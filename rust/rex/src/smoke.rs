//! 安装验收：/readyz + WSS exec 冒烟（等价 scripts/smoke.js，目标机无需 Node）。
use crate::client::{self, Call, Interrupt};
use serde_json::json;

pub struct Options<'a> {
    pub host: &'a str,
    pub port: u16,
    pub ca: &'a str,
    pub token_file: &'a str,
    pub expected_user: Option<&'a str>,
}

pub async fn run(opts: &Options<'_>) -> Result<(), String> {
    let certificate = std::fs::read_to_string(opts.ca).map_err(|e| format!("读取 CA 失败: {e}"))?;
    let token = std::fs::read_to_string(opts.token_file)
        .map_err(|e| format!("读取 token 失败: {e}"))?
        .trim()
        .to_owned();

    let root = reqwest::Certificate::from_pem(certificate.as_bytes())
        .map_err(|e| format!("CA PEM 无效: {e}"))?;
    let probe = reqwest::Client::builder()
        .add_root_certificate(root)
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let response = probe
        .get(format!("https://{}:{}/readyz", opts.host, opts.port))
        .send()
        .await
        .map_err(|e| format!("健康检查失败: {e}"))?;
    if response.status().as_u16() != 200 {
        return Err(format!("/readyz 返回 {}", response.status()));
    }

    // 安装验收时主机尚未登记 hosts.json，直连条目执行。
    let entry = crate::config::HostEntry {
        host: opts.host.to_owned(),
        port: opts.port,
        servername: Some(opts.host.to_owned()),
        ca: opts.ca.to_owned(),
        token_file: opts.token_file.to_owned(),
        via: None,
        cwd: None,
        note: None,
    };
    let mut interrupt = Interrupt(None);
    let result = client::call_entry(
        &entry,
        &token,
        &Call {
            method: "exec".into(),
            params: json!({
                "command": "printf '\\nremote-exec-install-ok\\n'; id -un",
                "timeoutMs": 5000,
            }),
        },
        None,
        &mut interrupt,
    )
    .await
    .map_err(|e| format!("RPC 验收失败: {e}"))?;
    let exit = result
        .get("exitCode")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    let stdout = client::decode_b64(&result, "stdoutB64");
    let output = String::from_utf8_lossy(&stdout);
    if exit != 0 || !output.contains("\nremote-exec-install-ok\n") {
        return Err("命令未正常完成".into());
    }
    if let Some(expected) = opts.expected_user {
        let last = output.trim().lines().next_back().unwrap_or("");
        if last != expected {
            return Err(format!("服务执行用户不符合配置: {last} != {expected}"));
        }
    }
    Ok(())
}
