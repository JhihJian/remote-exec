#!/usr/bin/env node
// Phase 4b 端到端：rex migrate（Node → Rust 布局迁移）与回滚演练。
// 拓扑：宿主 rex --SSH(root key)--> 目标容器（Node install.sh 首装 → migrate）。
// 覆盖：Node 布局预检、并置安装不影响 Node、单命令交接、旧凭据验收、
// 重复迁移拒绝、--rollback 完整恢复（含 Rust 资产清理）、回滚后再迁移、
// 迁移后 rex upgrade（自签叶子 pin 兼容）。
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createStore } = require("../../src/deploy/config-store.js");
const { createHarness, root, image, rex, nodePackage } = require("./helpers.js");

const {
  secrets, redact, command, docker, until, rexRun, rexOpsRun, rexRunPty,
  containerIp, fingerprintOf, setPasswords, pushFile, sha,
} = createHarness();

const releasePackage = process.env.REX_RELEASE_PACKAGE ||
  path.join(root, "dist/rust-release/remote-exec-linux-x64.tar.gz");

// 容器内用 Node 安装器布局首装（生成 install.json 标记的 Node 布局）。
async function installNodeLayout(container, packageFile, ip) {
  const stage = "/root/node-stage";
  await docker(["exec", container, "mkdir", "-p", stage, "/root/pkg"]);
  await pushFile(container, packageFile, "/root/pkg/node.tar.gz");
  await pushFile(container, `${packageFile}.sha256`, "/root/pkg/node.tar.gz.sha256");
  const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
  await docker(["exec", container, "bash", "-c",
    `tar -xzf /root/pkg/node.tar.gz -C ${stage}`]);
  await docker(["exec", container, "bash",
    `${stage}/scripts/install.sh`, "--package", "/root/pkg/node.tar.gz",
    "--address", ip, "--port", "9000"]);
  await until(() => docker(["exec", container, "systemctl", "is-active", "--quiet", "remote-exec.service"]),
    "Node remote-exec.service 启动");
}

// 把 Node 首装生成的接入资料登记进 rex 配置（CA=自签 server.crt，pin 语义）。
async function registerNodeCredentials(configDir, container, name, ip) {
  const accessDir = path.join(configDir, "node-access");
  fs.mkdirSync(accessDir, { recursive: true, mode: 0o700 });
  const token = (await docker(["exec", container, "cat", "/root/remote-exec-access/token.txt"])).stdout.trim();
  secrets.push(token);
  const serverCrt = (await docker(["exec", container, "cat",
    "/etc/remote-exec/credentials/server.crt"])).stdout;
  fs.writeFileSync(path.join(accessDir, "server.crt"), serverCrt);
  fs.writeFileSync(path.join(accessDir, "token.txt"), token);
  const store = createStore(path.join(configDir, ".config/remote-exec"));
  store.register({ name, host: ip, port: 9000, sshPort: 22 },
    { token, certificate: serverCrt });
  return store;
}

async function execOn(container, script) {
  const { stdout } = await docker(["exec", container, "bash", "-c", script]);
  return stdout.trim();
}

