//! rex-ops deploy：SSH 部署（直连 russh 或 --via 网关 deploy.ssh RPC）。
use crate::bundle;
use crate::config::{self, Credentials, Store};
use crate::prompt;
use crate::upgrade::trust_known_fingerprint;
use remote_exec_ssh::{self as ssh, Target as SshTarget};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::output;

const HELP: &str = "用法: rex-ops deploy [--via 网关名] [--port 8791] [--identity 私钥路径] [--package tar.gz] \
[--ssh-port 22] [--host-key SHA256:...] [name=]user@IPv4 ...";

/// 部署输出转录上限，超限整体丢弃只保留截断提示。
const TRANSCRIPT_LIMIT: usize = 1024 * 1024;
/// SSH/sudo 密码重试次数上限。
const MAX_AUTH_ATTEMPTS: i32 = 3;

struct DeployTarget {
    name: String,
    username: String,
    host: String,
    port: u16,
    ssh_port: u16,
}

struct Options {
    via: Option<String>,
    port: u16,
    ssh_port: u16,
    identity: Option<String>,
    package: Option<String>,
    host_key: Option<String>,
    targets: Vec<DeployTarget>,
}

fn is_ipv4(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| {
            !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()) && {
                let value: u32 = p.parse().unwrap_or(999);
                value <= 255 && !(p.len() > 1 && p.starts_with('0'))
            }
        })
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut options = Options {
        via: None,
        port: 8791,
        ssh_port: 22,
        identity: None,
        package: None,
        host_key: None,
        targets: Vec::new(),
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let mut take = |key: &'static str| -> Result<String, String> {
            let value = args.get(index + 1).ok_or(format!("{arg} 缺少值"))?.clone();
            if value.starts_with("--") {
                return Err(format!("{arg} 缺少值"));
            }
            if seen.contains(&key) {
                return Err(format!("未知或重复参数: {arg}"));
            }
            seen.push(key);
            index += 1;
            Ok(value)
        };
        match arg {
            "--help" | "-h" => return Err(format!("{HELP}\n")),
            "--via" => options.via = Some(take("via")?),
            "--port" => {
                let value = take("port")?;
                options.port = value
                    .parse()
                    .map_err(|_| format!("port 必须为 1..65535: {value}"))?;
                if options.port == 0 {
                    return Err("port 必须为 1..65535".into());
                }
            }
            "--ssh-port" => {
                let value = take("ssh-port")?;
                options.ssh_port = value
                    .parse()
                    .map_err(|_| format!("sshPort 必须为 1..65535: {value}"))?;
                if options.ssh_port == 0 {
                    return Err("sshPort 必须为 1..65535".into());
                }
            }
            "--identity" => options.identity = Some(take("identity")?),
            "--package" => options.package = Some(take("package")?),
            "--host-key" => options.host_key = Some(take("host-key")?),
            other => {
                if other.starts_with("--") {
                    return Err(format!("未知或重复参数: {other}"));
                }
                let (name_part, rest) = match other.split_once('=') {
                    Some((name, rest)) => (Some(name), rest),
                    None => (None, other),
                };
                let Some((username, host)) = rest.split_once('@') else {
                    return Err(format!("目标必须是 [name=]user@IPv4: {other}"));
                };
                if !is_ipv4(host) || host.contains('@') {
                    return Err(format!("目标必须是 [name=]user@IPv4: {other}"));
                }
                let valid_user = !username.is_empty()
                    && username.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                    && username
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
                if !valid_user {
                    return Err(format!("目标必须是 [name=]user@IPv4: {other}"));
                }
                let name = match name_part {
                    Some(name)
                        if !name.is_empty()
                            && name.starts_with(|c: char| c.is_ascii_alphanumeric())
                            && name.chars().all(|c| {
                                c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
                            }) =>
                    {
                        name.to_owned()
                    }
                    Some(_) => return Err(format!("目标别名无效: {other}")),
                    None => format!("host-{}", host.replace('.', "-")),
                };
                options.targets.push(DeployTarget {
                    name,
                    username: username.to_owned(),
                    host: host.to_owned(),
                    port: 0,
                    ssh_port: 0,
                });
            }
        }
        index += 1;
    }
    if options.targets.is_empty() {
        return Err(format!("请指定至少一个部署目标 user@IPv4\n{HELP}"));
    }
    // 选项与目标可任意顺序出现，统一在解析完成后合并。
    for target in &mut options.targets {
        target.port = options.port;
        target.ssh_port = options.ssh_port;
    }
    if let Some(host_key) = &options.host_key
        && (!ssh::valid_fingerprint(host_key) || options.targets.len() != 1)
    {
        return Err("--host-key 需要 SHA256 指纹且仅支持单目标".into());
    }
    let mut names = std::collections::HashSet::new();
    let mut endpoints = std::collections::HashSet::new();
    for target in &options.targets {
        if !names.insert(&target.name) || !endpoints.insert(&target.host) {
            return Err(format!("重复目标: {}", target.name));
        }
    }
    Ok(options)
}

