use crate::rpc::{RpcError, cancelled, send};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{mpsc, watch},
};
use tokio_tungstenite::tungstenite::Message;

// A synchronous guard also runs when the request/connection task is aborted.
struct ProcessGroup(i32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // SAFETY: negative PID addresses the process group created for this child.
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
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
    let group = ProcessGroup(
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
    drop(group);
    if status.is_none() {
        status = Some(child.wait().await?);
    }
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
            json!({"exitCode": code, "stdoutB64": STANDARD.encode(&buffers[0]), "stderrB64": STANDARD.encode(&buffers[1]), "truncated": truncated}),
        )
    }
}
