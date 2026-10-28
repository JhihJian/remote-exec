use crate::{AnyError, auth, files, rpc};
use futures_util::{StreamExt, TryStreamExt};
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response, StatusCode,
    body::{Bytes, Frame, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use sha2::{Digest, Sha256};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::AsyncReadExt;
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        handshake::derive_accept_key,
        protocol::{Role, WebSocketConfig},
    },
};

type Body = UnsyncBoxBody<Bytes, AnyError>;
fn response(status: StatusCode, text: impl Into<Bytes>, content_type: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(
            Full::new(text.into())
                .map_err(|e: Infallible| match e {})
                .boxed_unsync(),
        )
        .expect("valid response")
}
fn error(status: StatusCode, message: impl ToString) -> Response<Body> {
    response(
        status,
        serde_json::json!({"error": message.to_string()}).to_string(),
        "application/json",
    )
}

fn decode(input: &str) -> Result<String, AnyError> {
    let mut bytes = Vec::with_capacity(input.len());
    let mut iter = input.bytes();
    while let Some(c) = iter.next() {
        match c {
            b'+' => bytes.push(b' '),
            b'%' => {
                let a = iter.next().ok_or("无效 URL 编码")?;
                let b = iter.next().ok_or("无效 URL 编码")?;
                let hex = |c: u8| (c as char).to_digit(16).ok_or("无效 URL 编码");
                bytes.push((hex(a)? * 16 + hex(b)?) as u8);
            }
            c => bytes.push(c),
        }
    }
    Ok(String::from_utf8(bytes)?)
}
fn query_path(req: &Request<Incoming>) -> Result<String, AnyError> {
    let mut path = None;
    for pair in req.uri().query().unwrap_or("").split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if decode(key)? == "path" {
            if path.is_some() {
                return Err("重复 path".into());
            }
            path = Some(decode(value)?);
        }
    }
    let path = path.ok_or("缺少 path")?;
    files::absolute(Some(&path)).map_err(|e| e.message)?;
    Ok(path)
}

async fn upload(
    mut req: Request<Incoming>,
    path: &std::path::Path,
    _guard: crate::lifecycle::Guard,
) -> Result<Response<Body>, AnyError> {
    let (temp, mut file) = files::Temporary::create(path).await?;
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    while let Some(frame) =
        tokio::time::timeout(Duration::from_secs(1800), req.body_mut().frame()).await?
    {
        let frame = frame?;
        if let Ok(data) = frame.into_data() {
            use tokio::io::AsyncWriteExt;
            file.write_all(&data).await?;
            hash.update(&data);
            size = size.checked_add(data.len() as u64).ok_or("上传大小溢出")?;
        }
    }
    file.sync_all().await?;
    drop(file);
    temp.commit(path).await?;
    Ok(response(
        StatusCode::OK,
        serde_json::json!({"size": size, "sha256": format!("{:x}", hash.finalize())}).to_string(),
        "application/json",
    ))
}
async fn download(
    path: &std::path::Path,
    guard: crate::lifecycle::Guard,
) -> Result<Response<Body>, AnyError> {
    let file = files::open_regular(path).await?;
    let size = file.metadata().await?.len();
    let stream = futures_util::stream::try_unfold(
        (file, size, guard),
        |(mut file, left, guard)| async move {
            if left == 0 {
                drop(guard);
                return Ok::<_, AnyError>(None);
            }
            let mut data = vec![0; left.min(64 * 1024) as usize];
            let n = file.read(&mut data).await?;
            if n == 0 {
                return Err("下载过程文件缩短".into());
            }
            data.truncate(n);
            Ok(Some((
                Frame::data(Bytes::from(data)),
                (file, left - n as u64, guard),
            )))
        },
    );
    Ok(Response::builder()
        .header("content-type", "application/octet-stream")
        .header("content-length", size)
        .body(StreamBody::new(stream).boxed_unsync())?)
}

const MAX_RELAY_DOWNLOAD_REQUEST: usize = 128 * 1024;

