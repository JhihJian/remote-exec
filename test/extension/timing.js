const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Type } = require('@sinclair/typebox');

// 在 Pi 边界提供替身，测试实际注册的工具，不连接个人远程主机。
const tools = new Map();
const timers = new Map();
let now = 0;
let nextTimer = 0;
class Text {
  constructor(text) { this.text = text; }
  render() { return this.text.split('\n'); }
}
const sandbox = vm.createContext({
  exports: {}, Buffer, console,
  performance: { now: () => now },
  setInterval(callback, interval) {
    assert.equal(interval, 1000);
    const timer = { id: ++nextTimer, unref() {} };
    timers.set(timer, callback);
    return timer;
  },
  clearInterval(timer) { timers.delete(timer); },
  require(name) {
    if (name === '@earendil-works/pi-tui') return { Text };
    if (name === '@sinclair/typebox') return { Type };
    if (name === 'node:fs') return {
      ...fs,
      readFileSync(file, ...args) {
        if (String(file).endsWith('/remote-exec/hosts.json')) {
          return JSON.stringify({ hosts: { test: { host: '127.0.0.1', port: 8791 } } });
        }
        return fs.readFileSync(file, ...args);
      },
    };
    return require(name);
  },
});
const source = fs.readFileSync(path.join(__dirname, '../../pi-extension/remote-exec.ts'), 'utf8');
vm.runInContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, sandbox);
sandbox.exports.default({ registerTool: (tool) => tools.set(tool.name, tool), on() {} });
const bash = tools.get('remote_bash');
const theme = { fg: (_color, text) => text, bold: (text) => text };
const render = (result, expanded = false, isPartial = false) =>
  bash.renderResult(result, { expanded, isPartial }, theme).render(80).join('\n');

async function main() {
  const pending = [];
  sandbox.runCommand = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  vm.runInContext('remoteBash = runCommand', sandbox);
  const updates = [];
  const first = bash.execute('first', { host: 'test', command: 'first' }, undefined, (result) => updates.push(result));
  assert.equal(render(updates[0], false, true), '执行中 · 已用时 0.0s');
  now = 1200;
  for (const callback of timers.values()) callback();
  assert.equal(render(updates.at(-1), false, true), '执行中 · 已用时 1.2s');
  const secondUpdates = [];
  const second = bash.execute('second', { host: 'test', command: 'second' }, undefined, (result) => secondUpdates.push(result));
  now = 2500;
  for (const callback of timers.values()) callback();
  assert.equal(updates.at(-1).details.elapsedMs, 2500);
  assert.equal(secondUpdates.at(-1).details.elapsedMs, 1300);
  pending[0].resolve('[exit 0]\n完成');
  const result = await first;
  assert.equal(render(result), '耗时 2.5s\n[exit 0]\n完成');
  assert.equal(timers.size, 1);
  assert.equal(render(JSON.parse(JSON.stringify(result))), render(result));
  pending[1].resolve('远程执行失败：连接失败');
  assert.match(render(await second), /耗时 1.3s\n远程执行失败/);
  assert.equal(timers.size, 0);

  const failed = bash.execute('failed', { host: 'test', command: 'fail' }, undefined, () => {});
  pending[2].reject(new Error('unexpected failure'));
  await assert.rejects(failed, /unexpected failure/);
  assert.equal(timers.size, 0);

  const headless = bash.execute('headless', { host: 'test', command: 'headless' });
  assert.equal(timers.size, 0);
  pending[3].resolve('[exit 0]');
  assert.equal((await headless).content[0].text, '[exit 0]');

  const controller = new AbortController();
  const cancelled = bash.execute('cancelled', { host: 'test', command: 'cancelled' }, controller.signal, () => {});
  assert.equal(timers.size, 1);
  controller.abort();
  assert.equal(timers.size, 0);
  pending[4].resolve('[exit 124]');
  await cancelled;
  const alreadyCancelled = bash.execute('aborted', { host: 'test', command: 'aborted' }, controller.signal, () => assert.fail('已取消调用不应更新计时'));
  assert.equal(timers.size, 0);
  pending[5].resolve('[exit 124]');
  await alreadyCancelled;

  const long = { content: [{ type: 'text', text: Array.from({ length: 15 }, (_, i) => `行 ${i}`).join('\n') }], details: { elapsedMs: 123456 } };
  assert.match(render(long), /耗时 123.5s/);
  assert.match(render(long), /还有 5 行/);
  assert.doesNotMatch(render(long), /行 14/);
  assert.match(render(long, true), /行 14/);
  assert.doesNotMatch(render(long, true), /还有/);
  assert.equal(render({ content: [{ type: 'text', text: '旧会话输出' }] }), '旧会话输出');
  console.log('Pi extension：耗时更新、并行隔离、清理、持久化和结果渲染验证通过');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
