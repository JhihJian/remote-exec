"use strict";
// Phase 2 loopback 全流程验收：ctl upgrade 编排（解包/端口分配/promote/链接）、
// 路由切换与在途连接保持、两段式不隐式 retire、回滚、retire 保护、
// 重启恢复（active respawn + stale 清理）、候选失败保护、state 损坏拒绝。
// 用法：node test/rust-prototype/phase2.js
//   RUST_PROTOTYPE_BINARY 指定二进制（默认 musl release）。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, "../..");
const BINARY = process.env.RUST_PROTOTYPE_BINARY
  || path.join(ROOT, "rust/target/x86_64-unknown-linux-musl/release/remote-execd");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tempDir;
const supervisors = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function startSupervisor(port) {
  const child = spawn(BINARY, [
    "supervisor", "--host", "127.0.0.1", "--port", String(port),
    "--control", path.join(tempDir, "supervisor.sock"),
    "--state", path.join(tempDir, "state.json"),
  ], { stdio: ["ignore", "ignore", "pipe"] });
  supervisors.push(child);
  return new Promise((resolve, reject) => {
    let log = "";
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => reject(new Error(`supervisor 提前退出 (${code}): ${log}`)));
    (async () => {
      for (let i = 0; i < 250 && !log.includes("listening"); i += 1) await wait(20);
      log.includes("listening") ? resolve(child) : reject(new Error(`supervisor 未就绪: ${log}`));
    })();
  });
}

const stopSupervisor = async (sup) => {
  if (sup.exitCode !== null) return;
  sup.kill("SIGTERM");
  await new Promise((resolve) => sup.once("exit", resolve));
};

function ctl(args, { expectFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(BINARY, ["ctl", "--control", path.join(tempDir, "supervisor.sock"), ...args], (error, stdout, stderr) => {
      if (error && !expectFailure) {
        reject(new Error(`ctl ${args.join(" ")} 失败: ${stderr || stdout}`));
      } else if (!error && expectFailure) {
        reject(new Error(`ctl ${args.join(" ")} 应失败但成功了: ${stdout}`));
      } else {
        resolve({ stdout, stderr, code: error ? error.code : 0 });
      }
    });
  });
}

const find = (status, name) => status.generations.find((generation) => generation.name === name);
const pidOf = (generation) => generation.process && generation.process.pid;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    // 兜底：连接销毁后对端 RST 不应成为未处理异常。
    socket.on("error", () => {});
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/// 在 keep-alive 连接上发一次 GET，解析并返回正文。
function request(socket, pathName) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      socket.off("data", onData);
      resolve(buffer.slice(headerEnd + 4).trim());
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`GET ${pathName} HTTP/1.1\r\nHost: t\r\nConnection: keep-alive\r\n\r\n`);
  });
}

// 包内 HTTP 服务：读同目录 marker 作为 tag，--port 监听回环，正文 "<tag><path>"。
const BACKEND_SCRIPT = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const tag = fs.readFileSync(path.join(__dirname, "marker"), "utf8").trim();
http.createServer((req, res) => {
  const body = tag + req.url + "\\n";
  res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}).listen(port, "127.0.0.1");
