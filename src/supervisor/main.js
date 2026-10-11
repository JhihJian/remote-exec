#!/usr/bin/env node
"use strict";

const { createSupervisor } = require("./supervisor.js");

function parseArgs(argv) {
  const options = { host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} 需要一个值`);
      return argv[++i];
    };
    if (arg === "--host") options.host = next();
    else if (arg === "--port") options.port = Number(next());
    else if (arg === "--control") options.controlPath = next();
    else if (arg === "--old-host") options.oldBackend = { ...(options.oldBackend || {}), host: next() };
    else if (arg === "--old-port") options.oldBackend = { ...(options.oldBackend || {}), port: Number(next()) };
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function usage() {
  console.log("用法: node src/supervisor/main.js --port <固定TCP端口> --control <Unix socket> [--old-host host --old-port port]");
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { usage(); return null; }
  const supervisor = createSupervisor(options);
  await supervisor.listen();
  const shutdown = () => supervisor.close().then(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return supervisor;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { main, parseArgs };
