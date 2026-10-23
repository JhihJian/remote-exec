use crate::relay;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::CString,
    io,
    net::IpAddr,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream, UnixListener, UnixStream},
    process::Command,
    sync::{Mutex, watch},
};

#[derive(Clone, Debug)]
struct Backend {
    host: String,
    port: u16,
    protocol: String,
    ca: Option<String>,
}

#[derive(Debug)]
struct Generation {
    name: String,
    state: String,
    backend: Backend,
    pid: Option<u32>,
    managed: bool,
    connections: usize,
    previous: Option<String>,
    start_error: Option<String>,
    launch: Option<Launch>,
}

#[derive(Clone, Debug)]
struct Launch {
    command: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
}

#[derive(Default)]
struct State {
    active: Option<String>,
    generations: HashMap<String, Generation>,
}

type SharedState = Arc<Mutex<State>>;

const STATE_VERSION: u64 = 1;
static NEXT_STATE_TEMP: AtomicU64 = AtomicU64::new(0);

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

/// supervisor 以 root 运行时，daemon generation 应降权到的服务用户身份。
#[derive(Clone, Debug)]
struct RunIdentity {
    uid: u32,
    gid: u32,
    name: CString,
}

fn resolve_user(name: &str) -> io::Result<RunIdentity> {
    let cname = CString::new(name).map_err(|_| invalid("--run-user 含非法字符"))?;
    let mut passwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let mut buffer = vec![0u8; 1024];
    loop {
        let code = unsafe {
            libc::getpwnam_r(
                cname.as_ptr(),
                &mut passwd,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if code == 0 {
            break;
        }
        if code == libc::ERANGE {
            buffer.resize(buffer.len() * 2, 0);
            continue;
        }
        return Err(io::Error::from_raw_os_error(code));
    }
    if result.is_null() {
        return Err(invalid(format!("--run-user 用户不存在: {name}")));
    }
    Ok(RunIdentity {
        uid: passwd.pw_uid,
        gid: passwd.pw_gid,
        name: cname,
    })
}

fn setpgid_self() -> io::Result<()> {
    if unsafe { libc::setpgid(0, 0) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn drop_privileges(identity: &RunIdentity) -> io::Result<()> {
    // 顺序：先建立独立进程组，再以 root 身份初始化补充组并降权。
    setpgid_self()?;
    // 目标就是当前用户时降权为 no-op：非 root 进程的 setgroups 只允许子集，
    // 会因实际补充组与 /etc/group 不一致而 EPERM；无降权就不应改组。
    if unsafe { libc::getuid() } == identity.uid && unsafe { libc::getgid() } == identity.gid {
        return Ok(());
    }
    if unsafe { libc::initgroups(identity.name.as_ptr(), identity.gid) } == -1 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::setgid(identity.gid) } == -1 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::setuid(identity.uid) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn spawn_managed(
    launch: &Launch,
    run_user: Option<&RunIdentity>,
) -> io::Result<tokio::process::Child> {
    let program = launch
        .command
        .first()
        .map(String::as_str)
        .ok_or_else(|| invalid("command 不能为空"))?;
    let mut child = Command::new(program);
    for argument in launch.command.iter().skip(1) {
        child.arg(argument);
    }
    if let Some(cwd) = &launch.cwd {
        child.current_dir(cwd);
    }
    for (key, value) in &launch.env {
        child.env(key, value);
    }
    let identity = run_user.cloned();
    unsafe {
        child.pre_exec(move || {
            if let Some(identity) = identity.as_ref() {
                drop_privileges(identity)?;
            } else {
                setpgid_self()?;
            }
            Ok(())
        });
    }
    child.spawn().map_err(|error| {
        invalid(format!(
            "拉起 {} 失败: {error}",
            launch.command.first().map(String::as_str).unwrap_or("命令")
        ))
    })
}

fn exact_object<'a>(
    value: &'a Value,
    label: &str,
    keys: &[&str],
) -> io::Result<&'a serde_json::Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid(format!("{label} 必须是 JSON 对象")))?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid(format!("{label} 包含未知或缺失字段")));
    }
    Ok(object)
}

fn parse_launch(value: &Value, label: &str, managed: bool) -> io::Result<Option<Launch>> {
    let Some(object) = value.as_object() else {
        if value.is_null() && !managed {
            return Ok(None);
        }
        return Err(invalid(format!("{label} 必须是对象或 null")));
    };
    if !managed {
        return Err(invalid(format!("{label} 非托管 generation 不得设置")));
    }
    if object.len() != 3
        || !object.contains_key("command")
        || !object.contains_key("cwd")
        || !object.contains_key("env")
    {
        return Err(invalid(format!("{label} 包含未知或缺失字段")));
    }
    let command = object
        .get("command")
        .and_then(Value::as_array)
        .filter(|command| !command.is_empty())
        .ok_or_else(|| invalid(format!("{label}.command 必须是非空数组")))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| invalid(format!("{label}.command 参数必须是字符串")))
        })
        .collect::<io::Result<Vec<_>>>()?;
    let cwd = match object.get("cwd") {
        Some(value) if value.is_null() => None,
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| invalid(format!("{label}.cwd 必须是字符串或 null")))?
                .to_owned(),
        ),
        None => unreachable!(),
    };
    let env = object
        .get("env")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(format!("{label}.env 必须是对象")))?
        .iter()
        .map(|(key, value)| {
            Ok((
                key.clone(),
                value
                    .as_str()
                    .ok_or_else(|| invalid(format!("{label}.env 值必须是字符串")))?
                    .to_owned(),
            ))
        })
        .collect::<io::Result<HashMap<_, _>>>()?;
    Ok(Some(Launch { command, cwd, env }))
}

