#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-exec-relay-download-"));
const children = [];

function credentials(name) {
  const cert = path.join(dir, `${name}.crt`);
  const key = path.join(dir, `${name}.key`);
  const tokenSha = path.join(dir, `${name}.sha256`);
  const token = `${name}-${crypto.randomBytes(18).toString("hex")}`;
  fs.writeFileSync(tokenSha, crypto.createHash("sha256").update(token).digest("hex"), { mode: 0o600 });
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { cert, key, tokenSha, token };
}

function startDaemon(auth, relayAllow) {
  const args = [
    path.join(root, "src/daemon/main.js"), "--host", "127.0.0.1", "--port", "0",
    "--cert", auth.cert, "--key", auth.key, "--token-sha256-file", auth.tokenSha,
  ];
  if (relayAllow) args.push("--relay-allow", relayAllow);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/127\.0\.0\.1:(\d+)/);
      if (match) {
        child.stderr.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => reject(new Error(`daemon 未启动（${code}/${signal}）\n${output}`)));
  });
}

function request(port, ca, token, body) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1", port, method: "POST", path: "/relay-download", ca,
      rejectUnauthorized: true,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function main() {
  const target = credentials("target");
  const gateway = credentials("gateway");
  const remote = path.join(dir, "bench_blueops.py");
  const content = Buffer.from("print(\"relay-download\")\n");
  fs.writeFileSync(remote, content);
  const targetPort = await startDaemon(target);
  const gatewayPort = await startDaemon(gateway, "127.0.0.0/8");
  const body = JSON.stringify({
    target: { host: "127.0.0.1", port: targetPort, servername: "localhost" },
    auth: { token: target.token, ca: fs.readFileSync(target.cert, "utf8") },
    file: remote,
  });

  const success = await request(gatewayPort, fs.readFileSync(gateway.cert), gateway.token, body);
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, content);

  const unauthorized = await request(gatewayPort, fs.readFileSync(gateway.cert), "", body);
  assert.equal(unauthorized.status, 401);
  console.log("relay-download 网关流式下载、目标 TLS 和认证回归通过");
}

main()
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  });