//! WSS 客户端：直连与经网关 relay（信封协议），与 Node lib/client.js 语义一致。
use crate::config::HostEntry;
use futures_util::{SinkExt, StreamExt};
use rustls_pki_types::ServerName;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    WebSocketStream,
    client_async_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        handshake::client::Response,
        protocol::WebSocketConfig,
    },
};

pub type AnyError = Box<dyn std::error::Error + Send + Sync>;

const MAX_MESSAGE: usize = 64 * 1024 * 1024;

/// 以目标 CA 建立 TLS 连接；SNI/校验名取 servername（缺省 host），IP 字面量自动按 IP SAN 校验。
async fn connect_tls(
    host: &str,
    port: u16,
    servername: Option<&str>,
    ca_pem: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, AnyError> {
    let mut roots = rustls::RootCertStore::empty();
    let mut reader = std::io::BufReader::new(ca_pem.as_bytes());
    for cert in rustls_pemfile::certs(&mut reader) {
        roots.add(cert?)?;
    }
    let config = Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    );
    let name = servername.filter(|s| !s.is_empty()).unwrap_or(host);
    let server_name = ServerName::try_from(name.to_owned())
        .map_err(|e| format!("无效 servername \"{name}\": {e}"))?;
    let tcp = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("连接 {host}:{port} 超时"))??;
    let connector = tokio_rustls::TlsConnector::from(config);
    let tls = tokio::time::timeout(
        Duration::from_secs(15),
        connector.connect(server_name, tcp),
    )
    .await
    .map_err(|_| format!("TLS 握手 {host}:{port} 超时"))??;
    Ok(tls)
}

async fn wss_handshake(
    tls: tokio_rustls::client::TlsStream<TcpStream>,
    servername: &str,
    token: &str,
) -> Result<
    (
        WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>>,
        Response,
    ),
    AnyError,
> {
    let mut request = format!("wss://{servername}/").into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| "无效 token")?,
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (ws, response) = tokio::time::timeout(
        Duration::from_secs(15),
        client_async_with_config(request, tls, Some(config)),
    )
    .await
    .map_err(|_| "WSS 升级超时".to_string())??;
    Ok((ws, response))
}

/// 流式事件：stdout/stderr 增量。
pub struct StreamEvent {
    pub stderr: bool,
    pub data: Vec<u8>,
}

pub struct Call {
    pub method: String,
    pub params: Value,
}

/// 中断句柄：SIGINT 或用户取消时触发，连接被丢弃，服务端检测断连终止子进程。
pub struct Interrupt(pub Option<tokio::sync::oneshot::Receiver<()>>);

fn rpc_error_text(code: i64, message: &str) -> String {
    format!("rpc {code}: {message}")
}

/// 对目标主机发起一次调用（每调用一连接），支持直连与 relay。
/// relay 时向网关发送信封 {target, auth:{token,ca}, request}，流式事件与终态按协议转发。
pub async fn call_host(
    store: &crate::config::Store,
    host_name: &str,
    call: &Call,
    on_event: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    interrupt: &mut Interrupt,
) -> Result<Value, String> {
    let entry = store.host(host_name).map_err(|e| e.to_string())?;
    let token = std::fs::read_to_string(&entry.token_file)
        .map_err(|e| format!("读取 token 失败 {}: {e}", entry.token_file))?
        .trim()
        .to_owned();
    let ca_pem = std::fs::read_to_string(&entry.ca)
        .map_err(|e| format!("读取 CA 失败 {}: {e}", entry.ca))?;

    let Some(gateway) = &entry.via else {
        return call_entry(&entry, &token, call, on_event, interrupt).await;
    };
    let gateway_entry: HostEntry = store.host(gateway).map_err(|e| e.to_string())?;
    if gateway_entry.via.is_some() {
        return Err("via 链深度仅支持 1，不支持链式转发".into());
    }
    let gateway_token = std::fs::read_to_string(&gateway_entry.token_file)
        .map_err(|e| format!("读取 token 失败 {}: {e}", gateway_entry.token_file))?
        .trim()
        .to_owned();
    let tls = connect_tls(
        &gateway_entry.host,
        gateway_entry.port,
        gateway_entry.servername.as_deref(),
        &ca_pem_gateway(&gateway_entry)?,
    )
    .await
    .map_err(|e| e.to_string())?;
    let (mut ws, _) = wss_handshake(
        tls,
        name_or(&gateway_entry),
        &gateway_token,
    )
    .await
    .map_err(|e| e.to_string())?;
    let envelope = json!({
        "target": {"host": entry.host, "port": entry.port},
        "auth": {"token": token, "ca": ca_pem},
        "request": {"method": call.method, "params": call.params},
    });
    let request = json!({"id": 1, "method": "relay", "params": envelope});
    let final_value = drive(&mut ws, request, on_event, interrupt).await?;
    let error = final_value.get("error").filter(|e| !e.is_null());
    if let Some(error) = error {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
        return Err(rpc_error_text(code, message));
    }
    Ok(final_value.get("result").cloned().unwrap_or(Value::Null))
}

