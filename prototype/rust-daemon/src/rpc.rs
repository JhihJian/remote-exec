use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

#[derive(Debug)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}
impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
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

pub async fn session<S>(ws: WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut input) = ws.split();
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
        let mut request_cancel = cancel.clone();
        let result = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            result = dispatch(&request, &params, &id, &out, &mut request_cancel) => result,
        };
        let response = match result {
            Ok(result) => json!({"id": id, "result": result}),
            Err(e) => json!({"id": id, "error": {"code": e.code, "message": e.message}}),
        };
        if send(&out, response).await.is_err() {
            break;
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

async fn dispatch(
    request: &Value,
    params: &Value,
    id: &Value,
    out: &mpsc::Sender<Message>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, RpcError> {
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(-32600, "请求需要 method 字段"))?;
    if !matches!(method, "exec" | "exec.stream" | "file.read" | "file.write") {
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
        _ => Err(RpcError::new(-32601, format!("未知方法: {method}"))),
    }
}
