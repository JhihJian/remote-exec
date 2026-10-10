#!/usr/bin/env node
"use strict";
/**
 * remote-exec daemon
 * 单文件 WSS 远程执行服务。依赖仅 ws（WebSocket 帧解析交给成熟库，不再手写）。
 *
 * 设计参考 openai/codex app-server 的远程执行链路：
 * - TLS 内建，不依赖 nginx 终结 TLS
 * - 认证在 WebSocket upgrade 之前完成（对照 websocket.rs 的 authorize_upgrade）
 * - 服务端只存 token 的 SHA-256，常量时间比较（对照 websocket_auth.rs capability-token）
 * - exec 超时退出码沿用 GNU timeout 约定 124（对照 command_exec.rs）
 * - 明文模式仅允许回环监听（对照 is_unauthenticated_non_loopback_listener 兜底）
 * - 拒绝带 Origin 头的升级请求（防浏览器 CSRF）
 *
 * 协议：WSS 上的一条条 JSON 消息（JSON-RPC 风格）：
 *   请求 {id, method, params}，响应 {id, result} 或 {id, error:{code, message}}
 *   method = exec | file.read | file.write | relay
 *
 * relay（网关转发）：网关把单个 JSON 请求转发到局域网内另一台 daemon 并回传结果。
 * 适用场景：某局域网只暴露一个端口（经 VPN），内网多台设备各自跑 daemon，经网关分别控制。
 * 凭证（目标 token/CA）由请求携带、用后即弃，网关不落盘不日志。
 *
 * 用法：
 *   node server.js --port 8791 --cert .personal/certs/server.crt --key .personal/certs/server.key \
 *                  --token-sha256-file .personal/token.sha256
 *   node server.js --host 127.0.0.1 --port 8791 --insecure-http --token-sha256-file .personal/token.sha256
 *   可选 --relay-allow <cidr>（可重复，默认仅允许回环 + RFC1918 私网）
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const DEFAULT_OUTPUT_CAP = 1024 * 1024; // exec 输出收集上限，防内存爆
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const EXEC_TIMEOUT_EXIT_CODE = 124;
const STREAM_CHUNK_BYTES = 16 * 1024;
const STREAM_SEND_STALL_MS = 30 * 1000;
const MAX_PAYLOAD = 64 * 1024 * 1024; // 单帧上限，防超大帧攻击
const HTTP_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 大文件传输的空闲超时

// relay 相关：总预算、并发上限、内层参数钳制
const RELAY_CONNECT_BUDGET_MS = 10 * 1000;
const RELAY_SLACK_MS = 15 * 1000;
const RELAY_MAX_CONCURRENT = 8;
const RELAY_MAX_INNER_TIMEOUT_MS = 10 * 60 * 1000;
const RELAY_MAX_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_RELAY_ALLOW = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const RELAY_INNER_METHODS = new Set(["exec", "exec.stream", "file.read", "file.write"]);
const { WebSocket } = require("ws");

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const opts = { host: "127.0.0.1", port: 8791 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 需要一个值`);
      return argv[++i];
    };
    if (a === "--host") opts.host = next();
    else if (a === "--port") opts.port = Number(next());
    else if (a === "--cert") opts.cert = next();
    else if (a === "--key") opts.key = next();
    else if (a === "--token-sha256-file") opts.tokenSha256File = next();
    else if (a === "--insecure-http") opts.insecureHttp = true;
    else if (a === "--relay-allow") {
      (opts.relayAllow = opts.relayAllow || []).push(next());
    } else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(`用法: node server.js --port 8791 --cert <crt> --key <key> --token-sha256-file <file>
      node server.js --host 127.0.0.1 --insecure-http --token-sha256-file <file>
      可选 --relay-allow <cidr>（可重复，默认仅允许回环 + RFC1918 私网，禁止转发公网）
      node server.js --host 127.0.0.1 --insecure-http --token-sha256-file <file>

依赖: npm install ws （打包部署时随 node_modules/ws 一起传输）

生成自签证书:
  openssl req -x509 -newkey rsa:2048 -nodes \\
    -keyout certs/server.key -out certs/server.crt -days 3650 \\
    -subj "/CN=<host>" -addext "subjectAltName=DNS:<host>,IP:<ip>"

生成 token 及其 SHA-256:
  TOKEN=$(head -c 24 /dev/urandom | base64); printf '%s' "$TOKEN" > .personal/token.txt
  sha256sum .personal/token.txt | cut -d' ' -f1 > .personal/token.sha256`);
}

// ---------- 日志 ----------

function log(event, extra = "") {
  process.stderr.write(`[${new Date().toISOString()}] ${event}${extra ? " " + extra : ""}\n`);
}

// ---------- 认证（对照 websocket_auth.rs authorize_upgrade） ----------

function loadTokenSha256(file) {
  const hex = fs.readFileSync(file, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`token sha256 文件格式错误（需要 64 位 hex）: ${file}`);
  return Buffer.from(hex, "hex");
}

function bearerTokenFromHeaders(headers) {
  const auth = headers.authorization;
  if (!auth || !/^Bearer /i.test(auth)) return null;
  return auth.slice(7).trim();
}

function checkToken(tokenSha256, headers) {
  const token = bearerTokenFromHeaders(headers);
  if (!token) return false;
  const actual = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(tokenSha256, actual); // 常量时间比较，防时序攻击
}

// ---------- 方法实现 ----------

function rpcError(code, message) {
  const err = new Error(message);
  err.rpcCode = code;
  return err;
}

const b64 = (buf) => buf.toString("base64");

function terminateProcessGroup(child) {
  const signal = (name) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (err) {
      if (err.code !== "ESRCH") {
        try { child.kill(name); } catch { /* 进程已退出 */ }
      }
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 2000).unref();
}

