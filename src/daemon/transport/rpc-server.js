"use strict";

const { WebSocketServer } = require("ws");
const { MAX_PAYLOAD } = require("../shared/constants.js");
const { execCommand, execStreamCommand } = require("../operations/exec.js");
const { fileRead, fileWrite } = require("../operations/files.js");
const { createRelayHandler } = require("../operations/relay.js");
const { log } = require("../shared/log.js");
const { rpcError } = require("../shared/rpc-error.js");

function createRpcServer(relayAllow, lifecycle) {
  const relayRequest = createRelayHandler(relayAllow);
  const methods = {
    exec: execCommand,
    "exec.stream": execStreamCommand,
    "file.read": fileRead,
    "file.write": fileWrite,
    relay: relayRequest,
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  wss.on("connection", (ws, req) => {
    const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    log("ws.opened", peer);
    let queue = Promise.resolve();
    const inflight = new Set();
    const releaseConnection = lifecycle?.acquire("websocket");
    if (lifecycle && !releaseConnection) {
      ws.close(1013, "draining");
      return;
    }
    const removeForceCloser = lifecycle?.addForceCloser(() => ws.destroy());
    const sendJson = (msg) => new Promise((resolve, reject) => {
      if (ws.readyState !== ws.OPEN) {
        reject(new Error("连接已关闭"));
        return;
      }
      ws.send(JSON.stringify(msg), (err) => (err ? reject(err) : resolve()));
    });

    ws.on("message", (data) => {
      let request;
      try { request = JSON.parse(data.toString("utf8")); }
      catch {
        sendJson({ id: null, error: { code: -32700, message: "JSON 解析失败" } }).catch(() => {});
        return;
      }
      queue = queue
        .then(async () => {
          if (lifecycle && !lifecycle.accepting()) {
            throw rpcError(-32020, "daemon 正在排空，不再接受新的 RPC");
          }
          const releaseRequest = lifecycle?.acquire("rpc");
          if (lifecycle && !releaseRequest) throw rpcError(-32020, "daemon 正在排空，不再接受新的 RPC");
          try {
          if (!request || typeof request.method !== "string") throw rpcError(-32600, "请求需要 method 字段");
          const handler = methods[request.method];
          if (!handler) throw rpcError(-32601, `未知方法: ${request.method}`);
          const id = request.id ?? null;
          const result = await handler(
            request.params || {},
            { emitEvent: (event) => sendJson({ id, ...event }) },
            (cancel) => {
              inflight.add(cancel);
              return () => inflight.delete(cancel);
            },
          );
          return { id: request.id ?? null, result };
          } finally {
            releaseRequest?.();
          }
        })
        .catch((err) => ({
          id: request.id ?? null,
          error: { code: err.rpcCode ?? -32000, message: err.message, data: err.data },
        }))
        .then((message) => sendJson(message).catch(() => {}));
    });

    ws.on("error", (err) => log("ws.error", `${peer} ${err.message}`));
    ws.on("close", () => {
      releaseConnection?.();
      removeForceCloser?.();
      log("ws.closed", peer);
      if (inflight.size) {
        log("ws.cancel", `${peer} 终止 ${inflight.size} 个执行中的操作`);
        [...inflight].forEach((cancel) => cancel());
      }
    });
  });

  return wss;
}

module.exports = { createRpcServer };