struct InstallOutput {
    token: String,
    certificate: String,
    version: String,
    run_user: String,
}

impl InstallOutput {
    fn is_valid(&self) -> bool {
        !self.token.is_empty() && self.certificate.contains("BEGIN CERTIFICATE")
    }

    /// 解析 deploy.ssh install 响应。
    fn from_rpc(value: &Value) -> Result<Self, String> {
        let output = Self {
            token: value
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            certificate: value
                .get("certificate")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            version: value
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            run_user: value
                .get("runUser")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        };
        if output.is_valid() {
            Ok(output)
        } else {
            Err("安装未返回有效连接凭据".into())
        }
    }
}

/// 部署输出转录：直连与网关路径共用，超限整体截断。
struct Transcript {
    text: String,
    truncated: bool,
}

impl Transcript {
    fn new() -> Self {
        Self {
            text: String::new(),
            truncated: false,
        }
    }

    fn push(&mut self, stderr: bool, data: &[u8]) {
        if self.truncated {
            return;
        }
        let chunk = String::from_utf8_lossy(data);
        if self.text.len() + chunk.len() > TRANSCRIPT_LIMIT {
            self.text.clear();
            self.truncated = true;
            return;
        }
        self.text.push_str(&chunk);
        let _ = stderr;
    }
}

/// 单目标安装：上传三件套并执行 install.sh，读回接入资料。
/// 失败时尽力清理暂存目录；清理失败在错误信息中提示手工清理。
async fn install_target(
    ssh_target: &SshTarget,
    files: &bundle::Bundle,
    daemon_port: u16,
    on_output: &mut (dyn FnMut(bool, &[u8]) + Send),
) -> Result<InstallOutput, String> {
    let session = ssh::connect(ssh_target).await?;
    let mut temporary: Option<String> = None;
    let result = install_steps(
        &session,
        ssh_target,
        files,
        daemon_port,
        &mut temporary,
        on_output,
    )
    .await;
    if let Err(error) = &result {
        // 安装失败：清理暂存目录（会话失效时重连清理）。
        if let Some(path) = &temporary {
            let cleanup = ssh::exec(
                &session,
                ssh_target,
                &format!("rm -rf -- {}", ssh::shell_quote(path)),
                None,
                Duration::from_secs(15),
                None,
            )
            .await;
            let cleanup = match cleanup {
                Ok(_) => Ok(()),
                Err(_) => match ssh::connect(ssh_target).await {
                    Ok(fresh) => ssh::exec(
                        &fresh,
                        ssh_target,
                        &format!("rm -rf -- {}", ssh::shell_quote(path)),
                        None,
                        Duration::from_secs(15),
                        None,
                    )
                    .await
                    .map(|_| ()),
                    Err(retry_error) => Err(retry_error),
                },
            };
            if let Err(cleanup_error) = cleanup {
                return Err(format!(
                    "{error}\n目标暂存清理失败（{cleanup_error}），请通过 SSH 清理 {path}"
                ));
            }
        }
    } else if let Some(path) = &temporary {
        let _ = ssh::exec(
            &session,
            ssh_target,
            &format!("rm -rf -- {}", ssh::shell_quote(path)),
            None,
            Duration::from_secs(15),
            None,
        )
        .await;
    }
    result
}

