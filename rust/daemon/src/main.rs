mod auth;
mod exec;
mod files;
mod relay;
mod rpc;
mod server;
mod supervisor;

use std::{error::Error, io::BufReader, sync::Arc};
use tokio::net::TcpListener;
use tokio_rustls::{TlsAcceptor, rustls::ServerConfig};

type AnyError = Box<dyn Error + Send + Sync>;

struct Options {
    host: String,
    port: u16,
    cert: String,
    key: String,
    hash: String,
    relay_allow: Vec<String>,
}

fn options(args: &[String]) -> Result<Option<Options>, AnyError> {
    let mut args = args.iter().map(String::as_str);
    let mut opts = Options {
        host: "127.0.0.1".into(),
        port: 8791,
        cert: String::new(),
        key: String::new(),
        hash: String::new(),
        relay_allow: Vec::new(),
    };
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            println!(
                "remote-execd 服务程序，仅 TLS\n\
子命令:\n\
  daemon      运行 daemon（默认，可省略）\n\
  supervisor  运行固定入口 supervisor\n\
daemon 参数: --host <host> --port <port> --cert <pem> --key <pem> --token-sha256-file <file> [--relay-allow <cidr>]..."
            );
            return Ok(None);
        }
        if !matches!(
            arg,
            "--host" | "--port" | "--cert" | "--key" | "--token-sha256-file" | "--relay-allow"
        ) {
            return Err(format!("未知参数: {arg}").into());
        }
        let value = args.next().ok_or_else(|| format!("{arg} 需要值"))?;
        match arg {
            "--host" => opts.host = value.into(),
            "--port" => opts.port = value.parse()?,
            "--cert" => opts.cert = value.into(),
            "--key" => opts.key = value.into(),
            "--token-sha256-file" => opts.hash = value.into(),
            "--relay-allow" => opts.relay_allow.push(value.into()),
            _ => unreachable!(),
        }
    }
    if opts.cert.is_empty() || opts.key.is_empty() || opts.hash.is_empty() {
        return Err("必须提供 --cert --key --token-sha256-file".into());
    }
    Ok(Some(opts))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), AnyError> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("supervisor") => return supervisor::run(&arguments[1..]).await,
        Some("daemon") | None => {}
        Some(other) if other.starts_with('-') => {}
        Some(other) => {
            return Err(format!("未知子命令: {other}（支持 daemon 或 supervisor）").into());
        }
    }
    let opts_args = match arguments.first().map(String::as_str) {
        Some("daemon") | Some("supervisor") => &arguments[1..],
        _ => &arguments[..],
    };
    let Some(opts) = options(opts_args)? else {
        return Ok(());
    };
    let hash = auth::load_hash(&std::fs::read_to_string(opts.hash)?)?;
    let cert = std::fs::read(opts.cert)?;
    let key = std::fs::read(opts.key)?;
    let certs = rustls_pemfile::certs(&mut BufReader::new(cert.as_slice()))
        .collect::<Result<Vec<_>, _>>()?;
    let key =
        rustls_pemfile::private_key(&mut BufReader::new(key.as_slice()))?.ok_or("PEM 缺少私钥")?;
    let tls = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    let acceptor = TlsAcceptor::from(Arc::new(tls));
    let listener = TcpListener::bind((opts.host.as_str(), opts.port)).await?;
    eprintln!(
        "remote-execd listening {} (TLS only)",
        listener.local_addr()?
    );
    let permits = Arc::new(tokio::sync::Semaphore::new(64));
    let relay_allow = opts.relay_allow;
    let mut tasks = tokio::task::JoinSet::new();
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = term.recv() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let (socket, _) = accepted?;
                let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                let acceptor = acceptor.clone();
                let relay_allow = relay_allow.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    if let Ok(Ok(tls)) = tokio::time::timeout(std::time::Duration::from_secs(10), acceptor.accept(socket)).await {
                        server::serve(tls, hash, relay_allow).await;
                    }
                });
            }
        }
    }
    // SIGTERM/SIGINT 触发排空关闭；排空语义在 lifecycle 模块实现。
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}
