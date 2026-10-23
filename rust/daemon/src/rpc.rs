use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

#[derive(Debug)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    pub data: Option<Value>,
}
impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(-32602, message)
    }
    pub fn internal(error: crate::AnyError) -> Self {
        Self::new(-32000, error.to_string())
    }
}
impl From<std::io::Error> for RpcError {
    fn from(error: std::io::Error) -> Self {
        Self::new(-32000, error.to_string())
    }
}

pub async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let _ = cancel.changed().await;
}

pub async fn send(out: &mpsc::Sender<Message>, value: Value) -> Result<(), RpcError> {
    tokio::time::timeout(
        Duration::from_secs(30),
        out.send(Message::Text(value.to_string().into())),
    )
    .await
    .map_err(|_| RpcError::new(-32000, "输出发送超时"))?
    .map_err(|_| RpcError::new(-32000, "连接已关闭"))
}

pub async fn session<S>(
    ws: WebSocketStream<S>,
    relay_allow: Vec<String>,
    lifecycle: std::sync::Arc<crate::lifecycle::Lifecycle>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut input) = ws.split();
    let Some(_connection) = lifecycle.acquire("websocket") else {
        let _ = sink
            .send(Message::Close(Some(
                tokio_tungstenite::tungstenite::protocol::CloseFrame {
                    code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Again,
                    reason: "draining".into(),
                },
            )))
            .await;
        return;
    };
    let mut force = lifecycle.force_watcher();
    let (requests, mut queue) = mpsc::channel(1);
    let (out, mut outputs) = mpsc::channel(4);
    let (cancel_tx, mut cancel) = watch::channel(false);
    let mut tasks = tokio::task::JoinSet::new();
    let writer_cancel = cancel_tx.clone();
    tasks.spawn(async move {
        while let Some(msg) = outputs.recv().await {
            if !matches!(
                tokio::time::timeout(Duration::from_secs(30), sink.send(msg)).await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
        let _ = writer_cancel.send(true);
    });
    let pong = out.clone();
    tasks.spawn(async move {
        while let Some(Ok(msg)) = input.next().await {
            match msg {
                Message::Text(_) | Message::Binary(_) => {
                    // A full queue is closed instead of waiting, so EOF is always observed during exec.
                    if requests.try_send(msg).is_err() {
                        break;
                    }
                }
                Message::Ping(data) => {
                    if pong.try_send(Message::Pong(data)).is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = cancel_tx.send(true);
    });
    loop {
        let msg = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            _ = force.changed() => break, // 排空超时强制关闭
            msg = queue.recv() => match msg { Some(msg) => msg, None => break },
        };
        let request: Value = match serde_json::from_slice(&msg.into_data()) {
            Ok(value) => value,
            Err(_) => {
                if send(
                    &out,
                    json!({"id": null, "error": {"code": -32700, "message": "JSON 解析失败"}}),
                )
                .await
                .is_err()
                {
                    break;
                }
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let params = request.get("params").cloned().unwrap_or(json!({}));
        let Some(_rpc_guard) = lifecycle.acquire("rpc") else {
            let error = RpcError::new(-32020, "daemon 正在排空，不再接受新的 RPC");
            if send(&out, error_response(&id, &error)).await.is_err() {
                break;
            }
            continue;
        };
        let mut request_cancel = cancel.clone();
        let result = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            _ = force.changed() => break,
            result = dispatch(&request, &params, &id, &out, &mut request_cancel, &relay_allow) => result,
        };
        let response = match result {
            Ok(result) => json!({"id": id, "result": result}),
            Err(e) => error_response(&id, &e),
        };
        if send(&out, response).await.is_err() {
            break;
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

fn error_response(id: &Value, error: &RpcError) -> Value {
    let mut body = json!({"code": error.code, "message": error.message});
    if let Some(data) = &error.data {
        body["data"] = data.clone();
    }
    json!({"id": id, "error": body})
}

async fn dispatch(
    request: &Value,
    params: &Value,
    id: &Value,
    out: &mpsc::Sender<Message>,
    cancel: &mut watch::Receiver<bool>,
    relay_allow: &[String],
) -> Result<Value, RpcError> {
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(-32600, "请求需要 method 字段"))?;
    if !matches!(
        method,
        "exec" | "exec.stream" | "file.read" | "file.write" | "relay"
    ) {
        return Err(RpcError::new(-32601, format!("未知方法: {method}")));
    }
    if !params.is_object() {
        return Err(RpcError::invalid("params 必须是对象"));
    }
    match method {
        "exec" | "exec.stream" => {
            crate::exec::run(params, method == "exec.stream", id, out, cancel).await
        }
        "file.read" => crate::files::read(params).await,
        "file.write" => crate::files::write(params).await,
        "relay" => crate::relay::request(params, id, out, cancel, relay_allow).await,
        _ => Err(RpcError::new(-32601, format!("未知方法: {method}"))),
    }
}