async fn install_steps(
    session: &ssh::Session,
    ssh_target: &SshTarget,
    files: &bundle::Bundle,
    daemon_port: u16,
    temporary: &mut Option<String>,
    on_output: &mut (dyn FnMut(bool, &[u8]) + Send),
) -> Result<InstallOutput, String> {
    // 提权探测：非 root 且无可用 sudo 时进入 sudo 密码重试循环。
    let probe = ssh::exec(
        session,
        ssh_target,
        "true",
        None,
        Duration::from_secs(15),
        None,
    )
    .await?;
    if probe.code != 0 {
        return Err(format!(
            "{}: 提权失败，请提供 sudo 密码并确认账户具有 sudo 权限",
            ssh::SUDO_PASSWORD_REQUIRED
        ));
    }
    let staging = ssh::exec(
        session,
        ssh_target,
        "umask 077; mktemp -d /tmp/remote-exec-deploy.XXXXXXXX",
        None,
        Duration::from_secs(30),
        None,
    )
    .await?;
    let staging_path = staging.stdout.split_whitespace().last().unwrap_or("");
    let valid = staging.code == 0
        && staging_path.starts_with("/tmp/remote-exec-deploy.")
        && staging_path.len() == "/tmp/remote-exec-deploy.".len() + 8
        && staging_path
            .rsplit('.')
            .next()
            .is_some_and(|tail| tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_alphanumeric()));
    if !valid {
        return Err("无法创建目标安装暂存目录".into());
    }
    let staging_path = staging_path.to_owned();
    *temporary = Some(staging_path.clone());
    for (local, remote) in [
        (&files.package, "package.tar.gz"),
        (&files.checksum, "package.tar.gz.sha256"),
        (&files.installer, "install.sh"),
    ] {
        let data = std::fs::read(local).map_err(|e| format!("读取 {local:?} 失败: {e}"))?;
        ssh::upload_bytes(session, &format!("{staging_path}/{remote}"), &data).await?;
    }
    let install = ssh::exec(
        session,
        ssh_target,
        &format!(
            "bash {} --package {} --address {} --port {}",
            ssh::shell_quote(&format!("{staging_path}/install.sh")),
            ssh::shell_quote(&format!("{staging_path}/package.tar.gz")),
            ssh::shell_quote(&ssh_target.host),
            daemon_port
        ),
        None,
        Duration::from_secs(600),
        Some(&mut *on_output),
    )
    .await?;
    if install.code != 0 {
        return Err(format!(
            "目标安装失败（退出码 {}），请在目标查看 remote-exec 服务日志",
            install.code
        ));
    }
    // 接入资料由专门响应交付，不进入安装日志，TLS 私钥留在目标。
    let token_result = ssh::exec(
        session,
        ssh_target,
        "cat /root/remote-exec-access/token.txt",
        None,
        Duration::from_secs(30),
        None,
    )
    .await?;
    let certificate_result = ssh::exec(
        session,
        ssh_target,
        "cat /root/remote-exec-access/server.crt",
        None,
        Duration::from_secs(30),
        None,
    )
    .await?;
    let manifest_result = ssh::exec(
        session,
        ssh_target,
        "cat /opt/remote-exec/install.json",
        None,
        Duration::from_secs(30),
        None,
    )
    .await?;
    let token = token_result
        .stdout
        .lines()
        .find(|line| line.len() == 64 && line.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_owned);
    let certificate = certificate_result
        .stdout
        .split("-----BEGIN CERTIFICATE-----")
        .nth(1)
        .and_then(|rest| rest.split("-----END CERTIFICATE-----").next())
        .map(|body| format!("-----BEGIN CERTIFICATE-----{body}-----END CERTIFICATE-----\n"));
    let manifest: Option<Value> = manifest_result
        .stdout
        .find('{')
        .and_then(|start| serde_json::from_str(&manifest_result.stdout[start..]).ok());
    let ok = [&token_result, &certificate_result, &manifest_result]
        .iter()
        .all(|result| result.code == 0)
        && token.is_some()
        && certificate.is_some();
    if !ok {
        return Err("无法取得目标接入资料".into());
    }
    let manifest = manifest.expect("已校验");
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("");
    let run_user = manifest
        .get("runUser")
        .and_then(Value::as_str)
        .unwrap_or("");
    if version.is_empty() || run_user.is_empty() {
        return Err("无法读取目标安装状态".into());
    }
    Ok(InstallOutput {
        token: token.expect("已校验"),
        certificate: certificate.expect("已校验"),
        version: version.to_owned(),
        run_user: run_user.to_owned(),
    })
}

