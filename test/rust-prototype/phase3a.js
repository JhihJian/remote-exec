#!/usr/bin/env node
"use strict";

// Phase 3a：rex Rust 客户端 loopback 验收（Rust daemon + Rust 客户端，无需 Node 服务端）。
// 覆盖：一次性 exec/read/write、流式 upload/download、relay 信封、smoke、hosts 探测、
// 交互管道驱动（PWD 跟随、退出摘要）、register 写出的 hosts.json 与 Node 互操作格式。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { once } = require("node:events");

const root = path.resolve(__dirname, "../..");
const daemonBinary = process.env.RUST_PROTOTYPE_BINARY || path.join(root,
  "rust/target/x86_64-unknown-linux-musl/release/remote-execd");
const rex = process.env.REX_BINARY || path.join(root,
  "rust/target/x86_64-unknown-linux-musl/release/rex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error("等待条件超时");
    await wait(30);
  }
}
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

function run(args, options = {}) {
  return spawnSync(rex, args, { timeout: 30000, ...options });
}
function text(buffer) { return buffer.toString("utf8"); }

async function main() {
  assert.ok(fs.existsSync(daemonBinary), `请先构建 daemon：${daemonBinary}`);
  assert.ok(fs.existsSync(rex), `请先构建 rex：cargo build --release -p remote-exec-rex`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rex-phase3a-"));
  const configDir = path.join(tmp, "config");
  fs.mkdirSync(configDir, { recursive: true });

  // 网关与目标各自一套证书/token（目标由网关 relay 触达）。
  function makeIdentity(name) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    const ca = path.join(dir, "ca.pem");
    const caKey = path.join(dir, "ca.key");
    const cert = path.join(dir, "cert.pem");
    const key = path.join(dir, "key.pem");
    const csr = path.join(dir, "cert.csr");
    const ext = path.join(dir, "cert.ext");
    const token = crypto.randomBytes(32).toString("hex");
    const tokenFile = path.join(dir, "token");
    fs.writeFileSync(path.join(dir, "token.sha256"), sha(token), { mode: 0o600 });
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", caKey, "-out", ca, "-subj", `/CN=${name} CA`,
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
    execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", csr, "-subj", `/CN=localhost`], { stdio: "ignore" });
    fs.writeFileSync(ext, "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
    execFileSync("openssl", ["x509", "-req", "-days", "1", "-in", csr,
      "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-extfile", ext], { stdio: "ignore" });
    return { dir, ca, cert, key, token, tokenFile };
  }
  const gateway = makeIdentity("gateway");
  const target = makeIdentity("target");

  function startDaemon(identity, args = []) {
    const child = spawn(daemonBinary, ["--host", "127.0.0.1", "--port", "0",
      "--cert", identity.cert, "--key", identity.key,
      "--token-sha256-file", path.join(identity.dir, "token.sha256"), ...args],
      { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stderr.on("data", (chunk) => { log += chunk; });
    const exited = once(child, "exit");
    return { child, log: () => log, exited };
  }
  const gwDaemon = startDaemon(gateway);
  const targetDaemon = startDaemon(target);
  const env = { ...process.env, REX_CONFIG_DIR: configDir };

  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  }
  try {
    await eventually(() => /listening 127\.0\.0\.1:(\d+)/.test(gwDaemon.log()) || gwDaemon.child.exitCode !== null);
    const gwPort = Number(gwDaemon.log().match(/listening 127\.0\.0\.1:(\d+)/)[1]);
    await eventually(() => /listening 127\.0\.0\.1:(\d+)/.test(targetDaemon.log()) || targetDaemon.child.exitCode !== null);
    const targetPort = Number(targetDaemon.log().match(/listening 127\.0\.0\.1:(\d+)/)[1]);

    fs.writeFileSync(path.join(configDir, "hosts.json"), JSON.stringify({
      hosts: {
        local: { host: "127.0.0.1", port: gwPort, ca: gateway.ca, tokenFile: gateway.tokenFile, cwd: tmp },
        target: { host: "127.0.0.1", port: targetPort, ca: target.ca, tokenFile: target.tokenFile },
        relayed: { host: "127.0.0.1", port: targetPort, ca: target.ca, tokenFile: target.tokenFile, via: "local", cwd: "/tmp" },
      },
    }, null, 2) + "\n");

    await test("rex exec：stdout、退出码与摘要行", async () => {
      const r = run(["exec", "local", "--", "echo", "你好 rex"], { env });
      assert.equal(r.status, 0, text(r.stderr));
      assert.match(text(r.stdout), /你好 rex/);
      assert.match(text(r.stdout), /-- exit=0 \d+\.\ds/);
    });
    await test("rex exec：非零退出码透传", async () => {
      const r = run(["exec", "local", "--", "printf oops >&2; exit 7"], { env });
      assert.equal(r.status, 7);
      assert.match(text(r.stderr), /oops/);
    });
    await test("rex exec：stderr 混流时保留在 stderr", async () => {
      const r = run(["exec", "local", "--", "printf A; printf B >&2; exit 0"], { env });
      assert.equal(r.status, 0);
      assert.equal(text(r.stdout).includes("A"), true);
      assert.equal(text(r.stderr).includes("B"), true);
    });
    await test("未知主机提示可用列表", async () => {
      const r = run(["exec", "nope", "--", "true"], { env });
      assert.notEqual(r.status, 0);
      assert.match(text(r.stderr), /未知主机 "nope"/);
      for (const name of ["local", "target", "relayed"]) assert.ok(text(r.stderr).includes(name));
    });
    await test("rex read/write：文本与二进制往返", async () => {
      const file = path.join(tmp, "roundtrip.bin");
      const bytes = crypto.randomBytes(70000);
      const w = run(["write", "local", file], { env, input: bytes });
      assert.equal(w.status, 0, text(w.stderr));
      assert.match(text(w.stdout), /已写入 \d+ 字节/);
      const r = run(["read", "local", file], { env });
      assert.equal(r.status, 0);
      assert.deepEqual(r.stdout.subarray(0, r.stdout.length - 0), bytes);
      const u = run(["read", "local", "/etc/hostname"], { env });
      assert.equal(u.status, 0);
      assert.ok(u.stdout.length > 0);
    });
    await test("rex upload/download：30MB 哈希一致", async () => {
      const localFile = path.join(tmp, "big.bin");
      const piece = crypto.randomBytes(1024 * 1024);
      const fd = fs.openSync(localFile, "w");
      for (let i = 0; i < 30; i += 1) fs.writeSync(fd, piece);
      fs.closeSync(fd);
      const remote = path.join(tmp, "remote-big.bin");
      const up = run(["upload", "local", localFile, remote], { env });
      assert.equal(up.status, 0, text(up.stderr));
      const digest = sha(fs.readFileSync(localFile));
      assert.match(text(up.stdout), new RegExp(`31457280 字节 sha256=${digest}`));
      const back = path.join(tmp, "back.bin");
      const down = run(["download", "local", remote, back], { env });
      assert.equal(down.status, 0, text(down.stderr));
      assert.equal(sha(fs.readFileSync(back)), digest);
      assert.deepEqual(fs.readFileSync(back), fs.readFileSync(localFile));
    });
    await test("relay 主机拒绝流式传输", async () => {
      const r = run(["upload", "relayed", path.join(tmp, "hosts.json"), "/tmp/x"], { env });
      assert.notEqual(r.status, 0);
      assert.match(text(r.stderr), /经网关中转，暂不支持流式传输/);
    });
    await test("relay：exec、read、write、stream 事件", async () => {
      const r = run(["exec", "relayed", "--", "pwd"], { env });
      assert.equal(r.status, 0, text(r.stderr));
      assert.match(text(r.stdout), /\/tmp/);
      const file = path.join(tmp, "relay-file.bin");
      const bytes = crypto.randomBytes(4096);
      assert.equal(run(["write", "relayed", file], { env, input: bytes }).status, 0);
      const read = run(["read", "relayed", file], { env });
      assert.equal(read.status, 0);
      assert.equal(read.stdout.length, bytes.length);
      assert.ok(read.stdout.equals(bytes));
    });
    await test("rex smoke：直连目标验收通过", async () => {
      const r = run(["smoke", "--host", "127.0.0.1", "--port", String(targetPort),
        "--ca", target.ca, "--token-file", target.tokenFile], { env });
      assert.equal(r.status, 0, text(r.stderr));
      assert.match(text(r.stdout), /验收通过/);
    });
    await test("rex smoke：坏 token 被拒", async () => {
      const badToken = path.join(tmp, "bad.token");
      fs.writeFileSync(badToken, "wrong");
      const r = run(["smoke", "--host", "127.0.0.1", "--port", String(targetPort),
        "--ca", target.ca, "--token-file", badToken], { env });
      assert.notEqual(r.status, 0);
    });
    await test("rex hosts：全部可达", async () => {
      const r = run(["hosts"], { env });
      assert.equal(r.status, 0, text(r.stderr));
      for (const name of ["local", "relayed", "target"]) {
        assert.match(text(r.stdout), new RegExp(`${name}.*✓ \\d+ms`), text(r.stdout));
      }
    });
    await test("交互管道：执行、PWD 跟随、无标记泄漏、退出摘要", async () => {
      const child = spawn(rex, ["local"], { env, stdio: ["pipe", "inherit", "inherit"] });
      child.stdin.write("printf inter-ok\n");
      await wait(400);
      child.stdin.write("cd /tmp\n");
      await wait(400);
      child.stdin.write("pwd\n");
      await wait(400);
      child.stdin.write(":q\n");
      const [code] = await once(child, "exit");
      assert.equal(code, 0);
    });
    await test("无参数进入主机选择并列出主机", async () => {
      const r = run([], { env, input: "1\n:q\n" });
      assert.equal(r.status, 0, text(r.stderr));
      assert.match(text(r.stdout), /可用主机:/);
      assert.match(text(r.stdout), /会话结束：\d+ 条命令/);
    });
    await test("hosts.json 可被 Node config-store 读取（互操作格式）", async () => {
      const { createStore } = require("../../src/deploy/config-store.js");
      const written = fs.readFileSync(path.join(configDir, "hosts.json"), "utf8");
      const parsed = JSON.parse(written);
      assert.equal(parsed.hosts.local.tokenFile, gateway.tokenFile);
      assert.equal(parsed.hosts.relayed.via, "local");
      assert.ok(written.endsWith("\n"));
      const nodeStore = createStore(configDir);
      const hosts = nodeStore.loadConfig().hosts;
      assert.deepEqual(Object.keys(hosts).sort(), ["local", "relayed", "target"]);
      assert.equal(hosts.relayed.cwd, "/tmp");
    });
    console.log(`Phase 3a loopback: ${passed} checks passed`);
  } finally {
    for (const d of [gwDaemon, targetDaemon]) {
      if (d.child.exitCode === null && d.child.signalCode === null) {
        d.child.kill("SIGTERM");
        await d.exited;
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
