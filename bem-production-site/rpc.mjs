import {SPARKDRAW as F} from './web/sparkdraw-config.js';
import {POOLS,VERIFIER} from './web/sparkdraw-profiles.js';

const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_estimateGas', 'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'net_version']);
const TARGETS = new Set([F.bem,F.revenue,VERIFIER,'0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',...Object.values(POOLS).map(d=>d.address)].map(a => a.toLowerCase()));
const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i, HEX = /^0x[0-9a-f]*$/i;
const validBlock = x => typeof x === 'string' && (['latest', 'pending', 'safe', 'finalized', 'earliest'].includes(x) || /^0x[0-9a-f]{1,64}$/i.test(x));
const validAddress = a => typeof a === 'string' && ADDRESS.test(a);
const validHash = a => typeof a === 'string' && HASH.test(a);
const error = message => { throw Object.assign(new Error(message), { code: -32602 }); };

export function validateReadRequest(request) {
  if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || !['number', 'string'].includes(typeof request.id)
    || String(request.id).length > 100 || (typeof request.id === 'number' && !Number.isSafeInteger(request.id))) error('Invalid JSON-RPC request');
  if (!READ_METHODS.has(request.method)) throw Object.assign(new Error('Only read-only chain methods are available'), { code: -32601 });
  const p = request.params === undefined ? [] : request.params;
  if (!Array.isArray(p) || p.length > 4) error('Invalid parameters');
  const m = request.method;
  if (['eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'net_version'].includes(m) && p.length) error('Unexpected parameters');
  if (['eth_getCode', 'eth_getBalance', 'eth_getTransactionCount'].includes(m)
    && (p.length !== 2 || !validAddress(p[0]) || !validBlock(p[1]))) error('Invalid address or block');
  if (['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(m) && (p.length !== 1 || !validHash(p[0]))) error('Invalid transaction hash');
  if (m === 'eth_getBlockByNumber' && (p.length !== 2 || !validBlock(p[0]) || p[1] !== false)) error('Only block headers are available');
  if (['eth_call', 'eth_estimateGas'].includes(m)) {
    const tx = p[0];
    if (!tx || Array.isArray(tx) || typeof tx !== 'object' || p.length < 1 || p.length > 2
      || !validAddress(tx.to) || !TARGETS.has(tx.to.toLowerCase()) || (p.length === 2 && !validBlock(p[1]))) error('Invalid read target');
    const allowed = new Set(['to', 'from', 'data', 'input', 'value', 'gas', 'gasLimit', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'chainId', 'type']);
    if (Object.keys(tx).some(k => !allowed.has(k))) error('Unsupported transaction field');
    if (Object.hasOwn(tx, 'from') && !validAddress(tx.from)) error('Invalid sender');
    for (const key of ['data', 'input']) if (Object.hasOwn(tx, key) && (typeof tx[key] !== 'string' || !HEX.test(tx[key]) || tx[key].length > 400000 || tx[key].length % 2 !== 0)) error('Invalid call data');
    for (const key of ['value', 'gas', 'gasLimit', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'chainId', 'type']) {
      if (Object.hasOwn(tx, key) && (typeof tx[key] !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(tx[key]))) error('Invalid transaction quantity');
    }
    if (tx.value && BigInt(tx.value) !== 0n) error('Read calls must have zero value');
    if (tx.chainId && BigInt(tx.chainId) !== 56n) error('Expected BNB Chain');
    if ((tx.gas && BigInt(tx.gas) > 16777216n) || (tx.gasLimit && BigInt(tx.gasLimit) > 16777216n)) error('Gas exceeds network limit');
  }
  if (m === 'eth_getLogs') {
    const filter = p[0];
    if (p.length !== 1 || !filter || typeof filter !== 'object' || Array.isArray(filter)
      || !validAddress(filter.address) || !Object.values(POOLS).map(d=>d.address).some(a => a.toLowerCase() === filter.address.toLowerCase())) error('Only game event queries are available');
    if (Object.hasOwn(filter, 'blockHash')) { if (!validHash(filter.blockHash) || Object.hasOwn(filter, 'fromBlock') || Object.hasOwn(filter, 'toBlock')) error('Invalid block hash filter'); }
    else if (typeof filter.fromBlock !== 'string' || typeof filter.toBlock !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(filter.fromBlock) || !/^0x[0-9a-f]{1,64}$/i.test(filter.toBlock)
      || BigInt(filter.toBlock) < BigInt(filter.fromBlock) || BigInt(filter.toBlock) - BigInt(filter.fromBlock) >= 1000n) error('Limit event queries to 1000 blocks');
    if (Object.hasOwn(filter, 'topics') && (!Array.isArray(filter.topics) || filter.topics.length > 4 || filter.topics.some(t => t !== null && !(validHash(t) || (Array.isArray(t) && t.length <= 32 && t.every(v => validHash(v))))))) error('Invalid topics');
    if (Object.keys(filter).some(k => !['address', 'fromBlock', 'toBlock', 'blockHash', 'topics'].includes(k))) error('Invalid log filter');
  }
  if (m === 'eth_feeHistory' && (p.length !== 3 || typeof p[0] !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(p[0]) || BigInt(p[0]) > 100n || !validBlock(p[1])
    || !Array.isArray(p[2]) || p[2].length > 20 || p[2].some(n => !Number.isFinite(n) || n < 0 || n > 100))) error('Invalid fee history');
  return { jsonrpc: '2.0', id: request.id, method: m, params: p };
}

// Only identical, concurrent reads share an upstream response. No completed
// response is cached: a fresh request, including a numeric-block read after a
// reorg, must go upstream again. Transaction/fee/nonce and pending reads stay
// independent because they can be part of a wallet preflight or recovery.
const SHAREABLE_METHODS = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getCode', 'eth_getBalance', 'eth_call', 'eth_getLogs']);
function shareable({ method, params }) {
  if (!SHAREABLE_METHODS.has(method)) return false;
  if (method === 'eth_getBlockByNumber') return params[0] !== 'pending';
  if (['eth_getCode', 'eth_getBalance', 'eth_call'].includes(method)) return params[1] !== 'pending';
  return true;
}
const busy = message => Object.assign(new Error(message), { code: -32005 });

export function createReadRpc({ endpoint = 'https://bsc-dataseed.bnbchain.org', logsEndpoint = 'https://bsc-rpc.publicnode.com', fetchImpl = fetch,
  concurrency = 6, maxQueue = 100, queueTimeoutMs = 5000, requestTimeoutMs = 20000, maxSharedWaiters = 128 } = {}) {
  const url = new URL(endpoint), logsUrl = new URL(logsEndpoint);
  for (const target of [url, logsUrl]) if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Use a HTTPS RPC endpoint without inline credentials');
  for (const [name, value, min, max] of [['concurrency', concurrency, 1, 32], ['maxQueue', maxQueue, 0, 1000],
    ['queueTimeoutMs', queueTimeoutMs, 1, 30000], ['requestTimeoutMs', requestTimeoutMs, 1, 60000], ['maxSharedWaiters', maxSharedWaiters, 1, 1024]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid RPC ${name}`);
  }
  let serial = 0, active = 0;
  const waiting = [], inflight = new Map();
  function acquire() {
    if (active < concurrency) { active++; return Promise.resolve(); }
    if (waiting.length >= maxQueue) return Promise.reject(busy('RPC is busy; retry shortly'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index !== -1) { waiting.splice(index, 1); reject(busy('RPC queue wait expired; retry shortly')); }
      }, queueTimeoutMs);
      waiting.push(entry);
    });
  }
  function release() {
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else active--;
  }
  async function execute(payload, body) {
    await acquire();
    try {
      const response = await fetchImpl(payload.method === 'eth_getLogs' ? logsUrl : url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!response.ok) throw Object.assign(new Error('Upstream RPC temporarily unavailable'), { code: -32000 });
      const data = await response.json();
      if (data?.jsonrpc !== '2.0' || data.id !== payload.id) throw new Error('Mismatched chain response');
      if (data.error) throw Object.assign(new Error('Chain read failed'), { code: Number.isInteger(data.error.code) ? data.error.code : -32000 });
      if (!Object.hasOwn(data, 'result')) throw new Error('Missing chain result');
      return data.result;
    } finally { release(); }
  }
  return async function rpc(method, params) {
    const payload = validateReadRequest({ jsonrpc: '2.0', id: ++serial, method, params });
    // Freeze the exact payload before waiting; callers cannot change queued reads.
    const body = JSON.stringify(payload);
    if (!shareable(payload)) return execute(payload, body);
    const key = JSON.stringify([payload.method, payload.params]);
    let job = inflight.get(key);
    if (job) {
      if (job.waiters >= maxSharedWaiters) throw busy('RPC shared read is busy; retry shortly');
      job.waiters++;
    } else {
      job = { waiters: 1, promise: null };
      job.promise = execute(payload, body).finally(() => { if (inflight.get(key) === job) inflight.delete(key); });
      inflight.set(key, job);
    }
    try { return structuredClone(await job.promise); }
    finally { job.waiters--; }
  };
}