/// 部署后验收：钉住安装返回的叶子证书直连 daemon 执行 marker 命令。
async fn verify_target(target: &DeployTarget, credentials: &InstallOutput) -> Result<(), String> {
    if !matches!(credentials.run_user.as_str(), "root" | "remote-exec") {
        return Err("安装返回了未知服务身份".into());
    }
    let marker = format!("rex-deploy-{}", marker_hex());
    let entry = config::HostEntry {
        host: target.host.clone(),
        port: target.port,
        servername: None,
        ca: String::new(),
        token_file: String::new(),
        via: None,
        cwd: None,
        note: None,
    };
    let call = crate::client::Call {
        method: "exec".into(),
        params: serde_json::json!({
            "command": format!("printf '\\n{marker}\\n'; id -un"),
            "timeoutMs": 5000,
        }),
    };
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        crate::client::call_entry_pinned(
            &entry,
            &credentials.token,
            &credentials.certificate,
            &call,
        ),
    )
    .await
    .map_err(|_| "daemon 验收超时".to_owned())?
    .map_err(|e| format!("daemon 验收失败: {e}"))?;
    let stdout = decode_stdout(&result);
    let exit = result.get("exitCode").and_then(Value::as_i64).unwrap_or(-1);
    verify_reply(&stdout, exit, &marker, &credentials.run_user)
}

/// 网关部署会话：封装 deploy.ssh RPC 编排与网关侧暂存生命周期。
struct GatewayDeploy {
    name: String,
    entry: config::HostEntry,
    /// 网关暂存标识；首次 install 前惰性 prepare。
    prepared: Option<String>,
}

impl GatewayDeploy {
    fn resolve(store: &Store, name: &str) -> Result<Self, String> {
        let entry = store.host(name).map_err(|e| e.to_string())?;
        if entry.via.is_some() {
            return Err("via 仅支持单跳，网关自身不得设置 via".into());
        }
        std::fs::read_to_string(&entry.ca)
            .map_err(|e| format!("读取 CA 失败 {}: {e}", entry.ca))?;
        std::fs::read_to_string(&entry.token_file)
            .map_err(|e| format!("读取 token 失败 {}: {e}", entry.token_file))?;
        Ok(Self {
            name: name.to_owned(),
            entry,
            prepared: None,
        })
    }

    async fn call(
        &self,
        store: &Store,
        params: Value,
        on_event: Option<&mut (dyn FnMut(crate::client::StreamEvent) + Send)>,
    ) -> Result<Value, String> {
        let call = crate::client::Call {
            method: "deploy.ssh".into(),
            params,
        };
        let mut interrupt = crate::client::Interrupt(None);
        crate::client::call_host(store, &self.name, &call, on_event, &mut interrupt).await
    }

