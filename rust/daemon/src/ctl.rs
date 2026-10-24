//! remote-execd ctl：supervisor 控制面客户端。
//!
//! 面向 SSH root 通道提供查看、两段式升级、回滚与退役入口：
//! upgrade 只负责校验、解包、start 候选、promote 与更新 current 链接，
//! 不在同一调用内 retire 旧版本；旧版本的退役由外部按窗口驱动。

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixStream,
    },
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// promote 重试窗口与间隔：覆盖候选进程监听端口的启动耗时。
const PROMOTE_TIMEOUT: Duration = Duration::from_secs(15);
const PROMOTE_RETRY_INTERVAL: Duration = Duration::from_millis(300);

type AnyError = crate::AnyError;

fn usage() -> String {
    "用法:\n\
     remote-execd ctl --control <sock> status\n\
     remote-execd ctl --control <sock> rollback\n\
     remote-execd ctl --control <sock> retire <name>\n\
     remote-execd ctl --control <sock> upgrade --package <tar.gz> --sha256 <hex> \\\n\
     \x20 --versions-dir <dir> [--link <path>] [--cwd <dir>] [--env K=V]...\
\
     \x20 [--backend-protocol http|https] [--backend-ca <pem>] -- <command...>\n\
     upgrade 会在 command 末尾追加 --port <port>，端口由 ctl 分配并指向回环 backend。\n\
     command 中的 {version_dir} 会替换为解包后的版本目录绝对路径，\n\
     用于引用包内解压出的二进制（如 {version_dir}/bin/remote-execd）。"
        .to_owned()
}

fn control(socket: &Path, request: &Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket)
        .map_err(|error| format!("连接控制面 {} 失败: {error}", socket.display()))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|error| format!("设置控制面读取超时失败: {error}"))?;
    let line = serde_json::to_string(request).map_err(|error| error.to_string())?;
    stream
        .write_all(format!("{line}\n").as_bytes())
        .map_err(|error| format!("发送控制请求失败: {error}"))?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| format!("读取控制响应失败: {error}"))?;
    if line.trim().is_empty() {
        return Err("控制面在响应前关闭了连接".into());
    }
    let response: Value = serde_json::from_str(line.trim())
        .map_err(|error| format!("控制响应不是有效 JSON: {error}"))?;
    if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("控制面返回未知错误")
            .to_owned())
    }
}

fn print_result(result: &Value) {
    match serde_json::to_string_pretty(result) {
        Ok(text) => println!("{text}"),
        Err(error) => eprintln!("结果 JSON 编码失败: {error}"),
    }
}

fn file_sha256(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 65536];
    loop {
        let size = file.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        hasher.update(&buffer[..size]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// 将 Unix 纪元起的天数换算为 UTC 公历日期（Howard Hinnant civil_from_days）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn version_timestamp(seconds: u64) -> String {
    let (year, month, day) = civil_from_days((seconds / 86400) as i64);
    let time = seconds % 86400;
    format!(
        "{year:04}{month:02}{day:02}{:02}{:02}{:02}",
        time / 3600,
        time % 3600 / 60,
        time % 60
    )
}

/// 版本目录名：UTC 时间戳 + 包哈希前 8 位，字典序即时间序。
fn generation_id(digest: &str) -> String {
    format!("{}-{}", version_timestamp(now_seconds()), &digest[..8])
}

fn allocate_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("分配回环端口失败: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("分配回环端口失败: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

/// command 不得自带 --port：端口由 ctl 统一分配后追加。
fn ensure_no_port_flag(command: &[String]) -> Result<(), String> {
    if command
        .iter()
        .any(|argument| argument == "--port" || argument.starts_with("--port="))
    {
        return Err("command 不得包含 --port，端口由 ctl 分配并追加".into());
    }
    Ok(())
}

fn default_current_link(versions_dir: &Path) -> PathBuf {
    versions_dir
        .parent()
        .unwrap_or_else(|| Path::new("/"))
        .join("current")
}

/// 原子更新 current 链接：先建同目录临时符号链接，再 rename 覆盖。
fn update_current_link(link: &Path, version_dir: &Path) -> Result<(), String> {
    let parent = link
        .parent()
        .ok_or_else(|| format!("--link 路径缺少父目录: {}", link.display()))?;
    let target = version_dir
        .strip_prefix(parent)
        .unwrap_or(version_dir)
        .to_path_buf();
    let temp = parent.join(format!(".current-new-{}", std::process::id()));
    let _ = fs::remove_file(&temp);
    symlink(&target, &temp).map_err(|error| format!("创建 current 临时链接失败: {error}"))?;
    if let Err(error) = fs::rename(&temp, link) {
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "更新 current 链接 {} 失败: {error}",
            link.display()
        ));
    }
    Ok(())
}

