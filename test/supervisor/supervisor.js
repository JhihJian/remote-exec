#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
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
      if (!response.ok) reject(new Error(response.error));
      else resolve(response.result);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ method, ...params })}\n`));
  });
}

function response(socket) {
  return new Promise((resolve, reject) => {
    let data = "";
    const onData = (chunk) => {
      data += chunk.toString();
      const index = data.indexOf("\n");
      if (index >= 0) { socket.off("data", onData); resolve(data.slice(0, index)); }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function main() {
  const backends = [];
  const makeBackend = async (label) => {
    const server = net.createServer((socket) => socket.on("data", (data) => socket.write(`${label}:${data}`)));
    const port = await listen(server);
    backends.push(server);
    return { host: "127.0.0.1", port };
  };
  const oldBackend = await makeBackend("old");
  const newBackend = await makeBackend("new");
  const controlPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-")), "control.sock");
  const external = net.createServer();
  const externalPort = await listen(external);
  await new Promise((resolve) => external.close(resolve));
  const supervisor = createSupervisor({ port: externalPort, controlPath, oldBackend });

  try {
    await supervisor.listen();
    const oldClient = await connect(externalPort);
    oldClient.write("before\n");
    assert.equal(await response(oldClient), "old:before");

    await control(controlPath, "register", { generation: "new", backend: newBackend });
    const promoted = await control(controlPath, "promote", { generation: "new" });
    assert.equal(promoted.active, "new");
    assert.equal(promoted.generations.find((item) => item.name === "old").state, "draining");

    oldClient.write("after\n");
    assert.equal(await response(oldClient), "old:after");
    const newClient = await connect(externalPort);
    newClient.write("fresh\n");
    assert.equal(await response(newClient), "new:fresh");
    const status = await control(controlPath, "status");
    assert.equal(status.active, "new");
    const rolledBack = await control(controlPath, "rollback");
    assert.equal(rolledBack.active, "old");
    const drained = await control(controlPath, "drain", { generation: "new" });
    assert.equal(drained.generations.find((item) => item.name === "new").state, "draining");

    oldClient.destroy();
    newClient.destroy();
    console.log("TCP supervisor：generation 切换、旧连接保持、控制协议验证通过");
  } finally {
    await supervisor.close();
    for (const server of backends) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.dirname(controlPath), { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
