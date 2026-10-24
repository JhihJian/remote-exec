//! deploy.ssh 网关 RPC：SSH 部署（暂存治理、指纹 inspect、安装编排、输出脱敏）。
//! 语义与 Node src/daemon/operations/deploy.js + src/deploy/ssh.js 对齐：
//! 安装输出统一缓冲，成功取得凭据后脱敏交付，密码不进入输出通道。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use remote_exec_ssh as ssh;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

use crate::rpc::{RpcError, send};

const STAGING_LIMIT: usize = 4;
const STAGING_TTL: Duration = Duration::from_secs(3600);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
/// install.sh 输出缓冲上限，防止网关内存被部署日志撑爆。
const INSTALL_OUTPUT_LIMIT: usize = 256 * 1024;
const TMP_PREFIX: &str = "/tmp/remote-exec-deploy.";

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(-32015, message)
}

struct Staging {
    directory: PathBuf,
    /// install 期间持有；cleanup 等待其释放后再删目录。
    busy: AsyncMutex<()>,
    created: Instant,
}

fn staging_map() -> &'static StdMutex<HashMap<String, Arc<Staging>>> {
    static MAP: OnceLock<StdMutex<HashMap<String, Arc<Staging>>>> = OnceLock::new();
    MAP.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// 清理过期且空闲的暂存目录。
fn sweep_expired(map: &mut HashMap<String, Arc<Staging>>) {
    let expired: Vec<(String, PathBuf)> = map
        .iter()
        .filter(|(_, entry)| {
            entry.busy.try_lock().is_ok() && entry.created.elapsed() >= STAGING_TTL
        })
        .map(|(id, entry)| (id.clone(), entry.directory.clone()))
        .collect();
    for (id, directory) in expired {
        map.remove(&id);
        let _ = std::fs::remove_dir_all(&directory);
    }
}

async fn action_prepare() -> Result<Value, RpcError> {
    let mut map = staging_map().lock().expect("暂存锁");
    sweep_expired(&mut map);
    if map.len() >= STAGING_LIMIT {
        return Err(invalid("部署暂存已达上限，请等待其他任务结束"));
    }
    let id = format!("{:032x}", rand::random::<u128>());
    let directory = std::env::temp_dir().join(format!("remote-exec-deploy-{id}"));
    std::fs::create_dir(&directory)
        .map_err(|e| RpcError::internal(format!("创建暂存目录失败: {e}").into()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
    }
    map.insert(
        id.clone(),
        Arc::new(Staging {
            directory: directory.clone(),
            busy: AsyncMutex::new(()),
            created: Instant::now(),
        }),
    );
    Ok(json!({
        "id": id,
        "files": {
            "package": directory.join("package.tar.gz"),
            "checksum": directory.join("package.tar.gz.sha256"),
            "installer": directory.join("install.sh"),
        }
    }))
}

async fn action_cleanup(params: &Value) -> Result<Value, RpcError> {
    let Some(id) = params.get("id").and_then(Value::as_str) else {
        return Err(invalid("缺少部署暂存标识"));
    };
    let entry = staging_map().lock().expect("暂存锁").get(id).cloned();
    let Some(entry) = entry else {
        return Ok(json!({"cleaned": true}));
    };
    // install 自带超时与收尾，锁必然释放；等待期间不删目录。
    let _guard = entry.busy.lock().await;
    staging_map().lock().expect("暂存锁").remove(id);
    let _ = std::fs::remove_dir_all(&entry.directory);
    Ok(json!({"cleaned": true}))
}

/// 目标校验：地址格式 + IPv4 + 网关允许网段；返回 (host, ssh_port)。
fn validate_target(target: &Value, allow_list: &[String]) -> Result<(String, u16), RpcError> {
    let host = target
        .get("host")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("缺少 target.host"))?;
    if !host
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        || host.len() > 253
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
    {
        return Err(invalid("SSH 目标地址无效"));
    }
    let ip: std::net::Ipv4Addr = host
        .parse()
        .map_err(|_| invalid("SSH 部署目标必须是网关允许网段内的 IPv4 地址"))?;
    if !crate::relay::target_allowed(ip, allow_list) {
        return Err(invalid("SSH 部署目标必须是网关允许网段内的 IPv4 地址"));
    }
    let ssh_port = match target.get("sshPort") {
        None | Some(Value::Null) => 22,
        Some(value) => value
            .as_u64()
            .filter(|p| (1..=65535).contains(p))
            .ok_or_else(|| invalid("SSH 端口无效"))? as u16,
    };
    Ok((host.to_owned(), ssh_port))
}

