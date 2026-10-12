#!/usr/bin/env node
"use strict";

// Real SSH, systemd and WSS integration. Requires Docker privileged containers.
// INSTALL_PACKAGE must be a builder archive with its adjacent .sha256 file.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const project = path.resolve(__dirname, "../..");
const image = process.env.DEPLOY_TEST_IMAGE || "remote-exec-deploy:test";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secrets = [];
function redact(text) {
  let result = String(text);
  for (const secret of secrets) if (secret) result = result.split(secret).join("[已隐藏]");
  return result;
}
async function command(file, args, options = {}) {
  try { return await exec(file, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(redact(`${file} 失败: ${error.stderr || error.message}`)); }
}
const docker = (args, options) => command("docker", args, options);
async function until(check, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { return await check(); } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`${description} 超时: ${last?.message || "未就绪"}`);
}
function privateFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}
async function packagePath() {
  const archive = path.resolve(process.env.INSTALL_PACKAGE || path.join(project, "dist/remote-exec-linux-x64.tar.gz"));
  for (const file of [archive, `${archive}.sha256`]) {
    try { fs.accessSync(file, fs.constants.R_OK); }
    catch { throw new Error(`缺少可读的正式构建包或校验文件: ${file}。请运行 scripts/build-release.sh，或设置 INSTALL_PACKAGE。`); }
  }
  const { checksumMatches } = require("../../src/deploy/bundle.js");
  await checksumMatches(archive, `${archive}.sha256`);
  return archive;
}
async function ensureImage(root) {
  try { await docker(["image", "inspect", image]); return; } catch { /* Build missing image. */ }
  const log = path.join(root, "docker-build.log");
  const fd = fs.openSync(log, "w", 0o600);
  process.stdout.write(`构建测试镜像 ${image}，日志 ${log}\n`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("docker", ["build", "-t", image, "-f", path.join(__dirname, "Dockerfile"), __dirname], { stdio: ["ignore", fd, fd] });
      const timer = setTimeout(() => child.kill("SIGKILL"), 600000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Docker 构建失败 (${code}): ${fs.readFileSync(log, "utf8").slice(-12000)}`));
      });
    });
  } finally { fs.closeSync(fd); }
}
async function setPasswords(container, rootPassword, opsPassword) {
  await new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "chpasswd"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(redact(`设置测试密码失败: ${stderr}`))));
    child.stdin.on("error", reject);
    child.stdin.end(`root:${rootPassword}\nops:${opsPassword}\n`);
  });
}
async function stopDaemon(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function main() {
  const archive = await packagePath();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rex-deploy-e2e-"));
  fs.chmodSync(temporary, 0o700);
  const savedEnv = Object.fromEntries(["HOME", "SSH_AUTH_SOCK", "TMPDIR"].map((key) => [key, process.env[key]]));
  const suffix = crypto.randomBytes(6).toString("hex");
  const network = `rex-deploy-${suffix}`;
  const containers = [];
  let networkCreated = false;
  let gateway;
  let gatewayLog = "";
  let installLog = "";
  let passed = 0;
  const pass = (label) => { passed += 1; process.stdout.write(`PASS ${label}\n`); };
  try {
    await docker(["info"]);
    await ensureImage(temporary);
    await docker(["network", "create", "--internal", network]);
    networkCreated = true;
    const rootPassword = crypto.randomBytes(24).toString("hex");
    const opsPassword = crypto.randomBytes(24).toString("hex");
    const wrongPassword = crypto.randomBytes(24).toString("hex");
    secrets.push(rootPassword, opsPassword, wrongPassword);
    const targets = [];
    for (let index = 1; index <= 2; index += 1) {
      const container = `rex-deploy-${suffix}-${index}`;
      containers.push(container);
      // No host directory or cgroup bind mounts and no published container ports.
      await docker(["run", "-d", "--name", container, "--privileged", "--cgroupns=private", "--network", network,
        "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp:exec", image]);
      const { stdout: isolation } = await docker(["inspect", container]);
      const [details] = JSON.parse(isolation);
      assert.equal(details.HostConfig.Privileged, true);
      assert.equal(details.HostConfig.Binds?.length || 0, 0);
      assert.equal(Object.keys(details.HostConfig.PortBindings || {}).length, 0);
      await until(async () => {
        await docker(["exec", container, "systemctl", "is-active", "--quiet", "ssh.service"]);
      }, `${container} systemd/SSH`);
      await setPasswords(container, rootPassword, opsPassword);
      const { stdout } = await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container]);
      const host = stdout.trim();
      assert.match(host, /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/);
      targets.push({ container, host });
    }
    pass("两个隔离容器运行真实 systemd 与 SSH，无宿主目录挂载及端口映射");

    const clientHome = path.join(temporary, "client-home");
    const daemonHome = path.join(temporary, "gateway-home");
    const daemonTmp = path.join(temporary, "gateway-tmp");
    for (const directory of [clientHome, daemonHome, daemonTmp]) fs.mkdirSync(directory, { mode: 0o700 });
    process.env.HOME = clientHome;
    delete process.env.SSH_AUTH_SOCK;
    const configRoot = path.join(clientHome, ".config/remote-exec");
    const { createStore } = require("../../src/deploy/config-store.js");
    const { deploy, parseArgs } = require("../../src/deploy/cli.js");
    const client = require("../../src/client/index.js");
    const ssh = require("../../src/deploy/ssh.js");
    const store = createStore(configRoot);
    const certificate = path.join(daemonHome, "gateway.crt");
    const key = path.join(daemonHome, "gateway.key");
    await command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key,
      "-out", certificate, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
    fs.chmodSync(key, 0o600);
    const gatewayToken = crypto.randomBytes(32).toString("hex");
    secrets.push(gatewayToken);
    const hashFile = path.join(daemonHome, "token.sha256");
    privateFile(hashFile, crypto.createHash("sha256").update(gatewayToken).digest("hex"));
    const gatewayEnv = { ...process.env, HOME: daemonHome, TMPDIR: daemonTmp };
    gateway = spawn(process.execPath, [path.join(project, "src/daemon/main.js"), "--host", "0.0.0.0", "--port", "0",
      "--cert", certificate, "--key", key, "--token-sha256-file", hashFile], { env: gatewayEnv, stdio: ["ignore", "pipe", "pipe"] });
    gateway.stdout.on("data", (chunk) => { gatewayLog += chunk; });
    gateway.stderr.on("data", (chunk) => { gatewayLog += chunk; });
    let spawnError;
    gateway.on("error", (error) => { spawnError = error; });
    const gatewayPort = await until(() => {
      if (spawnError) throw spawnError;
      const match = /wss:\/\/0\.0\.0\.0:(\d+)/.exec(gatewayLog);
      if (!match || gateway.exitCode !== null) throw new Error(redact(gatewayLog || "网关未监听"));
      return Number(match[1]);
    }, "独立 TLS 网关监听");
    store.register({ name: "gateway", host: "127.0.0.1", port: gatewayPort }, { token: gatewayToken, certificate: fs.readFileSync(certificate, "utf8") });
    const promptCounts = { yes: 0, ssh: 0, sudo: 0 };
    let transcript = "";
    const prompts = {
      yes: async () => { promptCounts.yes += 1; return true; },
      secret: async (label) => {
        if (label.includes("sudo")) { promptCounts.sudo += 1; return opsPassword; }
        assert.match(label, /SSH/);
        promptCounts.ssh += 1;
        return label.startsWith("root@") ? rootPassword : opsPassword;
      },
    };
    const output = (text) => { transcript += String(text); };
    const tracedSsh = {
      inspectHost: ssh.inspectHost,
      installTarget: (options, callbacks = {}) => ssh.installTarget(options, {
        ...callbacks,
        onOutput: (chunk, stream) => { installLog += chunk.toString("utf8"); callbacks.onOutput?.(chunk, stream); },
      }),
    };
    const runDeploy = (args, overrides = {}) => deploy(parseArgs([...args, "--package", archive]), { store, prompts, output, ssh: tracedSsh, ...overrides });
    async function checkExec(name, expectedUser = "remote-exec") {
      const marker = crypto.randomBytes(12).toString("hex");
      const result = await client.callHost(name, "exec", { command: `printf '${marker}\\n'; id -un`, timeoutMs: 5000 });
      assert.equal(result.exitCode, 0);
      const stdout = result.stdoutB64 ? Buffer.from(result.stdoutB64, "base64").toString("utf8") : result.stdout;
      assert.equal(stdout, `${marker}\n${expectedUser}\n`);
    }
    function checkPrivate(name) {
      const config = store.loadConfig().hosts[name];
      for (const file of [path.join(configRoot, "hosts.json"), path.join(configRoot, "ssh-hosts.json"), config.ca, config.tokenFile]) {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${file} 权限`);
      }
      assert.equal(fs.statSync(configRoot).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.dirname(config.tokenFile)).mode & 0o777, 0o700);
      secrets.push(fs.readFileSync(config.tokenFile, "utf8"), fs.readFileSync(config.ca, "utf8"));
      return config;
    }
    async function installedState(target, port) {
      await docker(["exec", target.container, "systemctl", "is-active", "--quiet", "remote-exec.service"]);
      await docker(["exec", target.container, "systemctl", "is-enabled", "--quiet", "remote-exec.service"]);
      const { stdout: pid } = await docker(["exec", target.container, "systemctl", "show", "-p", "MainPID", "--value", "remote-exec.service"]);
      assert.ok(Number(pid.trim()) > 1);
      const { stdout: metadata } = await docker(["exec", target.container, "cat", "/opt/remote-exec/install.json"]);
      assert.equal(JSON.parse(metadata).port, port);
      const { stdout: hashes } = await docker(["exec", target.container, "sha256sum", "/root/remote-exec-access/token.txt", "/root/remote-exec-access/server.crt", "/etc/remote-exec/credentials/server.key"]);
      const { stdout: mode } = await docker(["exec", target.container, "stat", "-c", "%a", "/root/remote-exec-access/token.txt", "/etc/remote-exec/credentials/server.key"]);
      assert.equal(mode, "600\n600\n");
      return { pid: pid.trim(), hashes };
    }

    assert.equal((await runDeploy([`first=root@${targets[0].host}`, "--port", "9000"]))[0].success, true, redact(transcript));
    const first = checkPrivate("first");
    assert.equal(first.host, targets[0].host);
    assert.equal(first.port, 9000);
    assert.equal(Object.hasOwn(first, "via"), false);
    assert.equal(promptCounts.ssh, 1);
    assert.equal(promptCounts.yes, 1);
    await checkExec("first");
    const before = await installedState(targets[0], 9000);
    pass("root 密码回退、真实 SSH 安装、direct 配置与 WSS exec");

    const countsBefore = { ...promptCounts };
    assert.equal((await runDeploy([`second=ops@${targets[1].host}`, "--via", "gateway", "--port", "9001"]))[0].success, true, redact(transcript));
    const second = checkPrivate("second");
    assert.equal(second.via, "gateway");
    assert.equal(second.host, targets[1].host);
    assert.equal(second.port, 9001);
    assert.equal(promptCounts.ssh - countsBefore.ssh, 1);
    assert.equal(promptCounts.yes - countsBefore.yes, 1);
    assert.equal(promptCounts.sudo - countsBefore.sudo, 1);
    await checkExec("second");
    await installedState(targets[1], 9001);
    assert.deepEqual(fs.readdirSync(daemonTmp), [], "网关暂存包应 cleanup");
    pass("网关 HTTPS 上传、ops SSH/sudo 密码回退、安装、relay exec 与 via 配置");

    // The internal Docker network has no external route, so local-package installs run offline.
    const trustedPrompts = promptCounts.yes;
    assert.equal((await runDeploy([`first=root@${targets[0].host}`, "--port", "9000"]))[0].success, true, redact(transcript));
    assert.equal(promptCounts.yes, trustedPrompts);
    assert.deepEqual(await installedState(targets[0], 9000), before);
    await checkExec("first");
    pass("重复 direct 安装保持 systemd PID、token、证书和私钥");

    const identity = path.join(temporary, "deploy-key");
    await command("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", identity]);
    await new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", targets[0].container, "bash", "-c", "umask 077; mkdir -p /root/.ssh; cat > /root/.ssh/authorized_keys"], { stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("无法登记测试 SSH 公钥")));
      child.stdin.end(fs.readFileSync(`${identity}.pub`));
    });
    const passwordsBeforeKey = promptCounts.ssh;
    assert.equal((await runDeploy([`first=root@${targets[0].host}`, "--port", "9000", "--identity", identity]))[0].success, true, redact(transcript));
    assert.equal(promptCounts.ssh, passwordsBeforeKey);
    assert.deepEqual(await installedState(targets[0], 9000), before);
    assert.equal((await runDeploy([`key-via=root@${targets[0].host}`, "--port", "9000", "--via", "gateway", "--identity", identity]))[0].success, true, redact(transcript));
    assert.equal(promptCounts.ssh, passwordsBeforeKey);
    await checkExec("key-via");
    privateFile(path.join(clientHome, ".ssh/id_rsa"), fs.readFileSync(identity));
    privateFile(path.join(daemonHome, ".ssh/id_rsa"), fs.readFileSync(identity));
    assert.equal((await runDeploy([`first=root@${targets[0].host}`, "--port", "9000"]))[0].success, true, redact(transcript));
    assert.equal((await runDeploy([`key-via=root@${targets[0].host}`, "--port", "9000", "--via", "gateway"]))[0].success, true, redact(transcript));
    assert.equal(promptCounts.ssh, passwordsBeforeKey);
    pass("直连与网关均支持指定私钥和默认私钥免密部署");
    assert.equal(fs.readdirSync(path.join(configRoot, "credentials/first")).length, 1, "重复登记不应累积旧凭据目录");

    const { resolveBundle } = require("../../src/deploy/bundle.js");
    const cancellationBundle = await resolveBundle({ package: archive });
    try {
      const controller = new AbortController();
      await assert.rejects(ssh.installTarget({ host: targets[0].host, sshPort: 22, username: "root", port: 9000,
        fingerprint: store.getFingerprint({ host: targets[0].host, sshPort: 22 }), identity,
        bundle: cancellationBundle,
      }, { signal: controller.signal, onOutput: () => controller.abort() }), /中断|失败|关闭|取消/);
      const { stdout: leftover } = await docker(["exec", targets[0].container, "find", "/tmp", "-maxdepth", "1", "-name", "remote-exec-deploy.*"]);
      assert.equal(leftover.trim(), "");
      assert.deepEqual(await installedState(targets[0], 9000), before);
      pass("直连 SSH 安装取消后重新验证连接清理暂存，既有服务保持可用");
    } finally { cancellationBundle.cleanup(); }

    const snapshot = fs.readFileSync(path.join(configRoot, "hosts.json"), "utf8");
    let resolvedConflict = false;
    await assert.rejects(runDeploy([`first=root@${targets[1].host}`, "--port", "9000"], {
      resolveBundle: async () => { resolvedConflict = true; throw new Error("不应解析包"); },
    }), /别名/);
    assert.equal(resolvedConflict, false);
    assert.equal(fs.readFileSync(path.join(configRoot, "hosts.json"), "utf8"), snapshot);
    pass("同名端点冲突在读取包和 SSH 前失败，完整保留其他配置");

    const wrongTrust = createStore(path.join(temporary, "wrong-trust"));
    wrongTrust.saveFingerprint({ host: targets[0].host, sshPort: 22 }, `SHA256:${crypto.randomBytes(32).toString("base64").replace(/=+$/, "")}`);
    let forbiddenPrompts = 0;
    const mismatch = await runDeploy([`mismatch=root@${targets[0].host}`, "--port", "9000"], {
      store: wrongTrust, prompts: { yes: async () => { forbiddenPrompts += 1; return true; }, secret: async () => { forbiddenPrompts += 1; return rootPassword; } },
    });
    assert.equal(mismatch[0].success, false);
    assert.match(mismatch[0].error, /指纹/);
    assert.equal(forbiddenPrompts, 0);
    assert.deepEqual(wrongTrust.loadConfig().hosts, {});
    pass("真实 SSH 主机指纹不匹配拒绝连接，未询问密码");

    let wrongAttempts = 0;
    const badAuth = await runDeploy([`bad-auth=root@${targets[1].host}`, "--port", "9001"], {
      store: createStore(path.join(temporary, "bad-auth")),
      prompts: { yes: async () => true, secret: async () => { wrongAttempts += 1; return wrongPassword; } },
    });
    assert.equal(badAuth[0].success, false);
    assert.equal(wrongAttempts, 3);
    assert.equal(JSON.stringify(badAuth).includes(wrongPassword), false);
    assert.equal(transcript.includes(wrongPassword), false);
    assert.equal(fs.readFileSync(path.join(configRoot, "hosts.json"), "utf8"), snapshot);
    pass("真实 SSH 错误密码有限重试，输出和结果不泄漏密码");

    await assert.rejects(client.callHost("gateway", "deploy.ssh", { action: "inspect", target: { host: "8.8.8.8", sshPort: 22 } }), /IPv4|网段|私网|允许/);
    pass("真实 gateway RPC 拒绝公网 SSH 目标");

    let realInspections = 0;
    const continued = await runDeploy(["failed=root@192.0.2.1", `first=root@${targets[0].host}`, "--port", "9000"], {
      ssh: {
        inspectHost: async (target) => {
          if (target.host === "192.0.2.1") throw new Error("注入单目标 SSH 不可达");
          realInspections += 1;
          return ssh.inspectHost(target);
        },
        installTarget: ssh.installTarget,
      },
    });
    assert.deepEqual(continued.map((result) => result.success), [false, true]);
    assert.equal(realInspections, 1);
    assert.equal(store.loadConfig().hosts.failed, undefined);
    await checkExec("first");
    await checkExec("second");
    assert.deepEqual(await installedState(targets[0], 9000), before);
    pass("CLI 多目标首个失败后继续真实安装，既有 direct/via 均可用");
    for (const secret of secrets) assert.equal(transcript.includes(secret), false, "安装输出泄漏凭据");
    process.stdout.write(`SSH + systemd 部署端到端测试通过 (${passed} 项)\n`);
  } catch (error) {
    if (installLog) process.stderr.write(redact(`安装日志:\n${installLog.slice(-10000)}\n`));
    for (const container of containers) {
      const diagnostic = await docker(["exec", container, "journalctl", "--no-pager", "-u", "remote-exec.service", "-n", "30"]).catch(() => null);
      if (diagnostic?.stdout) process.stderr.write(redact(`${container} 服务日志:\n${diagnostic.stdout}\n`));
    }
    if (gatewayLog) process.stderr.write(redact(`网关日志:\n${gatewayLog.slice(-8000)}\n`));
    throw error;
  } finally {
    await stopDaemon(gateway);
    for (const container of containers) await docker(["rm", "-f", container]).catch(() => {});
    if (networkCreated) await docker(["network", "rm", network]).catch(() => {});
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${redact(error.stack || error.message)}\n`); process.exitCode = 1; });
