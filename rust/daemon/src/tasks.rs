use crate::{exec, rpc::RpcError};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

const MAX_TASKS: usize = 256;
static NEXT_EPHEMERAL_ID: AtomicU64 = AtomicU64::new(1);

struct Task {
    id: String,
    params: Value,
    cancel: watch::Sender<bool>,
    state: Mutex<TaskState>,
    notify: tokio::sync::Notify,
}

struct TaskState {
    status: &'static str,
    result: Option<Value>,
    error: Option<RpcErrorData>,
}

struct RpcErrorData {
    code: i32,
    message: String,
}

pub struct TaskManager {
    tasks: Mutex<HashMap<String, Arc<Task>>>,
}

impl TaskManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            tasks: Mutex::new(HashMap::new()),
        })
    }

    pub fn start(
        self: &Arc<Self>,
        id: String,
        params: Value,
        lifecycle: &Arc<crate::lifecycle::Lifecycle>,
    ) -> Result<Value, RpcError> {
        self.start_inner(id, params, lifecycle, true)
    }

    pub fn start_ephemeral(
        self: &Arc<Self>,
        params: Value,
        lifecycle: &Arc<crate::lifecycle::Lifecycle>,
    ) -> Result<String, RpcError> {
        let id = format!(
            "exec-{}-{}",
            std::process::id(),
            NEXT_EPHEMERAL_ID.fetch_add(1, Ordering::Relaxed)
        );
        self.start_inner(id.clone(), params, lifecycle, false)?;
        Ok(id)
    }

    fn start_inner(
        self: &Arc<Self>,
        id: String,
        params: Value,
        lifecycle: &Arc<crate::lifecycle::Lifecycle>,
        retain: bool,
    ) -> Result<Value, RpcError> {
        let command_params = without_task_id(&params);
        let guard = lifecycle
            .acquire("task")
            .ok_or_else(|| RpcError::new(-32020, "daemon 正在排空，不再接受新的任务"))?;
        let (task, mut cancel_rx) = {
            let mut tasks = self.tasks.lock().expect("task mutex");
            if let Some(existing) = tasks.get(&id) {
                if existing.params != command_params {
                    return Err(RpcError::new(-32041, "taskId 已存在，但请求参数不一致"));
                }
                return Ok(existing.snapshot());
            }
            if tasks.len() >= MAX_TASKS {
                return Err(RpcError::new(
                    -32042,
                    "任务数量已达上限，请查询或清理已有任务",
                ));
            }
            let (cancel, cancel_rx) = watch::channel(false);
            let task = Arc::new(Task {
                id: id.clone(),
                params: command_params,
                cancel,
                state: Mutex::new(TaskState {
                    status: "running",
                    result: None,
                    error: None,
                }),
                notify: tokio::sync::Notify::new(),
            });
            tasks.insert(id.clone(), task.clone());
            (task, cancel_rx)
        };

        let task_for_worker = task.clone();
        let manager_for_worker = self.clone();
        let task_id = id.clone();
        tokio::spawn(async move {
            let _guard = guard;
            let (out, _outputs) = mpsc::channel::<Message>(1);
            let request_id = Value::String(task_for_worker.id.clone());
            let result = exec::run(
                &task_for_worker.params,
                false,
                &request_id,
                &out,
                &mut cancel_rx,
            )
            .await;
            task_for_worker.finish(result);
            if !retain {
                manager_for_worker.remove(&task_id);
            }
        });
        Ok(task.snapshot())
    }

    pub async fn wait(&self, id: &str) -> Result<Value, RpcError> {
        let task = self
            .tasks
            .lock()
            .expect("task mutex")
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::new(-32040, "任务不存在或已被清理"))?;
        loop {
            let notified = task.notify.notified();
            let snapshot = task.snapshot();
            match snapshot.get("status").and_then(Value::as_str) {
                Some("completed") | Some("failed") => {
                    if let Some(error) = snapshot.get("error") {
                        return Err(RpcError::new(
                            error.get("code").and_then(Value::as_i64).unwrap_or(-32000) as i32,
                            error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("任务执行失败"),
                        ));
                    }
                    return Ok(snapshot.get("result").cloned().unwrap_or(Value::Null));
                }
                _ => notified.await,
            }
        }
    }

    pub fn status(&self, id: &str) -> Result<Value, RpcError> {
        self.tasks
            .lock()
            .expect("task mutex")
            .get(id)
            .map(|task| task.snapshot())
            .ok_or_else(|| RpcError::new(-32040, "任务不存在或已被清理"))
    }

    pub fn log(&self, id: &str) -> Result<Value, RpcError> {
        let status = self.status(id)?;
        let result = status.get("result").cloned().unwrap_or_else(|| json!({}));
        Ok(json!({
            "taskId": id,
            "status": status.get("status").cloned().unwrap_or(Value::Null),
            "stdoutB64": result.get("stdoutB64").cloned().unwrap_or_else(|| Value::from("")),
            "stderrB64": result.get("stderrB64").cloned().unwrap_or_else(|| Value::from("")),
            "truncated": result.get("truncated").cloned().unwrap_or(Value::from(false)),
        }))
    }

    pub fn cancel(&self, id: &str) -> Result<Value, RpcError> {
        let task = self
            .tasks
            .lock()
            .expect("task mutex")
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::new(-32040, "任务不存在或已被清理"))?;
        if task.snapshot().get("status").and_then(Value::as_str) == Some("running") {
            let _ = task.cancel.send(true);
        }
        Ok(task.snapshot())
    }

    pub fn forget(&self, id: &str) -> Result<Value, RpcError> {
        let mut tasks = self.tasks.lock().expect("task mutex");
        let task = tasks
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::new(-32040, "任务不存在或已被清理"))?;
        if task.snapshot().get("status").and_then(Value::as_str) == Some("running") {
            return Err(RpcError::new(-32043, "运行中的任务不能清理"));
        }
        tasks.remove(id);
        Ok(json!({"taskId": id, "forgotten": true}))
    }

    fn remove(&self, id: &str) {
        self.tasks.lock().expect("task mutex").remove(id);
    }
}

impl Task {
    fn finish(&self, result: Result<Value, RpcError>) {
        let mut state = self.state.lock().expect("task state mutex");
        match result {
            Ok(value) => {
                state.status = if value.get("exitCode").and_then(Value::as_i64) == Some(0) {
                    "completed"
                } else {
                    "failed"
                };
                state.result = Some(value);
            }
            Err(error) => {
                state.status = "failed";
                state.error = Some(RpcErrorData {
                    code: error.code,
                    message: error.message,
                });
            }
        }
        self.notify.notify_waiters();
    }

    fn snapshot(&self) -> Value {
        let state = self.state.lock().expect("task state mutex");
        let mut result = json!({"taskId": self.id, "status": state.status});
        if let Some(value) = &state.result {
            result["result"] = value.clone();
        }
        if let Some(error) = &state.error {
            result["error"] = json!({"code": error.code, "message": error.message});
        }
        result
    }
}

fn without_task_id(params: &Value) -> Value {
    let mut value = params.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("taskId");
    }
    value
}
