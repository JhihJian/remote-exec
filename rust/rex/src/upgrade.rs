//! rex upgrade：对已部署主机执行两段式升级（ctl upgrade + drain 等待 + retire）。
//! 前提：目标已按生产布局安装（/opt/remote-exec/{versions,current}、
//! /run/remote-exec/supervisor.sock、/etc/remote-exec/credentials）。
//! --via 网关主机升级属 Phase 4/5；本子命令只支持可直连 SSH 的主机。
use crate::bundle;
use crate::config::{self, Store};
use crate::prompt;
use crate::ssh::{self, Target as SshTarget};
use serde_json::Value;
use std::time::Duration;

const HELP: &str = "用法: rex upgrade <主机> --package <tar.gz> [--ssh-user root] [--ssh-port 22] \
[--identity 私钥] [--host-key 指纹] [--retire-wait-secs 300] [--rollback]";

const VERSIONS_DIR: &str = "/opt/remote-exec/versions";
const CURRENT_LINK: &str = "/opt/remote-exec/current";
const CONTROL_SOCKET: &str = "/run/remote-exec/supervisor.sock";
const CREDENTIALS_DIR: &str = "/etc/remote-exec/credentials";
const CTL_BINARY: &str = "/opt/remote-exec/current/bin/remote-execd";

struct Options {
    host: String,
    package: String,
    ssh_user: String,
    ssh_port: u16,
    identity: Option<String>,
    host_key: Option<String>,
    retire_wait: u64,
    rollback: bool,
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut host: Option<String> = None;
    let mut package: Option<String> = None;
    let mut ssh_user = "root".to_owned();
    let mut ssh_port: u16 = 22;
    let mut identity = None;
    let mut host_key = None;
    let mut retire_wait: u64 = 300;
    let mut rollback = false;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let value = |index: &mut usize| -> Result<String, String> {
            let value = args.get(*index + 1).ok_or(format!("{arg} 缺少值"))?.clone();
            if value.starts_with("--") {
                return Err(format!("{arg} 缺少值"));
            }
            *index += 1;
            Ok(value)
        };
        match arg {
            "--help" | "-h" => return Err(format!("{HELP}\n")),
            "--package" => package = Some(value(&mut index)?),
            "--ssh-user" => ssh_user = value(&mut index)?,
            "--ssh-port" => {
                ssh_port = value(&mut index)?
                    .parse()
                    .map_err(|_| "ssh-port 必须为 1..65535".to_owned())?;
                if ssh_port == 0 {
                    return Err("ssh-port 必须为 1..65535".into());
                }
            }
            "--identity" => identity = Some(value(&mut index)?),
            "--host-key" => host_key = Some(value(&mut index)?),
            "--retire-wait-secs" => {
                retire_wait = value(&mut index)?
                    .parse()
                    .map_err(|_| "retire-wait-secs 必须为非负整数".to_owned())?;
            }
            "--rollback" => rollback = true,
            other if other.starts_with("--") => return Err(format!("未知参数: {other}")),
            other => {
                if host.replace(other.to_owned()).is_some() {
                    return Err(format!("重复主机: {other}"));
                }
            }
        }
        index += 1;
    }
    let host = host.ok_or(format!("请指定要升级的主机\n{HELP}"))?;
    let package = package.unwrap_or_default();
    Ok(Options {
        host,
        package,
        ssh_user,
        ssh_port,
        identity,
        host_key,
        retire_wait,
        rollback,
    })
}

fn output(text: &str) {
    use std::io::Write;
    let mut stderr = std::io::stderr().lock();
    let _ = write!(stderr, "{text}");
    let _ = stderr.flush();
}

