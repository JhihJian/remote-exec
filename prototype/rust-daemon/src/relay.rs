use crate::rpc::{RpcError, cancelled, send};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    net::Ipv4Addr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio_rustls::rustls::{
    ClientConfig, DigitallySignedStruct, Error as TlsError, RootCertStore, SignatureScheme,
    client::WebPkiServerVerifier,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use tokio_tungstenite::{
    Connector, WebSocketStream, connect_async_tls_with_config,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};

const CONNECT_BUDGET: Duration = Duration::from_secs(10);
const DEFAULT_TIMEOUT: u64 = 5 * 60 * 1000;
const MAX_INNER_TIMEOUT: u64 = 10 * 60 * 1000;
const MAX_TOTAL_TIMEOUT: u64 = 15 * 60 * 1000;
const RELAY_SLACK: u64 = 15 * 1000;
const MAX_CONCURRENT: usize = 8;
const DEFAULT_ALLOW: [&str; 4] = [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
];
static ACTIVE: AtomicUsize = AtomicUsize::new(0);

struct RelayGuard;
impl Drop for RelayGuard {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

fn error(code: i32, message: impl Into<String>) -> RpcError {
    RpcError::new(code, message)
}

fn ipv4(value: &str) -> Option<Ipv4Addr> {
    value.parse().ok()
}

fn allowed(ip: Ipv4Addr, cidr: &str) -> bool {
    let (base, prefix) = cidr.split_once('/').map_or((cidr, 32), |(base, prefix)| {
        (base, prefix.parse::<u32>().unwrap_or(33))
    });
    let Some(base) = ipv4(base) else {
        return false;
    };
    if prefix > 32 {
        return false;
    }
    let ip = u32::from(ip);
    let base = u32::from(base);
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    ip & mask == base & mask
}

fn target_allowed(ip: Ipv4Addr, allow_list: &[String]) -> bool {
    if allow_list.is_empty() {
        DEFAULT_ALLOW.iter().any(|cidr| allowed(ip, cidr))
    } else {
        allow_list.iter().any(|cidr| allowed(ip, cidr))
    }
}

fn params_object(value: Option<&Value>) -> Result<Value, RpcError> {
    match value {
        None => Ok(json!({})),
        Some(value) if value.is_object() => Ok(value.clone()),
        Some(_) => Err(error(-32015, "relay request.params 必须是对象")),
    }
}

#[derive(Debug)]
struct PinnedCertificateVerifier {
    certificate: Vec<u8>,
    delegate: Arc<WebPkiServerVerifier>,
}

impl ServerCertVerifier for PinnedCertificateVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        if end_entity.as_ref() == self.certificate.as_slice() {
            webpki::EndEntityCert::try_from(end_entity)
                .map_err(|e| TlsError::General(format!("目标证书无效: {e}")))?
                .verify_is_valid_for_subject_name(server_name)
                .map_err(|e| TlsError::General(format!("目标证书主机名不匹配: {e}")))?;
            return Ok(ServerCertVerified::assertion());
        }
        self.delegate.verify_server_cert(
            end_entity,
            _intermediates,
            server_name,
            ocsp_response,
            now,
        )
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.delegate.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.delegate.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.delegate.supported_verify_schemes()
    }
}

fn build_tls(ca: &str) -> Result<Arc<ClientConfig>, RpcError> {
    if !ca.contains("BEGIN CERTIFICATE") {
        return Err(error(-32015, "auth.ca 必须是目标 CA 的 PEM 文本"));
    }
    let mut reader = std::io::BufReader::new(ca.as_bytes());
    let certs = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| error(-32015, format!("目标 CA PEM 无效: {e}")))?;
    if certs.is_empty() {
        return Err(error(-32015, "目标 CA PEM 不包含证书"));
    }
    let certificate = certs
        .first()
        .ok_or_else(|| error(-32015, "目标 CA PEM 不包含证书"))?
        .clone();
    let mut roots = RootCertStore::empty();
    roots.roots.push(
        webpki::anchor_from_trusted_cert(&certificate)
            .map_err(|e| error(-32015, format!("目标 CA 无效: {e}")))?
            .to_owned(),
    );
    let delegate = WebPkiServerVerifier::builder(Arc::new(roots.clone()))
        .build()
        .map_err(|e| error(-32015, format!("目标 CA 无效: {e}")))?;
    let verifier = PinnedCertificateVerifier {
        certificate: certificate.as_ref().to_vec(),
        delegate,
    };
    Ok(Arc::new(
        ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth(),
    ))
}

fn classify_connect(err: &tokio_tungstenite::tungstenite::Error) -> RpcError {
    match err {
        tokio_tungstenite::tungstenite::Error::Http(response)
            if response.status().as_u16() == 401 =>
        {
            error(-32013, "目标认证失败（token 不匹配）")
        }
        tokio_tungstenite::tungstenite::Error::Tls(_) => {
            error(-32012, format!("目标证书校验失败: {err}"))
        }
        _ => error(-32011, format!("目标不可达: {err}")),
    }
}

async fn connect(
    host: &str,
    port: u16,
    token: &str,
    ca: &str,
) -> Result<
    (
        WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        tokio_tungstenite::tungstenite::http::Response<Option<Vec<u8>>>,
    ),
    RpcError,
> {
    let mut request = format!("wss://{host}:{port}/")
        .into_client_request()
        .map_err(|e| error(-32015, format!("relay 请求地址无效: {e}")))?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| error(-32015, "auth.token 不是有效 header 值"))?,
    );
    let config = build_tls(ca)?;
    let connector = Connector::Rustls(config);
    tokio::time::timeout(
        CONNECT_BUDGET,
        connect_async_tls_with_config(request, None, false, Some(connector)),
    )
    .await
    .map_err(|_| error(-32011, "目标连接超时"))?
    .map_err(|e| classify_connect(&e))
}

