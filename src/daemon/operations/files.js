"use strict";

const fs = require("fs");
const path = require("path");
const { MAX_PAYLOAD } = require("../shared/constants.js");
const { rpcError } = require("../shared/rpc-error.js");

const b64 = (buf) => buf.toString("base64");

async function fileRead(params) {
  const { file } = params;
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw rpcError(-32602, "params.file 必须是绝对路径");
  }
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw rpcError(-32603, `文件不存在或不是常规文件: ${file}`);
  if (st.size > MAX_PAYLOAD) {
    throw rpcError(-32602, `文件 ${st.size} 字节超过 ${MAX_PAYLOAD} 上限，请分段读取或使用 /download 流式下载`);
  }
  const content = await fs.promises.readFile(file);
  return { contentB64: b64(content), size: content.length };
}

async function fileWrite(params) {
  const { file, contentB64 } = params;
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw rpcError(-32602, "params.file 必须是绝对路径");
  }
  if (typeof contentB64 !== "string") {
    throw rpcError(-32602, "params.contentB64 必须是 base64 字符串");
  }
  const content = Buffer.from(contentB64, "base64");
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content);
  return { size: content.length };
}

module.exports = { fileRead, fileWrite };
