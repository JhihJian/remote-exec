use crate::client::{self, Call, Interrupt};
use crate::config::Store;
use crate::{config, http, smoke, ui};
use serde_json::json;

pub const HELP: &str = "用法: rex [主机名]                交互式会话（缺省进入主机选择）
  rex hosts                       列出全部主机并探测连通延迟
  rex exec <主机> -- <命令...>      执行单条命令并打印结果
  rex read <主机> <绝对路径>        读取远端文件到 stdout（≤64MB）
  rex write <主机> <绝对路径>       从 stdin 写入远端文件（≤64MB）
  rex upload <主机> <本地> <远端>   流式上传（仅直连主机）
  rex download <主机> <远端> <本地> 流式下载（仅直连主机）
  rex smoke --port N --ca <pem> --token-file <f> [--expected-user 用户] [--host 地址]
                                   安装验收（readyz + WSS exec）
  运维命令由独立 rex-ops 扩展提供：deploy、upgrade、migrate";

pub async fn run(store: &Store, args: &[String]) -> Result<(), String> {
    let Some(first) = args.first().map(String::as_str) else {
        return ui::run(store, None).await;
    };
    match first {
        "-h" | "--help" | "help" => println!("{HELP}"),
        "hosts" | "-l" | "--list" => list_hosts(store).await?,
        "exec" => one_shot_exec(store, &args[1..]).await?,
        "read" => one_shot_file(store, &args[1..], Direction::Read).await?,
        "write" => one_shot_file(store, &args[1..], Direction::Write).await?,
        "upload" => transfer(store, &args[1..], Direction::Write).await?,
        "download" => transfer(store, &args[1..], Direction::Read).await?,
        "smoke" => {
            let options = smoke_options(&args[1..])?;
            smoke::run(&options).await?;
            println!("TLS、token、WSS 与执行用户验收通过");
        }
        host => ui::run(store, Some(host.to_owned())).await?,
    }
    Ok(())
}

async fn list_hosts(store: &Store) -> Result<(), String> {
    let hosts = store.load().map_err(|e| e.to_string())?;
    println!("可连接主机（{} 台）：", hosts.len());
    let mut tasks = tokio::task::JoinSet::new();
    for (name, entry) in &hosts {
        let name = name.clone();
        let host = entry
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        let port = entry.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
        let via = entry
            .get("via")
            .and_then(|v| v.as_str())
            .map(|v| format!("经 {v} relay"))
            .unwrap_or_else(|| "直连".into());
        let address = format!("{host}:{port}");
        let store = Store::new(config::config_root());
        let probe = async move {
            let started = std::time::Instant::now();
            let call = Call {
                method: "exec".into(),
                params: json!({"command": "true", "timeoutMs": 8000}),
            };
            let mut interrupt = Interrupt(None);
            match client::call_host(&store, &name, &call, None, &mut interrupt).await {
                Ok(_) => (
                    name,
                    address,
                    via,
                    format!("✓ {}ms", started.elapsed().as_millis()),
                ),
                Err(e) => (
                    name,
                    address,
                    via,
                    format!("✗ {}", e.chars().take(60).collect::<String>()),
                ),
            }
        };
        tasks.spawn(probe);
    }
    let mut rows = Vec::new();
    while let Some(row) = tasks.join_next().await {
        if let Ok(row) = row {
            rows.push(row);
        }
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, address, via, status) in rows {
        let mark = if status.starts_with('✓') {
            "\x1b[32m"
        } else {
            "\x1b[31m"
        };
        let name_padded = format!("{:<8}", name);
        let address_padded = format!("{:<22}", address);
        let via_padded = format!("{:<14}", via);
        println!(
            "  \x1b[36m{name_padded}\x1b[0m \x1b[2m{address_padded} {via_padded}\x1b[0m {mark}{status}\x1b[0m"
        );
    }
    Ok(())
}

async fn one_shot_exec(store: &Store, args: &[String]) -> Result<(), String> {
    let (host, command) = split_host_command(args)?;
    let mut interrupt = Interrupt(None);
    let started = std::time::Instant::now();
    let mut params = json!({"command": command, "timeoutMs": 300_000});
    if let Some(cwd) = store.host(&host).ok().and_then(|entry| entry.cwd) {
        params["cwd"] = serde_json::Value::from(cwd);
    }
    let value = client::call_host(
        store,
        &host,
        &Call {
            method: "exec".into(),
            params,
        },
        None,
        &mut interrupt,
    )
    .await?;
    let stdout = client::decode_b64(&value, "stdoutB64");
    let stderr = client::decode_b64(&value, "stderrB64");
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&stdout);
    if !stdout.ends_with(b"\n") && !stdout.is_empty() {
        let _ = out.write_all(b"\n");
    }
    drop(out);
    if !stderr.is_empty() {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(&stderr);
        if !stderr.ends_with(b"\n") {
            let _ = err.write_all(b"\n");
        }
    }
    let exit = value.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(-1);
    println!(
        "\x1b[2m-- exit={} {:.1}s\x1b[0m",
        exit,
        started.elapsed().as_secs_f64()
    );
    if exit != 0 {
        std::process::exit(exit as i32);
    }
    Ok(())
}

