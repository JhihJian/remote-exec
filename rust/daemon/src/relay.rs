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

fn error(code: i32, message: impl Into<String>, stage: &str) -> RpcError {
    let mut err = RpcError::new(code, message);
    err.data = Some(json!({ "stage": stage }));
    err
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

pub(crate) fn target_allowed(ip: Ipv4Addr, allow_list: &[String]) -> bool {
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
        Some(_) => Err(error(-32015, "relay request.params 必须是对象", "validate")),
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
            let cert = webpki::EndEntityCert::try_from(end_entity)
                .map_err(|e| TlsError::General(format!("目标证书无效: {e}")))?;
            cert.verify_is_valid_for_subject_name(server_name)
                .map_err(|e| TlsError::General(format!("目标证书主机名不匹配: {e}")))?;
            // pin 分支同样校验有效期，避免过期证书因 pin 绕过时间约束。
            let (not_before, not_after) = certificate_validity(end_entity.as_ref())
                .ok_or_else(|| TlsError::General("目标证书有效期不可解析".to_string()))?;
            let now = now.as_secs();
            if now < not_before {
                return Err(TlsError::General("目标证书尚未生效".to_string()));
            }
            if now > not_after {
                return Err(TlsError::General("目标证书已过期".to_string()));
            }
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

pub(crate) fn build_tls(ca: &str) -> Result<Arc<ClientConfig>, RpcError> {
    if !ca.contains("BEGIN CERTIFICATE") {
        return Err(error(-32012, "auth.ca 必须是目标 CA 的 PEM 文本", "tls"));
    }
    let mut reader = std::io::BufReader::new(ca.as_bytes());
    let certs = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| error(-32012, format!("目标 CA PEM 无效: {e}"), "tls"))?;
    if certs.is_empty() {
        return Err(error(-32012, "目标 CA PEM 不包含证书", "tls"));
    }
    let certificate = certs
        .first()
        .ok_or_else(|| error(-32012, "目标 CA PEM 不包含证书", "tls"))?
        .clone();
    let mut roots = RootCertStore::empty();
    roots.roots.push(
        webpki::anchor_from_trusted_cert(&certificate)
            .map_err(|e| error(-32012, format!("目标 CA 无效: {e}"), "tls"))?
            .to_owned(),
    );
    let delegate = WebPkiServerVerifier::builder(Arc::new(roots.clone()))
        .build()
        .map_err(|e| error(-32012, format!("目标 CA 无效: {e}"), "tls"))?;
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
            error(-32013, "目标认证失败（token 不匹配）", "auth")
        }
        tokio_tungstenite::tungstenite::Error::Tls(_) => {
            error(-32012, format!("目标证书校验失败: {err}"), "tls")
        }
        tokio_tungstenite::tungstenite::Error::Io(io)
            if io.to_string().contains("certificate")
                || io.to_string().contains("证书")
                || io.to_string().contains("TLS")
                || io.to_string().contains("tls") =>
        {
            error(-32012, format!("目标证书校验失败: {err}"), "tls")
        }
        _ => error(-32011, format!("目标不可达: {err}"), "connect"),
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
        .map_err(|e| error(-32015, format!("relay 请求地址无效: {e}"), "validate"))?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| error(-32015, "auth.token 不是有效 header 值", "validate"))?,
    );
    let config = build_tls(ca)?;
    let connector = Connector::Rustls(config);
    tokio::time::timeout(
        CONNECT_BUDGET,
        connect_async_tls_with_config(request, None, false, Some(connector)),
    )
    .await
    .map_err(|_| error(-32011, "目标连接超时", "connect"))?
    .map_err(|e| classify_connect(&e))
}

struct RelayCall<'a> {
    outer: &'a Value,
    target: &'a Value,
    auth: &'a Value,
    request: &'a Value,
    id: &'a Value,
    out: &'a mpsc::Sender<Message>,
    cancel: &'a mut watch::Receiver<bool>,
    allow_list: &'a [String],
}

