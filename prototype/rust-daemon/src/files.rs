use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MAX_PAYLOAD: usize = 64 * 1024 * 1024;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

pub struct Temporary {
    path: PathBuf,
    committed: bool,
}
impl Temporary {
    pub async fn create(target: &Path) -> Result<(Self, tokio::fs::File), crate::AnyError> {
        let parent = target.parent().ok_or("缺少父目录")?;
        tokio::fs::create_dir_all(parent).await?;
        for _ in 0..32 {
            let path = parent.join(format!(
                ".remote-exec-tmp-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            // Keep creation and guard construction together, with no cancellation point.
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o644)
                .open(&path)
            {
                Ok(file) => {
                    return Ok((
                        Self {
                            path,
                            committed: false,
                        },
                        tokio::fs::File::from_std(file),
                    ));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        Err("无法创建上传临时文件".into())
    }
    pub async fn commit(mut self, target: &Path) -> Result<(), crate::AnyError> {
        tokio::fs::rename(&self.path, target).await?;
        self.committed = true;
        Ok(())
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub fn absolute(value: Option<&str>) -> Result<&Path, crate::rpc::RpcError> {
    let file = value.ok_or_else(|| crate::rpc::RpcError::invalid("file/path 必须是绝对路径"))?;
    if !Path::new(file).is_absolute() || file.as_bytes().contains(&0) {
        return Err(crate::rpc::RpcError::invalid("file/path 必须是绝对路径"));
    }
    Ok(Path::new(file))
}

pub async fn open_regular(path: &Path) -> Result<tokio::fs::File, crate::AnyError> {
    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .await?;
    if !file.metadata().await?.is_file() {
        return Err("不是常规文件".into());
    }
    Ok(file)
}

pub async fn read(params: &Value) -> Result<Value, crate::rpc::RpcError> {
    let path = absolute(params.get("file").and_then(Value::as_str))?;
    let file = open_regular(path)
        .await
        .map_err(|e| crate::rpc::RpcError::new(-32603, e.to_string()))?;
    if file.metadata().await?.len() > MAX_PAYLOAD as u64 {
        return Err(crate::rpc::RpcError::invalid(
            "文件超过 64MB，请使用 /download",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_PAYLOAD as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > MAX_PAYLOAD {
        return Err(crate::rpc::RpcError::invalid("文件超过 64MB"));
    }
    Ok(json!({"contentB64": STANDARD.encode(&bytes), "size": bytes.len()}))
}

pub async fn write(params: &Value) -> Result<Value, crate::rpc::RpcError> {
    let path = absolute(params.get("file").and_then(Value::as_str))?;
    let input = params
        .get("contentB64")
        .and_then(Value::as_str)
        .ok_or_else(|| crate::rpc::RpcError::invalid("contentB64 必须是 base64 字符串"))?;
    if input.len() > MAX_PAYLOAD.div_ceil(3) * 4 {
        return Err(crate::rpc::RpcError::invalid(
            "文件超过 64MB，请使用 /upload",
        ));
    }
    let bytes = STANDARD
        .decode(input)
        .map_err(|_| crate::rpc::RpcError::invalid("无效 base64"))?;
    if bytes.len() > MAX_PAYLOAD {
        return Err(crate::rpc::RpcError::invalid(
            "文件超过 64MB，请使用 /upload",
        ));
    }
    let (temp, mut file) = Temporary::create(path)
        .await
        .map_err(crate::rpc::RpcError::internal)?;
    file.write_all(&bytes).await?;
    file.flush().await?;
    drop(file);
    temp.commit(path)
        .await
        .map_err(crate::rpc::RpcError::internal)?;
    Ok(json!({"size": bytes.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn temporary_drop_removes_uncommitted_file() {
        let target =
            std::env::temp_dir().join(format!("rust-prototype-test-{}", std::process::id()));
        let (temp, file) = Temporary::create(&target).await.unwrap();
        let path = temp.path.clone();
        assert!(path.exists());
        drop(file);
        drop(temp);
        assert!(!path.exists());
        assert!(!target.exists());
    }
}
