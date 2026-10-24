//! 部署包解析：--package 本地包或 GitHub latest 发布包。
//! 与 Node src/deploy/bundle.js 语义对齐：HTTPS-only、sha256 校验、
//! tar 成员必须包含唯一 scripts/install.sh。
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const RELEASES: &str = "https://api.github.com/repos/JhihJian/remote-exec/releases/latest";
const ASSET_NAMES: [&str; 3] = [
    "remote-exec-linux-x64.tar.gz",
    "remote-exec-linux-x64.tar.gz.sha256",
    "install.sh",
];
const DOWNLOAD_WINDOW: Duration = Duration::from_secs(900);

pub struct Bundle {
    pub package: PathBuf,
    pub checksum: PathBuf,
    pub installer: PathBuf,
    /// 暂存目录；调用方负责结束时删除。
    pub directory: PathBuf,
}

impl Bundle {
    pub fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

pub fn resolve(package: Option<&str>, on_progress: &mut dyn FnMut(&str)) -> Result<Bundle, String> {
    let directory = tempfile_dir()?;
    match package {
        Some(path) => from_local(path, &directory),
        None => from_release(&directory, on_progress),
    }
}

/// 原始升级包：只校验 sha256 并复制到暂存，不要求 scripts/install.sh。
pub struct RawBundle {
    pub package: PathBuf,
    /// 暂存目录；调用方负责结束时删除。
    pub directory: PathBuf,
}

impl RawBundle {
    pub fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

pub fn resolve_raw(package: &str) -> Result<RawBundle, String> {
    let directory = tempfile_dir()?;
    let (package, checksum) = copy_with_checksum(Path::new(package), &directory)?;
    checksum_matches(&package, &checksum)?;
    Ok(RawBundle { package, directory })
}

fn tempfile_dir() -> Result<PathBuf, String> {
    let unique = format!(
        "rex-deploy-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let dir = std::env::temp_dir().join(unique);
    std::fs::create_dir(&dir).map_err(|e| format!("创建暂存目录失败: {e}"))?;
    Ok(dir)
}

/// 复制本地包与其 .sha256 兄弟文件到暂存 payload 目录，返回 (包, 校验) 路径。
fn copy_with_checksum(source: &Path, directory: &Path) -> Result<(PathBuf, PathBuf), String> {
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("无效的本地包路径")?;
    let payload = directory.join("payload");
    std::fs::create_dir(&payload).map_err(|e| format!("创建 payload 目录失败: {e}"))?;
    let package = payload.join(file_name);
    let checksum = payload.join(format!("{file_name}.sha256"));
    std::fs::copy(source, &package).map_err(|e| format!("复制包失败: {e}"))?;
    let checksum_source = PathBuf::from(format!("{}.sha256", source.display()));
    std::fs::copy(&checksum_source, &checksum)
        .map_err(|e| format!("缺少校验文件 {}.sha256: {e}", source.display()))?;
    Ok((package, checksum))
}

fn from_local(source: &str, directory: &Path) -> Result<Bundle, String> {
    let (package, checksum) = copy_with_checksum(Path::new(source), directory)?;
    checksum_matches(&package, &checksum)?;
    let installer = directory.join("install.sh");
    extract_installer(&package, &installer)?;
    Ok(Bundle {
        package,
        checksum,
        installer,
        directory: directory.to_owned(),
    })
}

fn from_release(directory: &Path, on_progress: &mut dyn FnMut(&str)) -> Result<Bundle, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("启动下载运行时失败: {e}"))?;
    runtime.block_on(async move {
        let deadline = Instant::now() + DOWNLOAD_WINDOW;
        let metadata = directory.join("release.json");
        download(RELEASES, &metadata, deadline, on_progress).await?;
        let release: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&metadata)
                .map_err(|e| format!("读取 release.json 失败: {e}"))?,
        )
        .map_err(|_| "GitHub latest 发布信息无效".to_owned())?;
        let tag = release
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        let assets = release
            .get("assets")
            .and_then(|v| v.as_array())
            .ok_or("GitHub latest 发布信息无效")?;
        let mut paths = Vec::new();
        for name in ASSET_NAMES {
            let url = assets
                .iter()
                .find(|asset| asset.get("name").and_then(|n| n.as_str()) == Some(name))
                .and_then(|asset| asset.get("browser_download_url"))
                .and_then(|u| u.as_str())
                .ok_or_else(|| format!("发布 {tag} 缺少 {name}"))?;
            let destination = directory.join(name);
            download(url, &destination, deadline, on_progress).await?;
            paths.push(destination);
        }
        checksum_matches(&paths[0], &paths[1])?;
        Ok(Bundle {
            package: paths[0].clone(),
            checksum: paths[1].clone(),
            installer: paths[2].clone(),
            directory: directory.to_owned(),
        })
    })
}

