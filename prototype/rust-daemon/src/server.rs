use crate::{AnyError, auth, files, rpc};
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
async fn download(path: &std::path::Path) -> Result<Response<Body>, AnyError> {
    let file = files::open_regular(path).await?;
    let size = file.metadata().await?.len();
    let stream = futures_util::stream::try_unfold((file, size), |(mut file, left)| async move {
        if left == 0 {
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
            (file, left - n as u64),
        )))
    });
    Ok(Response::builder()
        .header("content-type", "application/octet-stream")
        .header("content-length", size)
        .body(StreamBody::new(stream).boxed_unsync())?)
}

pub async fn serve<S>(socket: S, hash: [u8; 32], relay_allow: Vec<String>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (upgrade_tx, upgrade_rx) = tokio::sync::oneshot::channel();
    let upgrade_tx = Arc::new(Mutex::new(Some(upgrade_tx)));
    let service = service_fn(move |mut req: Request<Incoming>| {
        let upgrade_tx = upgrade_tx.clone();
        async move {
            let result = if req.headers().contains_key("upgrade") {
                if req.headers().contains_key("origin") {
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
                    ("GET", "/healthz" | "/readyz") => {
                        response(StatusCode::OK, "ok\n", "text/plain")
                    }
                    ("POST", "/upload") | ("GET", "/download") => {
                        if !auth::authorized(req.headers(), &hash) {
                            error(StatusCode::UNAUTHORIZED, "unauthorized")
                        } else {
                            match query_path(&req) {
                                Err(e) => error(StatusCode::BAD_REQUEST, e),
                                Ok(path) => {
                                    let is_upload = req.method() == hyper::Method::POST;
                                    let result = if is_upload {
                                        upload(req, std::path::Path::new(&path)).await
                                    } else {
                                        download(std::path::Path::new(&path)).await
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
        rpc::session(ws, relay_allow).await;
    }
}
