"use strict";

const { Client, utils } = require("ssh2");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const fingerprint = (key) => `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

function validateTarget(target) {
  if (!target || typeof target.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(target.host)) throw new Error("SSH 目标地址无效");
  const sshPort = target.sshPort ?? 22;
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error("SSH 端口无效");
  if (target.username !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(target.username)) throw new Error("SSH 用户名无效");
  return { ...target, sshPort };
}

function inspectHost(target, { signal } = {}) {
  const options = validateTarget(target);
  return new Promise((resolve, reject) => {
    const connection = new Client();
    let found = false;
    const stop = () => connection.destroy();
    signal?.addEventListener("abort", stop, { once: true });
    connection.once("close", () => { signal?.removeEventListener("abort", stop); if (!found) reject(new Error("SSH 指纹检查已中断")); });
    connection.on("error", () => { if (!found) reject(new Error("无法取得 SSH 主机指纹，请检查目标地址与 SSH 端口")); });
    connection.connect({ host: options.host, port: options.sshPort, username: options.username || "remote-exec", readyTimeout: 15000,
      hostVerifier: (key) => { found = true; resolve({ fingerprint: fingerprint(key) }); return false; },
    });
    if (signal?.aborted) stop();
  });
}

async function identityOptions(target) {
  if (target.password !== undefined) return { password: target.password };
  if (target.identity) return { privateKey: await fs.promises.readFile(target.identity) };
  const identities = ["id_ed25519", "id_rsa", "id_ecdsa"];
  const authHandler = [{ type: "none", username: target.username }];
  if (process.env.SSH_AUTH_SOCK) authHandler.push({ type: "agent", username: target.username, agent: process.env.SSH_AUTH_SOCK });
  for (const name of identities) {
    try {
      const key = await fs.promises.readFile(path.join(os.homedir(), ".ssh", name));
      if (!(utils.parseKey(key) instanceof Error)) authHandler.push({ type: "publickey", username: target.username, key });
    } catch (error) { if (!["ENOENT", "EACCES"].includes(error.code)) throw new Error("无法读取 SSH 密钥，请检查执行用户权限"); }
  }
  return { authHandler };
}

async function connect(target, signal) {
  const options = validateTarget(target);
  if (typeof options.fingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(options.fingerprint)) throw new Error("需要已确认的 SSH 主机指纹");
  const auth = await identityOptions(options);
  return new Promise((resolve, reject) => {
    const connection = new Client();
    let keyMismatch = false;
    let ready = false;
    const abort = () => connection.destroy();
    signal?.addEventListener("abort", abort, { once: true });
    connection.once("close", () => { signal?.removeEventListener("abort", abort); if (!ready) reject(new Error("SSH 连接已中断")); });
    connection.on("error", (error) => {
      if (keyMismatch) reject(new Error("SSH 主机指纹发生变化，已停止部署"));
      else if (error.level === "client-authentication" || /authentication|privateKey|passphrase/i.test(error.message)) reject(new Error("SSH_AUTH_REQUIRED: SSH 认证失败"));
      else reject(new Error(`SSH 连接失败${error.code ? ` (${error.code})` : ""}`));
    });
    connection.once("ready", () => { ready = true; resolve(connection); });
    try {
      connection.connect({ host: options.host, port: options.sshPort, username: options.username, ...auth, readyTimeout: 15000, keepaliveInterval: 10000,
        hostVerifier: (key) => { keyMismatch = fingerprint(key) !== options.fingerprint; return !keyMismatch; },
      });
    } catch { reject(new Error("SSH_AUTH_REQUIRED: 无法使用当前密钥，请使用 SSH 密码")); }
    if (signal?.aborted) abort();
  });
}

function execute(connection, command, { input, onOutput, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { connection.destroy(); reject(new Error("SSH 操作超时，目标安装状态需要重新检查")); }, timeoutMs);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    connection.exec(command, (error, stream) => {
      if (error) return finish(new Error("SSH 执行通道不可用"));
      let stdout = "", stderr = "";
      const collect = (data, kind) => {
        if (kind === "stdout") stdout += data.toString("utf8"); else stderr += data.toString("utf8");
        if (stdout.length + stderr.length > 256 * 1024) { stream.close(); finish(new Error("SSH 操作输出超过上限")); return; }
        onOutput?.(data, kind);
      };
      stream.on("data", (data) => collect(data, "stdout"));
      stream.stderr.on("data", (data) => collect(data, "stderr"));
      stream.once("error", () => finish(new Error("SSH 执行中断")));
      stream.once("close", (code) => finish(null, { code: code ?? -1, stdout, stderr }));
      connection.once("close", onConnectionClose);
      stream.once("close", () => connection.removeListener("close", onConnectionClose));
      function onConnectionClose() { finish(new Error("SSH 执行连接已中断")); }
      stream.end(input || "");
    });
  });
}

function sftp(connection) {
  return new Promise((resolve, reject) => connection.sftp((error, session) => error ? reject(new Error("SSH SFTP 不可用")) : resolve(session)));
}

async function upload(session, local, remote) {
  await pipeline(fs.createReadStream(local), session.createWriteStream(remote, { mode: 0o600 }));
}

async function installTarget(options, { onOutput, signal } = {}) {
  const target = validateTarget(options);
  if (!target.username) throw new Error("缺少 SSH 用户名");
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("daemon 端口无效");
  for (const secret of [target.password, target.sudoPassword]) {
    if (secret !== undefined && (typeof secret !== "string" || secret.includes("\n") || secret.includes("\r"))) throw new Error("密码包含无效字符");
  }
  if (!target.bundle || !["package", "checksum", "installer"].every((key) => typeof target.bundle[key] === "string")) throw new Error("缺少部署运行包");
  const connection = await connect(target, signal);
  let temporary;
  let disconnected = false;
  connection.once("close", () => { disconnected = true; });
  connection.once("error", () => { disconnected = true; });
  const abort = () => { disconnected = true; connection.destroy(); };
  const timer = setTimeout(abort, 10 * 60 * 1000);
  try {
    const user = await execute(connection, "id -u");
    const uid = user.stdout.trim().split(/\s+/).at(-1);
    if (user.code !== 0 || !/^\d+$/.test(uid)) throw new Error("无法确认 SSH 用户身份");
    const root = uid === "0";
    const prefix = root ? "" : target.sudoPassword === undefined ? "sudo -n -- " : "sudo -S -p '' -- ";
    const input = !root && target.sudoPassword !== undefined ? `${target.sudoPassword}\n` : undefined;
    if (!root) {
      const privilege = await execute(connection, `${prefix}true`, { input, timeoutMs: 15000 });
      if (privilege.code !== 0) throw new Error("SUDO_PASSWORD_REQUIRED: 提权失败，请提供 sudo 密码并确认账户具有 sudo 权限");
    }
    const directory = await execute(connection, "umask 077; mktemp -d /tmp/remote-exec-deploy.XXXXXXXX");
    temporary = directory.stdout.trim().split(/\s+/).at(-1);
    if (directory.code !== 0 || !/^\/tmp\/remote-exec-deploy\.[A-Za-z0-9]{8}$/.test(temporary)) throw new Error("无法创建目标安装暂存目录");
    const session = await sftp(connection);
    try {
      await upload(session, target.bundle.package, `${temporary}/package.tar.gz`);
      await upload(session, target.bundle.checksum, `${temporary}/package.tar.gz.sha256`);
      await upload(session, target.bundle.installer, `${temporary}/install.sh`);
    } finally { session.end(); }
    const install = await execute(connection, `${prefix}bash ${quote(`${temporary}/install.sh`)} --package ${quote(`${temporary}/package.tar.gz`)} --address ${quote(target.host)} --port ${target.port}`, { input, onOutput });
    if (install.code !== 0) throw new Error(`目标安装失败（退出码 ${install.code}），请在目标查看 remote-exec 服务日志`);
    // 接入资料由专门响应交付，不进入安装日志，TLS 私钥留在目标。
    const tokenResult = await execute(connection, `${prefix}cat /root/remote-exec-access/token.txt`, { input });
    const certificateResult = await execute(connection, `${prefix}cat /root/remote-exec-access/server.crt`, { input });
    const manifestResult = await execute(connection, `${prefix}cat /opt/remote-exec/install.json`, { input });
    const token = tokenResult.stdout.match(/(?:^|\n)([a-f0-9]{64})(?:\n|$)/)?.[1];
    const certificate = certificateResult.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    let config;
    try { config = JSON.parse(manifestResult.stdout.slice(manifestResult.stdout.indexOf("{"))); } catch { throw new Error("无法读取目标安装状态"); }
    if ([tokenResult, certificateResult, manifestResult].some((result) => result.code !== 0) || !token || !certificate) throw new Error("无法取得目标接入资料");
    return { token, certificate: `${certificate}\n`, version: config.version, runUser: config.runUser, port: config.port };
  } finally {
    clearTimeout(timer);
    if (temporary) {
      let cleanupConnection = connection;
      try {
        // 取消导致原连接关闭时，重新建立已验证指纹的连接，只清理本次暂存目录。
        if (signal?.aborted || disconnected) cleanupConnection = await connect(target);
        const cleanup = await execute(cleanupConnection, `rm -rf -- ${quote(temporary)}`, { timeoutMs: 5000 });
        if (cleanup.code !== 0) throw new Error("清理命令未成功");
      } catch {
        throw new Error(`目标暂存清理失败，请通过 SSH 清理 ${temporary} 并检查服务状态`);
      } finally {
        if (cleanupConnection !== connection) cleanupConnection.end();
        connection.end();
      }
    } else connection.end();
  }
}

module.exports = { inspectHost, installTarget, validateTarget, fingerprint };
