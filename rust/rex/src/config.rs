//! hosts.json / ssh-hosts.json / credentials 读写，与 Node src/deploy/config-store.js 同格式互操作。
// 部署登记与指纹写入由 Phase 3b 的 deploy 子命令接入，这里提前保持
// 与 Node config-store 的互操作实现（单元测试已验证格式一致）。
#![allow(dead_code)]
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub type AnyError = Box<dyn std::error::Error + Send + Sync>;

/// 部署目标（register 入参）。via 为空表示直连。
#[derive(Clone)]
pub struct Target {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub ssh_port: u16,
    pub via: Option<String>,
}

/// hosts.json 单主机条目。未知字段（如 note）保留并在写回时原样输出。
#[derive(Clone, Serialize)]
pub struct HostEntry {
    pub host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub servername: Option<String>,
    pub ca: String,
    pub token_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub fn config_root() -> PathBuf {
    std::env::var_os("REX_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/root"))
                .join(".config")
                .join("remote-exec")
        })
}

pub struct Store {
    pub root: PathBuf,
}

fn read_json(path: &Path, fallback: Value) -> Result<Value, AnyError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(e) => Err(e.into()),
    }
}

fn atomic_write(path: &Path, content: &str) -> Result<(), AnyError> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        hex_random(12),
    ));
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn hex_random(bytes: usize) -> String {
    // 无需密码学强度：仅避免临时文件名碰撞。
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64) << 32;
    let mut out = String::with_capacity(bytes * 2);
    while out.len() < bytes * 2 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        out.push_str(&format!("{:016x}", seed));
    }
    out.truncate(bytes * 2);
    out
}

/// mkdir 锁，与 Node 端 .deploy.lock 互斥。
struct DirLock<'a>(&'a Path);
impl DirLock<'_> {
    fn acquire(path: &Path) -> Result<DirLock<'_>, AnyError> {
        std::fs::create_dir_all(path.parent().expect("lock 有父目录"))
            .and_then(|_| {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = std::fs::DirBuilder::new();
                builder.mode(0o700);
                builder.create(path)
            })
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    AnyError::from("其他部署正在更新配置，请稍后重试".to_owned())
                } else {
                    AnyError::from(e)
                }
            })?;
        Ok(DirLock(path))
    }
}
impl Drop for DirLock<'_> {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(self.0);
    }
}

pub struct Credentials {
    pub token: String,
    pub certificate: String,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn hosts_path(&self) -> PathBuf {
        self.root.join("hosts.json")
    }

    fn fingerprints_path(&self) -> PathBuf {
        self.root.join("ssh-hosts.json")
    }

    /// 读取 hosts.json，保留字段顺序与未知字段。
    pub fn load(&self) -> Result<Map<String, Value>, AnyError> {
        let config = read_json(&self.hosts_path(), serde_json::json!({"hosts": {}}))?;
        let hosts = config
            .get("hosts")
            .and_then(Value::as_object)
            .ok_or("hosts.json 格式错误")?;
        Ok(hosts.clone())
    }

    /// 单主机条目（强类型视图）。
    pub fn host(&self, name: &str) -> Result<HostEntry, AnyError> {
        let hosts = self.load()?;
        let entry = hosts
            .get(name)
            .ok_or_else(|| format!("未知主机 \"{name}\"，可用主机: {}", host_names(&hosts)))?;
        host_entry_from(name, entry)
    }

    fn assert_available(
        &self,
        target: &Target,
        hosts: &Map<String, Value>,
    ) -> Result<Option<Value>, AnyError> {
        if !target
            .name
            .starts_with(|c: char| c.is_ascii_alphanumeric())
            || !target
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        {
            return Err("主机别名格式错误".into());
        }
        let existing = hosts.get(&target.name).cloned();
        if let Some(existing) = &existing {
            let host = existing.get("host").and_then(Value::as_str).unwrap_or("");
            let port = existing.get("port").and_then(Value::as_u64).unwrap_or(0);
            let via = existing.get("via").and_then(Value::as_str).unwrap_or("");
            if host != target.host
                || port != target.port as u64
                || via != target.via.as_deref().unwrap_or("")
            {
                return Err(format!("主机别名 {} 已被其他端点使用", target.name).into());
            }
        }
        Ok(existing)
    }

