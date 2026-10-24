"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { WssClient } = require("../../src/client/websocket.js");

const exec = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const packagePath = process.env.INSTALL_PACKAGE || path.join(root, "dist/rust-handoff/remote-exec-linux-x64.tar.gz");
const daemon = process.env.RUST_DAEMON || path.join(root, "rust/target/x86_64-unknown-linux-musl/release/remote-execd");
const token = "node-rust-handoff-test-token";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function waitForOutput(child, text, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`等待输出超时: ${text}\n${output}`)), timeout);
    const onData = (chunk) => {
      output += String(chunk);
      if (output.includes(text)) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve(output);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error(`进程提前退出 ${code}: ${output}`));
      }
    });
  });
}

async function cleanupSupervisor(controlPath) {
  const { stdout } = await exec("ps", ["-eo", "pid=,args="]);
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && match[2].includes("remote-execd supervisor") && match[2].includes(`--control ${controlPath}`)) {
      try { process.kill(Number(match[1]), "SIGTERM"); } catch {}
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function main() {
  assert.ok(fs.existsSync(packagePath), `缺少 Rust 发布包: ${packagePath}`);
  assert.ok(fs.existsSync(daemon), `缺少 Rust daemon: ${daemon}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remote-exec-handoff-"));
  const cert = path.join(tmp, "server.crt");
  const key = path.join(tmp, "server.key");
  const tokenFile = path.join(tmp, "token.sha256");
  const configFile = path.join(tmp, "handoff.json");
  const versions = path.join(tmp, "versions");
  const state = path.join(tmp, "state.json");
  const control = path.join(tmp, "supervisor.sock");
  const port = 18991;
  fs.writeFileSync(tokenFile, `${sha256(token)}\n`, { mode: 0o600 });
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1"]);
  fs.writeFileSync(configFile, JSON.stringify({
    supervisor: daemon,
    ctl: daemon,
    package: packagePath,
    sha256: sha256(fs.readFileSync(packagePath)),
    host: "127.0.0.1",
    port,
    versionsDir: versions,
    link: path.join(tmp, "current"),
    control,
    state,
    backendCa: cert,
    command: ["{version_dir}/bin/remote-execd", "daemon", "--host", "127.0.0.1",
      "--cert", cert, "--key", key, "--token-sha256-file", tokenFile],
  }, null, 2));
  const node = spawn(process.execPath, [path.join(root, "src/daemon/main.js"),
    "--host", "127.0.0.1", "--port", String(port), "--cert", cert, "--key", key,
    "--token-sha256-file", tokenFile, "--handoff-config", configFile], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let nodeOutput = "";
  node.stdout.on("data", (chunk) => { nodeOutput += String(chunk); });
  node.stderr.on("data", (chunk) => { nodeOutput += String(chunk); });
  try {
    await waitForOutput(node, "listening", 10000);
    const oldConnection = new WssClient({ host: "127.0.0.1", port, ca: cert });
    await oldConnection.connectToken(token);
    const oldRequest = oldConnection.call("exec", {
      command: "sleep 2; printf old-completed",
      timeoutMs: 10000,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.kill(node.pid, "SIGUSR2");
    const rustConnection = new WssClient({ host: "127.0.0.1", port, ca: cert });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await rustConnection.connectToken(token);
    const rustResult = await rustConnection.call("exec", { command: "printf rust-new" });
    const oldResult = await oldRequest;
    assert.equal(Buffer.from(rustResult.stdoutB64, "base64").toString(), "rust-new");
    assert.equal(Buffer.from(oldResult.stdoutB64, "base64").toString(), "old-completed");
    rustConnection.abort();
    oldConnection.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(node.exitCode, 0, `Node 未正常退出: ${nodeOutput}`);
    process.stdout.write("PASS Node listener handoff：旧 WSS 请求完成，新连接进入 Rust\n");
  } finally {
    if (node.exitCode === null) node.kill("SIGKILL");
    await cleanupSupervisor(control);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
