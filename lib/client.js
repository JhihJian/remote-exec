"use strict";
/**
 * remote-exec 公共客户端库：hosts.json 加载、WSS 客户端（直连/relay）、HTTP 流式传输。
 * 被 tui-client.js 使用；WssClient 实现与 test-client.js、pi-extension/remote-exec.ts 同源。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tls = require("tls");
const crypto = require("crypto");

// ---------- 配置 ----------

function loadConfig() {
  const p = path.join(os.homedir(), ".config", "remote-exec", "hosts.json");
  if (!fs.existsSync(p)) throw new Error(`配置不存在: ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---------- WSS 客户端（TLS + 手写 RFC 6455 帧） ----------

class WssClient {
  constructor(opts) {
    this.o = opts; // { host, port, servername?, ca?, insecure? }
    this.pending = new Map();
    this.nextId = 1;
  }
  connect() {
    const token = this.token || ""; // 由 connectToken 设置
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      // servername 为 IP 字面量时不传（DEP0123；证书 SAN 已含 IP，验证用 host 匹配）
      const sn = this.o.servername || this.o.host;
      const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(sn);
      const req = tls.connect({
        host: this.o.host, port: this.o.port, servername: isIp ? undefined : sn,
        ca: this.o.ca ? fs.readFileSync(this.o.ca) : undefined, rejectUnauthorized: !this.o.insecure,
      }, () => {
        req.write(`GET / HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`);
      });
      this.buf = Buffer.alloc(0); this.upgraded = false;
      req.on("data", (c) => this.onData(c, resolve, reject));
      req.on("error", (err) => {
        if (!this.upgraded) reject(err);
        this.failPending(err);
      });
      req.on("end", () => this.failPending(new Error("远程连接已关闭")));
      req.on("close", () => this.failPending(new Error("远程连接已关闭")));
      this.socket = req;
    });
  }
  connectToken(token) { this.token = token; return this.connect(); }
  onData(c, resolve, reject) {
    this.buf = Buffer.concat([this.buf, c]);
    if (!this.upgraded) {
      const i = this.buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      const head = this.buf.subarray(0, i).toString();
      if (!head.includes("101")) { reject(new Error(`upgrade 失败: ${head.split("\r\n")[0]}`)); return; }
      this.upgraded = true; this.buf = this.buf.subarray(i + 4);
      resolve();
    }
    while (this.buf.length >= 2) {
      const opcode = this.buf[0] & 0x0f;
      const lenBits = this.buf[1] & 0x7f;
      let off, len;
      if (lenBits < 126) { len = lenBits; off = 2; }
      else if (lenBits === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode !== 0x1) continue;
      let msg;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch (err) {
        this.failPending(new Error(`服务端返回非 JSON 消息: ${err.message}`));
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      if (msg.event) {
        if (p.onEvent) p.onEvent(msg);
        continue;
      }
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`rpc ${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
    }
  }
  call(method, params = {}) { return this.callStream(method, params); }
  callStream(method, params = {}, onEvent) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      const body = Buffer.from(JSON.stringify({ id, method, params }));
      const mask = crypto.randomBytes(4);
      let header;
      if (body.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | body.length; }
      else { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(body.length, 2); }
      header[0] = 0x81;
      const masked = Buffer.alloc(body.length);
      for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i & 3];
      this.socket.write(Buffer.concat([header, mask, masked]));
    });
  }
  failPending(err) {
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
  }
  close() { if (this.socket) { try { this.socket.write(Buffer.from([0x88, 0x00])); this.socket.end(); } catch { /* 已关闭 */ } } }
  /** 立即断开连接（服务端断连时会终止执行中的子进程），pending 全部 reject */
  abort() {
    if (!this.socket) return;
    const err = new Error("连接已中断");
    this.failPending(err);
    this.socket.destroy();
  }
}

// ---------- 统一调用入口（直连 / relay） ----------

/**
 * 目标带 via 时经网关 relay 转发：凭证（目标 token/CA）随请求携带，网关不存储。
 * 每次调用建立新连接，用完即关；onAbort 在调用被外部中断时触发（断开连接，
 * 服务端检测断连会终止执行中的子进程，relay 链同理逐级传播）。
 */
