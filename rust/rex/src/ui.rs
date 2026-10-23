//! readline 交互模式：与 Node tui-client.js 同构的会话命令与输出习惯。
use crate::client::{self, Call, Interrupt, StreamEvent};
use crate::config::{self, Store};
use base64::Engine;
use serde_json::{Value, json};
use std::io::Write;
use std::time::Instant;

const PWD_MARK: &str = "\x01PWD\x02";

fn cyan(s: &str) -> String {
    format!("\x1b[36m{s}\x1b[0m")
}
fn dim(s: &str) -> String {
    format!("\x1b[2m{s}\x1b[0m")
}
fn red(s: &str) -> String {
    format!("\x1b[31m{s}\x1b[0m")
}

struct State {
    host: String,
    cwd: String,
    timeout_ms: u64,
    commands: u64,
    started: Instant,
}

fn decode_b64(value: &Value, field: &str) -> Vec<u8> {
    value
        .get(field)
        .and_then(Value::as_str)
        .and_then(|s| {
            base64::engine::general_purpose::STANDARD
                .decode(s)
                .ok()
        })
        .unwrap_or_default()
}

/// 以 Ctrl+C 为中断源执行一次调用。
async fn interrupted_call(
    store: &Store,
    host: &str,
    call: &Call,
    events: bool,
) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let mut interrupt = Interrupt(Some(rx));
    let listener = async {
        let _ = tokio::signal::ctrl_c().await;
        let _ = tx.send(());
        "已中断".to_string()
    };
    let mut callback: Option<Box<dyn FnMut(StreamEvent) + Send>> = None;
    if events {
        callback = Some(Box::new(|event: StreamEvent| {
            if event.stderr {
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(b"\x1b[31m");
                let _ = out.write_all(&event.data);
                let _ = out.write_all(b"\x1b[0m");
                out.flush().ok();
            } else {
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(&event.data);
                out.flush().ok();
            }
        }));
    }
    let callback_ref = callback.as_mut().map(|f| f.as_mut() as &mut (dyn FnMut(StreamEvent) + Send));
    let call = client::call_host(store, host, call, callback_ref, &mut interrupt);
    tokio::select! {
        result = call => result,
        message = listener => Err(message),
    }
}

fn write_out(bytes: &[u8]) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(bytes);
    if !bytes.ends_with(b"\n") {
        let _ = out.write_all(b"\n");
    }
}

pub async fn run(store: &Store, initial: Option<String>) -> Result<(), String> {
    let hosts = store.load().map_err(|e| e.to_string())?;
    let names: Vec<String> = hosts.keys().cloned().collect();
    let mut state = State {
        host: String::new(),
        cwd: String::new(),
        timeout_ms: 300_000,
        commands: 0,
        started: Instant::now(),
    };
    let mut rl = rustyline::DefaultEditor::new().map_err(|e| e.to_string())?;
    let mut picking = false;
    if let Some(name) = initial {
        if !hosts.contains_key(&name) {
            return Err(format!(
                "未知主机 {name}，可用: {}",
                names.join(", ")
            ));
        }
        state.host = name;
        state.cwd = config_host_cwd(&hosts, &state.host).unwrap_or_default();
    } else {
        picking = true;
        println!("可用主机:");
        for (i, name) in names.iter().enumerate() {
            let entry = &hosts[name];
            let via = entry
                .get("via")
                .and_then(Value::as_str)
                .map(|v| dim(&format!("（经 {v} relay）")))
                .unwrap_or_default();
            let address = format!(
                "{}:{}",
                entry.get("host").and_then(Value::as_str).unwrap_or("?"),
                entry.get("port").and_then(Value::as_u64).unwrap_or(0)
            );
            println!("  {}. {} {}{}", i + 1, name, dim(&address), via);
        }
    }
    if !picking {
        print_banner(&hosts, &state.host);
    }
    loop {
        let prompt = if picking {
            "选择序号或主机名（默认 1）: ".to_string()
        } else {
            format!("{}$ ", cyan(&format!("[{}:{}]", state.host, state.cwd)))
        };
        let line = match rl.readline(&prompt) {
            Ok(line) => line,
            Err(rustyline::error::ReadlineError::Interrupted)
            | Err(rustyline::error::ReadlineError::Eof) => break,
            Err(e) => return Err(e.to_string()),
        };
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        let _ = rl.add_history_entry(text);
        if picking {
            picking = false;
            let choice = if text.is_empty() {
                None
            } else if hosts.contains_key(text) {
                Some(text.to_owned())
            } else if let Ok(index) = text.parse::<usize>() {
                names.get(index - 1).cloned()
            } else {
                None
            };
            let Some(name) = choice else {
                println!("{}", red("无效选择"));
                break;
            };
            state.host = name;
            state.cwd = config_host_cwd(&hosts, &state.host).unwrap_or_default();
            print_banner(&hosts, &state.host);
            continue;
        }
        if let Some(command) = text.strip_prefix(':') {
            match session_command(store, &mut state, command).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => println!("{}", red(&format!("错误: {e}"))),
            }
            continue;
        }
        state.commands += 1;
        if let Err(e) = run_exec(store, &mut state, text).await {
            println!("{}", red(&format!("错误: {e}")));
        }
    }
    let elapsed = state.started.elapsed().as_secs();
    println!(
        "\n{}",
        dim(&format!(
            "会话结束：{} 条命令，主机 {}，用时 {}m{:02}s",
            state.commands,
            if state.host.is_empty() { "-" } else { &state.host },
            elapsed / 60,
            elapsed % 60
        ))
    );
    Ok(())
}