function spawnShell(command, cwd) {
  return spawn("bash", ["-lc", command], {
    cwd: cwd || undefined,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 执行 shell 命令（对照 command_exec.rs 的非 tty 分支：spawn + 收集 + 超时 kill；onCancel 注册断连取消） */
function execCommand(params, _ctx, onCancel) {
  const { command, cwd, timeoutMs, outputBytesCap } = params;
  if (typeof command !== "string" || !command.trim()) throw rpcError(-32602, "params.command 必须是非空字符串");
  if (cwd !== undefined && !path.isAbsolute(cwd)) throw rpcError(-32602, "params.cwd 必须是绝对路径");
  const cap = Math.max(1, Number(outputBytesCap) || DEFAULT_OUTPUT_CAP);
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);

  return new Promise((resolve) => {
    const child = spawnShell(command, cwd);
    const chunks = { out: [], err: [] }; // 块列表 + 一次 concat，避免反复拷贝
    let collected = { out: 0, err: 0 };
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    const killChild = () => terminateProcessGroup(child);
    const collect = (which) => (data) => {
      if (collected[which] >= cap) {
        truncated = true;
        return;
      }
      const room = cap - collected[which];
      const piece = data.length > room ? data.subarray(0, room) : data;
      if (piece.length < data.length) truncated = true;
      chunks[which].push(piece);
      collected[which] += piece.length;
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeout);
    const unregisterCancel = onCancel ? onCancel(() => { cancelled = true; killChild(); }) : () => {};
    let done = false;
    let drainTimer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      unregisterCancel();
      resolve(result);
    };
    child.on("error", (err) =>
      finish({
        exitCode: -1,
        stdoutB64: b64(Buffer.concat(chunks.out)),
        stderrB64: b64(Buffer.concat([...chunks.err, Buffer.from(String(err))])),
        truncated,
      }),
    );
    child.on("close", (code) =>
      finish({
        exitCode: cancelled ? 130 : timedOut ? EXEC_TIMEOUT_EXIT_CODE : (code ?? -1),
        stdoutB64: b64(Buffer.concat(chunks.out)),
        stderrB64: b64(Buffer.concat(chunks.err)),
        truncated,
      }),
    );
    // 后台进程继承 stdio 会 hold 住管道导致 close 永不触发（如 nohup setsid 起服务）：
    // 主进程 exit 后等 500ms flush，仍无 close 则强制收尾，避免 exec 挂死
    child.on("exit", (code) => {
      drainTimer = setTimeout(
        () =>
          finish({
            exitCode: cancelled ? 130 : timedOut ? EXEC_TIMEOUT_EXIT_CODE : (code ?? -1),
            stdoutB64: b64(Buffer.concat(chunks.out)),
            stderrB64: b64(Buffer.concat(chunks.err)),
            truncated,
          }),
        500,
      );
    });
  });
}

/** 持续回传 stdout/stderr，终态仍通过普通 JSON-RPC result 发送。 */
function execStreamCommand(params, ctx, onCancel) {
  const { command, cwd, timeoutMs } = params;
  if (typeof command !== "string" || !command.trim()) throw rpcError(-32602, "params.command 必须是非空字符串");
  if (cwd !== undefined && !path.isAbsolute(cwd)) throw rpcError(-32602, "params.cwd 必须是绝对路径");
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);

  return new Promise((resolve) => {
    const child = spawnShell(command, cwd);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let transportFailed = false;
    let done = false;
    let drainTimer = null;
    let paused = false;
    let sendChain = Promise.resolve();
    const killChild = () => terminateProcessGroup(child);
    const unregisterCancel = onCancel ? onCancel(() => { cancelled = true; killChild(); }) : () => {};
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeout);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      unregisterCancel();
      resolve({
        exitCode: cancelled || transportFailed ? 130 : timedOut ? EXEC_TIMEOUT_EXIT_CODE : (code ?? -1),
        reason: cancelled || transportFailed ? "cancelled" : timedOut ? "timeout" : "exited",
        stdoutBytes,
        stderrBytes,
      });
    };
    const emitWithStallLimit = (event) => new Promise((resolveSend, rejectSend) => {
      const timerId = setTimeout(() => rejectSend(new Error("流式输出发送停滞")), STREAM_SEND_STALL_MS);
      ctx.emitEvent(event).then(
        () => { clearTimeout(timerId); resolveSend(); },
        (err) => { clearTimeout(timerId); rejectSend(err); },
      );
    });
    const enqueueOutput = (stream, data) => {
      if (done || transportFailed) return;
      if (stream === "stdout") stdoutBytes += data.length;
      else stderrBytes += data.length;
      if (!paused) {
        paused = true;
        child.stdout.pause();
        child.stderr.pause();
      }
      sendChain = sendChain
        .then(async () => {
          if (transportFailed || done) return;
          for (let offset = 0; offset < data.length; offset += STREAM_CHUNK_BYTES) {
            await emitWithStallLimit({
              event: "output",
              stream,
              dataB64: b64(data.subarray(offset, offset + STREAM_CHUNK_BYTES)),
            });
          }
        })
        .catch(() => {
          transportFailed = true;
          cancelled = true;
          killChild();
        });
      const thisChain = sendChain;
      thisChain.then(() => {
        if (thisChain === sendChain && paused && !done && !transportFailed) {
          paused = false;
          child.stdout.resume();
          child.stderr.resume();
        }
      });
    };

    child.stdout.on("data", (data) => enqueueOutput("stdout", data));
    child.stderr.on("data", (data) => enqueueOutput("stderr", data));
    child.on("error", () => sendChain.then(() => finish(-1)));
    child.on("close", (code) => sendChain.then(() => finish(code)));
    // 后台进程仍持有 stdout/stderr 时，沿用 exec 的收尾策略。
    child.on("exit", (code) => {
      drainTimer = setTimeout(() => sendChain.then(() => finish(code)), 500);
    });
  });
}

