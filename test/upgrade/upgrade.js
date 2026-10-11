#!/usr/bin/env node
"use strict";

// 独立真实升级验收：node test/upgrade/upgrade.js
// 仅需 Node >=18、项目依赖 ws 和 openssl。本机与 xiaomi 使用相同入口。
// supervisor 尚无回滚窗口 API，窗口由此验收流程管理，关闭窗口后才发送 retire。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const WebSocket = require("ws");
const { createSupervisor } = require("../../src/supervisor/supervisor.js");

const ROOT = path.resolve(__dirname, "../..");
const STEP_MS = 10000;
const TOTAL_MS = 75000;
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // 屏障后才 await 的操作也必须立即安装拒绝处理器。
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function bounded(promise, label, ms = STEP_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 截止时间 ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function freePort(host) {
  const server = net.createServer();
  try {
    await bounded(new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    }), "临时端口监听");
    return server.address().port;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "re-upgrade-"));
  const controlPath = path.join(dir, "control.sock");
  const sockets = new Set();
  const clients = new Set();
  const pids = new Set();
  const childLogs = [];
  let supervisor;
  let stopped = false;
  let deadline;
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const check = () => { if (stopped) throw new Error("验收已截止或正在清理"); };
  async function until(fn, label, ms = STEP_MS) {
    const end = Date.now() + ms;
    do {
      check();
      if (await fn()) return;
      await delay(25);
    } while (Date.now() < end);
    throw new Error(`${label} 截止时间 ${ms}ms`);
  }
  function control(method, params = {}) {
    check();
    return new Promise((resolve, reject) => {
      const socket = track(net.connect(controlPath));
      let data = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`控制 ${method} 超时`)), STEP_MS);
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error(`控制 ${method} 提前关闭`)));
      socket.once("connect", () => socket.write(`${JSON.stringify({ method, ...params })}\n`));
      socket.on("data", (chunk) => {
        data += chunk;
        const newline = data.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(data.slice(0, newline));
          finish(response.ok ? null : new Error(response.error), response.result);
        } catch (error) { finish(error); }
      });
    });
  }
  function credentials(name) {
    const cert = path.join(dir, `${name}.crt`);
    const key = path.join(dir, `${name}.key`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
      "-out", cert, "-days", "1", "-subj", `/CN=${name}`, "-addext", "subjectAltName=IP:127.0.0.1"],
    { stdio: "ignore", timeout: STEP_MS });
    const token = crypto.randomBytes(32).toString("hex");
    const tokenFile = path.join(dir, `${name}.sha256`);
    fs.writeFileSync(tokenFile, sha256(token), { mode: 0o600 });
    return { cert, key, token, tokenFile, ca: fs.readFileSync(cert, "utf8") };
  }
  function request(port, credentials, method, url, headers = {}) {
    check();
    const req = https.request({ host: "127.0.0.1", port, method, path: url,
      ca: credentials.ca, rejectUnauthorized: true, agent: false,
      headers: { Authorization: `Bearer ${credentials.token}`, ...headers } });
    req.on("socket", track);
    req.setTimeout(STEP_MS, () => req.destroy(new Error(`${method} ${url} 空闲超时`)));
    return req;
  }
  async function get(port, credentials, url = "/readyz") {
    const req = request(port, credentials, "GET", url);
    return bounded(new Promise((resolve, reject) => {
      req.once("error", reject);
      req.once("response", (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.once("error", reject);
        res.once("aborted", () => reject(new Error("HTTPS 响应中断")));
        res.once("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.end();
    }), `HTTPS ${url}`).finally(() => req.destroy());
  }
  async function connect(port, credentials) {
    check();
    const ws = new WebSocket(`wss://127.0.0.1:${port}/`, {
      ca: credentials.ca, rejectUnauthorized: true, handshakeTimeout: STEP_MS,
      headers: { Authorization: `Bearer ${credentials.token}` },
    });
    const pending = new Map();
    let nextId = 1;
    clients.add(ws);
    const fail = (error) => {
      for (const item of pending.values()) item.reject(error);
      pending.clear();
    };
    ws.on("error", fail);
    ws.once("close", () => { clients.delete(ws); fail(new Error("WSS 提前关闭")); });
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        const item = pending.get(message.id);
        if (!item) return;
        if (message.event) { item.event?.(message); return; }
        pending.delete(message.id);
        if (message.error) item.reject(new Error(`RPC ${message.error.code}: ${message.error.message}`));
        else item.resolve(message.result);
      } catch (error) { fail(error); }
    });
    await bounded(new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", () => reject(new Error("WSS 握手提前关闭")));
    }), "WSS 握手");
    return {
      ws,
      call(method, params = {}, event) {
        const id = nextId++;
        const operation = new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject, event });
          ws.send(JSON.stringify({ id, method, params }), (error) => {
            if (error) { pending.delete(id); reject(error); }
          });
        });
        const result = bounded(operation, `RPC ${method}`).finally(() => pending.delete(id));
        result.catch(() => {});
        return result;
      },
      async close() {
        if (ws.readyState === WebSocket.CLOSED) return;
        await bounded(new Promise((resolve) => {
          ws.once("close", resolve);
          ws.close();
        }), "WSS 正常关闭", 2000).catch(() => ws.terminate());
      },
    };
  }
  const labelCommand = 'printf "%s" "$RELEASE_LABEL"';
  async function fresh(expected, port, credentials) {
    const client = await connect(port, credentials);
    try {
      const result = await client.call("exec", { command: labelCommand, timeoutMs: 3000 });
      assert.equal(result.exitCode, 0);
      assert.equal(Buffer.from(result.stdoutB64, "base64").toString(), expected);
    } finally { await client.close(); }
  }
  async function start(name, label, credentials, ready = true) {
    const port = await freePort("127.0.0.1");
    const log = path.join(dir, `${name}.log`);
    childLogs.push(log);
    // 日志由真实子进程写入，不改变 supervisor 的 stdio/API。
    const boot = `const fs=require('node:fs');const log=fs.createWriteStream(${JSON.stringify(log)});` +
      `process.stderr.write=(s)=>log.write(s);const server=require(${JSON.stringify(path.join(ROOT, "src/daemon/main.js"))}).main(process.argv.slice(1));` +
      // 真实 TLS daemon 的候选启动钩子：readyz 尚未发布，返回正常的 404。
      (ready ? "" : `server.prependListener('request',(req)=>{if(req.url==='/readyz')req.url='/candidate-not-ready';});`);
    const backend = { host: "127.0.0.1", port, protocol: "https", ca: credentials.ca };
    const status = await control("start", { generation: name, backend,
      command: [process.execPath, "-e", boot, "--", "--host", "127.0.0.1", "--port", String(port),
        "--cert", credentials.cert, "--key", credentials.key, "--token-sha256-file", credentials.tokenFile,
        "--generation", name, "--drain-timeout-ms", "2000"],
      cwd: ROOT, env: { RELEASE_LABEL: label } });
    const pid = status.generations.find((item) => item.name === name).process?.pid;
    assert(pid, `${name} 未获得托管 PID`);
    pids.add(pid);
    await until(async () => {
      assert(alive(pid), `${name} 在就绪前退出`);
      return await get(port, credentials, ready ? "/readyz" : "/healthz").then((res) => res.status === 200).catch(() => false);
    }, `${name} TLS ready`);
    return { name, port, pid, credentials, backend };
  }
  async function retire(name, pid) {
    const status = await control("retire", { generation: name });
    assert(!status.generations.some((item) => item.name === name));
    if (pid) await until(() => !alive(pid), `${name} 托管进程退出`);
  }
  async function drained(name) {
    try {
      await until(async () => (await control("status")).generations.find((item) => item.name === name)?.connections === 0,
        `${name} 双端连接排空`);
    } catch (error) {
      const status = await control("status");
      console.error(`排空状态 ${JSON.stringify({ active: status.active, generations: status.generations.map(({ name, state, connections, process }) => ({ name, state, connections, process })) })}`);
      throw error;
    }
  }

  async function run() {
    console.log(`真实升级验收 host=${os.hostname()} node=${process.version} deadline=${TOTAL_MS}ms`);
    const credentialsMain = credentials("upgrade");
    const credentialsTarget = credentials("relay-target");
    const externalPort = await freePort("0.0.0.0");
    supervisor = createSupervisor({ host: "0.0.0.0", port: externalPort, controlPath, readinessTimeout: 1500 });
    await supervisor.listen();
    assert.equal(fs.statSync(controlPath).mode & 0o777, 0o600);
    const target = await start("relay-target", "relay-target", credentialsTarget);
    let active = await start("v1", "v1", credentialsMain);
    await control("promote", { generation: "v1" });
    await fresh("v1", externalPort, credentialsMain);
    console.log(`PASS TLS 外部入口 0.0.0.0:${externalPort}，客户端/后端 127.0.0.1，Unix socket 0600`);

    // 三种失败均使用真实托管 daemon / spawn，失败后检查状态及新连接的执行结果。
    const badReady = await start("not-ready", "not-ready", credentialsMain, false);
    assert.equal((await get(badReady.port, credentialsMain)).status, 404);
    await assert.rejects(control("promote", { generation: badReady.name }), /404/);
    assert.equal((await control("status")).active, "v1");
    await fresh("v1", externalPort, credentialsMain);
    await retire(badReady.name, badReady.pid);
    const untrusted = await start("untrusted", "untrusted", credentialsTarget);
    // 相同真实 daemon，但 promote 时不提供其信任 CA。
    await control("register", { generation: "bad-tls", backend: { host: "127.0.0.1", port: untrusted.port, protocol: "https" } });
    await assert.rejects(control("promote", { generation: "bad-tls" }), /self.signed|certificate|cert/i);
    assert.equal((await control("status")).active, "v1");
    await fresh("v1", externalPort, credentialsMain);
    await retire("bad-tls");
    await retire(untrusted.name, untrusted.pid);
    const failedPort = await freePort("127.0.0.1");
    await control("start", { generation: "spawn-failed", command: [path.join(dir, "missing-executable")],
      backend: { host: "127.0.0.1", port: failedPort, protocol: "https", ca: credentialsMain.ca } });
    await until(async () => Boolean((await control("status")).generations.find((item) => item.name === "spawn-failed").startError), "spawn ENOENT");
    await assert.rejects(control("promote", { generation: "spawn-failed" }), /启动失败/);
    assert.equal((await control("status")).active, "v1");
    await fresh("v1", externalPort, credentialsMain);
    await retire("spawn-failed");
    console.log("PASS ready=404 / TLS 不受信任 / spawn ENOENT 均保持 active=v1 且新连接可执行");

    // 16MiB 超过 TCP 缓冲容量，暂停下载读取，直到切换后再继续。
    const payload = crypto.randomBytes(16 * 1024 * 1024);
    const expectedHash = sha256(payload);
    const downloadFile = path.join(dir, "download.bin");
    fs.writeFileSync(downloadFile, payload);
    for (const nextLabel of ["v2", "v3"]) {
      const old = active;
      const next = await start(nextLabel, nextLabel, credentialsMain);
      const gate = path.join(dir, `${old.name}-gate`);
      const marker = path.join(dir, `${old.name}-exec-started`);
      const ordinary = await connect(externalPort, credentialsMain);
      const streaming = await connect(externalPort, credentialsMain);
      const relay = await connect(externalPort, credentialsMain);
      let downloadResponse;
      const uploadReady = deferred();
      const downloadReady = deferred();
      const streamReady = deferred();
      const relayReady = deferred();
      const transferGate = deferred();
      let uploadBytes = 0;
      let downloadedBytes = 0;
      let newConnections = 0;
      let probing = true;
      let probeError;
      // 串行建立独立 TLS/WSS 新连接，覆盖切换前、切换中及切换后。
      const probeLoop = (async () => {
        while (probing) {
          const client = await connect(externalPort, credentialsMain);
          try {
            const result = await client.call("exec", { command: labelCommand, timeoutMs: 3000 });
            assert.equal(result.exitCode, 0);
            assert([old.name, nextLabel].includes(Buffer.from(result.stdoutB64, "base64").toString()));
            newConnections += 1;
          } finally { await client.close(); }
          await delay(20);
        }
      })().catch((error) => { probeError = error; });
      const command = (stream, labelMarker) => {
        const code = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(labelMarker)},String(process.pid));` +
          (stream ? `process.stdout.write(process.env.RELEASE_LABEL+':begin\\n');` : "") +
          `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);` +
          `process.stdout.write(process.env.RELEASE_LABEL+':end\\n');process.stderr.write('stderr-ok\\n');}},20);`;
        return `${quote(process.execPath)} -e ${quote(code)}`;
      };
      const streamChunks = { stdout: [], stderr: [] };
      const relayChunks = { stdout: [], stderr: [] };
      const collect = (chunks, ready) => (event) => {
        assert.equal(event.event, "output");
        chunks[event.stream].push(Buffer.from(event.dataB64, "base64"));
        if (event.stream === "stdout") ready.resolve();
      };
      const normalDone = ordinary.call("exec", { command: command(false, marker), timeoutMs: 15000 });
      const streamDone = streaming.call("exec.stream", {
        command: command(true, path.join(dir, `${old.name}-stream-started`)), timeoutMs: 15000,
      }, collect(streamChunks, streamReady));
      const relayDone = relay.call("relay", {
        target: { host: "127.0.0.1", port: target.port },
        auth: { token: credentialsTarget.token, ca: credentialsTarget.ca },
        request: { method: "exec.stream", params: {
          command: command(true, path.join(dir, `${old.name}-relay-started`)), timeoutMs: 15000,
        } },
      }, collect(relayChunks, relayReady));
      const uploadFile = path.join(dir, `${old.name}-uploaded.bin`);
      const up = request(externalPort, credentialsMain, "POST", `/upload?path=${encodeURIComponent(uploadFile)}`,
        { "Content-Length": payload.length });
      const uploadDone = bounded(new Promise((resolve, reject) => {
        up.once("error", reject);
        up.once("response", (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.once("error", reject);
          res.once("aborted", () => reject(new Error("上传响应中断")));
          res.once("end", () => {
            try { assert.equal(res.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks))); }
            catch (error) { reject(error); }
          });
        });
        up.once("socket", (socket) => socket.once("secureConnect", () => {
          (async () => {
            const size = 64 * 1024;
            for (let offset = 0; offset < payload.length; offset += size) {
              check();
              await new Promise((resolveWrite, rejectWrite) => up.write(payload.subarray(offset, offset + size),
                (error) => error ? rejectWrite(error) : resolveWrite()));
              uploadBytes = Math.min(offset + size, payload.length);
              if (offset === 0) { uploadReady.resolve(); await transferGate.promise; }
              await delay(2);
            }
            up.end();
          })().catch((error) => { up.destroy(error); reject(error); });
        }));
      }), "慢上传", 20000).finally(() => up.destroy());
      uploadDone.catch(() => {});
      const down = request(externalPort, credentialsMain, "GET", `/download?path=${encodeURIComponent(downloadFile)}`);
      const downloadDone = bounded(new Promise((resolve, reject) => {
        down.once("error", reject);
        down.once("response", (res) => {
          downloadResponse = res;
          const hash = crypto.createHash("sha256");
          let first = true;
          res.on("data", (chunk) => {
            hash.update(chunk);
            downloadedBytes += chunk.length;
            if (first) { first = false; res.pause(); downloadReady.resolve(); }
            else {
              res.pause();
              delay(2).then(() => { if (!stopped) res.resume(); });
            }
          });
          res.once("error", reject);
          res.once("aborted", () => reject(new Error("下载响应中断")));
          res.once("end", () => {
            try {
              assert.equal(res.statusCode, 200);
              assert.equal(Number(res.headers["content-length"]), payload.length);
              resolve(hash.digest("hex"));
            } catch (error) { reject(error); }
          });
        });
        down.end();
      }), "慢下载", 20000).finally(() => down.destroy());
      downloadDone.catch(() => {});
      try {
        await bounded(Promise.all([streamReady.promise, relayReady.promise, uploadReady.promise, downloadReady.promise]), "在途屏障");
        await until(() => fs.existsSync(marker) && newConnections >= 2, "普通长命令已开始且新连接持续成功");
        assert(uploadBytes > 0 && uploadBytes < payload.length);
        assert(downloadedBytes > 0 && downloadedBytes < payload.length);
        assert(!fs.existsSync(gate));
        const before = await control("status");
        assert.equal(before.active, old.name);
        assert(before.generations.find((item) => item.name === old.name).connections >= 5);
        const probeBefore = newConnections;
        await control("promote", { generation: nextLabel });
        assert.equal((await control("status")).active, nextLabel);
        await fresh(nextLabel, externalPort, credentialsMain);
        await assert.rejects(control("retire", { generation: nextLabel }), /active/);
        await assert.rejects(control("retire", { generation: old.name }), /活动连接/);
        console.log(`PASS ${old.name}->${nextLabel} 切换时 exec / exec.stream / relay.stream / 上传 ${uploadBytes}/${payload.length} / 下载 ${downloadedBytes}/${payload.length} 均在途`);
        fs.writeFileSync(gate, "continue");
        transferGate.resolve();
        downloadResponse.resume();
        const [normalResult, streamResult, relayResult, uploaded, downloaded] = await Promise.all([
          normalDone, streamDone, relayDone, uploadDone, downloadDone,
        ]);
        assert.equal(normalResult.exitCode, 0);
        assert.equal(normalResult.truncated, false);
        assert.equal(Buffer.from(normalResult.stdoutB64, "base64").toString(), `${old.name}:end\n`);
        assert.equal(Buffer.from(normalResult.stderrB64, "base64").toString(), "stderr-ok\n");
        for (const [label, result, chunks] of [[old.name, streamResult, streamChunks],
          ["relay-target", relayResult.result, relayChunks]]) {
          assert.equal(result.exitCode, 0);
          assert.equal(result.reason, "exited");
          assert.equal(Buffer.concat(chunks.stdout).toString(), `${label}:begin\n${label}:end\n`);
          assert.equal(Buffer.concat(chunks.stderr).toString(), "stderr-ok\n");
          assert.equal(result.stdoutBytes, Buffer.concat(chunks.stdout).length);
          assert.equal(result.stderrBytes, Buffer.concat(chunks.stderr).length);
        }
        assert.equal(relayResult.relayed, true);
        assert.equal(relayResult.error, null);
        assert.equal(uploaded.size, payload.length);
        assert.equal(uploaded.sha256, expectedHash);
        assert.equal(sha256(fs.readFileSync(uploadFile)), expectedHash);
        assert.equal(downloadedBytes, payload.length);
        assert.equal(downloaded, expectedHash);
        await until(() => newConnections > probeBefore, "切换后持续新连接成功");
        console.log(`PASS ${old.name}->${nextLabel} 全部命令完整终态，上传/下载 16MiB SHA256=${expectedHash}`);
        await Promise.all([ordinary.close(), streaming.close(), relay.close()]);
        probing = false;
        await bounded(probeLoop, "持续连接探测结束");
        if (probeError) throw probeError;
        await drained(old.name);
        // 排空仍保留旧进程：此时回滚窗口开放，实际回滚并验证新连接。
        const retained = (await control("status")).generations.find((item) => item.name === old.name);
        assert.equal(retained.state, "draining");
        assert.equal(retained.connections, 0);
        assert(alive(old.pid));
        await control("rollback");
        assert.equal((await control("status")).active, old.name);
        await fresh(old.name, externalPort, credentialsMain);
        await control("promote", { generation: nextLabel });
        await fresh(nextLabel, externalPort, credentialsMain);
        await drained(old.name);
        // 明确结束本轮回滚窗口，然后允许 retire。
        await retire(old.name, old.pid);
        await assert.rejects(control("rollback"), /上一版本/);
        assert.equal((await control("status")).active, nextLabel);
        await fresh(nextLabel, externalPort, credentialsMain);
        active = next;
        console.log(`PASS ${old.name}->${nextLabel} ${newConnections} 次持续新连接，排空后回滚新连接=${old.name}，窗口关闭 retire 后 PID ${old.pid} 已退出`);
      } finally {
        probing = false;
        transferGate.resolve();
        fs.writeFileSync(gate, "cleanup");
        downloadResponse?.destroy();
        up.destroy();
        down.destroy();
        await Promise.all([ordinary.close(), streaming.close(), relay.close()]);
        await bounded(probeLoop, "探测清理", 2000).catch(() => {});
        await Promise.allSettled([normalDone, streamDone, relayDone, uploadDone, downloadDone]);
      }
    }
    await retire(target.name, target.pid);
    assert.equal((await control("status")).active, "v3");
    await supervisor.close();
    await until(() => [...pids].every((pid) => !alive(pid)), "supervisor.close 托管子进程退出");
    assert(!fs.existsSync(controlPath));
    for (const port of [externalPort, active.port, target.port]) {
      const server = net.createServer();
      try {
        await bounded(new Promise((resolve, reject) => {
          server.once("error", reject); server.listen(port, "127.0.0.1", resolve);
        }), `退出后端口 ${port} 可复用`);
      } finally { if (server.listening) await new Promise((resolve) => server.close(resolve)); }
    }
    console.log(`PASS supervisor.close，全部 ${pids.size} 个托管 PID 无残留，Unix socket 删除，入口/后端端口可复用`);
  }

  let failure;
  try {
    await Promise.race([run(), new Promise((_, reject) => {
      deadline = setTimeout(() => { stopped = true; reject(new Error(`套件总截止时间 ${TOTAL_MS}ms`)); }, TOTAL_MS);
    })]);
  } catch (error) {
    failure = error;
    for (const log of childLogs) {
      if (fs.existsSync(log)) console.error(`daemon ${path.basename(log)}:\n${fs.readFileSync(log, "utf8").slice(-1200)}`);
    }
  } finally {
    clearTimeout(deadline);
    stopped = true;
    for (const ws of clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    if (supervisor) await bounded(supervisor.close(), "supervisor finally 清理", 3000).catch((error) => { failure ||= error; });
    for (const pid of pids) {
      if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") failure ||= error; } }
    }
    const end = Date.now() + 3000;
    while ([...pids].some(alive) && Date.now() < end) await delay(25);
    for (const pid of pids) {
      if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") failure ||= error; } }
    }
    const killEnd = Date.now() + 2000;
    while ([...pids].some(alive) && Date.now() < killEnd) await delay(25);
    if ([...pids].some(alive)) failure ||= new Error("finally 后托管进程仍存在");
    fs.rmSync(dir, { recursive: true, force: true });
    if (![...pids].some(alive) && !fs.existsSync(dir)) {
      console.log(`PASS finally 清理：${pids.size} 个托管 PID 已退出，临时证书/文件/Unix socket 已删除`);
    }
  }
  if (failure) throw failure;
  console.log("PASS 连续两轮 v1->v2->v3 真实 TLS 升级验收完成，临时文件全部清理");
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