async fn run(call: RelayCall<'_>) -> Result<Value, RpcError> {
    let RelayCall {
        outer,
        target,
        auth,
        request,
        id,
        out,
        cancel,
        allow_list,
    } = call;
    let host = target
        .get("host")
        .and_then(Value::as_str)
        .ok_or_else(|| error(-32015, "target.host 必须是 IPv4 字面量", "validate"))?;
    let ip = ipv4(host).ok_or_else(|| {
        error(
            -32015,
            format!("target.host 必须是 IPv4 字面量: {host}"),
            "validate",
        )
    })?;
    if !target_allowed(ip, allow_list) {
        return Err(error(
            -32010,
            format!("目标 {host} 不在 relay 白名单内"),
            "allowlist",
        ));
    }
    let port = target
        .get("port")
        .and_then(Value::as_u64)
        .filter(|value| (1..=65535).contains(value))
        .ok_or_else(|| error(-32015, "target.port 必须是 1..65535 的整数", "validate"))?
        as u16;
    let token = auth
        .get("token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error(-32015, "auth.token 不能为空", "validate"))?;
    let ca = auth
        .get("ca")
        .and_then(Value::as_str)
        .ok_or_else(|| error(-32015, "auth.ca 必须是目标 CA 的 PEM 文本", "validate"))?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| error(-32015, "request.method 必须存在", "validate"))?;
    if !matches!(method, "exec" | "exec.stream" | "file.read" | "file.write") {
        return Err(error(
            -32015,
            "relay 仅支持 exec/exec.stream/file.read/file.write，禁止嵌套 relay",
            "validate",
        ));
    }
    let mut inner_params = params_object(request.get("params"))?;
    // 仅当调用方显式提供 timeoutMs 时才改写内层超时，并限制在上限内。
    let inner_budget = match inner_params.get("timeoutMs") {
        Some(value) => {
            let clamped = value.as_u64().unwrap_or(1).clamp(1, MAX_INNER_TIMEOUT);
            inner_params["timeoutMs"] = Value::from(clamped);
            clamped
        }
        None => DEFAULT_TIMEOUT,
    };
    // 外层 timeoutMs 可覆盖总超时，默认按连接预算 + 内层预算 + 余量推算。
    let default_total = inner_budget
        .saturating_add(CONNECT_BUDGET.as_millis() as u64)
        .saturating_add(RELAY_SLACK)
        .min(MAX_TOTAL_TIMEOUT);
    let total_timeout = outer
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(default_total)
        .min(MAX_TOTAL_TIMEOUT);
    let (mut ws, _) = connect(host, port, token, ca).await?;
    let message = json!({"id": 1, "method": method, "params": inner_params});
    ws.send(Message::Text(message.to_string().into()))
        .await
        .map_err(|e| error(-32011, format!("目标发送失败: {e}"), "connect"))?;
    let result = tokio::time::timeout(Duration::from_millis(total_timeout), async {
        loop {
            tokio::select! {
                _ = cancelled(cancel) => return Err(error(-32014, format!("上游客户端断开: {host}:{port}"), "aborted")),
                message = ws.next() => {
                    let Some(message) = message else { return Err(error(-32011, "目标连接提前关闭", "connect")); };
                    let message = message.map_err(|e| error(-32011, format!("目标连接失败: {e}"), "connect"))?;
                    match message {
                        Message::Ping(data) => {
                            ws.send(Message::Pong(data)).await.map_err(|e| error(-32011, format!("目标连接失败: {e}"), "connect"))?;
                        }
                        Message::Text(text) => {
                            let value: Value = serde_json::from_str(&text).map_err(|_| error(-32015, "目标返回非 JSON 响应", "validate"))?;
                            if value.get("id") != Some(&Value::from(1)) { return Err(error(-32015, "目标响应 id 不匹配", "validate")); }
                            if value.get("event").is_some() {
                                if method != "exec.stream" || value.get("event").and_then(Value::as_str) != Some("output") || !matches!(value.get("stream").and_then(Value::as_str), Some("stdout") | Some("stderr")) || value.get("dataB64").and_then(Value::as_str).is_none() {
                                    return Err(error(-32015, "目标发送了无效流式事件", "validate"));
                                }
                                let mut event = value;
                                event["id"] = id.clone();
                                send(out, event).await?;
                            } else {
                                return Ok(json!({"relayed": true, "result": value.get("result").cloned().unwrap_or(Value::Null), "error": value.get("error").cloned().unwrap_or(Value::Null)}));
                            }
                        }
                        Message::Binary(data) => {
                            let value: Value = serde_json::from_slice(&data).map_err(|_| error(-32015, "目标返回非 JSON 响应", "validate"))?;
                            return Ok(json!({"relayed": true, "result": value.get("result").cloned().unwrap_or(Value::Null), "error": value.get("error").cloned().unwrap_or(Value::Null)}));
                        }
                        Message::Close(_) => return Err(error(-32011, "目标连接提前关闭", "connect")),
                        _ => {}
                    }
                }
            }
        }
    }).await.map_err(|_| error(-32014, format!("relay 总超时（{total_timeout}ms）: {host}:{port}"), "deadline"))?;
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
        .ok_or_else(|| error(-32015, "缺少 target", "validate"))?;
    let auth = params
        .get("auth")
        .ok_or_else(|| error(-32015, "缺少 auth", "validate"))?;
    let request = params
        .get("request")
        .ok_or_else(|| error(-32015, "缺少 request", "validate"))?;
    let current = ACTIVE.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        (value < MAX_CONCURRENT).then_some(value + 1)
    });
    if current.is_err() {
        return Err(error(-32015, "relay 并发已达上限，请稍后重试", "validate"));
    }
    let _guard = RelayGuard;
    run(RelayCall {
        outer: params,
        target,
        auth,
        request,
        id,
        out,
        cancel,
        allow_list,
    })
    .await
}