async function fileRead(params) {
  const { file } = params;
  if (typeof file !== "string" || !path.isAbsolute(file)) throw rpcError(-32602, "params.file 必须是绝对路径");
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw rpcError(-32603, `文件不存在或不是常规文件: ${file}`);
  if (st.size > MAX_PAYLOAD) {
    throw rpcError(-32602, `文件 ${st.size} 字节超过 ${MAX_PAYLOAD} 上限，请分段读取或使用 /download 流式下载`);
  }
  const content = await fs.promises.readFile(file);
  return { contentB64: b64(content), size: content.length };
}

async function fileWrite(params) {
  const { file, contentB64 } = params;
  if (typeof file !== "string" || !path.isAbsolute(file)) throw rpcError(-32602, "params.file 必须是绝对路径");
  if (typeof contentB64 !== "string") throw rpcError(-32602, "params.contentB64 必须是 base64 字符串");
  const content = Buffer.from(contentB64, "base64");
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content);
  return { size: content.length };
}

let RELAY_ALLOW = DEFAULT_RELAY_ALLOW; // main() 启动时按 --relay-allow 覆盖

const METHODS = {
  exec: execCommand,
  "exec.stream": execStreamCommand,
  "file.read": fileRead,
  "file.write": fileWrite,
  relay: (params, ctx, onCancel) => relayRequest(params, ctx, onCancel),
};

