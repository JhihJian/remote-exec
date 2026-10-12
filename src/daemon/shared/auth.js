"use strict";

const crypto = require("crypto");
const fs = require("fs");

function loadTokenSha256(file) {
  const hex = fs.readFileSync(file, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`token sha256 文件格式错误（需要 64 位 hex）: ${file}`);
  }
  return Buffer.from(hex, "hex");
}

function bearerTokenFromHeaders(headers) {
  const auth = headers.authorization;
  if (!auth || !/^Bearer /i.test(auth)) return null;
  return auth.slice(7).trim();
}

function checkToken(tokenSha256, headers) {
  const token = bearerTokenFromHeaders(headers);
  if (!token) return false;
  const actual = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(tokenSha256, actual);
}

module.exports = { checkToken, loadTokenSha256 };