fn split_host_command(args: &[String]) -> Result<(String, String), String> {
    let Some(host) = args.first() else {
        return Err("用法: rex exec <主机> -- <命令...>".into());
    };
    let Some(position) = args.iter().position(|a| a == "--") else {
        return Err("命令需要以 -- 分隔，例如 rex exec 主机 -- ls /root".into());
    };
    if position != 1 {
        return Err("用法: rex exec <主机> -- <命令...>".into());
    }
    let command = args[2..].join(" ");
    if command.is_empty() {
        return Err("命令不能为空".into());
    }
    Ok((host.clone(), command))
}

enum Direction {
    Read,
    Write,
}

async fn one_shot_file(store: &Store, args: &[String], direction: Direction) -> Result<(), String> {
    let (host, path) = match args {
        [host, path] => (host.clone(), path.clone()),
        _ => {
            return Err(match direction {
                Direction::Read => "用法: rex read <主机> <绝对路径>".into(),
                Direction::Write => "用法: rex write <主机> <绝对路径>".into(),
            });
        }
    };
    let mut interrupt = Interrupt(None);
    let (method, params) = match direction {
        Direction::Read => ("file.read", json!({"file": path})),
        Direction::Write => {
            use std::io::Read;
            let mut content = Vec::new();
            std::io::stdin()
                .read_to_end(&mut content)
                .map_err(|e| format!("读取 stdin 失败: {e}"))?;
            use base64::Engine;
            (
                "file.write",
                json!({"file": path, "contentB64": base64::engine::general_purpose::STANDARD.encode(&content)}),
            )
        }
    };
    let value = client::call_host(
        store,
        &host,
        &Call {
            method: method.into(),
            params,
        },
        None,
        &mut interrupt,
    )
    .await?;
    if let Direction::Read = direction {
        let content = client::decode_b64(&value, "contentB64");
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(&content);
        let _ = out.flush();
    } else {
        let size = value.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        println!("已写入 {size} 字节");
    }
    Ok(())
}

async fn transfer(store: &Store, args: &[String], direction: Direction) -> Result<(), String> {
    let (host, local, remote) = match args {
        [host, a, b] => match direction {
            Direction::Write => (host.clone(), a.clone(), b.clone()),
            Direction::Read => (host.clone(), b.clone(), a.clone()),
        },
        _ => {
            return Err(match direction {
                Direction::Read => "用法: rex download <主机> <远端绝对路径> <本地路径>".into(),
                Direction::Write => "用法: rex upload <主机> <本地路径> <远端绝对路径>".into(),
            });
        }
    };
    let entry = store.host(&host).map_err(|e| e.to_string())?;
    if entry.via.is_some() {
        return Err(format!("\"{host}\" 经网关中转，暂不支持流式传输"));
    }
    let token = std::fs::read_to_string(&entry.token_file)
        .map_err(|e| format!("读取 token 失败: {e}"))?
        .trim()
        .to_owned();
    let ca_pem = std::fs::read_to_string(&entry.ca).map_err(|e| e.to_string())?;
    let result = match direction {
        Direction::Write => {
            http::upload(
                &entry,
                &ca_pem,
                &token,
                std::path::Path::new(&local),
                &remote,
            )
            .await?
        }
        Direction::Read => {
            http::download(
                &entry,
                &ca_pem,
                &token,
                &remote,
                std::path::Path::new(&local),
            )
            .await?
        }
    };
    println!("{} 字节 sha256={}", result.size, result.sha256);
    Ok(())
}

fn smoke_options(args: &[String]) -> Result<smoke::Options<'static>, String> {
    let mut host = "127.0.0.1".to_owned();
    let mut port: Option<u16> = None;
    let mut ca: Option<String> = None;
    let mut token_file: Option<String> = None;
    let mut expected_user: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let value = args.get(index + 1).ok_or(format!("{arg} 需要值"))?.clone();
        match arg {
            "--host" => host = value,
            "--port" => port = Some(value.parse().map_err(|_| format!("无效端口: {value}"))?),
            "--ca" => ca = Some(value),
            "--token-file" => token_file = Some(value),
            "--expected-user" => expected_user = Some(value),
            other => return Err(format!("无效参数: {other}")),
        }
        index += 2;
    }
    Ok(smoke::Options {
        host: leak_str(host),
        port: port.ok_or("需要 --port")?,
        ca: leak_str(ca.ok_or("需要 --ca")?),
        token_file: leak_str(token_file.ok_or("需要 --token-file")?),
        expected_user: expected_user.map(leak_str),
    })
}

fn leak_str(value: String) -> &'static str {
    Box::leak(value.into_boxed_str())
}
