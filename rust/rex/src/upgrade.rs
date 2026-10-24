//! rex upgrade：对已部署主机执行两段式升级（ctl upgrade + drain 等待 + retire）。
//! 前提：目标已按生产布局安装（/opt/remote-exec/{versions,current}、
//! /run/remote-exec/supervisor.sock、/etc/remote-exec/credentials）。
//! --via 网关主机升级属 Phase 4/5；本子命令只支持可直连 SSH 的主机。
use crate::bundle;
use crate::config::{self, Store};
use crate::prompt;
use remote_exec_ssh::{self as ssh, Target as SshTarget};
use serde_json::Value;
use std::time::Duration;

const HELP: &str = "用法: rex upgrade <主机> --package <tar.gz> [--ssh-user root] [--ssh-port 22] \
[--identity 私钥] [--host-key 指纹] [--retire-wait-secs 300] [--rollback]";

pub(crate) const VERSIONS_DIR: &str = "/opt/remote-exec/versions";
pub(crate) const CURRENT_LINK: &str = "/opt/remote-exec/current";
pub(crate) const CONTROL_SOCKET: &str = "/run/remote-exec/supervisor.sock";
pub(crate) const CREDENTIALS_DIR: &str = "/etc/remote-exec/credentials";
const CTL_BINARY: &str = "/opt/remote-exec/current/bin/remote-execd";

/// 公共 SSH 连接参数（位置参数主机与 --ssh-user/--ssh-port/--identity/--host-key）。
pub(crate) struct SshArgs {
    pub host: String,
    pub ssh_user: String,
    pub ssh_port: u16,
    pub identity: Option<String>,
    pub host_key: Option<String>,
}

/// 读取 args[index+1] 作为 flag 的值（拒绝把下一个 flag 当值）。
pub(crate) fn arg_value(args: &[String], index: usize, flag: &str) -> Result<String, String> {
    let value = args.get(index + 1).ok_or(format!("{flag} 缺少值"))?;
    if value.starts_with("--") {
        return Err(format!("{flag} 缺少值"));
    }
    Ok(value.clone())
}

/// 解析公共 SSH 参数；extra 消费子命令专属选项，读取值后自行推进 *index。
pub(crate) fn parse_ssh_args(
    args: &[String],
    help: &str,
    verb: &str,
    mut extra: impl FnMut(&str, &mut usize) -> Result<(), String>,
) -> Result<SshArgs, String> {
    let mut host: Option<String> = None;
    let mut ssh_user = "root".to_owned();
    let mut ssh_port: u16 = 22;
    let mut identity = None;
    let mut host_key = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let value = |index: &mut usize| -> Result<String, String> {
            let value = arg_value(args, *index, arg)?;
            *index += 1;
            Ok(value)
        };
        match arg {
            "--help" | "-h" => return Err(format!("{help}\n")),
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
            other if other.starts_with("--") => extra(other, &mut index)?,
            other => {
                if host.replace(other.to_owned()).is_some() {
                    return Err(format!("重复主机: {other}"));
                }
            }
        }
        index += 1;
    }
    let host = host.ok_or(format!("请指定要{verb}的主机\n{help}"))?;
    Ok(SshArgs {
        host,
        ssh_user,
        ssh_port,
        identity,
        host_key,
    })
}

pub(crate) fn output(text: &str) {
    crate::output(text)
}

/// SSH 连接参数（主机名已解析为真实地址），upgrade 与 migrate 共用。
pub(crate) struct SshCommon {
    /// 展示用主机名（hosts 条目名）。
    pub display: String,
    /// SSH 实际地址。
    pub host: String,
    pub ssh_user: String,
    pub ssh_port: u16,
    pub identity: Option<String>,
    pub host_key: Option<String>,
}

