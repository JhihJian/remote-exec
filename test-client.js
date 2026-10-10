#!/usr/bin/env node
"use strict";
/**
 * remote-exec 自测客户端
 * 复用 ~/bin/codex-remote-run.js 的手写 WSS 客户端逻辑（TLS + RFC6455 帧 + JSON 消息），
 * 对本机 server.js 做端到端验证。
 *
 * 用法: node test-client.js --port 8791 --token-file .personal/token.txt --ca .personal/certs/server.crt
 */

const tls = require("tls");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");

// ---------- 参数 ----------

function parseArgs(argv) {
  const opts = { host: "127.0.0.1", port: 8791 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 需要一个值`);
      return argv[++i];
    };
    if (a === "--host") opts.host = next();
    else if (a === "--servername") opts.servername = next();
    else if (a === "--port") opts.port = Number(next());
    else if (a === "--token-file") opts.tokenFile = next();
    else if (a === "--ca") opts.ca = next();
    else if (a === "--insecure") opts.insecure = true;
    else throw new Error(`未知参数: ${a}`);
  }
  if (!opts.tokenFile) throw new Error("必须提供 --token-file");
  return opts;
}

// ---------- 客户端帧编码（发往服务端的帧必须 mask） ----------

function encodeFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x81;
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// ---------- WSS 客户端（对照 codex-remote-run.js 的 AppServerClient） ----------

class WssClient {
  constructor(opts, token) {
    this.opts = opts;
    this.token = token;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const socket = tls.connect({
        host: this.opts.host,
        port: this.opts.port,
        servername: tlsServerName(this.opts),
        ca: this.opts.ca ? fs.readFileSync(this.opts.ca) : undefined,
        rejectUnauthorized: !this.opts.insecure,
      });
      socket.on("secureConnect", () => {
        socket.write(
          `GET / HTTP/1.1\r\n` +
            `Host: ${this.opts.host}:${this.opts.port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n` +
            `Authorization: Bearer ${this.token}\r\n` +
            `\r\n`,
        );
      });
      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.upgraded) {
          const idx = this.buffer.indexOf("\r\n\r\n");
          if (idx < 0) return;
          const head = this.buffer.subarray(0, idx).toString();
          if (!/HTTP\/1\.1 101/.test(head)) {
            this.httpResponse = head;
            socket.destroy();
            reject(new Error(`upgrade 失败: ${head.split("\r\n")[0]}`));
            return;
          }
          this.upgraded = true;
          this.buffer = this.buffer.subarray(idx + 4);
          this.socket = socket;
          resolve();
        }
        this.consumeFrames();
      });
      socket.on("error", reject);
    });
  }

  consumeFrames() {
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      if (!fin) throw new Error("测试客户端不支持分片（服务端不应发送分片）");
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      const lenBits = buf[1] & 0x7f;
      let offset = 2;
      let length;
      if (lenBits < 126) length = lenBits;
      else if (lenBits === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(offset);
        offset = 2 + 2;
      } else {
        if (buf.length < 10) return;
        length = Number(buf.readBigUInt64BE(offset));
        offset = 2 + 8;
      }
      if (masked) throw new Error("服务端帧不应 mask");
      if (buf.length < offset + length) return;
      const payload = buf.subarray(offset, offset + length);
      this.buffer = buf.subarray(offset + length);
      if (opcode === 0x1) this.onMessage(JSON.parse(payload.toString("utf8")));
      else if (opcode === 0x9) this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      else if (opcode === 0x8) { this.closed = true; }
    }
  }

  onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.event) {
      if (p.onEvent) p.onEvent(msg);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`rpc ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }

  call(method, params = {}) { return this.callStream(method, params); }
  callStream(method, params = {}, onEvent) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      this.socket.write(encodeFrame(JSON.stringify({ id, method, params })));
    });
  }

  close() {
    if (this.socket && !this.closed) {
      this.socket.write(Buffer.from([0x88, 0x00])); // close 帧
      this.socket.end();
    }
  }
  abort() {
    const err = new Error("连接已中断");
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
    this.socket.destroy();
  }
}