async fn run(
    target: &Value,
    auth: &Value,
    request: &Value,
    id: &Value,
    out: &mpsc::Sender<Message>,
    cancel: &mut watch::Receiver<bool>,
    allow_list: &[String],
) -> Result<Value, RpcError> {
    let host = target
        .get("host")
        .and_then(Value::as_str)
        .ok_or_else(|| error(-32015, "target.host 必须是 IPv4 字面量"))?;
    let ip = ipv4(host)
        .ok_or_else(|| error(-32015, format!("target.host 必须是 IPv4 字面量: {host}")))?;
    if !target_allowed(ip, allow_list) {
        return Err(error(-32010, format!("目标 {host} 不在 relay 白名单内")));
    }
    let port = target
        .get("port")
        .and_then(Value::as_u64)
        .filter(|value| (1..=65535).contains(value))
        .ok_or_else(|| error(-32015, "target.port 必须是 1..65535 的整数"))? as u16;
    let token = auth
        .get("token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error(-32015, "auth.token 不能为空"))?;
    let ca = auth
        .get("ca")
        .and_then(Value::as_str)
        .ok_or_else(|| error(-32015, "auth.ca 必须是目标 CA 的 PEM 文本"))?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| error(-32015, "request.method 必须存在"))?;
    if !matches!(method, "exec" | "exec.stream" | "file.read" | "file.write") {
        return Err(error(
            -32015,
            "relay 仅支持 exec/exec.stream/file.read/file.write，禁止嵌套 relay",
        ));
    }
    let inner_params = params_object(request.get("params"))?;
    let inner_timeout = inner_params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT)
        .clamp(1, MAX_INNER_TIMEOUT);
    let mut inner_params = inner_params;
    if inner_params.is_object() {
        inner_params["timeoutMs"] = Value::from(inner_timeout);
    }
    let total_timeout = inner_timeout
        .saturating_add(CONNECT_BUDGET.as_millis() as u64)
        .saturating_add(RELAY_SLACK)
        .min(MAX_TOTAL_TIMEOUT);
    let (mut ws, _) = connect(host, port, token, ca).await?;
    let message = json!({"id": 1, "method": method, "params": inner_params});
    ws.send(Message::Text(message.to_string().into()))
        .await
        .map_err(|e| error(-32011, format!("目标发送失败: {e}")))?;
    let result = tokio::time::timeout(Duration::from_millis(total_timeout), async {
        loop {
            tokio::select! {
                _ = cancelled(cancel) => return Err(error(-32014, format!("上游客户端断开: {host}:{port}"))),
                message = ws.next() => {
                    let Some(message) = message else { return Err(error(-32011, "目标连接提前关闭")); };
                    let message = message.map_err(|e| error(-32011, format!("目标连接失败: {e}")))?;
                    match message {
                        Message::Ping(data) => {
                            ws.send(Message::Pong(data)).await.map_err(|e| error(-32011, format!("目标连接失败: {e}")))?;
                        }
                        Message::Text(text) => {
                            let value: Value = serde_json::from_str(&text).map_err(|_| error(-32015, "目标返回非 JSON 响应"))?;
                            if value.get("id") != Some(&Value::from(1)) { return Err(error(-32015, "目标响应 id 不匹配")); }
                            if value.get("event").is_some() {
                                if method != "exec.stream" || value.get("event").and_then(Value::as_str) != Some("output") || !matches!(value.get("stream").and_then(Value::as_str), Some("stdout") | Some("stderr")) || value.get("dataB64").and_then(Value::as_str).is_none() {
                                    return Err(error(-32015, "目标发送了无效流式事件"));
                                }
                                let mut event = value;
                                event["id"] = id.clone();
                                send(out, event).await?;
                            } else {
                                return Ok(json!({"relayed": true, "result": value.get("result").cloned().unwrap_or(Value::Null), "error": value.get("error").cloned().unwrap_or(Value::Null)}));
                            }
                        }
                        Message::Binary(data) => {
                            let value: Value = serde_json::from_slice(&data).map_err(|_| error(-32015, "目标返回非 JSON 响应"))?;
                            return Ok(json!({"relayed": true, "result": value.get("result").cloned().unwrap_or(Value::Null), "error": value.get("error").cloned().unwrap_or(Value::Null)}));
                        }
                        Message::Close(_) => return Err(error(-32011, "目标连接提前关闭")),
                        _ => {}
                    }
                }
            }
        }
    }).await.map_err(|_| error(-32014, format!("relay 总超时（{total_timeout}ms）: {host}:{port}")))?;
    let _ = ws.close(None).await;
    result
}

pub async fn request(
    params: &Value,
    id: &Value,
    out: &mpsc::Sender<Message>,
    cancel: &mut watch::Receiver<bool>,
    allow_list: &[String],
) -> Result<Value, RpcError> {
    let target = params
        .get("target")
        .ok_or_else(|| error(-32015, "缺少 target"))?;
    let auth = params
        .get("auth")
        .ok_or_else(|| error(-32015, "缺少 auth"))?;
    let request = params
        .get("request")
        .ok_or_else(|| error(-32015, "缺少 request"))?;
    let current = ACTIVE.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        (value < MAX_CONCURRENT).then_some(value + 1)
    });
    if current.is_err() {
        return Err(error(-32015, "relay 并发已达上限，请稍后重试"));
    }
    let _guard = RelayGuard;
    run(target, auth, request, id, out, cancel, allow_list).await
}
