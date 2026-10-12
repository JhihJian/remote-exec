"use strict";

const fs = require("fs");
const tls = require("tls");
const crypto = require("crypto");

class WssClient {
  constructor(opts) {
    this.o = opts;
    this.pending = new Map();
    this.nextId = 1;
  }

  connect() {
    const token = this.token || "";
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const sn = this.o.servername || this.o.host;
      const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(sn);
      const req = tls.connect({
        host: this.o.host,
        port: this.o.port,
        servername: isIp ? undefined : sn,
        ca: this.o.ca ? fs.readFileSync(this.o.ca) : undefined,
        rejectUnauthorized: !this.o.insecure,
      }, () => {
        req.write(`GET / HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`);
      });
      this.buf = Buffer.alloc(0);
      this.upgraded = false;
      req.setTimeout(15000, () => req.destroy(new Error("TLS/WSS 连接超时")));
      req.on("data", (chunk) => this.onData(chunk, resolve, reject));
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

  onData(chunk, resolve, reject) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.upgraded) {
      const i = this.buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      const head = this.buf.subarray(0, i).toString();
      if (!head.includes("101")) {
        reject(new Error(`upgrade 失败: ${head.split("\r\n")[0]}`));
        return;
      }
      this.upgraded = true;
      this.socket.setTimeout(0);
      this.buf = this.buf.subarray(i + 4);
      resolve();
    }
    while (this.buf.length >= 2) {
      const opcode = this.buf[0] & 0x0f;
      const lenBits = this.buf[1] & 0x7f;
      let offset;
      let length;
      if (lenBits < 126) { length = lenBits; offset = 2; }
      else if (lenBits === 126) { if (this.buf.length < 4) return; length = this.buf.readUInt16BE(2); offset = 4; }
      else { if (this.buf.length < 10) return; length = Number(this.buf.readBigUInt64BE(2)); offset = 10; }
      if (this.buf.length < offset + length) return;
      const payload = this.buf.subarray(offset, offset + length);
      this.buf = this.buf.subarray(offset + length);
      if (opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(payload.toString("utf8")); }
      catch (err) { this.failPending(new Error(`服务端返回非 JSON 消息: ${err.message}`)); continue; }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      if (msg.event) {
        if (pending.onEvent) pending.onEvent(msg);
        continue;
      }
      this.pending.delete(msg.id);
      msg.error
        ? pending.reject(new Error(`rpc ${msg.error.code}: ${msg.error.message}`))
        : pending.resolve(msg.result);
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
      for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i & 3];
      this.socket.write(Buffer.concat([header, mask, masked]));
    });
  }

  failPending(err) {
    this.pending.forEach((pending) => pending.reject(err));
    this.pending.clear();
  }

  close() {
    if (this.socket) {
      try { this.socket.write(Buffer.from([0x88, 0x00])); this.socket.end(); } catch { /* 已关闭 */ }
    }
  }

  abort() {
    if (!this.socket) return;
    this.failPending(new Error("连接已中断"));
    this.socket.destroy();
  }
}

module.exports = { WssClient };