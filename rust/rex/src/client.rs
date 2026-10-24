//! WSS 客户端：直连与经网关 relay（信封协议），与 Node lib/client.js 语义一致。
use crate::config::HostEntry;
use futures_util::{SinkExt, StreamExt};
use rustls_pki_types::ServerName;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    WebSocketStream, client_async_with_config,
    tungstenite::{
        Message, client::IntoClientRequest, handshake::client::Response, protocol::WebSocketConfig,
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
    // 共享信任策略：CA 首证书同时作为 pin（兼容 Node 布局自签叶子）与信任锚。
    let config = Arc::new(remote_exec_tls::pinned_or_ca_client_config(ca_pem)?);
    let name = servername.filter(|s| !s.is_empty()).unwrap_or(host);
    let server_name = ServerName::try_from(name.to_owned())
        .map_err(|e| format!("无效 servername \"{name}\": {e}"))?;
    let tcp = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("连接 {host}:{port} 超时"))??;
    let connector = tokio_rustls::TlsConnector::from(config);
    let tls = tokio::time::timeout(Duration::from_secs(15), connector.connect(server_name, tcp))
        .await
        .map_err(|_| format!("TLS 握手 {host}:{port} 超时"))??;
    Ok(tls)
}

/// 钉住单张叶子证书的验证器：仅当服务端出示的证书与预置证书逐字节一致时通过。
/// 用于部署验收——证书刚经 SSH root 通道取得，钉住即绑定信任，兼容自签叶子。
#[derive(Debug)]
struct PinnedVerifier {
    cert_der: Vec<u8>,
}

impl rustls::client::danger::ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() == self.cert_der.as_slice() {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::NotValidForName,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls_pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls_pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// 以钉住叶子证书建立 TLS 连接（不经 CA 验证）。cert_pem 必须恰好包含一张证书。
async fn connect_tls_pinned(
    host: &str,
    port: u16,
    servername: Option<&str>,
    cert_pem: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, AnyError> {
    let mut reader = std::io::BufReader::new(cert_pem.as_bytes());
    let mut certs = Vec::new();
    for cert in rustls_pemfile::certs(&mut reader) {
        certs.push(cert?);
    }
    if certs.len() != 1 {
        return Err("钉住验证需要恰好一张叶子证书".into());
    }
    let config = Arc::new(
        rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
                cert_der: certs.remove(0).to_vec(),
            }))
            .with_no_client_auth(),
    );
    let name = servername.filter(|s| !s.is_empty()).unwrap_or(host);
    let server_name = ServerName::try_from(name.to_owned())
        .map_err(|e| format!("无效 servername \"{name}\": {e}"))?;
    let tcp = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("连接 {host}:{port} 超时"))??;
    let connector = tokio_rustls::TlsConnector::from(config);
    let tls = tokio::time::timeout(Duration::from_secs(15), connector.connect(server_name, tcp))
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

/// 解码响应中 base64 字段（缺失或无效时为空）。
pub fn decode_b64(value: &Value, field: &str) -> Vec<u8> {
    use base64::Engine;
    value
        .get(field)
        .and_then(Value::as_str)
        .and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok())
        .unwrap_or_default()
}

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
    let (mut ws, _) = wss_handshake(tls, name_or(&gateway_entry), &gateway_token)
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

/// 独立任务调用：提交和查询使用同一个 taskId，连接断开时只重试 RPC，不取消远端进程。
pub async fn call_task_host(
    store: &crate::config::Store,
    host_name: &str,
    call: &Call,
    interrupt: &mut Interrupt,
) -> Result<Value, String> {
    let task_id = format!("{:032x}", rand::random::<u128>());
    let timeout_ms = call
        .params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(300_000);
    let deadline = std::time::Instant::now()
        .checked_add(Duration::from_millis(timeout_ms.saturating_add(30_000)))
        .ok_or_else(|| "任务超时时间溢出".to_string())?;
    let mut start_params = call.params.clone();
    start_params
        .as_object_mut()
        .ok_or_else(|| "独立任务参数必须是对象".to_string())?
        .insert("taskId".into(), Value::String(task_id.clone()));
    let mut started = false;
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(format!("任务状态无法确认，taskId={task_id}"));
        }
        let request = Call {
            method: if started { "exec.status" } else { "exec.start" }.into(),
            params: if started {
                json!({"taskId": task_id})
            } else {
                start_params.clone()
            },
        };
        let rpc = call_host(store, host_name, &request, None, interrupt);
        match tokio::time::timeout(Duration::from_secs(30), rpc).await {
            Ok(Ok(state)) => {
                started = true;
                match state.get("status").and_then(Value::as_str) {
                    Some("completed") | Some("failed") => {
                        if let Some(error) = state.get("error") {
                            return Err(format!(
                                "任务失败 rpc {}: {}",
                                error.get("code").and_then(Value::as_i64).unwrap_or(0),
                                error.get("message").and_then(Value::as_str).unwrap_or("")
                            ));
                        }
                        let result = state.get("result").cloned().unwrap_or(Value::Null);
                        let mut cleanup_interrupt = Interrupt(None);
                        let _ = call_host(
                            store,
                            host_name,
                            &Call {
                                method: "exec.forget".into(),
                                params: json!({"taskId": task_id}),
                            },
                            None,
                            &mut cleanup_interrupt,
                        )
                        .await;
                        return Ok(result);
                    }
                    Some("running") => {}
                    _ => return Err(format!("任务返回了未知状态: {state}")),
                }
            }
            Ok(Err(error))
                if !error.starts_with("rpc ") && std::time::Instant::now() < deadline => {}
            Ok(Err(error)) => return Err(error),
            Err(_) if std::time::Instant::now() < deadline => {}
            Err(_) => return Err(format!("任务 RPC 等待超时，taskId={task_id}")),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
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
    let ca_pem = std::fs::read_to_string(&entry.ca)
        .map_err(|e| format!("读取 CA 失败 {}: {e}", entry.ca))?;
    let tls = connect_tls(
        &entry.host,
        entry.port,
        entry.servername.as_deref(),
        &ca_pem,
    )
    .await
    .map_err(|e| e.to_string())?;
    let (mut ws, _) = wss_handshake(tls, name_or(entry), token)
        .await
        .map_err(|e| e.to_string())?;
    let request = json!({"id": 1, "method": call.method, "params": call.params});
    drive(&mut ws, request, on_event, interrupt).await
}

/// 部署验收专用：钉住刚安装的叶子证书直连调用，不经 CA 验证。
pub async fn call_entry_pinned(
    entry: &HostEntry,
    token: &str,
    cert_pem: &str,
    call: &Call,
) -> Result<Value, String> {
    let tls = connect_tls_pinned(
        &entry.host,
        entry.port,
        entry.servername.as_deref(),
        cert_pem,
    )
    .await
    .map_err(|e| e.to_string())?;
    let (mut ws, _) = wss_handshake(tls, name_or(entry), token)
        .await
        .map_err(|e| e.to_string())?;
    let request = json!({"id": 1, "method": call.method, "params": call.params});
    let mut interrupt = Interrupt(None);
    drive(&mut ws, request, None, &mut interrupt).await
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