// ---------- relay：网关转发单个请求到局域网内另一台 daemon ----------

/** IPv4 字面量 → 整数，非 IPv4 字面量返回 null（relay 目标仅接受 IP，拒绝 DNS 名防解析绕过白名单） */
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInCidr(ip, cidr) {
  const slash = cidr.indexOf("/");
  const base = slash < 0 ? cidr : cidr.slice(0, slash);
  const prefix = slash < 0 ? 32 : Number(cidr.slice(slash + 1));
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null || !(prefix >= 0 && prefix <= 32)) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function relayAllowedByTarget(host, allowList) {
  return allowList.some((cidr) => ipInCidr(host, cidr));
}

function relayErr(code, message, stage) {
  const err = rpcError(code, message);
  err.data = { stage };
  return err;
}

let activeRelays = 0;

/** 网关转发：连接目标 daemon，发送单个请求，回传信封。凭证用后即弃（不落盘、不日志、不缓存） */
function relayRequest(params, ctx, onCancel) {
  const { target, auth, request } = params || {};
  if (
    !target || typeof target.host !== "string" || typeof target.port !== "number" ||
    !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 ||
    !auth || typeof auth.token !== "string" || !auth.token ||
    typeof auth.ca !== "string" || !auth.ca.includes("BEGIN CERTIFICATE") ||
    !request || typeof request.method !== "string"
  ) {
    throw relayErr(
      -32015,
      "params 需要 {target:{host,port}, auth:{token,ca}, request:{method,params}}，auth.ca 必须是目标 CA 的 PEM 文本",
      "validate",
    );
  }
  if (ipv4ToInt(target.host) === null) {
    throw relayErr(-32015, `target.host 必须是 IPv4 字面量（拒绝 DNS 名，防解析绕过白名单）: ${target.host}`, "validate");
  }
  if (!relayAllowedByTarget(target.host, ctx.relayAllow)) {
    throw relayErr(-32010, `目标 ${target.host} 不在 relay 白名单（--relay-allow）内`, "allowlist");
  }
  if (!RELAY_INNER_METHODS.has(request.method)) {
    throw relayErr(-32015, `relay 仅支持转发 ${[...RELAY_INNER_METHODS].join("/")}，禁止嵌套 relay`, "validate");
  }
  if (activeRelays >= RELAY_MAX_CONCURRENT) {
    throw relayErr(-32015, `relay 并发已达上限（${RELAY_MAX_CONCURRENT}），请稍后重试`, "validate");
  }

  // 内层参数钳制：不让远端请求指定超长超时/超大输出，防挂死与内存放大
  const innerParams = { ...(request.params || {}) };
  if (innerParams.timeoutMs !== undefined) {
    innerParams.timeoutMs = Math.min(Math.max(1, Number(innerParams.timeoutMs) || 0), RELAY_MAX_INNER_TIMEOUT_MS);
  }
  const innerBudget = Math.min(innerParams.timeoutMs || DEFAULT_TIMEOUT_MS, RELAY_MAX_INNER_TIMEOUT_MS);
  const totalTimeout = Math.min(
    Number(params.timeoutMs) || RELAY_CONNECT_BUDGET_MS + innerBudget + RELAY_SLACK_MS,
    RELAY_MAX_TOTAL_TIMEOUT_MS,
  );

  activeRelays += 1;
  const peer = `${target.host}:${target.port}`;
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let terminalReceived = false;
    let targetPaused = false;
    let forwardChain = Promise.resolve();
    const ws = new WebSocket(`wss://${peer}/`, {
      ca: auth.ca,
      rejectUnauthorized: true, // 网关侧严格校验目标证书，不提供关闭选项
      headers: { authorization: `Bearer ${auth.token}` },
      handshakeTimeout: RELAY_CONNECT_BUDGET_MS,
    });
    // 上游客户端断连：结算并断开对目标的连接 → 目标 daemon 断连终止执行中的子进程
    const unregisterCancel = onCancel ? onCancel(() => settle(relayErr(-32014, `上游客户端断开: ${peer}`, "aborted"))) : () => {};
    const timer = setTimeout(() => {
      settle(relayErr(-32014, `relay 总超时（${totalTimeout}ms）: ${peer}`, "deadline"));
    }, totalTimeout);
    const finish = (err) => {
      clearTimeout(timer);
      activeRelays -= 1;
      unregisterCancel();
      try { ws.terminate(); } catch {}
    };
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      finish();
      log(err ? "relay.fail" : "relay", `${peer} ${request.method} ${err ? err.message : "ok"} ${Date.now() - t0}ms`);
      if (err) resolve(Promise.reject(err));
      else resolve(value);
    };
    const forwardEvent = (event) => new Promise((resolveForward, rejectForward) => {
      const timerId = setTimeout(() => rejectForward(new Error("relay 流式输出发送停滞")), STREAM_SEND_STALL_MS);
      ctx.emitEvent(event).then(
        () => { clearTimeout(timerId); resolveForward(); },
        (err) => { clearTimeout(timerId); rejectForward(err); },
      );
    });
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: request.method, params: innerParams })));
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        settle(relayErr(-32015, "目标返回非 JSON 响应", "validate"));
        return;
      }
      if (msg.id !== 1) {
        settle(relayErr(-32015, "目标响应 id 不匹配", "validate"));
        return;
      }
      if (msg.event) {
        if (request.method !== "exec.stream" || msg.event !== "output" ||
          (msg.stream !== "stdout" && msg.stream !== "stderr") || typeof msg.dataB64 !== "string") {
          settle(relayErr(-32015, "目标发送了无效流式事件", "validate"));
          return;
        }
        if (!targetPaused) {
          targetPaused = true;
          ws.pause();
        }
        forwardChain = forwardChain
          .then(() => {
            if (settled) return;
            return forwardEvent({ event: "output", stream: msg.stream, dataB64: msg.dataB64 });
          })
          .catch(() => settle(relayErr(-32014, `上游连接已断开: ${peer}`, "aborted")));
        const thisChain = forwardChain;
        thisChain.then(() => {
          if (thisChain === forwardChain && targetPaused && !settled) {
            targetPaused = false;
            ws.resume();
          }
        });
        return;
      }
      if (terminalReceived) return;
      terminalReceived = true;
      forwardChain.then(() => {
        // 信封：目标业务错误原样透传（result: null + error），网关自身失败走顶层 error
        settle(null, { relayed: true, result: msg.result ?? null, error: msg.error ?? null });
      });
    });
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) settle(relayErr(-32013, `目标认证失败（token 不匹配）: ${peer}`, "auth"));
      else settle(relayErr(-32011, `目标拒绝升级（HTTP ${res.statusCode}）: ${peer}`, "connect"));
    });
    ws.on("error", (err) => {
      const code = err.code || "";
      const msg = String(err.message || err);
      if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"].includes(code)) {
        settle(relayErr(-32011, `目标不可达: ${msg}`, "connect"));
      } else if (
        code.includes("TLS") || code.includes("CERT") || /certificate|SSL|TLS/i.test(msg)
      ) {
        settle(relayErr(-32012, `目标证书校验失败: ${msg}`, "tls"));
      } else {
        settle(relayErr(-32011, `relay 失败: ${msg}`, "connect"));
      }
    });
    ws.on("close", () => {
      if (!settled && !terminalReceived) settle(relayErr(-32011, `目标连接提前关闭: ${peer}`, "connect"));
    });
  });
}