    /// 经网关探测目标 SSH 指纹。
    async fn inspect(&self, store: &Store, target: &DeployTarget) -> Result<String, String> {
        let inspected = self
            .call(
                store,
                serde_json::json!({
                    "action": "inspect",
                    "target": {"host": target.host, "sshPort": target.ssh_port},
                }),
                None,
            )
            .await?;
        Ok(inspected
            .get("fingerprint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }

    /// 网关暂存 + 三件套上传（仅首次）。
    async fn ensure_prepared(
        &mut self,
        store: &Store,
        bundle: &bundle::Bundle,
    ) -> Result<(), String> {
        if self.prepared.is_some() {
            return Ok(());
        }
        let staged = self
            .call(store, serde_json::json!({"action": "prepare"}), None)
            .await?;
        let id = staged
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let files = staged.get("files").cloned().unwrap_or(Value::Null);
        if id.is_empty() || !files.is_object() {
            return Err("网关暂存准备失败".into());
        }
        let ca =
            std::fs::read_to_string(&self.entry.ca).map_err(|e| format!("读取 CA 失败: {e}"))?;
        let token = std::fs::read_to_string(&self.entry.token_file)
            .map_err(|e| format!("读取 token 失败: {e}"))?
            .trim()
            .to_owned();
        for (local, kind) in [
            (bundle.package.as_path(), "package"),
            (bundle.checksum.as_path(), "checksum"),
            (bundle.installer.as_path(), "installer"),
        ] {
            let remote = files.get(kind).and_then(Value::as_str).unwrap_or_default();
            if remote.is_empty() {
                return Err("网关暂存路径无效".into());
            }
            crate::http::upload(&self.entry, &ca, &token, local, remote).await?;
        }
        self.prepared = Some(id);
        Ok(())
    }

    /// 经网关执行安装 RPC；identity 为私钥 PEM 内容。
    #[allow(clippy::too_many_arguments)]
    async fn install(
        &self,
        store: &Store,
        target: &DeployTarget,
        fingerprint: &str,
        identity: Option<&str>,
        password: Option<&str>,
        sudo_password: Option<&str>,
        on_output: Option<&mut (dyn FnMut(crate::client::StreamEvent) + Send)>,
    ) -> Result<InstallOutput, String> {
        let staging_id = self.prepared.clone().unwrap_or_default();
        let mut install_target = serde_json::json!({
            "host": target.host,
            "sshPort": target.ssh_port,
            "username": target.username,
            "fingerprint": fingerprint,
            "port": target.port,
            "runUser": "remote-exec",
        });
        if let Some(pem) = identity {
            install_target["identity"] = serde_json::json!(pem);
        }
        if let Some(secret) = password {
            install_target["password"] = serde_json::json!(secret);
        }
        if let Some(secret) = sudo_password {
            install_target["sudoPassword"] = serde_json::json!(secret);
        }
        let value = self
            .call(
                store,
                serde_json::json!({"action": "install", "id": staging_id, "target": install_target}),
                on_output,
            )
            .await?;
        InstallOutput::from_rpc(&value)
    }

    /// 经网关 relay 信封验收新部署主机（凭据为安装返回的 token+证书）。
    async fn verify(
        &self,
        store: &Store,
        target: &DeployTarget,
        credentials: &InstallOutput,
    ) -> Result<(), String> {
        if !matches!(credentials.run_user.as_str(), "root" | "remote-exec") {
            return Err("安装返回了未知服务身份".into());
        }
        let marker = format!("rex-deploy-{}", marker_hex());
        let envelope = serde_json::json!({
            "target": {"host": target.host, "port": target.port},
            "auth": {"token": credentials.token, "ca": credentials.certificate},
            "request": {"method": "exec", "params": {
                "command": format!("printf '\\n{marker}\\n'; id -un"),
                "timeoutMs": 5000,
            }},
            "timeoutMs": 10000,
        });
        let call = crate::client::Call {
            method: "relay".into(),
            params: envelope,
        };
        let mut interrupt = crate::client::Interrupt(None);
        let envelope = tokio::time::timeout(
            Duration::from_secs(15),
            crate::client::call_host(store, &self.name, &call, None, &mut interrupt),
        )
        .await
        .map_err(|_| "daemon 验收超时".to_owned())??;
        if let Some(error) = envelope.get("error").filter(|e| !e.is_null()) {
            return Err(format!(
                "daemon 验收 RPC 失败: {}",
                error.get("message").and_then(Value::as_str).unwrap_or("")
            ));
        }
        let result = envelope.get("result").cloned().unwrap_or(Value::Null);
        let stdout = decode_stdout(&result);
        let exit = result.get("exitCode").and_then(Value::as_i64).unwrap_or(-1);
        verify_reply(&stdout, exit, &marker, &credentials.run_user)
    }

    /// 释放网关暂存；返回错误文本供调用方提示（不视为部署失败）。
    async fn cleanup(&mut self, store: &Store) -> Option<String> {
        let id = self.prepared.take()?;
        match self
            .call(
                store,
                serde_json::json!({"action": "cleanup", "id": id}),
                None,
            )
            .await
        {
            Ok(_) => None,
            Err(error) => Some(format!("网关临时部署文件清理失败: {error}")),
        }
    }
}

fn marker_hex() -> String {
    format!("{:08x}", rand::random::<u32>())
}

/// 解码 exec 响应 stdout。
fn decode_stdout(result: &Value) -> String {
    String::from_utf8_lossy(&crate::client::decode_b64(result, "stdoutB64")).into_owned()
}

/// 验收公共断言：退出码为 0 且输出尾部为 marker + 服务用户。
fn verify_reply(stdout: &str, exit_code: i64, marker: &str, run_user: &str) -> Result<(), String> {
    let expected = format!("\n{marker}\n{run_user}");
    if exit_code == 0 && stdout.trim_end().ends_with(&expected) {
        Ok(())
    } else {
        Err("daemon 验收输出或执行用户不匹配".into())
    }
}

fn redact(text: &str, secrets: &[&str]) -> String {
    let mut clean = text.to_owned();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        clean = clean.replace(secret, "[已隐藏]");
    }
    clean
}

/// deploy 入口：返回进程退出码（0 全部成功）。
pub async fn run(store: &Store, args: &[String]) -> Result<i32, String> {
    let options = parse_options(args)?;
    let hosts = store.load().map_err(|e| e.to_string())?;
    for target in &options.targets {
        let record = config::Target {
            name: target.name.clone(),
            host: target.host.clone(),
            port: target.port,
            ssh_port: target.ssh_port,
            via: options.via.clone(),
        };
        store
            .assert_available(&record, &hosts)
            .map_err(|e| e.to_string())?;
    }
    let mut progress = |text: &str| output(text);
    let bundle = bundle::resolve(options.package.as_deref(), &mut progress)?;
    let mut gateway = match &options.via {
        Some(name) => Some(GatewayDeploy::resolve(store, name)?),
        None => None,
    };
    // 私钥统一在此读为 PEM 内容：直连与网关路径共用同一语义。
    let identity_pem = match &options.identity {
        Some(path) => {
            Some(std::fs::read_to_string(path).map_err(|e| format!("读取私钥 {path} 失败: {e}"))?)
        }
        None => None,
    };
    let cancelled = AtomicBool::new(false);
    let mut failures = 0;
    for target in &options.targets {
        if cancelled.load(Ordering::SeqCst) {
            output(&format!("{} 部署失败: 操作已取消\n", target.name));
            failures += 1;
            continue;
        }
        output(&format!("正在部署 {} ({})\n", target.name, target.host));
        let mut password: Option<String> = None;
        let mut sudo_password: Option<String> = None;
        let mut transcript = Transcript::new();
        let outcome: Result<(String, InstallOutput), String> = async {
            let fingerprint = match gateway.as_ref() {
                Some(gateway) => gateway.inspect(store, target).await?,
                None => ssh::inspect(&target.host, target.ssh_port).await?,
            };
            if !ssh::valid_fingerprint(&fingerprint) {
                return Err("SSH 返回无效主机指纹".into());
            }
            trust_known_fingerprint(
                store,
                &target.name,
                &target.host,
                target.ssh_port,
                options.host_key.as_deref(),
                &fingerprint,
            )
            .await?;

            let mut ssh_attempts = 0;
            let mut sudo_attempts = 0;
            let installed = loop {
                if cancelled.load(Ordering::SeqCst) {
                    return Err("操作已取消".into());
                }
                let attempt: Result<InstallOutput, String> = if let Some(gateway) = gateway.as_mut() {
                    gateway.ensure_prepared(store, &bundle).await?;
                    let mut via_output = |event: crate::client::StreamEvent| {
                        transcript.push(event.stderr, &event.data);
                    };
                    let call = gateway.install(
                        store,
                        target,
                        &fingerprint,
                        identity_pem.as_deref(),
                        password.as_deref(),
                        sudo_password.as_deref(),
                        Some(&mut via_output),
                    );
                    tokio::select! {
                        result = call => result,
                        _ = tokio::signal::ctrl_c() => {
                            cancelled.store(true, Ordering::SeqCst);
                            Err("操作已取消".into())
                        }
                    }
                } else {
                    let ssh_target = SshTarget {
                        host: target.host.clone(),
                        ssh_port: target.ssh_port,
                        username: target.username.clone(),
                        fingerprint: Some(fingerprint.clone()),
                        identity: identity_pem.clone(),
                        password: password.clone(),
                        sudo_password: sudo_password.clone(),
                    };
                    let mut direct_output = |stderr: bool, data: &[u8]| {
                        transcript.push(stderr, data);
                    };
                    tokio::select! {
                        result = install_target(&ssh_target, &bundle, target.port, &mut direct_output) => result,
                        _ = tokio::signal::ctrl_c() => {
                            cancelled.store(true, Ordering::SeqCst);
                            Err("操作已取消".into())
                        }
                    }
                };
                match attempt {
                    Ok(installed) => break installed,
                    Err(error) => {
                        if cancelled.load(Ordering::SeqCst) {
                            return Err("操作已取消".into());
                        }
                        if error.contains(ssh::AUTH_REQUIRED) && ssh_attempts < MAX_AUTH_ATTEMPTS {
                            ssh_attempts += 1;
                            password = Some(prompt::secret(&format!(
                                "{}@{} SSH 密码",
                                target.username, target.host
                            ))?);
                        } else if target.username != "root"
                            && error.contains(ssh::SUDO_PASSWORD_REQUIRED)
                            && sudo_attempts < MAX_AUTH_ATTEMPTS
                        {
                            sudo_attempts += 1;
                            sudo_password = Some(prompt::secret(&format!(
                                "{}@{} sudo 密码",
                                target.username, target.host
                            ))?);
                        } else {
                            return Err(error);
                        }
                    }
                }
            };
            if !installed.is_valid() {
                return Err("安装未返回有效连接凭据".into());
            }
            match gateway.as_ref() {
                Some(gateway) => gateway.verify(store, target, &installed).await?,
                None => verify_target(target, &installed).await?,
            }
            if cancelled.load(Ordering::SeqCst) {
                return Err("操作已取消".into());
            }
            let record = config::Target {
                name: target.name.clone(),
                host: target.host.clone(),
                port: target.port,
                ssh_port: target.ssh_port,
                via: options.via.clone(),
            };
            let credentials = Credentials {
                token: installed.token.clone(),
                certificate: installed.certificate.clone(),
            };
            store
                .register(&record, &credentials, None, None)
                .map_err(|e| e.to_string())?;
            Ok((installed.version.clone(), installed))
        }
        .await;
        match outcome {
            Ok((version, installed)) => {
                if !transcript.text.is_empty() {
                    output(&redact(
                        &transcript.text,
                        &[
                            password.as_deref().unwrap_or(""),
                            sudo_password.as_deref().unwrap_or(""),
                            &installed.token,
                            &installed.certificate,
                        ],
                    ));
                }
                output(&format!(
                    "{} 部署成功，已登记配置（版本 {version}）\n",
                    target.name
                ));
            }
            Err(error) => {
                let error = redact(&error, &[password.as_deref().unwrap_or("")]);
                output(&format!("{} 部署失败: {error}\n", target.name));
                failures += 1;
            }
        }
    }
    if let Some(gateway) = gateway.as_mut()
        && let Some(error) = gateway.cleanup(store).await
    {
        output(&format!("{error}\n"));
    }
    bundle.cleanup();
    Ok(if failures > 0 { 1 } else { 0 })
}
