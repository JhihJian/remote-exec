"use strict";

const readline = require("readline");

function cancelled() { return Object.assign(new Error("操作已取消"), { code: "ABORT_ERR" }); }
function requireTty(input, output) {
  if (!input.isTTY || !output.isTTY) throw new Error("此操作需要交互终端，请在 TTY 中运行");
}

function yes(message, { input = process.stdin, output = process.stderr } = {}) {
  requireTty(input, output);
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output });
    let done = false;
    rl.on("SIGINT", () => { done = true; rl.close(); reject(cancelled()); });
    rl.on("close", () => { if (!done) reject(cancelled()); });
    rl.question(`${message} [y/N] `, (answer) => {
      done = true;
      rl.close();
      resolve(/^(y|yes)$/i.test(answer.trim()));
    });
  });
}

function secret(message, { input = process.stdin, output = process.stderr } = {}) {
  requireTty(input, output);
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = input.isPaused();
    let value = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      if (err) reject(err); else resolve(value);
      value = "";
    };
    const onEnd = () => finish(cancelled());
    const onError = (err) => finish(err);
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") return finish(cancelled());
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (char >= " " && char !== "\u001b") value += char;
      }
    };
    output.write(`${message}: `);
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}

module.exports = { yes, secret };
