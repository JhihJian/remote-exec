use crate::relay;
use serde_json::{Value, json};
use std::{
    collections::HashMap, io, net::IpAddr, os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc,
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
}

#[derive(Default)]
struct State {
    active: Option<String>,
    generations: HashMap<String, Generation>,
}

type SharedState = Arc<Mutex<State>>;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
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

async fn register(state: &SharedState, request: &Value) -> Result<Value, String> {
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
            name,
            state: "candidate".into(),
            backend,
            pid: None,
            managed: false,
            connections: 0,
            previous: None,
            start_error: None,
        },
    );
    Ok(status(&state))
}

async fn start(state: &SharedState, request: &Value) -> Result<Value, String> {
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
        .ok_or("start 需要 command 数组")?;
    let program = command
        .first()
        .and_then(Value::as_str)
        .ok_or("command 不能为空")?;
    let mut child = Command::new(program);
    for argument in command.iter().skip(1) {
        child.arg(argument.as_str().ok_or("command 参数必须是字符串")?);
    }
    if let Some(cwd) = request.get("cwd").and_then(Value::as_str) {
        child.current_dir(cwd);
    }
    if let Some(env) = request.get("env").and_then(Value::as_object) {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                child.env(key, value);
            }
        }
    }
    let mut process = child.spawn().map_err(|error| error.to_string())?;
    let pid = process.id().ok_or("无法取得候选进程 PID")?;
    {
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
            },
        );
    }
    let monitor_state = state.clone();
    tokio::spawn(async move {
        let _ = process.wait().await;
        let mut state = monitor_state.lock().await;
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
    });
    let state = state.lock().await;
    Ok(status(&state))
}

async fn promote(state: &SharedState, request: &Value) -> Result<Value, String> {
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
    if let Some(previous_name) = state.active.clone()
        && let Some(previous) = state.generations.get_mut(&previous_name)
    {
        previous.state = "draining".into();
    }
    let previous = state.active.clone();
    let generation = state
        .generations
        .get_mut(&name)
        .ok_or_else(|| format!("generation 不存在: {name}"))?;
    generation.previous = previous;
    generation.state = "active".into();
    state.active = Some(name);
    Ok(status(&state))
}

async fn drain(state: &SharedState, request: &Value) -> Result<Value, String> {
    let name = request
        .get("generation")
        .and_then(Value::as_str)
        .ok_or("generation 无效")?;
    let mut state = state.lock().await;
    if state.active.as_deref() == Some(name) {
        return Err("不能 drain 当前 active generation，请先 promote 另一个 generation".into());
    }
    let generation = state
        .generations
        .get_mut(name)
        .ok_or_else(|| format!("generation 不存在: {name}"))?;
    generation.state = "draining".into();
    Ok(status(&state))
}

async fn rollback(state: &SharedState) -> Result<Value, String> {
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
    promote(state, &json!({"generation": name})).await
}

async fn retire(state: &SharedState, request: &Value) -> Result<Value, String> {
    let name = request
        .get("generation")
        .and_then(Value::as_str)
        .ok_or("generation 无效")?
        .to_owned();
    let mut state = state.lock().await;
    if state.active.as_deref() == Some(&name) {
        return Err("不能 retire active generation".into());
    }
    let generation = state
        .generations
        .get(&name)
        .ok_or_else(|| format!("generation 不存在: {name}"))?;
    if generation.connections != 0 {
        return Err("不能 retire 有活动连接的 generation".into());
    }
    let pid = generation.pid;
    state.generations.remove(&name);
    let result = status(&state);
    drop(state);
    if let Some(pid) = pid {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    Ok(result)
}

async fn handle_control(
    socket: UnixStream,
    state: SharedState,
    queue: Arc<Mutex<()>>,
) -> io::Result<()> {
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
        "register" => register(&state, &request).await,
        "start" => start(&state, &request).await,
        "promote" => promote(&state, &request).await,
        "drain" => drain(&state, &request).await,
        "rollback" => rollback(&state).await,
        "retire" => retire(&state, &request).await,
        method => Err(format!("未知控制方法: {method}")),
    };
    respond(writer, result).await
}

pub async fn run(args: &[String]) -> Result<(), crate::AnyError> {
    let mut host = "127.0.0.1".to_owned();
    let mut port = None;
    let mut control_path = None;
    let mut old_host = None;
    let mut old_port = None;
    let mut index = 0;
    while index < args.len() {
        let value = args.get(index + 1).ok_or("supervisor 参数缺少值")?;
        match args[index].as_str() {
            "--host" => host = value.clone(),
            "--port" => port = Some(value.parse::<u16>()?),
            "--control" => control_path = Some(PathBuf::from(value)),
            "--old-host" => old_host = Some(value.clone()),
            "--old-port" => old_port = Some(value.parse::<u16>()?),
            _ => return Err(format!("未知 supervisor 参数: {}", args[index]).into()),
        }
        index += 2;
    }
    let port = port
        .filter(|port| *port > 0)
        .ok_or("supervisor 必须提供 1-65535 的 --port")?;
    let control_path = control_path.ok_or("supervisor 必须提供 --control")?;
    let state = Arc::new(Mutex::new(State::default()));
    match (old_host, old_port) {
        (Some(host), Some(port)) => {
            let backend = validate_backend(
                &json!({"host": host, "port": port, "protocol": "http"}),
                "oldBackend",
            )?;
            let mut state = state.lock().await;
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
                },
            );
        }
        (None, None) => {}
        _ => return Err("--old-host 和 --old-port 必须同时提供".into()),
    }
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
    let control_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                accepted = control_listener.accept() => {
                    let Ok((socket, _)) = accepted else { break; };
                    tokio::spawn(handle_control(socket, control_state.clone(), control_queue.clone()));
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
    control_task.abort();
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let state = state.lock().await;
    for generation in state.generations.values() {
        if let Some(pid) = generation.pid {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
    }
    drop(state);
    let _ = tokio::fs::remove_file(control_path).await;
    Ok(())
}
