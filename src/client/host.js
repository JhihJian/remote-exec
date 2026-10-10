"use strict";

const fs = require("fs");
const { loadConfig } = require("./config.js");
const { WssClient } = require("./websocket.js");

function getHost(config, hostName) {
  const hosts = config?.hosts;
  const host = hosts?.[hostName];
  if (!host) {
    const available = hosts ? Object.keys(hosts).join(", ") : "（配置不存在或为空）";
    throw new Error(`未知主机 "${hostName}"，可用主机: ${available}`);
  }
  return { hosts, host };
}

function createClient(host) {
  return new WssClient({ host: host.host, port: host.port, servername: host.servername, ca: host.ca });
}

async function callHost(hostName, method, params, onAbort) {
  const config = loadConfig();
  const { hosts, host } = getHost(config, hostName);
  const targetToken = fs.readFileSync(host.tokenFile, "utf8").trim();
  if (!host.via) {
    const client = createClient(host);
    if (onAbort) onAbort(() => client.abort());
    try {
      await client.connectToken(targetToken);
      return await client.call(method, params);
    } finally { client.close(); }
  }

  const gateway = hosts[host.via];
  if (!gateway) throw new Error(`主机 "${hostName}" 的 via 网关 "${host.via}" 不在配置中`);
  if (gateway.via) throw new Error("via 链深度仅支持 1，不支持链式转发");
  const client = createClient(gateway);
  if (onAbort) onAbort(() => client.abort());
  try {
    await client.connectToken(fs.readFileSync(gateway.tokenFile, "utf8").trim());
    const envelope = await client.call("relay", {
      target: { host: host.host, port: host.port },
      auth: { token: targetToken, ca: fs.readFileSync(host.ca, "utf8") },
      request: { method, params },
    });
    if (envelope.error) throw new Error(`目标返回错误 rpc ${envelope.error.code}: ${envelope.error.message}`);
    return envelope.result;
  } finally { client.close(); }
}

async function callHostStream(hostName, method, params, onEvent, onAbort) {
  const config = loadConfig();
  const { hosts, host } = getHost(config, hostName);
  const targetToken = fs.readFileSync(host.tokenFile, "utf8").trim();
  if (!host.via) {
    const client = createClient(host);
    if (onAbort) onAbort(() => client.abort());
    try {
      await client.connectToken(targetToken);
      return await client.callStream(method, params, onEvent);
    } finally { client.close(); }
  }

  const gateway = hosts[host.via];
  if (!gateway) throw new Error(`主机 "${hostName}" 的 via 网关 "${host.via}" 不在配置中`);
  if (gateway.via) throw new Error("via 链深度仅支持 1，不支持链式转发");
  const client = createClient(gateway);
  if (onAbort) onAbort(() => client.abort());
  try {
    await client.connectToken(fs.readFileSync(gateway.tokenFile, "utf8").trim());
    const envelope = await client.callStream("relay", {
      target: { host: host.host, port: host.port },
      auth: { token: targetToken, ca: fs.readFileSync(host.ca, "utf8") },
      request: { method, params },
    }, onEvent);
    if (envelope.error) throw new Error(`目标返回错误 rpc ${envelope.error.code}: ${envelope.error.message}`);
    return envelope.result;
  } finally { client.close(); }
}

module.exports = { callHost, callHostStream };