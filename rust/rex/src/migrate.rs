//! rex migrate：把 Node 布局主机一次性迁移到 Rust supervisor 布局。
//!
//! 流程：预检（Node 安装在位、Rust 布局未存在）→ 并置安装
//! （versions 引导目录 + supervisor 单元，不影响运行中的 Node 服务）→
//! 单命令交接（停 Node、启 supervisor、ctl upgrade 建首个 generation）→
//! 旧凭据（CA pin + token）执行验收。`--rollback` 恢复 Node 服务
//! 并清理全部 Rust 资产，之后可重新迁移。
//!
//! 保留的 Node 资产（回滚用）：/opt/remote-exec/{runtime,src,node_modules,
//! install.json}、remote-exec.service 单元（迁移后 disabled）。
//! 证书与 token 原样复用（/etc/remote-exec/credentials、token.sha256），
//! 客户端凭据无需任何变化。

use crate::bundle;
use crate::client::{self, Call, Interrupt};
use crate::config::Store;
use crate::output;
use crate::upgrade::{
    CONTROL_SOCKET, CREDENTIALS_DIR, CURRENT_LINK, SshCommon, VERSIONS_DIR, arg_value, ctl,
    drive_with_retry, mktemp_staging, parse_ssh_args, remove_staging, unix_now_secs,
    unpack_generation,
};
use remote_exec_ssh::{self as ssh, Target as SshTarget};
use std::time::Duration;

const HELP: &str = "用法: rex migrate <主机> --package <tar.gz> [--ssh-user root] [--ssh-port 22] \
[--identity 私钥] [--host-key 指纹]\n       rex migrate <主机> --rollback [--ssh-user root] \
[--ssh-port 22] [--identity 私钥] [--host-key 指纹]";

/// Node 布局参数：install.json 中的端口与运行用户。
struct NodeLayout {
    port: u16,
    run_user: String,
}

