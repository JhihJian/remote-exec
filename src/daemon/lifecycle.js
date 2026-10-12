"use strict";

const { DRAIN_TIMEOUT_MS } = require("./shared/constants.js");

function createLifecycle(options = {}) {
  const drainTimeoutMs = Math.max(1, Number(options.drainTimeoutMs) || DRAIN_TIMEOUT_MS);
  let state = "starting";
  let draining = null;
  let active = 0;
  const resources = new Map();
  const forceClosers = new Set();
  const idleWaiters = new Set();

  const notifyIdle = () => {
    if (active !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  const acquire = (kind) => {
    if (state === "draining" || state === "stopped") return null;
    active += 1;
    resources.set(kind, (resources.get(kind) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const count = (resources.get(kind) || 1) - 1;
      if (count > 0) resources.set(kind, count);
      else resources.delete(kind);
      notifyIdle();
    };
  };
  const waitForIdle = () => active === 0
    ? Promise.resolve()
    : new Promise((resolve) => idleWaiters.add(resolve));
  const beginDrain = () => {
    if (state === "draining") return draining.promise;
    if (state === "stopped") return Promise.resolve();
    state = "draining";
    let resolveDeadline;
    const deadline = new Promise((resolve) => { resolveDeadline = resolve; });
    const timer = setTimeout(() => {
      for (const close of forceClosers) close();
      resolveDeadline();
    }, drainTimeoutMs);
    draining = { promise: Promise.race([waitForIdle(), deadline]).finally(() => clearTimeout(timer)) };
    return draining.promise;
  };
  const markReady = () => { if (state === "starting") state = "ready"; };
  const markStopped = () => { state = "stopped"; notifyIdle(); };
  const addForceCloser = (close) => {
    forceClosers.add(close);
    return () => forceClosers.delete(close);
  };
  return {
    get state() { return state; },
    get active() { return active; },
    get resources() { return Object.fromEntries(resources); },
    accepting() { return state === "ready"; },
    acquire,
    addForceCloser,
    beginDrain,
    waitForIdle,
    markReady,
    markStopped,
  };
}

module.exports = { createLifecycle };
