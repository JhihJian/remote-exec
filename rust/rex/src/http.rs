//! HTTP 流式上传/下载，走 daemon 的 /upload /download；经单跳网关下载走 /relay-download。
use crate::config::HostEntry;
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

fn client(_entry: &HostEntry, ca_pem: &str) -> Result<reqwest::Client, String> {
    let certificate = reqwest::Certificate::from_pem(ca_pem.as_bytes())
        .map_err(|e| format!("CA PEM 无效: {e}"))?;
    reqwest::Client::builder()
        .add_root_certificate(certificate)
        .timeout(std::time::Duration::from_secs(1800))
        .connect_timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

fn base_url(entry: &HostEntry) -> String {
    let name = entry.servername.as_deref().unwrap_or(&entry.host);
    format!("https://{name}:{}/", entry.port)
}

pub struct Transfer {
    pub size: u64,
    pub sha256: String,
}

/// 上传本地文件到远端绝对路径（流式请求体）。
pub async fn upload(
    entry: &HostEntry,
    ca_pem: &str,
    token: &str,
    local: &Path,
    remote: &str,
) -> Result<Transfer, String> {
    let file = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("打开本地文件失败: {e}"))?;
    let size = file.metadata().await.map_err(|e| e.to_string())?.len();
    let client = client(entry, ca_pem)?;
    let url = format!(
        "{base}upload?path={}",
        urlencode(remote),
        base = base_url(entry)
    );
    let body = reqwest::Body::wrap_stream(ReaderStream::with_capacity(file, 64 * 1024));
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Length", size)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("上传失败: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP 失败: {status} {text}"));
    }
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("响应非 JSON: {e}"))?;
    Ok(Transfer {
        size: value.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
        sha256: value
            .get("sha256")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned(),
    })
}

/// 下载远端绝对路径到本地文件（流式写盘并计算哈希）。
pub async fn download(
    entry: &HostEntry,
    ca_pem: &str,
    token: &str,
    remote: &str,
    local: &Path,
) -> Result<Transfer, String> {
    let client = client(entry, ca_pem)?;
    let url = format!(
        "{base}download?path={}",
        urlencode(remote),
        base = base_url(entry)
    );
    let response = client
        .get(url.clone())
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    if std::env::var("REX_DEBUG").is_ok() {
        eprintln!("[rex] GET {} → {}", response.url(), response.status());
    }
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP 失败: {status} {text}"));
    }
    write_response(response, local).await
}

/// 经单跳网关下载目标 daemon 的文件，网关只代理字节流，不落盘。
pub async fn download_via(
    gateway: &HostEntry,
    gateway_ca_pem: &str,
    gateway_token: &str,
    target: &HostEntry,
    target_ca_pem: &str,
    target_token: &str,
    remote: &str,
    local: &Path,
) -> Result<Transfer, String> {
    let client = client(gateway, gateway_ca_pem)?;
    let body = json!({
        "target": { "host": target.host, "port": target.port, "servername": target.servername.as_deref().unwrap_or(&target.host) },
        "auth": { "token": target_token, "ca": target_ca_pem },
        "file": remote,
    });
    let response = client
        .post(format!("{}relay-download", base_url(gateway)))
        .header("Authorization", format!("Bearer {gateway_token}"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("经网关下载失败: {e}"))?;
    if std::env::var("REX_DEBUG").is_ok() {
        eprintln!("[rex] POST relay-download → {}", response.status());
    }
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP 失败: {status} {text}"));
    }
    write_response(response, local).await
}

async fn write_response(response: reqwest::Response, local: &Path) -> Result<Transfer, String> {
    let temp = temp_sibling(local);
    let mut file = tokio::fs::File::create(&temp)
        .await
        .map_err(|e| format!("创建本地文件失败: {e}"))?;
    let mut hash = Sha256::new();
    let mut size: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        hash.update(&chunk);
        size += chunk.len() as u64;
    }
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&temp, local)
        .await
        .map_err(|e| format!("落盘失败: {e}"))?;
    Ok(Transfer {
        size,
        sha256: format!("{:x}", hash.finalize()),
    })
}

fn urlencode(input: &str) -> String {
    // 仅 path 查询参数需要转义，保留 UTF-8。
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 同目录临时文件，避免覆盖半成品。
fn temp_sibling(path: &Path) -> std::path::PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    path.with_file_name(format!(".{name}.rex-dl-{}", std::process::id()))
}