fn encode_query(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

async fn relay_download(
    mut req: Request<Incoming>,
    relay_allow: &[String],
    guard: crate::lifecycle::Guard,
) -> Result<Response<Body>, AnyError> {
    let mut body = Vec::new();
    while let Some(frame) = req.body_mut().frame().await {
        let frame = frame?;
        if let Ok(data) = frame.into_data() {
            if body.len() + data.len() > MAX_RELAY_DOWNLOAD_REQUEST {
                return Err("relay-download 请求体过大".into());
            }
            body.extend_from_slice(&data);
        }
    }
    let value: serde_json::Value = serde_json::from_slice(&body)?;
    let target = value.get("target").ok_or("缺少 target")?;
    let auth = value.get("auth").ok_or("缺少 auth")?;
    let host = target
        .get("host")
        .and_then(|v| v.as_str())
        .ok_or("target.host 必须是 IPv4 字面量")?;
    let ip = host
        .parse::<std::net::Ipv4Addr>()
        .map_err(|_| "target.host 必须是 IPv4 字面量")?;
    if !crate::relay::target_allowed(ip, relay_allow) {
        return Err(format!("目标 {host} 不在 relay 白名单内").into());
    }
    let port = target
        .get("port")
        .and_then(|v| v.as_u64())
        .filter(|v| (1..=65535).contains(v))
        .ok_or("target.port 必须是 1..65535 的整数")?;
    let servername = target
        .get("servername")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty() && !v.contains('/') && !v.contains(':'))
        .unwrap_or(host);
    let token = auth
        .get("token")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or("auth.token 不能为空")?;
    let ca = auth
        .get("ca")
        .and_then(|v| v.as_str())
        .filter(|v| v.contains("BEGIN CERTIFICATE"))
        .ok_or("auth.ca 必须是目标 CA 的 PEM 文本")?;
    let file = value
        .get("file")
        .and_then(|v| v.as_str())
        .ok_or("缺少 file")?;
    files::absolute(Some(file)).map_err(|e| e.message)?;
    let certificate = reqwest::Certificate::from_pem(ca.as_bytes())?;
    let target_addr = format!("{host}:{port}")
        .parse()
        .map_err(|_| "目标地址无效")?;
    let client = reqwest::Client::builder()
        .add_root_certificate(certificate)
        .resolve(servername, target_addr)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30 * 60))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client
        .get(format!(
            "https://{servername}:{port}/download?path={}",
            encode_query(file)
        ))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await?;
    let status = StatusCode::from_u16(response.status().as_u16())?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let content_length = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let stream = response
        .bytes_stream()
        .map_err(|e| -> AnyError { Box::new(e) })
        .map_ok(Frame::data)
        .map(move |item| {
            let _keep_alive = &guard;
            item
        });
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", content_type);
    if let Some(content_length) = content_length {
        builder = builder.header("content-length", content_length);
    }
    Ok(builder.body(StreamBody::new(stream).boxed_unsync())?)
}