fn ca_pem_gateway(entry: &HostEntry) -> Result<String, String> {
    std::fs::read_to_string(&entry.ca).map_err(|e| format!("读取 CA 失败 {}: {e}", entry.ca))
}

fn name_or(entry: &HostEntry) -> &str {
    entry.servername.as_deref().unwrap_or(&entry.host)
}

/// 直连指定条目（smoke 与 call_host 直连路径共用）。
pub async fn call_entry(
    entry: &HostEntry,
    token: &str,
    call: &Call,
    on_event: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    interrupt: &mut Interrupt,
) -> Result<Value, String> {
    let ca_pem =
        std::fs::read_to_string(&entry.ca).map_err(|e| format!("读取 CA 失败 {}: {e}", entry.ca))?;
    let tls = connect_tls(&entry.host, entry.port, entry.servername.as_deref(), &ca_pem)
        .await
        .map_err(|e| e.to_string())?;
    let (mut ws, _) = wss_handshake(tls, name_or(entry), token)
        .await
        .map_err(|e| e.to_string())?;
    let request = json!({"id": 1, "method": call.method, "params": call.params});
    drive(&mut ws, request, on_event, interrupt).await
}

/// 发送请求并驱动读循环：事件回调、终态返回。abort 时直接断开（丢弃 ws）。
async fn drive<S>(
    ws: &mut WebSocketStream<S>,
    request: Value,
    mut on_event: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    interrupt: &mut Interrupt,
) -> Result<Value, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    ws.send(Message::Text(request.to_string().into()))
        .await
        .map_err(|e| format!("发送失败: {e}"))?;
    let mut interrupt = interrupt.0.take();
    let result = loop {
        let interrupted = async {
            match interrupt.as_mut() {
                Some(receiver) => {
                    let _ = receiver.await;
                }
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(interrupted);
        tokio::select! {
            _ = &mut interrupted => break Err("已中断".to_string()),
            message = ws.next() => {
                let Some(message) = message else { break Err("远程连接已关闭".to_string()) };
                let message = message.map_err(|e| e.to_string())?;
                match message {
                    Message::Text(text) => {
                        let value: Value = serde_json::from_str(&text)
                            .map_err(|e| format!("服务端返回非 JSON 消息: {e}"))?;
                        if value.get("event").is_some() {
                            let event = StreamEvent {
                                stderr: value.get("stream").and_then(Value::as_str) == Some("stderr"),
                                data: value
                                    .get("dataB64")
                                    .and_then(Value::as_str)
                                    .and_then(|s| {
                                        use base64::Engine;
                                        base64::engine::general_purpose::STANDARD
                                            .decode(s)
                                            .ok()
                                    })
                                    .unwrap_or_default(),
                            };
                            if let Some(sink) = on_event.as_mut() {
                                sink(event);
                            }
                            continue;
                        }
                        if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
                            let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
                            let message = error.get("message").and_then(Value::as_str).unwrap_or("");
                            break Err(rpc_error_text(code, message));
                        }
                        break Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                    Message::Close(_) => break Err("远程连接已关闭".to_string()),
                    _ => {}
                }
            }
        }
    };
    let _ = ws.close(None).await;
    result
}
