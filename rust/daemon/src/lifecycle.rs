use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

const STARTING: u8 = 0;
const READY: u8 = 1;
const DRAINING: u8 = 2;

pub const DEFAULT_DRAIN_TIMEOUT_MS: u64 = 15 * 60 * 1000;

/// 服务生命周期：starting → ready → draining → stopped。
/// draining 期间不再接受新连接、新 RPC 和新文件传输，既有请求继续完成。
pub struct Lifecycle {
    state: AtomicU8,
    active: Mutex<Vec<(&'static str, u64)>>,
    idle: Notify,
    force_generation: tokio::sync::watch::Sender<u64>,
    drain_timeout: Duration,
}

impl Lifecycle {
    pub fn new(drain_timeout_ms: u64) -> Arc<Self> {
        let (force_generation, _) = tokio::sync::watch::channel(0);
        Arc::new(Self {
            state: AtomicU8::new(STARTING),
            active: Mutex::new(Vec::new()),
            idle: Notify::new(),
            force_generation,
            drain_timeout: Duration::from_millis(drain_timeout_ms.max(1)),
        })
    }

    pub fn accepting(&self) -> bool {
        self.state.load(Ordering::Acquire) == READY
    }

    pub fn mark_ready(&self) {
        self.state
            .compare_exchange(STARTING, READY, Ordering::AcqRel, Ordering::Acquire)
            .ok();
    }

    /// 排空期强制关闭既有连接的信号通道；代数递增表示触发一次强制关闭。
    pub fn force_watcher(&self) -> tokio::sync::watch::Receiver<u64> {
        self.force_generation.subscribe()
    }

    /// 登记一个活跃资源；排空期返回 None 表示不再接受。
    pub fn acquire(self: &Arc<Self>, kind: &'static str) -> Option<Guard> {
        if !self.accepting() {
            return None;
        }
        {
            let mut active = self.active.lock().expect("lifecycle mutex");
            match active.iter_mut().find(|(k, _)| *k == kind) {
                Some((_, count)) => *count += 1,
                None => active.push((kind, 1)),
            }
        }
        Some(Guard {
            lifecycle: self.clone(),
            kind,
        })
    }

    /// 开始排空。返回的任务在活跃资源清零或超时后完成；
    /// 超时通过递增 force 通道代数强制关闭既有连接。
    pub fn begin_drain(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let lifecycle = self.clone();
        let timeout = self.drain_timeout;
        tokio::spawn(async move {
            lifecycle.state.fetch_max(DRAINING, Ordering::AcqRel);
            let forced = tokio::time::sleep(timeout);
            tokio::pin!(forced);
            loop {
                if lifecycle.active.lock().expect("lifecycle mutex").is_empty() {
                    return;
                }
                tokio::select! {
                    _ = &mut forced => {
                        // 注意：不能把 borrow() 放进 send 的参数里，
                        // 否则读锁未释放就要拿写锁，单线程 runtime 会自死锁。
                        let next = lifecycle.force_generation.borrow().wrapping_add(1);
                        let _ = lifecycle.force_generation.send(next);
                        return;
                    }
                    _ = lifecycle.idle.notified() => {}
                }
            }
        })
    }
}

pub struct Guard {
    lifecycle: Arc<Lifecycle>,
    kind: &'static str,
}
impl Guard {
    fn release(&self) {
        let mut active = self.lifecycle.active.lock().expect("lifecycle mutex");
        if let Some(index) = active.iter().position(|(k, _)| *k == self.kind) {
            if active[index].1 > 1 {
                active[index].1 -= 1;
            } else {
                active.remove(index);
            }
        }
        drop(active);
        // notify_one 会保留许可，即使任务尚未进入等待也不会错过唤醒。
        self.lifecycle.idle.notify_one();
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.release();
    }
}