// ---------- 断言工具 ----------

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || "断言失败");
}
function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`);
}

// ---------- 用例 ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = fs.readFileSync(opts.tokenFile, "utf8").trim();

  // 1. 健康检查（HTTPS GET）
  await test("healthz 返回 200", async () => {
    const res = await httpsGet(opts, "/healthz");
    assertEq(res.status, 200, "status");
    assertEq(res.body.trim(), "ok", "body");
  });

  // 2. 错误 token 在 upgrade 阶段被拒
  await test("错误 token 被 401 拒绝", async () => {
    const bad = new WssClient(opts, "definitely-wrong-token");
    await assertRejects(bad.connect(), /401/);
  });

  // 3. 正确 token 建立会话
  const client = new WssClient(opts, token);
  try {
    await test("正确 token 完成升级", async () => {
      await client.connect();
    });

    // 4. exec 基本执行（含 UTF-8 中文）
    await test("exec echo 中文", async () => {
      const r = await client.call("exec", { command: "echo '你好 remote-exec'" });
      assertEq(r.exitCode, 0, "exitCode");
      assertEq(Buffer.from(r.stdoutB64, "base64").toString("utf8").trim(), "你好 remote-exec", "stdout");
    });

    // 5. exec cwd 生效
    await test("exec cwd 生效", async () => {
      const r = await client.call("exec", { command: "pwd", cwd: "/tmp" });
      assertEq(r.exitCode, 0, "exitCode");
      assertEq(Buffer.from(r.stdoutB64, "base64").toString("utf8").trim(), "/tmp", "pwd");
    });

    // 6. exec 非零退出码透传
    await test("exec 非零退出码透传", async () => {
      const r = await client.call("exec", { command: "echo err >&2; exit 2" });
      assertEq(r.exitCode, 2, "exitCode");
      assertEq(Buffer.from(r.stderrB64, "base64").toString("utf8").trim(), "err", "stderr");
    });

    // 7. exec 超时按 124 终止
    await test("exec 超时返回 124", async () => {
      const r = await client.call("exec", { command: "sleep 5", timeoutMs: 500 });
      assertEq(r.exitCode, 124, "exitCode");
    });

    await test("exec.stream 实时输出与终态", async () => {
      const stdout = [];
      const stderr = [];
      const started = Date.now();
      let firstOutputAt = 0;
      const r = await client.callStream(
        "exec.stream",
        { command: "printf 'first\\n'; sleep 0.8; printf 'second\\n'; printf 'err\\n' >&2" },
        (event) => {
          if (!firstOutputAt) firstOutputAt = Date.now();
          const target = event.stream === "stdout" ? stdout : stderr;
          target.push(Buffer.from(event.dataB64, "base64"));
        },
      );
      assert(firstOutputAt > 0 && firstOutputAt - started < 600, "首条输出没有在命令结束前到达");
      assertEq(Buffer.concat(stdout).toString("utf8"), "first\nsecond\n", "stdout");
      assertEq(Buffer.concat(stderr).toString("utf8"), "err\n", "stderr");
      assertEq(r.exitCode, 0, "exitCode");
      assertEq(r.reason, "exited", "reason");
    });

    await test("exec.stream 16KB 分片可重组", async () => {
      const chunks = [];
      const r = await client.callStream("exec.stream", { command: "head -c 50000 /dev/zero" }, (event) => {
        chunks.push(Buffer.from(event.dataB64, "base64"));
      });
      assert(chunks.length >= 4, "输出未按固定大小分片");
      assertEq(Buffer.concat(chunks).length, 50000, "输出字节数");
      assertEq(r.stdoutBytes, 50000, "stdoutBytes");
    });

    await test("exec.stream 超时返回 124", async () => {
      const r = await client.callStream("exec.stream", { command: "printf ready; sleep 5", timeoutMs: 150 });
      assertEq(r.exitCode, 124, "exitCode");
      assertEq(r.reason, "timeout", "reason");
    });

    await test("exec.stream 断连终止进程组", async () => {
      const cancelClient = new WssClient(opts, token);
      const pidFile = `/tmp/remote-exec-stream-${Date.now()}.pid`;
      let signalReady;
      const ready = new Promise((resolve) => { signalReady = resolve; });
      try {
        await cancelClient.connect();
        const running = cancelClient.callStream(
          "exec.stream",
          { command: `echo $$ > ${pidFile}; echo ready; sleep 30` },
          (event) => {
            if (Buffer.from(event.dataB64, "base64").toString("utf8").includes("ready")) signalReady();
          },
        );
        await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("未收到 ready")), 2000))]);
        const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
        cancelClient.abort();
        await assertRejects(running, /连接已中断/);
        await new Promise((resolve) => setTimeout(resolve, 200));
        let exists = true;
        try { process.kill(pid, 0); } catch (err) { exists = err.code !== "ESRCH"; }
        assert(!exists, "断连后 bash 进程仍存在");
      } finally {
        fs.rmSync(pidFile, { force: true });
        cancelClient.close();
      }
    });

    // 8. exec 输出上限截断
    await test("exec 输出上限截断", async () => {
      const r = await client.call("exec", { command: "head -c 100000 /dev/zero | base64", outputBytesCap: 1024 });
      const out = Buffer.from(r.stdoutB64, "base64");
      assert(out.length <= 1024, "stdout 应被截断到 cap 以内");
      assertEq(r.truncated, true, "truncated 标记");
    });

    // 9. 未知方法
    await test("未知方法返回 -32601", async () => {
      await assertRejects(client.call("no.such.method"), /-32601/);
    });

    // 10. 参数校验
    await test("相对路径被拒绝", async () => {
      await assertRejects(client.call("file.read", { file: "relative/path" }), /-32602/);
    });

    // 11. file.write + file.read 往返（含中文与随机二进制）
    await test("file.write/read 往返", async () => {
      const dir = `/tmp/remote-exec-test-${Date.now()}`;
      const textFile = `${dir}/中文目录/notes.txt`;
      const binFile = `${dir}/blob.bin`;
      const bin = crypto.randomBytes(4096);
      const w1 = await client.call("file.write", { file: textFile, contentB64: Buffer.from("你好，世界").toString("base64") });
      assertEq(w1.size, Buffer.byteLength("你好，世界"), "写入字节数");
      await client.call("file.write", { file: binFile, contentB64: bin.toString("base64") });
      const r1 = await client.call("file.read", { file: textFile });
      assertEq(Buffer.from(r1.contentB64, "base64").toString("utf8"), "你好，世界", "文本往返");
      const r2 = await client.call("file.read", { file: binFile });
      assert(Buffer.from(r2.contentB64, "base64").equals(bin), "二进制往返一致");
    });

    // 12. file.read 不存在文件报错
    await test("file.read 缺失文件报错", async () => {
      await assertRejects(client.call("file.read", { file: "/tmp/remote-exec-not-exist-" + Date.now() }), /ENOENT|-32000|-32603/);
    });

    // 13. 大消息分片重组（发送端分多个 TCP 写入由内核决定，这里测 200KB 大 payload）
    await test("exec 大输出传输", async () => {
      const r = await client.call("exec", { command: "seq 1 20000", outputBytesCap: 1024 * 1024 });
      assertEq(r.exitCode, 0, "exitCode");
      const lines = Buffer.from(r.stdoutB64, "base64").toString("utf8").trim().split("\n");
      assertEq(lines.length, 20000, "行数");
      assertEq(lines[19999], "20000", "末行");
    });

    // 14. 多层嵌套引号：命令经 JSON 传输 + spawn argv 注入，不经二次 shell 拼接
    await test("多层嵌套引号", async () => {
      const cases = [
        [`echo "outer 'inner' end"`, `outer 'inner' end`],
        [`echo 'single "double" single'`, `single "double" single`],
        [`echo "esc \\"q\\" and 's'"`, `esc "q" and 's'`],
        [`echo "$(echo 'sub "quote"')"`, `sub "quote"`],
        [`printf '%s\n' "line1 with 'q'" 'line2 with "dq"'`, `line1 with 'q'\nline2 with "dq"`],
        [`cat <<'EOF'\nDon't "quote" $var \`cmd\`\nEOF`, `Don't "quote" $var \`cmd\``],
        [`bash -c 'bash -c "echo \\"depth3 '"'"'mix'"'"' done\\""'`, `depth3 'mix' done`],
        [`echo 'it'\\''s escaped'`, `it's escaped`],
        [`awk '{print $1}' <<< "a b c"`, `a`],
        [`echo "back\\\\slash and \\$notvar"`, `back\\slash and $notvar`],
      ];
      for (const [command, expected] of cases) {
        const r = await client.call("exec", { command });
        const out = Buffer.from(r.stdoutB64, "base64").toString("utf8").replace(/\n$/, "");
        assertEq(r.exitCode, 0, `exitCode: ${command}`);
        assertEq(out, expected.replace(/\\n/g, "\n"), `stdout: ${command}`);
      }
    });
    // 15. 大文件上传/下载（HTTP 流式端点，sha256 校验往返）
    await test("上传/下载 100MB 大文件", async () => {
      const os = require("os");
      const { execSync } = require("child_process");
      const local = `${os.tmpdir()}/re-big-${Date.now()}.bin`;
      const remote = `/tmp/re-big-${Date.now()}.bin`;
      const localBack = `${local}.back`;
      execSync(`head -c 104857600 /dev/urandom > ${JSON.stringify(local)}`);
      const localSha = execSync(`sha256sum ${JSON.stringify(local)}`).toString().split(" ")[0];
      const up = await httpUpload(opts, token, local, remote);
      assertEq(up.size, 104857600, "服务端收到大小");
      assertEq(up.sha256, localSha, "服务端 sha256");
      const down = await httpDownload(opts, token, remote, localBack);
      assertEq(down.sha256, localSha, "下载往返 sha256");
      console.log(`      上传 ${up.mbPerS} MB/s，耗时 ${up.ms}ms`);
      execSync(`rm -f ${JSON.stringify(local)} ${JSON.stringify(localBack)}`);
      await client.call("exec", { command: `rm -f ${remote}` });
    });

    // 16. 上传认证拒绝
    await test("上传无 token 被 401 拒绝", async () => {
      const res = await httpsRequestRaw(opts, "POST", "/upload?path=/tmp/x", "data");
      assertEq(res.status, 401, "status");
    });

    // ---- relay 测试：本机自足起一个目标 daemon（独立证书/token，127.0.0.1:18793）----
    const { execSync, spawn: spawnProc } = require("child_process");
    const os = require("os");
    const pathMod = require("path");
    const tdir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "re-relay-"));
    const tPort = await findFreePort();
    const tCrt = pathMod.join(tdir, "t.crt");
    const tKey = pathMod.join(tdir, "t.key");
    const tTokenFile = pathMod.join(tdir, "t.token");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tKey} -out ${tCrt} -days 2 -subj "/CN=target" -addext "subjectAltName=IP:127.0.0.1" 2>/dev/null`,
    );
    const tToken = crypto.randomBytes(18).toString("base64");
    fs.writeFileSync(tTokenFile, tToken);
    const tSha = pathMod.join(tdir, "t.sha256");
    fs.writeFileSync(tSha, crypto.createHash("sha256").update(tToken).digest("hex"));
    const tProc = spawnProc(
      process.execPath,
      [pathMod.join(__dirname, "server.js"), "--host", "127.0.0.1", "--port", String(tPort), "--cert", tCrt, "--key", tKey, "--token-sha256-file", tSha],
      { stdio: "ignore" },
    );
    const tOpts = { host: "127.0.0.1", port: tPort, servername: "127.0.0.1", ca: tCrt };
    try {
      // 等目标就绪
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        await new Promise((r) => setTimeout(r, 150));
        ready = await httpsGet(tOpts, "/readyz").then((r) => r.status === 200).catch(() => false);
      }
      assert(ready, "目标 daemon 未就绪");
      const tCaPem = fs.readFileSync(tCrt, "utf8");
      const relay = (req, extra = {}) => client.call("relay", {
        target: { host: "127.0.0.1", port: tPort },
        auth: { token: tToken, ca: tCaPem },
        request: req,
        ...extra,
      });

      // 17. relay exec 成功 + 信封结构
      await test("relay exec 成功（信封透传）", async () => {
        const r = await relay({ method: "exec", params: { command: "echo relay-ok && hostname" } });
        assertEq(r.relayed, true, "relayed 标记");
        assertEq(r.result.exitCode, 0, "exitCode");
        assert(Buffer.from(r.result.stdoutB64, "base64").toString("utf8").includes("relay-ok"), "stdout 透传");
        assertEq(r.error, null, "error 为空");
      });

      await test("relay exec.stream 逐事件转发", async () => {
        const stdout = [];
        const r = await client.callStream("relay", {
          target: { host: "127.0.0.1", port: tPort },
          auth: { token: tToken, ca: tCaPem },
          request: { method: "exec.stream", params: { command: "printf relay-first; sleep 0.1; printf relay-second" } },
        }, (event) => stdout.push(Buffer.from(event.dataB64, "base64")));
        assertEq(Buffer.concat(stdout).toString("utf8"), "relay-firstrelay-second", "stdout");
        assertEq(r.relayed, true, "relayed 标记");
        assertEq(r.result.exitCode, 0, "exitCode");
        assertEq(r.result.reason, "exited", "reason");
      });

      await test("relay exec.stream 断连终止目标进程组", async () => {
        const cancelClient = new WssClient(opts, token);
        const pidFile = `/tmp/remote-exec-relay-stream-${Date.now()}.pid`;
        let signalReady;
        const ready = new Promise((resolve) => { signalReady = resolve; });
        try {
          await cancelClient.connect();
          const running = cancelClient.callStream("relay", {
            target: { host: "127.0.0.1", port: tPort },
            auth: { token: tToken, ca: tCaPem },
            request: { method: "exec.stream", params: { command: `echo $$ > ${pidFile}; echo ready; sleep 30` } },
          }, (event) => {
            if (Buffer.from(event.dataB64, "base64").toString("utf8").includes("ready")) signalReady();
          });
          await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("未收到 ready")), 2000))]);
          const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
          cancelClient.abort();
          await assertRejects(running, /连接已中断/);
          await new Promise((resolve) => setTimeout(resolve, 200));
          let exists = true;
          try { process.kill(pid, 0); } catch (err) { exists = err.code !== "ESRCH"; }
          assert(!exists, "relay 断连后目标 bash 进程仍存在");
        } finally {
          fs.rmSync(pidFile, { force: true });
          cancelClient.close();
        }
      });

      // 18. relay file.write/read 往返（经网关写目标、读回）
      await test("relay file.write/read 往返", async () => {
        const f = "/tmp/re-relay-roundtrip.txt";
        const payload = Buffer.from("relay 往返验证 'quote' \u00e9");
        const w = await relay({ method: "file.write", params: { file: f, contentB64: payload.toString("base64") } });
        assertEq(w.result.size, payload.length, "写入字节数");
        const rd = await relay({ method: "file.read", params: { file: f } });
        assert(Buffer.from(rd.result.contentB64, "base64").equals(payload), "内容一致");
        await relay({ method: "exec", params: { command: `rm -f ${f}` } });
      });

      // 19. 目标不可达（ECONNREFUSED → -32011）
      await test("relay 目标不可达 -32011", async () => {
        await assertRejects(
          relay({ method: "exec", params: { command: "true" } }, { target: { host: "127.0.0.1", port: 1 } }),
          /-32011/,
        );
      });

      // 20. 目标 token 错（401 → -32013）
      await test("relay 目标认证失败 -32013", async () => {
        await assertRejects(
          client.call("relay", {
            target: { host: "127.0.0.1", port: tPort },
            auth: { token: "wrong-token", ca: tCaPem },
            request: { method: "exec", params: { command: "true" } },
          }),
          /-32013/,
        );
      });

      // 21. 目标 CA 错（TLS 校验失败 → -32012）
      await test("relay 目标证书校验失败 -32012", async () => {
        await assertRejects(
          client.call("relay", {
            target: { host: "127.0.0.1", port: tPort },
            auth: { token: tToken, ca: fs.readFileSync(opts.ca, "utf8") },
            request: { method: "exec", params: { command: "true" } },
          }),
          /-32012/,
        );
      });

      // 22. 白名单拒绝（公网 IP → -32010）
      await test("relay 公网目标被白名单拒绝 -32010", async () => {
        await assertRejects(
          client.call("relay", {
            target: { host: "8.8.8.8", port: 443 },
            auth: { token: tToken, ca: tCaPem },
            request: { method: "exec", params: { command: "true" } },
          }),
          /-32010/,
        );
      });

      // 23. 嵌套 relay 被拒
      await test("relay 嵌套 relay 被拒 -32015", async () => {
        await assertRejects(
          relay({ method: "relay", params: { target: { host: "127.0.0.1", port: tPort } } }),
          /-32015/,
        );
      });

      // 24. DNS 名目标被拒（防解析绕过白名单）
      await test("relay DNS 名目标被拒 -32015", async () => {
        await assertRejects(
          client.call("relay", {
            target: { host: "localhost", port: tPort },
            auth: { token: tToken, ca: tCaPem },
            request: { method: "exec", params: { command: "true" } },
          }),
          /-32015/,
        );
      });
    } finally {
      tProc.kill("SIGTERM");
      fs.rmSync(tdir, { recursive: true, force: true });
    }
  } finally {
    client.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

function httpsGet(opts, urlPath) {
  return new Promise((resolve, reject) => {
    const req = tls.connect(
      { host: opts.host, port: opts.port, servername: tlsServerName(opts), ca: opts.ca ? fs.readFileSync(opts.ca) : undefined, rejectUnauthorized: !opts.insecure },
      () => {
        req.write(`GET ${urlPath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      },
    );
    let raw = Buffer.alloc(0);
    req.on("data", (c) => (raw = Buffer.concat([raw, c])));
    req.on("end", () => {
      const idx = raw.indexOf("\r\n\r\n");
      const status = Number(raw.subarray(0, idx).toString().split(" ")[1]);
      resolve({ status, body: raw.subarray(idx + 4).toString() });
    });
    req.on("error", reject);
  });
}

