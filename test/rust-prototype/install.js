#!/usr/bin/env node
"use strict";

// Rust 正式安装验收：发布包、supervisor、重复安装、凭据保留和重启恢复。
// 需要 Docker privileged 容器；目标包由 INSTALL_PACKAGE 或 Rust release 默认路径提供。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execAsync = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const image = process.env.INSTALL_SYSTEMD_IMAGE || "remote-exec-deploy:test";
const packageFile = process.env.INSTALL_PACKAGE ||
  path.join(root, "dist/rust-release/remote-exec-linux-x64.tar.gz");
const rex = process.env.REX_BINARY ||
  path.join(root, "rust/target/x86_64-unknown-linux-musl/release/rex");

async function command(file, args, options = {}) {
  try {
    return await execAsync(file, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
  } catch (error) {
    throw new Error(`${file} ${args.join(" ")} 失败: ${error.stderr || error.message}`);
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, label) {
  let last;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${label} 超时: ${last?.message || "未就绪"}`);
}

async function main() {
  for (const file of [packageFile, `${packageFile}.sha256`, rex]) {
    assert.ok(fs.existsSync(file), `缺少 ${file}`);
  }
  await command("sha256sum", ["--check", `${packageFile}.sha256`], { cwd: path.dirname(packageFile) });
  const port = await freePort();
  const name = `rex-rust-install-${crypto.randomBytes(6).toString("hex")}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rex-rust-install-"));
  try {
    await command("docker", ["image", "inspect", image]);
    await command("docker", ["run", "--privileged", "--network", "host", "-d", "--name", name,
      "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp:exec", image]);
    await waitFor(async () => {
      let result;
      try {
        result = await execAsync("docker", ["exec", name, "systemctl", "is-system-running"]);
      } catch (error) {
        result = error;
      }
      assert.match(String(result.stdout || "").trim(), /^(running|degraded)$/);
    }, "systemd");
    await command("docker", ["exec", name, "mkdir", "-p", "/root/pkg"]);
    await command("docker", ["cp", packageFile, `${name}:/root/pkg/package.tar.gz`]);
    await command("docker", ["cp", `${packageFile}.sha256`, `${name}:/root/pkg/package.tar.gz.sha256`]);
    await command("docker", ["cp", path.join(root, "rust/packaging/install.sh"), `${name}:/root/pkg/install.sh`]);

    const install = ["exec", name, "bash", "/root/pkg/install.sh", "--package", "/root/pkg/package.tar.gz",
      "--address", "127.0.0.1", "--port", String(port), "--run-user", "remote-exec"];
    await command("docker", install);
    await command("docker", ["exec", name, "systemctl", "is-active", "--quiet", "remote-exec-supervisor.service"]);
    const { stdout: firstPid } = await command("docker", ["exec", name, "systemctl", "show", "-p", "MainPID", "--value", "remote-exec-supervisor.service"]);
    const release = JSON.parse((await command("docker", ["exec", name, "cat", "/opt/remote-exec/release.json"])).stdout);
    assert.equal(release.port, port);
    assert.equal(release.runUser, "remote-exec");
    assert.equal((await command("docker", ["exec", name, "bash", "-lc", "command -v node || true"])).stdout.trim(), "");

    const access = path.join(work, "access");
    fs.mkdirSync(access, { mode: 0o700 });
    for (const file of ["ca.crt", "token.txt"]) {
      await command("docker", ["cp", `${name}:/root/remote-exec-access/${file}`, path.join(access, file)]);
    }
    await command(rex, ["smoke", "--host", "127.0.0.1", "--port", String(port),
      "--ca", path.join(access, "ca.crt"), "--token-file", path.join(access, "token.txt"),
      "--expected-user", "remote-exec"]);

    await command("docker", install);
    const { stdout: secondPid } = await command("docker", ["exec", name, "systemctl", "show", "-p", "MainPID", "--value", "remote-exec-supervisor.service"]);
    assert.equal(secondPid.trim(), firstPid.trim(), "重复安装不应重启 supervisor");
    await command("docker", ["exec", name, "systemctl", "restart", "remote-exec-supervisor.service"]);
    await waitFor(() => command(rex, ["smoke", "--host", "127.0.0.1", "--port", String(port),
      "--ca", path.join(access, "ca.crt"), "--token-file", path.join(access, "token.txt"),
      "--expected-user", "remote-exec"]), "Rust supervisor 重启恢复");
    console.log("PASS Rust 正式包安装、supervisor、重复安装、无 Node 运行时和重启恢复");
  } finally {
    await command("docker", ["rm", "-f", name]).catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Rust 安装验收失败：${error.stack || error}`);
  process.exitCode = 1;
});