async fn action_inspect(params: &Value, allow_list: &[String]) -> Result<Value, RpcError> {
    let target = params.get("target").ok_or_else(|| invalid("缺少 target"))?;
    let (host, ssh_port) = validate_target(target, allow_list)?;
    let fingerprint = ssh::inspect(&host, ssh_port).await.map_err(invalid)?;
    Ok(json!({"fingerprint": fingerprint}))
}

/// install 动作的完整目标参数（已校验）。
struct InstallRequest {
    host: String,
    ssh_port: u16,
    username: String,
    fingerprint: String,
    /// 私钥 PEM 内容。
    identity: Option<String>,
    password: Option<String>,
    sudo_password: Option<String>,
    port: u16,
}

fn secret_valid(secret: Option<&str>) -> bool {
    secret.is_none_or(|s| !s.contains('\n') && !s.contains('\r'))
}

fn parse_install(params: &Value, allow_list: &[String]) -> Result<InstallRequest, RpcError> {
    let target = params.get("target").ok_or_else(|| invalid("缺少 target"))?;
    let (host, ssh_port) = validate_target(target, allow_list)?;
    let username = target
        .get("username")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("缺少 SSH 用户名"))?;
    if !username
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        || username.len() > 64
        || !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(invalid("SSH 用户名无效"));
    }
    let fingerprint = target
        .get("fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("需要已确认的 SSH 主机指纹"))?;
    if !ssh::valid_fingerprint(fingerprint) {
        return Err(invalid("需要已确认的 SSH 主机指纹"));
    }
    let port = target
        .get("port")
        .and_then(Value::as_u64)
        .filter(|p| (1..=65535).contains(p))
        .ok_or_else(|| invalid("daemon 端口无效"))? as u16;
    let password = target
        .get("password")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let sudo_password = target
        .get("sudoPassword")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if !secret_valid(password.as_deref()) || !secret_valid(sudo_password.as_deref()) {
        return Err(invalid("密码包含无效字符"));
    }
    let identity = target
        .get("identity")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(InstallRequest {
        host,
        ssh_port,
        username: username.to_owned(),
        fingerprint: fingerprint.to_owned(),
        identity,
        password,
        sudo_password,
        port,
    })
}

/// 安装后读回的接入资料（TLS 私钥留在目标，不回传）。
struct AccessInfo {
    token: String,
    certificate: String,
    ca: String,
    version: String,
    run_user: String,
    port: u16,
}

fn parse_access(
    token: &ssh::ExecOutcome,
    certificate: &ssh::ExecOutcome,
    ca: &ssh::ExecOutcome,
    manifest: &ssh::ExecOutcome,
) -> Result<AccessInfo, RpcError> {
    if token.code != 0 || certificate.code != 0 || ca.code != 0 || manifest.code != 0 {
        return Err(invalid("无法取得目标接入资料"));
    }
    let Some(token_line) = token
        .stdout
        .lines()
        .find(|line| line.len() == 64 && line.bytes().all(|b| b.is_ascii_hexdigit()))
    else {
        return Err(invalid("无法取得目标接入资料"));
    };
    let Some(body) = certificate
        .stdout
        .split("-----BEGIN CERTIFICATE-----")
        .nth(1)
        .and_then(|rest| rest.split("-----END CERTIFICATE-----").next())
    else {
        return Err(invalid("无法取得目标接入资料"));
    };
    let certificate = format!("-----BEGIN CERTIFICATE-----{body}-----END CERTIFICATE-----\n");
    let Some(ca_body) = ca
        .stdout
        .split("-----BEGIN CERTIFICATE-----")
        .nth(1)
        .and_then(|rest| rest.split("-----END CERTIFICATE-----").next())
    else {
        return Err(invalid("无法取得目标 CA 证书"));
    };
    let ca = format!("-----BEGIN CERTIFICATE-----{ca_body}-----END CERTIFICATE-----\n");
    let Some(start) = manifest.stdout.find('{') else {
        return Err(invalid("无法读取目标安装状态"));
    };
    let config: Value = serde_json::from_str(&manifest.stdout[start..])
        .map_err(|_| invalid("无法读取目标安装状态"))?;
    let version = config.get("version").and_then(Value::as_str).unwrap_or("");
    let run_user = config.get("runUser").and_then(Value::as_str).unwrap_or("");
    let port = config.get("port").and_then(Value::as_u64).unwrap_or(0);
    if version.is_empty() || run_user.is_empty() || !(1..=65535).contains(&port) {
        return Err(invalid("无法读取目标安装状态"));
    }
    Ok(AccessInfo {
        token: token_line.to_owned(),
        certificate,
        ca,
        version: version.to_owned(),
        run_user: run_user.to_owned(),
        port: port as u16,
    })
}

struct BundleFiles {
    package: Vec<u8>,
    checksum: Vec<u8>,
    installer: Vec<u8>,
}

