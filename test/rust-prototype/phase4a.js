#!/usr/bin/env node
// Phase 4a 端到端：rex deploy --via 网关部署（daemon deploy.ssh RPC）。
// 拓扑：宿主 rex → 网关容器(Rust daemon 8791/8792) --SSH--> 目标容器(systemd+sshd)。
// 覆盖：密钥/密码/sudo 认证、relay 验收与登记、幂等、指纹拒绝、
// 网段校验拒绝、暂存上限、两侧暂存清理、输出脱敏。
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WssClient } = require("../../src/client/websocket.js");
const { createStore } = require("../../src/deploy/config-store.js");
const { createHarness, root, image, rex, rexOps, daemonBinary, serverPackage } = require("./helpers.js");

const {
  secrets, redact, command, docker, until, privateFile, rexRun, rexOpsRun, rexOpsRunPty,
  containerIp, fingerprintOf, setPasswords, pushFile, makeIdentity,
  leafCertificate, sha,
} = createHarness();

async function gatewayDaemon(container, dir, name, ip, port, relayAllow) {
  const identity = makeIdentity(dir, name);
  const leaf = leafCertificate(dir, identity.ca, identity.caKey, ip);
  // 同容器双 daemon：各自独立目录，避免二进制互相覆盖（运行中改写会 ETXTBSY）。
  const remote = `/root/${name}`;
  const quote = (text) => `'${String(text).replace(/'/g, `'\''`)}'`;
  await docker(["exec", container, "mkdir", "-p", remote]);
  await pushFile(container, daemonBinary, `${remote}/remote-execd`, 0o755);
  await pushFile(container, leaf.crt, `${remote}/gw.crt`);
  await pushFile(container, leaf.key, `${remote}/gw.key`, 0o600);
  await pushFile(container, path.join(dir, "token.sha256"), `${remote}/token.sha256`);
  const allowArgs = relayAllow ? ["--relay-allow", relayAllow] : [];
  await docker(["exec", "-d", container, "bash", "-c",
    [`cd ${quote(remote)} &&`, "./remote-execd daemon",
      `--host 0.0.0.0 --port ${port}`,
      `--cert ${quote(`${remote}/gw.crt`)} --key ${quote(`${remote}/gw.key`)}`,
      `--token-sha256-file ${quote(`${remote}/token.sha256`)}`,
      ...allowArgs, `> /root/daemon-${port}.log 2>&1`].join(" ")]);
  await until(async () => {
    await command("bash", ["-c", `timeout 2 bash -c 'echo > /dev/tcp/${ip}/${port}'`]);
  }, `网关 daemon ${name} 就绪`);
  return identity;
}
function registerGateway(configDir, name, ip, port, identity) {
  const store = createStore(path.join(configDir, ".config/remote-exec"));
  store.register({ name, host: ip, port, sshPort: 22 },
    { token: identity.token, certificate: fs.readFileSync(identity.ca, "utf8") });
  return store;
}
// 部署后经网关 relay 验收登记主机。
async function checkExecViaRelay(configDir, name, expectedUser = "remote-exec") {
  const marker = crypto.randomBytes(12).toString("hex");
  const result = await rexRun(configDir, ["exec", name, "--",
    `printf '${marker}\\n'; id -un`]);
  assert.equal(result.code, 0, redact(result.stdout + result.stderr));
  assert.match(result.stdout, new RegExp(`^${marker}\\n${expectedUser}\\n`));
}