// ---------- WebSocket 会话（帧解析由 ws 库负责，协议错误自动断连） ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

wss.on("connection", (ws, req) => {
  const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  log("ws.opened", peer);
  let queue = Promise.resolve(); // 串行处理请求，保证顺序语义
  const inflight = new Set(); // 执行中的可取消操作（exec 子进程），断连时统一终止
  const sendJson = (msg) => new Promise((resolve, reject) => {
    if (ws.readyState !== ws.OPEN) {
      reject(new Error("连接已关闭"));
      return;
    }
    ws.send(JSON.stringify(msg), (err) => (err ? reject(err) : resolve()));
  });

  ws.on("message", (data) => {
    let req;
    try {
      req = JSON.parse(data.toString("utf8"));
    } catch {
      sendJson({ id: null, error: { code: -32700, message: "JSON 解析失败" } }).catch(() => {});
      return;
    }
    queue = queue
      .then(async () => {
        if (!req || typeof req.method !== "string") throw rpcError(-32600, "请求需要 method 字段");
        const handler = METHODS[req.method];
        if (!handler) throw rpcError(-32601, `未知方法: ${req.method}`);
        const id = req.id ?? null;
        const result = await handler(
          req.params || {},
          {
            relayAllow: RELAY_ALLOW,
            emitEvent: (event) => sendJson({ id, ...event }),
          },
          (cancel) => {
            inflight.add(cancel);
            return () => inflight.delete(cancel);
          },
        );
        return { id: req.id ?? null, result };
      })
      .catch((err) => ({
        id: req.id ?? null,
        error: { code: err.rpcCode ?? -32000, message: err.message, data: err.data },
      }))
      .then((msg) => {
        return sendJson(msg).catch(() => {});
      });
  });

  ws.on("error", (err) => log("ws.error", `${peer} ${err.message}`));
  ws.on("close", () => {
    log("ws.closed", peer);
    if (inflight.size) {
      log("ws.cancel", `${peer} 终止 ${inflight.size} 个执行中的操作`);
      [...inflight].forEach((cancel) => cancel());
    }
  });
});