/// 指纹信任裁决（与 deploy 相同：已知 > --host-key > 交互确认），通过则记录。
/// inspect 方式由调用方决定（直连或网关 RPC）。
pub(crate) async fn trust_known_fingerprint(
    store: &Store,
    name: &str,
    host: &str,
    ssh_port: u16,
    host_key: Option<&str>,
    fingerprint: &str,
) -> Result<(), String> {
    let record = config::Target {
        name: name.to_owned(),
        host: host.to_owned(),
        port: 0,
        ssh_port,
        via: None,
    };
    let known = store.get_fingerprint(&record).map_err(|e| e.to_string())?;
    let has_known = known.is_some();
    if known.as_deref().is_some_and(|known| known != fingerprint) {
        return Err("SSH 主机指纹发生变化，拒绝连接".into());
    }
    if host_key.is_some_and(|expected| expected != fingerprint) {
        return Err("SSH 主机指纹与 --host-key 不匹配".into());
    }
    if !has_known && host_key.is_none() {
        let confirmed = prompt::confirm(&format!(
            "信任 {}:{} 的 SSH 指纹 {fingerprint}？",
            host, ssh_port
        ))?;
        if !confirmed {
            return Err("未确认 SSH 主机指纹".into());
        }
    }
    store
        .save_fingerprint(&record, fingerprint)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 直连探测并裁决指纹信任。
async fn trust_fingerprint(store: &Store, common: &SshCommon) -> Result<String, String> {
    let fingerprint = ssh::inspect(&common.host, common.ssh_port).await?;
    trust_known_fingerprint(
        store,
        &common.display,
        &common.host,
        common.ssh_port,
        common.host_key.as_deref(),
        &fingerprint,
    )
    .await?;
    Ok(fingerprint)
}

/// 连接并执行 drive，自动处理密码/sudo 重试与 SIGINT；失败时返回退出码。
pub(crate) async fn drive_with_retry<'a, F, Fut>(
    store: &'a Store,
    common: &SshCommon,
    verb: &str,
    mut drive: F,
) -> Result<i32, String>
where
    F: FnMut(SshTarget) -> Fut,
    Fut: std::future::Future<Output = Result<i32, String>> + 'a,
{
    let fingerprint = trust_fingerprint(store, common).await?;
    let mut password: Option<String> = None;
    let mut sudo_password: Option<String> = None;
    let mut attempts = 0;
    let mut sudo_attempts = 0;
    loop {
        let ssh_target = SshTarget {
            host: common.host.clone(),
            ssh_port: common.ssh_port,
            username: common.ssh_user.clone(),
            fingerprint: Some(fingerprint.clone()),
            identity: common.identity.clone(),
            password: password.clone(),
            sudo_password: sudo_password.clone(),
        };
        let attempt = tokio::select! {
            result = drive(ssh_target) => result,
            _ = tokio::signal::ctrl_c() => Err("操作已取消".into()),
        };
        match attempt {
            Ok(code) => return Ok(code),
            Err(error) => {
                if error.contains(ssh::AUTH_REQUIRED) && attempts < 3 {
                    attempts += 1;
                    password = Some(prompt::secret(&format!(
                        "{}@{} SSH 密码",
                        common.ssh_user, common.host
                    ))?);
                } else if common.ssh_user != "root"
                    && error.contains(ssh::SUDO_PASSWORD_REQUIRED)
                    && sudo_attempts < 3
                {
                    sudo_attempts += 1;
                    sudo_password = Some(prompt::secret(&format!(
                        "{}@{} sudo 密码",
                        common.ssh_user, common.host
                    ))?);
                } else {
                    output(&format!("{} {}失败: {error}\n", common.display, verb));
                    return Ok(1);
                }
            }
        }
    }
}

