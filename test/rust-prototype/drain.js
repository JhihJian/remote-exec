#!/usr/bin/env node
"use strict";

// Rust daemon 排空与终止语义、relay 阶段标注和外层超时的行为验证。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const tls = require("node:tls");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { WssClient } = require("../../src/client/websocket.js");

const root = path.resolve(__dirname, "../..");
const target = process.env.RUST_PROTOTYPE_TARGET || "x86_64-unknown-linux-musl";
const binary = path.resolve(process.env.RUST_PROTOTYPE_BINARY || path.join(root,
  `rust/target/${target}/release/remote-execd`));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error("等待条件超时");
    await wait(30);
  }
}
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

function issueCert(dir, prefix, { ca, caKey, days = 1, notBefore, notAfter } = {}) {
  const key = path.join(dir, `${prefix}.key`);
  const cert = path.join(dir, `${prefix}.crt`);
  if (notBefore || notAfter) {
    const csr = path.join(dir, `${prefix}.csr`);
    const config = path.join(dir, `${prefix}.cnf`);
    fs.writeFileSync(config, `[ ca ]\ndefault_ca = CA_default\n[ CA_default ]\ndatabase = ${path.join(dir, `${prefix}.index`)}\nserial = ${path.join(dir, `${prefix}.serial`)}\nnew_certs_dir = ${dir}\ndefault_md = sha256\ndefault_days = 1\npolicy = policy_any\n[ policy_any ]\ncommonName = supplied\n`);
    fs.writeFileSync(path.join(dir, `${prefix}.index`), "");
    fs.writeFileSync(path.join(dir, `${prefix}.serial`), "01\n");
    execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", csr, "-subj", "/CN=localhost"], { stdio: "ignore" });
    const extensions = path.join(dir, `${prefix}.ext`);
    fs.writeFileSync(extensions, "[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
    const args = ["ca", "-batch", "-config", config, "-selfsign", "-keyfile", key,
      "-in", csr, "-out", cert, "-extfile", extensions, "-extensions", "ext"];
    if (notBefore) args.push("-startdate", notBefore);
    if (notAfter) args.push("-enddate", notAfter);
    execFileSync("openssl", args, {
      input: "[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
      stdio: ["pipe", "ignore", "ignore"],
    });
  } else if (ca) {
    const csr = path.join(dir, `${prefix}.csr`);
    execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", csr, "-subj", "/CN=localhost"], { stdio: "ignore" });
    execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey,
      "-CAcreateserial", "-out", cert, "-days", String(days), "-extfile", "/dev/stdin"], {
      input: "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
      stdio: ["pipe", "ignore", "ignore"],
    });
  } else {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  }
  return { key, cert };
}

function caBundle(dir) {
  const ca = path.join(dir, "ca.crt");
  const caKey = path.join(dir, "ca.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", caKey, "-out", ca, "-subj", "/CN=test-ca",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
  return { ca, caKey };
}

async function startDaemon(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-exec-drain-"));
  const { key, cert } = issueCert(dir, "server");
  const hashFile = path.join(dir, "token.sha256");
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(hashFile, sha(token), { mode: 0o600 });
  const args = ["--host", "127.0.0.1", "--port", "0", "--cert", cert,
    "--key", key, "--token-sha256-file", hashFile];
  for (const extra of overrides.args || []) args.push(...extra);
  const daemon = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(daemon, "exit");
  let log = "";
  daemon.stderr.on("data", (chunk) => { log += chunk; });
  await eventually(() => /listening 127\.0\.0\.1:(\d+)/.test(log) || daemon.exitCode !== null);
  const match = log.match(/listening 127\.0\.0\.1:(\d+)/);
  assert.ok(match, log);
  const options = { host: "127.0.0.1", port: Number(match[1]), ca: fs.readFileSync(cert), rejectUnauthorized: true };
  const request = (method, urlPath, headers = {}) => new Promise((resolve, reject) => {
    const req = https.request({ ...options, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (b) => chunks.push(b));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error("HTTP 超时")));
    req.on("error", reject);
    req.end();
  });
  async function client() {
    const c = new WssClient({ ...options, ca: cert });
    await c.connectToken(token);
    return c;
  }
  return { daemon, exited, dir, cert, token, request, client, options };
}