/// 解包 tar.gz 到目标目录。拒绝绝对路径、.. 与链接类条目，
/// 只接受普通文件与目录，防止包内容逃逸版本目录。
fn unpack_package(package: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(package).map_err(|error| format!("打开包失败: {error}"))?;
    let gzip = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gzip);
    let entries = archive
        .entries()
        .map_err(|error| format!("读取包条目失败: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("读取包条目失败: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("读取包条目路径失败: {error}"))?
            .into_owned();
        if path.is_absolute() {
            return Err(format!("包内包含绝对路径条目: {}", path.display()));
        }
        if path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(format!("包内包含 .. 路径条目: {}", path.display()));
        }
        match entry.header().entry_type() {
            tar::EntryType::Regular | tar::EntryType::Directory => {}
            other => {
                return Err(format!(
                    "包内包含不支持的条目类型 {other:?}: {}",
                    path.display()
                ));
            }
        }
        entry
            .unpack_in(dest)
            .map_err(|error| format!("解包 {} 失败: {error}", path.display()))?;
    }
    Ok(())
}

struct UpgradeOptions {
    package: String,
    sha256: String,
    versions_dir: PathBuf,
    link: Option<PathBuf>,
    cwd: Option<String>,
    env: Vec<(String, String)>,
    backend_protocol: String,
    backend_ca: Option<String>,
    command: Vec<String>,
}

fn parse_upgrade_args(args: &[String]) -> Result<UpgradeOptions, String> {
    let mut package = None;
    let mut sha256 = None;
    let mut versions_dir = None;
    let mut link = None;
    let mut cwd = None;
    let mut env = Vec::new();
    let mut backend_protocol = String::new();
    let mut backend_ca = None;
    let mut command = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let argument = args[index].as_str();
        if argument == "--" {
            command = args[index + 1..].to_vec();
            break;
        }
        let value = match args.get(index + 1) {
            Some(value) if !value.starts_with("--") => value.clone(),
            _ => return Err(format!("{argument} 需要一个不以 -- 开头的值")),
        };
        match argument {
            "--package" => package = Some(value),
            "--sha256" => sha256 = Some(value),
            "--versions-dir" => versions_dir = Some(value),
            "--link" => link = Some(value),
            "--cwd" => cwd = Some(value),
            "--backend-protocol" => {
                if value != "http" && value != "https" {
                    return Err("--backend-protocol 只支持 http 或 https".into());
                }
                backend_protocol = value;
            }
            "--backend-ca" => backend_ca = Some(value),
            "--env" => {
                let Some((key, env_value)) = value.split_once('=') else {
                    return Err("--env 需要 K=V 形式".into());
                };
                if key.is_empty() {
                    return Err("--env 的键不能为空".into());
                }
                env.push((key.to_owned(), env_value.to_owned()));
            }
            other => return Err(format!("未知 upgrade 参数: {other}")),
        }
        index += 2;
    }
    let package = package.ok_or("upgrade 必须提供 --package <tar.gz>")?;
    let sha256 = sha256.ok_or("upgrade 必须提供 --sha256 <hex>")?;
    let versions_dir = versions_dir.ok_or("upgrade 必须提供 --versions-dir <dir>")?;
    if command.is_empty() {
        return Err("upgrade 必须在 -- 之后提供候选启动命令".into());
    }
    if backend_ca.is_some() && backend_protocol.is_empty() {
        return Err("--backend-ca 需要 --backend-protocol https".into());
    }
    Ok(UpgradeOptions {
        package,
        sha256,
        versions_dir: PathBuf::from(versions_dir),
        link: link.map(PathBuf::from),
        cwd,
        env,
        backend_protocol,
        backend_ca,
        command,
    })
}