async function callHost(hostName, method, params, onAbort) {
  const config = loadConfig();
  const hosts = config?.hosts;
  const host = hosts?.[hostName];
  if (!host) {
    const available = hosts ? Object.keys(hosts).join(", ") : "（配置不存在或为空）";
    throw new Error(`未知主机 "${hostName}"，可用主机: ${available}`);
  }
  const targetToken = fs.readFileSync(host.tokenFile, "utf8").trim();

  if (!host.via) {
    const client = new WssClient({ host: host.host, port: host.port, servername: host.servername, ca: host.ca });
    if (onAbort) onAbort(() => client.abort());
    try {
      await client.connectToken(targetToken);
      return await client.call(method, params);
    } finally { client.close(); }
  }

  const gateway = hosts[host.via];
  if (!gateway) throw new Error(`主机 "${hostName}" 的 via 网关 "${host.via}" 不在配置中`);
  if (gateway.via) throw new Error(`via 链深度仅支持 1，不支持链式转发`);
  const gatewayToken = fs.readFileSync(gateway.tokenFile, "utf8").trim();
  const client = new WssClient({ host: gateway.host, port: gateway.port, servername: gateway.servername, ca: gateway.ca });
  if (onAbort) onAbort(() => client.abort());
  try {
    await client.connectToken(gatewayToken);
    const envelope = await client.call("relay", {
      target: { host: host.host, port: host.port },
      auth: { token: targetToken, ca: fs.readFileSync(host.ca, "utf8") },
      request: { method, params },
    });
    if (envelope.error) throw new Error(`目标返回错误 rpc ${envelope.error.code}: ${envelope.error.message}`);
    return envelope.result;
  } finally { client.close(); }
}

/** 单请求持续接收事件，终态仍以 Promise 返回。 */
async function callHostStream(hostName, method, params, onEvent, onAbort) {
  const config = loadConfig();
  const hosts = config?.hosts;
  const host = hosts?.[hostName];
  if (!host) {
    const available = hosts ? Object.keys(hosts).join(", ") : "（配置不存在或为空）";
    throw new Error(`未知主机 "${hostName}"，可用主机: ${available}`);
  }
  const targetToken = fs.readFileSync(host.tokenFile, "utf8").trim();

  if (!host.via) {
    const client = new WssClient({ host: host.host, port: host.port, servername: host.servername, ca: host.ca });
    if (onAbort) onAbort(() => client.abort());
    try {
      await client.connectToken(targetToken);
      return await client.callStream(method, params, onEvent);
    } finally { client.close(); }
  }

  const gateway = hosts[host.via];
  if (!gateway) throw new Error(`主机 "${hostName}" 的 via 网关 "${host.via}" 不在配置中`);
  if (gateway.via) throw new Error("via 链深度仅支持 1，不支持链式转发");
  const gatewayToken = fs.readFileSync(gateway.tokenFile, "utf8").trim();
  const client = new WssClient({ host: gateway.host, port: gateway.port, servername: gateway.servername, ca: gateway.ca });
  if (onAbort) onAbort(() => client.abort());
  try {
    await client.connectToken(gatewayToken);
    const envelope = await client.callStream("relay", {
      target: { host: host.host, port: host.port },
      auth: { token: targetToken, ca: fs.readFileSync(host.ca, "utf8") },
      request: { method, params },
    }, onEvent);
    if (envelope.error) throw new Error(`目标返回错误 rpc ${envelope.error.code}: ${envelope.error.message}`);
    return envelope.result;
  } finally { client.close(); }
}

// ---------- HTTP 流式传输（仅直连主机） ----------

function httpOp(host, op, localFile, remoteFile) {
  return new Promise((resolve, reject) => {
    const config = loadConfig();
    const h = config.hosts[host];
    if (!h) throw new Error(`未知主机 "${host}"`);
    if (h.via) throw new Error(`"${host}" 经网关中转，暂不支持流式传输`);
    const token = fs.readFileSync(h.tokenFile, "utf8").trim();
    const fail = (err) => reject(err instanceof Error ? err : new Error(String(err)));
    let req;
    if (op === "upload") {
      const stat = fs.statSync(localFile);
      req = tls.connect({ host: h.host, port: h.port, servername: /^\d+\.\d+\.\d+\.\d+$/.test(h.servername || h.host) ? undefined : (h.servername || h.host), ca: h.ca ? fs.readFileSync(h.ca) : undefined, rejectUnauthorized: true }, () => {
        req.write(`POST /upload?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${stat.size}\r\nConnection: close\r\n\r\n`);
        fs.createReadStream(localFile).pipe(req, { end: false });
      });
    } else {
      req = tls.connect({ host: h.host, port: h.port, servername: /^\d+\.\d+\.\d+\.\d+$/.test(h.servername || h.host) ? undefined : (h.servername || h.host), ca: h.ca ? fs.readFileSync(h.ca) : undefined, rejectUnauthorized: true }, () => {
        req.write(`GET /download?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
      });
    }
    let raw = Buffer.alloc(0);
    req.on("data", (c) => (raw = Buffer.concat([raw, c])));
    req.on("end", () => {
      req.end();
      const i = raw.indexOf("\r\n\r\n");
      if (i < 0) return fail("响应不完整");
      const statusLine = raw.subarray(0, i).toString().split("\r\n")[0];
      if (!/ 200 /.test(statusLine)) return fail(`HTTP 失败: ${statusLine}`);
      const body = raw.subarray(i + 4);
      if (op === "upload") {
        try { resolve(JSON.parse(body.toString())); } catch (e) { fail(e); }
      } else {
        fs.writeFileSync(localFile, body);
        resolve({ size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") });
      }
    });
    req.on("error", fail);
  });
}

module.exports = { loadConfig, WssClient, callHost, callHostStream, httpOp };