async function main() {
  assert.ok(fs.existsSync(binary), `请先构建静态原型：${binary}`);
  let passed = 0;
  async function test(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } finally { /* 清理由各用例自行完成 */ }
  }

  await test("排空超时强制关闭残余连接并退出", async () => {
    const d = await startDaemon({ args: [["--drain-timeout-ms", "1500"]] });
    const c = await d.client();
    daemonClosed = null;
    const closed = new Promise((resolve) => { daemonClosed = resolve; });
    c.socket ? c.socket.once("close", daemonClosed) : c.abort();
    d.daemon.kill("SIGTERM");
    const began = Date.now();
    await d.exited;
    const elapsed = Date.now() - began;
    assert.ok(elapsed < 8000, `排空超时应及时退出，实际 ${elapsed}ms`);
    assert.equal(d.daemon.exitCode, 0);
    await closed;
    c.abort();
    fs.rmSync(d.dir, { recursive: true, force: true });
  });

  await test("exec 超时先 TERM 后 KILL，忽略 TERM 的进程 2 秒后被清理", async () => {
    const d = await startDaemon();
    const c = await d.client();
    const began = Date.now();
    const r = await c.call("exec", {
      command: "trap '' TERM; sleep 30",
      timeoutMs: 300,
    });
    const elapsed = Date.now() - began;
    assert.equal(r.exitCode, 124);
    assert.ok(elapsed >= 2000 && elapsed < 6000, `KILL 兜底应在约 2 秒发生，实际 ${elapsed}ms`);
    c.abort();
    d.daemon.kill("SIGTERM");
    await d.exited;
    fs.rmSync(d.dir, { recursive: true, force: true });
  });

  await test("exec 超时时子进程可捕获 TERM 完成清理输出", async () => {
    const d = await startDaemon();
    const c = await d.client();
    const r = await c.call("exec", {
      command: "trap 'printf bye; exit 0' TERM; sleep 30",
      timeoutMs: 300,
    });
    assert.equal(r.exitCode, 124);
    assert.equal(Buffer.from(r.stdoutB64, "base64").toString(), "bye");
    c.abort();
    d.daemon.kill("SIGTERM");
    await d.exited;
    fs.rmSync(d.dir, { recursive: true, force: true });
  });

  await test("exec.stream 超时时仍交付 TERM trap 尾部事件", async () => {
    const d = await startDaemon();
    const c = await d.client();
    const events = [];
    const r = await c.callStream("exec.stream", {
      command: "trap 'printf bye; exit 0' TERM; sleep 30",
      timeoutMs: 300,
    }, (event) => events.push(event));
    assert.equal(r.exitCode, 124);
    assert.equal(events
      .filter((event) => event.stream === "stdout")
      .map((event) => Buffer.from(event.dataB64, "base64").toString())
      .join(""), "bye");
    c.abort();
    d.daemon.kill("SIGTERM");
    await d.exited;
    fs.rmSync(d.dir, { recursive: true, force: true });
  });
  await test("relay 失败响应带 stage 标注且外层 timeoutMs 可缩短总超时", async () => {
    // 甲：中继入口；乙：正常目标；丙：错误 token 目标。
    const a = await startDaemon();
    const b = await startDaemon();
    const c2 = await startDaemon();
    const caB = fs.readFileSync(b.cert, "utf8");
    const base = { target: { host: "127.0.0.1", port: b.options.port }, auth: { token: b.token, ca: caB } };
    const ca = await a.client();

    const stages = async (params) => ca.call("relay", params).then(() => null, (e) => e);
    let err = await stages({ ...base, request: { method: "exec", params: { command: "true" } } });
    assert.equal(err, null, "正常 relay 不应失败");

    err = await stages({ target: { host: "127.0.0.1", port: 1 }, auth: base.auth,
      request: { method: "exec", params: { command: "true" } } });
    assert.match(err.message, /-32011/);
    assert.equal(err.data.stage, "connect");

    err = await stages({ ...base, auth: { token: "wrong", ca: caB },
      request: { method: "exec", params: { command: "true" } } });
    assert.match(err.message, /-32013/);
    assert.equal(err.data.stage, "auth");

    err = await stages({ target: base.target, auth: { token: b.token, ca: fs.readFileSync(c2.cert, "utf8") },
      request: { method: "exec", params: { command: "true" } } });
    assert.match(err.message, /-32012/);
    assert.equal(err.data.stage, "tls");

    err = await stages({ target: { host: "8.8.8.8", port: 8791 }, auth: base.auth,
      request: { method: "exec", params: { command: "true" } } });
    assert.match(err.message, /-32010/);
    assert.equal(err.data.stage, "allowlist");

    err = await stages({ ...base, request: { method: "relay", params: {} } });
    assert.match(err.message, /-32015/);
    assert.equal(err.data.stage, "validate");

    const began = Date.now();
    err = await stages({ ...base, timeoutMs: 700,
      request: { method: "exec", params: { command: "sleep 30", timeoutMs: 600000 } } });
    const elapsed = Date.now() - began;
    assert.match(err.message, /-32014/);
    assert.equal(err.data.stage, "deadline");
    assert.ok(elapsed < 4000, `外层超时应覆盖总超时，实际 ${elapsed}ms`);
    assert.ok(err.message.includes("700ms"), err.message);

    ca.abort();
    for (const d of [a, b, c2]) { d.daemon.kill("SIGTERM"); await d.exited; fs.rmSync(d.dir, { recursive: true, force: true }); }
  });

  await test("relay pin 分支拒绝已过期与未生效证书", async () => {
    const a = await startDaemon();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-exec-validity-"));
    const { ca, caKey } = caBundle(dir);
    const expired = issueCert(dir, "expired", { ca, caKey, notBefore: "20200101000000Z", notAfter: "20210101000000Z" });
    const future = issueCert(dir, "future", { ca, caKey, notBefore: "20350101000000Z", notAfter: "20500101000000Z" });
    async function relayWith(certFile) {
      const hashFile = path.join(dir, "token.sha256");
      const token = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(hashFile, sha(token), { mode: 0o600 });
      const daemon = spawn(binary, ["--host", "127.0.0.1", "--port", "0", "--cert", certFile,
        "--key", path.join(dir, path.basename(certFile, ".crt") + ".key"),
        "--token-sha256-file", hashFile], { stdio: ["ignore", "pipe", "pipe"] });
      const exited = once(daemon, "exit");
      let log = "";
      daemon.stderr.on("data", (c) => { log += c; });
      await eventually(() => /listening/.test(log) || daemon.exitCode !== null);
      const port = Number(log.match(/listening 127\.0\.0\.1:(\d+)/)?.[1] || 0);
      if (!port) { daemon.kill("SIGKILL"); throw new Error(`目标启动失败: ${log}`); }
      const client = await a.client();
      const err = await client.call("relay", {
        target: { host: "127.0.0.1", port },
        auth: { token, ca: fs.readFileSync(certFile, "utf8") },
        request: { method: "exec", params: { command: "true" } },
      }).then(() => null, (e) => e);
      client.abort();
      daemon.kill("SIGTERM");
      await exited;
      return err;
    }
    const expiredErr = await relayWith(expired.cert);
    assert.match(expiredErr.message, /-32012/);
    assert.equal(expiredErr.data.stage, "tls");
    assert.match(expiredErr.message, /过期/);
    const futureErr = await relayWith(future.cert);
    assert.match(futureErr.message, /-32012/);
    assert.match(futureErr.message, /尚未生效/);
    const ca2 = await a.client();
    ca2.abort();
    a.daemon.kill("SIGTERM");
    await a.exited;
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`Rust drain/relay 语义: ${passed} checks passed`);
}

let daemonClosed = null;
main().catch((e) => { console.error(e); process.exitCode = 1; });
