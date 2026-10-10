"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function loadConfig() {
  const configPath = path.join(os.homedir(), ".config", "remote-exec", "hosts.json");
  if (!fs.existsSync(configPath)) throw new Error(`配置不存在: ${configPath}`);
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

module.exports = { loadConfig };