fn persistent_state(state: &State) -> Value {
    let mut generations: Vec<_> = state
        .generations
        .values()
        .map(|generation| {
            let (command, cwd, env) = generation
                .launch
                .as_ref()
                .map_or((Value::Null, Value::Null, Value::Null), |launch| {
                    (json!(launch.command), json!(launch.cwd), json!(launch.env))
                });
            json!({
                "name": generation.name,
                "state": generation.state,
                "backend": {
                    "host": generation.backend.host,
                    "port": generation.backend.port,
                    "protocol": generation.backend.protocol,
                    "ca": generation.backend.ca,
                },
                "managed": generation.managed,
                "command": command,
                "cwd": cwd,
                "env": env,
                "previous": generation.previous,
            })
        })
        .collect();
    generations.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    json!({
        "version": STATE_VERSION,
        "active": state.active,
        "generations": generations,
    })
}

fn parse_persistent_state(value: Value) -> io::Result<State> {
    let object = exact_object(&value, "state", &["version", "active", "generations"])?;
    if object.get("version").and_then(Value::as_u64) != Some(STATE_VERSION) {
        return Err(invalid("state version 不受支持"));
    }
    let active = match object.get("active") {
        Some(value) if value.is_null() => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| invalid("state.active 必须是非空字符串或 null"))?
                .to_owned(),
        ),
        None => unreachable!(),
    };
    let values = object
        .get("generations")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("state.generations 必须是数组"))?;
    let mut generations = HashMap::new();
    for (index, value) in values.iter().enumerate() {
        let label = format!("state.generations[{index}]");
        let generation = exact_object(
            value,
            &label,
            &[
                "name", "state", "backend", "managed", "command", "cwd", "env", "previous",
            ],
        )?;
        let name = generation
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| invalid(format!("{label}.name 必须是非空字符串")))?
            .to_owned();
        if generations.contains_key(&name) {
            return Err(invalid(format!("state 中 generation 重复: {name}")));
        }
        let state_name = generation
            .get("state")
            .and_then(Value::as_str)
            .filter(|state| matches!(*state, "candidate" | "active" | "draining"))
            .ok_or_else(|| invalid(format!("{label}.state 无效")))?
            .to_owned();
        let backend_value = generation
            .get("backend")
            .ok_or_else(|| invalid(format!("{label}.backend 缺失")))?;
        let backend_object = exact_object(
            backend_value,
            &format!("{label}.backend"),
            &["host", "port", "protocol", "ca"],
        )?;
        if !backend_object
            .get("ca")
            .is_some_and(|value| value.is_null() || value.is_string())
        {
            return Err(invalid(format!("{label}.backend.ca 必须是字符串或 null")));
        }
        let backend = validate_backend(backend_value, &format!("{label}.backend"))?;
        let managed = generation
            .get("managed")
            .and_then(Value::as_bool)
            .ok_or_else(|| invalid(format!("{label}.managed 必须是布尔值")))?;
        let launch = parse_launch(
            &json!({
                "command": generation
                    .get("command")
                    .ok_or_else(|| invalid(format!("{label}.command 缺失")))?,
                "cwd": generation
                    .get("cwd")
                    .ok_or_else(|| invalid(format!("{label}.cwd 缺失")))?,
                "env": generation
                    .get("env")
                    .ok_or_else(|| invalid(format!("{label}.env 缺失")))?,
            }),
            &format!("{label}.launch"),
            managed,
        )?;
        let previous = match generation.get("previous") {
            Some(value) if value.is_null() => None,
            Some(value) => Some(
                value
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| invalid(format!("{label}.previous 必须是非空字符串或 null")))?
                    .to_owned(),
            ),
            None => unreachable!(),
        };
        generations.insert(
            name.clone(),
            Generation {
                name,
                state: state_name,
                backend,
                pid: None,
                managed,
                connections: 0,
                previous,
                start_error: None,
                launch,
            },
        );
    }
    if let Some(active) = &active {
        let generation = generations
            .get(active)
            .ok_or_else(|| invalid("state.active 引用了不存在的 generation"))?;
        if generation.state != "active" {
            return Err(invalid("state.active 必须引用 active generation"));
        }
    }
    if generations
        .values()
        .filter(|generation| generation.state == "active")
        .count()
        != usize::from(active.is_some())
    {
        return Err(invalid("state 中 active generation 与 active 字段不一致"));
    }
    for generation in generations.values() {
        if let Some(previous) = &generation.previous
            && !generations.contains_key(previous)
        {
            return Err(invalid(format!(
                "generation {} 的 previous 引用了不存在的 generation",
                generation.name
            )));
        }
    }
    Ok(State {
        active,
        generations,
    })
}

