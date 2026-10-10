#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "../..");
const integrationDir = path.join(root, "test", "integration");
const fuzzDir = path.join(root, "test", "fuzz");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-exec-test-"));
  const cert = path.join(dir, "server.crt");
  const key = path.join(dir, "server.key");
  const tokenFile = path.join(dir, "token.txt");
  const tokenSha = path.join(dir, "token.sha256");
  let server;

  try {
    createCredentials({ cert, key, tokenFile, tokenSha });
    server = spawn(process.execPath, [
      path.join(root, "server.js"),
      "--host", "127.0.0.1",
      "--port", "0",
      "--cert", cert,
      "--key", key,
      "--token-sha256-file", tokenSha,
    ], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });

    const port = await waitForListening(server);
    const common = [
      "--host", "127.0.0.1",
      "--port", String(port),
      "--token-file", tokenFile,
      "--ca", cert,
    ];

    runNode(path.join(integrationDir, "client.js"), common);
    runNode(path.join(fuzzDir, "client.js"), common);
    console.log("\n端到端回归与 fuzz 全部通过");
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await waitForExit(server);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createCredentials(files) {
  const token = crypto.randomBytes(24).toString("base64");
  fs.writeFileSync(files.tokenFile, token, { mode: 0o600 });
  fs.writeFileSync(files.tokenSha, crypto.createHash("sha256").update(token).digest("hex"), { mode: 0o600 });
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", files.key, "-out", files.cert, "-days", "2",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
}

function waitForListening(child) {
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
    child.once("exit", (code, signal) => {
      reject(new Error(`测试 daemon 未启动（code=${code}, signal=${signal}）\n${output}`));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} 失败，退出码 ${result.status}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});