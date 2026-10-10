#!/usr/bin/env node
"use strict";
/**
 * remote-exec 极简 TUI：交互式远程命令执行。
 * 用法: node src/tui/app.js [主机名]     （不带参数则交互选择）
 * 会话命令: :host [名]  :cd 目录  :timeout 秒  :hosts  :q
 * 普通输入按 bash 命令在远端执行（cwd 跟随提示符），支持直连与 relay(via) 主机。
 */
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { loadConfig, callHost, callHostStream } = require("../client/index.js");

const args = process.argv.slice(2);
const state = { host: null, cwd: "/root", timeoutMs: 300000 };

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const prompt = () => `${cyan(`[${state.host}:${state.cwd}]`)}$ `;

/** 列出全部主机并并行探测连通延迟 */
async function listHosts() {
  const hosts = loadConfig().hosts;
  const entries = Object.entries(hosts);
  console.log(`可连接主机（${entries.length} 台）：`);
  const rows = await Promise.all(entries.map(async ([name, h]) => {
    const via = h.via ? `经 ${h.via} relay` : "直连";
    const t0 = Date.now();
    try {
      await callHost(name, "exec", { command: "true", timeoutMs: 8000 });
      return { name, addr: `${h.host}:${h.port}`, via, ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { name, addr: `${h.host}:${h.port}`, via, ok: false, err: e.message.slice(0, 60) };
    }
  }));
  for (const r of rows) {
    const status = r.ok ? green(`✓ ${r.ms}ms`) : red(`✗ ${r.err}`);
    console.log(`  ${cyan(r.name.padEnd(8))} ${dim(r.addr.padEnd(22))} ${dim(r.via.padEnd(14))} ${status}`);
  }
}

const PWD_MARK = "\x01PWD\x02"; // 控制字符包裹，避免与正常输出混淆
let currentAbort = null; // 执行中命令的中断句柄（Ctrl+C 触发）

function interruptible(promise, onAbort) {
  return new Promise((resolve, reject) => {
    const abort = () => { currentAbort = null; onAbort(); };
    currentAbort = abort;
    promise.then(
      (v) => { if (currentAbort === abort) currentAbort = null; resolve(v); },
      (e) => { if (currentAbort === abort) currentAbort = null; reject(e); },
    );
  });
}
const INTERRUPTED = Symbol("interrupted");

async function runCommand(line) {
  const t0 = Date.now();
  // 尾部追加 PWD 回传：裸 cd / 复合命令改目录后提示符自动跟随
  const wrapped = `${line}\nprintf '${PWD_MARK}%s' "$PWD"`;
  let r;
  try {
    r = await interruptible(
      callHost(state.host, "exec", {
        command: wrapped, cwd: state.cwd, timeoutMs: state.timeoutMs,
      }, (abort) => {
        // Ctrl+C：断开连接，服务端检测断连终止远端子进程
        interruptible.abortNow = abort;
      }),
      () => interruptible.abortNow && interruptible.abortNow(),
    );
  } catch (e) {
    if (currentAbort === null && /连接已中断/.test(e.message)) throw INTERRUPTED;
    throw e;
  }
  interruptible.abortNow = null;
  const dt = Date.now() - t0;
  let out = Buffer.from(r.stdoutB64, "base64");
  const err = Buffer.from(r.stderrB64, "base64");
  // 从 stdout 提取 PWD 标记并同步提示符
  const s = out.toString("utf8");
  const mi = s.lastIndexOf(PWD_MARK);
  if (mi >= 0) {
    const np = s.slice(mi + PWD_MARK.length).split("\n")[0].trim();
    if (np) state.cwd = np;
    out = Buffer.from(s.slice(0, mi), "utf8");
  }
  // 二进制检测：含 NUL 字节则 hex 预览
  if (out.includes(0)) {
    console.log(dim(`(stdout 含二进制，预览前 256 字节 hex)`));
    console.log(out.subarray(0, 256).toString("hex").replace(/(..)/g, "$1 ").trim());
  } else if (out.length) {
    process.stdout.write(out.toString("utf8").endsWith("\n") ? out.toString("utf8") : out.toString("utf8") + "\n");
  }
  if (err.length) {
    const et = err.toString("utf8");
    process.stdout.write(red(et.endsWith("\n") ? et : et + "\n"));
  }
  const parts = [`exit=${r.exitCode}`, `${(dt / 1000).toFixed(dt < 1000 ? 2 : 1)}s`];
  if (r.truncated) parts.push(dim("输出已截断"));
  if (r.exitCode === 124) parts.push(dim("超时被杀"));
  console.log(dim(`-- ${parts.join(" ")}`));
  return r.exitCode;
}

async function runFollowCommand(command) {
  const t0 = Date.now();
  let wroteOutput = false;
  let endedWithNewline = true;
  let r;
  try {
    r = await interruptible(
      callHostStream(
        state.host,
        "exec.stream",
        { command, cwd: state.cwd, timeoutMs: state.timeoutMs },
        (event) => {
          const data = Buffer.from(event.dataB64, "base64");
          wroteOutput = wroteOutput || data.length > 0;
          if (data.length) endedWithNewline = data[data.length - 1] === 0x0a;
          if (event.stream === "stderr") {
            process.stdout.write("\x1b[31m");
            process.stdout.write(data);
            process.stdout.write("\x1b[0m");
          } else process.stdout.write(data);
        },
        (abort) => { interruptible.abortNow = abort; },
      ),
      () => interruptible.abortNow && interruptible.abortNow(),
    );
  } catch (e) {
    if (currentAbort === null && /连接已中断/.test(e.message)) throw INTERRUPTED;
    throw e;
  }
  interruptible.abortNow = null;
  if (wroteOutput && !endedWithNewline) process.stdout.write("\n");
  const dt = Date.now() - t0;
  const parts = [`exit=${r.exitCode}`, `${(dt / 1000).toFixed(dt < 1000 ? 2 : 1)}s`, r.reason];
  if (r.reason === "timeout") parts.push("超时被杀");
  console.log(dim(`-- ${parts.join(" ")}`));
  return r.exitCode;
}

async function handleSessionCmd(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  const hosts = loadConfig().hosts;
  switch (cmd) {
    case "q": case "quit": case "exit":
      return "quit";
    case "h": case "help":
      console.log(`命令直接回车即在远端执行。会话命令:
  :host [名]   列出/切换主机（relay 主机自动经网关）
  :cd 目录      切换工作目录
  :timeout 秒   设置单命令超时（当前 ${state.timeoutMs / 1000}s）
  :flow 命令    实时显示持续输出（Ctrl+C 停止）
  :hosts       列出全部主机
  :q           退出`);
      return "ok";
    case "hosts":
      Object.entries(hosts).forEach(([n, h]) => {
        const via = h.via ? dim(`（经 ${h.via} relay）`) : "";
        console.log(`  ${n === state.host ? cyan(n) : n} ${dim(`${h.host}:${h.port}`)}${via}`);
      });
      return "ok";
    case "host": {
      if (!arg) return "hosts";
      if (!hosts[arg]) { console.log(red(`未知主机 ${arg}，可用: ${Object.keys(hosts).join(", ")}`)); return "ok"; }
      // 连通性验证 + 取真实 cwd
      try {
        const r = await callHost(arg, "exec", { command: "pwd", cwd: hosts[arg].cwd || "/root", timeoutMs: 15000 });
        state.host = arg;
        state.cwd = Buffer.from(r.stdoutB64, "base64").toString().trim() || "/root";
        console.log(dim(`已连接 ${arg}（${hosts[arg].host}:${hosts[arg].port}${hosts[arg].via ? `，经 ${hosts[arg].via} relay` : ""}）`));
      } catch (e) {
        console.log(red(`连接 ${arg} 失败: ${e.message}`));
      }
      return "ok";
    }
    case "cd": {
      if (!arg) { state.cwd = "/root"; return "ok"; }
      const r = await callHost(state.host, "exec", { command: `cd ${JSON.stringify(arg)} && pwd`, cwd: state.cwd, timeoutMs: 15000 });
      if (r.exitCode !== 0) {
        console.log(red(Buffer.from(r.stderrB64, "base64").toString("utf8").trim() || `cd 失败 exit=${r.exitCode}`));
      } else {
        state.cwd = Buffer.from(r.stdoutB64, "base64").toString().trim();
      }
      return "ok";
    }
    case "timeout": {
      const s = parseInt(arg, 10);
      if (!s || s < 1) { console.log(red("用法: :timeout 秒")); return "ok"; }
      state.timeoutMs = s * 1000;
      console.log(dim(`超时已设为 ${s}s`));
      return "ok";
    }
    case "flow":
      if (!arg) { console.log(red("用法: :flow <命令>")); return "ok"; }
      await runFollowCommand(arg);
      return "ok";
    default:
      console.log(red(`未知会话命令 :${cmd}，:h 查看帮助`));
      return "ok";
  }
}

async function main() {
  if (args[0] === "--list" || args[0] === "hosts" || args[0] === "-l") {
    await listHosts();
    return;
  }
  const hosts = loadConfig().hosts;
  const names = Object.keys(hosts);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let picking = !args[0]; // 无参数时第一行输入作为主机选择
  let name = args[0];
  if (args[0] && !hosts[args[0]]) { console.log(red(`未知主机 ${args[0]}，可用: ${names.join(", ")}`)); process.exit(1); }
  if (picking) {
    console.log("可用主机:");
    names.forEach((n, i) => {
      const h = hosts[n];
      const via = h.via ? dim(`（经 ${h.via} relay）`) : "";
      console.log(`  ${i + 1}. ${n} ${dim(`${h.host}:${h.port}`)}${via}`);
    });
    stdout.write("选择序号或主机名（默认 1）: ");
  } else {
    state.host = name;
    state.cwd = hosts[name].cwd || "/root";
    console.log(`remote-exec TUI → ${name} ${dim(`${hosts[name].host}:${hosts[name].port}${hosts[name].via ? `（经 ${hosts[name].via} relay）` : ""}，:h 帮助，:q 退出`)}`);
  }

  let closed = false;
  rl.on("SIGINT", () => {
    if (currentAbort) {
      console.log(red(`^C 已中断（远端进程已终止）`));
      currentAbort();
    } else {
      rl.close(); // 空闲时 Ctrl+C 退出会话
    }
  });
  rl.on("close", () => { closed = true; });
  for await (const line of rl) {
    const t = line.trim();
    if (picking) {
      picking = false;
      let n;
      if (!t) n = names[0];
      else if (hosts[t]) n = t;
      else if (/^\d+$/.test(t) && names[parseInt(t, 10) - 1]) n = names[parseInt(t, 10) - 1];
      if (!n) { console.log(red("无效选择")); process.exit(1); }
      state.host = n;
      state.cwd = hosts[n].cwd || "/root";
      console.log(`remote-exec TUI → ${n} ${dim(`${hosts[n].host}:${hosts[n].port}${hosts[n].via ? `（经 ${hosts[n].via} relay）` : ""}，:h 帮助，:q 退出`)}`);
      rl.setPrompt(prompt());
      rl.prompt();
      continue;
    }
    if (!t) { if (!closed) rl.prompt(); continue; }
    try {
      if (t.startsWith(":")) {
        const r = await handleSessionCmd(t);
        if (r === "quit") { rl.close(); return; }
        if (r === "hosts") await handleSessionCmd(":hosts");
      } else {
        await runCommand(t);
      }
    } catch (e) {
      if (e === INTERRUPTED) { /* 已打印中断提示 */ }
      else console.log(red(`错误: ${e.message}`));
    }
    if (!closed) { rl.setPrompt(prompt()); rl.prompt(); }
  }
  stdout.write("\n");
  process.exit(0); // EOF / Ctrl+D 自然退出（命令处理完才到这里）
}

main().catch((e) => { console.error(red(`启动失败: ${e.message}`)); process.exit(1); });
