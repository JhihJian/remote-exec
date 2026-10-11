#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { createSupervisor } = require("../../src/supervisor/supervisor.js");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
function control(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let data = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      data += chunk;
      const index = data.indexOf("\n");
      if (index < 0) return;
      socket.end();
      const response = JSON.parse(data.slice(0, index));
      if (!response.ok) reject(new Error(response.error)); else resolve(response.result);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ method, ...params })}\n`));
  });
}
function httpRequest(socket, pathName) {
  return new Promise((resolve, reject) => {
    let data = "";
    const onData = (chunk) => {
      data += chunk.toString();
      const match = data.match(/\r\n\r\n([\s\S]*)$/);
      if (!match) return;
      const length = Number(data.match(/content-length: (\d+)/i)?.[1] || 0);
      if (Buffer.byteLength(match[1]) < length) return;
      socket.off("data", onData);
      resolve(match[1].slice(0, length));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`GET ${pathName} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`);
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve();
    socket.once("close", resolve);
    socket.destroy();
  });
}

async function main() {
  const backends = [];
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
    backends.push(server);
    return { host: "127.0.0.1", port, backend: { host: "127.0.0.1", port, protocol: "http" }, setReady(value) { accepting = value; } };
  };

  const old = await makeBackend("old");
  const first = await makeBackend("v1");
  const second = await makeBackend("v2");
  const bad = await makeBackend("bad", false);
  const controlPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-")), "control.sock");
  const external = net.createServer();
  const externalPort = await listen(external);
  await new Promise((resolve) => external.close(resolve));
  const supervisor = createSupervisor({ port: externalPort, controlPath, oldBackend: old.backend });

  try {
    await supervisor.listen();
    assert.equal(fs.statSync(controlPath).mode & 0o777, 0o600);
    const oldClient = await connect(externalPort);
    assert.equal(await httpRequest(oldClient, "/before"), "old:/before");

    const initial = await control(controlPath, "register", { generation: "v1", backend: first.backend });
    assert.equal(initial.active, "old");
    assert.equal(initial.generations.find((item) => item.name === "v1").state, "candidate");
    await assert.rejects(() => control(controlPath, "register", { generation: "v1", backend: first.backend }), /已存在/);
    await control(controlPath, "promote", { generation: "v1" });
    assert.equal(await httpRequest(oldClient, "/after-v1"), "old:/after-v1");
    const v1Client = await connect(externalPort);
    assert.equal(await httpRequest(v1Client, "/v1"), "v1:/v1");

    await control(controlPath, "register", { generation: "v2", backend: second.backend });
    await control(controlPath, "promote", { generation: "v2" });
    assert.equal((await control(controlPath, "status")).active, "v2");
    assert.equal((await control(controlPath, "status")).generations.find((item) => item.name === "v1").state, "draining");
    assert.equal(await httpRequest(v1Client, "/still-v1"), "v1:/still-v1");

    const v2Client = await connect(externalPort);
    assert.equal(await httpRequest(v2Client, "/v2"), "v2:/v2");
    await control(controlPath, "register", { generation: "bad", backend: bad.backend });
    await assert.rejects(() => control(controlPath, "promote", { generation: "bad" }), /503/);
    assert.equal((await control(controlPath, "status")).active, "v2");

    const rolledBack = await control(controlPath, "rollback");
    assert.equal(rolledBack.active, "v1");
    const v1Fresh = await connect(externalPort);
    assert.equal(await httpRequest(v1Fresh, "/rollback"), "v1:/rollback");
    await assert.rejects(() => control(controlPath, "retire", { generation: "v1" }), /active/);
    await assert.rejects(() => control(controlPath, "retire", { generation: "v2" }), /活动连接/);
    v1Client.destroy();
    v1Fresh.destroy();
    await closeSocket(v2Client);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = (await control(controlPath, "status")).generations.find((item) => item.name === "v2");
      if (!current || current.connections === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    oldClient.destroy();
    await control(controlPath, "retire", { generation: "v2" });
    assert.equal((await control(controlPath, "status")).generations.some((item) => item.name === "v2"), false);
    console.log("supervisor：连续两轮升级、HTTP readiness 失败保护、回滚窗口、双端连接计数和 retire 条件验证通过");
  } finally {
    await supervisor.close();
    for (const server of backends) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.dirname(controlPath), { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
