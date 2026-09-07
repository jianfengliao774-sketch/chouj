import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import { createReadRpc } from '../bem-production-site/rpc.mjs';
import { GAME } from '../bem-production-site/config.mjs';

const HASH = '0x' + 'ab'.repeat(32);
const call = (data = '0x1234', block = '0x64') => [{ to: GAME, data }, block];
function fixture(options = {}) {
  const calls = [];
  let active = 0, maximum = 0;
  const rpc = createReadRpc({ endpoint: 'https://rpc.invalid', logsEndpoint: 'https://logs.invalid', ...options,
    fetchImpl: (url, request) => new Promise((resolve, reject) => {
      const payload = JSON.parse(request.body);
      active++; maximum = Math.max(maximum, active);
      let finished = false;
      function finish(error, result = '0x38') {
        if (finished) return; finished = true; active--; request.signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve({ ok: true, json: async () => ({ jsonrpc: '2.0', id: payload.id, result }) });
      }
      const abort = () => finish(request.signal.reason);
      request.signal.addEventListener('abort', abort, { once: true });
      calls.push({ payload, url: String(url), resolve: result => finish(null, result), reject: error => finish(error) });
    }),
  });
  return { rpc, calls, maximum: () => maximum };
}
const observed = promise => promise.then(value => ({ value }), error => ({ error }));

test('100 identical in-flight calls use one upstream request with isolated result objects; completed results are never cached', async () => {
  const s = fixture();
  const results = Array.from({ length: 100 }, () => s.rpc('eth_call', call()));
  await tick(); assert.equal(s.calls.length, 1);
  s.calls[0].resolve({ rows: [{ number: 1 }] });
  const all = await Promise.all(results); all[0].rows[0].number = 99;
  assert.equal(all[1].rows[0].number, 1);
  const fresh = s.rpc('eth_call', call()); await tick(); assert.equal(s.calls.length, 2);
  s.calls[1].resolve('0x02'); assert.equal(await fresh, '0x02');
});

test('different calldata, senders and numeric block tags cannot share state, including after a same-height reorg', async () => {
  const s = fixture();
  const reads = [s.rpc('eth_call', call()), s.rpc('eth_call', call('0x1235')),
    s.rpc('eth_call', call('0x1234', '0x65')),
    s.rpc('eth_call', [{ to: GAME, data: '0x1234', from: '0x' + '12'.repeat(20) }, '0x64'])];
  await tick(); assert.equal(s.calls.length, 4);
  s.calls.forEach((item, index) => item.resolve('0x0' + index));
  assert.deepEqual(await Promise.all(reads), ['0x00', '0x01', '0x02', '0x03']);
  const afterReorg = s.rpc('eth_call', call()); await tick();
  assert.equal(s.calls.length, 5); s.calls[4].resolve('0xff'); assert.equal(await afterReorg, '0xff');
});

test('pending, nonce, transaction, receipt, gas estimate and fee requests stay independent', async () => {
  for (const [method, params] of [['eth_call', call('0x1234', 'pending')], ['eth_getCode', [GAME, 'pending']],
    ['eth_getBalance', [GAME, 'pending']], ['eth_getBlockByNumber', ['pending', false]],
    ['eth_getTransactionCount', [GAME, 'latest']], ['eth_getTransactionByHash', [HASH]],
    ['eth_getTransactionReceipt', [HASH]], ['eth_estimateGas', [{ to: GAME, data: '0x1234' }]],
    ['eth_gasPrice', []], ['eth_feeHistory', ['0x1', 'latest', []]]]) {
    const s = fixture(), first = s.rpc(method, params), second = s.rpc(method, params);
    await tick(); assert.equal(s.calls.length, 2, method);
    s.calls[0].resolve('0x1'); s.calls[1].resolve('0x2');
    assert.deepEqual(await Promise.all([first, second]), ['0x1', '0x2']);
  }
});

test('queue capacity bounds distinct work while duplicate queued reads share a single slot in FIFO order', async () => {
  const s = fixture({ concurrency: 1, maxQueue: 1 });
  const first = s.rpc('eth_call', call('0x01'));
  const second = s.rpc('eth_call', call('0x02')), sameSecond = s.rpc('eth_call', call('0x02'));
  const excess = observed(s.rpc('eth_call', call('0x03')));
  await tick(); assert.equal(s.calls.length, 1); assert.equal((await excess).error.code, -32005);
  s.calls[0].resolve('0x01'); assert.equal(await first, '0x01'); await tick();
  assert.equal(s.calls.length, 2); assert.equal(s.calls[1].payload.params[0].data, '0x02');
  s.calls[1].resolve('0x02'); assert.deepEqual(await Promise.all([second, sameSecond]), ['0x02', '0x02']);
  assert.equal(s.maximum(), 1);
});

test('expired queued work never reaches upstream and does not consume a later concurrency slot', async () => {
  const s = fixture({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 15 });
  const active = s.rpc('eth_call', call('0x01'));
  const expired = observed(s.rpc('eth_call', call('0x02')));
  await delay(40); assert.equal((await expired).error.code, -32005); assert.equal(s.calls.length, 1);
  const retry = s.rpc('eth_call', call('0x02'));
  s.calls[0].resolve('0x01'); await active; await tick();
  assert.equal(s.calls.length, 2); s.calls[1].resolve('0x02'); assert.equal(await retry, '0x02');
  assert.equal(s.maximum(), 1);
});

test('an aborted upstream releases its slot and identical failed reads can be retried', async () => {
  const s = fixture({ concurrency: 1, requestTimeoutMs: 20, queueTimeoutMs: 200 });
  const first = observed(s.rpc('eth_call', call('0x01'))), joined = observed(s.rpc('eth_call', call('0x01')));
  const next = s.rpc('eth_call', call('0x02'));
  await delay(30); assert.ok((await first).error); assert.ok((await joined).error);
  assert.equal(s.calls.length, 2); s.calls[1].resolve('0x02'); assert.equal(await next, '0x02');
  const retried = s.rpc('eth_call', call('0x01')); await tick();
  assert.equal(s.calls.length, 3); s.calls[2].resolve('0x03'); assert.equal(await retried, '0x03');
});

test('shared subscribers are bounded and invalid or signing requests cannot occupy any upstream slot', async () => {
  const s = fixture({ maxSharedWaiters: 2 });
  const first = s.rpc('eth_call', call()), second = s.rpc('eth_call', call());
  await assert.rejects(s.rpc('eth_call', call()), e => e.code === -32005);
  await assert.rejects(s.rpc('eth_sendTransaction', [{ to: GAME }]), e => e.code === -32601);
  await assert.rejects(s.rpc('eth_call', [{ to: GAME }, null]), e => e.code === -32602);
  await tick(); assert.equal(s.calls.length, 1); s.calls[0].resolve('0x01'); await Promise.all([first, second]);
});

test('queued payloads are snapshotted before callers can mutate them and logs keep their separate endpoint', async () => {
  const s = fixture({ concurrency: 1 });
  const first = s.rpc('eth_chainId', []);
  const params = call('0xabcd'); const second = s.rpc('eth_call', params); params[0].data = '0xffff';
  await tick(); s.calls[0].resolve('0x38'); await first; await tick();
  assert.equal(s.calls[1].payload.params[0].data, '0xabcd'); s.calls[1].resolve('0x1'); await second;
  const logs = s.rpc('eth_getLogs', [{ address: GAME, blockHash: HASH }]); await tick();
  assert.equal(s.calls[2].url, 'https://logs.invalid/'); s.calls[2].resolve([]); await logs;
});
