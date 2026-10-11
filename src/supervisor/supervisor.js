"use strict";

const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function isLoopback(host) {
  if (net.isIPv4(host)) return host.split(".")[0] === "127";
  return net.isIPv6(host) && host.toLowerCase() === "::1";
}

function validateBackend(backend, label = "backend") {
  if (!backend || typeof backend.host !== "string" || !isLoopback(backend.host)) {
    throw new Error(`${label}.host 必须是回环 IP`);
  }
  if (!Number.isInteger(backend.port) || backend.port < 1 || backend.port > 65535) {
    throw new Error(`${label}.port 必须是 1-65535 的整数`);
  }
  const protocol = backend.protocol || (backend.https || backend.tls ? "https" : "http");
  if (protocol !== "http" && protocol !== "https") throw new Error(`${label}.protocol 必须是 http 或 https`);
  if (protocol === "https" && backend.ca !== undefined && typeof backend.ca !== "string") {
    throw new Error(`${label}.ca 必须是 PEM 字符串`);
  }
  return { host: backend.host, port: backend.port, protocol, ...(backend.ca ? { ca: backend.ca } : {}) };
}

function removeSocket(socketPath) {
  try { fs.unlinkSync(socketPath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function createSupervisor(options = {}) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("port 必须是 1-65535 的固定外部 TCP 端口");
  }
  if (typeof options.controlPath !== "string" || !options.controlPath) throw new Error("必须提供 controlPath Unix domain socket 路径");
  const generations = new Map();
  const initialOld = options.oldBackend ? validateBackend(options.oldBackend, "oldBackend") : null;
  if (initialOld) generations.set("old", { name: "old", state: "active", backend: initialOld, process: null, managed: false, connections: new Set(), previous: null });
  let active = initialOld ? "old" : null;
  let tcpServer;
  let controlServer;
  const controlConnections = new Set();
  let closing = false;
  let controlQueue = Promise.resolve();

  function requireName(name) {
    if (typeof name !== "string" || !name) throw new Error("generation 必须是非空名称");
    return name;
  }
  function get(name) {
    const generation = generations.get(requireName(name));
    if (!generation) throw new Error(`generation 不存在: ${name}`);
    return generation;
  }
  function newGeneration(name, backend) {
    requireName(name);
    if (generations.has(name)) throw new Error(`generation 已存在: ${name}`);
    const generation = { name, state: "candidate", backend: validateBackend(backend, `${name} backend`), process: null, managed: false, connections: new Set(), previous: null, startError: null };
    generations.set(name, generation);
    return generation;
  }
  function register(name, backend) { return newGeneration(name, backend); }
  function snapshot(generation) {
    return {
      name: generation.name,
      state: generation.state,
      backend: generation.backend,
      connections: generation.connections.size,
      process: generation.process ? { pid: generation.process.pid, exited: generation.process.exitCode !== null } : null,
      startError: generation.startError ? generation.startError.message : null,
    };
  }
  function status() { return { active, generations: [...generations.values()].map(snapshot) }; }

  function readiness(backend) {
    return new Promise((resolve, reject) => {
      const secure = backend.protocol === "https";
      const client = (secure ? https : http).request({
        host: backend.host,
        port: backend.port,
        path: "/readyz",
        method: "GET",
        timeout: options.readinessTimeout || 3000,
        ...(secure ? { rejectUnauthorized: true, ...(backend.ca ? { ca: backend.ca } : {}) } : {}),
      }, (response) => {
        response.resume();
        response.once("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve();
          else reject(new Error(`${backend.protocol} /readyz 返回 ${response.statusCode}`));
        });
      });
      client.once("timeout", () => client.destroy(new Error("/readyz 超时")));
      client.once("error", reject);
      client.end();
    });
  }

  async function promote(name) {
    const target = get(name);
    if (target.state !== "candidate" && target.state !== "draining") throw new Error(`${name} 不是可 promote 的候选版本`);
    if (!target.backend) throw new Error(`${name} 没有已注册后端`);
    if (target.startError || !target.process && target.managed) throw new Error(`${name} 启动失败，不能 promote`);
    if (target.process && target.process.exitCode !== null) throw new Error(`${name} 候选进程已退出，不能 promote`);
    await readiness(target.backend);
    if (target.startError || !target.process && target.managed || target.process && target.process.exitCode !== null) {
      throw new Error(`${name} 候选进程已退出，不能 promote`);
    }
    const previous = active ? generations.get(active) : null;
    if (previous && previous !== target) previous.state = "draining";
    target.previous = active;
    target.state = "active";
    active = target.name;
    return status();
  }

  function drain(name) {
    const target = get(name);
    if (target.name === active) throw new Error("不能 drain 当前 active generation，请先 promote 另一个 generation");
    target.state = "draining";
    return status();
  }

  function start(params = {}) {
    const name = requireName(params.generation || "new");
    if (generations.has(name)) throw new Error(`generation 已存在: ${name}`);
    if (!Array.isArray(params.command) || !params.command.length) {
      if (params.backend) return register(name, params.backend) && status();
      throw new Error("start 需要 command 数组，或提供 backend 注册已有后端");
    }
    const generation = newGeneration(name, params.backend);
    generation.managed = true;
    const child = spawn(params.command[0], params.command.slice(1), { cwd: params.cwd, env: { ...process.env, ...(params.env || {}) }, stdio: params.stdio || "ignore" });
    generation.process = child;
    child.once("exit", () => {
      if (generation.process !== child) return;
      generation.process = null;
      if (generation.state === "candidate") generation.startError = new Error("候选进程已退出");
      if (active === generation.name) { active = null; generation.state = "draining"; }
    });
    child.once("error", (error) => {
      if (generation.process === child) generation.process = null;
      generation.startError = error;
    });
    return status();
  }

  function proxy(client) {
    const generation = active && generations.get(active);
    if (!generation || generation.state !== "active" || !generation.backend) { client.destroy(new Error("当前没有可用的 active backend")); return; }
    const upstream = net.connect(generation.backend);
    const connection = { client, upstream, clientClosed: false, upstreamClosed: false };
    generation.connections.add(connection);
    const remove = (side) => {
      connection[`${side}Closed`] = true;
      if (connection.clientClosed && connection.upstreamClosed) generation.connections.delete(connection);
    };
    client.once("close", () => {
      remove("client");
      if (!upstream.destroyed) upstream.destroy();
    });
    upstream.once("close", () => {
      remove("upstream");
      if (!client.destroyed) client.destroy();
    });
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    upstream.once("connect", () => { client.pipe(upstream); upstream.pipe(client); });
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
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let request;
        try { request = JSON.parse(line); } catch (error) { socket.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); continue; }
        controlQueue = controlQueue.then(async () => {
          let result;
          switch (request.method) {
            case "status": result = status(); break;
            case "register": result = statusAfter(register(request.generation, request.backend)); break;
            case "start": result = start(request); break;
            case "promote": result = await promote(request.generation); break;
            case "drain": result = drain(request.generation); break;
            case "rollback": result = await rollback(); break;
            case "retire": result = await retire(request.generation); break;
            default: throw new Error(`未知控制方法: ${request.method}`);
          }
          if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: true, result })}\n`);
        }).catch((error) => { if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); });
      }
    });
  }
  function statusAfter() { return status(); }
  async function rollback() {
    if (!active) throw new Error("没有 active generation 可回滚");
    const target = generations.get(generations.get(active).previous);
    if (!target) throw new Error("没有上一版本可回滚");
    return promote(target.name);
  }
  function waitExit(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once("exit", resolve));
  }
  async function retire(name) {
    const target = get(name);
    if (target.name === active) throw new Error("不能 retire active generation");
    if (target.connections.size) throw new Error("不能 retire 有活动连接的 generation");
    if (target.process && target.process.exitCode === null) { target.process.kill("SIGTERM"); await waitExit(target.process); }
    generations.delete(target.name);
    return status();
  }

  async function listen() {
    if (tcpServer || controlServer) throw new Error("supervisor 已启动");
    removeSocket(options.controlPath);
    tcpServer = net.createServer(proxy); controlServer = net.createServer(handleControl);
    try {
      await Promise.all([
        new Promise((resolve, reject) => { tcpServer.once("error", reject); tcpServer.listen(options.port, options.host || "127.0.0.1", resolve); }),
        new Promise((resolve, reject) => { controlServer.once("error", reject); controlServer.listen(options.controlPath, () => { fs.chmodSync(options.controlPath, 0o600); resolve(); }); }),
      ]);
    } catch (error) { tcpServer.close(); controlServer.close(); removeSocket(options.controlPath); tcpServer = null; controlServer = null; throw error; }
    return status();
  }
  async function close() {
    if (closing) return; closing = true;
    for (const generation of generations.values()) {
      for (const connection of generation.connections) { connection.client.destroy(); connection.upstream.destroy(); }
      if (generation.process && generation.process.exitCode === null) generation.process.kill("SIGTERM");
    }
    for (const socket of controlConnections) socket.destroy();
    await Promise.all([tcpServer ? new Promise((resolve) => tcpServer.close(resolve)) : Promise.resolve(), controlServer ? new Promise((resolve) => controlServer.close(resolve)) : Promise.resolve()]);
    removeSocket(options.controlPath); tcpServer = null; controlServer = null;
  }
  return { listen, close, status, register, start, promote, drain, rollback, retire };
}

module.exports = { createSupervisor, validateBackend };