/// 读取 install.json 的 port/runUser（Node 布局事实源），并做白名单校验。
async fn node_layout(session: &ssh::Session, target: &SshTarget) -> Result<NodeLayout, String> {
    let script = r#"port="$(sed -nE 's/^.+"port": *([0-9]+).*/\1/p' /opt/remote-exec/install.json)"
run_user="$(sed -nE 's/^.+"runUser": *"([^"]*)".*/\1/p' /opt/remote-exec/install.json)"
id -u "$run_user" >/dev/null
echo "port=$port"
echo "user=$run_user""#;
    let outcome = ssh::exec(session, target, script, None, Duration::from_secs(30), None).await?;
    if outcome.code != 0 {
        return Err(format!(
            "install.json 解析失败（退出码 {}）: {}",
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
    let port = port
        .filter(|port| *port > 0)
        .ok_or("install.json 缺少有效端口")?;
    let run_user = run_user.ok_or("install.json 缺少运行用户")?;
    if run_user != "remote-exec" && run_user != "root" {
        return Err(format!("runUser 无效: {run_user}"));
    }
    Ok(NodeLayout { port, run_user })
}

/// 迁移预检：Node 布局在位且服务运行、Rust 布局未存在、凭据完整。
async fn precheck(session: &ssh::Session, target: &SshTarget) -> Result<NodeLayout, String> {
    let script = r#"set -e
test -f /opt/remote-exec/install.json
test ! -e /opt/remote-exec/versions
test -f /etc/remote-exec/credentials/server.crt
test -f /etc/remote-exec/credentials/server.key
test -f /etc/remote-exec/credentials/token.sha256
systemctl is-active --quiet remote-exec.service"#;
    let outcome = ssh::exec(session, target, script, None, Duration::from_secs(30), None).await?;
    if outcome.code != 0 {
        return Err(format!(
            "预检失败（退出码 {}）: {}（需 Node 布局在位、Rust 布局未存在）",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    node_layout(session, target).await
}

/// 并置安装：解包引导 generation，supervisor 单元从发布包模板渲染，
/// Node 服务保持运行。
async fn prepare_parallel(
    session: &ssh::Session,
    target: &SshTarget,
    layout: &NodeLayout,
    staging: &str,
    sha256: &str,
) -> Result<String, String> {
    let generation = format!("migrate-{}-{}", unix_now_secs(), &sha256[..8]);
    unpack_generation(
        session,
        target,
        &generation,
        &format!("{staging}/package.tar.gz"),
    )
    .await?;
    // supervisor 单元与 install.sh 使用发布包内同一模板（@PORT@/@RUN_USER@ 占位）。
    let script = format!(
        "set -e; sed -e 's/@PORT@/{}/g' -e 's/@RUN_USER@/{}/g' \
{VERSIONS_DIR}/{generation}/packaging/remote-exec-supervisor.service \
> /etc/systemd/system/remote-exec-supervisor.service && systemctl daemon-reload",
        layout.port, layout.run_user
    );
    let outcome = ssh::exec(
        session,
        target,
        &script,
        None,
        Duration::from_secs(30),
        None,
    )
    .await?;
    if outcome.code != 0 {
        return Err(format!(
            "supervisor 单元安装失败（退出码 {}）: {}",
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
    let outcome = ssh::exec(
        session,
        target,
        &script,
        None,
        Duration::from_secs(120),
        None,
    )
    .await?;
    if outcome.code == 0 {
        return Ok(());
    }
    let recovery = restore_node_script();
    let _ = ssh::exec(
        session,
        target,
        &recovery,
        None,
        Duration::from_secs(120),
        None,
    )
    .await;
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
    let stdout = String::from_utf8_lossy(&client::decode_b64(&value, "stdoutB64"))
        .trim()
        .to_owned();
    if stdout != run_user {
        return Err(format!(
            "旧凭据验收失败：exec 以 {stdout} 执行（期望 {run_user}）"
        ));
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
    output(&format!(
        "{display} 预检通过：Node 端口 {}，运行用户 {}\n",
        layout.port, layout.run_user
    ));
    let staging = mktemp_staging(&session, ssh_target, "migrate").await?;
    let outcome = async {
        migrate_flow(
            &session,
            ssh_target,
            &layout,
            display,
            &staging,
            package_bytes,
            sha256,
        )
        .await?;
        verify_with_existing_credentials(store, display, &layout.run_user).await?;
        output(&format!(
            "{display} 迁移完成：旧凭据（CA pin + token）验收通过\n\
回滚：rex migrate {display} --rollback；Node 资产保留在 /opt/remote-exec（install.json 标记）\n"
        ));
        Ok(0)
    }
    .await;
    remove_staging(&session, ssh_target, &staging).await;
    outcome
}

/// 迁移主体：上传包 → 并置安装 → 交接 → ctl upgrade 建首个正式 generation。
async fn migrate_flow(
    session: &ssh::Session,
    target: &SshTarget,
    layout: &NodeLayout,
    display: &str,
    staging: &str,
    package_bytes: &[u8],
    sha256: &str,
) -> Result<(), String> {
    ssh::upload_bytes(session, &format!("{staging}/package.tar.gz"), package_bytes).await?;
    let generation = prepare_parallel(session, target, layout, staging, sha256).await?;
    output(&format!(
        "{display} 并置安装完成（引导 {generation}，Node 服务未受影响）\n"
    ));
    cutover(session, target).await?;
    output(&format!("{display} supervisor 已接管 {}\n", layout.port));
    // 首个正式 generation：backend 证书 pin 校验兼容 Node 自签叶子。
    ctl(
        session,
        target,
        &format!(
            "upgrade --package {staging}/package.tar.gz --sha256 {sha256} \
--versions-dir {VERSIONS_DIR} --link {CURRENT_LINK} \
--backend-protocol https --backend-ca {CREDENTIALS_DIR}/server.crt \
--cwd /var/lib/remote-exec \
-- {{version_dir}}/bin/remote-execd daemon --cert {CREDENTIALS_DIR}/server.crt \
--key {CREDENTIALS_DIR}/server.key --token-sha256-file {CREDENTIALS_DIR}/token.sha256"
        ),
    )
    .await?;
    Ok(())
}

async fn drive_rollback(
    store: &Store,
    ssh_target: &SshTarget,
    display: &str,
) -> Result<i32, String> {
    let session = ssh::connect(ssh_target).await?;
    // 前置：Node 布局在位且已完成过迁移（versions 存在）。
    let check = ssh::exec(
        &session,
        ssh_target,
        "test -f /opt/remote-exec/install.json && test -d /opt/remote-exec/versions",
        None,
        Duration::from_secs(15),
        None,
    )
    .await?;
    if check.code != 0 {
        return Err("未发现可回滚的迁移（需 install.json 与 versions 同时在位）".into());
    }
    let layout = node_layout(&session, ssh_target).await?;
    let script = format!(
        "set -e; {}; \
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
(exec 3<>/dev/tcp/127.0.0.1/{}) 2>/dev/null && exit 0; sleep 1; done; \
echo 'Node 服务端口未就绪' >&2; exit 1",
        restore_node_script(),
        layout.port
    );
    let outcome = ssh::exec(
        &session,
        ssh_target,
        &script,
        None,
        Duration::from_secs(120),
        None,
    )
    .await?;
    if outcome.code != 0 {
        return Err(format!(
            "回滚失败（退出码 {}）: {}",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    verify_with_existing_credentials(store, display, &layout.run_user).await?;
    output(&format!(
        "{display} 已回滚到 Node 服务（Rust 布局已清理）；可重新执行 rex migrate\n"
    ));
    Ok(0)
}

pub async fn run(store: &Store, args: &[String]) -> Result<i32, String> {
    let mut package = String::new();
    let mut rollback = false;
    let parsed = parse_ssh_args(args, HELP, "迁移", |flag, index| {
        match flag {
            "--package" => {
                package = arg_value(args, *index, flag)?;
                *index += 1;
            }
            "--rollback" => rollback = true,
            other => return Err(format!("未知参数: {other}")),
        }
        Ok(())
    })?;
    let entry = store.host(&parsed.host).map_err(|e| e.to_string())?;
    if entry.via.is_some() {
        return Err(format!(
            "\"{}\" 经网关中转，SSH 不可直连；网关主机迁移属 Phase 5",
            parsed.host
        ));
    }
    if package.is_empty() && !rollback {
        return Err(format!("缺少 --package <tar.gz>\n{HELP}"));
    }
    if !package.is_empty() && rollback {
        return Err(format!("--rollback 不需要 --package\n{HELP}"));
    }
    let bundle = if rollback {
        None
    } else {
        Some(bundle::resolve_raw(&package)?)
    };
    let common = SshCommon {
        display: parsed.host.clone(),
        host: entry.host.clone(),
        ssh_user: parsed.ssh_user.clone(),
        ssh_port: parsed.ssh_port,
        identity: parsed.identity.clone(),
        host_key: parsed.host_key.clone(),
    };
    let result = if rollback {
        let display = common.display.clone();
        drive_with_retry(store, &common, "回滚", move |ssh_target| {
            let display = display.clone();
            async move { drive_rollback(store, &ssh_target, &display).await }
        })
        .await
    } else {
        let package_bytes = std::fs::read(&bundle.as_ref().expect("非回滚必有包").package)
            .map_err(|e| format!("读取迁移包失败: {e}"))?;
        use sha2::Digest;
        let sha256 = sha2::Sha256::digest(&package_bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let display = common.display.clone();
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