// ---------- HTTP / upgrade 入口 ----------

/** POST /upload?path=/abs/file —— 流式接收大文件：临时文件 + sha256 + 原子 rename，内存 O(1) */
function handleUpload(req, res, tokenSha256) {
  const url = new URL(req.url, "https://localhost");
  const file = url.searchParams.get("path");
  if (!file || !path.isAbsolute(file)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "path 必须是绝对路径" }));
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  log("upload.start", file);
  const tmp = path.join(
    path.dirname(file),
    `.remote-exec-tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const hash = crypto.createHash("sha256");
  let size = 0;
  const out = fs.createWriteStream(tmp, { mode: 0o644 });
  const fail = (status, message) => {
    out.destroy();
    fs.unlink(tmp, () => {});
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    } else res.destroy();
  };
  req.on("data", (chunk) => {
    size += chunk.length;
    hash.update(chunk);
  });
  req.on("end", () => log("upload.req-end", `${size}B`));
  req.on("error", (err) => { log("upload.req-error", String(err)); fail(500, String(err)); });
  req.on("aborted", () => { log("upload.aborted", `${size}B`); fail(500, "客户端中断"); });
  out.on("error", (err) => { log("upload.out-error", String(err)); fail(500, String(err)); });
  out.on("finish", () => {
    // 先落盘完成（req 流 pipe 到 finish）再校验 rename
    fs.rename(tmp, file, (err) => {
      if (err) {
        fail(500, String(err));
        return;
      }
      const body = JSON.stringify({ size, sha256: hash.digest("hex") });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      log("upload", `${file} ${size}B`);
    });
  });
  req.pipe(out);
}

/** GET /download?path=/abs/file —— 流式回传大文件，Content-Length 预告知 */
function handleDownload(req, res, tokenSha256) {
  const url = new URL(req.url, "https://localhost");
  const file = url.searchParams.get("path");
  if (!file || !path.isAbsolute(file)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "path 必须是绝对路径" }));
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `文件不存在: ${file}` }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": st.size,
    });
    fs.createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
    log("download", `${file} ${st.size}B`);
  });
}

function createServer(opts, tokenSha256) {
  const requestHandler = (req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": 3 });
      res.end("ok\n");
      return;
    }
    const isUpload = req.method === "POST" && req.url.startsWith("/upload");
    const isDownload = req.method === "GET" && req.url.startsWith("/download");
    if (isUpload || isDownload) {
      if (!checkToken(tokenSha256, req.headers)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized\n");
        log(isUpload ? "upload" : "download", "rejected-auth");
        return;
      }
      req.setTimeout(HTTP_IDLE_TIMEOUT_MS);
      if (isUpload) handleUpload(req, res, tokenSha256);
      else handleDownload(req, res, tokenSha256);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  };

  const onUpgrade = (req, socket, head) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    // 防浏览器 CSRF：带 Origin 的升级一律拒绝（对照 websocket.rs reject_requests_with_origin_header）
    if (req.headers.origin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      log("upgrade.rejected-origin", peer);
      return;
    }
    if (!checkToken(tokenSha256, req.headers)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      log("upgrade.rejected-auth", peer);
      return;
    }
    // 认证通过后才交给 ws 库完成协议升级
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };

  const server = opts.insecureHttp
    ? http.createServer(requestHandler)
    : https.createServer(
        { cert: fs.readFileSync(opts.cert), key: fs.readFileSync(opts.key) },
        requestHandler,
      );
  server.requestTimeout = 0; // 大文件上传不受默认 300s 限制，空闲超时由 req.setTimeout 单独控制
  server.on("upgrade", onUpgrade);
  return server;
}

// ---------- 启动 ----------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!opts.tokenSha256File) throw new Error("必须提供 --token-sha256-file");
  const tokenSha256 = loadTokenSha256(opts.tokenSha256File);
  if (opts.relayAllow) RELAY_ALLOW = opts.relayAllow;

  if (opts.insecureHttp) {
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(opts.host);
    // 明文仅允许回环：对照 codex 拒绝无认证非回环监听的安全兜底
    if (!loopback) throw new Error("明文模式（--insecure-http）只允许监听回环地址");
  } else {
    if (!opts.cert || !opts.key) throw new Error("TLS 模式必须提供 --cert 与 --key");
  }

  const server = createServer(opts, tokenSha256);
  server.listen(opts.port, opts.host, () => {
    const scheme = opts.insecureHttp ? "ws" : "wss";
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : opts.port;
    log("listening", `${scheme}://${opts.host}:${port} (token 认证已启用, ws 库处理帧协议)`);
  });
}

main();