/// 指纹信任（与 deploy 相同：已知 > --host-key > 交互确认）。
async fn trust_fingerprint(store: &Store, options: &Options) -> Result<String, String> {
    let fingerprint = ssh::inspect(options.host_for_ssh(), options.ssh_port).await?;
    let record = config::Target {
        name: options.host.clone(),
        host: options.host_for_ssh().to_owned(),
        port: 0,
        ssh_port: options.ssh_port,
        via: None,
    };
    let known = store.get_fingerprint(&record).map_err(|e| e.to_string())?;
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
            options.host_for_ssh(),
            options.ssh_port
        ))?;
        if !confirmed {
            return Err("未确认 SSH 主机指纹".into());
        }
    }
    store
        .save_fingerprint(&record, &fingerprint)
        .map_err(|e| e.to_string())?;
    Ok(fingerprint)
}

impl Options {
    /// SSH 目标地址（run() 已将 options.host 解析为 hosts 条目的真实地址）。
    fn host_for_ssh(&self) -> &str {
        &self.host
    }
}

async fn ctl(session: &ssh::Session, target: &SshTarget, args: &str) -> Result<Value, String> {
    let command = format!(
        "{} ctl --control {} {}",
        CTL_BINARY, CONTROL_SOCKET, args
    );
    let outcome = ssh::exec(session, target, &command, None, Duration::from_secs(300), None).await?;
    if outcome.code != 0 {
        return Err(format!(
            "ctl {args} 失败（退出码 {}）: {}",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    serde_json::from_str(outcome.stdout.trim())
        .map_err(|_| format!("ctl {args} 输出无法解析为 JSON: {}", outcome.stdout.trim()))
}

async fn ctl_raw(session: &ssh::Session, target: &SshTarget, args: &str) -> Result<(), String> {
    let command = format!(
        "{} ctl --control {} {}",
        CTL_BINARY, CONTROL_SOCKET, args
    );
    let outcome = ssh::exec(session, target, &command, None, Duration::from_secs(300), None).await?;
    if outcome.code != 0 {
        return Err(format!(
            "ctl {args} 失败（退出码 {}）: {}",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    Ok(())
}

pub async fn run(store: &Store, args: &[String]) -> Result<i32, String> {
    let mut options = parse_options(args)?;
    let entry = store.host(&options.host).map_err(|e| e.to_string())?;
    if entry.via.is_some() {
        return Err(format!(
            "\"{}\" 经网关中转，SSH 不可直连；网关主机升级将在 Phase 4/5 支持",
            options.host
        ));
    }
    if options.package.is_empty() && !options.rollback {
        return Err(format!("缺少 --package <tar.gz>\n{HELP}"));
    }
    options.host = entry.host.clone();
    // rollback 不需要包；正常升级先本地校验（含 sha256 兄弟文件）避免上传损坏包。
    let bundle = if options.rollback {
        None
    } else {
        if options.package.is_empty() {
            return Err(format!("缺少 --package <tar.gz>\n{HELP}"));
        }
        Some(bundle::resolve_raw(&options.package)?)
    };
    let result = upgrade_host(store, &options, bundle.as_ref()).await;
    if let Some(bundle) = bundle {
        bundle.cleanup();
    }
    result
}

async fn upgrade_host(
    store: &Store,
    options: &Options,
    bundle: Option<&bundle::RawBundle>,
) -> Result<i32, String> {
    let fingerprint = trust_fingerprint(store, options).await?;
    let mut password: Option<String> = None;
    let mut sudo_password: Option<String> = None;
    let mut attempts = 0;
    let mut sudo_attempts = 0;
    loop {
        let ssh_target = SshTarget {
            host: options.host_for_ssh().to_owned(),
            ssh_port: options.ssh_port,
            username: options.ssh_user.clone(),
            fingerprint: Some(fingerprint.clone()),
            identity: options.identity.clone(),
            password: password.clone(),
            sudo_password: sudo_password.clone(),
        };
        let attempt = tokio::select! {
            result = drive_upgrade(&ssh_target, options, bundle) => result,
            _ = tokio::signal::ctrl_c() => Err("操作已取消".into()),
        };
        match attempt {
            Ok(code) => return Ok(code),
            Err(error) => {
                if error.contains(ssh::AUTH_REQUIRED) && attempts < 3 {
                    attempts += 1;
                    password = Some(prompt::secret(&format!(
                        "{}@{} SSH 密码",
                        options.ssh_user,
                        options.host_for_ssh()
                    ))?);
                } else if options.ssh_user != "root"
                    && error.contains(ssh::SUDO_PASSWORD_REQUIRED)
                    && sudo_attempts < 3
                {
                    sudo_attempts += 1;
                    sudo_password = Some(prompt::secret(&format!(
                        "{}@{} sudo 密码",
                        options.ssh_user,
                        options.host_for_ssh()
                    ))?);
                } else {
                    output(&format!("{} 升级失败: {error}\n", options.host));
                    return Ok(1);
                }
            }
        }
    }
}

async fn drive_upgrade(
    ssh_target: &SshTarget,
    options: &Options,
    bundle: Option<&bundle::RawBundle>,
) -> Result<i32, String> {
    let session = ssh::connect(ssh_target).await?;
    if options.rollback {
        ctl_raw(&session, ssh_target, "rollback").await?;
        // supervisor 只切换进程，不管理 current 链接；按 active generation 名同步链接。
        let status = ctl(&session, ssh_target, "status").await?;
        let active = status
            .get("active")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !active.is_empty() {
            let _ = ssh::exec(
                &session,
                ssh_target,
                &format!(
                    "ln -sfn {} {}",
                    ssh::shell_quote(&format!("{VERSIONS_DIR}/{active}")),
                    ssh::shell_quote(CURRENT_LINK)
                ),
                None,
                Duration::from_secs(15),
                None,
            )
            .await;
        }
        output(&format!("{} 已回滚到 {active}\n", options.host));
        return Ok(0);
    }
    let Some(bundle) = bundle else {
        return Err("内部错误: 升级缺少包".into());
    };
    let staging = ssh::exec(
        &session,
        ssh_target,
        "umask 077; mktemp -d /tmp/remote-exec-upgrade.XXXXXXXX",
        None,
        Duration::from_secs(30),
        None,
    )
    .await?;
    let staging_path = staging.stdout.trim().to_owned();
    if staging.code != 0
        || !staging_path.starts_with("/tmp/remote-exec-upgrade.")
        || staging_path.len() != "/tmp/remote-exec-upgrade.".len() + 8
    {
        return Err("无法创建升级暂存目录".into());
    }
    let outcome = try_upgrade(&session, ssh_target, options, bundle, &staging_path).await;
    let _ = ssh::exec(
        &session,
        ssh_target,
        &format!("rm -rf -- {}", ssh::shell_quote(&staging_path)),
        None,
        Duration::from_secs(15),
        None,
    )
    .await;
    let summary = outcome?;
    let generation = summary
        .get("generation")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let previous = summary
        .get("previous")
        .and_then(Value::as_str)
        .map(str::to_owned);
    output(&format!(
        "{} 已切换到新版本 {generation}",
        options.host
    ));
    // 两段式：等待旧 generation 连接归零后 retire；窗口到期则提示手工处理。
    if let Some(previous) = previous {
        match wait_and_retire(&session, ssh_target, &previous, options.retire_wait).await {
            Ok(()) => output(&format!("，旧版本 {previous} 已回收\n")),
            Err(error) => output(&format!(
                "。旧版本 {previous} 回收未完成（{error}），可稍后执行 remote-execd ctl --control {CONTROL_SOCKET} retire {previous}\n"
            )),
        }
    } else {
        output("\n");
    }
    Ok(0)
}

async fn try_upgrade(
    session: &ssh::Session,
    ssh_target: &SshTarget,
    _options: &Options,
    bundle: &bundle::RawBundle,
    staging_path: &str,
) -> Result<Value, String> {
    let package_data = std::fs::read(&bundle.package).map_err(|e| format!("读取升级包失败: {e}"))?;
    use sha2::Digest;
    let sha256 = sha2::Sha256::digest(&package_data);
    let sha256 = sha256.iter().map(|b| format!("{b:02x}")).collect::<String>();
    ssh::upload_file(
        session,
        &format!("{staging_path}/package.tar.gz"),
        &package_data,
    )
    .await?;
    // 首装引导：current 尚不存在时 ctl 二进制本身不可用，
    // 直接解包首个版本、建立链接并拉起 supervisor 单元。
    let probe = ssh::exec(
        session,
        ssh_target,
        &format!("test -x {}", CTL_BINARY),
        None,
        Duration::from_secs(15),
        None,
    )
    .await?;
    if probe.code != 0 {
        // 首装引导只负责让 ctl 二进制与 supervisor 单元可用；
        // daemon generation 仍统一由下方 ctl upgrade 创建。
        bootstrap_first_install(session, ssh_target, &sha256, staging_path).await?;
    }
    let command = format!(
        "upgrade --package {} --sha256 {} --versions-dir {} --link {} \
--backend-protocol https --backend-ca {}/ca.crt -- \
{{version_dir}}/bin/remote-execd daemon --cert {}/server.crt --key {}/server.key \
--token-sha256-file {}/token.sha256",
        ssh::shell_quote(&format!("{staging_path}/package.tar.gz")),
        sha256,
        VERSIONS_DIR,
        CURRENT_LINK,
        CREDENTIALS_DIR,
        CREDENTIALS_DIR,
        CREDENTIALS_DIR,
        CREDENTIALS_DIR,
    );
    ctl(session, ssh_target, &command).await
}

/// 首装：解包到 versions/<id>、建立 current 链接、启用并等待 supervisor 单元。
async fn bootstrap_first_install(
    session: &ssh::Session,
    ssh_target: &SshTarget,
    sha256: &str,
    staging_path: &str,
) -> Result<Value, String> {
    let generation = format!(
        "bootstrap-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        &sha256[..8]
    );
    let package = ssh::shell_quote(&format!("{staging_path}/package.tar.gz"));
    let script = format!(
        "set -e; mkdir -p {VERSIONS_DIR} && mkdir -p {VERSIONS_DIR}/{generation} && \
tar -xzf {package} -C {VERSIONS_DIR}/{generation} && \
chmod -R a+rX,go-w {VERSIONS_DIR}/{generation} && \
test -x {VERSIONS_DIR}/{generation}/bin/remote-execd && \
ln -sfn {VERSIONS_DIR}/{generation} {CURRENT_LINK} && \
systemctl daemon-reload && systemctl enable --now remote-exec-supervisor.service && \
for _ in 1 2 3 4 5 6 7 8 9 10; do test -S {CONTROL_SOCKET} && exit 0; sleep 1; done; \
echo 'supervisor 控制套接字未就绪' >&2; exit 1"
    );
    let outcome = ssh::exec(session, ssh_target, &script, None, Duration::from_secs(120), None).await?;
    if outcome.code != 0 {
        return Err(format!(
            "首装引导失败（退出码 {}）: {}",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    Ok(serde_json::json!({ "generation": generation, "previous": null }))
}

async fn wait_and_retire(
    session: &ssh::Session,
    ssh_target: &SshTarget,
    generation: &str,
    wait_secs: u64,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(wait_secs);
    loop {
        let status = ctl(session, ssh_target, "status").await?;
        let draining = status
            .get("generations")
            .and_then(Value::as_array)
            .and_then(|list| {
                list.iter()
                    .find(|g| g.get("name").and_then(Value::as_str) == Some(generation))
            })
            .ok_or_else(|| format!("status 中不存在 generation {generation}"))?;
        let connections = draining
            .get("connections")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if connections == 0 {
            let state = draining.get("state").and_then(Value::as_str).unwrap_or("");
            if state == "active" {
                return Err(format!(
                    "generation {generation} 处于 active 状态，可能已发生回滚"
                ));
            }
            ctl_raw(session, ssh_target, &format!("retire {generation}")).await?;
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "旧版本仍有 {connections} 个连接（等待 {wait_secs}s 超时）"
            ));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
