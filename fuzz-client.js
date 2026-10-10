#!/usr/bin/env node
"use strict";
/**
 * 畸形输入健壮性验证：正确 upgrade 后向服务端灌非法 WS 数据。
 * 覆盖曾导致 2GB OOM 死循环的三种 protocol-error 输入：
 *   1. 未 mask 的客户端帧
 *   2. 非法 opcode
 *   3. 随机垃圾字节
 * 预期：服务端立即断开连接、进程存活、内存稳定。
 * 用法: node fuzz-client.js --host 127.0.0.1 --port 8791 --token-file .personal/token.txt --ca .personal/certs/server.crt
 */

const tls = require("tls");
const crypto = require("crypto");
const fs = require("fs");

function parseArgs(argv) {
  const opts = { host: "127.0.0.1", port: 8791 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--host") opts.host = next();
    else if (a === "--port") opts.port = Number(next());
    else if (a === "--token-file") opts.tokenFile = next();
    else if (a === "--ca") opts.ca = next();
    else throw new Error(`未知参数: ${a}`);
  }
  return opts;
}

/** 完成正确 upgrade 后把 rawBytes 写进 WS 通道 */
function upgradeThenSend(opts, token, rawBytes) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = tls.connect({
      host: opts.host,
      port: opts.port,
      servername: undefined,
      ca: opts.ca ? fs.readFileSync(opts.ca) : undefined,
      rejectUnauthorized: true,
    });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(5000, () => done("timeout"));
    socket.on("error", (err) => reject(err));
    socket.on("data", (chunk) => {
      if (socket.upgraded) {
        // 服务端应回 close 帧或直接断开
        done(`closed-after-${chunk.length}b`);
        return;
      }
      const s = chunk.toString("latin1");
      if (s.includes("101 Switching Protocols")) {
        socket.upgraded = true;
        socket.write(rawBytes);
      } else if (s.includes("401") || s.includes("403")) {
        reject(new Error("upgrade 被拒绝"));
      }
    });
    socket.on("secureConnect", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${opts.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
          `Authorization: Bearer ${token}\r\n\r\n`,
      );
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = fs.readFileSync(opts.tokenFile, "utf8").trim();
  const cases = [
    ["未 mask 帧", Buffer.from([0x81, 0x02, 0x68, 0x69])], // 文本 "hi" 但无 mask
    ["非法 opcode 0x3", Buffer.from([0x83, 0x80, 1, 2, 3, 4])], // mask 位在但 opcode 保留
    ["随机垃圾 4KB", crypto.randomBytes(4096)],
    ["超长帧头声明 2GB", Buffer.from([0x81, 0xff, ...Buffer.alloc(8, 0xff), 1, 2, 3, 4])],
  ];
  let failed = 0;
  for (const [name, bytes] of cases) {
    const t0 = Date.now();
    try {
      const result = await upgradeThenSend(opts, token, bytes);
      const ms = Date.now() - t0;
      const ok = ms < 3000; // 若死循环会超时 5s 或挂死
      console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${result} (${ms}ms)`);
      if (!ok) failed += 1;
    } catch (err) {
      console.log(`FAIL ${name}: ${err.message}`);
      failed += 1;
    }
  }
  console.log(failed ? "\n存在失败" : "\n畸形输入全部正确断开");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