    /// 登记主机：写入凭据目录并更新 hosts.json。servername/cwd 显式覆盖（None 表示保持现状）。
    pub fn register(
        &self,
        target: &Target,
        credentials: &Credentials,
        servername: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<(), AnyError> {
        let lock_path = self.root.join(".deploy.lock");
        let _lock = DirLock::acquire(&lock_path)?;
        let mut hosts = self.load()?;
        let existing = self.assert_available(target, &hosts)?;
        let directory = self.root.join("credentials").join(&target.name);
        std::fs::create_dir_all(&directory)?;
        set_mode(&directory, 0o700)?;
        let access_directory = directory.join(format!("access-{}", hex_random(12)));
        std::fs::create_dir(&access_directory)?;
        set_mode(&access_directory, 0o700)?;
        let token_file = access_directory.join("token");
        let ca = access_directory.join("ca.pem");
        let result = (|| -> Result<(), AnyError> {
            atomic_write(&token_file, &credentials.token)?;
            atomic_write(&ca, &credentials.certificate)?;
            let mut entry = existing.clone().unwrap_or_else(|| serde_json::json!({}));
            let object = entry.as_object_mut().expect("hosts 条目是对象");
            object.insert("host".into(), Value::from(target.host.clone()));
            object.insert("port".into(), Value::from(target.port));
            object.insert("ca".into(), Value::from(ca.to_string_lossy().into_owned()));
            object.insert(
                "tokenFile".into(),
                Value::from(token_file.to_string_lossy().into_owned()),
            );
            if let Some(via) = &target.via {
                object.insert("via".into(), Value::from(via.clone()));
            } else {
                object.remove("via");
            }
            if let Some(servername) = servername {
                object.insert("servername".into(), Value::from(servername));
            }
            if let Some(cwd) = cwd {
                object.insert("cwd".into(), Value::from(cwd));
            }
            hosts.insert(target.name.clone(), entry);
            let config = serde_json::json!({ "hosts": Value::Object(hosts.clone()) });
            atomic_write(&self.hosts_path(), &format_json(&config))?;
            Ok(())
        })();
        if result.is_ok() {
            // 清理不再被引用的旧 access 目录（仅限本主机的凭据目录内）。
            for old in existing
                .as_ref()
                .map(|e| [e.get("tokenFile"), e.get("ca")])
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
            {
                let Some(old_directory) = old.parent() else { continue };
                let owned = old_directory.parent() == Some(&directory)
                    && old_directory
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("access-"));
                let referenced = hosts.values().any(|item| {
                    [item.get("ca"), item.get("tokenFile")]
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .any(|f| Path::new(f).parent() == Some(old_directory))
                });
                if owned && !referenced {
                    let _ = std::fs::remove_dir_all(old_directory);
                }
            }
        } else {
            let _ = std::fs::remove_dir_all(&access_directory);
        }
        result
    }

    fn fingerprint_key(target: &Target) -> String {
        // 与 Node 端 JSON.stringify([via?"via":"direct", via||null, host, sshPort]) 一致。
        let kind = if target.via.is_some() { "via" } else { "direct" };
        format!(
            "[\"{}\",{},\"{}\",{}]",
            kind,
            target
                .via
                .as_ref()
                .map(|v| format!("\"{v}\""))
                .unwrap_or_else(|| "null".into()),
            target.host,
            target.ssh_port
        )
    }

