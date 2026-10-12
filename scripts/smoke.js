#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const https = require("node:https");
const WebSocket = require("ws");

async function smoke({ port, ca, tokenFile, expectedUser }) {
  const certificate = fs.readFileSync(ca);
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  await new Promise((resolve, reject) => {
    const request = https.get({ host: "127.0.0.1", port, path: "/readyz", ca: certificate, timeout: 5000 }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 200 ? resolve() : reject(new Error(`/readyz 返回 ${response.statusCode}`)));
    });
    request.once("timeout", () => request.destroy(new Error("健康检查超时")));
    request.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, {
      ca: certificate,
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 5000,
    });
    const finish = (error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.terminate();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("WSS 命令验收超时")), 10000);
    socket.once("error", finish);
    socket.once("close", () => finish(new Error("WSS 验收期间连接关闭")));
    socket.once("open", () => socket.send(JSON.stringify({
      id: 1, method: "exec", params: { command: "printf '\\nremote-exec-install-ok\\n'; id -un", timeoutMs: 5000 },
    })));
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.id !== 1) return;
        if (message.error) throw new Error(`RPC 验收失败: ${message.error.message}`);
        const output = Buffer.from(message.result.stdoutB64, "base64").toString("utf8");
        if (message.result.exitCode !== 0 || !output.includes("\nremote-exec-install-ok\n")) throw new Error("命令未正常完成");
        if (expectedUser && output.trim().split("\n").at(-1) !== expectedUser) throw new Error("服务执行用户不符合配置");
        finish();
      } catch (error) { finish(error); }
    });
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  const names = { "--port": "port", "--ca": "ca", "--token-file": "tokenFile", "--expected-user": "expectedUser" };
  try {
    for (let i = 0; i < args.length; i += 2) {
      const name = names[args[i]];
      if (!name || !args[i + 1]) throw new Error(`无效参数: ${args[i]}`);
      options[name] = args[i + 1];
    }
    if (!options.port || !options.ca || !options.tokenFile) throw new Error("需要 --port、--ca 和 --token-file");
    smoke(options).then(() => console.log("TLS、token、WSS 与执行用户验收通过"), (error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { smoke };