/// 候选失败时回收：drain 置为 draining，retire 终止托管进程并移除记录。
fn retire_candidate(socket: &Path, id: &str) -> Option<String> {
    let mut problems = Vec::new();
    if let Err(error) = control(socket, &json!({"method": "drain", "generation": id})) {
        problems.push(format!("drain 失败: {error}"));
    }
    if let Err(error) = control(socket, &json!({"method": "retire", "generation": id})) {
        problems.push(format!("retire 失败: {error}"));
    }
    (!problems.is_empty()).then(|| problems.join("；"))
}

fn cleanup_version_dir(version_dir: &Path) {
    if let Err(error) = fs::remove_dir_all(version_dir) {
        eprintln!("清理版本目录 {} 失败: {error}", version_dir.display());
    }
}

fn upgrade(socket: &Path, args: &[String]) -> Result<Value, String> {
    let options = parse_upgrade_args(args)?;
    let expected = options.sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("--sha256 必须是 64 位十六进制字符".into());
    }
    ensure_no_port_flag(&options.command)?;
    let package_path = PathBuf::from(&options.package);
    let digest = file_sha256(&package_path)
        .map_err(|error| format!("读取包 {} 失败: {error}", options.package))?;
    if digest != expected {
        return Err(format!("包 SHA-256 不匹配：期望 {expected}，实际 {digest}"));
    }

    // 解包到 versions/<id>/，目录 root 属主 0755。
    let id = generation_id(&digest);
    let version_dir = options.versions_dir.join(&id);
    if version_dir.exists() {
        // 同秒内重复升级（id 含秒级时间戳）或对已 active 版本重放：
        // 目录内容标记一致且已是 active 时幂等成功，否则拒绝。
        let active = control(socket, &json!({"method": "status"}))
            .ok()
            .and_then(|status| {
                status
                    .get("active")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let marker_ok = fs::read_to_string(version_dir.join(".package-sha256"))
            .map(|text| text.trim() == expected)
            .unwrap_or(false);
        if active.as_deref() == Some(id.as_str()) && marker_ok {
            return Ok(json!({"id": id, "state": "active", "idempotent": true}));
        }
        return Err(format!("版本目录已存在: {}", version_dir.display()));
    }
    let prepare = (|| {
        fs::create_dir_all(&options.versions_dir)
            .map_err(|error| format!("创建 {} 失败: {error}", options.versions_dir.display()))?;
        fs::create_dir(&version_dir)
            .map_err(|error| format!("创建 {} 失败: {error}", version_dir.display()))?;
        fs::set_permissions(&version_dir, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("设置 {} 权限失败: {error}", version_dir.display()))?;
        unpack_package(&package_path, &version_dir)?;
        // 内容标记：同 id 重放时判定目录与包一致。
        fs::write(version_dir.join(".package-sha256"), format!("{digest}\n")).map_err(|error| {
            format!(
                "写入 {} 失败: {error}",
                version_dir.join(".package-sha256").display()
            )
        })
    })();
    if let Err(error) = prepare {
        cleanup_version_dir(&version_dir);
        return Err(error);
    }

    // 当前 active 作为 previous；首次安装（无 active）直接 promote 候选。
    let previous = match control(socket, &json!({"method": "status"})) {
        Ok(status) => status
            .get("active")
            .and_then(Value::as_str)
            .map(str::to_owned),
        Err(error) => {
            cleanup_version_dir(&version_dir);
            return Err(format!("查询 supervisor 状态失败: {error}"));
        }
    };

    // 组装 start 请求：backend 固定回环 http，command 追加分配端口。
    let port = match allocate_loopback_port() {
        Ok(port) => port,
        Err(error) => {
            cleanup_version_dir(&version_dir);
            return Err(error);
        }
    };
    // command 中的 {version_dir} 占位符替换为解包后的版本目录绝对路径：
    // 调用方无法预知版本 id，用它引用包内解压出的二进制。
    let mut command: Vec<String> = options
        .command
        .iter()
        .map(|token| token.replace("{version_dir}", &version_dir.to_string_lossy()))
        .collect();
    command.push("--port".to_owned());
    command.push(port.to_string());
    // backend 默认 http（loopback 假 backend）；真实 daemon 仅 TLS，
    // 需 --backend-protocol https --backend-ca <pem> 供 supervisor 做 readyz 校验。
    let mut backend = json!({"host": "127.0.0.1", "port": port, "protocol": "http"});
    if options.backend_protocol == "https" {
        backend["protocol"] = json!("https");
        let ca = options
            .backend_ca
            .as_deref()
            .ok_or("https backend 必须提供 --backend-ca <pem>（supervisor readyz 校验需要）")?;
        let ca_text =
            fs::read_to_string(ca).map_err(|error| format!("读取 CA {} 失败: {error}", ca))?;
        backend["ca"] = json!(ca_text);
    }
    let mut start_request = json!({
        "method": "start",
        "generation": id,
        "backend": backend,
        "command": command,
    });
    if let Some(cwd) = &options.cwd {
        start_request["cwd"] = json!(cwd);
    }
    if !options.env.is_empty() {
        let env: serde_json::Map<String, Value> = options
            .env
            .iter()
            .map(|(key, value)| (key.clone(), json!(value)))
            .collect();
        start_request["env"] = Value::Object(env);
    }

    if let Err(error) = control(socket, &start_request) {
        cleanup_version_dir(&version_dir);
        return Err(format!("启动候选 {id} 失败: {error}"));
    }
    // readiness 由 supervisor promote 内建校验；候选进程启动需要时间，
    // readiness 未就绪时短暂重试，候选进程退出或超时则失败。
    let mut last_error = String::new();
    let mut promoted = false;
    let deadline = Instant::now() + PROMOTE_TIMEOUT;
    while !promoted {
        match control(socket, &json!({"method": "promote", "generation": id})) {
            Ok(_) => promoted = true,
            Err(error) => {
                last_error = error;
                // 状态查询瞬时失败时保持重试，直到候选确认退出或超时。
                let candidate_alive =
                    control(socket, &json!({"method": "status"})).map_or(true, |status| {
                        status["generations"]
                            .as_array()
                            .and_then(|generations| {
                                generations.iter().find(|generation| {
                                    generation["name"].as_str() == Some(id.as_str())
                                })
                            })
                            .is_some_and(|generation| {
                                generation["startError"].is_null()
                                    && generation["process"].is_object()
                            })
                    });
                if !candidate_alive || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(PROMOTE_RETRY_INTERVAL);
            }
        }
    }
    if !promoted {
        let cleanup = retire_candidate(socket, &id);
        cleanup_version_dir(&version_dir);
        let mut message = format!("promote 候选 {id} 失败: {last_error}");
        if let Some(cleanup) = cleanup {
            message.push_str(&format!("（回收候选也失败: {cleanup}）"));
        }
        return Err(message);
    }

    let link_path = options
        .link
        .clone()
        .unwrap_or_else(|| default_current_link(&options.versions_dir));
    if let Err(error) = update_current_link(&link_path, &version_dir) {
        let mut message = format!("更新 current 链接失败: {error}");
        if previous.is_some() {
            // 有上一版本：回滚、回收候选、清理目录，保持 active 不变。
            match control(socket, &json!({"method": "rollback"})) {
                Ok(_) => {
                    if let Some(cleanup) = retire_candidate(socket, &id) {
                        message.push_str(&format!("（回收候选也失败: {cleanup}）"));
                    }
                    cleanup_version_dir(&version_dir);
                    message.push_str("，已回滚到上一版本并清理候选");
                }
                Err(rollback_error) => {
                    message.push_str(&format!(
                        "，且回滚失败（{rollback_error}），新版本继续提供服务，请修复链接后重试"
                    ));
                    return Err(message);
                }
            }
        } else {
            message.push_str("，首次安装无上一版本可回滚，新版本继续提供服务，请修复链接");
            return Err(message);
        }
        return Err(message);
    }

    // 两段式：不在本次调用内 retire 旧版本。
    let mut summary = json!({"generation": id, "previous": previous});
    if let Some(previous) = &previous {
        summary["retireHint"] = json!(format!(
            "remote-execd ctl --control {} retire {}",
            socket.display(),
            previous
        ));
    }
    Ok(summary)
}

pub fn run(args: &[String]) -> Result<(), AnyError> {
    let mut control_path = None;
    let mut index = 0;
    let subcommand = loop {
        match args.get(index) {
            None => return Err(format!("ctl 需要子命令\n{}", usage()).into()),
            Some(arg) if arg == "--control" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("--control 需要值\n{}", usage()))?;
                control_path = Some(PathBuf::from(value));
                index += 2;
            }
            Some(arg) if arg == "--help" || arg == "-h" => {
                println!("{}", usage());
                return Ok(());
            }
            Some(arg) => break arg.clone(),
        }
    };
    let control_path =
        control_path.ok_or_else(|| format!("ctl 必须提供 --control <sock>\n{}", usage()))?;
    let rest = &args[index + 1..];
    let result = match subcommand.as_str() {
        "status" => {
            if !rest.is_empty() {
                return Err(format!("status 不接受额外参数\n{}", usage()).into());
            }
            control(&control_path, &json!({"method": "status"}))
        }
        "rollback" => {
            if !rest.is_empty() {
                return Err(format!("rollback 不接受额外参数\n{}", usage()).into());
            }
            control(&control_path, &json!({"method": "rollback"}))
        }
        "retire" => {
            let [name] = rest else {
                return Err(format!("retire 需要恰好一个 generation 名称\n{}", usage()).into());
            };
            control(
                &control_path,
                &json!({"method": "retire", "generation": name}),
            )
        }
        "upgrade" => upgrade(&control_path, rest),
        other => return Err(format!("未知 ctl 子命令: {other}\n{}", usage()).into()),
    };
    match result {
        Ok(value) => {
            print_result(&value);
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_timestamp_matches_utc_dates() {
        assert_eq!(version_timestamp(0), "19700101000000");
        assert_eq!(version_timestamp(951_782_400), "20000229000000");
        assert_eq!(version_timestamp(1_784_208_000), "20260716132000");
    }

    #[test]
    fn command_must_not_carry_port_flag() {
        let command = vec!["/bin/sh".to_owned(), "-c".to_owned(), "sleep 1".to_owned()];
        assert!(ensure_no_port_flag(&command).is_ok());
        assert!(ensure_no_port_flag(&["/bin/sh".into(), "--port".into(), "1".into()]).is_err());
        assert!(ensure_no_port_flag(&["/bin/sh".into(), "--port=1".into()]).is_err());
    }

    #[test]
    fn version_dir_placeholder_expands_in_every_token() {
        let version_dir = Path::new("/opt/remote-exec/versions/20260101000000-deadbeef");
        let tokens: Vec<String> = [
            "{version_dir}/bin/remote-execd",
            "--config",
            "{version_dir}/daemon.json",
        ]
        .iter()
        .map(|token| token.replace("{version_dir}", &version_dir.to_string_lossy()))
        .collect();
        assert_eq!(
            tokens[0],
            "/opt/remote-exec/versions/20260101000000-deadbeef/bin/remote-execd"
        );
        assert_eq!(
            tokens[2],
            "/opt/remote-exec/versions/20260101000000-deadbeef/daemon.json"
        );
    }

    #[test]
    fn parse_upgrade_args_accepts_full_form() {
        let args: Vec<String> = [
            "--package",
            "p.tar.gz",
            "--sha256",
            "ab",
            "--versions-dir",
            "/v",
            "--link",
            "/c",
            "--cwd",
            "/tmp",
            "--env",
            "A=1",
            "--env",
            "B=2",
            "--",
            "/bin/sh",
            "-c",
            "sleep 1",
        ]
        .iter()
        .map(|value| value.to_string())
        .collect();
        let options = parse_upgrade_args(&args).expect("解析应成功");
        assert_eq!(options.package, "p.tar.gz");
        assert_eq!(options.versions_dir, PathBuf::from("/v"));
        assert_eq!(options.link.as_deref(), Some(Path::new("/c")));
        assert_eq!(options.cwd.as_deref(), Some("/tmp"));
        assert_eq!(
            options.env,
            vec![
                ("A".to_owned(), "1".to_owned()),
                ("B".to_owned(), "2".to_owned())
            ]
        );
        assert_eq!(options.command, vec!["/bin/sh", "-c", "sleep 1"]);
    }

    #[test]
    fn parse_upgrade_args_rejects_bad_input() {
        let args = |values: &[&str]| -> Vec<String> {
            values.iter().map(|value| value.to_string()).collect()
        };
        assert!(parse_upgrade_args(&args(&["--package", "p"])).is_err());
        assert!(
            parse_upgrade_args(&args(&[
                "--package",
                "p",
                "--sha256",
                "a",
                "--versions-dir",
                "v",
                "--"
            ]))
            .is_err()
        );
        assert!(parse_upgrade_args(&args(&["--package"])).is_err());
        assert!(parse_upgrade_args(&args(&["--unknown", "x"])).is_err());
        assert!(parse_upgrade_args(&args(&["--env", "NOEQ"])).is_err());
        assert!(parse_upgrade_args(&args(&["--package", "--sha256"])).is_err());
    }

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ctl-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("创建测试目录");
        dir
    }

    #[test]
    fn update_current_link_points_to_version_dir() {
        let dir = test_dir("link");
        let root = dir.join("root");
        let version = root.join("versions").join("20260101000000-deadbeef");
        fs::create_dir_all(&version).expect("创建版本目录");
        let link = root.join("current");
        update_current_link(&link, &version).expect("更新链接");
        assert_eq!(
            fs::read_link(&link).expect("读取链接"),
            Path::new("versions/20260101000000-deadbeef")
        );
        // 再次更新应原子覆盖。
        let next = root.join("versions").join("20260101000001-feedface");
        fs::create_dir_all(&next).expect("创建版本目录");
        update_current_link(&link, &next).expect("二次更新链接");
        assert_eq!(
            fs::read_link(&link).expect("读取链接"),
            Path::new("versions/20260101000001-feedface")
        );
        fs::remove_dir_all(&dir).ok();
    }

    fn build_package(
        dir: &Path,
        name: &str,
        append: impl FnOnce(&mut tar::Builder<fs::File>),
    ) -> PathBuf {
        let package = dir.join(name);
        let file = fs::File::create(&package).expect("创建包文件");
        let mut builder = tar::Builder::new(file);
        append(&mut builder);
        builder.finish().expect("封存 tar");
        let compressed = dir.join(format!("{name}.gz"));
        let input = fs::File::open(&package).expect("打开 tar");
        let mut encoder = flate2::write::GzEncoder::new(
            fs::File::create(&compressed).expect("创建 gz"),
            flate2::Compression::default(),
        );
        std::io::copy(&mut std::io::BufReader::new(input), &mut encoder).expect("压缩");
        encoder.finish().expect("完成压缩");
        compressed
    }

    #[test]
    fn unpack_package_accepts_regular_entries() {
        let dir = test_dir("unpack-ok");
        let package = build_package(&dir, "ok.tar", |builder| {
            let mut header = tar::Header::new_gnu();
            header.set_size(5);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "bin/remote-execd", b"hello".as_slice())
                .expect("写入条目");
        });
        let dest = dir.join("out");
        fs::create_dir_all(&dest).expect("创建目标目录");
        unpack_package(&package, &dest).expect("解包应成功");
        assert_eq!(
            fs::read(dest.join("bin").join("remote-execd")).expect("读取解包文件"),
            b"hello"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unpack_package_rejects_dangerous_entries() {
        let dir = test_dir("unpack-bad");
        let dest = dir.join("out");
        fs::create_dir_all(&dest).expect("创建目标目录");

        let symlink_package = build_package(&dir, "symlink.tar", |builder| {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_path("escape").expect("设置路径");
            header.set_link_name("/etc/passwd").expect("设置链接目标");
            header.set_cksum();
            builder
                .append(&header, &mut &b""[..])
                .expect("写入符号链接条目");
        });
        let error = unpack_package(&symlink_package, &dest).expect_err("应拒绝符号链接");
        assert!(error.contains("不支持的条目类型"), "错误信息: {error}");

        // 手工构造含 ../evil 条目的恶意包：tar 后直接改写 name 字段并重算校验和，
        // 绕过 Builder set_path 的构造期校验。
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_mode(0o644);
        header.set_path("evil").expect("设置合法占位路径");
        header.set_cksum();
        builder
            .append(&header, &mut &b""[..])
            .expect("写入占位条目");
        let mut raw = builder.into_inner().expect("封存 tar");
        raw[..100].fill(0);
        raw[..7].copy_from_slice(b"../evil");
        raw[148..156].fill(b' ');
        let sum: u32 = raw[..512].iter().map(|byte| u32::from(*byte)).sum();
        raw[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        let escape_package = dir.join("escape.tar.gz");
        let mut encoder = flate2::write::GzEncoder::new(
            fs::File::create(&escape_package).expect("创建 gz"),
            flate2::Compression::default(),
        );
        encoder.write_all(&raw).expect("压缩写入");
        encoder.finish().expect("完成压缩");
        let error = unpack_package(&escape_package, &dest).expect_err("应拒绝 .. 路径");
        assert!(error.contains(".."), "错误信息: {error}");
        assert!(!dir.join("evil").exists());
        fs::remove_dir_all(&dir).ok();
    }
}