async fn load_state(path: Option<&Path>) -> io::Result<State> {
    let Some(path) = path else {
        return Ok(State::default());
    };
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(State::default()),
        Err(error) => return Err(error),
    };
    let value = serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("state JSON 无效: {error}")))?;
    parse_persistent_state(value)
}

async fn persist_state(state: &State, path: Option<&Path>) -> io::Result<()> {
    let Some(path) = path else {
        return Ok(());
    };
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let data = serde_json::to_vec_pretty(&persistent_state(state))
        .map_err(|error| invalid(format!("state JSON 编码失败: {error}")))?;
    let temp_path = parent.join(format!(
        ".supervisor-state-{}-{}",
        std::process::id(),
        NEXT_STATE_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp_path)
    {
        Ok(file) => tokio::fs::File::from_std(file),
        Err(error) => return Err(error),
    };
    let result = async {
        file.write_all(&data).await?;
        file.sync_all().await
    }
    .await;
    drop(file);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error);
    }
    if let Err(error) = tokio::fs::rename(&temp_path, path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error);
    }
    Ok(())
}

fn validate_backend(value: &Value, label: &str) -> io::Result<Backend> {
    let host = value
        .get("host")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{label}.host 必须是回环 IP")))?;
    let ip: IpAddr = host
        .parse()
        .map_err(|_| invalid(format!("{label}.host 必须是回环 IP")))?;
    if !ip.is_loopback() {
        return Err(invalid(format!("{label}.host 必须是回环 IP")));
    }
    let port = value
        .get("port")
        .and_then(Value::as_u64)
        .filter(|value| (1..=65535).contains(value))
        .ok_or_else(|| invalid(format!("{label}.port 必须是 1-65535 的整数")))?
        as u16;
    let protocol = value
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or("http");
    if !matches!(protocol, "http" | "https") {
        return Err(invalid(format!("{label}.protocol 必须是 http 或 https")));
    }
    let ca = value.get("ca").and_then(Value::as_str).map(str::to_owned);
    if protocol == "https" && ca.is_none() {
        return Err(invalid(format!("{label}.ca 必须是 PEM 字符串")));
    }
    Ok(Backend {
        host: host.to_owned(),
        port,
        protocol: protocol.to_owned(),
        ca,
    })
}

fn snapshot(generation: &Generation) -> Value {
    json!({
        "name": generation.name,
        "state": generation.state,
        "backend": {
            "host": generation.backend.host,
            "port": generation.backend.port,
            "protocol": generation.backend.protocol,
            "ca": generation.backend.ca,
        },
        "connections": generation.connections,
        "process": generation.pid.map(|pid| json!({"pid": pid, "exited": false})),
        "startError": generation.start_error,
    })
}

fn status(state: &State) -> Value {
    let mut generations: Vec<_> = state.generations.values().map(snapshot).collect();
    generations.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    json!({"active": state.active, "generations": generations})
}

trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}

