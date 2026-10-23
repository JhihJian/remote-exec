//! rex migrate：把 Node 布局主机一次性迁移到 Rust supervisor 布局。
//!
//! 流程：预检（Node 安装在位、Rust 布局未存在）→ 并置安装
//! （versions 引导目录 + supervisor 单元，不影响运行中的 Node 服务）→
//! 单命令交接（停 Node、启 supervisor、ctl upgrade 建首个 generation）→
//! 旧凭据（CA pin + token）执行验收。`--rollback` 恢复 Node 服务。
//!
//! 保留的 Node 资产（回滚用）：/opt/remote-exec/{runtime,src,node_modules,
//! install.json}、remote-exec.service 单元（迁移后 disabled）。
//! 证书与 token 原样复用（/etc/remote-exec/credentials、token.sha256），
//! 客户端凭据无需任何变化。

use crate::bundle;
use crate::client::{self, Call, Interrupt};
use crate::config::Store;
use crate::upgrade::{
    drive_with_retry, output, SshCommon, CONTROL_SOCKET, CREDENTIALS_DIR, CURRENT_LINK,
    VERSIONS_DIR,
};
use remote_exec_ssh::{self as ssh, Target as SshTarget};
use serde_json::Value;
use std::time::Duration;

const HELP: &str = "用法: rex migrate <主机> --package <tar.gz> [--ssh-user root] [--ssh-port 22] \
[--identity 私钥] [--host-key 指纹]\n       rex migrate <主机> --rollback [--ssh-user root] \
[--ssh-port 22] [--identity 私钥] [--host-key 指纹]";

struct Options {
    host: String,
    package: String,
    ssh_user: String,
    ssh_port: u16,
    identity: Option<String>,
    host_key: Option<String>,
    rollback: bool,
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut host: Option<String> = None;
    let mut package = String::new();
    let mut ssh_user = "root".to_owned();
    let mut ssh_port: u16 = 22;
    let mut identity = None;
    let mut host_key = None;
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
            "--package" => package = value(&mut index)?,
            "--ssh-user" => ssh_user = value(&mut index)?,
            "--ssh-port" => {
                ssh_port = value(&mut index)?
                    .parse()
                    .map_err(|_| "ssh-port 必须为 1..65535".to_owned())?;
                if ssh_port == 0 {
                    return Err("ssh-port 必须为 1..65535".into());
                }
            }
            "--identity" => {
                let path = value(&mut index)?;
                let pem = std::fs::read_to_string(&path)
                    .map_err(|e| format!("读取私钥 {path} 失败: {e}"))?;
                identity = Some(pem);
            }
            "--host-key" => host_key = Some(value(&mut index)?),
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
    let host = host.ok_or(format!("请指定要迁移的主机\n{HELP}"))?;
    Ok(Options {
        host,
        package,
        ssh_user,
        ssh_port,
        identity,
        host_key,
        rollback,
    })
}

/// Node 布局参数：install.json 中的端口与运行用户。
struct NodeLayout {
    port: u16,
    run_user: String,
}

async fn run_script(
    session: &ssh::Session,
    target: &SshTarget,
    script: &str,
    timeout: Duration,
) -> Result<ssh::ExecOutcome, String> {
    let outcome = ssh::exec(session, target, script, None, timeout, None).await?;
    Ok(outcome)
}

