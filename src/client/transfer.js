"use strict";

const fs = require("fs");
const tls = require("tls");
const crypto = require("crypto");
const { loadConfig } = require("./config.js");

function httpOp(hostName, op, localFile, remoteFile) {
  return new Promise((resolve, reject) => {
    const config = loadConfig();
    const host = config.hosts[hostName];
    if (!host) throw new Error(`未知主机 "${hostName}"`);
    if (host.via) throw new Error(`"${hostName}" 经网关中转，暂不支持流式传输`);
    const token = fs.readFileSync(host.tokenFile, "utf8").trim();
    const servername = /^\d+\.\d+\.\d+\.\d+$/.test(host.servername || host.host)
      ? undefined : (host.servername || host.host);
    const options = {
      host: host.host,
      port: host.port,
      servername,
      ca: host.ca ? fs.readFileSync(host.ca) : undefined,
      rejectUnauthorized: true,
    };
    let req;
    if (op === "upload") {
      const stat = fs.statSync(localFile);
      req = tls.connect(options, () => {
        req.write(`POST /upload?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${stat.size}\r\nConnection: close\r\n\r\n`);
        fs.createReadStream(localFile).pipe(req, { end: false });
      });
    } else {
      req = tls.connect(options, () => {
        req.write(`GET /download?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
      });
    }
    const fail = (err) => reject(err instanceof Error ? err : new Error(String(err)));
    let raw = Buffer.alloc(0);
    req.on("data", (chunk) => { raw = Buffer.concat([raw, chunk]); });
    req.on("end", () => {
      req.end();
      const i = raw.indexOf("\r\n\r\n");
      if (i < 0) return fail("响应不完整");
      const statusLine = raw.subarray(0, i).toString().split("\r\n")[0];
      if (!/ 200 /.test(statusLine)) return fail(`HTTP 失败: ${statusLine}`);
      const body = raw.subarray(i + 4);
      if (op === "upload") {
        try { resolve(JSON.parse(body.toString())); } catch (err) { fail(err); }
      } else {
        fs.writeFileSync(localFile, body);
        resolve({ size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") });
      }
    });
    req.on("error", fail);
  });
}

module.exports = { httpOp };