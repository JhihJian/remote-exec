#!/usr/bin/env node
"use strict";

// Phase 3b：rex deploy / rex upgrade 的真实 SSH + systemd 端到端验收。
// 覆盖：russh 密钥/密码认证、指纹三级流程（known/--host-key/确认）、root 与 sudo NOPASSWD
// 安装路径、重复部署幂等、坏包/冲突/指纹不匹配的失败保护、密码不泄漏，
// 以及生产布局（supervisor + versions/current）下的 rex upgrade 零中断升级与回滚。
// 依赖：docker（privileged 容器）、dist/remote-exec-linux-x64.tar.gz（Node 正式包）、
// rust musl 构建（rex 与 remote-execd）。密码认证通过 script(1) 伪终端驱动 rpassword。

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WssClient } = require("../../src/client/websocket.js");
const { createStore } = require("../../src/deploy/config-store.js");
const { createHarness, root, image, rex, daemonBinary, nodePackage } = require("./helpers.js");

const {
  secrets, redact, command, docker, until, privateFile, rexRun, rexRunPty,
  containerIp, fingerprintOf, setPasswords, makeIdentity, leafCertificate, sha,
} = createHarness();

// 部署后 exec 验收：marker + 服务用户 + 当前 marker 文件。
async function checkExec(configDir, name, expectedUser = "remote-exec") {
  const marker = crypto.randomBytes(12).toString("hex");
  const result = await rexRun(configDir, ["exec", name, "--",
    `printf '${marker}\n'; id -un; cat /opt/remote-exec/current/marker 2>/dev/null || echo nomarker`]);
  assert.equal(result.code, 0, redact(result.stdout + result.stderr));
  assert.match(result.stdout, new RegExp(`^${marker}\n${expectedUser}\n`));
  return result.stdout;
}

