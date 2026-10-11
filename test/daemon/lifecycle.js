const assert = require('node:assert/strict');
const { createLifecycle } = require('../../src/daemon/lifecycle.js');

async function main() {
  const lifecycle = createLifecycle({ drainTimeoutMs: 50 });
  lifecycle.markReady();
  const release = lifecycle.acquire('rpc');
  assert.equal(lifecycle.state, 'ready');
  assert.deepEqual(lifecycle.resources, { rpc: 1 });
  const draining = lifecycle.beginDrain();
  assert.equal(lifecycle.state, 'draining');
  assert.equal(lifecycle.accepting(), false);
  assert.equal(lifecycle.acquire('rpc'), null);
  release();
  await draining;
  assert.equal(lifecycle.active, 0);
  lifecycle.markStopped();
  assert.equal(lifecycle.state, 'stopped');
  console.log('daemon lifecycle：ready、draining、资源计数和截止时间验证通过');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
