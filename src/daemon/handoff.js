"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const HANDOFF_TIMEOUT_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} 必须是绝对路径`);
  }
  return value;
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("handoff 配置必须是对象");
  for (const key of ["supervisor", "ctl", "package", "versionsDir", "control", "state", "backendCa"]) {
    requireAbsolute(config[key], `handoff.${key}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(config.sha256 || "")) {
    throw new Error("handoff.sha256 必须是 64 位十六进制摘要");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("handoff.port 无效");
  }
  if (config.runUser !== undefined && (typeof config.runUser !== "string" || !/^[A-Za-z0-9_.-]+$/.test(config.runUser))) {
    throw new Error("handoff.runUser 无效");
  }
  if (!Array.isArray(config.command) || config.command.length === 0 || config.command.some((value) => typeof value !== "string")) {
    throw new Error("handoff.command 必须是非空字符串数组");
  }
  if (config.command.some((value) => value === "--port" || value.startsWith("--port="))) {
    throw new Error("handoff.command 不得包含 --port");
  }
}

function runChild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: options.stdio || ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, child }));
  });
}

async function waitForControl(child, controlPath) {
  const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`supervisor 提前退出: ${child.exitCode}`);
    }
    try {
      await fs.promises.access(controlPath, fs.constants.F_OK);
      return;
    } catch {}
    await sleep(50);
  }
  throw new Error("supervisor 控制面未在期限内就绪");
}

async function handoff(server, config, log) {
  validateConfig(config);
  const fd = server?._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) {
    throw new Error("无法取得 Node HTTPS listener FD");
  }
  await fs.promises.rm(config.control, { force: true });
  const args = [
    "supervisor",
    "--host", config.host || "0.0.0.0",
    "--port", String(config.port),
    "--control", config.control,
    "--state", config.state,
    "--listener-fd", "3",
  ];
  if (config.runUser) args.push("--run-user", config.runUser);
  const supervisor = spawn(config.supervisor, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", fd],
  });
  supervisor.unref();
  try {
    await waitForControl(supervisor, config.control);
    const ctlArgs = [
      "ctl", "--control", config.control, "upgrade",
      "--package", config.package,
      "--sha256", config.sha256,
      "--versions-dir", config.versionsDir,
      "--backend-protocol", "https",
      "--backend-ca", config.backendCa,
      "--",
      ...config.command,
    ];
    const result = await runChild(config.ctl, ctlArgs);
    if (result.code !== 0) {
      throw new Error(`候选 Rust 启动失败（退出码 ${result.code}）: ${result.stderr.trim()}`);
    }
    // promote 已完成后停止 Node 接受新连接；已有 TCP/WSS 连接继续由 Node 服务。
    server.close();
    log("handoff.ready", "Rust supervisor 已接管新连接，Node 保留已有连接");
  } catch (error) {
    supervisor.kill("SIGTERM");
    throw error;
  }
}

module.exports = { handoff };