async function main() {
  for (const file of [rex, nodePackage, `${nodePackage}.sha256`, releasePackage, `${releasePackage}.sha256`]) {
    assert.ok(fs.existsSync(file), `缺少 ${file}。请先构建 rust musl 产物或设置环境变量。`);
  }
  assert.equal(sha(fs.readFileSync(releasePackage)),
    fs.readFileSync(`${releasePackage}.sha256`).toString().split(/\s+/)[0],
    "Rust 发布包 sha256 不匹配");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rex-phase4b-"));
  fs.chmodSync(tmp, 0o700);
  const suffix = crypto.randomBytes(6).toString("hex");
  const network = `rex-p4b-${suffix}`;
  const container = `rex-p4b-${suffix}`;
  let passed = 0;
  const pass = (label) => { passed += 1; process.stdout.write(`PASS ${label}\n`); };
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  try {
    await docker(["info"]);
    try { await docker(["image", "inspect", image]); }
    catch {
      process.stdout.write(`构建测试镜像 ${image}……\n`);
      await docker(["build", "-t", image, "-f", path.join(root, "test/deploy/Dockerfile"), path.join(root, "test/deploy")]);
    }
    await docker(["network", "create", "--internal", network]);
    await docker(["run", "-d", "--name", container, "--privileged", "--cgroupns=private",
      "--network", network, "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp:exec", image]);
    await until(() => docker(["exec", container, "systemctl", "is-active", "--quiet", "ssh.service"]),
      `${container} systemd/SSH`);
    const ip = await containerIp(container, network);
    const rootPassword = crypto.randomBytes(24).toString("hex");
    secrets.push(rootPassword);
    await setPasswords(container, rootPassword, rootPassword);
    const identity = path.join(tmp, "migrate-key");
    await command("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", identity, "-C", "phase4b"]);
    await new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", container, "bash", "-c",
        "umask 077; mkdir -p /root/.ssh; cat >> /root/.ssh/authorized_keys; sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys"],
      { stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("无法登记 root 公钥")));
      child.stdin.end(fs.readFileSync(`${identity}.pub`));
    });
    const fingerprint = /SHA256:\S+/.exec((await fingerprintOf(ip)).trim())[0];

    // —— Node 布局首装 + rex 旧凭据接入 ——
    await installNodeLayout(container, nodePackage, ip);
    await registerNodeCredentials(home, container, "node-host", ip);
    let result = await rexRun(home, ["exec", "node-host", "--", "id", "-un"]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    assert.match(result.stdout, /^remote-exec\n/);
    pass("Node 布局首装完成，rex 旧凭据（自签叶子 pin + token）接入可用");

    // —— rex migrate：并置 → 交接 → 旧凭据验收 ——
    const nodeAssets = await execOn(container,
      "ls /opt/remote-exec/versions /opt/remote-exec/current 2>&1 | head -1");
    assert.match(nodeAssets, /No such file/);
    result = await rexOpsRun(home, ["migrate", "node-host",
      "--package", releasePackage, "--identity", identity, "--host-key", fingerprint]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    assert.match(redact(result.stdout + result.stderr), /迁移完成：旧凭据（CA pin \+ token）验收通过/);
    assert.equal(await execOn(container, "systemctl is-active remote-exec-supervisor || true"), "active");
    assert.equal(await execOn(container, "systemctl is-active remote-exec || true"), "inactive");
    assert.equal(await execOn(container, "systemctl is-enabled remote-exec 2>&1 || true"), "disabled");
    assert.equal(await execOn(container, "test -f /opt/remote-exec/install.json && echo kept"), "kept");
    result = await rexRun(home, ["exec", "node-host", "--", "id", "-un"]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    assert.match(result.stdout, /^remote-exec\n/);
    pass("rex migrate 完成：supervisor 接管，Node 服务停用，旧凭据验收通过");

    // —— 重复迁移拒绝（Rust 布局已存在）——
    result = await rexOpsRun(home, ["migrate", "node-host",
      "--package", releasePackage, "--identity", identity, "--host-key", fingerprint]);
    assert.notEqual(result.code, 0);
    assert.match(redact(result.stdout + result.stderr), /预检失败/);
    pass("重复迁移被预检拒绝");

    // —— rollback：完整恢复 Node（含 Rust 资产清理）——
    result = await rexOpsRun(home, ["migrate", "node-host", "--rollback",
      "--identity", identity, "--host-key", fingerprint]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    assert.match(redact(result.stdout + result.stderr), /已回滚到 Node 服务/);
    assert.equal(await execOn(container, "systemctl is-active remote-exec || true"), "active");
    assert.equal(await execOn(container, "systemctl is-enabled remote-exec 2>&1 || true"), "enabled");
    assert.equal(await execOn(container,
      "test -e /opt/remote-exec/versions || test -e /opt/remote-exec/current || test -e /etc/remote-exec/supervisor-state.json || test -e /etc/systemd/system/remote-exec-supervisor.service && echo leftover || echo clean"), "clean");
    result = await rexRun(home, ["exec", "node-host", "--", "id", "-un"]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    pass("rollback 完整恢复 Node 服务且清理全部 Rust 资产，旧凭据仍可用");

    // —— 回滚后再迁移（全流程可重入）——
    result = await rexOpsRun(home, ["migrate", "node-host",
      "--package", releasePackage, "--identity", identity, "--host-key", fingerprint]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    assert.match(redact(result.stdout + result.stderr), /迁移完成/);
    pass("回滚后可重新迁移");

    // —— 迁移后 rex upgrade（自签叶子 backend-ca 兼容）——
    result = await rexOpsRun(home, ["upgrade", "node-host",
      "--package", releasePackage, "--identity", identity, "--host-key", fingerprint,
      "--retire-wait-secs", "30"]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    assert.match(redact(result.stdout + result.stderr), /已切换到新版本/);
    result = await rexRun(home, ["exec", "node-host", "--", "id", "-un"]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    assert.match(result.stdout, /^remote-exec\n/);
    pass("迁移后 rex upgrade 正常（叶子 pin 校验），执行可用");

    process.stdout.write(`\n全部通过：${passed}\n`);
  } finally {
    if (process.env.REX_TEST_KEEP === "1") {
      process.stderr.write(`保留现场: 容器 ${container}，网络 ${network}，临时目录 ${tmp}\n`);
    } else {
      await docker(["rm", "-f", container]).catch(() => {});
      await docker(["network", "rm", network]).catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${redact(error?.stack || error)}\n`);
  process.exit(1);
});