`;

/// 构造升级包：marker + backend.js，command 用 {version_dir} 引用解包路径。
async function buildPackage(name) {
  const pkgDir = path.join(tempDir, `pkg-src-${name}`);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "marker"), name);
  fs.writeFileSync(path.join(pkgDir, "backend.js"), BACKEND_SCRIPT);
  const tarPath = path.join(tempDir, `${name}.tar.gz`);
  await execFileAsync("tar", ["-czf", tarPath, "-C", pkgDir, "."]);
  const sha256 = await execFileAsync("sha256sum", [tarPath]);
  return { tarPath, sha256: sha256.stdout.trim().split(/\s+/)[0] };
}

async function upgrade(pkg) {
  const versionsDir = path.join(tempDir, "opt", "versions");
  const currentLink = path.join(tempDir, "opt", "current");
  const result = await ctl([
    "upgrade", "--package", pkg.tarPath, "--sha256", pkg.sha256,
    "--versions-dir", versionsDir, "--link", currentLink,
    "--", process.execPath, "{version_dir}/backend.js",
  ]);
  return JSON.parse(result.stdout);
}

async function main() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rust-phase2-"));
  const supervisorPort = await freePort();
  const versionsDir = path.join(tempDir, "opt", "versions");
  const currentLink = path.join(tempDir, "opt", "current");

  // 场景 A：首次安装 → 在途连接 → 二次升级 → 回滚 → retire 保护与两段式
  {
    let supervisor = await startSupervisor(supervisorPort);
    const initial = JSON.parse((await ctl(["status"])).stdout);
    assert.equal(initial.active, null, "初始无 active");

    const v1 = await buildPackage("v1");
    const first = await upgrade(v1);
    assert.ok(first.generation, "首次安装应返回 generation");
    assert.equal(first.previous, null, "首次安装 previous 为空");
    const v1Name = first.generation;
    assert.equal(fs.readFileSync(path.join(currentLink, "marker"), "utf8"), "v1", "current 链接指向 v1");

    // 首个客户端连接路由到 v1
    const held = await connect(supervisorPort);
    assert.equal(await request(held, "/probe"), "v1/probe", "新连接应路由到 v1");

    // 二次升级：升级过程中 held 连接保持，升级后旧连接仍由 v1 服务、新连接切到 v2
    const v2 = await buildPackage("v2");
    const second = await upgrade(v2);
    assert.equal(second.previous, v1Name, "二次升级 previous 为 v1");
    const v2Name = second.generation;
    assert.equal(fs.readFileSync(path.join(currentLink, "marker"), "utf8"), "v2", "current 链接指向 v2");

    const afterUpgrade = JSON.parse((await ctl(["status"])).stdout);
    assert.equal(afterUpgrade.active, v2Name, "升级后 active 为 v2");
    assert.equal(find(afterUpgrade, v1Name).state, "draining", "旧版本进入 draining");
    assert.equal(await request(held, "/inflight"), "v1/inflight", "升级后旧连接仍由 v1 服务（零中断）");
    const fresh = await connect(supervisorPort);
    assert.equal(await request(fresh, "/fresh"), "v2/fresh", "新连接应路由到 v2");
    fresh.destroy();
    held.destroy();

    // 回滚：active 回到 v1，v2 进入 draining
    await ctl(["rollback"]);
    const afterRollback = JSON.parse((await ctl(["status"])).stdout);
    assert.equal(afterRollback.active, v1Name, "回滚后 active 为 v1");
    const rollbackConn = await connect(supervisorPort);
    assert.equal(await request(rollbackConn, "/rb"), "v1/rb", "回滚后新连接路由到 v1");
    rollbackConn.destroy();

    // retire 保护：active 不能 retire
    await ctl(["retire", v1Name], { expectFailure: true });

    // retire v2（draining 无连接，managed）：进程被终止、记录删除
    const v2Pid = pidOf(find(afterRollback, v2Name));
    await ctl(["retire", v2Name]);
    const afterRetire = JSON.parse((await ctl(["status"])).stdout);
    assert.equal(find(afterRetire, v2Name), undefined, "v2 应被 retire");
    assert.ok(!alive(v2Pid), "v2 托管进程应被终止");
    assert.ok(find(afterRetire, v1Name), "两段式：v1 在显式 retire 前保留");
    console.log("PASS 场景A：升级编排、在途零中断、回滚、retire 保护与两段式");
    await stopSupervisor(supervisor);
  }

  // 场景 B：重启恢复（active managed respawn）与 stale 清理
  {
    let supervisor = await startSupervisor(supervisorPort);
    const before = JSON.parse((await ctl(["status"])).stdout);
    assert.ok(before.active, "重启后应恢复 active");
    const activeName = before.active;
    assert.ok(pidOf(find(before, activeName)), "重启后 active managed 应重新拉起");
    const respawnConn = await connect(supervisorPort);
    assert.equal(await request(respawnConn, "/revived"), "v1/revived", "respawn 后路由仍可用");
    respawnConn.destroy();
    await stopSupervisor(supervisor);

    // 注入 stale managed draining，重启后应被清理且不影响 active
    const statePath = path.join(tempDir, "state.json");
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    raw.generations.push({
      name: "stale-draining", state: "draining", managed: true,
      backend: { host: "127.0.0.1", port: 2, protocol: "http", ca: null },
      command: ["/bin/sleep", "300"], cwd: null, env: {}, previous: null,
    });
    fs.writeFileSync(statePath, JSON.stringify(raw));
    supervisor = await startSupervisor(supervisorPort);
    const after = JSON.parse((await ctl(["status"])).stdout);
    assert.equal(find(after, "stale-draining"), undefined, "stale managed draining 应被清理");
    assert.equal(after.active, activeName, "active 不受清理影响");
    await stopSupervisor(supervisor);
    console.log("PASS 场景B：重启恢复 respawn 与 stale 清理");
  }

  // 场景 C：候选失败保护与坏包拒绝
  {
    let supervisor = await startSupervisor(supervisorPort);
    const before = JSON.parse((await ctl(["status"])).stdout);
    const activeName = before.active;

    // readiness 失败：command 是 sleep（永不监听端口），promote 超时后清理候选
    const bad = await buildPackage("bad");
    await ctl([
      "upgrade", "--package", bad.tarPath, "--sha256", bad.sha256,
      "--versions-dir", versionsDir, "--link", currentLink,
      "--", "/bin/sleep", "60",
    ], { expectFailure: true });
    const afterBad = JSON.parse((await ctl(["status"])).stdout);
    assert.equal(afterBad.active, activeName, "候选失败应保持 active 不变");
    assert.equal(afterBad.generations.length, before.generations.length, "候选应被清理不留记录");

    // SHA 不匹配拒绝且不落盘
    const good = await buildPackage("good");
    const dirCountBefore = fs.readdirSync(versionsDir).length;
    await ctl([
      "upgrade", "--package", good.tarPath, "--sha256", "0".repeat(64),
      "--versions-dir", versionsDir, "--link", currentLink,
      "--", process.execPath, "{version_dir}/backend.js",
    ], { expectFailure: true });
    assert.equal(fs.readdirSync(versionsDir).length, dirCountBefore, "坏 SHA 不应解包落盘");
    console.log("PASS 场景C：候选失败保护与坏包拒绝");
    await stopSupervisor(supervisor);
  }

  // 场景 D：损坏/未知 state 拒绝启动
  {
    const statePath = path.join(tempDir, "state.json");
    for (const content of ["{ broken", JSON.stringify({ version: 99, active: null, generations: [] })]) {
      fs.writeFileSync(statePath, content);
      const bad = spawn(BINARY, [
        "supervisor", "--host", "127.0.0.1", "--port", String(supervisorPort),
        "--control", path.join(tempDir, "supervisor.sock"), "--state", statePath,
      ], { stdio: ["ignore", "ignore", "ignore"] });
      supervisors.push(bad);
      const code = await new Promise((resolve) => bad.once("exit", resolve));
      assert.notEqual(code, 0, "损坏或未知 state 应拒绝启动");
    }
    console.log("PASS 场景D：损坏/未知 state 拒绝启动");
  }

  // 场景 E：--run-user 降权路径（同 uid 下验证解析与 pre_exec 链路；跨 uid 留给实机）
  {
    fs.rmSync(path.join(tempDir, "state.json"), { force: true });
    const port = await freePort();
    const child = spawn(BINARY, [
      "supervisor", "host-placeholder".replace("host-placeholder", "--host"), "127.0.0.1",
      "--port", String(port),
      "--control", path.join(tempDir, "supervisor.sock"),
      "--state", path.join(tempDir, "state.json"),
      "--run-user", os.userInfo().username,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    supervisors.push(child);
    await new Promise((resolve, reject) => {
      let log = "";
      child.stderr.on("data", (chunk) => { log += chunk.toString(); });
      child.once("exit", (code) => reject(new Error(`--run-user supervisor 退出 (${code}): ${log}`)));
      (async () => {
        for (let i = 0; i < 250 && !log.includes("listening"); i += 1) await wait(20);
        log.includes("listening") ? resolve() : reject(new Error(`--run-user supervisor 未就绪: ${log}`));
      })();
    });
    const pkg = await buildPackage("dropped");
    const result = await ctl([
      "upgrade", "--package", pkg.tarPath, "--sha256", pkg.sha256,
      "--versions-dir", versionsDir, "--link", currentLink,
      "--", process.execPath, "{version_dir}/backend.js",
    ]);
    assert.ok(JSON.parse(result.stdout).generation, "--run-user 下升级应成功");
    const conn = await connect(port);
    assert.equal(await request(conn, "/dropped"), "dropped/dropped", "降权后 backend 仍可服务");
    conn.destroy();
    await stopSupervisor(child);
    console.log("PASS 场景E：--run-user 降权路径可用");
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("Rust Phase 2 loopback: 5 scenarios passed");
  process.exit(0);
}

process.on("exit", () => {
  for (const sup of supervisors) { try { sup.kill("SIGKILL"); } catch {} }
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
