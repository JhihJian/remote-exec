"use strict";

const fs = require("fs");
const tls = require("tls");
const crypto = require("crypto");
const { loadConfig } = require("./config.js");

function httpOp(hostName, op, localFile, remoteFile, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const config = loadConfig();
    const host = config.hosts[hostName];
    if (!host) throw new Error(`未知主机 "${hostName}"`);
    if (host.via && op === "upload") throw new Error(`"${hostName}" 经网关中转，暂不支持流式上传`);
    const gateway = host.via ? config.hosts[host.via] : null;
    if (host.via && (!gateway || gateway.via)) throw new Error(`"${hostName}" 的 via 链配置无效`);
    const route = gateway || host;
    const token = fs.readFileSync(route.tokenFile, "utf8").trim();
    const servername = /^\d+\.\d+\.\d+\.\d+$/.test(route.servername || route.host)
      ? undefined : (route.servername || route.host);
    const options = {
      host: route.host,
      port: route.port,
      servername,
      ca: host.ca ? fs.readFileSync(host.ca) : undefined,
      rejectUnauthorized: true,
    };
    let request;
    let source;
    let settled = false;
    const abort = () => finish(new Error("文件传输已取消"));
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      source?.destroy();
      request?.destroy();
      error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(result);
    };
    if (op === "upload") {
      const stat = fs.statSync(localFile);
      request = tls.connect(options, () => {
        request.write(`POST /upload?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${stat.size}\r\nConnection: close\r\n\r\n`);
        source = fs.createReadStream(localFile);
        source.once("error", finish);
        source.pipe(request, { end: false });
      });
    } else {
      request = tls.connect(options, () => {
        if (!gateway) {
          request.write(`GET /download?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
          return;
        }
        const body = JSON.stringify({
          target: { host: host.host, port: host.port, servername: host.servername || host.host },
          auth: { token: fs.readFileSync(host.tokenFile, "utf8").trim(), ca: fs.readFileSync(host.ca, "utf8") },
          file: remoteFile,
        });
        request.write(
          `POST /relay-download HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n` +
          `Authorization: Bearer ${token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
    }
    request.setTimeout(30000, () => finish(new Error("文件传输连接停滞超时")));
    let raw = Buffer.alloc(0);
    request.on("data", (chunk) => { raw = Buffer.concat([raw, chunk]); });
    request.on("end", () => {
      const i = raw.indexOf("\r\n\r\n");
      if (i < 0) return finish(new Error("响应不完整"));
      const statusLine = raw.subarray(0, i).toString().split("\r\n")[0];
      if (!/ 200 /.test(statusLine)) return finish(new Error(`HTTP 失败: ${statusLine}`));
      const body = raw.subarray(i + 4);
      try {
        if (op === "upload") finish(null, JSON.parse(body.toString()));
        else {
          fs.writeFileSync(localFile, body);
          finish(null, { size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") });
        }
      } catch (error) { finish(error); }
    });
    request.on("error", finish);
    request.once("close", () => { if (!settled) finish(new Error("文件传输连接提前关闭")); });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

module.exports = { httpOp };
