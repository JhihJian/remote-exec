//! rex deploy：SSH 直连部署 Node 发布包（russh 移植 src/deploy/{cli,ssh}.js）。
//! --via 网关部署属 Phase 4；本子命令只做直连。
use crate::bundle;
use crate::config::{self, Credentials, Store};
use crate::prompt;
use crate::ssh::{self, Target as SshTarget};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const HELP: &str = "用法: rex deploy [--port 8791] [--identity 私钥路径] [--package tar.gz] \
[--ssh-port 22] [--host-key SHA256:...] [name=]user@IPv4 ...";

struct DeployTarget {
    name: String,
    username: String,
    host: String,
    port: u16,
    ssh_port: u16,
}

struct Options {
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
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()) && {
                let value: u32 = p.parse().unwrap_or(999);
                value <= 255 && !(p.len() > 1 && p.starts_with('0'))
            })
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut options = Options {
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
            "--via" => {
                return Err("rex deploy 暂不支持 --via 网关部署（Phase 4 支持），请直连部署".into())
            }
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
                            && name.chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) =>
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
    if let Some(host_key) = &options.host_key {
        let valid = host_key.starts_with("SHA256:")
            && host_key.len() == 50
            && host_key[7..]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/');
        if !valid || options.targets.len() != 1 {
            return Err("--host-key 需要 SHA256 指纹且仅支持单目标".into());
        }
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
    let result = install_steps(&session, ssh_target, files, daemon_port, &mut temporary, on_output).await;
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
    let probe = ssh::exec(session, ssh_target, "true", None, Duration::from_secs(15), None).await?;
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
        ssh::upload_file(session, &format!("{staging_path}/{remote}"), &data).await?;
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
    let version = manifest.get("version").and_then(Value::as_str).unwrap_or("");
    let run_user = manifest.get("runUser").and_then(Value::as_str).unwrap_or("");
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
async fn verify_target(
    target: &DeployTarget,
    credentials: &InstallOutput,
) -> Result<(), String> {
    if !matches!(credentials.run_user.as_str(), "root" | "remote-exec") {
        return Err("安装返回了未知服务身份".into());
    }
    let marker = format!(
        "rex-deploy-{}",
        hex_random()
    );
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
        crate::client::call_entry_pinned(&entry, &credentials.token, &credentials.certificate, &call),
    )
    .await
    .map_err(|_| "daemon 验收超时".to_owned())?
    .map_err(|e| format!("daemon 验收失败: {e}"))?;
    use base64::Engine;
    let stdout = result
        .get("stdoutB64")
        .and_then(Value::as_str)
        .map(|s| {
            base64::engine::general_purpose::STANDARD
                .decode(s)
                .unwrap_or_default()
        })
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    let exit = result.get("exitCode").and_then(Value::as_i64).unwrap_or(-1);
    let expected = format!("\n{marker}\n{}", credentials.run_user);
    if exit != 0 || !stdout.trim_end().ends_with(&expected) {
        return Err("daemon 验收输出或执行用户不匹配".into());
    }
    Ok(())
}

fn hex_random() -> String {
    use sha2::{Digest, Sha256};
    let seed = format!(
        "{}{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let digest = Sha256::digest(seed.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn redact(text: &str, secrets: &[&str]) -> String {
    let mut clean = text.to_owned();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        clean = clean.replace(secret, "[已隐藏]");
    }
    clean
}

fn output(text: &str) {
    use std::io::Write;
    let mut stderr = std::io::stderr().lock();
    let _ = write!(stderr, "{text}");
    let _ = stderr.flush();
}

