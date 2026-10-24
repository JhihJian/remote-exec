"use strict";
// Rust 原型 E2E 公共工具：容器编排、rex 调用、PTY 密码喂入、证书与指纹。
// phase3a/3b/4a 共用；secrets 登记后 redact 会替换所有输出。

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);

const root = path.resolve(__dirname, "../..");
const image = process.env.DEPLOY_TEST_IMAGE || "remote-exec-deploy:test";
const rex = process.env.REX_BINARY || path.join(root,
  "rust/target/x86_64-unknown-linux-musl/release/rex");
const rexOps = process.env.REX_OPS_BINARY || path.join(root,
  "rust/target/x86_64-unknown-linux-musl/release/rex-ops");
const daemonBinary = process.env.RUST_PROTOTYPE_BINARY || path.join(root,
  "rust/target/x86_64-unknown-linux-musl/release/remote-execd");
const serverPackage = process.env.INSTALL_PACKAGE || path.join(root, "dist/rust-release/remote-exec-linux-x64.tar.gz");
const nodePackage = process.env.NODE_PACKAGE || path.join(root, "dist/remote-exec-linux-x64.tar.gz");

const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness() {
  const secrets = [];
  const redact = (text) => {
    let result = String(text);
    for (const secret of secrets) if (secret) result = result.split(secret).join("[已隐藏]");
    return result;
  };
  const command = async (file, args, options = {}) => {
    try {
      return await exec(file, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
    } catch (error) {
      throw new Error(redact(`${file} 失败: ${error.stderr || error.message}`));
    }
  };
  const docker = (args, options) => command("docker", args, options);
  const until = async (check, description, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { return await check(); } catch (error) { last = error; }
      await sleep(250);
    }
    throw new Error(`${description} 超时: ${last?.message || "未就绪"}`);
  };
  const privateFile = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
  };
  const rexEnv = (configDir, extra = {}) => ({
    ...process.env,
    HOME: configDir,
    REX_CONFIG_DIR: path.join(configDir, ".config/remote-exec"),
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, value])),
  });
  // 真实二进制调用。stdout/stderr 合并便于断言错误消息。
  const rexRun = (configDir, args, options = {}) =>
    new Promise((resolve) => {
      const child = spawn(rex, args, { env: rexEnv(configDir), ...options });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error}` }));
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
  const rexOpsRun = (configDir, args, options = {}) =>
    new Promise((resolve) => {
      const child = spawn(rexOps, args, { env: rexEnv(configDir), ...options });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error}` }));
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
  // 用 script(1) 伪终端喂 rpassword。固定延时喂入存在竞态：回显关闭前写入的
  // 密码会被行规程回显进 transcript。改为检测到"密码"提示后立即喂入下一个答案，
  // 此时 rpassword 已关闭回显，密码不会进入输出。
  const rexRunPty = (configDir, args, answers, timeoutMs = 240000) =>
    new Promise((resolve) => {
      const child = spawn("script", ["-qec",
        [rex, ...args].map((part) => `'${String(part).replace(/'/g, `'\\''`)}'`).join(" "),
        "/dev/null"],
      { env: rexEnv(configDir), stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let fed = 0;
      let seenPrompts = 0;
      const onChunk = (chunk) => {
        output += chunk;
        const prompts = (String(chunk).match(/密码/g) || []).length;
        if (prompts > 0) {
          seenPrompts += prompts;
          while (fed < seenPrompts && fed < answers.length) {
            child.stdin.write(`${answers[fed]}\n`);
            fed += 1;
          }
        }
      };
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  const rexOpsRunPty = (configDir, args, answers, timeoutMs = 240000) =>
    new Promise((resolve) => {
      const child = spawn("script", ["-qec",
        [rexOps, ...args].map((part) => `'${String(part).replace(/'/g, `'\\''`)}'`).join(" "),
        "/dev/null"],
      { env: rexEnv(configDir), stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let fed = 0;
      let seenPrompts = 0;
      const onChunk = (chunk) => {
        output += chunk;
        const prompts = (String(chunk).match(/密码/g) || []).length;
        if (prompts > 0) {
          seenPrompts += prompts;
          while (fed < seenPrompts && fed < answers.length) {
            child.stdin.write(`${answers[fed]}\n`);
            fed += 1;
          }
        }
      };
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  const containerIp = async (container, network) => {
    const { stdout } = await docker(["inspect", "--format",
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container]);
    return stdout.trim();
  };
  const fingerprintOf = async (host, port = 22) => {
    const { stdout } = await command("ssh-keyscan", ["-p", String(port), "-T", "5", "-t", "ed25519", host]);
    const first = stdout.split("\n").find((line) => line && !line.startsWith("#"));
    assert.ok(first, `ssh-keyscan 无输出: ${host}`);
    const { stdout: fp } = await command("bash", ["-c", `printf '%s\n' '${first.replace(/'/g, `'\\''`)}' | ssh-keygen -lf -`]);
    return fp;
  };
  const setPasswords = (container, rootPassword, opsPassword) =>
    new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", container, "chpasswd"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(redact(`设置测试密码失败: ${stderr}`))));
      child.stdin.end(`root:${rootPassword}\nops:${opsPassword}\n`);
    });
  const pushFile = (container, localFile, remoteFile, mode = 0o644) =>
    new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", container, "bash", "-c",
        `cat > '${remoteFile.replace(/'/g, `'\\''`)}' && chmod ${mode.toString(8)} '${remoteFile.replace(/'/g, `'\\''`)}'`],
      { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`推送 ${remoteFile} 失败: ${stderr}`)));
      child.stdin.on("error", (error) => reject(new Error(`推送 ${remoteFile} 失败: 对端提前退出 ${error.code || ""}`)));
      child.stdin.end(fs.readFileSync(localFile));
    });
  const execFileSync = (file, args) => {
    const result = require("node:child_process").spawnSync(file, args, { timeout: 30000 });
    assert.equal(result.status, 0, `${file} 失败: ${result.stderr}`);
  };
  // CA（keyUsage 扩展满足 rustls）+ token 材料。
  const makeIdentity = (dir, name) => {
    fs.mkdirSync(dir, { recursive: true });
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(path.join(dir, "token.sha256"), sha(token));
    privateFile(path.join(dir, "token"), token);
    const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.crt"),
      "-subj", `/CN=${name} CA`, "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign"];
    execFileSync("openssl", args);
    return { token, ca: path.join(dir, "ca.crt"), caKey: path.join(dir, "ca.key") };
  };
  // SAN 含 IP 的叶子证书（supervisor/daemon 供 rustls 客户端校验）。
  const leafCertificate = (dir, ca, caKey, hostname) => {
    const csr = path.join(dir, "server.csr");
    const key = path.join(dir, "server.key");
    const crt = path.join(dir, "server.crt");
    const ext = path.join(dir, "server.ext");
    execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", csr, "-subj", "/CN=remote-exec"]);
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    fs.writeFileSync(ext, `basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1,${ip ? `IP:${hostname}` : `DNS:${hostname}`}\n`);
    execFileSync("openssl", ["x509", "-req", "-days", "365", "-in", csr,
      "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", crt, "-extfile", ext]);
    return { key, crt };
  };
  return {
    secrets, redact, command, docker, until, privateFile, rexEnv, rexRun, rexOpsRun, rexRunPty, rexOpsRunPty,
    containerIp, fingerprintOf, setPasswords, pushFile, execFileSync, makeIdentity,
    leafCertificate, sha, sleep,
  };
}

module.exports = { createHarness, root, image, rex, rexOps, daemonBinary, serverPackage, nodePackage };
