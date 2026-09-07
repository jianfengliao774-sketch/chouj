import { GAME, BEM, CONTAINER, PROCESSOR, COORDINATOR, OPENER } from './config.mjs';
import { POOL_DEPLOYMENTS } from './web/pool-deployments.js';

const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_estimateGas', 'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'net_version']);
const TARGETS = new Set([GAME, BEM, CONTAINER, PROCESSOR, COORDINATOR, OPENER, ...Object.values(POOL_DEPLOYMENTS).map(d => d.address)].map(a => a.toLowerCase()));
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
    for (const key of ['data', 'input']) if (Object.hasOwn(tx, key) && (typeof tx[key] !== 'string' || !HEX.test(tx[key]) || tx[key].length > 131074 || tx[key].length % 2 !== 0)) error('Invalid call data');
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
      || !validAddress(filter.address) || ![GAME, ...Object.values(POOL_DEPLOYMENTS).map(d => d.address)].some(a => a.toLowerCase() === filter.address.toLowerCase())) error('Only game event queries are available');
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

export function createReadRpc({ endpoint = 'https://bsc-dataseed.bnbchain.org', logsEndpoint = 'https://bsc-rpc.publicnode.com', fetchImpl = fetch } = {}) {
  const url = new URL(endpoint), logsUrl = new URL(logsEndpoint);
  for (const target of [url, logsUrl]) if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Use a HTTPS RPC endpoint without inline credentials');
  let serial = 0, active = 0;
  const waiting = [];
  return async function rpc(method, params) {
    const payload = validateReadRequest({ jsonrpc: '2.0', id: ++serial, method, params });
    if (active >= 6) {
      if (waiting.length >= 100) throw Object.assign(new Error('RPC is busy'), { code: -32005 });
      await new Promise(resolve => waiting.push(resolve));
    } else active++;
    try {
      const response = await fetchImpl(method === 'eth_getLogs' ? logsUrl : url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Object.assign(new Error('Upstream RPC temporarily unavailable'), { code: -32000 });
      const data = await response.json();
      if (data?.jsonrpc !== '2.0' || data.id !== payload.id) throw new Error('Mismatched chain response');
      if (data.error) throw Object.assign(new Error('Chain read failed'), { code: Number.isInteger(data.error.code) ? data.error.code : -32000 });
      if (!Object.hasOwn(data, 'result')) throw new Error('Missing chain result');
      return data.result;
    } finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}