fn read_bundle_files(directory: &Path) -> Result<BundleFiles, RpcError> {
    Ok(BundleFiles {
        package: std::fs::read(directory.join("package.tar.gz"))
            .map_err(|_| invalid("部署运行包缺失"))?,
        checksum: std::fs::read(directory.join("package.tar.gz.sha256"))
            .map_err(|_| invalid("部署运行包缺失"))?,
        installer: std::fs::read(directory.join("install.sh"))
            .map_err(|_| invalid("部署运行包缺失"))?,
    })
}

/// 目标暂存目录名校验：必须由 mktemp 在约定前缀下生成。
fn valid_temp_dir(path: &str) -> bool {
    path.strip_prefix(TMP_PREFIX)
        .is_some_and(|tail| tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// 单条安装输出（stderr 标记 + 数据），成功后统一脱敏交付。
type OutputChunk = (bool, Vec<u8>);

/// 单连接内：探测提权 → 目标暂存 → 上传三件套 → install.sh → 读回接入资料。
/// temp_dir 记录目标暂存路径，供取消/失败路径清理。
async fn install_on_target(
    session: &ssh::Session,
    target: &ssh::Target,
    daemon_port: u16,
    files: &BundleFiles,
    temp_dir: &StdMutex<Option<String>>,
) -> Result<(AccessInfo, Vec<OutputChunk>), RpcError> {
    let probe = ssh::exec(session, target, "true", None, Duration::from_secs(15), None)
        .await
        .map_err(invalid)?;
    if probe.code != 0 {
        return Err(invalid(format!(
            "{}: 提权失败，请提供 sudo 密码并确认账户具有 sudo 权限",
            ssh::SUDO_PASSWORD_REQUIRED
        )));
    }
    let staging = ssh::exec(
        session,
        target,
        &format!("umask 077; mktemp -d {TMP_PREFIX}XXXXXXXX"),
        None,
        Duration::from_secs(30),
        None,
    )
    .await
    .map_err(invalid)?;
    let path = staging.stdout.split_whitespace().last().unwrap_or("");
    if staging.code != 0 || !valid_temp_dir(path) {
        return Err(invalid("无法创建目标安装暂存目录"));
    }
    let path = path.to_owned();
    *temp_dir.lock().expect("暂存路径") = Some(path.clone());
    for (name, data) in [
        ("package.tar.gz", &files.package),
        ("package.tar.gz.sha256", &files.checksum),
        ("install.sh", &files.installer),
    ] {
        ssh::upload_bytes(session, &format!("{path}/{name}"), data)
            .await
            .map_err(invalid)?;
    }
    let mut outputs: Vec<OutputChunk> = Vec::new();
    let mut collector = |stderr: bool, data: &[u8]| {
        outputs.push((stderr, data.to_vec()));
    };
    let command = format!(
        "bash {} --package {} --address {} --port {}",
        ssh::shell_quote(&format!("{path}/install.sh")),
        ssh::shell_quote(&format!("{path}/package.tar.gz")),
        ssh::shell_quote(&target.host),
        daemon_port
    );
    let result = ssh::exec(
        session,
        target,
        &command,
        None,
        INSTALL_TIMEOUT,
        Some(&mut collector),
    )
    .await
    .map_err(invalid)?;
    if outputs.iter().map(|(_, data)| data.len()).sum::<usize>() > INSTALL_OUTPUT_LIMIT {
        return Err(invalid("SSH 操作输出超过上限"));
    }
    if result.code != 0 {
        return Err(invalid(format!(
            "目标安装失败（退出码 {}），请在目标查看 remote-exec 服务日志",
            result.code
        )));
    }
    // 接入资料由专门响应交付，不进入安装日志，TLS 私钥留在目标。
    let access = parse_access(
        &ssh::exec(
            session,
            target,
            "cat /root/remote-exec-access/token.txt",
            None,
            Duration::from_secs(30),
            None,
        )
        .await
        .map_err(invalid)?,
        &ssh::exec(
            session,
            target,
            "cat /root/remote-exec-access/server.crt",
            None,
            Duration::from_secs(30),
            None,
        )
        .await
        .map_err(invalid)?,
        &ssh::exec(
            session,
            target,
            "cat /root/remote-exec-access/ca.crt 2>/dev/null || cat /etc/remote-exec/credentials/ca.crt 2>/dev/null || cat /root/remote-exec-access/server.crt",
            None,
            Duration::from_secs(30),
            None,
        )
        .await
        .map_err(invalid)?,
        &ssh::exec(
            session,
            target,
            "cat /opt/remote-exec/release.json",
            None,
            Duration::from_secs(30),
            None,
        )
        .await
        .map_err(invalid)?,
    )?;
    Ok((access, outputs))
}

async fn action_install(
    params: &Value,
    id: &Value,
    out: &mpsc::Sender<Message>,
    cancel: &mut watch::Receiver<bool>,
    allow_list: &[String],
) -> Result<Value, RpcError> {
    let Some(staging_id) = params.get("id").and_then(Value::as_str) else {
        return Err(invalid("缺少部署暂存标识"));
    };
    let request = parse_install(params, allow_list)?;
    let entry = staging_map()
        .lock()
        .expect("暂存锁")
        .get(staging_id)
        .cloned();
    let Some(entry) = entry else {
        return Err(invalid("部署暂存不存在或正在使用"));
    };
    // 拿不到锁说明另一安装正在使用该暂存。
    let _guard = entry
        .busy
        .try_lock()
        .map_err(|_| invalid("部署暂存不存在或正在使用"))?;
    run_install(&entry, &request, id, out, cancel).await
}

async fn run_install(
    entry: &Arc<Staging>,
    request: &InstallRequest,
    id: &Value,
    out: &mpsc::Sender<Message>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, RpcError> {
    let files = read_bundle_files(&entry.directory)?;
    let target = ssh::Target {
        host: request.host.clone(),
        ssh_port: request.ssh_port,
        username: request.username.clone(),
        fingerprint: Some(request.fingerprint.clone()),
        identity: request.identity.clone(),
        password: request.password.clone(),
        sudo_password: request.sudo_password.clone(),
    };
    let session = ssh::connect(&target).await.map_err(invalid)?;
    let temp_dir: StdMutex<Option<String>> = StdMutex::new(None);
    let work = install_on_target(&session, &target, request.port, &files, &temp_dir);
    let result = tokio::select! {
        biased;
        _ = crate::rpc::cancelled(cancel) => Err(invalid("上游客户端断开")),
        result = work => result,
    };
    // 目标侧暂存目录清理：成功、失败与取消路径都执行。
    let temp_path = temp_dir.into_inner().expect("暂存路径");
    if let Some(path) = temp_path {
        let command = format!("rm -rf -- {}", ssh::shell_quote(&path));
        let cleanup = ssh::exec(&session, &target, &command, None, CLEANUP_TIMEOUT, None).await;
        let cleanup = match cleanup {
            Ok(_) => Ok(()),
            Err(_) => match ssh::connect(&target).await {
                Ok(fresh) => ssh::exec(&fresh, &target, &command, None, CLEANUP_TIMEOUT, None)
                    .await
                    .map(|_| ()),
                Err(retry_error) => Err(retry_error),
            },
        };
        if let Err(cleanup_error) = cleanup {
            let context = result
                .as_ref()
                .err()
                .map(|e| format!("{}\n", e.message))
                .unwrap_or_default();
            return Err(invalid(format!(
                "{context}目标暂存清理失败（{cleanup_error}），请通过 SSH 清理 {path} 并检查服务状态"
            )));
        }
    }
    let (access, outputs) = result?;
    // 取得凭据后统一脱敏交付（Node 语义：密码与 token 不进入输出通道）。
    for (stderr, data) in outputs {
        let text = String::from_utf8_lossy(&data).into_owned();
        let secrets: [Option<&str>; 3] = [
            request.password.as_deref(),
            request.sudo_password.as_deref(),
            Some(access.token.as_str()),
        ];
        let redacted = redact(&text, &secrets);
        use base64::Engine;
        let data_b64 = base64::engine::general_purpose::STANDARD.encode(redacted.as_bytes());
        let event = json!({
            "id": id,
            "event": "output",
            "stream": if stderr { "stderr" } else { "stdout" },
            "dataB64": data_b64,
        });
        send(out, event).await?;
    }
    Ok(json!({
        "token": access.token,
        "certificate": access.certificate,
        "ca": access.ca,
        "version": access.version,
        "runUser": access.run_user,
        "port": access.port,
    }))
}

fn redact(text: &str, secrets: &[Option<&str>]) -> String {
    let mut result = text.to_owned();
    for secret in secrets.iter().flatten().filter(|s| !s.is_empty()) {
        if result.contains(*secret) {
            result = result.replace(*secret, "[已隐藏]");
        }
    }
    result
}

pub async fn run(
    params: &Value,
    id: &Value,
    out: &mpsc::Sender<Message>,
    cancel: &mut watch::Receiver<bool>,
    allow_list: &[String],
) -> Result<Value, RpcError> {
    if !params.is_object() {
        return Err(invalid("params 必须是对象"));
    }
    match params.get("action").and_then(Value::as_str) {
        Some("prepare") => action_prepare().await,
        Some("cleanup") => action_cleanup(params).await,
        Some("inspect") => action_inspect(params, allow_list).await,
        Some("install") => action_install(params, id, out, cancel, allow_list).await,
        _ => Err(invalid("未知 SSH 部署操作")),
    }
}