async fn check_response<S: AsyncStream>(mut stream: S, host: &str) -> io::Result<()> {
    stream
        .write_all(
            format!("GET /readyz HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await?;
    let mut response = Vec::new();
    let mut buffer = [0u8; 1024];
    while response.len() < 8192 {
        let size = stream.read(&mut buffer).await?;
        if size == 0 {
            break;
        }
        response.extend_from_slice(&buffer[..size]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let line = response
        .split(|byte| *byte == b'\n')
        .next()
        .ok_or_else(|| invalid("backend readiness 响应为空"))?;
    let code = String::from_utf8_lossy(line)
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| invalid("backend readiness 响应无 HTTP 状态码"))?;
    if (200..300).contains(&code) {
        Ok(())
    } else {
        Err(invalid(format!("backend /readyz 返回 {code}")))
    }
}

async fn readiness(backend: &Backend) -> io::Result<()> {
    let socket = TcpStream::connect((&*backend.host, backend.port)).await?;
    if backend.protocol == "https" {
        let ca = backend
            .ca
            .as_deref()
            .ok_or_else(|| invalid("HTTPS backend 缺少 CA"))?;
        let config = relay::build_tls(ca).map_err(|error| invalid(error.message))?;
        let connector = tokio_rustls::TlsConnector::from(config);
        let name = tokio_rustls::rustls::pki_types::ServerName::try_from(backend.host.clone())
            .map_err(|_| invalid("backend host 不是有效 TLS 名称"))?;
        let stream = connector
            .connect(name, socket)
            .await
            .map_err(|error| invalid(error.to_string()))?;
        check_response(stream, &backend.host).await
    } else {
        check_response(socket, &backend.host).await
    }
}

async fn proxy(mut client: TcpStream, state: SharedState) {
    let (name, backend) = {
        let mut state = state.lock().await;
        let Some(name) = state.active.clone() else {
            return;
        };
        let Some(generation) = state.generations.get_mut(&name) else {
            return;
        };
        if generation.state != "active" {
            return;
        }
        generation.connections += 1;
        (name, generation.backend.clone())
    };
    if let Ok(mut upstream) = TcpStream::connect((&*backend.host, backend.port)).await {
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    }
    let mut state = state.lock().await;
    if let Some(generation) = state.generations.get_mut(&name) {
        generation.connections = generation.connections.saturating_sub(1);
    }
}

async fn respond<W: AsyncWrite + Unpin>(
    mut writer: W,
    result: Result<Value, String>,
) -> io::Result<()> {
    let response = match result {
        Ok(result) => json!({"ok": true, "result": result}),
        Err(error) => json!({"ok": false, "error": error}),
    };
    writer.write_all(format!("{}\n", response).as_bytes()).await
}

async fn register(
    state: &SharedState,
    request: &Value,
    state_path: Option<&Path>,
) -> Result<Value, String> {
    let name = request
        .get("generation")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("generation 无效")?
        .to_owned();
    let backend = validate_backend(
        request.get("backend").ok_or("缺少 backend")?,
        &format!("{name} backend"),
    )
    .map_err(|error| error.to_string())?;
    let mut state = state.lock().await;
    if state.generations.contains_key(&name) {
        return Err(format!("generation 已存在: {name}"));
    }
    state.generations.insert(
        name.clone(),
        Generation {
            name: name.clone(),
            state: "candidate".into(),
            backend,
            pid: None,
            managed: false,
            connections: 0,
            previous: None,
            start_error: None,
            launch: None,
        },
    );
    if let Err(error) = persist_state(&state, state_path).await {
        state.generations.remove(&name);
        return Err(format!("持久化 state 失败: {error}"));
    }
    Ok(status(&state))
}

async fn watch_child(
    state: SharedState,
    state_path: Option<PathBuf>,
    name: String,
    mut process: tokio::process::Child,
    shutting_down: Arc<std::sync::atomic::AtomicBool>,
) {
    let _ = process.wait().await;
    let mut state = state.lock().await;
    // supervisor 主动退出时终止子进程属于预期行为，不得据此清空 active。
    if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
        if let Some(generation) = state.generations.get_mut(&name) {
            generation.pid = None;
        }
        return;
    }
    let was_active = state.active.as_deref() == Some(&name);
    if let Some(generation) = state.generations.get_mut(&name) {
        generation.pid = None;
        if generation.state == "candidate" {
            generation.start_error = Some("候选进程已退出".into());
        }
        if was_active {
            generation.state = "draining".into();
        }
    }
    if was_active {
        state.active = None;
    }
    if was_active && let Err(error) = persist_state(&state, state_path.as_deref()).await {
        eprintln!("持久化 supervisor state 失败: {error}");
    }
}

async fn start(
    state: &SharedState,
    request: &Value,
    state_path: Option<&Path>,
    run_user: Option<&RunIdentity>,
    shutting_down: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<Value, String> {
    let name = request
        .get("generation")
        .and_then(Value::as_str)
        .unwrap_or("new")
        .to_owned();
    if state.lock().await.generations.contains_key(&name) {
        return Err(format!("generation 已存在: {name}"));
    }
    let backend = validate_backend(
        request.get("backend").ok_or("缺少 backend")?,
        &format!("{name} backend"),
    )
    .map_err(|error| error.to_string())?;
    let command = request
        .get("command")
        .and_then(Value::as_array)
        .ok_or("start 需要 command 数组")?
        .iter()
        .map(|argument| {
            argument
                .as_str()
                .map(str::to_owned)
                .ok_or("command 参数必须是字符串")
        })
        .collect::<Result<Vec<_>, _>>()?;
    if command.is_empty() {
        return Err("command 不能为空".into());
    }
    let cwd = request
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let env: HashMap<String, String> = request
        .get("env")
        .and_then(Value::as_object)
        .map(|env| {
            env.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    let launch = Launch { command, cwd, env };
    let mut process = spawn_managed(&launch, run_user).map_err(|error| error.to_string())?;
    let pid = process.id().ok_or("无法取得候选进程 PID")?;
    let persist_error = {
        let mut state = state.lock().await;
        state.generations.insert(
            name.clone(),
            Generation {
                name: name.clone(),
                state: "candidate".into(),
                backend,
                pid: Some(pid),
                managed: true,
                connections: 0,
                previous: None,
                start_error: None,
                launch: Some(launch),
            },
        );
        persist_state(&state, state_path).await.err()
    };
    if let Some(error) = persist_error {
        let _ = signal_process_group(pid, libc::SIGKILL);
        let _ = process.kill().await;
        let _ = process.wait().await;
        let message = error.to_string();
        let mut state = state.lock().await;
        state.generations.remove(&name);
        return Err(format!("持久化 state 失败: {message}"));
    }
    tokio::spawn(watch_child(
        state.clone(),
        state_path.map(Path::to_path_buf),
        name.clone(),
        process,
        shutting_down.clone(),
    ));
    let state = state.lock().await;
    Ok(status(&state))
}

async fn promote(
    state: &SharedState,
    request: &Value,
    state_path: Option<&Path>,
) -> Result<Value, String> {
    let name = request
        .get("generation")
        .and_then(Value::as_str)
        .ok_or("generation 无效")?
        .to_owned();
    let candidate = {
        let state = state.lock().await;
        state.generations.get(&name).map(|generation| {
            (
                generation.backend.clone(),
                generation.state.clone(),
                generation.pid,
                generation.managed,
                generation.start_error.clone(),
            )
        })
    };
    let Some((backend, state_name, pid, managed, start_error)) = candidate else {
        return Err(format!("generation 不存在: {name}"));
    };
    if !matches!(state_name.as_str(), "candidate" | "draining") {
        return Err(format!("{name} 不是可 promote 的候选版本"));
    }
    if start_error.is_some() || (managed && pid.is_none()) {
        return Err(format!("{name} 启动失败，不能 promote"));
    }
    readiness(&backend)
        .await
        .map_err(|error| error.to_string())?;
    let mut state = state.lock().await;
    let generation = state
        .generations
        .get(&name)
        .ok_or_else(|| format!("generation 不存在: {name}"))?;
    if !matches!(generation.state.as_str(), "candidate" | "draining")
        || generation.start_error.is_some()
        || (generation.managed && generation.pid.is_none())
    {
        return Err(format!("{name} 候选进程已退出，不能 promote"));
    }
    let previous = state.active.clone();
    let previous_state = previous
        .as_ref()
        .and_then(|previous| state.generations.get(previous))
        .map(|generation| generation.state.clone());
    let previous_target = state
        .generations
        .get(&name)
        .and_then(|generation| generation.previous.clone());
    if let Some(previous_name) = previous.clone()
        && let Some(previous) = state.generations.get_mut(&previous_name)
    {
        previous.state = "draining".into();
    }
    let generation = state
        .generations
        .get_mut(&name)
        .ok_or_else(|| format!("generation 不存在: {name}"))?;
    generation.previous = previous.clone();
    generation.state = "active".into();
    state.active = Some(name.clone());
    if let Err(error) = persist_state(&state, state_path).await {
        state.active = previous;
        if let Some(previous_name) = state.active.clone()
            && let Some(previous) = state.generations.get_mut(&previous_name)
            && let Some(previous_state) = previous_state
        {
            previous.state = previous_state;
        }
        if let Some(generation) = state.generations.get_mut(&name) {
            generation.state = "candidate".into();
            generation.previous = previous_target;
        }
        return Err(format!("持久化 state 失败: {error}"));
    }
    Ok(status(&state))
}

async fn drain(
    state: &SharedState,
    request: &Value,
    state_path: Option<&Path>,
) -> Result<Value, String> {
    let name = request
        .get("generation")
        .and_then(Value::as_str)
        .ok_or("generation 无效")?;
    let mut state = state.lock().await;
    if state.active.as_deref() == Some(name) {
        return Err("不能 drain 当前 active generation，请先 promote 另一个 generation".into());
    }
    let old_state = {
        let generation = state
            .generations
            .get_mut(name)
            .ok_or_else(|| format!("generation 不存在: {name}"))?;
        let old_state = generation.state.clone();
        generation.state = "draining".into();
        old_state
    };
    if let Err(error) = persist_state(&state, state_path).await {
        if let Some(generation) = state.generations.get_mut(name) {
            generation.state = old_state;
        }
        return Err(format!("持久化 state 失败: {error}"));
    }
    Ok(status(&state))
}

fn process_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn process_group_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(-(pid as i32), 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn signal_process_group(pid: u32, signal: libc::c_int) -> io::Result<()> {
    if unsafe { libc::kill(-(pid as i32), signal) } == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}

async fn wait_process_group_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if !process_alive(pid) && !process_group_alive(pid) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn terminate_managed(pid: u32) -> io::Result<()> {
    signal_process_group(pid, libc::SIGTERM)?;
    if wait_process_group_exit(pid, Duration::from_secs(2)).await {
        return Ok(());
    }
    signal_process_group(pid, libc::SIGKILL)?;
    if wait_process_group_exit(pid, Duration::from_secs(2)).await {
        Ok(())
    } else {
        Err(invalid(format!("托管进程组 {pid} 未退出")))
    }
}

async fn rollback(state: &SharedState, state_path: Option<&Path>) -> Result<Value, String> {
    let name = {
        let state = state.lock().await;
        let active = state
            .active
            .as_ref()
            .ok_or("没有 active generation 可回滚")?;
        state
            .generations
            .get(active)
            .and_then(|generation| generation.previous.clone())
            .ok_or("没有上一版本可回滚")?
    };
    promote(state, &json!({"generation": name}), state_path).await
}

async fn retire(
    state: &SharedState,
    request: &Value,
    state_path: Option<&Path>,
) -> Result<Value, String> {
    let name = request
        .get("generation")
        .and_then(Value::as_str)
        .ok_or("generation 无效")?
        .to_owned();
    let state_guard = state.lock().await;
    if state_guard.active.as_deref() == Some(&name) {
        return Err("不能 retire active generation".into());
    }
    let (pid, managed) = {
        let generation = state_guard
            .generations
            .get(&name)
            .ok_or_else(|| format!("generation 不存在: {name}"))?;
        if generation.connections != 0 {
            return Err("不能 retire 有活动连接的 generation".into());
        }
        (generation.pid, generation.managed)
    };
    drop(state_guard);
    if managed && let Some(pid) = pid {
        terminate_managed(pid)
            .await
            .map_err(|error| error.to_string())?;
    }
    let mut state = state.lock().await;
    let generation = state
        .generations
        .remove(&name)
        .ok_or_else(|| format!("generation 不存在: {name}"))?;
    let previous_links: Vec<_> = state
        .generations
        .iter()
        .filter(|(_, generation)| generation.previous.as_deref() == Some(name.as_str()))
        .map(|(generation_name, generation)| (generation_name.clone(), generation.previous.clone()))
        .collect();
    for (generation_name, _) in &previous_links {
        if let Some(generation) = state.generations.get_mut(generation_name) {
            generation.previous = None;
        }
    }
    if let Err(error) = persist_state(&state, state_path).await {
        state.generations.insert(name, generation);
        for (generation_name, previous) in previous_links {
            if let Some(generation) = state.generations.get_mut(&generation_name) {
                generation.previous = previous;
            }
        }
        return Err(format!("持久化 state 失败: {error}"));
    }
    Ok(status(&state))
}

async fn handle_control(
    socket: UnixStream,
    state: SharedState,
    queue: Arc<Mutex<()>>,
    state_path: Option<PathBuf>,
    expected_uid: u32,
    run_user: Option<Arc<RunIdentity>>,
    shutting_down: Arc<std::sync::atomic::AtomicBool>,
) -> io::Result<()> {
    // 控制面仅限与 supervisor 同 uid 的调用方（生产中即 root）。
    let cred = socket.peer_cred()?;
    if cred.uid() != expected_uid {
        return Err(invalid(format!("控制面拒绝 uid {} 的调用方", cred.uid())));
    }
    let (reader, writer) = socket.into_split();
    let mut lines = tokio::io::BufReader::new(reader).lines();
    let Some(line) = lines.next_line().await? else {
        return Ok(());
    };
    let request: Value = match serde_json::from_str(&line) {
        Ok(request) => request,
        Err(error) => return respond(writer, Err(error.to_string())).await,
    };
    let _queue = queue.lock().await;
    let result = match request.get("method").and_then(Value::as_str).unwrap_or("") {
        "status" => {
            let state = state.lock().await;
            Ok(status(&state))
        }
        "register" => register(&state, &request, state_path.as_deref()).await,
        "start" => {
            start(
                &state,
                &request,
                state_path.as_deref(),
                run_user.as_deref(),
                &shutting_down,
            )
            .await
        }
        "promote" => promote(&state, &request, state_path.as_deref()).await,
        "drain" => drain(&state, &request, state_path.as_deref()).await,
        "rollback" => rollback(&state, state_path.as_deref()).await,
        "retire" => retire(&state, &request, state_path.as_deref()).await,
        method => Err(format!("未知控制方法: {method}")),
    };
    respond(writer, result).await
}

/// supervisor 重启后恢复：托管 candidate/draining 已随上次退出终止，直接清理；
/// active managed 重新拉起；external 只恢复路由记录，不接管进程。
async fn recover_generations(
    state: &SharedState,
    state_path: Option<&Path>,
    run_user: Option<&RunIdentity>,
    shutting_down: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), crate::AnyError> {
    let mut respawn: Vec<(String, Launch)> = Vec::new();
    {
        let mut state = state.lock().await;
        let doomed: Vec<String> = state
            .generations
            .iter()
            .filter(|(_, generation)| generation.managed && generation.state != "active")
            .map(|(name, _)| name.clone())
            .collect();
        for name in &doomed {
            state.generations.remove(name);
            for generation in state.generations.values_mut() {
                if generation.previous.as_deref() == Some(name.as_str()) {
                    generation.previous = None;
                }
            }
        }
        for (name, generation) in state.generations.iter() {
            if generation.managed
                && generation.state == "active"
                && let Some(launch) = generation.launch.clone()
            {
                respawn.push((name.clone(), launch));
            }
        }
        if !doomed.is_empty()
            && let Err(error) = persist_state(&state, state_path).await
        {
            return Err(format!("恢复时持久化 state 失败: {error}").into());
        }
    }
    for (name, launch) in respawn {
        let mut guard = state.lock().await;
        let Some(generation) = guard.generations.get_mut(&name) else {
            continue;
        };
        match spawn_managed(&launch, run_user) {
            Ok(process) => {
                let pid = process.id();
                generation.pid = pid;
                generation.start_error = None;
                eprintln!("supervisor 恢复拉起 {name} (pid {:?})", pid);
                tokio::spawn(watch_child(
                    state.clone(),
                    state_path.map(Path::to_path_buf),
                    name.clone(),
                    process,
                    shutting_down.clone(),
                ));
            }
            Err(error) => {
                generation.pid = None;
                generation.start_error = Some(format!("重启恢复拉起失败: {error}"));
                eprintln!("supervisor 恢复拉起 {name} 失败: {error}");
            }
        }
        if let Err(error) = persist_state(&guard, state_path).await {
            return Err(format!("恢复时持久化 state 失败: {error}").into());
        }
    }
    Ok(())
}

pub async fn run(args: &[String]) -> Result<(), crate::AnyError> {
    let mut host = "127.0.0.1".to_owned();
    let mut port = None;
    let mut control_path = None;
    let mut state_path = None;
    let mut old_host = None;
    let mut old_port = None;
    let mut run_user = None;
    let mut index = 0;
    while index < args.len() {
        let value = args.get(index + 1).ok_or("supervisor 参数缺少值")?;
        match args[index].as_str() {
            "--host" => host = value.clone(),
            "--port" => port = Some(value.parse::<u16>()?),
            "--control" => control_path = Some(PathBuf::from(value)),
            "--state" => state_path = Some(PathBuf::from(value)),
            "--old-host" => old_host = Some(value.clone()),
            "--old-port" => old_port = Some(value.parse::<u16>()?),
            "--run-user" => run_user = Some(value.clone()),
            _ => return Err(format!("未知 supervisor 参数: {}", args[index]).into()),
        }
        index += 2;
    }
    let port = port
        .filter(|port| *port > 0)
        .ok_or("supervisor 必须提供 1-65535 的 --port")?;
    let control_path = control_path.ok_or("supervisor 必须提供 --control")?;
    let state_path = state_path;
    let run_user = match run_user.as_deref() {
        Some(name) => Some(Arc::new(resolve_user(name)?)),
        None => None,
    };
    let loaded_state = load_state(state_path.as_deref()).await?;
    let state = Arc::new(Mutex::new(loaded_state));
    let shutting_down = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut state_changed = false;
    match (old_host, old_port) {
        (Some(host), Some(port)) => {
            let backend = validate_backend(
                &json!({"host": host, "port": port, "protocol": "http"}),
                "oldBackend",
            )?;
            let mut state = state.lock().await;
            if state.generations.is_empty() && state.active.is_none() {
                state.active = Some("old".into());
                state.generations.insert(
                    "old".into(),
                    Generation {
                        name: "old".into(),
                        state: "active".into(),
                        backend,
                        pid: None,
                        managed: false,
                        connections: 0,
                        previous: None,
                        start_error: None,
                        launch: None,
                    },
                );
                state_changed = true;
            }
        }
        (None, None) => {}
        _ => return Err("--old-host 和 --old-port 必须同时提供".into()),
    }
    if state_changed {
        let state = state.lock().await;
        persist_state(&state, state_path.as_deref()).await?;
    }
    recover_generations(
        &state,
        state_path.as_deref(),
        run_user.as_deref(),
        &shutting_down,
    )
    .await?;
    if control_path.exists() {
        tokio::fs::remove_file(&control_path).await?;
    }
    let external = TcpListener::bind((host.as_str(), port)).await?;
    let control_listener = UnixListener::bind(&control_path)?;
    tokio::fs::set_permissions(&control_path, std::fs::Permissions::from_mode(0o600)).await?;
    eprintln!("Rust supervisor listening {}", external.local_addr()?);
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let control_state = state.clone();
    let control_queue = Arc::new(Mutex::new(()));
    let control_state_path = state_path.clone();
    let control_run_user = run_user.clone();
    let control_shutting_down = shutting_down.clone();
    let expected_uid = unsafe { libc::getuid() };
    let control_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                accepted = control_listener.accept() => {
                    let Ok((socket, _)) = accepted else { break; };
                    tokio::spawn(handle_control(
                        socket,
                        control_state.clone(),
                        control_queue.clone(),
                        control_state_path.clone(),
                        expected_uid,
                        control_run_user.clone(),
                        control_shutting_down.clone(),
                    ));
                }
            }
        }
    });
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = term.recv() => break,
            _ = tokio::signal::ctrl_c() => break,
            accepted = external.accept() => {
                let (socket, _) = accepted?;
                tasks.spawn(proxy(socket, state.clone()));
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    }
    let _ = shutdown_tx.send(true);
    shutting_down.store(true, std::sync::atomic::Ordering::Release);
    control_task.abort();
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let doomed: Vec<u32> = {
        let state = state.lock().await;
        state
            .generations
            .values()
            .filter(|generation| generation.managed)
            .filter_map(|generation| generation.pid)
            .collect()
    };
    let mut terminations = tokio::task::JoinSet::new();
    for pid in doomed {
        terminations.spawn(async move { terminate_managed(pid).await });
    }
    while let Some(result) = terminations.join_next().await {
        if let Err(error) = result.unwrap_or_else(|error| Err(invalid(error.to_string()))) {
            eprintln!("supervisor 退出时托管进程回收失败: {error}");
        }
    }
    let _ = tokio::fs::remove_file(control_path).await;
    Ok(())
}
