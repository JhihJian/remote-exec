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
use tokio_rustls::rustls::ClientConfig;
use tokio_tungstenite::{
    Connector, WebSocketStream, connect_async_tls_with_config,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};

const CONNECT_BUDGET: Duration = Duration::from_secs(10);
const DEFAULT_TIMEOUT: u64 = 5 * 60 * 1000;
const MAX_INNER_TIMEOUT: u64 = 10 * 60 * 1000;
const MAX_TASK_TIMEOUT: u64 = 24 * 60 * 60 * 1000;
const MAX_TOTAL_TIMEOUT: u64 = 15 * 60 * 1000;
const MAX_TASK_TOTAL_TIMEOUT: u64 = 24 * 60 * 60 * 1000;
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

pub(crate) fn build_tls(ca: &str) -> Result<Arc<ClientConfig>, RpcError> {
    remote_exec_tls::pinned_or_ca_client_config(ca)
        .map(Arc::new)
        .map_err(|e| error(-32012, e, "tls"))
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
    if !matches!(
        method,
        "exec"
            | "exec.stream"
            | "exec.start"
            | "exec.status"
            | "exec.log"
            | "exec.cancel"
            | "exec.forget"
            | "file.read"
            | "file.write"
    ) {
        return Err(error(
            -32015,
            "relay 仅支持 exec/exec.stream/exec.start/exec.status/exec.log/exec.cancel/exec.forget/file.read/file.write，禁止嵌套 relay",
            "validate",
        ));
    }
    let mut inner_params = params_object(request.get("params"))?;
    // 仅当调用方显式提供 timeoutMs 时才改写内层超时，并限制在上限内。
    let task_method = matches!(method, "exec" | "exec.start");
    let inner_limit = if task_method {
        MAX_TASK_TIMEOUT
    } else {
        MAX_INNER_TIMEOUT
    };
    let inner_budget = match inner_params.get("timeoutMs") {
        Some(value) => {
            let clamped = value.as_u64().unwrap_or(1).clamp(1, inner_limit);
            inner_params["timeoutMs"] = Value::from(clamped);
            clamped
        }
        None => DEFAULT_TIMEOUT,
    };
    // 外层 timeoutMs 可覆盖总超时，默认按连接预算 + 内层预算 + 余量推算。
    let total_limit = if task_method {
        MAX_TASK_TOTAL_TIMEOUT
    } else {
        MAX_TOTAL_TIMEOUT
    };
    let default_total = inner_budget
        .saturating_add(CONNECT_BUDGET.as_millis() as u64)
        .saturating_add(RELAY_SLACK)
        .min(total_limit);
    let total_timeout = outer
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(default_total)
        .min(total_limit);
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