pub async fn serve<S>(
    socket: S,
    hash: [u8; 32],
    relay_allow: Vec<String>,
    lifecycle: std::sync::Arc<crate::lifecycle::Lifecycle>,
    task_manager: std::sync::Arc<crate::tasks::TaskManager>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (upgrade_tx, upgrade_rx) = tokio::sync::oneshot::channel();
    let upgrade_tx = Arc::new(Mutex::new(Some(upgrade_tx)));
    let lifecycle_for_session = lifecycle.clone();
    let relay_allow_for_http = relay_allow.clone();
    let service = service_fn(move |mut req: Request<Incoming>| {
        let upgrade_tx = upgrade_tx.clone();
        let lifecycle = lifecycle.clone();
        let relay_allow = relay_allow_for_http.clone();
        async move {
            let result = if req.headers().contains_key("upgrade") {
                if !lifecycle.accepting() {
                    response(StatusCode::SERVICE_UNAVAILABLE, "draining\n", "text/plain")
                } else if req.headers().contains_key("origin") {
                    error(StatusCode::FORBIDDEN, "Origin 不允许")
                } else if !auth::authorized(req.headers(), &hash) {
                    error(StatusCode::UNAUTHORIZED, "unauthorized")
                } else {
                    let token = |name: &str, target: &str| {
                        req.headers()
                            .get_all(name)
                            .iter()
                            .filter_map(|v| v.to_str().ok())
                            .flat_map(|v| v.split(','))
                            .any(|v| v.trim().eq_ignore_ascii_case(target))
                    };
                    let key = req
                        .headers()
                        .get("sec-websocket-key")
                        .and_then(|v| v.to_str().ok());
                    use base64::Engine;
                    let valid_key = key.is_some_and(|k| {
                        base64::engine::general_purpose::STANDARD
                            .decode(k)
                            .is_ok_and(|v| v.len() == 16)
                    });
                    if req.method() != hyper::Method::GET
                        || !token("upgrade", "websocket")
                        || !token("connection", "upgrade")
                        || req
                            .headers()
                            .get("sec-websocket-version")
                            .is_none_or(|v| v != "13")
                        || !valid_key
                    {
                        error(StatusCode::BAD_REQUEST, "无效 WebSocket 握手")
                    } else {
                        let accept = derive_accept_key(key.expect("validated").as_bytes());
                        if let Some(tx) = upgrade_tx.lock().expect("upgrade mutex").take() {
                            let _ = tx.send(hyper::upgrade::on(&mut req));
                        }
                        Response::builder()
                            .status(StatusCode::SWITCHING_PROTOCOLS)
                            .header("connection", "Upgrade")
                            .header("upgrade", "websocket")
                            .header("sec-websocket-accept", accept)
                            .body(
                                Full::new(Bytes::new())
                                    .map_err(|e: Infallible| match e {})
                                    .boxed_unsync(),
                            )
                            .expect("valid upgrade")
                    }
                }
            } else {
                match (req.method().as_str(), req.uri().path()) {
                    ("GET", "/healthz") => response(StatusCode::OK, "ok\n", "text/plain"),
                    ("GET", "/readyz") => {
                        if lifecycle.accepting() {
                            response(StatusCode::OK, "ok\n", "text/plain")
                        } else {
                            response(StatusCode::SERVICE_UNAVAILABLE, "draining\n", "text/plain")
                        }
                    }
                    ("POST", "/relay-download") | ("POST", "/upload") | ("GET", "/download") => {
                        if !auth::authorized(req.headers(), &hash) {
                            error(StatusCode::UNAUTHORIZED, "unauthorized")
                        } else {
                            match lifecycle.acquire("http") {
                                None => response(
                                    StatusCode::SERVICE_UNAVAILABLE,
                                    "draining\n",
                                    "text/plain",
                                ),
                                Some(guard) => {
                                    if req.uri().path() == "/relay-download" {
                                        relay_download(req, &relay_allow, guard)
                                            .await
                                            .unwrap_or_else(|e| error(StatusCode::BAD_GATEWAY, e))
                                    } else {
                                        match query_path(&req) {
                                            Err(e) => error(StatusCode::BAD_REQUEST, e),
                                            Ok(path) => {
                                                let is_upload = req.method() == hyper::Method::POST;
                                                let result = if is_upload {
                                                    upload(req, std::path::Path::new(&path), guard)
                                                        .await
                                                } else {
                                                    download(std::path::Path::new(&path), guard)
                                                        .await
                                                };
                                                result.unwrap_or_else(|e| {
                                                    error(
                                                        if is_upload {
                                                            StatusCode::INTERNAL_SERVER_ERROR
                                                        } else {
                                                            StatusCode::NOT_FOUND
                                                        },
                                                        e,
                                                    )
                                                })
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => error(StatusCode::NOT_FOUND, "not found"),
                }
            };
            Ok::<_, Infallible>(result)
        }
    });
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(10))
        .serve_connection(TokioIo::new(socket), service)
        .with_upgrades()
        .await;
    if let Ok(upgrade) = upgrade_rx.await
        && let Ok(Ok(socket)) = tokio::time::timeout(Duration::from_secs(10), upgrade).await
    {
        let config = WebSocketConfig::default()
            .max_message_size(Some(files::MAX_PAYLOAD))
            .max_frame_size(Some(files::MAX_PAYLOAD));
        let ws = WebSocketStream::from_raw_socket(TokioIo::new(socket), Role::Server, Some(config))
            .await;
        rpc::session(ws, relay_allow, lifecycle_for_session, task_manager).await;
    }
}