async function main() {
  for (const file of [rex, rexOps, daemonBinary, serverPackage, `${serverPackage}.sha256`]) {
    assert.ok(fs.existsSync(file), `缺少 ${file}。请先构建 rust musl 产物或设置环境变量。`);
  }
  const { checksumMatches } = require("../../src/deploy/bundle.js");
  await checksumMatches(serverPackage, `${serverPackage}.sha256`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rex-phase4a-"));
  fs.chmodSync(tmp, 0o700);
  const suffix = crypto.randomBytes(6).toString("hex");
  const network = `rex-p4a-${suffix}`;
  const gwContainer = `rex-p4a-${suffix}-gw`;
  const tgtContainer = `rex-p4a-${suffix}-tgt`;
  let passed = 0;
  const pass = (label) => { passed += 1; process.stdout.write(`PASS ${label}\n`); };
  const homeMain = path.join(tmp, "home-main");
  const homeBad = path.join(tmp, "home-bad");
  const homePw = path.join(tmp, "home-pw");
  const homeOps = path.join(tmp, "home-ops");
  for (const home of [homeMain, homeBad, homePw, homeOps]) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  }

  try {
    await docker(["info"]);
    try { await docker(["image", "inspect", image]); }
    catch {
      process.stdout.write(`构建测试镜像 ${image}……\n`);
      await docker(["build", "-t", image, "-f", path.join(root, "test/deploy/Dockerfile"), path.join(root, "test/deploy")]);
    }
    await docker(["network", "create", "--internal", network]);
    for (const [name] of [["gw"], ["tgt"]]) {
      await docker(["run", "-d", "--name", `rex-p4a-${suffix}-${name}`, "--privileged", "--cgroupns=private",
        "--network", network, "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp:exec", image]);
    }
    await until(() => docker(["exec", tgtContainer, "systemctl", "is-active", "--quiet", "ssh.service"]), `${tgtContainer} systemd/SSH`);
    const gwIp = await containerIp(gwContainer, network);
    const tgtIp = await containerIp(tgtContainer, network);
    const rootPassword = crypto.randomBytes(24).toString("hex");
    const opsPassword = crypto.randomBytes(24).toString("hex");
    secrets.push(rootPassword, opsPassword);
    await setPasswords(tgtContainer, rootPassword, opsPassword);
    const identity = path.join(tmp, "deploy-key");
    await command("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", identity, "-C", "phase4a"]);
    await new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", tgtContainer, "bash", "-c",
        "umask 077; mkdir -p /root/.ssh; cat >> /root/.ssh/authorized_keys; sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys"],
      { stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("无法登记 root 公钥")));
      child.stdin.end(fs.readFileSync(`${identity}.pub`));
    });
    const tgtFp = (await fingerprintOf(tgtIp)).trim();
    const tgtFingerprint = /SHA256:\S+/.exec(tgtFp)[0];

    // 两个网关 daemon：gw 默认私网放行，gw2 只放行 10/8（用于网段校验拒绝）。
    const gw1 = await gatewayDaemon(gwContainer, path.join(tmp, "gw1"), "gw1", gwIp, 8791, null);
    const gw2 = await gatewayDaemon(gwContainer, path.join(tmp, "gw2"), "gw2", gwIp, 8792, "10.0.0.0/8");
    for (const home of [homeMain, homeBad, homePw, homeOps]) {
      registerGateway(home, "gw", gwIp, 8791, gw1);
      registerGateway(home, "gw2", gwIp, 8792, gw2);
    }
    pass("网关 daemon（默认放行/受限放行）与目标容器就绪");

    // —— 密钥认证网关部署 + relay 验收 + 登记 ——
    let result = await rexOpsRun(homeMain, ["deploy", "--via", "gw", `tgt-key=root@${tgtIp}`,
      "--port", "9000", "--identity", identity, "--host-key", tgtFingerprint, "--package", serverPackage]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    const mainStore = createStore(path.join(homeMain, ".config/remote-exec"));
    let registered = mainStore.loadConfig().hosts["tgt-key"];
    assert.ok(registered, "hosts.json 未登记 tgt-key");
    assert.equal(registered.host, tgtIp);
    assert.equal(registered.port, 9000);
    assert.equal(registered.via, "gw");
    await checkExecViaRelay(homeMain, "tgt-key");
    const { stdout: gwLeftover } = await docker(["exec", gwContainer, "bash", "-c",
      "find /tmp -maxdepth 1 -name 'remote-exec-deploy-*' | wc -l"]);
    assert.equal(gwLeftover.trim(), "0", "网关不得残留暂存目录");
    const { stdout: tgtLeftover } = await docker(["exec", tgtContainer, "bash", "-c",
      "find /tmp -maxdepth 1 -name 'remote-exec-deploy.*' | wc -l"]);
    assert.equal(tgtLeftover.trim(), "0", "目标不得残留暂存目录");
    pass("密钥认证经网关部署成功，relay 验收与登记正常，两侧暂存已清理");

    // —— 幂等重装：凭据与文件状态不变 ——
    const accessState = async () => {
      const { stdout } = await docker(["exec", tgtContainer, "bash", "-c",
        "sha256sum /root/remote-exec-access/token.txt /root/remote-exec-access/server.crt /etc/remote-exec/credentials/server.key; stat -c '%a' /root/remote-exec-access/token.txt /etc/remote-exec/credentials/server.key"]);
      return stdout.trim();
    };
    const before = await accessState();
    result = await rexOpsRun(homeMain, ["deploy", "--via", "gw", `tgt-key=root@${tgtIp}`,
      "--port", "9000", "--identity", identity, "--host-key", tgtFingerprint, "--package", serverPackage]);
    assert.equal(result.code, 0, redact(result.stdout + result.stderr));
    assert.equal(await accessState(), before, "重复部署不得轮换凭据");
    await checkExecViaRelay(homeMain, "tgt-key");
    pass("网关部署幂等，凭据不变");

    // —— 指纹保护（known 与 --host-key 双路径）——
    const badStore = createStore(path.join(homeBad, ".config/remote-exec"));
    badStore.saveFingerprint({ host: tgtIp, sshPort: 22 },
      "SHA256:" + crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43));
    result = await rexOpsRun(homeBad, ["deploy", "--via", "gw", `tgt-bad=root@${tgtIp}`,
      "--port", "9000", "--identity", identity, "--package", serverPackage]);
    assert.notEqual(result.code, 0);
    assert.match(redact(result.stderr + result.stdout), /指纹/);
    result = await rexOpsRun(homeMain, ["deploy", "--via", "gw", `tgt-hk=root@${tgtIp}`,
      "--port", "9000", "--identity", identity,
      "--host-key", "SHA256:" + crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43),
      "--package", serverPackage]);
    assert.notEqual(result.code, 0);
    assert.match(redact(result.stderr + result.stdout), /--host-key 不匹配/);
    assert.equal(mainStore.loadConfig().hosts["tgt-hk"], undefined);
    pass("known 指纹与 --host-key 不匹配都会在认证前拒绝");

    // —— 网段校验：gw2 只放行 10/8，docker 网段目标必须被拒 ——
    result = await rexOpsRun(homeMain, ["deploy", "--via", "gw2", `tgt-allow=root@${tgtIp}`,
      "--port", "9000", "--identity", identity, "--host-key", tgtFingerprint, "--package", serverPackage]);
    assert.notEqual(result.code, 0);
    assert.match(redact(result.stderr + result.stdout), /允许网段/);
    assert.equal(mainStore.loadConfig().hosts["tgt-allow"], undefined);
    pass("受限网段网关拒绝非白名单目标");

    // —— root 密码认证（网关 SSH）+ 输出脱敏 ——
    result = await rexOpsRunPty(homePw, ["deploy", "--via", "gw", `tgt-pw=root@${tgtIp}`,
      "--port", "9000", "--host-key", tgtFingerprint, "--package", serverPackage], [rootPassword]);
    assert.equal(result.code, 0, redact(result.output));
    assert.ok(!result.output.includes(rootPassword), "密码不得出现在部署输出");
    const pwStore = createStore(path.join(homePw, ".config/remote-exec"));
    const pwRegistered = pwStore.loadConfig().hosts["tgt-pw"];
    assert.ok(pwRegistered?.tokenFile, "密码部署未登记");
    const targetToken = (await docker(["exec", tgtContainer, "cat", "/root/remote-exec-access/token.txt"])).stdout.trim();
    secrets.push(targetToken);
    assert.ok(!result.output.includes(targetToken), "目标 token 不得出现在部署输出");
    pass("root 密码认证经网关部署成功且输出脱敏");

    // —— 非根 sudo 认证（SUDO_PASSWORD_REQUIRED 经网关传递）——
    result = await rexOpsRunPty(homeOps, ["deploy", "--via", "gw", `tgt-ops=ops@${tgtIp}`,
      "--port", "9000", "--host-key", tgtFingerprint, "--package", serverPackage], [opsPassword, opsPassword]);
    assert.equal(result.code, 0, redact(result.output));
    assert.ok(!result.output.includes(opsPassword), "sudo 密码不得出现在部署输出");
    pass("非根 sudo 认证经网关部署成功");

    // —— 暂存上限：4 个并发 prepare，第 5 个被拒，cleanup 后恢复 ——
    {
      const ws = new WssClient({ host: gwIp, port: 8791, ca: gw1.ca });
      await ws.connectToken(gw1.token);
      const ids = [];
      for (let i = 0; i < 4; i += 1) {
        const reply = await ws.call("deploy.ssh", { action: "prepare" });
        assert.ok(reply.id, "prepare 未返回暂存标识");
        ids.push(reply.id);
      }
      await assert.rejects(() => ws.call("deploy.ssh", { action: "prepare" }), /上限/);
      for (const id of ids) await ws.call("deploy.ssh", { action: "cleanup", id });
      const again = await ws.call("deploy.ssh", { action: "prepare" });
      await ws.call("deploy.ssh", { action: "cleanup", id: again.id });
      ws.close();
      const { stdout: after } = await docker(["exec", gwContainer, "bash", "-c",
        "find /tmp -maxdepth 1 -name 'remote-exec-deploy-*' | wc -l"]);
      assert.equal(after.trim(), "0", "cleanup 后不得残留暂存目录");
      pass("暂存上限 4 个，超限拒绝，cleanup 后恢复");
    }

    process.stdout.write(`\n全部通过：${passed}\n`);
  } finally {
    if (process.env.REX_TEST_KEEP === "1") {
      process.stderr.write(`保留现场: 容器 ${gwContainer} ${tgtContainer}，网络 ${network}，临时目录 ${tmp}\n`);
    } else {
      await docker(["rm", "-f", gwContainer, tgtContainer]).catch(() => {});
      await docker(["network", "rm", network]).catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${redact(error?.stack || error)}\n`);
  process.exit(1);
});
