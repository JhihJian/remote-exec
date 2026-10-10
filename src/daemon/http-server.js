"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const { HTTP_IDLE_TIMEOUT_MS } = require("./constants.js");
const { handleDownload, handleUpload } = require("./files.js");
const { checkToken, log } = require("./security.js");
const { createRpcServer } = require("./rpc.js");

function createServer(opts, tokenSha256) {
  const wss = createRpcServer(opts.relayAllow);
  const requestHandler = (req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": 3 });
      res.end("ok\n");
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

  const server = opts.insecureHttp
    ? http.createServer(requestHandler)
    : https.createServer({ cert: fs.readFileSync(opts.cert), key: fs.readFileSync(opts.key) }, requestHandler);
  server.requestTimeout = 0;
  server.on("upgrade", onUpgrade);
  return server;
}

module.exports = { createServer };