/// 经 supervisor 控制套接字执行 ctl 子命令，解析 JSON 输出。
pub(crate) async fn ctl(
    session: &ssh::Session,
    target: &SshTarget,
    args: &str,
) -> Result<Value, String> {
    let command = format!("{} ctl --control {} {}", CTL_BINARY, CONTROL_SOCKET, args);
    let outcome = ssh::exec(
        session,
        target,
        &command,
        None,
        Duration::from_secs(300),
        None,
    )
    .await?;
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
    let command = format!("{} ctl --control {} {}", CTL_BINARY, CONTROL_SOCKET, args);
    let outcome = ssh::exec(
        session,
        target,
        &command,
        None,
        Duration::from_secs(300),
        None,
    )
    .await?;
    if outcome.code != 0 {
        return Err(format!(
            "ctl {args} 失败（退出码 {}）: {}",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    Ok(())
}

/// 远端 /tmp 暂存目录（0700），前缀区分用途。
pub(crate) async fn mktemp_staging(
    session: &ssh::Session,
    target: &SshTarget,
    name: &str,
) -> Result<String, String> {
    let prefix = format!("/tmp/remote-exec-{name}");
    let outcome = ssh::exec(
        session,
        target,
        &format!("umask 077; mktemp -d {prefix}.XXXXXXXX"),
        None,
        Duration::from_secs(30),
        None,
    )
    .await?;
    let path = outcome.stdout.trim().to_owned();
    if outcome.code != 0
        || !path.starts_with(&format!("{prefix}."))
        || path.len() != prefix.len() + 9
    {
        return Err("无法创建暂存目录".into());
    }
    Ok(path)
}

/// 删除远端暂存目录（尽力而为，失败不阻断主流程）。
pub(crate) async fn remove_staging(session: &ssh::Session, target: &SshTarget, path: &str) {
    let _ = ssh::exec(
        session,
        target,
        &format!("rm -rf -- {}", ssh::shell_quote(path)),
        None,
        Duration::from_secs(15),
        None,
    )
    .await;
}

pub(crate) fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 解包发布包到 versions/<generation> 并建立 current 链接（要求目录不存在）。
pub(crate) async fn unpack_generation(
    session: &ssh::Session,
    target: &SshTarget,
    generation: &str,
    package: &str,
) -> Result<(), String> {
    let script = format!(
        "set -e; mkdir -p {VERSIONS_DIR} && mkdir -p {VERSIONS_DIR}/{generation} && \
tar -xzf {package} -C {VERSIONS_DIR}/{generation} && \
chmod -R a+rX,go-w {VERSIONS_DIR}/{generation} && \
test -x {VERSIONS_DIR}/{generation}/bin/remote-execd && \
ln -sfn {VERSIONS_DIR}/{generation} {CURRENT_LINK}",
        package = ssh::shell_quote(package),
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
    if outcome.code != 0 {
        return Err(format!(
            "解包失败（退出码 {}）: {}",
            outcome.code,
            outcome.stderr.trim()
        ));
    }
    Ok(())
}

pub async fn run(store: &Store, args: &[String]) -> Result<i32, String> {
    let mut package = String::new();
    let mut retire_wait: u64 = 300;
    let mut rollback = false;
    let parsed = parse_ssh_args(args, HELP, "升级", |flag, index| {
        match flag {
            "--package" => {
                package = arg_value(args, *index, flag)?;
                *index += 1;
            }
            "--retire-wait-secs" => {
                retire_wait = arg_value(args, *index, flag)?
                    .parse()
                    .map_err(|_| "retire-wait-secs 必须为非负整数".to_owned())?;
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
            "\"{}\" 经网关中转，SSH 不可直连；网关主机升级将在 Phase 4/5 支持",
            parsed.host
        ));
    }
    if package.is_empty() && !rollback {
        return Err(format!("缺少 --package <tar.gz>\n{HELP}"));
    }
    // rollback 不需要包；正常升级先本地校验（含 sha256 兄弟文件）避免上传损坏包。
    let bundle = if rollback {
        None
    } else {
        Some(bundle::resolve_raw(&package)?)
    };
    let common = SshCommon {
        display: entry.host.clone(),
        host: entry.host.clone(),
        ssh_user: parsed.ssh_user.clone(),
        ssh_port: parsed.ssh_port,
        identity: parsed.identity.clone(),
        host_key: parsed.host_key.clone(),
    };
    let bundle_ref = bundle.as_ref();
    let common_ref = &common;
    let result = drive_with_retry(store, common_ref, "升级", |ssh_target| async move {
        drive_upgrade(&ssh_target, common_ref, bundle_ref, retire_wait).await
    })
    .await;
    if let Some(bundle) = bundle {
        bundle.cleanup();
    }
    result
}

async fn drive_upgrade(
    ssh_target: &SshTarget,
    common: &SshCommon,
    bundle: Option<&bundle::RawBundle>,
    retire_wait: u64,
) -> Result<i32, String> {
    let session = ssh::connect(ssh_target).await?;
    // rollback：supervisor 只切换进程，不管理 current 链接，按 active 名同步链接。
    let Some(bundle) = bundle else {
        ctl_raw(&session, ssh_target, "rollback").await?;
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
        output(&format!("{} 已回滚到 {active}\n", common.display));
        return Ok(0);
    };
    let staging = mktemp_staging(&session, ssh_target, "upgrade").await?;
    let outcome = try_upgrade(&session, ssh_target, bundle, &staging).await;
    remove_staging(&session, ssh_target, &staging).await;
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
    output(&format!("{} 已切换到新版本 {generation}", common.display));
    // 两段式：等待旧 generation 连接归零后 retire；窗口到期则提示手工处理。
    if let Some(previous) = previous {
        match wait_and_retire(&session, ssh_target, &previous, retire_wait).await {
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
    bundle: &bundle::RawBundle,
    staging_path: &str,
) -> Result<Value, String> {
    let package_data =
        std::fs::read(&bundle.package).map_err(|e| format!("读取升级包失败: {e}"))?;
    use sha2::Digest;
    let sha256 = sha2::Sha256::digest(&package_data);
    let sha256 = sha256
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    ssh::upload_bytes(
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
    // backend CA：正式 CA 优先；rex migrate 迁移主机沿用 Node 自签叶子（pin 校验）。
    let ca_probe = ssh::exec(
        session,
        ssh_target,
        &format!("if test -f {CREDENTIALS_DIR}/ca.crt; then echo ca; else echo leaf; fi"),
        None,
        Duration::from_secs(15),
        None,
    )
    .await?;
    let backend_ca = format!(
        "{CREDENTIALS_DIR}/{}",
        if ca_probe.stdout.trim() == "ca" {
            "ca.crt"
        } else {
            "server.crt"
        }
    );
    let command = format!(
        "upgrade --package {} --sha256 {} --versions-dir {} --link {} \
--backend-protocol https --backend-ca {backend_ca} -- \
{{version_dir}}/bin/remote-execd daemon --cert {}/server.crt --key {}/server.key \
--token-sha256-file {}/token.sha256",
        ssh::shell_quote(&format!("{staging_path}/package.tar.gz")),
        sha256,
        VERSIONS_DIR,
        CURRENT_LINK,
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
    let generation = format!("bootstrap-{}-{}", unix_now_secs(), &sha256[..8]);
    unpack_generation(
        session,
        ssh_target,
        &generation,
        &format!("{staging_path}/package.tar.gz"),
    )
    .await?;
    let script = format!(
        "set -e; systemctl daemon-reload && systemctl enable --now remote-exec-supervisor.service && \
for _ in 1 2 3 4 5 6 7 8 9 10; do test -S {CONTROL_SOCKET} && exit 0; sleep 1; done; \
echo 'supervisor 控制套接字未就绪' >&2; exit 1"
    );
    let outcome = ssh::exec(
        session,
        ssh_target,
        &script,
        None,
        Duration::from_secs(120),
        None,
    )
    .await?;
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