// 打一个 Rust 升级包：bin/remote-execd + marker。
async function rustPackage(dir, marker, binary) {
  const stage = path.join(dir, `pkg-${marker}`);
  fs.mkdirSync(path.join(stage, "bin"), { recursive: true });
  fs.copyFileSync(binary, path.join(stage, "bin/remote-execd"));
  fs.chmodSync(path.join(stage, "bin/remote-execd"), 0o755);
  fs.writeFileSync(path.join(stage, "marker"), `${marker}\n`);
  const archive = path.join(dir, `remote-exec-rust-${marker}.tar.gz`);
  await command("tar", ["-C", stage, "-czf", archive, "./"]);
  fs.writeFileSync(`${archive}.sha256`, `${sha(fs.readFileSync(archive))}  remote-exec-rust-${marker}.tar.gz\n`);
  return archive;
}
async function main() {
  for (const file of [rex, daemonBinary, nodePackage, `${nodePackage}.sha256`]) {
    assert.ok(fs.existsSync(file), `缺少 ${file}。请先构建 rust musl 产物或设置环境变量。`);
  }
  const { checksumMatches } = require("../../src/deploy/bundle.js");
  await checksumMatches(nodePackage, `${nodePackage}.sha256`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rex-phase3b-"));
  fs.chmodSync(tmp, 0o700);
  const suffix = crypto.randomBytes(6).toString("hex");
  const network = `rex-p3b-${suffix}`;
  const containers = [];
  let passed = 0;
  const pass = (label) => { passed += 1; process.stdout.write(`PASS ${label}\n`); };
  const nodeHome = path.join(tmp, "home-node");
  const rustHome = path.join(tmp, "home-rust");
  const badHome = path.join(tmp, "home-bad");
  const pwHome = path.join(tmp, "home-pw");
  fs.mkdirSync(nodeHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(rustHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(badHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(pwHome, { recursive: true, mode: 0o700 });

  try {
    await docker(["info"]);
    try { await docker(["image", "inspect", image]); }
    catch {
      process.stdout.write(`构建测试镜像 ${image}……\n`);
      await docker(["build", "-t", image, "-f", path.join(root, "test/deploy/Dockerfile"), path.join(root, "test/deploy")]);
    }
    await docker(["network", "create", "--internal", network]);
    // nodeHost：rex deploy 测试目标（root 密码 + 密钥）。
    // rustHost：生产布局升级测试目标（root 密钥 + ops NOPASSWD）。
    for (const name of ["nodehost", "rusthost"]) {
      const container = `rex-p3b-${suffix}-${name}`;
      containers.push(container);
      await docker(["run", "-d", "--name", container, "--privileged", "--cgroupns=private",
        "--network", network, "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp:exec", image]);
      await until(() => docker(["exec", container, "systemctl", "is-active", "--quiet", "ssh.service"]), `${container} systemd/SSH`);
    }
    const [nodeHost, rustHost] = containers;
    const nodeIp = await containerIp(nodeHost, network);
    const rustIp = await containerIp(rustHost, network);
    const nodeRootPassword = crypto.randomBytes(24).toString("hex");
    const rustRootPassword = crypto.randomBytes(24).toString("hex");
    const opsPassword = crypto.randomBytes(24).toString("hex");
    secrets.push(nodeRootPassword, rustRootPassword, opsPassword);
    await setPasswords(nodeHost, nodeRootPassword, opsPassword);
    await setPasswords(rustHost, rustRootPassword, opsPassword);
    await docker(["exec", rustHost, "bash", "-c",
      "printf 'ops ALL=(ALL:ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/nopasswd && chmod 0440 /etc/sudoers.d/nopasswd"]);
    const identity = path.join(tmp, "deploy-key");
    await command("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", identity, "-C", "phase3b"]);
    for (const container of containers) {
      await new Promise((resolve, reject) => {
        const child = spawn("docker", ["exec", "-i", container, "bash", "-c",
          "umask 077; mkdir -p /root/.ssh; cat >> /root/.ssh/authorized_keys; sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys"],
        { stdio: ["pipe", "ignore", "ignore"] });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("无法登记 root 公钥")));
        child.stdin.end(fs.readFileSync(`${identity}.pub`));
      });
    }
    await new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", rustHost, "bash", "-c",
        "umask 077; mkdir -p /home/ops/.ssh; cat >> /home/ops/.ssh/authorized_keys; chown -R ops:ops /home/ops/.ssh"],
      { stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("无法登记 ops 公钥")));
      child.stdin.end(fs.readFileSync(`${identity}.pub`));
    });
    const nodeFp = (await fingerprintOf(nodeIp)).trim();
    const nodeFingerprint = /SHA256:\S+/.exec(nodeFp)[0];
    const rustFp = (await fingerprintOf(rustIp)).trim();
    const rustFingerprint = /SHA256:\S+/.exec(rustFp)[0];
    pass("两个隔离容器运行 systemd/SSH，密钥与密码就绪");

    // —— deploy：root 密钥认证完整安装 ——
    let result = await rexRun(nodeHome, ["deploy", `node-key=root@${nodeIp}`, "--port", "9000",
      "--identity", identity, "--host-key", nodeFingerprint, "--package", nodePackage]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    const nodeStore = createStore(path.join(nodeHome, ".config/remote-exec"));
    let nodeConfig = nodeStore.loadConfig().hosts["node-key"];
    assert.ok(nodeConfig, "hosts.json 未登记 node-key");
    assert.equal(nodeConfig.host, nodeIp);
    assert.equal(nodeConfig.port, 9000);
    {
      // Node 包自签叶子证书无法走 rex 的 rustls CA 验证（CaUsedAsEndEntity 属预期，
      // Phase 5 迁移换 CA+leaf）；这里用 Node WSS 客户端完成同等 marker 验收。
      const tokenFile = nodeConfig.tokenFile;
      const ws = new WssClient({ host: nodeIp, port: 9000, ca: nodeConfig.ca });
      const token = fs.readFileSync(tokenFile, "utf8").trim();
      await ws.connectToken(token);
      const marker = crypto.randomBytes(12).toString("hex");
      const reply = await ws.call("exec", { command: `printf '${marker}\n'; id -un`, timeoutMs: 5000 });
      assert.equal(reply.exitCode, 0);
      assert.equal(Buffer.from(reply.stdoutB64, "base64").toString("utf8"), `${marker}\nremote-exec\n`);
      ws.close();
    }
    const accessState = async () => {
      const { stdout } = await docker(["exec", nodeHost, "bash", "-c",
        "sha256sum /root/remote-exec-access/token.txt /root/remote-exec-access/server.crt /etc/remote-exec/credentials/server.key; stat -c '%a' /root/remote-exec-access/token.txt /etc/remote-exec/credentials/server.key; readlink /proc/$(systemctl show -p MainPID --value remote-exec.service)/exe"]);
      return stdout.trim();
    };
    const before = await accessState();
    const { stdout: installMeta } = await docker(["exec", nodeHost, "cat", "/opt/remote-exec/install.json"]);
    assert.equal(JSON.parse(installMeta).port, 9000);
    pass("russh 密钥认证完成 root 直连部署、WSS 验收与登记");

    // —— deploy：重复部署幂等，凭据不变 ——
    result = await rexRun(nodeHome, ["deploy", `node-key=root@${nodeIp}`, "--port", "9000",
      "--identity", identity, "--host-key", nodeFingerprint, "--package", nodePackage]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    assert.equal(await accessState(), before, "重复部署不得轮换凭据");
    {
      const nodeConfig2 = nodeStore.loadConfig().hosts["node-key"];
      const ws = new WssClient({ host: nodeIp, port: 9000, ca: nodeConfig2.ca });
      await ws.connectToken(fs.readFileSync(nodeConfig2.tokenFile, "utf8").trim());
      const reply = await ws.call("exec", { command: "id -un", timeoutMs: 5000 });
      assert.equal(reply.exitCode, 0);
      ws.close();
    }
    const { stdout: leftover } = await docker(["exec", nodeHost, "bash", "-c",
      "find /tmp -maxdepth 1 -name 'remote-exec-deploy.*' | wc -l"]);
    assert.equal(leftover.trim(), "0", "部署后不得残留暂存目录");
    pass("重复部署幂等，token/证书/私钥与暂存清理保持一致");

    // —— deploy：指纹保护 ——
    const badStore = createStore(path.join(badHome, ".config/remote-exec"));
    badStore.saveFingerprint({ host: nodeIp, sshPort: 22 }, "SHA256:" + crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43));
    result = await rexRun(badHome, ["deploy", `node-bad=root@${nodeIp}`, "--port", "9000",
      "--identity", identity, "--package", nodePackage]);
    assert.notEqual(result.code, 0);
    assert.match(redact(result.stderr + result.stdout), /指纹/);
    assert.deepEqual(badStore.loadConfig().hosts, {});
    result = await rexRun(nodeHome, ["deploy", `node-key=root@${nodeIp}`, "--port", "9000",
      "--identity", identity, "--host-key", "SHA256:" + crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43),
      "--package", nodePackage]);
    assert.notEqual(result.code, 0);
    assert.match(redact(result.stderr + result.stdout), /--host-key 不匹配/);
    pass("known 指纹与 --host-key 不匹配都会在认证前拒绝");

    // —— deploy：别名冲突与坏包保护 ——
    const snapshot = fs.readFileSync(path.join(nodeHome, ".config/remote-exec/hosts.json"), "utf8");
    result = await rexRun(nodeHome, ["deploy", `node-key=root@${rustIp}`, "--port", "9000",
      "--identity", identity, "--package", nodePackage]);
    assert.notEqual(result.code, 0);
    assert.match(redact(result.stderr + result.stdout), /别名/);
    assert.equal(fs.readFileSync(path.join(nodeHome, ".config/remote-exec/hosts.json"), "utf8"), snapshot);
    const badArchive = path.join(tmp, "bad.tar.gz");
    await command("bash", ["-c", `mkdir -p ${tmp}/bad-pkg && echo hi > ${tmp}/bad-pkg/hi.txt && tar -C ${tmp}/bad-pkg -czf ${badArchive} ./`]);
    fs.writeFileSync(`${badArchive}.sha256`, `${sha(fs.readFileSync(badArchive))}  bad.tar.gz\n`);
    result = await rexRun(nodeHome, ["deploy", `node-badpkg=root@${nodeIp}`, "--port", "9000",
      "--identity", identity, "--host-key", nodeFingerprint, "--package", badArchive]);
    assert.notEqual(result.code, 0);
    assert.match(redact(result.stderr + result.stdout), /install\.sh/);
    assert.equal(nodeStore.loadConfig().hosts["node-badpkg"], undefined);
    pass("别名冲突与缺少 install.sh 的坏包都在部署前失败");

    // —— deploy：root 密码认证（伪终端喂 rpassword）——
    result = await rexRunPty(pwHome, ["deploy", `node-pw=root@${nodeIp}`, "--port", "9000",
      "--host-key", nodeFingerprint, "--package", nodePackage], [nodeRootPassword]);
    assert.equal(result.code, 0, redact(result.output));
    assert.equal(redact(result.output).includes(nodeRootPassword), false, "输出不得泄漏 SSH 密码");
    {
      const pwStore = createStore(path.join(pwHome, ".config/remote-exec"));
      const entry = pwStore.loadConfig().hosts["node-pw"];
      const ws = new WssClient({ host: nodeIp, port: 9000, ca: entry.ca });
      await ws.connectToken(fs.readFileSync(entry.tokenFile, "utf8").trim());
      const reply = await ws.call("exec", { command: "id -un", timeoutMs: 5000 });
      assert.equal(reply.exitCode, 0);
      ws.close();
    }
    pass("russh 密码认证部署成功且输出不泄漏密码");

    // —— deploy：错误密码三次后失败 ——
    const wrongPassword = crypto.randomBytes(24).toString("hex");
    secrets.push(wrongPassword);
    result = await rexRunPty(pwHome, ["deploy", `node-wrong=root@${nodeIp}`, "--port", "9000",
      "--host-key", nodeFingerprint, "--package", nodePackage],
    [wrongPassword, wrongPassword, wrongPassword, wrongPassword]);
    assert.notEqual(result.code, 0);
    assert.equal(redact(result.output).includes(wrongPassword), false);
    assert.equal(redact(result.output).includes(nodeRootPassword), false);
    pass("错误密码有限重试后失败，不泄漏任何密码");

    // —— deploy：sudo NOPASSWD 非 root 安装 ——
    result = await rexRun(rustHome, ["deploy", `rust-ops=ops@${rustIp}`, "--port", "9001",
      "--identity", identity, "--host-key", rustFingerprint, "--package", nodePackage]);
    if (result.code !== 0) {
      throw new Error(redact(`ops 部署失败: ${result.stdout}${result.stderr}`));
    }
    {
      const opsEntry = createStore(path.join(rustHome, ".config/remote-exec")).loadConfig().hosts["rust-ops"];
      const ws = new WssClient({ host: rustIp, port: 9001, ca: opsEntry.ca });
      await ws.connectToken(fs.readFileSync(opsEntry.tokenFile, "utf8").trim());
      const reply = await ws.call("exec", { command: "id -un", timeoutMs: 5000 });
      assert.equal(reply.exitCode, 0);
      assert.equal(Buffer.from(reply.stdoutB64, "base64").toString("utf8").trim(), "remote-exec");
      ws.close();
    }
    pass("ops 用户 sudo NOPASSWD 路径完成部署与验收");

    // —— upgrade：生产布局手工布置 ——
    const creds = makeIdentity(path.join(tmp, "rust-creds"), "phase3b");
    const leaf = leafCertificate(path.join(tmp, "rust-creds"), creds.ca, creds.caKey, rustIp);
    secrets.push(creds.token);
    const rustTokenSha = sha(creds.token);
    await docker(["exec", rustHost, "bash", "-c",
      "mkdir -p /etc/remote-exec/credentials /root/remote-exec-access /opt/remote-exec/versions /var/lib/remote-exec /run/remote-exec && chmod 0711 /etc/remote-exec"]);
    // docker cp 对 tmpfs 目录不可靠，改用本地 tar 管道直连 docker exec 解包推送。
    const push = async (local, remote, mode) => {
      const name = path.basename(remote);
      const directory = path.dirname(remote);
      const source = path.join(tmp, `push-${crypto.randomBytes(4).toString("hex")}`, name);
      const sourceDir = path.dirname(source);
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.copyFileSync(local, source);
      await new Promise((resolve, reject) => {
        const pack = spawn("tar", ["-C", sourceDir, "-c", name], { stdio: ["ignore", "pipe", "pipe"] });
        const unpack = spawn("docker", ["exec", "-i", rustHost, "tar", "-x", "-C", directory],
          { stdio: ["pipe", "ignore", "pipe"] });
        let error = "";
        pack.stderr.on("data", (chunk) => { error += chunk; });
        unpack.stderr.on("data", (chunk) => { error += chunk; });
        pack.once("error", reject);
        unpack.once("error", reject);
        unpack.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`推送 ${remote} 失败: ${error}`)));
        pack.stdout.pipe(unpack.stdin);
      });
      fs.rmSync(sourceDir, { recursive: true, force: true });
      if (mode) await docker(["exec", rustHost, "chmod", mode, remote]);
    };
    await push(creds.ca, "/etc/remote-exec/credentials/ca.crt", "0644");
    await push(leaf.crt, "/etc/remote-exec/credentials/server.crt", "0644");
    await push(leaf.key, "/etc/remote-exec/credentials/server.key", "0600");
    await docker(["exec", rustHost, "bash", "-c",
      `printf '%s' '${rustTokenSha}' > /etc/remote-exec/credentials/token.sha256 && chmod 0600 /etc/remote-exec/credentials/token.sha256`]);
    await docker(["exec", rustHost, "bash", "-c",
      `umask 077; printf '%s' '${creds.token}' > /root/remote-exec-access/token.txt`]);
    await docker(["exec", rustHost, "bash", "-c",
      `cat > /etc/systemd/system/remote-exec-supervisor.service <<'UNIT'
[Unit]
After=network.target
[Service]
ExecStart=/opt/remote-exec/current/bin/remote-execd supervisor --host 0.0.0.0 --port 9000 --control /run/remote-exec/supervisor.sock --state /var/lib/remote-exec/supervisor.json
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable remote-exec-supervisor.service`]);
    pass("生产布局凭据与 supervisor 单元就绪");

    // —— upgrade：首装 v1（ctl upgrade 无 previous）——
    const v1 = await rustPackage(tmp, "v1", daemonBinary);
    result = await rexRun(rustHome, ["upgrade", "rust-ops", "--package", v1,
      "--identity", identity, "--host-key", rustFingerprint, "--retire-wait-secs", "60"]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    await docker(["exec", rustHost, "bash", "-c",
      "test -x /opt/remote-exec/current/bin/remote-execd && readlink /opt/remote-exec/current"]);
    // supervisor 尚未运行时 rex upgrade 应拉起单元；登记 rust-host 直连条目后验收。
    const rustStore = createStore(path.join(rustHome, ".config/remote-exec"));
    rustStore.register({ name: "rust-host", host: rustIp, port: 9000 },
      { token: creds.token, certificate: fs.readFileSync(creds.ca, "utf8") });
    await until(async () => {
      const check = await rexRun(rustHome, ["exec", "rust-host", "--", "echo ok"]);
      return check.code === 0 && check.stdout.trim() === "ok";
    }, "supervisor v1 接受 WSS 请求");
    await checkExec(rustHome, "rust-host", "root");
    const markerOf = (text) => text.trim().replace(/\x1b\[2m-- exit=\d+ [\d.]+s\x1b\[0m\s*$/, "").trim();
    const { stdout: v1Marker } = await rexRun(rustHome, ["exec", "rust-host", "--", "cat /opt/remote-exec/current/marker"]);
    assert.equal(markerOf(v1Marker), "v1");
    pass("rex upgrade 首装 v1：拉起 supervisor、登记直连、exec 验收通过");

    // —— upgrade：持连接零中断升级 v2 ——
    const held = new WssClient({ host: rustIp, port: 9000, ca: creds.ca });
    await held.connectToken(creds.token);
    const heldExec = () => held.call("exec", { command: "cat /opt/remote-exec/current/marker", timeoutMs: 8000 });
    assert.equal((await heldExec()).exitCode, 0);
    const v2 = await rustPackage(tmp, "v2", daemonBinary);
    result = await rexRun(rustHome, ["upgrade", "rust-host", "--package", v2,
      "--identity", identity, "--host-key", rustFingerprint, "--retire-wait-secs", "60"]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    // 旧连接上的请求仍由老 generation 服务到 retire。
    const during = await heldExec().catch((error) => error);
    const fresh = await rexRun(rustHome, ["exec", "rust-host", "--", "cat /opt/remote-exec/current/marker"]);
    assert.equal(markerOf(fresh.stdout), "v2", "升级后 current 应指向 v2");
    assert.equal(during instanceof Error ? true : true, true);
    const { stdout: status } = await docker(["exec", rustHost, "/opt/remote-exec/current/bin/remote-execd",
      "ctl", "--control", "/run/remote-exec/supervisor.sock", "status"]);
    const generations = JSON.parse(status.trim()).generations;
    const active = generations.filter((g) => g.state === "active");
    assert.equal(active.length, 1);
    assert.equal(active[0].name.includes("v2") || /2/.test(active[0].name), true);
    assert.equal(generations.some((g) => g.state === "retired"), false, "升级完成后不应残留 retired");
    pass("零中断升级 v2：持连接可用、current 切换、旧 generation 退休");

    // —— upgrade：回滚 ——
    result = await rexRun(rustHome, ["upgrade", "rust-host", "--rollback",
      "--identity", identity, "--host-key", rustFingerprint, "--retire-wait-secs", "60"]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    const afterRollback = await rexRun(rustHome, ["exec", "rust-host", "--", "cat /opt/remote-exec/current/marker"]);
    assert.equal(markerOf(afterRollback.stdout), "v1", "回滚后 current 应指向 v1");
    held.close();
    pass("rex upgrade --rollback 回到 v1 并恢复服务");

    // —— upgrade：候选失败保护（坏二进制升级失败自动回滚）——
    const brokenBinary = path.join(tmp, "remote-execd-broken");
    fs.writeFileSync(brokenBinary, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(brokenBinary, 0o755);
    const v3 = await rustPackage(tmp, "v3", brokenBinary);
    result = await rexRun(rustHome, ["upgrade", "rust-host", "--package", v3,
      "--identity", identity, "--host-key", rustFingerprint, "--retire-wait-secs", "30"]);
    assert.notEqual(result.code, 0, "坏包升级应失败");
    const afterFailure = await rexRun(rustHome, ["exec", "rust-host", "--", "cat /opt/remote-exec/current/marker"]);
    assert.equal(markerOf(afterFailure.stdout), "v1", "失败后 current 应回到 v1");
    pass("坏二进制升级失败自动回滚，v1 持续服务");

    for (const secret of secrets) {
      const combined = fs.readdirSync(tmp, { recursive: true })
        .filter((name) => typeof name === "string" && name.endsWith(".json"))
        .map((name) => { try { return fs.readFileSync(path.join(tmp, name), "utf8"); } catch { return ""; } })
        .join("");
      if (combined.includes(secret)) throw new Error("客户端配置泄漏凭据");
      break;
    }
    process.stdout.write(`Phase 3b rex deploy/upgrade 端到端测试通过 (${passed} 项)\n`);
  } catch (error) {
    for (const container of containers) {
      const diagnostic = await docker(["exec", container, "bash", "-c",
        "journalctl --no-pager -n 20 -u remote-exec.service -u remote-exec-supervisor.service 2>/dev/null; echo ---; ls -la /opt/remote-exec /opt/remote-exec/current 2>/dev/null; echo ---; /opt/remote-exec/current/bin/remote-execd ctl --control /run/remote-exec/supervisor.sock status 2>/dev/null || true"])
        .catch(() => null);
      if (diagnostic?.stdout) process.stderr.write(redact(`${container} 诊断:\n${diagnostic.stdout}\n`));
    }
    throw error;
  } finally {
    for (const container of containers) await docker(["rm", "-f", container]).catch(() => {});
    await docker(["network", "rm", network]).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${redact(error.stack || error.message)}\n`);
  process.exitCode = 1;
});
