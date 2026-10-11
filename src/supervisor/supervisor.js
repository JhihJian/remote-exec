"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GENERATIONS = ["old", "new"];
const STATES = ["inactive", "active", "draining"];

function validateBackend(backend, label = "backend") {
  if (!backend || typeof backend.host !== "string" || !backend.host) {
    throw new Error(`${label}.host 必须是非空字符串`);
  }
  if (!Number.isInteger(backend.port) || backend.port < 1 || backend.port > 65535) {
    throw new Error(`${label}.port 必须是 1-65535 的整数`);
  }
  return { host: backend.host, port: backend.port };
}

function removeSocket(socketPath) {
  try { fs.unlinkSync(socketPath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function createSupervisor(options = {}) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("port 必须是 1-65535 的固定外部 TCP 端口");
  }
  if (typeof options.controlPath !== "string" || !options.controlPath) {
    throw new Error("必须提供 controlPath Unix domain socket 路径");
  }

  const generations = new Map(GENERATIONS.map((name) => [name, {
    name,
    state: "inactive",
    backend: null,
    process: null,
    connections: new Set(),
  }]));
  const initialOld = options.oldBackend ? validateBackend(options.oldBackend, "oldBackend") : null;
  const old = generations.get("old");
  if (initialOld) { old.backend = initialOld; old.state = "active"; }
  let active = initialOld ? "old" : null;
  let tcpServer;
  let controlServer;
  const controlConnections = new Set();
  let closing = false;

  function getGeneration(name) {
    if (!GENERATIONS.includes(name)) throw new Error(`generation 必须是 old 或 new: ${name}`);
    return generations.get(name);
  }

  function register(name, backend) {
    const generation = getGeneration(name);
    generation.backend = validateBackend(backend, `${name} backend`);
    if (!active) {
      active = name;
      generation.state = "active";
    } else if (name !== active && generation.state === "inactive") {
      generation.state = "draining";
    }
    return generation;
  }

  function snapshot(generation) {
    return {
      name: generation.name,
      state: generation.state,
      backend: generation.backend,
      connections: generation.connections.size,
      process: generation.process ? {
        pid: generation.process.pid,
        exited: generation.process.exitCode !== null,
      } : null,
    };
  }

  function status() {
    return { active, generations: GENERATIONS.map((name) => snapshot(generations.get(name))) };
  }

  function promote(name) {
    const target = getGeneration(name);
    if (!target.backend) throw new Error(`${name} 没有已注册后端`);
    if (target.state === "draining") target.state = "active";
    if (active && active !== name) {
      const previous = generations.get(active);
      if (previous.state === "active") previous.state = "draining";
    }
    active = name;
    target.state = "active";
    return status();
  }

  function drain(name) {
    const target = getGeneration(name);
    if (target.name === active) throw new Error("不能 drain 当前 active generation，请先 promote 另一个 generation");
    if (!target.backend) throw new Error(`${name} 没有已注册后端`);
    target.state = "draining";
    return status();
  }

  function rollback() {
    const target = active === "old" ? generations.get("new") : generations.get("old");
    return promote(target.name);
  }

  function start(params = {}) {
    const name = params.generation || "new";
    const generation = getGeneration(name);
    if (!Array.isArray(params.command) || !params.command.length) {
      if (params.backend) return register(name, params.backend) && status();
      throw new Error("start 需要 command 数组，或提供 backend 注册已有后端");
    }
    const backend = validateBackend(params.backend, `${name} backend`);
    if (generation.process && generation.process.exitCode === null) {
      throw new Error(`${name} 已有运行中的候选进程`);
    }
    const child = spawn(params.command[0], params.command.slice(1), {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env || {}) },
      stdio: params.stdio || "ignore",
    });
    generation.process = child;
    generation.backend = backend;
    generation.state = active === name ? "active" : "draining";
    child.once("exit", () => {
      if (generation.process === child) generation.process = null;
    });
    child.once("error", () => {
      if (generation.process === child) generation.process = null;
    });
    return status();
  }

  function proxy(client) {
    const name = active;
    const generation = name && generations.get(name);
    if (!generation || !generation.backend || generation.state !== "active") {
      client.destroy(new Error("当前没有可用的 active backend"));
      return;
    }
    const upstream = net.connect(generation.backend);
    generation.connections.add(client);
    generation.connections.add(upstream);
    const remove = () => {
      generation.connections.delete(client);
      generation.connections.delete(upstream);
    };
    client.once("close", remove);
    upstream.once("close", remove);
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    upstream.once("connect", () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }

  function handleControl(socket) {
    controlConnections.add(socket);
    socket.once("close", () => controlConnections.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
          let result;
          switch (request.method) {
            case "status": result = status(); break;
            case "register": result = statusAfter(register(request.generation, request.backend)); break;
            case "start": result = start(request); break;
            case "promote": result = promote(request.generation); break;
            case "drain": result = drain(request.generation); break;
            case "rollback": result = rollback(); break;
            default: throw new Error(`未知控制方法: ${request.method}`);
          }
          socket.write(`${JSON.stringify({ ok: true, result })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
        }
      }
    });
  }

  function statusAfter() { return status(); }

  async function listen() {
    if (tcpServer || controlServer) throw new Error("supervisor 已启动");
    removeSocket(options.controlPath);
    tcpServer = net.createServer(proxy);
    controlServer = net.createServer(handleControl);
    await Promise.all([
      new Promise((resolve, reject) => { tcpServer.once("error", reject); tcpServer.listen(options.port, options.host || "127.0.0.1", resolve); }),
      new Promise((resolve, reject) => { controlServer.once("error", reject); controlServer.listen(options.controlPath, resolve); }),
    ]);
    return status();
  }

  async function close() {
    if (closing) return;
    closing = true;
    for (const generation of generations.values()) {
      for (const connection of generation.connections) connection.destroy();
      if (generation.process && generation.process.exitCode === null) generation.process.kill("SIGTERM");
    }
    for (const socket of controlConnections) socket.destroy();
    await Promise.all([
      tcpServer ? new Promise((resolve) => tcpServer.close(() => resolve())) : Promise.resolve(),
      controlServer ? new Promise((resolve) => controlServer.close(() => resolve())) : Promise.resolve(),
    ]);
    removeSocket(options.controlPath);
    tcpServer = null;
    controlServer = null;
  }

  return { listen, close, status, register, start, promote, drain, rollback };
}

module.exports = { createSupervisor, validateBackend };
