"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const { HTTP_IDLE_TIMEOUT_MS } = require("../shared/constants.js");
const { handleDownload, handleUpload } = require("./file-transfer.js");
const { checkToken } = require("../shared/auth.js");
const { log } = require("../shared/log.js");
const { createRpcServer } = require("./rpc-server.js");

function createServer(opts, tokenSha256) {
  const lifecycle = opts.lifecycle;
  const requestHandler = (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": 3 });
      res.end("ok\n");
      return;
    }
    if (req.url === "/readyz") {
      const ready = !lifecycle || lifecycle.accepting();
      res.writeHead(ready ? 200 : 503, { "Content-Type": "text/plain", "Content-Length": ready ? 3 : 10 });
      res.end(ready ? "ok\n" : "draining\n");
      return;
    }
    const isUpload = req.method === "POST" && req.url.startsWith("/upload");
    const isDownload = req.method === "GET" && req.url.startsWith("/download");
    if (isUpload || isDownload) {
      if (!checkToken(tokenSha256, req.headers)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized\n");
        log(isUpload ? "upload" : "download", "rejected-auth");
        return;
      }
      const release = lifecycle?.acquire("http");
      if (lifecycle && !release) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("draining\n");
        return;
      }
      let released = false;
      const finish = () => {
        if (released) return;
        released = true;
        release?.();
      };
      res.once("finish", finish);
      res.once("close", finish);
      req.once("aborted", finish);
      req.setTimeout(HTTP_IDLE_TIMEOUT_MS);
      if (isUpload) handleUpload(req, res);
      else handleDownload(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  };

  const onUpgrade = (req, socket, head) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    if (lifecycle && !lifecycle.accepting()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      log("upgrade.rejected-draining", peer);
      return;
    }
    if (req.headers.origin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      log("upgrade.rejected-origin", peer);
      return;
    }
    if (!checkToken(tokenSha256, req.headers)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      log("upgrade.rejected-auth", peer);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };

  const wss = createRpcServer(opts.relayAllow, lifecycle);
  const server = opts.insecureHttp
    ? http.createServer(requestHandler)
    : https.createServer({ cert: fs.readFileSync(opts.cert), key: fs.readFileSync(opts.key) }, requestHandler);
  server.requestTimeout = 0;
  server.on("upgrade", onUpgrade);
  server.lifecycle = lifecycle;
  server.wss = wss;
  return server;
}

module.exports = { createServer };