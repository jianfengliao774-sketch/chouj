import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadRpcBatcher } from '../bem-production-site/web/read-rpc-batcher.js';
import { GAME } from '../bem-production-site/web/sparkdraw-transactions.js';
import { profile } from '../bem-production-site/web/sparkdraw-profiles.js';

const response = (rows, status = 200) => ({ ok: status === 200, status, headers: { get: () => 'application/json' }, json: async () => rows });
const replies = options => JSON.parse(options.body).map(row => ({ jsonrpc: '2.0', id: row.id, result: row.params[0] ?? '0x38' }));

test('5000-ticket estimates are intact and concurrent large requests split below 512 KiB', async () => {
  const requests = [], tx = {to: profile('5').address, data: GAME.encodeFunctionData('buySelected', [1, Array.from({length: 5000}, (_, i) => i)])};
  const rpc = createReadRpcBatcher({fetchImpl: async (_, options) => {
    assert.ok(Buffer.byteLength(options.body) <= 524288);
    const rows = JSON.parse(options.body); requests.push(rows);
    return response(rows.map(r => ({jsonrpc:'2.0', id:r.id, result:'0x123'})));
  }});
  const values = await Promise.all([rpc('eth_estimateGas', [tx, 'latest']), rpc('eth_estimateGas', [tx, 'latest']), rpc('eth_gasPrice')]);
  assert.deepEqual(values, ['0x123', '0x123', '0x123']); assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.length), [1, 2]);
  for (const r of requests.flat().filter(r => r.method === 'eth_estimateGas')) assert.equal(GAME.decodeFunctionData('buySelected', r.params[0].data)[1].length, 5000);
});

test('60 concurrent reads use three HTTP requests of at most 25 and map unordered responses by ID', async () => {
  const requests = [], rpc = createReadRpcBatcher({ fetchImpl: async (_, options) => {
    requests.push(JSON.parse(options.body)); return response(replies(options).reverse());
  } });
  assert.deepEqual(await Promise.all(Array.from({ length: 60 }, (_, n) => rpc('eth_call', [n]))), Array.from({ length: 60 }, (_, n) => n));
  assert.deepEqual(requests.map(rows => rows.length), [25, 25, 10]);
});

test('cancelling one read never cancels or overwrites another wallet’s read', async () => {
  let complete, entered;
  const fetching = new Promise(resolve => { entered = resolve; });
  const rpc = createReadRpcBatcher({ fetchImpl: async (_, options) => {
    entered(); await new Promise(resolve => { complete = resolve; }); return response(replies(options));
  } });
  const controller = new AbortController();
  const first = rpc('eth_call', ['old'], controller.signal), rejected = assert.rejects(first, { name: 'AbortError' });
  const second = rpc('eth_call', ['new']);
  await fetching; controller.abort(); complete(); await rejected;
  assert.equal(await second, 'new');
});

test('wallet signing and broadcast methods cannot enter the retry transport', async () => {
  let calls = 0;
  const rpc = createReadRpcBatcher({ fetchImpl: async () => { calls++; } });
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign', 'eth_signTypedData_v4']) {
    await assert.rejects(rpc(method), /Read-only/);
  }
  assert.equal(calls, 0);
});

test('only temporary read failures retry, with at most three attempts', async () => {
  let calls = 0;
  const rpc = createReadRpcBatcher({ retryDelay: async () => {}, fetchImpl: async (_, options) => {
    calls++; return calls < 3 ? response(null, 503) : response(replies(options));
  } });
  assert.equal(await rpc('eth_chainId'), '0x38'); assert.equal(calls, 3);
  let failures = 0;
  const busy = createReadRpcBatcher({ retryDelay: async () => {}, fetchImpl: async () => { failures++; return response(null, 429); } });
  await assert.rejects(busy('eth_chainId'), { code: 'RPC_UNAVAILABLE' }); assert.equal(failures, 3);
});

test('a batch retries only busy members, preserving already successful reads', async () => {
  const requests = [];
  const rpc = createReadRpcBatcher({ retryDelay: async () => {}, fetchImpl: async (_, options) => {
    const rows = replies(options); requests.push(rows);
    if (requests.length === 1) rows[1] = { jsonrpc: '2.0', id: rows[1].id, error: { code: -32005 } };
    return response(rows);
  } });
  assert.deepEqual(await Promise.all([rpc('eth_call', ['one']), rpc('eth_call', ['two'])]), ['one', 'two']);
  assert.deepEqual(requests.map(rows => rows.length), [2, 1]);
});

test('malformed, missing, duplicate and unrelated response IDs fail closed without retry', async () => {
  for (const corrupt of [rows => rows.slice(1), rows => [rows[0], rows[0]], rows => [rows[0], { ...rows[1], id: 999 }], () => ({ result: '0x38' })]) {
    let calls = 0;
    const rpc = createReadRpcBatcher({ fetchImpl: async (_, options) => { calls++; return response(corrupt(replies(options))); } });
    const settled = await Promise.allSettled([rpc('eth_chainId'), rpc('eth_chainId')]);
    assert.ok(settled.every(row => row.status === 'rejected' && row.reason.code === 'RPC_UNAVAILABLE'));
    assert.equal(calls, 1);
  }
});
