"use strict";

const { WebSocket } = require("ws");
const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RELAY_ALLOW,
  RELAY_CONNECT_BUDGET_MS,
  RELAY_INNER_METHODS,
  RELAY_MAX_CONCURRENT,
  RELAY_MAX_INNER_TIMEOUT_MS,
  RELAY_MAX_TOTAL_TIMEOUT_MS,
  RELAY_SLACK_MS,
  STREAM_SEND_STALL_MS,
} = require("../shared/constants.js");
const { log } = require("../shared/log.js");
const { rpcError } = require("../shared/rpc-error.js");

function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInCidr(ip, cidr) {
  const slash = cidr.indexOf("/");
  const base = slash < 0 ? cidr : cidr.slice(0, slash);
  const prefix = slash < 0 ? 32 : Number(cidr.slice(slash + 1));
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null || !(prefix >= 0 && prefix <= 32)) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function relayAllowedByTarget(host, allowList) {
  return allowList.some((cidr) => ipInCidr(host, cidr));
}

function relayErr(code, message, stage) {
  const err = rpcError(code, message);
  err.data = { stage };
  return err;
}

function createRelayHandler(relayAllow = DEFAULT_RELAY_ALLOW) {
  let activeRelays = 0;

  return function relayRequest(params, ctx, onCancel) {
    const { target, auth, request } = params || {};
    if (
      !target || typeof target.host !== "string" || typeof target.port !== "number" ||
      !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 ||
      !auth || typeof auth.token !== "string" || !auth.token ||
      typeof auth.ca !== "string" || !auth.ca.includes("BEGIN CERTIFICATE") ||
      !request || typeof request.method !== "string"
    ) {
      throw relayErr(
        -32015,
        "params 需要 {target:{host,port}, auth:{token,ca}, request:{method,params}}，auth.ca 必须是目标 CA 的 PEM 文本",
        "validate",
      );
    }
    if (ipv4ToInt(target.host) === null) {
      throw relayErr(-32015, `target.host 必须是 IPv4 字面量（拒绝 DNS 名，防解析绕过白名单）: ${target.host}`, "validate");
    }
    if (!relayAllowedByTarget(target.host, relayAllow)) {
      throw relayErr(-32010, `目标 ${target.host} 不在 relay 白名单（--relay-allow）内`, "allowlist");
    }
    if (!RELAY_INNER_METHODS.has(request.method)) {
      throw relayErr(-32015, `relay 仅支持转发 ${[...RELAY_INNER_METHODS].join("/")}，禁止嵌套 relay`, "validate");
    }
    if (activeRelays >= RELAY_MAX_CONCURRENT) {
      throw relayErr(-32015, `relay 并发已达上限（${RELAY_MAX_CONCURRENT}），请稍后重试`, "validate");
    }

    const innerParams = { ...(request.params || {}) };
    if (innerParams.timeoutMs !== undefined) {
      innerParams.timeoutMs = Math.min(Math.max(1, Number(innerParams.timeoutMs) || 0), RELAY_MAX_INNER_TIMEOUT_MS);
    }
    const innerBudget = Math.min(innerParams.timeoutMs || DEFAULT_TIMEOUT_MS, RELAY_MAX_INNER_TIMEOUT_MS);
    const totalTimeout = Math.min(
      Number(params.timeoutMs) || RELAY_CONNECT_BUDGET_MS + innerBudget + RELAY_SLACK_MS,
      RELAY_MAX_TOTAL_TIMEOUT_MS,
    );

    activeRelays += 1;
    const peer = `${target.host}:${target.port}`;
    const t0 = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      let terminalReceived = false;
      let targetPaused = false;
      let forwardChain = Promise.resolve();
      const ws = new WebSocket(`wss://${peer}/`, {
        ca: auth.ca,
        rejectUnauthorized: true,
        headers: { authorization: `Bearer ${auth.token}` },
        handshakeTimeout: RELAY_CONNECT_BUDGET_MS,
      });
      const unregisterCancel = onCancel
        ? onCancel(() => settle(relayErr(-32014, `上游客户端断开: ${peer}`, "aborted")))
        : () => {};
      const timer = setTimeout(() => {
        settle(relayErr(-32014, `relay 总超时（${totalTimeout}ms）: ${peer}`, "deadline"));
      }, totalTimeout);
      const finish = () => {
        clearTimeout(timer);
        activeRelays -= 1;
        unregisterCancel();
        try { ws.terminate(); } catch {}
      };
      const settle = (err, value) => {
        if (settled) return;
        settled = true;
        finish();
        log(err ? "relay.fail" : "relay", `${peer} ${request.method} ${err ? err.message : "ok"} ${Date.now() - t0}ms`);
        if (err) resolve(Promise.reject(err));
        else resolve(value);
      };
      const forwardEvent = (event) => new Promise((resolveForward, rejectForward) => {
        const timerId = setTimeout(() => rejectForward(new Error("relay 流式输出发送停滞")), STREAM_SEND_STALL_MS);
        ctx.emitEvent(event).then(
          () => { clearTimeout(timerId); resolveForward(); },
          (err) => { clearTimeout(timerId); rejectForward(err); },
        );
      });
      ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: request.method, params: innerParams })));
      ws.on("message", (data) => {
        let msg;
        try { msg = JSON.parse(data.toString("utf8")); }
        catch { settle(relayErr(-32015, "目标返回非 JSON 响应", "validate")); return; }
        if (msg.id !== 1) { settle(relayErr(-32015, "目标响应 id 不匹配", "validate")); return; }
        if (msg.event) {
          if (request.method !== "exec.stream" || msg.event !== "output" ||
            (msg.stream !== "stdout" && msg.stream !== "stderr") || typeof msg.dataB64 !== "string") {
            settle(relayErr(-32015, "目标发送了无效流式事件", "validate"));
            return;
          }
          if (!targetPaused) { targetPaused = true; ws.pause(); }
          forwardChain = forwardChain
            .then(() => { if (settled) return; return forwardEvent({ event: "output", stream: msg.stream, dataB64: msg.dataB64 }); })
            .catch(() => settle(relayErr(-32014, `上游连接已断开: ${peer}`, "aborted")));
          const thisChain = forwardChain;
          thisChain.then(() => {
            if (thisChain === forwardChain && targetPaused && !settled) { targetPaused = false; ws.resume(); }
          });
          return;
        }
        if (terminalReceived) return;
        terminalReceived = true;
        forwardChain.then(() => settle(null, { relayed: true, result: msg.result ?? null, error: msg.error ?? null }));
      });
      ws.on("unexpected-response", (_req, res) => {
        if (res.statusCode === 401) settle(relayErr(-32013, `目标认证失败（token 不匹配）: ${peer}`, "auth"));
        else settle(relayErr(-32011, `目标拒绝升级（HTTP ${res.statusCode}）: ${peer}`, "connect"));
      });
      ws.on("error", (err) => {
        const code = err.code || "";
        const msg = String(err.message || err);
        if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"].includes(code)) {
          settle(relayErr(-32011, `目标不可达: ${msg}`, "connect"));
        } else if (code.includes("TLS") || code.includes("CERT") || /certificate|SSL|TLS/i.test(msg)) {
          settle(relayErr(-32012, `目标证书校验失败: ${msg}`, "tls"));
        } else settle(relayErr(-32011, `relay 失败: ${msg}`, "connect"));
      });
      ws.on("close", () => {
        if (!settled && !terminalReceived) settle(relayErr(-32011, `目标连接提前关闭: ${peer}`, "connect"));
      });
    });
  };
}

module.exports = { createRelayHandler };