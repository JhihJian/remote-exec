#!/usr/bin/env node
"use strict";

const { DEFAULT_RELAY_ALLOW } = require("./constants.js");
const { createServer } = require("./http-server.js");
const { loadTokenSha256, log } = require("./security.js");

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
    else if (a === "--relay-allow") (opts.relayAllow = opts.relayAllow || []).push(next());
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(`用法: node src/daemon/main.js --port 8791 --cert <crt> --key <key> --token-sha256-file <file>
      node src/daemon/main.js --host 127.0.0.1 --insecure-http --token-sha256-file <file>
      可选 --relay-allow <cidr>（可重复，默认仅允许回环 + RFC1918 私网，禁止转发公网）

依赖: npm install ws （打包部署时随 node_modules/ws 一起传输）`);
}

function validateOptions(opts) {
  if (!opts.tokenSha256File) throw new Error("必须提供 --token-sha256-file");
  if (opts.insecureHttp) {
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(opts.host);
    if (!loopback) throw new Error("明文模式（--insecure-http）只允许监听回环地址");
  } else if (!opts.cert || !opts.key) {
    throw new Error("TLS 模式必须提供 --cert 与 --key");
  }
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    usage();
    return;
  }
  validateOptions(opts);
  const tokenSha256 = loadTokenSha256(opts.tokenSha256File);
  const relayAllow = opts.relayAllow || DEFAULT_RELAY_ALLOW;
  const server = createServer({ ...opts, relayAllow }, tokenSha256);
  server.listen(opts.port, opts.host, () => {
    const scheme = opts.insecureHttp ? "ws" : "wss";
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : opts.port;
    log("listening", `${scheme}://${opts.host}:${port} (token 认证已启用, ws 库处理帧协议)`);
  });
  return server;
}

if (require.main === module) main();

module.exports = { main, parseArgs, validateOptions };