"use strict";

const https = require("https");
const path = require("path");
const { HTTP_IDLE_TIMEOUT_MS } = require("../shared/constants.js");
const { relayAllowedByTarget } = require("../operations/relay.js");

const MAX_REQUEST_BYTES = 128 * 1024;

function fail(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function parseRequest(body, relayAllow) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("请求体必须是 JSON");
  }
  const target = value?.target;
  const auth = value?.auth;
  const file = value?.file;
  if (
    !target || typeof target.host !== "string" || !Number.isInteger(target.port) ||
    target.port < 1 || target.port > 65535 || !relayAllowedByTarget(target.host, relayAllow) ||
    !auth || typeof auth.token !== "string" || !auth.token ||
    typeof auth.ca !== "string" || !auth.ca.includes("BEGIN CERTIFICATE") ||
    typeof file !== "string" || !path.isAbsolute(file)
  ) {
    throw new Error("需要合法的 target、auth 和绝对路径 file，目标必须在 relay 白名单内");
  }
  return { target, auth, file };
}

function handleRelayDownload(req, res, relayAllow) {
  let size = 0;
  const chunks = [];
  let finished = false;
  const rejectRequest = (status, message) => {
    if (finished) return;
    finished = true;
    fail(res, status, message);
  };
  req.on("data", (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      rejectRequest(413, "relay-download 请求体过大");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.once("error", (err) => rejectRequest(400, String(err)));
  req.once("aborted", () => { finished = true; });
  req.once("end", () => {
    if (finished) return;
    let request;
    try {
      request = parseRequest(Buffer.concat(chunks).toString("utf8"), relayAllow);
    } catch (err) {
      rejectRequest(400, err.message);
      return;
    }

    const upstream = https.request({
      host: request.target.host,
      port: request.target.port,
      servername: request.target.servername || request.target.host,
      path: `/download?path=${encodeURIComponent(request.file)}`,
      method: "GET",
      ca: request.auth.ca,
      rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${request.auth.token}` },
    }, (targetRes) => {
      if (finished) {
        targetRes.destroy();
        return;
      }
      finished = true;
      const headers = {};
      for (const name of ["content-type", "content-length"]) {
        if (targetRes.headers[name]) headers[name] = targetRes.headers[name];
      }
      res.writeHead(targetRes.statusCode || 502, headers);
      targetRes.pipe(res);
    });
    upstream.setTimeout(HTTP_IDLE_TIMEOUT_MS, () => upstream.destroy(new Error("目标下载连接停滞超时")));
    upstream.once("error", (err) => {
      if (finished) return;
      rejectRequest(502, `目标下载失败: ${err.message}`);
    });
    res.once("close", () => upstream.destroy());
    upstream.end();
  });
}

module.exports = { handleRelayDownload };