    pub fn get_fingerprint(&self, target: &Target) -> Result<Option<String>, AnyError> {
        let records = read_json(&self.fingerprints_path(), serde_json::json!({}))?;
        Ok(records
            .get(Self::fingerprint_key(target))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    pub fn save_fingerprint(&self, target: &Target, fingerprint: &str) -> Result<(), AnyError> {
        let lock_path = self.root.join(".deploy.lock");
        let _lock = DirLock::acquire(&lock_path)?;
        let mut records = read_json(&self.fingerprints_path(), serde_json::json!({}))?;
        let object = records.as_object_mut().expect("ssh-hosts.json 是对象");
        let key = Self::fingerprint_key(target);
        if let Some(existing) = object.get(&key).and_then(Value::as_str) {
            if existing != fingerprint {
                return Err("SSH 主机指纹发生变化，拒绝连接".into());
            }
            return Ok(());
        }
        object.insert(key, Value::from(fingerprint));
        atomic_write(&self.fingerprints_path(), &format_json(&records))
    }
}

fn set_mode(path: &Path, mode: u32) -> Result<(), AnyError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    Ok(())
}

fn format_json(value: &Value) -> String {
    // Node 端 JSON.stringify(x, null, 2) + "\n"。
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    text
}

pub fn host_names(hosts: &Map<String, Value>) -> String {
    let names: Vec<&str> = hosts.keys().map(String::as_str).collect();
    if names.is_empty() {
        "（配置不存在或为空）".into()
    } else {
        names.join(", ")
    }
}

fn host_entry_from(name: &str, value: &Value) -> Result<HostEntry, AnyError> {
    let get = |field: &str| value.get(field).cloned();
    let host = get("host")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or(format!("主机 {name} 缺少 host 字段"))?
        .to_owned();
    let port = get("port")
        .and_then(|v| v.as_u64())
        .ok_or(format!("主机 {name} 缺少 port 字段"))? as u16;
    let ca = get("ca")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or(format!("主机 {name} 缺少 ca 字段"))?
        .to_owned();
    let token_file = get("tokenFile")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or(format!("主机 {name} 缺少 tokenFile 字段"))?
        .to_owned();
    Ok(HostEntry {
        host,
        port,
        servername: get("servername").and_then(|v| v.as_str().map(str::to_owned)),
        ca,
        token_file,
        via: get("via").and_then(|v| v.as_str().map(str::to_owned)),
        cwd: get("cwd").and_then(|v| v.as_str().map(str::to_owned)),
        note: get("note").and_then(|v| v.as_str().map(str::to_owned)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(name: &str, host: &str, port: u16, via: Option<&str>) -> Target {
        Target {
            name: name.into(),
            host: host.into(),
            port,
            ssh_port: 22,
            via: via.map(str::to_owned),
        }
    }

    #[test]
    fn register_writes_node_compatible_hosts_json() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        store
            .register(
                &target("nm24", "172.16.126.24", 18791, Some("nm105")),
                &Credentials {
                    token: "t".into(),
                    certificate: "c".into(),
                },
                Some("172.16.126.24"),
                Some("/root"),
            )
            .unwrap();
        let text = std::fs::read_to_string(dir.path().join("hosts.json")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        let host = &value["hosts"]["nm24"];
        assert_eq!(host["host"], "172.16.126.24");
        assert_eq!(host["port"], 18791);
        assert_eq!(host["servername"], "172.16.126.24");
        assert_eq!(host["via"], "nm105");
        assert_eq!(host["cwd"], "/root");
        let token_file = host["tokenFile"].as_str().unwrap();
        assert!(token_file.contains("credentials/nm24/access-"));
        assert_eq!(std::fs::read_to_string(token_file).unwrap(), "t");
        assert!(text.ends_with('\n'));
        // 重复登记同端点幂等；换端点被拒绝。
        store
            .register(
                &target("nm24", "172.16.126.24", 18791, Some("nm105")),
                &Credentials {
                    token: "t2".into(),
                    certificate: "c2".into(),
                },
                None,
                None,
            )
            .unwrap();
        assert!(store
            .register(
                &target("nm24", "172.16.126.99", 18791, None),
                &Credentials {
                    token: "t".into(),
                    certificate: "c".into(),
                },
                None,
                None,
            )
            .is_err());
    }

    #[test]
    fn fingerprint_key_matches_node_format() {
        let direct = Store::fingerprint_key(&target("a", "10.0.0.1", 8791, None));
        assert_eq!(direct, "[\"direct\",null,\"10.0.0.1\",22]");
        let relayed = Store::fingerprint_key(&target("b", "10.0.0.2", 8791, Some("gw")));
        assert_eq!(relayed, "[\"via\",\"gw\",\"10.0.0.2\",22]");
    }

    #[test]
    fn register_rejects_bad_alias() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        assert!(store
            .register(
                &target("-bad", "10.0.0.1", 8791, None),
                &Credentials {
                    token: "t".into(),
                    certificate: "c".into(),
                },
                None,
                None,
            )
            .is_err());
    }
}
