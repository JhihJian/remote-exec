//! SSH 直连传输层：russh 封装（指纹校验、认证链、exec、SFTP 上传）。
//! 语义与 Node src/deploy/ssh.js 对齐，错误标记（SSH_AUTH_REQUIRED / SUDO_PASSWORD_REQUIRED）
//! 以消息前缀形式供 deploy 循环识别。
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{AuthResult, Handler};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::AgentClient;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::{HashAlg, PublicKeyOrCertificate};
use sha2::{Digest, Sha256};

/// 已认证会话（服务端密钥已按指纹校验）。
pub type Session = russh::client::Handle<ServerKeyHandler>;

pub const AUTH_REQUIRED: &str = "SSH_AUTH_REQUIRED";
pub const SUDO_PASSWORD_REQUIRED: &str = "SUDO_PASSWORD_REQUIRED";

const DEFAULT_KEYS: [&str; 3] = ["id_ed25519", "id_rsa", "id_ecdsa"];

/// 部署目标（来自 CLI 参数，密码仅在内存中存活，不落盘）。
pub struct Target {
    pub host: String,
    pub ssh_port: u16,
    pub username: String,
    pub fingerprint: Option<String>,
    /// 私钥 PEM 内容。网关模式下客户端无法传路径，统一由调用方读文件后传内容。
    pub identity: Option<String>,
    pub password: Option<String>,
    pub sudo_password: Option<String>,
}

pub struct ExecOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// 单条输出回调：stderr 为 true 时输出走 stderr。
pub type OnOutput<'a> = &'a mut (dyn FnMut(bool, &[u8]) + Send);

fn fingerprint_of(key: &russh::keys::PublicKey) -> String {
    use base64::Engine;
    use russh::keys::ssh_encoding::Encode;
    let mut blob = Vec::new();
    let _ = key.key_data().encode(&mut blob);
    let digest = Sha256::digest(&blob);
    let encoded = base64::engine::general_purpose::STANDARD.encode(digest);
    format!("SHA256:{}", encoded.trim_end_matches('='))
}

enum VerifyMode {
    /// 仅取回指纹后拒绝连接（不建立会话）。
    Inspect(Mutex<Option<String>>),
    /// 期望指纹，不匹配即拒绝。
    Expect(String),
}

pub struct ServerKeyHandler {
    mode: Arc<VerifyMode>,
}

impl Handler for ServerKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } = server_public_key else {
            // 主机证书不参与指纹信任链，按不信任处理。
            return Ok(false);
        };
        let fingerprint = fingerprint_of(key);
        match &*self.mode {
            VerifyMode::Inspect(slot) => {
                *slot.lock().expect("指纹槽") = Some(fingerprint);
                Ok(false)
            }
            VerifyMode::Expect(expected) => Ok(expected == &fingerprint),
        }
    }
}

fn client_config() -> Arc<russh::client::Config> {
    Arc::new(russh::client::Config {
        keepalive_interval: Some(Duration::from_secs(10)),
        inactivity_timeout: None,
        ..Default::default()
    })
}

/// 连接目标并按指纹校验主机密钥（inspect=true 时只取指纹即断开）。
async fn dial(target: &Target, mode: Arc<VerifyMode>) -> Result<Session, String> {
    let handler = ServerKeyHandler { mode };
    let address = (target.host.as_str(), target.ssh_port);
    russh::client::connect(client_config(), address, handler)
        .await
        .map_err(|e| format!("SSH 连接 {}:{} 失败: {e}", target.host, target.ssh_port))
}

/// 获取主机指纹（不认证、不建立会话）。
pub async fn inspect(host: &str, ssh_port: u16) -> Result<String, String> {
    let slot = Arc::new(VerifyMode::Inspect(Mutex::new(None)));
    let target = Target {
        host: host.to_owned(),
        ssh_port,
        username: String::new(),
        fingerprint: None,
        identity: None,
        password: None,
        sudo_password: None,
    };
    let _ = dial(&target, slot.clone()).await;
    if let VerifyMode::Inspect(slot) = &*slot
        && let Some(fp) = slot.lock().expect("指纹槽").clone()
    {
        return Ok(fp);
    }
    Err(format!("无法获取 {host}:{ssh_port} 的主机指纹"))
}

