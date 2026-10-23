#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const tls = require("node:tls");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { pipeline } = require("node:stream/promises");
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
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
function running(pid) {
  try { return !/[)] [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

async function main() {
  assert.ok(fs.existsSync(binary), `请先构建静态原型：${binary}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remote-exec-rust-"));
  const cert = path.join(tmp, "cert.pem");
  const key = path.join(tmp, "key.pem");
  const hashFile = path.join(tmp, "token.sha256");
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(hashFile, sha(token), { mode: 0o600 });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  const daemon = spawn(binary, ["--host", "0.0.0.0", "--port", "0", "--cert", cert,
    "--key", key, "--token-sha256-file", hashFile], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(daemon, "exit");
  const targetTmp = fs.mkdtempSync(path.join(os.tmpdir(), "remote-exec-rust-relay-target-"));
  const targetCa = path.join(targetTmp, "ca.pem");
  const targetCaKey = path.join(targetTmp, "ca.key");
  const targetCert = path.join(targetTmp, "cert.pem");
  const targetCsr = path.join(targetTmp, "cert.csr");
  const targetExt = path.join(targetTmp, "cert.ext");
  const targetKey = path.join(targetTmp, "key.pem");
  const targetHash = path.join(targetTmp, "token.sha256");
  const targetToken = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(targetHash, sha(targetToken), { mode: 0o600 });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", targetCaKey, "-out", targetCa, "-subj", "/CN=localhost CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes",
    "-keyout", targetKey, "-out", targetCsr, "-subj", "/CN=localhost"], { stdio: "ignore" });
  fs.writeFileSync(targetExt, "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
  execFileSync("openssl", ["x509", "-req", "-days", "1", "-in", targetCsr,
    "-CA", targetCa, "-CAkey", targetCaKey, "-CAcreateserial", "-out", targetCert,
    "-extfile", targetExt], { stdio: "ignore" });
  const targetDaemon = spawn(binary, ["--host", "127.0.0.1", "--port", "0", "--cert", targetCert,
    "--key", targetKey, "--token-sha256-file", targetHash], { stdio: ["ignore", "pipe", "pipe"] });
  const targetExited = once(targetDaemon, "exit");
  let log = "";
  daemon.stderr.on("data", (chunk) => { log += chunk; });
  daemon.on("error", (e) => { log += e.message; });
  let targetLog = "";
  targetDaemon.stderr.on("data", (chunk) => { targetLog += chunk; });
  targetDaemon.on("error", (e) => { targetLog += e.message; });
  const clients = new Set();
  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  }
  try {
    await eventually(() => /listening 0\.0\.0\.0:(\d+)/.test(log) || daemon.exitCode !== null);
    const match = log.match(/listening 0\.0\.0\.0:(\d+)/);
    assert.ok(match, log);
    await eventually(() => /listening 127\.0\.0\.1:(\d+)/.test(targetLog) || targetDaemon.exitCode !== null);
    const targetMatch = targetLog.match(/listening 127\.0\.0\.1:(\d+)/);
    assert.ok(targetMatch, targetLog);
    const options = { host: "127.0.0.1", port: Number(match[1]), ca: fs.readFileSync(cert), rejectUnauthorized: true };
    const auth = { Authorization: `Bearer ${token}` };
    function request(method, url, headers = {}, body) {
      return new Promise((resolve, reject) => {
        const req = https.request({ ...options, method, path: url, headers, agent: false }, (res) => {
          const chunks = [];
          res.on("data", (b) => chunks.push(b));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        });
        req.setTimeout(10000, () => req.destroy(new Error("HTTP 超时")));
        req.on("error", reject);
        if (Array.isArray(body)) { for (const part of body) req.write(part); req.end(); }
        else req.end(body);
      });
    }
    async function client() {
      const c = new WssClient({ ...options, ca: cert });
      clients.add(c);
      await c.connectToken(token);
      return c;
    }
    function raw(headers, bytesAfterUpgrade) {
      return new Promise((resolve, reject) => {
        const socket = tls.connect(options);
        let buffer = Buffer.alloc(0);
        let upgraded = false;
        let done = false;
        const finish = (e) => {
          if (done) return;
          done = true;
          socket.destroy();
          e ? reject(e) : resolve(buffer);
        };
        socket.setTimeout(3000, () => finish(new Error("原始连接超时")));
        socket.on("secureConnect", () => socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n\r\n`));
        socket.on("data", (b) => {
          buffer = Buffer.concat([buffer, b]);
          if (!upgraded && buffer.includes("\r\n\r\n")) {
            if (bytesAfterUpgrade && buffer.toString().startsWith("HTTP/1.1 101")) {
              upgraded = true;
              socket.write(bytesAfterUpgrade);
            } else finish();
          } else if (upgraded) finish();
        });
        socket.on("end", () => finish());
        socket.on("close", () => finish());
        socket.on("error", (e) => upgraded ? finish() : finish(e));
      });
    }
    const upgrade = `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}`;
    await test("真实 TLS 健康检查与就绪检查", async () => {
      for (const route of ["/healthz", "/readyz"]) {
        const r = await request("GET", route);
        assert.equal(r.status, 200); assert.equal(r.body.toString(), "ok\n");
      }
    });
    await test("客户端拒绝不可信 TLS 证书", async () => {
      const bad = new WssClient({ host: options.host, port: options.port });
      clients.add(bad);
      await assert.rejects(bad.connectToken(token), /self-signed|certificate/i);
    });
    await test("错误 token、Origin 与非法握手被拒绝", async () => {
      assert.match((await raw(upgrade.replace(token, "wrong"))).toString(), /^HTTP\/1\.1 401/);
      assert.match((await raw(upgrade + "\r\nOrigin: https://example.test")).toString(), /^HTTP\/1\.1 403/);
      assert.match((await raw(upgrade.replace("Sec-WebSocket-Version: 13", "Sec-WebSocket-Version: 12"))).toString(), /^HTTP\/1\.1 400/);
      assert.equal((await request("POST", "/upload?path=/tmp/not-written", {}, "bad")).status, 401);
    });
    await test("HTTP 请求头停滞超过 10 秒关闭连接", async () => {
      const began = Date.now();
      await new Promise((resolve, reject) => {
        const socket = tls.connect(options);
        socket.setTimeout(12000, () => socket.destroy(new Error("请求头超时未生效")));
        socket.on("secureConnect", () => socket.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\n"));
        socket.on("data", () => {});
        socket.on("end", resolve);
        socket.on("error", reject);
        socket.on("close", resolve);
      });
      assert.ok(Date.now() - began < 12000);
    });
    const c = await client();
    await test("现有 Node WSS 客户端执行中文、cwd 和非零退出码", async () => {
      let r = await c.call("exec", { command: "printf '你好 Rust'" });
      assert.equal(r.exitCode, 0); assert.equal(Buffer.from(r.stdoutB64, "base64").toString(), "你好 Rust");
      r = await c.call("exec", { command: "pwd; printf err >&2; exit 7", cwd: tmp });
      assert.equal(r.exitCode, 7); assert.equal(Buffer.from(r.stdoutB64, "base64").toString().trim(), tmp);
      assert.equal(Buffer.from(r.stderrB64, "base64").toString(), "err");
      await assert.rejects(c.call("exec", { command: "pwd", cwd: "relative" }), /-32602/);
    });
    await test("stdout、stderr 独立截断且持续排空管道", async () => {
      const r = await c.call("exec", { command: "head -c 200000 /dev/zero; head -c 200000 /dev/zero >&2", outputBytesCap: 1024 });
      assert.equal(r.exitCode, 0); assert.equal(r.truncated, true);
      assert.equal(Buffer.from(r.stdoutB64, "base64").length, 1024);
      assert.equal(Buffer.from(r.stderrB64, "base64").length, 1024);
    });
    await test("同连接请求按顺序执行", async () => {
      const marker = path.join(tmp, "sequence");
      const first = c.call("exec", { command: `sleep 0.2; printf first > ${shellQuote(marker)}` });
      await wait(30);
      const second = c.call("exec", { command: `cat ${shellQuote(marker)}` });
      assert.equal((await first).exitCode, 0);
      assert.equal(Buffer.from((await second).stdoutB64, "base64").toString(), "first");
    });
    await test("流式双流实时交付，字节数与终态准确", async () => {
      const events = [];
      let firstAt;
      const started = Date.now();
      const r = await c.callStream("exec.stream", { command: "printf one; sleep 0.4; printf two >&2" }, (e) => {
        firstAt ??= Date.now(); events.push(e);
      });
      assert.equal(r.exitCode, 0); assert.equal(r.reason, "exited");
      assert.equal(r.stdoutBytes, 3); assert.equal(r.stderrBytes, 3);
      assert.ok(firstAt < Date.now() - 200); assert.ok(firstAt >= started);
      assert.equal(events.filter((e) => e.stream === "stdout").map((e) => Buffer.from(e.dataB64, "base64").toString()).join(""), "one");
      assert.equal(events.filter((e) => e.stream === "stderr").map((e) => Buffer.from(e.dataB64, "base64").toString()).join(""), "two");
    });
    await test("超时返回 124 并清理整个进程组", async () => {
      const pidfile = path.join(tmp, "timeout-pid");
      const r = await c.call("exec", { command: `sleep 60 & echo $! > ${shellQuote(pidfile)}; wait`, timeoutMs: 300 });
      assert.equal(r.exitCode, 124);
      const pid = Number(fs.readFileSync(pidfile, "utf8"));
      await eventually(() => !running(pid));
    });
    await test("客户端断连清理子进程", async () => {
      const pidfile = path.join(tmp, "cancel-pid");
      const other = await client();
      const pending = other.call("exec", { command: `sleep 60 & echo $! > ${shellQuote(pidfile)}; wait` });
      const rejected = assert.rejects(pending, /中断|关闭/);
      await eventually(() => fs.existsSync(pidfile));
      other.abort(); await rejected;
      await eventually(() => !running(Number(fs.readFileSync(pidfile, "utf8"))));
    });
    await test("二进制文件 RPC 往返与参数拒绝", async () => {
      const file = path.join(tmp, "nested", "binary");
      const bytes = crypto.randomBytes(8192);
      assert.equal((await c.call("file.write", { file, contentB64: bytes.toString("base64") })).size, bytes.length);
      const r = await c.call("file.read", { file });
      assert.equal(r.size, bytes.length); assert.deepEqual(Buffer.from(r.contentB64, "base64"), bytes);
      await assert.rejects(c.call("file.read", { file: "relative" }), /-32602/);
      await assert.rejects(c.call("file.write", { file, contentB64: "%%%" }), /-32602/);
      await assert.rejects(c.call("file.read", { file: tmp }), /-32603/);
      await assert.rejects(c.call("relay", {}), /-32015/);
    });
    await test("relay 转发 Rust 目标的命令、流式输出和文件 RPC", async () => {
      const target = { host: "127.0.0.1", port: Number(targetMatch[1]) };
      const auth = { token: targetToken, ca: fs.readFileSync(targetCa, "utf8") };
      const base = { target, auth };
      let r = await c.call("relay", { ...base, request: { method: "exec", params: { command: "printf relay-rust" } } });
      assert.equal(r.relayed, true);
      assert.equal(r.error, null);
      assert.equal(Buffer.from(r.result.stdoutB64, "base64").toString(), "relay-rust");
      const events = [];
      r = await c.callStream("relay", { ...base, request: { method: "exec.stream", params: { command: "printf first; printf second >&2" } } }, (event) => events.push(event));
      assert.equal(r.relayed, true);
      assert.equal(events.filter((event) => event.stream === "stdout").map((event) => Buffer.from(event.dataB64, "base64").toString()).join(""), "first");
      assert.equal(events.filter((event) => event.stream === "stderr").map((event) => Buffer.from(event.dataB64, "base64").toString()).join(""), "second");
      const targetFile = "/tmp/remote-exec-rust-relay-file";
      const payload = Buffer.from("relay-file");
      r = await c.call("relay", { ...base, request: { method: "file.write", params: { file: targetFile, contentB64: payload.toString("base64") } } });
      assert.equal(r.result.size, payload.length);
      r = await c.call("relay", { ...base, request: { method: "file.read", params: { file: targetFile } } });
      assert.deepEqual(Buffer.from(r.result.contentB64, "base64"), payload);
      await c.call("relay", { ...base, request: { method: "exec", params: { command: `rm -f ${shellQuote(targetFile)}` } } });
      r = await c.call("relay", {
        target: { host: "127.0.0.1", port: Number(match[1]) },
        auth: { token, ca: fs.readFileSync(cert, "utf8") },
        request: { method: "exec", params: { command: "printf relay-self-signed" } },
      });
      assert.equal(Buffer.from(r.result.stdoutB64, "base64").toString(), "relay-self-signed");
    });
    await test("relay 白名单和嵌套请求被拒绝", async () => {
      const target = { host: "8.8.8.8", port: 8791 };
      const auth = { token: targetToken, ca: fs.readFileSync(targetCa, "utf8") };
      await assert.rejects(c.call("relay", { target, auth, request: { method: "exec", params: { command: "true" } } }), /-32010/);
      await assert.rejects(c.call("relay", { target: { host: "127.0.0.1", port: Number(targetMatch[1]) }, auth, request: { method: "relay", params: {} } }), /-32015/);
    });
    await test("chunked 上传与下载保留 Content-Length 和哈希", async () => {
      const file = path.join(tmp, "chunked");
      const chunks = [crypto.randomBytes(13000), crypto.randomBytes(17000)];
      const bytes = Buffer.concat(chunks);
      const r = await request("POST", `/upload?path=${encodeURIComponent(file)}`, auth, chunks);
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), { size: bytes.length, sha256: sha(bytes) });
      const d = await request("GET", `/download?path=${encodeURIComponent(file)}`, auth);
      assert.equal(Number(d.headers["content-length"]), bytes.length); assert.deepEqual(d.body, bytes);
    });
    await test("100MB 文件流式上传下载哈希一致", async () => {
      const file = path.join(tmp, "large-remote");
      const local = path.join(tmp, "large-source");
      const piece = crypto.randomBytes(1024 * 1024);
      const expected = crypto.createHash("sha256");
      const fd = fs.openSync(local, "w");
      try { for (let i = 0; i < 100; i++) { fs.writeSync(fd, piece); expected.update(piece); } }
      finally { fs.closeSync(fd); }
      const digest = expected.digest("hex");
      const upload = new Promise((resolve, reject) => {
        const req = https.request({ ...options, method: "POST", path: `/upload?path=${encodeURIComponent(file)}`,
          headers: { ...auth, "Content-Length": 100 * piece.length }, agent: false }, (res) => {
          const chunks = []; res.on("data", (b) => chunks.push(b)); res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        req.setTimeout(20000, () => req.destroy(new Error("大文件上传超时")));
        req.on("error", reject);
        pipeline(fs.createReadStream(local), req).catch(reject);
      });
      const r = await upload;
      assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), { size: 100 * piece.length, sha256: digest });
      await new Promise((resolve, reject) => {
        const req = https.get({ ...options, path: `/download?path=${encodeURIComponent(file)}`, headers: auth, agent: false }, async (res) => {
          try {
            assert.equal(res.statusCode, 200); assert.equal(Number(res.headers["content-length"]), 100 * piece.length);
            const hash = crypto.createHash("sha256"); let size = 0;
            for await (const b of res) { hash.update(b); size += b.length; }
            assert.equal(size, 100 * piece.length); assert.equal(hash.digest("hex"), digest); resolve();
          } catch (e) { reject(e); }
        });
        req.setTimeout(20000, () => req.destroy(new Error("大文件下载超时"))); req.on("error", reject);
      });
    });
    await test("上传中断保留旧文件并删除临时文件", async () => {
      const file = path.join(tmp, "partial");
      fs.writeFileSync(file, "original");
      const socket = tls.connect(options);
      socket.on("error", () => {});
      await once(socket, "secureConnect");
      socket.write(`POST /upload?path=${encodeURIComponent(file)} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Length: 1000000\r\n\r\npartial`);
      await eventually(() => fs.readdirSync(tmp).some((f) => f.startsWith(".remote-exec-tmp-")));
      socket.destroy();
      await eventually(() => !fs.readdirSync(tmp).some((f) => f.startsWith(".remote-exec-tmp-")));
      assert.equal(fs.readFileSync(file, "utf8"), "original");
    });
    await test("畸形 WebSocket 帧迅速断开且服务保持可用", async () => {
      for (const bytes of [Buffer.from([0x81, 2, 104, 105]), Buffer.from([0x83, 0x80, 1, 2, 3, 4]),
        Buffer.from([0x81, 0xff, ...Buffer.alloc(8, 0xff), 1, 2, 3, 4])]) {
        const began = Date.now(); await raw(upgrade, bytes); assert.ok(Date.now() - began < 2500);
      }
      assert.equal((await c.call("exec", { command: "printf alive" })).exitCode, 0);
    });
    await test("SIGTERM 排空：拒绝新请求、既有请求完成后退出", async () => {
      const pending = c.call("exec", { command: "sleep 0.6; printf drained" });
      await wait(100);
      daemon.kill("SIGTERM");
      await eventually(async () => (await request("GET", "/readyz")).status === 503);
      const readyz = await request("GET", "/readyz");
      assert.equal(readyz.body.toString(), "draining\n");
      assert.match((await raw(upgrade)).toString(), /^HTTP\/1\.1 503/);
      assert.equal((await request("POST", "/upload?path=/tmp/not-written", auth, "x")).status, 503);
      await assert.rejects(c.call("exec", { command: "true" }), /-32020/);
      const r = await pending;
      assert.equal(r.exitCode, 0);
      assert.equal(Buffer.from(r.stdoutB64, "base64").toString(), "drained");
      // 排空会等待既有连接关闭；客户端断开后 daemon 才退出。
      c.close();
      await exited;
      assert.equal(daemon.exitCode, 0);
    });
    console.log(`Rust prototype: ${passed} checks passed`);
  } finally {
    for (const c of clients) c.abort();
    if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill("SIGTERM"); await exited; }
    if (targetDaemon.exitCode === null && targetDaemon.signalCode === null) { targetDaemon.kill("SIGTERM"); await targetExited; }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(targetTmp, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