async fn precheck(session: &ssh::Session, target: &SshTarget) -> Result<NodeLayout, String> {
    let script = r#"set -e
test -f /opt/remote-exec/install.json
test ! -e /opt/remote-exec/versions
test -f /etc/remote-exec/credentials/server.crt
test -f /etc/remote-exec/credentials/server.key
test -f /etc/remote-exec/credentials/token.sha256
systemctl is-active --quiet remote-exec.service
port="$(sed -n 's/^.*"port": *\([0-9][0-9]*\).*/\1/p' /opt/remote-exec/install.json)"
run_user="$(sed -n 's/^.*"runUser": *"\([^"]*\)".*/\1/p' /opt/remote-exec/install.json)"
case "$run_user" in remote-exec|root) ;; *) echo "runUser 无效: $run_user" >&2; exit 3 ;; esac
case "$port" in ''|*[!0-9]*) echo "port 无效: $port" >&2; exit 3 ;; esac
id -u "$run_user" >/dev/null
echo "port=$port"
echo "user=$run_user"
"#;
    let outcome = run_script(session, target, script, Duration::from_secs(30)).await?;
    if outcome.code != 0 {
        return Err(format!(
            "预检失败（退出码 {}）: {}（需 Node 布局在位、Rust 布局未存在）",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    let mut port = None;
    let mut run_user = None;
    for line in outcome.stdout.lines() {
        if let Some(value) = line.strip_prefix("port=") {
            port = value.parse::<u16>().ok();
        } else if let Some(value) = line.strip_prefix("user=") {
            run_user = Some(value.to_owned());
        }
    }
    let port = port.ok_or("预检输出缺少端口")?;
    let run_user = run_user.ok_or("预检输出缺少运行用户")?;
    if run_user != "remote-exec" && run_user != "root" {
        return Err(format!("runUser 无效: {run_user}"));
    }
    Ok(NodeLayout { port, run_user })
}

/// 并置安装：引导 generation + supervisor 单元，Node 服务保持运行。
async fn prepare_parallel(
    session: &ssh::Session,
    target: &SshTarget,
    layout: &NodeLayout,
    staging: &str,
    sha256: &str,
) -> Result<String, String> {
    let generation = format!(
        "migrate-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        &sha256[..8]
    );
    let unit = format!(
        "[Unit]\nDescription=remote-exec supervisor\nAfter=network.target\n\n\
[Service]\nType=simple\nUser=root\n\
ExecStart=/opt/remote-exec/current/bin/remote-execd supervisor --host 0.0.0.0 --port {} \
--control {CONTROL_SOCKET} --state /etc/remote-exec/supervisor-state.json --run-user {}\n\
RuntimeDirectory=remote-exec\nRestart=on-failure\nRestartSec=2\n\n\
[Install]\nWantedBy=multi-user.target\n",
        layout.port, layout.run_user
    );
    let script = format!(
        "set -e; umask 022; \
mkdir -p {VERSIONS_DIR} && mkdir -p {VERSIONS_DIR}/{generation} && \
tar -xzf {staging}/package.tar.gz -C {VERSIONS_DIR}/{generation} && \
chmod -R a+rX,go-w {VERSIONS_DIR}/{generation} && \
test -x {VERSIONS_DIR}/{generation}/bin/remote-execd && \
ln -sfn {VERSIONS_DIR}/{generation} {CURRENT_LINK} && \
cat > /etc/systemd/system/remote-exec-supervisor.service <<'UNIT'\n{unit}UNIT\n\
systemctl daemon-reload",
    );
    let outcome = run_script(session, target, &script, Duration::from_secs(120)).await?;
    if outcome.code != 0 {
        return Err(format!(
            "并置安装失败（退出码 {}）: {}",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    Ok(generation)
}

/// 单命令交接：停 Node、启 supervisor、等控制套接字；失败时完整恢复 Node。
async fn cutover(session: &ssh::Session, target: &SshTarget) -> Result<(), String> {
    let script = format!(
        "set -e; \
systemctl disable --now remote-exec.service && \
systemctl enable --now remote-exec-supervisor.service && \
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
test -S {CONTROL_SOCKET} && exit 0; sleep 1; done; \
echo 'supervisor 控制套接字未就绪' >&2; exit 1"
    );
    let outcome = run_script(session, target, &script, Duration::from_secs(120)).await?;
    if outcome.code == 0 {
        return Ok(());
    }
    let recovery = restore_node_script();
    let _ = run_script(session, target, &recovery, Duration::from_secs(120)).await;
    Err(format!(
        "切换失败（退出码 {}）: {}，已尝试恢复 Node 服务",
        outcome.code,
        outcome.stderr.trim()
    ))
}

/// 完整恢复 Node：停并清理 supervisor 布局（含 versions、state、单元），重启 Node 服务。
fn restore_node_script() -> String {
    format!(
        "systemctl disable --now remote-exec-supervisor.service 2>/dev/null; \
rm -rf -- {VERSIONS_DIR}; rm -f -- {CURRENT_LINK} /etc/remote-exec/supervisor-state.json \
/etc/systemd/system/remote-exec-supervisor.service; systemctl daemon-reload; \
systemctl enable --now remote-exec.service"
    )
}

/// 旧凭据验收：迁移不改证书与 token，用客户端既有凭据执行命令。
async fn verify_with_existing_credentials(
    store: &Store,
    host: &str,
    run_user: &str,
) -> Result<(), String> {
    let mut interrupt = Interrupt(None);
    let value = client::call_host(
        store,
        host,
        &Call {
            method: "exec".into(),
            params: serde_json::json!({"command": "id -un", "timeoutMs": 30_000}),
        },
        None,
        &mut interrupt,
    )
    .await?;
    use base64::Engine;
    let stdout = value
        .get("stdoutB64")
        .and_then(Value::as_str)
        .map(|s| base64::engine::general_purpose::STANDARD.decode(s).unwrap_or_default())
        .unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout).trim().to_owned();
    if stdout != run_user {
        return Err(format!("旧凭据验收失败：exec 以 {stdout} 执行（期望 {run_user}）"));
    }
    Ok(())
}

async fn drive_migrate(
    store: &Store,
    ssh_target: &SshTarget,
    display: &str,
    package_bytes: &[u8],
    sha256: &str,
) -> Result<i32, String> {
    let session = ssh::connect(ssh_target).await?;
    let layout = precheck(&session, ssh_target).await?;
    let staging = ssh::exec(
        &session,
        ssh_target,
        "umask 077; mktemp -d /tmp/remote-exec-migrate.XXXXXXXX",
        None,
        Duration::from_secs(30),
        None,
    )
    .await?;
    let staging_path = staging.stdout.trim().to_owned();
    if staging.code != 0
        || !staging_path.starts_with("/tmp/remote-exec-migrate.")
        || staging_path.len() != "/tmp/remote-exec-migrate.".len() + 8
    {
        return Err("无法创建迁移暂存目录".into());
    }
    let migration = Migration {
        display,
        staging: &staging_path,
        package_bytes,
        sha256,
    };
    let outcome = migrate_flow(&session, ssh_target, store, &layout, &migration).await;
    let _ = ssh::exec(
        &session,
        ssh_target,
        &format!("rm -rf -- {}", ssh::shell_quote(&staging_path)),
        None,
        Duration::from_secs(15),
        None,
    )
    .await;
    outcome
}

/// 一次迁移的上下文参数。
struct Migration<'a> {
    display: &'a str,
    staging: &'a str,
    package_bytes: &'a [u8],
    sha256: &'a str,
}

async fn migrate_flow(
    session: &ssh::Session,
    target: &SshTarget,
    store: &Store,
    layout: &NodeLayout,
    migration: &Migration<'_>,
) -> Result<i32, String> {
    let (display, staging, package_bytes, sha256) = (
        migration.display,
        migration.staging,
        migration.package_bytes,
        migration.sha256,
    );
    output(&format!("{display} 预检通过：Node 端口 {}，运行用户 {}\n", layout.port, layout.run_user));
    ssh::upload_bytes(session, &format!("{staging}/package.tar.gz"), package_bytes).await?;
    let generation =
        prepare_parallel(session, target, layout, staging, sha256).await?;
    output(&format!(
        "{display} 并置安装完成（引导 {generation}，Node 服务未受影响）\n"
    ));
    cutover(session, target).await?;
    output(&format!("{display} supervisor 已接管 {}\n", layout.port));
    // 首个正式 generation：backend 证书 pin 校验兼容 Node 自签叶子。
    let ctl_command = format!(
        "upgrade --package {staging}/package.tar.gz --sha256 {sha256} \
--versions-dir {VERSIONS_DIR} --link {CURRENT_LINK} \
--backend-protocol https --backend-ca {CREDENTIALS_DIR}/server.crt \
--cwd /var/lib/remote-exec \
-- {{version_dir}}/bin/remote-execd daemon --cert {CREDENTIALS_DIR}/server.crt \
--key {CREDENTIALS_DIR}/server.key --token-sha256-file {CREDENTIALS_DIR}/token.sha256"
    );
    let ctl_binary = format!("{CURRENT_LINK}/bin/remote-execd");
    let outcome = ssh::exec(
        session,
        target,
        &format!("{ctl_binary} ctl --control {CONTROL_SOCKET} {ctl_command}"),
        None,
        Duration::from_secs(300),
        None,
    )
    .await?;
    if outcome.code != 0 {
        return Err(format!(
            "ctl upgrade 失败（退出码 {}）: {}",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    verify_with_existing_credentials(store, display, &layout.run_user).await?;
    output(&format!(
        "{display} 迁移完成：旧凭据（CA pin + token）验收通过\n\
回滚：rex migrate {display} --rollback；Node 资产保留在 /opt/remote-exec（install.json 标记）\n"
    ));
    Ok(0)
}

async fn drive_rollback(
    store: &Store,
    ssh_target: &SshTarget,
    display: &str,
) -> Result<i32, String> {
    let session = ssh::connect(ssh_target).await?;
    let script = format!(
        "set -e; test -f /opt/remote-exec/install.json; test -d {versions_dir}; {restore}; \
port=\"$(sed -nE 's/^.+\"port\": *([0-9]+).*/\\1/p' /opt/remote-exec/install.json)\"; \
case \"$port\" in ''|*[!0-9]*) echo 'port 解析失败' >&2; exit 3;; esac; \
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
(exec 3<>/dev/tcp/127.0.0.1/\"$port\") 2>/dev/null && exit 0; sleep 1; done; \
echo 'Node 服务端口未就绪' >&2; exit 1",
        versions_dir = VERSIONS_DIR,
        restore = restore_node_script()
    );
    let outcome = run_script(&session, ssh_target, &script, Duration::from_secs(120)).await?;
    if outcome.code != 0 {
        return Err(format!(
            "回滚失败（退出码 {}）: {}",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    let layout_user = ssh::exec(
        &session,
        ssh_target,
        "sed -n 's/^.*\"runUser\": *\"\\([^\"]*\\)\".*/\\1/p' /opt/remote-exec/install.json",
        None,
        Duration::from_secs(15),
        None,
    )
    .await?;
    let run_user = layout_user.stdout.trim().to_owned();
    if run_user != "remote-exec" && run_user != "root" {
        return Err(format!("install.json runUser 无效: {run_user}"));
    }
    verify_with_existing_credentials(store, display, &run_user).await?;
    output(&format!(
        "{display} 已回滚到 Node 服务（Rust 布局已清理）；可重新执行 rex migrate\n"
    ));
    Ok(0)
}

pub async fn run(store: &Store, args: &[String]) -> Result<i32, String> {
    let options = parse_options(args)?;
    let entry = store.host(&options.host).map_err(|e| e.to_string())?;
    if entry.via.is_some() {
        return Err(format!(
            "\"{}\" 经网关中转，SSH 不可直连；网关主机迁移属 Phase 5",
            options.host
        ));
    }
    if options.package.is_empty() && !options.rollback {
        return Err(format!("缺少 --package <tar.gz>\n{HELP}"));
    }
    if !options.package.is_empty() && options.rollback {
        return Err(format!("--rollback 不需要 --package\n{HELP}"));
    }
    let bundle = if options.rollback {
        None
    } else {
        Some(bundle::resolve_raw(&options.package)?)
    };
    let common = SshCommon {
        display: options.host.clone(),
        host: entry.host.clone(),
        ssh_user: options.ssh_user.clone(),
        ssh_port: options.ssh_port,
        identity: options.identity.clone(),
        host_key: options.host_key.clone(),
    };
    let display = options.host.clone();
    let result = if options.rollback {
        drive_with_retry(store, &common, "回滚", |ssh_target| {
            let display = display.clone();
            async move { drive_rollback(store, &ssh_target, &display).await }
        })
        .await
    } else {
        let package_bytes = std::fs::read(&bundle.as_ref().expect("非回滚必有包").package)
            .map_err(|e| format!("读取迁移包失败: {e}"))?;
        use sha2::Digest;
        let digest = sha2::Sha256::digest(&package_bytes);
        let sha256 = digest.iter().map(|b| format!("{b:02x}")).collect::<String>();
        drive_with_retry(store, &common, "迁移", move |ssh_target| {
            let package_bytes = package_bytes.clone();
            let sha256 = sha256.clone();
            let display = display.clone();
            async move {
                drive_migrate(store, &ssh_target, &display, &package_bytes, &sha256).await
            }
        })
        .await
    };
    if let Some(bundle) = bundle {
        bundle.cleanup();
    }
    result
}