/// 认证并返回可用会话。认证链：显式密码 > 显式私钥 > agent > 默认私钥。
/// 全部失败返回带 AUTH_REQUIRED 前缀的错误，由调用方提示密码后重试。
pub async fn connect(target: &Target) -> Result<Session, String> {
    let expected = target.fingerprint.clone().ok_or_else(|| {
        format!("内部错误: {} 未通过指纹校验即尝试连接", target.host)
    })?;
    let mut session = dial(target, Arc::new(VerifyMode::Expect(expected))).await?;
    let user = target.username.as_str();

    if let Some(password) = &target.password {
        return match session.authenticate_password(user, password).await {
            Ok(AuthResult::Success) => Ok(session),
            Ok(_) => Err(format!(
                "{AUTH_REQUIRED}: SSH 密码认证失败 {}@{}",
                user, target.host
            )),
            Err(e) => Err(format!("SSH 密码认证错误: {e}")),
        };
    }

    if let Some(pem) = &target.identity {
        let key = load_key(pem)?;
        let with_hash = PrivateKeyWithHashAlg::new(
            Arc::new(key.clone()),
            rsa_hash_alg(&key),
        );
        return match session.authenticate_publickey(user, with_hash).await {
            Ok(AuthResult::Success) => Ok(session),
            Ok(_) => Err(format!("{AUTH_REQUIRED}: 私钥认证失败 {user}")),
            Err(e) => Err(format!("SSH 私钥认证错误: {e}")),
        };
    }

    if let Ok(mut agent) = AgentClient::connect_env().await
        && let Ok(identities) = agent.request_identities().await
    {
        for identity in identities {
            let AgentIdentity::PublicKey { key, .. } = identity else {
                continue;
            };
            let hash_alg = match key.algorithm() {
                russh::keys::Algorithm::Rsa { hash } => Some(
                    hash.unwrap_or(russh::keys::HashAlg::Sha256),
                ),
                _ => None,
            };
            if let Ok(AuthResult::Success) = session
                .authenticate_publickey_with(user, key, hash_alg, &mut agent)
                .await
            {
                return Ok(session);
            }
        }
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    for name in DEFAULT_KEYS {
        let path = Path::new(&home).join(".ssh").join(name);
        if !path.exists() {
            continue;
        }
        let Ok(key) = russh::keys::load_secret_key(&path, None) else {
            continue;
        };
        let with_hash = PrivateKeyWithHashAlg::new(
            Arc::new(key.clone()),
            rsa_hash_alg(&key),
        );
        if let Ok(AuthResult::Success) = session
            .authenticate_publickey(user, with_hash)
            .await
        {
            return Ok(session);
        }
    }

    Err(format!(
        "{AUTH_REQUIRED}: SSH 认证失败 {}@{}（已尝试 agent 与默认私钥）",
        user, target.host
    ))
}

fn load_key(pem: &str) -> Result<russh::keys::PrivateKey, String> {
    russh::keys::decode_secret_key(pem, None)
        .map_err(|_| "解析私钥 PEM 失败".to_owned())
}

/// 主机指纹格式校验：SHA256: 前缀 + 43 位 base64 字符（不含填充）。
pub fn valid_fingerprint(fingerprint: &str) -> bool {
    fingerprint.len() == 50
        && fingerprint.starts_with("SHA256:")
        && fingerprint[7..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// RSA 私钥一律走 SHA-2，避免服务器拒绝 ssh-rsa(SHA-1)。
fn rsa_hash_alg(key: &russh::keys::PrivateKey) -> Option<HashAlg> {
    match key.algorithm() {
        russh::keys::Algorithm::Rsa { .. } => Some(HashAlg::Sha256),
        _ => None,
    }
}

/// 远端执行命令。非 root 用户自动加 sudo 前缀；sudo 密码经 stdin 传递。
/// timeout 到点放弃该 channel（会话保留），输出经 on_output 流式转发。
pub async fn exec(
    session: &Session,
    target: &Target,
    command: &str,
    stdin_data: Option<&[u8]>,
    timeout: Duration,
    on_output: Option<OnOutput<'_>>,
) -> Result<ExecOutcome, String> {
    let uid = current_uid(session, target).await?;
    let (prefix, stdin): (String, Vec<u8>) = if uid == 0 {
        (String::new(), Vec::new())
    } else if let Some(password) = &target.sudo_password {
        (
            "sudo -S -p '' -- ".to_owned(),
            format!("{password}\n").into_bytes(),
        )
    } else {
        ("sudo -n -- ".to_owned(), Vec::new())
    };
    let stdin = stdin_data.map(|d| d.to_vec()).unwrap_or(stdin);
    run_with_prefix(session, target, &format!("{prefix}{command}"), stdin, timeout, on_output)
        .await
}

/// 直连执行（不加 sudo 前缀），供需要原生 shell 语义的调用使用。
#[allow(dead_code)]
pub async fn exec_raw(
    session: &Session,
    target: &Target,
    command: &str,
    stdin_data: &[u8],
    timeout: Duration,
) -> Result<ExecOutcome, String> {
    run_with_prefix(session, target, command, stdin_data.to_vec(), timeout, None).await
}

async fn current_uid(
    session: &Session,
    target: &Target,
) -> Result<u32, String> {
    let outcome = run_with_prefix(
        session,
        target,
        "id -u",
        Vec::new(),
        Duration::from_secs(20),
        None,
    )
    .await?;
    if outcome.code != 0 {
        return Err(format!("获取 uid 失败: {}", outcome.stderr.trim()));
    }
    outcome
        .stdout
        .trim()
        .parse()
        .map_err(|_| format!("uid 输出无法解析: {}", outcome.stdout.trim()))
}

async fn run_with_prefix(
    session: &Session,
    target: &Target,
    command: &str,
    stdin_data: Vec<u8>,
    timeout: Duration,
    mut on_output: Option<OnOutput<'_>>,
) -> Result<ExecOutcome, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SSH channel 失败: {e}"))?;
    channel
        .exec(true, command.as_bytes().to_vec())
        .await
        .map_err(|e| format!("启动命令失败: {e}"))?;
    if !stdin_data.is_empty() {
        channel
            .data_bytes(stdin_data)
            .await
            .map_err(|e| format!("写入 stdin 失败: {e}"))?;
    }
    channel
        .eof()
        .await
        .map_err(|e| format!("关闭 stdin 失败: {e}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code: Option<i32> = None;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let message = tokio::select! {
            message = channel.wait() => message,
            _ = tokio::time::sleep_until(deadline) => {
                if let Some(on_output) = on_output.as_mut() {
                    on_output(true, format!("\n[rex] 命令超时（{}s）\n", timeout.as_secs()).as_bytes());
                }
                return Err(format!("SSH 命令超时（{}s）: {command}", timeout.as_secs()));
            }
        };
        let Some(message) = message else { break };
        match message {
            russh::ChannelMsg::Data { ref data } => {
                if stdout.len() + data.len() <= 512 * 1024 {
                    stdout.extend_from_slice(data);
                }
                if let Some(on_output) = on_output.as_mut() {
                    on_output(false, data);
                }
            }
            russh::ChannelMsg::ExtendedData { ref data, .. } => {
                if stderr.len() + data.len() <= 512 * 1024 {
                    stderr.extend_from_slice(data);
                }
                if let Some(on_output) = on_output.as_mut() {
                    on_output(true, data);
                }
            }
            russh::ChannelMsg::ExitStatus { exit_status } => {
                code = Some(exit_status as i32);
            }
            // OpenSSH 在 EOF 之后才发送 exit-status，EOF 只表示输出结束。
            russh::ChannelMsg::Eof => {}
            russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    let code = code.unwrap_or(-1);
    if code != 0 {
        let stderr_text = String::from_utf8_lossy(&stderr);
        if stderr_text.contains("sudo: a password is required")
            || stderr_text.contains("sudo: no password was provided")
        {
            return Err(format!(
                "{SUDO_PASSWORD_REQUIRED}: 需要 sudo 密码，请提供并确认账号有 sudo 权限"
            ));
        }
    }
    let _ = target;
    Ok(ExecOutcome {
        code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// SFTP 上传字节到远端文件（0600），目标路径需已存在父目录。
pub async fn upload_bytes(
    session: &Session,
    remote_path: &str,
    data: &[u8],
) -> Result<(), String> {
    use russh_sftp::client::SftpSession;
    use russh_sftp::protocol::FileAttributes;
    use russh_sftp::protocol::OpenFlags;
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SFTP channel 失败: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("请求 sftp subsystem 失败: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("初始化 SFTP 失败: {e}"))?;
    let attrs = FileAttributes {
        permissions: Some(0o600),
        ..Default::default()
    };
    let flags = OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE;
    let mut file = sftp
        .open_with_flags_and_attributes(remote_path, flags, attrs)
        .await
        .map_err(|e| format!("打开远端文件 {remote_path} 失败: {e}"))?;
    use tokio::io::AsyncWriteExt;
    file.write_all(data)
        .await
        .map_err(|e| format!("写入 {remote_path} 失败: {e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("关闭 {remote_path} 失败: {e}"))?;
    sftp.close().await.ok();
    Ok(())
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
