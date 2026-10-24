use crate::rpc::{RpcError, cancelled, send};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{mpsc, watch},
};
use tokio_tungstenite::tungstenite::Message;

// 同步 Drop 也会触发终止，保证连接任务被 abort 时子进程仍被回收。
struct ProcessGroup {
    pid: i32,
    done: std::sync::atomic::AtomicBool,
}
impl ProcessGroup {
    fn new(pid: i32) -> Self {
        Self {
            pid,
            done: std::sync::atomic::AtomicBool::new(false),
        }
    }
    // 子进程已自然退出时解除终止义务。
    fn disarm(&self) {
        self.done.store(true, std::sync::atomic::Ordering::Release);
    }
    // 与 Node 版一致：先 SIGTERM，2 秒后仍存活则 SIGKILL。
    fn terminate(&self) {
        if self.done.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        self.done.store(true, std::sync::atomic::Ordering::Release);
        // SAFETY: 负 PID 指向为该子进程创建的进程组。
        unsafe {
            libc::kill(-self.pid, libc::SIGTERM);
        }
        let pid = self.pid;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            // SAFETY: 同上。
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        });
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn drain_remaining<R: AsyncRead + Unpin>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
    count: &mut usize,
    cap: usize,
    truncated: &mut bool,
) -> Result<(), std::io::Error> {
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let size = reader.read(&mut chunk).await?;
        if size == 0 {
            return Ok(());
        }
        let room = cap.saturating_sub(*count);
        buffer.extend_from_slice(&chunk[..size.min(room)]);
        *count += size.min(room);
        *truncated |= size > room;
    }
}
async fn drain_stream_remaining<R: AsyncRead + Unpin>(
    reader: &mut R,
    stream: &str,
    id: &Value,
    out: &mpsc::Sender<Message>,
    count: &mut usize,
) -> Result<(), RpcError> {
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let size = reader.read(&mut chunk).await?;
        if size == 0 {
            return Ok(());
        }
        *count += size;
        send(
            out,
            json!({
                "id": id,
                "event": "output",
                "stream": stream,
                "dataB64": STANDARD.encode(&chunk[..size]),
            }),
        )
        .await?;
    }
}

fn positive(params: &Value, key: &str, default: u64) -> Result<u64, RpcError> {
    match params.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| RpcError::invalid(format!("{key} 必须是正整数"))),
    }
}

