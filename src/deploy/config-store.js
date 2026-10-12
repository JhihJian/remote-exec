"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function createStore(root = path.join(os.homedir(), ".config", "remote-exec")) {
  const configPath = path.join(root, "hosts.json");
  const fingerprintsPath = path.join(root, "ssh-hosts.json");
  function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (err) { if (err.code === "ENOENT") return fallback; throw err; }
  }
  function atomic(file, content) {
    const tmp = `${file}.${crypto.randomBytes(12).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
    } finally { try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== "ENOENT") throw err; } }
  }
  function locked(fn) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const lock = path.join(root, ".deploy.lock");
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (err) { if (err.code === "EEXIST") throw new Error("其他部署正在更新配置，请稍后重试"); throw err; }
    try { return fn(); } finally { fs.rmdirSync(lock); }
  }
  function loadConfig() {
    const config = read(configPath, { hosts: {} });
    if (!config || typeof config !== "object" || !config.hosts || typeof config.hosts !== "object" || Array.isArray(config.hosts)) throw new Error("hosts.json 格式错误");
    return config;
  }
  function assertAvailable(target, config = loadConfig()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(target.name)) throw new Error("主机别名格式错误");
    const existing = Object.hasOwn(config.hosts, target.name) ? config.hosts[target.name] : undefined;
    if (existing && (existing.host !== target.host || existing.port !== target.port || (existing.via || null) !== (target.via || null))) {
      throw new Error(`主机别名 ${target.name} 已被其他端点使用`);
    }
    return existing;
  }
  const fingerprintKey = (target) => JSON.stringify([target.via ? "via" : "direct", target.via || null, target.host, target.sshPort]);
  function getFingerprint(target) { return read(fingerprintsPath, {})[fingerprintKey(target)]; }
  function saveFingerprint(target, fingerprint) {
    return locked(() => {
      const records = read(fingerprintsPath, {});
      const key = fingerprintKey(target);
      if (records[key] && records[key] !== fingerprint) throw new Error("SSH 主机指纹发生变化，拒绝连接");
      records[key] = fingerprint;
      atomic(fingerprintsPath, `${JSON.stringify(records, null, 2)}\n`);
    });
  }
  function register(target, credentials) {
    return locked(() => {
      const config = loadConfig();
      const existing = assertAvailable(target, config);
      const directory = path.join(root, "credentials", target.name);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      const accessDirectory = fs.mkdtempSync(path.join(directory, "access-"));
      fs.chmodSync(accessDirectory, 0o700);
      const tokenFile = path.join(accessDirectory, "token");
      const ca = path.join(accessDirectory, "ca.pem");
      try {
        atomic(tokenFile, credentials.token);
        atomic(ca, credentials.certificate);
        const host = { ...existing, host: target.host, port: target.port, ca, tokenFile };
        if (target.via) host.via = target.via;
        else delete host.via;
        Object.defineProperty(config.hosts, target.name, { value: host, enumerable: true, writable: true, configurable: true });
        atomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
        for (const oldFile of [existing?.tokenFile, existing?.ca]) {
          if (!oldFile) continue;
          const oldDirectory = path.dirname(oldFile);
          const owned = path.dirname(oldDirectory) === directory && path.basename(oldDirectory).startsWith("access-");
          const referenced = Object.values(config.hosts).some((item) => [item.ca, item.tokenFile].some((file) => file && path.dirname(file) === oldDirectory));
          if (owned && !referenced) {
            try { fs.rmSync(oldDirectory, { recursive: true, force: true }); }
            catch { /* 旧目录清理失败不影响已提交的新凭据。 */ }
          }
        }
        return host;
      } catch (error) {
        fs.rmSync(accessDirectory, { recursive: true, force: true });
        throw error;
      }
    });
  }
  return { loadConfig, assertAvailable, getFingerprint, saveFingerprint, register };
}

module.exports = { createStore };
