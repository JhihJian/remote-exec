"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const BINARY = process.env.RUST_SUPERVISOR_BINARY || path.join(ROOT, "prototype/rust-daemon/target/x86_64-unknown-linux-musl/release/remote-exec-rust-prototype");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const closeServer = (server) => new Promise((resolve) => {
  if (!server.listening) return resolve();
  server.close(() => resolve());
});
const closeSocket = (socket) => new Promise((resolve) => {
  if (socket.destroyed) return resolve();
  socket.once("close", resolve);
  socket.destroy();
});

function control(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.once("error", finish);
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        finish(response.ok ? null : new Error(response.error), response.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify({ method, ...params })}\n`));
  });
}

function request(socket, pathName) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headers = buffer.slice(0, headerEnd);
      const length = Number(headers.match(/content-length: (\d+)/i)?.[1] || 0);
      const body = buffer.slice(headerEnd + 4);
      if (Buffer.byteLength(body) < length) return;
      socket.off("data", onData);
      resolve(body.slice(0, length));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`GET ${pathName} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`);
  });
}

async function main() {
  assert.ok(fs.existsSync(BINARY), `请先构建 Rust binary: ${BINARY}`);
  const sockets = new Set();
  const servers = [];
  let supervisor;
  let tempDir;
  try {
    const makeBackend = async (label, ready = true) => {
      let accepting = ready;
      const server = http.createServer((request, response) => {
        if (request.url === "/readyz") {
          response.writeHead(accepting ? 200 : 503, { "content-length": 0 });
          response.end();
          return;
        }
        const body = `${label}:${request.url}`;
        response.writeHead(200, { "content-length": Buffer.byteLength(body), connection: "keep-alive" });
        response.end(body);
      });
      const port = await listen(server);
      servers.push(server);
      return { backend: { host: "127.0.0.1", port, protocol: "http" }, setReady: (value) => { accepting = value; } };
    };

    const old = await makeBackend("old");
    const next = await makeBackend("next");
    const bad = await makeBackend("bad", false);
    const probe = net.createServer();
    const supervisorPort = await listen(probe);
    await closeServer(probe);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rust-supervisor-test-"));
    const controlPath = path.join(tempDir, "control.sock");
    supervisor = spawn(BINARY, ["--supervisor", "--port", String(supervisorPort), "--control", controlPath,
      "--old-host", old.backend.host, "--old-port", String(old.backend.port)], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    supervisor.stderr.on("data", (chunk) => { log += chunk.toString(); });
    for (let i = 0; i < 100 && !log.includes("Rust supervisor listening"); i += 1) await wait(20);
    assert.match(log, /Rust supervisor listening/);
    assert.equal(fs.statSync(controlPath).mode & 0o777, 0o600);

    assert.equal((await control(controlPath, "status")).active, "old");
    await control(controlPath, "register", { generation: "bad", backend: bad.backend });
    await assert.rejects(control(controlPath, "promote", { generation: "bad" }), /返回 503/);
    assert.equal((await control(controlPath, "status")).active, "old");

    const oldClient = net.connect(supervisorPort, "127.0.0.1");
    sockets.add(oldClient);
    await new Promise((resolve, reject) => { oldClient.once("connect", resolve); oldClient.once("error", reject); });
    assert.equal(await request(oldClient, "/before"), "old:/before");

    await control(controlPath, "register", { generation: "next", backend: next.backend });
    await control(controlPath, "promote", { generation: "next" });
    assert.equal(await request(oldClient, "/after"), "old:/after");

    const nextClient = net.connect(supervisorPort, "127.0.0.1");
    sockets.add(nextClient);
    await new Promise((resolve, reject) => { nextClient.once("connect", resolve); nextClient.once("error", reject); });
    assert.equal(await request(nextClient, "/fresh"), "next:/fresh");
    await assert.rejects(control(controlPath, "retire", { generation: "next" }), /active/);

    await control(controlPath, "rollback");
    const rollbackClient = net.connect(supervisorPort, "127.0.0.1");
    sockets.add(rollbackClient);
    await new Promise((resolve, reject) => { rollbackClient.once("connect", resolve); rollbackClient.once("error", reject); });
    assert.equal(await request(rollbackClient, "/rollback"), "old:/rollback");
    await assert.rejects(control(controlPath, "retire", { generation: "next" }), /活动连接/);
    await closeSocket(nextClient);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const generation = (await control(controlPath, "status")).generations.find((item) => item.name === "next");
      if (!generation || generation.connections === 0) break;
      await wait(25);
    }
    await control(controlPath, "retire", { generation: "next" });
    assert.equal((await control(controlPath, "status")).generations.some((item) => item.name === "next"), false);
    console.log("PASS Rust supervisor readiness、切换、旧连接、回滚和 retire");
  } finally {
    for (const socket of sockets) await closeSocket(socket);
    if (supervisor && supervisor.exitCode === null) {
      supervisor.kill("SIGTERM");
      await new Promise((resolve) => supervisor.once("exit", resolve));
    }
    for (const server of servers) await closeServer(server);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