/// deploy 入口：返回进程退出码（0 全部成功）。
pub async fn run(store: &Store, args: &[String]) -> Result<i32, String> {
    let options = if args.first().map(String::as_str) == Some("deploy") {
        parse_options(&args[1..])?
    } else {
        parse_options(args)?
    };
    let hosts = store.load().map_err(|e| e.to_string())?;
    for target in &options.targets {
        let record = config::Target {
            name: target.name.clone(),
            host: target.host.clone(),
            port: target.port,
            ssh_port: target.ssh_port,
            via: None,
        };
        store
            .assert_available(&record, &hosts)
            .map_err(|e| e.to_string())?;
    }
    let mut progress = |text: &str| output(text);
    let bundle = bundle::resolve(options.package.as_deref(), &mut progress)?;
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
        let mut transcript = String::new();
        let mut truncated = false;
        let outcome: Result<(String, InstallOutput), String> = async {
            let fingerprint = ssh::inspect(&target.host, target.ssh_port).await?;
            let valid = fingerprint.starts_with("SHA256:")
                && fingerprint.len() == 50
                && fingerprint[7..]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/');
            if !valid {
                return Err("SSH 返回无效主机指纹".into());
            }
            let record = config::Target {
                name: target.name.clone(),
                host: target.host.clone(),
                port: target.port,
                ssh_port: target.ssh_port,
                via: None,
            };
            let known = store
                .get_fingerprint(&record)
                .map_err(|e| e.to_string())?;
            let has_known = known.is_some();
            if known.as_deref().is_some_and(|known| known != fingerprint) {
                return Err("SSH 主机指纹发生变化，拒绝连接".into());
            }
            if options.host_key.as_deref().is_some_and(|k| k != fingerprint) {
                return Err("SSH 主机指纹与 --host-key 不匹配".into());
            }
            if !has_known && options.host_key.is_none() {
                let confirmed = prompt::confirm(&format!(
                    "信任 {}:{} 的 SSH 指纹 {fingerprint}？",
                    target.host, target.ssh_port
                ))?;
                if !confirmed {
                    return Err("未确认 SSH 主机指纹".into());
                }
            }
            store
                .save_fingerprint(&record, &fingerprint)
                .map_err(|e| e.to_string())?;

            let mut ssh_attempts = 0;
            let mut sudo_attempts = 0;
            let installed = loop {
                if cancelled.load(Ordering::SeqCst) {
                    return Err("操作已取消".into());
                }
                let ssh_target = SshTarget {
                    host: target.host.clone(),
                    ssh_port: target.ssh_port,
                    username: target.username.clone(),
                    fingerprint: Some(fingerprint.clone()),
                    identity: options.identity.clone(),
                    password: password.clone(),
                    sudo_password: sudo_password.clone(),
                };
                let mut collector = |stderr: bool, data: &[u8]| {
                    if truncated {
                        return;
                    }
                    let text = String::from_utf8_lossy(data);
                    if transcript.len() + text.len() > 1024 * 1024 {
                        transcript.clear();
                        truncated = true;
                    } else {
                        transcript.push_str(&text);
                    }
                    let _ = stderr;
                };
                let attempt = tokio::select! {
                    result = install_target(&ssh_target, &bundle, target.port, &mut collector) => result,
                    _ = tokio::signal::ctrl_c() => {
                        cancelled.store(true, Ordering::SeqCst);
                        Err("操作已取消".into())
                    }
                };
                match attempt {
                    Ok(installed) => break installed,
                    Err(error) => {
                        if cancelled.load(Ordering::SeqCst) {
                            return Err("操作已取消".into());
                        }
                        if error.contains(ssh::AUTH_REQUIRED) && ssh_attempts < 3 {
                            ssh_attempts += 1;
                            password = Some(prompt::secret(&format!(
                                "{}@{} SSH 密码",
                                target.username, target.host
                            ))?);
                        } else if target.username != "root"
                            && error.contains(ssh::SUDO_PASSWORD_REQUIRED)
                            && sudo_attempts < 3
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
            if installed.token.is_empty()
                || !installed.certificate.contains("BEGIN CERTIFICATE")
            {
                return Err("安装未返回有效连接凭据".into());
            }
            verify_target(target, &installed).await?;
            if cancelled.load(Ordering::SeqCst) {
                return Err("操作已取消".into());
            }
            let record = config::Target {
                name: target.name.clone(),
                host: target.host.clone(),
                port: target.port,
                ssh_port: target.ssh_port,
                via: None,
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
                if !transcript.is_empty() {
                    output(&redact(
                        &transcript,
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
    bundle.cleanup();
    Ok(if failures > 0 { 1 } else { 0 })
}
