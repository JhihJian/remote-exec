"use strict";

const path = require("path");
const { spawn } = require("child_process");
const {
  DEFAULT_OUTPUT_CAP,
  DEFAULT_TIMEOUT_MS,
  EXEC_TIMEOUT_EXIT_CODE,
  STREAM_CHUNK_BYTES,
  STREAM_SEND_STALL_MS,
} = require("../shared/constants.js");
const { rpcError } = require("../shared/rpc-error.js");

const b64 = (buf) => buf.toString("base64");

function terminateProcessGroup(child) {
  const signal = (name) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (err) {
      if (err.code !== "ESRCH") {
        try { child.kill(name); } catch { /* 进程已退出 */ }
      }
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 2000).unref();
}

function spawnShell(command, cwd) {
  return spawn("bash", ["-lc", command], {
    cwd: cwd || undefined,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function validateCommandParams(params) {
  const { command, cwd } = params;
  if (typeof command !== "string" || !command.trim()) {
    throw rpcError(-32602, "params.command 必须是非空字符串");
  }
  if (cwd !== undefined && !path.isAbsolute(cwd)) {
    throw rpcError(-32602, "params.cwd 必须是绝对路径");
  }
}

function execCommand(params, _ctx, onCancel) {
  validateCommandParams(params);
  const { command, cwd, timeoutMs, outputBytesCap } = params;
  const cap = Math.max(1, Number(outputBytesCap) || DEFAULT_OUTPUT_CAP);
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);

  return new Promise((resolve) => {
    const child = spawnShell(command, cwd);
    const chunks = { out: [], err: [] };
    const collected = { out: 0, err: 0 };
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    const killChild = () => terminateProcessGroup(child);
    const collect = (which) => (data) => {
      if (collected[which] >= cap) {
        truncated = true;
        return;
      }
      const room = cap - collected[which];
      const piece = data.length > room ? data.subarray(0, room) : data;
      if (piece.length < data.length) truncated = true;
      chunks[which].push(piece);
      collected[which] += piece.length;
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeout);
    const unregisterCancel = onCancel ? onCancel(() => { cancelled = true; killChild(); }) : () => {};
    let done = false;
    let drainTimer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      unregisterCancel();
      resolve(result);
    };
    child.on("error", (err) => finish({
      exitCode: -1,
      stdoutB64: b64(Buffer.concat(chunks.out)),
      stderrB64: b64(Buffer.concat([...chunks.err, Buffer.from(String(err))])),
      truncated,
    }));
    child.on("close", (code) => finish({
      exitCode: cancelled ? 130 : timedOut ? EXEC_TIMEOUT_EXIT_CODE : (code ?? -1),
      stdoutB64: b64(Buffer.concat(chunks.out)),
      stderrB64: b64(Buffer.concat(chunks.err)),
      truncated,
    }));
    child.on("exit", (code) => {
      drainTimer = setTimeout(() => finish({
        exitCode: cancelled ? 130 : timedOut ? EXEC_TIMEOUT_EXIT_CODE : (code ?? -1),
        stdoutB64: b64(Buffer.concat(chunks.out)),
        stderrB64: b64(Buffer.concat(chunks.err)),
        truncated,
      }), 500);
    });
  });
}

function execStreamCommand(params, ctx, onCancel) {
  validateCommandParams(params);
  const { command, cwd, timeoutMs } = params;
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);

  return new Promise((resolve) => {
    const child = spawnShell(command, cwd);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let transportFailed = false;
    let done = false;
    let drainTimer = null;
    let paused = false;
    let sendChain = Promise.resolve();
    const killChild = () => terminateProcessGroup(child);
    const unregisterCancel = onCancel ? onCancel(() => { cancelled = true; killChild(); }) : () => {};
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeout);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      unregisterCancel();
      resolve({
        exitCode: cancelled || transportFailed ? 130 : timedOut ? EXEC_TIMEOUT_EXIT_CODE : (code ?? -1),
        reason: cancelled || transportFailed ? "cancelled" : timedOut ? "timeout" : "exited",
        stdoutBytes,
        stderrBytes,
      });
    };
    const emitWithStallLimit = (event) => new Promise((resolveSend, rejectSend) => {
      const timerId = setTimeout(() => rejectSend(new Error("流式输出发送停滞")), STREAM_SEND_STALL_MS);
      ctx.emitEvent(event).then(
        () => { clearTimeout(timerId); resolveSend(); },
        (err) => { clearTimeout(timerId); rejectSend(err); },
      );
    });
    const enqueueOutput = (stream, data) => {
      if (done || transportFailed) return;
      if (stream === "stdout") stdoutBytes += data.length;
      else stderrBytes += data.length;
      if (!paused) {
        paused = true;
        child.stdout.pause();
        child.stderr.pause();
      }
      sendChain = sendChain
        .then(async () => {
          if (transportFailed || done) return;
          for (let offset = 0; offset < data.length; offset += STREAM_CHUNK_BYTES) {
            await emitWithStallLimit({
              event: "output",
              stream,
              dataB64: b64(data.subarray(offset, offset + STREAM_CHUNK_BYTES)),
            });
          }
        })
        .catch(() => {
          transportFailed = true;
          cancelled = true;
          killChild();
        });
      const thisChain = sendChain;
      thisChain.then(() => {
        if (thisChain === sendChain && paused && !done && !transportFailed) {
          paused = false;
          child.stdout.resume();
          child.stderr.resume();
        }
      });
    };
    child.stdout.on("data", (data) => enqueueOutput("stdout", data));
    child.stderr.on("data", (data) => enqueueOutput("stderr", data));
    child.on("error", () => sendChain.then(() => finish(-1)));
    child.on("close", (code) => sendChain.then(() => finish(code)));
    child.on("exit", (code) => {
      drainTimer = setTimeout(() => sendChain.then(() => finish(code)), 500);
    });
  });
}

module.exports = { execCommand, execStreamCommand };