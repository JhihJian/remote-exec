"use strict";

const crypto = require("crypto");
const net = require("net");
const fs = require("fs");
const { WebSocket } = require("ws");
const { createStore } = require("./config-store.js");
const { resolveBundle } = require("./bundle.js");
const defaultPrompts = require("./prompts.js");

function parseArgs(argv) {
  const options = { port: 8791, sshPort: 22, targets: [] };
  const flags = { "--via": "via", "--port": "port", "--identity": "identity", "--package": "package", "--ssh-port": "sshPort", "--host-key": "hostKey" };
  const args = argv[0] === "deploy" ? argv.slice(1) : argv;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg.startsWith("--")) {
      const key = flags[arg];
      if (!key || seen.has(key)) throw new Error(`未知或重复参数: ${arg}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
      seen.add(key);
      options[key] = value;
    } else {
      const match = /^(?:([a-zA-Z0-9][a-zA-Z0-9_.-]*)=)?([a-zA-Z_][a-zA-Z0-9_.-]*)@([^@]+)$/.exec(arg);
      if (!match || net.isIP(match[3]) !== 4) throw new Error(`目标必须是 [name=]user@IPv4: ${arg}`);
      options.targets.push({ name: match[1] || `host-${match[3].replaceAll(".", "-")}`, username: match[2], host: match[3] });
    }
  }
  for (const key of ["port", "sshPort"]) {
    if (!/^\d+$/.test(String(options[key])) || Number(options[key]) < 1 || Number(options[key]) > 65535) throw new Error(`${key} 必须为 1..65535`);
    options[key] = Number(options[key]);
  }
  if (options.help) return options;
  if (!options.targets.length) throw new Error("请指定至少一个部署目标 user@IPv4");
  if (options.hostKey && (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(options.hostKey) || options.targets.length !== 1)) throw new Error("--host-key 需要 SHA256 指纹且仅支持单目标");
  const names = new Set();
  const endpoints = new Set();
  options.targets = options.targets.map((target) => {
    if (names.has(target.name) || endpoints.has(target.host)) throw new Error(`重复目标: ${target.name}`);
    names.add(target.name);
    endpoints.add(target.host);
    return { ...target, port: options.port, sshPort: options.sshPort, ...(options.via ? { via: options.via } : {}) };
  });
  return options;
}

// Verify using in-memory CA/token, before adding a host to local configuration.
async function useWssClient(target, credentials, request, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${target.host}:${target.port}/`, {
      ca: credentials.certificate,
      rejectUnauthorized: true,
      handshakeTimeout: 5000,
      headers: { authorization: `Bearer ${credentials.token}` },
    });
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      ws.terminate();
      if (err) reject(err); else resolve(result);
    };
    const abort = () => finish(new Error("操作已取消"));
    const timer = setTimeout(() => finish(new Error("daemon 验收超时")), 10000);
    ws.on("error", (err) => finish(err));
    ws.on("unexpected-response", (_request, response) => { response.resume(); finish(new Error(`daemon 拒绝连接（HTTP ${response.statusCode}）`)); });
    ws.on("close", () => finish(new Error("daemon 验收连接提前关闭")));
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, ...request })));
    ws.on("message", (data) => {
      let message;
      try { message = JSON.parse(data.toString("utf8")); } catch { finish(new Error("daemon 返回无效 JSON")); return; }
      if (message.id !== 1 || message.event) return;
      finish(message.error ? new Error("daemon 验收 RPC 失败") : null, message.result);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function verifyTarget(target, credentials, deps, signal) {
  const marker = `rex-deploy-${crypto.randomBytes(16).toString("hex")}`;
  const request = { method: "exec", params: { command: `printf '\\n${marker}\\n'; id -un`, timeoutMs: 5000 } };
  let result;
  if (target.via) {
    let abort;
    let timer;
    const onSignal = () => abort?.();
    signal?.addEventListener("abort", onSignal, { once: true });
    try {
      result = await Promise.race([
        deps.callHost(target.via, "relay", {
          target: { host: target.host, port: target.port },
          auth: { token: credentials.token, ca: credentials.certificate },
          request,
          timeoutMs: 10000,
        }, (fn) => { abort = fn; if (signal?.aborted) fn(); }),
        new Promise((_resolve, reject) => { timer = setTimeout(() => { abort?.(); reject(new Error("daemon 验收超时")); }, 10000); }),
      ]);
      if (result.error) throw new Error("daemon 验收 RPC 失败");
      result = result.result;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", onSignal); }
  } else result = await deps.useWssClient(target, credentials, request, { signal });
  const stdout = typeof result?.stdoutB64 === "string" ? Buffer.from(result.stdoutB64, "base64").toString("utf8") : result?.stdout;
  if (!["root", "remote-exec"].includes(credentials.runUser)) throw new Error("安装返回了未知服务身份");
  if (result?.exitCode !== 0 || !stdout?.trimEnd().endsWith(`\n${marker}\n${credentials.runUser}`)) throw new Error("daemon 验收输出或执行用户不匹配");
}

function redact(text, secrets) {
  let clean = String(text);
  for (const secret of secrets) if (secret) clean = clean.split(secret).join("[已隐藏]");
  return clean;
}

async function deploy(input, injected = {}) {
  const options = Array.isArray(input) ? parseArgs(input) : input;
  const client = require("../client/index.js");
  const ssh = injected.ssh || { inspectHost: (...args) => require("./ssh.js").inspectHost(...args), installTarget: (...args) => require("./ssh.js").installTarget(...args) };
  const deps = { ...client, useWssClient, resolveBundle, ...injected };
  const store = deps.store || createStore();
  const prompts = deps.prompts || defaultPrompts;
  const output = deps.output || ((text) => process.stderr.write(text));
  const signal = deps.signal;
  if (options.via) {
    const gateway = store.loadConfig().hosts[options.via];
    if (!gateway) throw new Error(`未知网关: ${options.via}`);
    if (gateway.via) throw new Error("via 仅支持单跳，网关自身不得设置 via");
    // Read trust material before any upload or remote mutation.
    fs.readFileSync(gateway.ca);
    fs.readFileSync(gateway.tokenFile);
  }
  for (const target of options.targets) store.assertAvailable(target);
  const bundle = await deps.resolveBundle({ package: options.package, onProgress: output, signal });
  const results = [];
  let prepared;
  let preparationAttempted = false;
  let preparationError;
  let cancelled = false;
  try {
    for (const target of options.targets) {
      let password;
      let sudoPassword;
      let credentials;
      let transcript = "";
      let transcriptTruncated = false;
      let abortInstall;
      const onAbort = (fn) => { abortInstall = fn; if (signal?.aborted) fn(); };
      const onSignal = () => abortInstall?.();
      signal?.addEventListener("abort", onSignal);
      const collect = (chunk) => {
        if (transcriptTruncated) return;
        const text = String(chunk);
        if (transcript.length + text.length > 1024 * 1024) {
          transcript = "";
          transcriptTruncated = true;
        } else transcript += text;
      };
      const streamOutput = (event) => {
        if (typeof event === "string" || Buffer.isBuffer(event)) collect(event);
        else if (event?.dataB64) collect(Buffer.from(event.dataB64, "base64").toString("utf8"));
      };
      try {
        if (cancelled || signal?.aborted) throw new Error("操作已取消");
        output(`正在部署 ${target.name} (${target.host})\n`);
        const inspected = target.via
          ? await deps.callHost(target.via, "deploy.ssh", { action: "inspect", target: { host: target.host, sshPort: target.sshPort } }, onAbort)
          : await ssh.inspectHost({ host: target.host, sshPort: target.sshPort }, { signal });
        const fingerprint = inspected.fingerprint;
        if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("SSH 返回无效主机指纹");
        const known = store.getFingerprint(target);
        if (known && known !== fingerprint) throw new Error("SSH 主机指纹发生变化，拒绝连接");
        if (options.hostKey && options.hostKey !== fingerprint) throw new Error("SSH 主机指纹与 --host-key 不匹配");
        if (!known && !options.hostKey && !await prompts.yes(`信任 ${target.host}:${target.sshPort} 的 SSH 指纹 ${fingerprint}？`)) throw new Error("未确认 SSH 主机指纹");
        store.saveFingerprint(target, fingerprint);
        if (target.via && !preparationAttempted) {
          preparationAttempted = true;
          try {
            prepared = await deps.callHost(target.via, "deploy.ssh", { action: "prepare" }, onAbort);
            for (const kind of ["package", "checksum", "installer"]) await deps.httpOp(target.via, "upload", bundle[kind], prepared.files[kind], { signal });
          } catch (err) { preparationError = err; }
        }
        if (preparationError) throw preparationError;
        let sshAttempts = 0;
        let sudoAttempts = 0;
        while (true) {
          if (signal?.aborted) throw new Error("操作已取消");
          const installOptions = {
            host: target.host, sshPort: target.sshPort, username: target.username, fingerprint,
            ...(options.identity ? { identity: options.identity } : {}),
            ...(password !== undefined ? { password } : {}),
            ...(sudoPassword !== undefined ? { sudoPassword } : {}),
            port: target.port, runUser: "remote-exec",
          };
          try {
            credentials = target.via
              ? await deps.callHostStream(target.via, "deploy.ssh", { action: "install", id: prepared.id, target: installOptions }, streamOutput, onAbort)
              : await ssh.installTarget({ ...installOptions, bundle: { package: bundle.package, checksum: bundle.checksum, installer: bundle.installer } }, { onOutput: collect, signal });
            break;
          } catch (err) {
            if (signal?.aborted) throw new Error("操作已取消");
            if (err.message.includes("SSH_AUTH_REQUIRED") && sshAttempts++ < 3) password = await prompts.secret(`${target.username}@${target.host} SSH 密码`);
            else if (target.username !== "root" && err.message.includes("SUDO_PASSWORD_REQUIRED") && sudoAttempts++ < 3) sudoPassword = await prompts.secret(`${target.username}@${target.host} sudo 密码`);
            else throw err;
          }
        }
        if (!credentials || typeof credentials.token !== "string" || !credentials.token || typeof credentials.certificate !== "string" || !credentials.certificate.includes("BEGIN CERTIFICATE")) throw new Error("安装未返回有效连接凭据");
        await verifyTarget(target, credentials, deps, signal);
        if (signal?.aborted) throw new Error("操作已取消");
        store.register(target, credentials);
        // Only emit installation output after its returned credentials can be redacted.
        if (transcript) output(redact(transcript, [password, sudoPassword, credentials.token, credentials.certificate]));
        output(`${target.name} 部署成功，已登记配置\n`);
        results.push({ name: target.name, host: target.host, success: true, version: credentials.version });
      } catch (err) {
        if (err.code === "ABORT_ERR") cancelled = true;
        const error = redact(err.message || "部署失败", [password, sudoPassword, credentials?.token, credentials?.certificate]);
        output(`${target.name} 部署失败: ${error}\n`);
        results.push({ name: target.name, host: target.host, success: false, error });
      } finally {
        password = undefined;
        sudoPassword = undefined;
        transcript = "";
        signal?.removeEventListener("abort", onSignal);
      }
    }
  } finally {
    try {
      if (prepared?.id) await deps.callHost(options.via, "deploy.ssh", { action: "cleanup", id: prepared.id });
    } catch { output("网关临时部署文件清理失败\n"); }
    finally { await bundle.cleanup(); }
  }
  return results;
}

const HELP = "用法: rex deploy [--via 网关名] [--port 8791] [--identity 私钥路径] [--package tar.gz] [--ssh-port 22] [--host-key SHA256:...] [name=]user@IPv4 ...\n";

async function main(argv = process.argv.slice(2), injected = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const options = parseArgs(argv);
    if (options.help) { (injected.output || ((text) => process.stdout.write(text)))(HELP); return []; }
    const results = await deploy(options, { signal: controller.signal, ...injected });
    if (results.some((result) => !result.success)) process.exitCode = 1;
    return results;
  } catch (err) {
    (injected.output || ((text) => process.stderr.write(text)))(`${err.message}\n`);
    process.exitCode = 1;
    return [];
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

module.exports = { parseArgs, deploy, main, useWssClient, verifyTarget };