pub async fn run(
    params: &Value,
    streaming: bool,
    id: &Value,
    out: &mpsc::Sender<Message>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, RpcError> {
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && !s.contains('\0'))
        .ok_or_else(|| RpcError::invalid("params.command 必须是非空字符串"))?;
    let timeout = positive(params, "timeoutMs", 300_000)?;
    let cap = positive(params, "outputBytesCap", 1024 * 1024)?.min(crate::files::MAX_PAYLOAD as u64)
        as usize;
    let mut cmd = Command::new("bash");
    cmd.args(["-lc", command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    if params.get("cwd").is_some() {
        cmd.current_dir(crate::files::absolute(
            params.get("cwd").and_then(Value::as_str),
        )?);
    }
    let mut child = cmd.spawn()?;
    let group = ProcessGroup::new(
        child
            .id()
            .ok_or_else(|| RpcError::new(-32000, "缺少进程 PID"))? as i32,
    );
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let deadline = tokio::time::sleep(Duration::from_millis(timeout));
    tokio::pin!(deadline);
    let mut drain = Box::pin(tokio::time::sleep(Duration::from_secs(86400)));
    let mut buffers = [Vec::new(), Vec::new()];
    let mut counts = [0_usize; 2];
    let mut truncated = false;
    let mut eof = [false; 2];
    let mut status = None;
    let mut reason = "exited";
    let mut chunk_out = [0_u8; 16 * 1024];
    let mut chunk_err = [0_u8; 16 * 1024];
    loop {
        if status.is_some() && eof.iter().all(|v| *v) {
            break;
        }
        let (which, size) = tokio::select! {
            _ = cancelled(cancel) => { reason = "cancelled"; break; }
            _ = &mut deadline => { reason = "timeout"; break; }
            _ = &mut drain, if status.is_some() => break,
            result = child.wait(), if status.is_none() => {
                status = Some(result?);
                drain.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(500));
                continue;
            }
            result = stdout.read(&mut chunk_out), if !eof[0] => (0, result?),
            result = stderr.read(&mut chunk_err), if !eof[1] => (1, result?),
        };
        if size == 0 {
            eof[which] = true;
            continue;
        }
        let data = if which == 0 {
            &chunk_out[..size]
        } else {
            &chunk_err[..size]
        };
        if streaming {
            let event = json!({"id": id, "event": "output", "stream": if which == 0 { "stdout" } else { "stderr" }, "dataB64": STANDARD.encode(data)});
            tokio::select! {
                biased;
                _ = cancelled(cancel) => { reason = "cancelled"; break; }
                _ = &mut deadline => { reason = "timeout"; break; }
                result = send(out, event) => { result?; }
            }
            counts[which] += size;
        } else {
            let room = cap - buffers[which].len();
            buffers[which].extend_from_slice(&data[..size.min(room)]);
            truncated |= size > room;
        }
    }
    if reason != "exited" {
        group.terminate();
    }
    if status.is_none() {
        status = Some(child.wait().await?);
    }
    let mut drain_timed_out = false;
    if streaming {
        match tokio::time::timeout(
            Duration::from_millis(500),
            drain_stream_remaining(&mut stdout, "stdout", id, out, &mut counts[0]),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => drain_timed_out = true,
        }
        match tokio::time::timeout(
            Duration::from_millis(500),
            drain_stream_remaining(&mut stderr, "stderr", id, out, &mut counts[1]),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => drain_timed_out = true,
        }
    } else {
        match tokio::time::timeout(
            Duration::from_millis(500),
            drain_remaining(
                &mut stdout,
                &mut buffers[0],
                &mut counts[0],
                cap,
                &mut truncated,
            ),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => drain_timed_out = true,
        }
        match tokio::time::timeout(
            Duration::from_millis(500),
            drain_remaining(
                &mut stderr,
                &mut buffers[1],
                &mut counts[1],
                cap,
                &mut truncated,
            ),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => drain_timed_out = true,
        }
    }
    if drain_timed_out {
        truncated = true;
        group.terminate();
    } else {
        group.disarm();
    }
    drop(group);
    let code = match reason {
        "timeout" => 124,
        "cancelled" => 130,
        _ => status.and_then(|s| s.code()).unwrap_or(-1),
    };
    if streaming {
        Ok(
            json!({"exitCode": code, "reason": reason, "stdoutBytes": counts[0], "stderrBytes": counts[1]}),
        )
    } else {
        Ok(
            json!({"exitCode": code, "reason": reason, "stdoutB64": STANDARD.encode(&buffers[0]), "stderrB64": STANDARD.encode(&buffers[1]), "truncated": truncated}),
        )
    }
}

fn task_id(params: &Value) -> Result<String, RpcError> {
    params
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.chars().all(|c| c.is_ascii_graphic() && c != '"')
        })
        .map(ToOwned::to_owned)
        .ok_or_else(|| RpcError::invalid("taskId 必须是 1 至 128 个可打印 ASCII 字符"))
}

pub async fn start_task(
    params: &Value,
    manager: &std::sync::Arc<crate::tasks::TaskManager>,
    lifecycle: &std::sync::Arc<crate::lifecycle::Lifecycle>,
) -> Result<Value, RpcError> {
    let id = task_id(params)?;
    validate_task_params(params)?;
    manager.start(id, params.clone(), lifecycle)
}

fn validate_task_params(params: &Value) -> Result<(), RpcError> {
    params
        .get("command")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && !s.contains('\0'))
        .ok_or_else(|| RpcError::invalid("params.command 必须是非空字符串"))?;
    let _ = positive(params, "timeoutMs", 300_000)?;
    let _ = positive(params, "outputBytesCap", 1024 * 1024)?;
    Ok(())
}

pub async fn run_reliable(
    params: &Value,
    manager: &std::sync::Arc<crate::tasks::TaskManager>,
    lifecycle: &std::sync::Arc<crate::lifecycle::Lifecycle>,
) -> Result<Value, RpcError> {
    validate_task_params(params)?;
    let task_id = match params.get("taskId") {
        Some(_) => {
            let id = task_id(params)?;
            manager.start(id.clone(), params.clone(), lifecycle)?;
            id
        }
        None => manager.start_ephemeral(params.clone(), lifecycle)?,
    };
    manager.wait(&task_id).await
}

fn task_param(params: &Value) -> Result<String, RpcError> {
    params
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| RpcError::invalid("taskId 必须是非空字符串"))
}

pub fn task_status(
    params: &Value,
    manager: &std::sync::Arc<crate::tasks::TaskManager>,
) -> Result<Value, RpcError> {
    manager.status(&task_param(params)?)
}

pub fn task_log(
    params: &Value,
    manager: &std::sync::Arc<crate::tasks::TaskManager>,
) -> Result<Value, RpcError> {
    manager.log(&task_param(params)?)
}

pub fn cancel_task(
    params: &Value,
    manager: &std::sync::Arc<crate::tasks::TaskManager>,
) -> Result<Value, RpcError> {
    manager.cancel(&task_param(params)?)
}

pub fn forget_task(
    params: &Value,
    manager: &std::sync::Arc<crate::tasks::TaskManager>,
) -> Result<Value, RpcError> {
    manager.forget(&task_param(params)?)
}