// ---- 证书有效期解析（仅用于 pin 分支补齐 WebPKI 不覆盖的时间校验） ----

/// 读取一个 DER TLV，返回 (tag, 内容, 含头总长度)。
fn der_split(input: &[u8]) -> Option<(u8, &[u8], usize)> {
    let (&tag, rest) = input.split_first()?;
    let (&len_byte, rest) = rest.split_first()?;
    let (content_len, body_start) = if len_byte & 0x80 == 0 {
        (len_byte as usize, 0)
    } else {
        let n = (len_byte & 0x7f) as usize;
        if n == 0 || n > 4 || rest.len() < n {
            return None;
        }
        let mut v = 0_usize;
        for &b in &rest[..n] {
            v = (v << 8) | b as usize;
        }
        (v, n)
    };
    let content = rest.get(body_start..body_start + content_len)?;
    Some((tag, content, 2 + body_start + content_len))
}

/// UTCTime(YYMMDDHHMMSSZ) / GeneralizedTime(YYYYMMDDHHMMSSZ) 转为 Unix 秒。
fn asn1_time(tag: u8, body: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(body).ok()?;
    let (year, rest) = if tag == 0x17 {
        let y: i64 = text.get(0..2)?.parse().ok()?;
        ((if y >= 50 { 1900 + y } else { 2000 + y }), &text[2..])
    } else if tag == 0x18 {
        (text.get(0..4)?.parse().ok()?, &text[4..])
    } else {
        return None;
    };
    if rest.as_bytes().last() != Some(&b'Z') || rest.len() < 11 {
        return None;
    }
    let two = |range: std::ops::Range<usize>| -> Option<i64> { rest.get(range)?.parse().ok() };
    let month = two(0..2)?;
    let day = two(2..4)?;
    let hour = two(4..6)?;
    let minute = two(6..8)?;
    let second = two(8..10)?;
    // Howard Hinnant 的 civil 日期算法。
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) as u64)
}

/// 从 DER 证书中提取 Validity 的 (not_before, not_after) Unix 秒。
fn certificate_validity(cert: &[u8]) -> Option<(u64, u64)> {
    let body = match der_split(cert) {
        Some((0x30, body, _)) => body,
        _ => return None,
    };
    // tbsCertificate 是证书 SEQUENCE 的第一个子元素，Validity 位于其内部。
    let tbs = match der_split(body) {
        Some((0x30, tbs, _)) => tbs,
        _ => return None,
    };
    let mut rest = tbs;
    while !rest.is_empty() {
        let (tag, child, consumed) = der_split(rest)?;
        rest = &rest[consumed..];
        // Validity 是唯一由两个 Time 组成的 SEQUENCE。
        if tag == 0x30 {
            let Some((time_tag, first, used)) = der_split(child) else {
                continue;
            };
            if matches!(time_tag, 0x17 | 0x18) {
                let Some((_, tail, tail_used)) = der_split(&child[used..]) else {
                    continue;
                };
                if tail_used == child.len() - used {
                    return Some((asn1_time(time_tag, first)?, asn1_time(time_tag, tail)?));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_builtin_certificate_validity() {
        // 用当前进程可访问的任一 PEM 不现实；改为构造最小 DER 结构验证解析器。
        let time = |body: &[u8]| vec![body.to_vec()];
        let _ = time;
        let utctime = b"250101000000Z";
        let mut seq = Vec::new();
        seq.push(0x17);
        seq.extend_from_slice(&(13usize as u16).to_be_bytes()[1..]);
        seq.extend_from_slice(utctime);
        let _ = seq;
        // 直接验证 asn1_time。
        assert_eq!(asn1_time(0x17, utctime), Some(1_735_689_600));
        assert_eq!(asn1_time(0x18, b"19700101000000Z"), Some(0));
        // 用 openssl 生成的真实证书验证 Validity 提取。
        let dir = std::env::temp_dir().join(format!("relay-validity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert_path = dir.join("cert.pem");
        let status = std::process::Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-keyout",
                dir.join("key.pem").to_str().unwrap(),
                "-out",
                cert_path.to_str().unwrap(),
                "-subj",
                "/CN=localhost",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if let Ok(status) = status
            && status.success()
        {
            let pem = std::fs::read_to_string(&cert_path).unwrap();
            let base64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
            use base64::Engine;
            let der = base64::engine::general_purpose::STANDARD
                .decode(base64)
                .unwrap();
            let (not_before, not_after) =
                certificate_validity(&der).expect("openssl 证书应可解析有效期");
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            assert!(now >= not_before);
            assert!(now <= not_after + 60);
            assert!(not_after - not_before <= 90_000);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
