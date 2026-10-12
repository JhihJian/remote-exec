"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { log } = require("../shared/log.js");

function handleUpload(req, res) {
  const url = new URL(req.url, "https://localhost");
  const file = url.searchParams.get("path");
  if (!file || !path.isAbsolute(file)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "path 必须是绝对路径" }));
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  log("upload.start", file);
  const tmp = path.join(
    path.dirname(file),
    `.remote-exec-tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const hash = crypto.createHash("sha256");
  let size = 0;
  const out = fs.createWriteStream(tmp, { mode: 0o644 });
  const fail = (status, message) => {
    out.destroy();
    fs.unlink(tmp, () => {});
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    } else res.destroy();
  };
  req.on("data", (chunk) => {
    size += chunk.length;
    hash.update(chunk);
  });
  req.on("end", () => log("upload.req-end", `${size}B`));
  req.on("error", (err) => { log("upload.req-error", String(err)); fail(500, String(err)); });
  req.on("aborted", () => { log("upload.aborted", `${size}B`); fail(500, "客户端中断"); });
  out.on("error", (err) => { log("upload.out-error", String(err)); fail(500, String(err)); });
  out.on("finish", () => {
    fs.rename(tmp, file, (err) => {
      if (err) {
        fail(500, String(err));
        return;
      }
      const body = JSON.stringify({ size, sha256: hash.digest("hex") });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      log("upload", `${file} ${size}B`);
    });
  });
  req.pipe(out);
}

function handleDownload(req, res) {
  const url = new URL(req.url, "https://localhost");
  const file = url.searchParams.get("path");
  if (!file || !path.isAbsolute(file)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "path 必须是绝对路径" }));
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `文件不存在: ${file}` }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": st.size,
    });
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    log("download", `${file} ${st.size}B`);
  });
}

module.exports = { handleDownload, handleUpload };
