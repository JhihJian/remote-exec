"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { inspectHost, installTarget, validateTarget } = require("../../deploy/ssh.js");
const { DEFAULT_RELAY_ALLOW } = require("../shared/constants.js");
const { relayAllowedByTarget } = require("./relay.js");

function createSshDeployHandler(allow = DEFAULT_RELAY_ALLOW) {
  const staging = new Map();
  const remove = async (id) => {
    const state = staging.get(id);
    if (!state) return;
    if (state.busy) throw new Error("部署仍在执行，稍后清理");
    staging.delete(id);
    clearTimeout(state.timer);
    await fs.rm(state.directory, { recursive: true, force: true });
  };
  const checkTarget = (target) => {
    const options = validateTarget(target);
    if (!net.isIPv4(options.host) || !relayAllowedByTarget(options.host, allow)) throw new Error("SSH 部署目标必须是网关允许网段内的 IPv4 地址");
    return options;
  };
  return async function deploySsh(params, context, onCancel) {
    if (params.action === "prepare") {
      if (staging.size >= 4) throw new Error("部署暂存已达上限，请等待其他任务结束");
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "remote-exec-deploy-"));
      await fs.chmod(directory, 0o700);
      const id = crypto.randomBytes(16).toString("hex");
      const state = { directory, busy: false };
      state.timer = setInterval(() => { if (!state.busy) remove(id).catch(() => {}); }, 60 * 60 * 1000);
      state.timer.unref();
      staging.set(id, state);
      return { id, files: { package: path.join(directory, "package.tar.gz"), checksum: path.join(directory, "package.tar.gz.sha256"), installer: path.join(directory, "install.sh") } };
    }
    if (params.action === "cleanup") {
      if (typeof params.id !== "string") throw new Error("缺少部署暂存标识");
      const state = staging.get(params.id);
      if (state?.busy) await state.finished;
      await remove(params.id);
      return { cleaned: true };
    }
    if (!["inspect", "install"].includes(params.action)) throw new Error("未知 SSH 部署操作");
    const target = checkTarget(params.target);
    const controller = new AbortController();
    const unregister = onCancel?.(() => controller.abort()) || (() => {});
    try {
      if (params.action === "inspect") return await inspectHost(target, { signal: controller.signal });
      const state = staging.get(params.id);
      if (!state || state.busy) throw new Error("部署暂存不存在或正在使用");
      state.busy = true;
      let finished;
      state.finished = new Promise((resolve) => { finished = resolve; });
      try {
        const bundle = { package: path.join(state.directory, "package.tar.gz"), checksum: path.join(state.directory, "package.tar.gz.sha256"), installer: path.join(state.directory, "install.sh") };
        const output = [];
        const result = await installTarget({ ...target, bundle }, { signal: controller.signal,
          onOutput: (chunk, stream) => output.push({ stream, data: chunk.toString("utf8") }),
        });
        // 输出在成功取得 token 后过滤，再交付事件。密码不进入输出通道。
        for (const entry of output) {
          let text = entry.data;
          for (const secret of [target.password, target.sudoPassword, result.token]) {
            if (secret) text = text.split(secret).join("[已隐藏]");
          }
          await context.emitEvent({ event: "output", stream: entry.stream, dataB64: Buffer.from(text).toString("base64") });
        }
        return result;
      } finally { state.busy = false; finished(); }
    } finally { unregister(); }
  };
}

module.exports = { createSshDeployHandler };