async fn download(
    url: &str,
    destination: &Path,
    deadline: Instant,
    on_progress: &mut dyn FnMut(&str),
) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("发布下载必须使用 HTTPS".into());
    }
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(deadline.saturating_duration_since(Instant::now()))
        .build()
        .map_err(|e| format!("构建下载客户端失败: {e}"))?;
    let mut attempt = 0;
    loop {
        attempt += 1;
        match fetch_with_resume(&client, url, destination, deadline).await {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 3 => {
                on_progress(&format!("[rex] 下载失败将重试（{attempt}/3）: {e}\n"));
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

async fn fetch_with_resume(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    deadline: Instant,
) -> Result<(), String> {
    let existing = std::fs::metadata(destination).map(|m| m.len()).unwrap_or(0);
    let request = if existing > 0 {
        client
            .get(url)
            .header("Range", format!("bytes={existing}-"))
    } else {
        client.get(url)
    };
    let response = request.send().await.map_err(|e| format!("下载失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败 HTTP {status}"));
    }
    let append = existing > 0 && status.as_u16() == 206;
    use std::io::Write;
    let mut file = if append {
        let file = std::fs::OpenOptions::new()
            .append(true)
            .open(destination)
            .map_err(|e| format!("续传打开 {destination:?} 失败: {e}"))?;
        file.set_len(existing)
            .map_err(|e| format!("截断损坏部分文件失败: {e}"))?;
        file
    } else {
        std::fs::File::create(destination)
            .map_err(|e| format!("创建 {destination:?} 失败: {e}"))?;
        std::fs::OpenOptions::new()
            .append(true)
            .open(destination)
            .map_err(|e| format!("打开 {destination:?} 失败: {e}"))?
    };
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载数据流中断: {e}"))?;
        if Instant::now() > deadline {
            return Err("下载超时".into());
        }
        file.write_all(&chunk)
            .map_err(|e| format!("写入下载文件失败: {e}"))?;
    }
    Ok(())
}

pub fn checksum_matches(package: &Path, checksum: &Path) -> Result<(), String> {
    let content =
        std::fs::read_to_string(checksum).map_err(|e| format!("读取校验文件失败: {e}"))?;
    let expected = content.split_whitespace().next().unwrap_or("");
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("SHA256 文件格式错误".into());
    }
    let data = std::fs::read(package).map_err(|e| format!("读取部署包失败: {e}"))?;
    use sha2::Digest;
    let actual = sha2::Sha256::digest(&data);
    let actual = actual
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if actual != expected.to_ascii_lowercase() {
        return Err("部署包 SHA256 校验失败".into());
    }
    Ok(())
}

/// 从 tar.gz 中提取唯一 scripts/install.sh（成员路径不得包含 ..）。
fn extract_installer(package: &Path, installer: &Path) -> Result<(), String> {
    let listing = run_tar(&["-tzf", &package.to_string_lossy()], 4)?;
    let members: Vec<&str> = listing
        .lines()
        .filter(|entry| {
            let ok_suffix = entry.ends_with("scripts/install.sh");
            let prefix_ok = entry
                .strip_suffix("scripts/install.sh")
                .is_some_and(|p| p.is_empty() || p.ends_with('/'));
            ok_suffix && prefix_ok && !entry.split('/').any(|part| part == "..")
        })
        .collect();
    if members.len() != 1 {
        return Err("部署包必须包含唯一 scripts/install.sh".into());
    }
    let script = run_tar(&["-xOzf", &package.to_string_lossy(), "--", members[0]], 1)?;
    if script.is_empty() {
        return Err("部署包 scripts/install.sh 内容为空或不是普通文件".into());
    }
    std::fs::write(installer, script).map_err(|e| format!("写入 install.sh 失败: {e}"))?;
    set_mode_600(installer)?;
    Ok(())
}

fn run_tar(args: &[&str], max_mb: usize) -> Result<String, String> {
    let output = std::process::Command::new("tar")
        .args(args)
        .output()
        .map_err(|e| format!("执行 tar 失败: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "tar 执行失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.len() > max_mb * 1024 * 1024 {
        return Err("tar 输出超过上限".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(unix)]
fn set_mode_600(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("设置 install.sh 权限失败: {e}"))
}

#[cfg(not(unix))]
fn set_mode_600(_path: &Path) -> Result<(), String> {
    Ok(())
}
