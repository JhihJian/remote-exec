"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const exec = promisify(execFile);
const RELEASES = "https://api.github.com/repos/JhihJian/remote-exec/releases/latest";

async function checksumMatches(packagePath, checksumPath) {
  const expected = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("SHA256 文件格式错误");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(packagePath)) hash.update(chunk);
  if (hash.digest("hex") !== expected.toLowerCase()) throw new Error("部署包 SHA256 校验失败");
}

async function resolveBundle(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rex-deploy-"));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  const deadline = Date.now() + 900000;
  async function download(url, destination) {
    if (options.signal?.aborted) throw new Error("操作已取消");
    if (!url.startsWith("https://")) throw new Error("发布下载必须使用 HTTPS");
    await new Promise((resolve, reject) => {
      const child = spawn("curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--retry", "3", "--continue-at", "-", "--max-time", String(Math.max(1, Math.ceil((deadline - Date.now()) / 1000))), "--output", destination, url], { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (chunk) => (options.onProgress || ((data) => process.stderr.write(data)))(chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(1, deadline - Date.now()));
      const abort = () => child.kill("SIGKILL");
      const finish = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      child.on("error", (err) => { finish(); reject(err); });
      child.on("close", (code) => {
        finish();
        if (options.signal?.aborted) reject(new Error("操作已取消"));
        else if (code === 0) resolve();
        else reject(new Error(`下载失败（curl ${code}）`));
      });
    });
  }
  try {
    let packagePath;
    let checksum;
    const installer = path.join(directory, "install.sh");
    if (options.package) {
      const source = path.resolve(options.package);
      const payloadDirectory = path.join(directory, "payload");
      fs.mkdirSync(payloadDirectory, { mode: 0o700 });
      packagePath = path.join(payloadDirectory, path.basename(source));
      checksum = `${packagePath}.sha256`;
      fs.copyFileSync(source, packagePath);
      fs.copyFileSync(`${source}.sha256`, checksum);
      await checksumMatches(packagePath, checksum);
      const { stdout: listing } = await exec("tar", ["-tzf", packagePath], { maxBuffer: 4 * 1024 * 1024, timeout: 60000, signal: options.signal });
      const members = listing.split("\n").filter((entry) => /^(?:[^/]+\/)*scripts\/install\.sh$/.test(entry) && !entry.split("/").includes(".."));
      if (members.length !== 1) throw new Error("部署包必须包含唯一 scripts/install.sh");
      const { stdout } = await exec("tar", ["-xOzf", packagePath, "--", members[0]], { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: 60000, signal: options.signal });
      if (!stdout.length) throw new Error("部署包 scripts/install.sh 内容为空或不是普通文件");
      fs.writeFileSync(installer, stdout, { mode: 0o600 });
    } else {
      const metadata = path.join(directory, "release.json");
      await download(RELEASES, metadata);
      const release = JSON.parse(fs.readFileSync(metadata, "utf8"));
      if (!release.tag_name || !Array.isArray(release.assets)) throw new Error("GitHub latest 发布信息无效");
      const names = ["remote-exec-linux-x64.tar.gz", "remote-exec-linux-x64.tar.gz.sha256", "install.sh"];
      for (const name of names) {
        const asset = release.assets.find((item) => item.name === name);
        if (!asset) throw new Error(`发布 ${release.tag_name} 缺少 ${name}`);
        await download(asset.browser_download_url, path.join(directory, name));
      }
      packagePath = path.join(directory, names[0]);
      checksum = path.join(directory, names[1]);
      await checksumMatches(packagePath, checksum);
    }
    return { package: packagePath, checksum, installer, cleanup };
  } catch (err) { cleanup(); throw err; }
}

module.exports = { resolveBundle, checksumMatches };