function assertRejects(promise, pattern) {
  return promise.then(
    () => {
      throw new Error("预期失败但成功了");
    },
    (err) => {
      if (pattern && !pattern.test(err.message)) throw new Error(`错误不匹配 ${pattern}: ${err.message}`);
    },
  );
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function tlsServerName(opts) {
  const name = opts.servername || opts.host;
  return /^\d+\.\d+\.\d+\.\d+$/.test(name) ? undefined : name;
}

/** 原始 HTTPS 请求（小 body） */
function httpsRequestRaw(opts, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = tls.connect(
      { host: opts.host, port: opts.port, servername: tlsServerName(opts), ca: opts.ca ? fs.readFileSync(opts.ca) : undefined, rejectUnauthorized: !opts.insecure },
      () => {
        req.write(`${method} ${urlPath} HTTP/1.1\r\nHost: h\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      },
    );
    let raw = Buffer.alloc(0);
    req.on("data", (c) => (raw = Buffer.concat([raw, c])));
    req.on("end", () => {
      const idx = raw.indexOf("\r\n\r\n");
      resolve({ status: Number(raw.subarray(0, idx).toString().split(" ")[1]), body: raw.subarray(idx + 4).toString() });
    });
    req.on("error", reject);
  });
}

/** 流式上传：本地文件 pipe 到 POST /upload，返回 {size, sha256, ms, mbPerS} */
function httpUpload(opts, token, localFile, remoteFile) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(localFile);
    const t0 = Date.now();
    const req = tls.connect(
      { host: opts.host, port: opts.port, servername: tlsServerName(opts), ca: opts.ca ? fs.readFileSync(opts.ca) : undefined, rejectUnauthorized: !opts.insecure },
      () => {
        req.write(
          `POST /upload?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\n` +
            `Authorization: Bearer ${token}\r\nContent-Length: ${stat.size}\r\nConnection: close\r\n\r\n`,
        );
        // 不发 TLS fin：fin 与服务端未消费数据竞态会让 Node https 判 aborted（100MB 实测必现）。
        // 请求由 Content-Length 定界，收完响应后再 end。
        fs.createReadStream(localFile).pipe(req, { end: false });
      },
    );
    let raw = Buffer.alloc(0);
    req.on("data", (c) => (raw = Buffer.concat([raw, c])));
    req.on("end", () => {
      req.end(); // 响应已收完，此时再关闭写侧
      const idx = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, idx).toString();
      if (!/ 200 /.test(head.split("\r\n")[0])) {
        reject(new Error(`upload 失败: ${head.split("\r\n")[0]} ${raw.subarray(idx + 4).toString()}`));
        return;
      }
      const result = JSON.parse(raw.subarray(idx + 4).toString());
      result.ms = Date.now() - t0;
      result.mbPerS = (stat.size / 1024 / 1024 / (result.ms / 1000)).toFixed(1);
      resolve(result);
    });
    req.on("error", reject);
  });
}

/** 流式下载：GET /download pipe 到本地文件，返回 {sha256} */
function httpDownload(opts, token, remoteFile, localFile) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const out = fs.createWriteStream(localFile);
    const req = tls.connect(
      { host: opts.host, port: opts.port, servername: tlsServerName(opts), ca: opts.ca ? fs.readFileSync(opts.ca) : undefined, rejectUnauthorized: !opts.insecure },
      () => {
        req.write(
          `GET /download?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\n` +
            `Authorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
        );
      },
    );
    let headerBuf = Buffer.alloc(0);
    let headerDone = false;
    req.on("data", (c) => {
      if (!headerDone) {
        headerBuf = Buffer.concat([headerBuf, c]);
        const idx = headerBuf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const status = headerBuf.subarray(0, idx).toString().split("\r\n")[0];
        if (!/ 200 /.test(status)) {
          req.destroy();
          out.destroy();
          fs.unlink(localFile, () => {});
          reject(new Error(`download 失败: ${status}`));
          return;
        }
        headerDone = true;
        const first = headerBuf.subarray(idx + 4);
        if (first.length) {
          hash.update(first);
          out.write(first);
        }
        return;
      }
      hash.update(c);
      out.write(c);
    });
    req.on("end", () => {
      out.end(() => resolve({ sha256: hash.digest("hex") }));
    });
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