fn config_host_cwd(hosts: &serde_json::Map<String, Value>, name: &str) -> Option<String> {
    hosts
        .get(name)
        .and_then(|h| h.get("cwd"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// exec 参数：未确定 cwd 时省略该字段，由 daemon 使用自身可访问的工作目录。
fn exec_params(command: String, cwd: &str, timeout_ms: u64) -> Value {
    let mut params = json!({"command": command, "timeoutMs": timeout_ms});
    if !cwd.is_empty() {
        params["cwd"] = Value::from(cwd);
    }
    params
}

fn print_banner(hosts: &serde_json::Map<String, Value>, name: &str) {
    let entry = &hosts[name];
    let address = format!(
        "{}:{}",
        entry.get("host").and_then(Value::as_str).unwrap_or("?"),
        entry.get("port").and_then(Value::as_u64).unwrap_or(0)
    );
    let via = entry
        .get("via")
        .and_then(Value::as_str)
        .map(|v| format!("，经 {v} relay"))
        .unwrap_or_default();
    println!(
        "remote-exec → {name} {}",
        dim(&format!("{address}{via}，:h 帮助，:q 退出"))
    );
}

/// 返回 false 表示退出会话。
async fn session_command(store: &Store, state: &mut State, line: &str) -> Result<bool, String> {
    let mut parts = line.split_whitespace();
    let Some(command) = parts.next() else { return Ok(true) };
    let arg: String = parts.collect::<Vec<_>>().join(" ");
    let hosts = store.load().map_err(|e| e.to_string())?;
    match command {
        "q" | "quit" | "exit" => Ok(false),
        "h" | "help" => {
            println!("命令直接回车即在远端执行。会话命令:\n  :host [名]   列出/切换主机（relay 主机自动经网关）\n  :cd 目录      切换工作目录\n  :timeout 秒   设置单命令超时（当前 {}s）\n  :flow 命令    实时显示持续输出（Ctrl+C 停止）\n  :hosts       列出全部主机\n  :q           退出", state.timeout_ms / 1000);
            Ok(true)
        }
        "hosts" => {
            for (name, entry) in &hosts {
                let via = entry
                    .get("via")
                    .and_then(Value::as_str)
                    .map(|v| dim(&format!("（经 {v} relay）")))
                    .unwrap_or_default();
                let shown = if name == &state.host {
                    cyan(name)
                } else {
                    name.clone()
                };
                let address = format!(
                    "{}:{}",
                    entry.get("host").and_then(Value::as_str).unwrap_or("?"),
                    entry.get("port").and_then(Value::as_u64).unwrap_or(0)
                );
                println!("  {shown} {}{}", dim(&address), via);
            }
            Ok(true)
        }
        "host" => {
            if arg.is_empty() {
                return Box::pin(session_command(store, state, "hosts")).await;
            }
            if !hosts.contains_key(&arg) {
                println!(
                    "{}",
                    red(&format!(
                        "未知主机 {arg}，可用: {}",
                        config::host_names(&hosts)
                    ))
                );
                return Ok(true);
            }
            let configured = config_host_cwd(&hosts, &arg);
            let result = interrupted_call(
                store,
                &arg,
                &Call {
                    method: "exec".into(),
                    params: exec_params("pwd".into(), configured.as_deref().unwrap_or(""), 15000),
                },
                false,
            )
            .await;
            match result {
                Ok(value) => {
                    let stdout = decode_b64(&value, "stdoutB64");
                    let output = String::from_utf8_lossy(&stdout);
                    let trimmed = output.trim();
                    state.cwd = if trimmed.is_empty() {
                        configured.unwrap_or_default()
                    } else {
                        trimmed.to_owned()
                    };
                    state.host = arg.clone();
                    let entry = &hosts[&arg];
                    let via = entry
                        .get("via")
                        .and_then(Value::as_str)
                        .map(|v| format!("，经 {v} relay"))
                        .unwrap_or_default();
                    let address = format!(
                        "{}:{}{}",
                        entry.get("host").and_then(Value::as_str).unwrap_or("?"),
                        entry.get("port").and_then(Value::as_u64).unwrap_or(0),
                        via
                    );
                    println!("{}", dim(&format!("已连接 {arg}（{address}）")));
                }
                Err(e) => println!("{}", red(&format!("连接 {arg} 失败: {e}"))),
            }
            Ok(true)
        }
        "cd" => {
            if arg.is_empty() {
                state.cwd = String::new();
                return Ok(true);
            }
            let quoted = serde_json::to_string(&arg).unwrap_or_else(|_| arg.clone());
            let value = interrupted_call(
                store,
                &state.host,
                &Call {
                    method: "exec".into(),
                    params: exec_params(format!("cd {quoted} && pwd"), &state.cwd, 15000),
                },
                false,
            )
            .await?;
            if value.get("exitCode").and_then(Value::as_i64) != Some(0) {
                let stderr = decode_b64(&value, "stderrB64");
                let error = String::from_utf8_lossy(&stderr);
                let message = error.trim();
                println!(
                    "{}",
                    red(if message.is_empty() {
                        "cd 失败"
                    } else {
                        message
                    })
                );
            } else {
                let stdout = decode_b64(&value, "stdoutB64");
                let output = String::from_utf8_lossy(&stdout);
                state.cwd = output.trim().to_owned();
            }
            Ok(true)
        }
        "timeout" => {
            let seconds: u64 = arg.parse().map_err(|_| "用法: :timeout 秒".to_string())?;
            if seconds < 1 {
                return Err("用法: :timeout 秒".into());
            }
            state.timeout_ms = seconds * 1000;
            println!("{}", dim(&format!("超时已设为 {seconds}s")));
            Ok(true)
        }
        "flow" => {
            if arg.is_empty() {
                return Err("用法: :flow <命令>".into());
            }
            let started = Instant::now();
            let value = interrupted_call(
                store,
                &state.host,
                &Call {
                    method: "exec.stream".into(),
                    params: exec_params(arg, &state.cwd, state.timeout_ms),
                },
                true,
            )
            .await?;
            print_summary(&value, started, true);
            Ok(true)
        }
        other => {
            println!("{}", red(&format!("未知会话命令 :{other}，:h 查看帮助")));
            Ok(true)
        }
    }
}

async fn run_exec(store: &Store, state: &mut State, line: &str) -> Result<(), String> {
    let started = Instant::now();
    // 尾部追加 PWD 回传：cd 后提示符自动跟随。
    let wrapped = format!("{line}\nprintf '{PWD_MARK}%s' \"$PWD\"");
    let value = interrupted_call(
        store,
        &state.host,
        &Call {
            method: "exec".into(),
            params: exec_params(wrapped, &state.cwd, state.timeout_ms),
        },
        false,
    )
    .await?;
    let full = decode_b64(&value, "stdoutB64");
    let mut stdout = full.clone();
    if let Some(position) = find_subslice(&full, PWD_MARK.as_bytes()) {
        stdout.truncate(position);
        // 同步提示符：标记后的第一行即远端 PWD。
        let tail = String::from_utf8_lossy(&full[position + PWD_MARK.len()..]);
        if let Some(next) = tail.lines().next().map(str::trim).filter(|s| !s.is_empty()) {
            state.cwd = next.to_owned();
        }
    }
    print_exec_output(stdout, &value, started);
    Ok(())
}

fn print_exec_output(stdout: Vec<u8>, value: &Value, started: Instant) {
    let stderr = decode_b64(value, "stderrB64");
    if stdout.contains(&0) {
        println!("{}", dim("(stdout 含二进制，预览前 256 字节 hex)"));
        let preview: String = stdout
            .iter()
            .take(256)
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(" ");
        println!("{preview}");
    } else if !stdout.is_empty() {
        write_out(&stdout);
    }
    if !stderr.is_empty() {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(b"\x1b[31m");
        let _ = out.write_all(&stderr);
        let _ = out.write_all(b"\x1b[0m\n");
    }
    print_summary(value, started, false);
}

fn print_summary(value: &Value, started: Instant, stream: bool) {
    let exit = value.get("exitCode").and_then(Value::as_i64).unwrap_or(-1);
    let elapsed = started.elapsed().as_secs_f64();
    let mut parts = vec![
        format!("exit={exit}"),
        format!("{elapsed:.2}s"),
    ];
    if stream {
        if let Some(reason) = value.get("reason").and_then(Value::as_str) {
            parts.push(reason.to_owned());
        }
    } else if value.get("truncated").and_then(Value::as_bool) == Some(true) {
        parts.push(dim("输出已截断"));
    }
    if exit == 124 {
        parts.push(dim("超时被杀"));
    }
    println!("{}", dim(&format!("-- {}", parts.join(" "))));
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}
