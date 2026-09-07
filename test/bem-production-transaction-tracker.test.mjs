import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { PINNED } from '../bem-production-site/web/guards.js';
import { validateReadRequest } from '../bem-production-site/rpc.mjs';
import { createTransactionRecord, restoreTransactionRecords, createTransactionTracker, isTransactionBlocking } from '../bem-production-site/web/transaction-tracker.js';

const USER = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
const h = n => '0x' + BigInt(n).toString(16).padStart(64, '0'), q = n => '0x' + BigInt(n).toString(16);
const ABI = new Interface(['function approve(address,uint256)', 'function buy(uint256,uint32)', 'function buySelected(uint256,uint16[])', 'function refund(uint256,address)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event TicketsPurchased(uint256 indexed roundId,address indexed buyer,uint32 firstTicket,uint32 endExclusive,uint256 paid)',
  'event Refunded(uint256 indexed roundId,address indexed buyer,uint256 amount)']);
const READS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getTransactionCount', 'eth_getCode']);

function fixture(action = 'buy', options = {}) {
  let time = Date.parse('2026-09-07T01:00:00Z');
  const data = action === 'approve' ? ABI.encodeFunctionData('approve', [PINNED.gameAddress, 3n * PINNED.ticketPrice]) :
    action === 'refund' ? ABI.encodeFunctionData('refund', [3, USER]) : ABI.encodeFunctionData('buySelected', [3, [0, 87, 9999]]);
  const record = createTransactionRecord({ hash: h(1), account: USER, action, roundId: '3', to: action === 'approve' ? PINNED.bemAddress : PINNED.gameAddress,
    data, submittedAt: new Date(time).toISOString(), fromBlock: 90 });
  const state = { tip: 100, chain: '0x38', consumedAt: Infinity, code: '0x', transactions: new Map(), receipts: new Map(), blockTx: new Map(), changedHashes: new Map(), calls: [], failure: null };
  const blockHash = number => state.changedHashes.get(number) ?? h(1000000 + number);
  function transaction(hash = record.hash, changes = {}) { return { hash, chainId: '0x38', from: USER, to: record.to, input: record.data, value: '0x0', nonce: '0x7', blockNumber: null, blockHash: null, ...changes }; }
  state.transactions.set(record.hash, transaction());
  function log(tx, name, args, address = record.to) {
    const encoded = ABI.encodeEventLog(ABI.getEvent(name), args);
    return { address, ...encoded, blockNumber: tx.blockNumber, blockHash: tx.blockHash, transactionHash: tx.hash, logIndex: '0x0', removed: false };
  }
  function events(tx) {
    if (action === 'approve') return [log(tx, 'Approval', [USER, PINNED.gameAddress, 3n * PINNED.ticketPrice])];
    if (action === 'refund') return [log(tx, 'Refunded', [3, USER, 3n * PINNED.ticketPrice])];
    return [0, 87, 9999].map((n, i) => ({ ...log(tx, 'TicketsPurchased', [3, USER, n, n + 1, PINNED.ticketPrice]), logIndex: q(i) }));
  }
  function mine(hash = record.hash, changes = {}, status = 1, expectedEvents = true) {
    const tx = transaction(hash, { blockNumber: q(110), blockHash: blockHash(110), ...changes });
    state.transactions.set(hash, tx); const list = state.blockTx.get(110) ?? []; if (!list.includes(hash)) list.push(hash); state.blockTx.set(110, list);
    state.receipts.set(hash, { transactionHash: hash, from: tx.from, to: tx.to, blockNumber: tx.blockNumber, blockHash: tx.blockHash, status: q(status), logs: status && expectedEvents ? events(tx) : [] });
    state.consumedAt = 110; state.tip = 122; return tx;
  }
  async function rpc(method, params) {
    assert.ok(READS.has(method), 'Never request a signing or sending method');
    validateReadRequest({ jsonrpc: '2.0', id: 1, method, params });
    state.calls.push([method, params]);
    if (state.failure) return state.failure(method, params);
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getTransactionByHash') return structuredClone(state.transactions.get(params[0]) ?? null);
    if (method === 'eth_getTransactionReceipt') return structuredClone(state.receipts.get(params[0]) ?? null);
    if (method === 'eth_getCode') return state.code;
    if (method === 'eth_getTransactionCount') return q(Number(BigInt(params[1])) >= state.consumedAt ? 8 : 7);
    const number = params[0] === 'latest' ? state.tip : Number(BigInt(params[0]));
    return { number: q(number), hash: blockHash(number), transactions: [...(state.blockTx.get(number) ?? [])] };
  }
  const tracker = createTransactionTracker({ rpc, now: () => time, ...options });
  return { state, record, tracker, rpc, transaction, mine, log, events, blockHash, now: () => time, advance: n => { time += n; } };
}

test('only canonical fixed-target receipt with the expected approval event confirms', async () => {
  const f = fixture('approve'); f.mine();
  const result = await f.tracker.poll(f.record);
  assert.equal(result.status, 'confirmed'); assert.equal(result.confirmations, 13); assert.equal(result.effectiveHash, f.record.hash);
  assert.equal(result.evidence.amount, '3000000'); assert.equal(result.blockingUntil, 0);
  assert.equal(result.replacementHash, null);
});

test('free ticket selection verifies all three actual ticket numbers and payment', async () => {
  const f = fixture(); f.mine(); const result = await f.tracker.poll(f.record);
  assert.equal(result.status, 'confirmed'); assert.deepEqual(result.evidence.tickets, [0, 87, 9999]);
  const receipt = f.state.receipts.get(f.record.hash); receipt.logs[2] = receipt.logs[0];
  assert.equal((await f.tracker.poll(f.record)).status, 'unverified', 'Duplicated ranges cannot stand in for the selected tickets');
});

test('refund confirms only the corresponding round and recipient event', async () => {
  const f = fixture('refund'); const tx = f.mine(); assert.equal((await f.tracker.poll(f.record)).status, 'confirmed');
  f.state.receipts.get(f.record.hash).logs = [f.log(tx, 'Refunded', [4, USER, 3000000])];
  assert.equal((await f.tracker.poll(f.record)).reason, 'EVENT_MISMATCH');
  assert.throws(() => createTransactionRecord({ ...f.record, data: ABI.encodeFunctionData('refund', [3, OTHER]) }));
});

test('a canonical failure receipt is reverted; elapsed time alone never is', async () => {
  const f = fixture(); f.mine(f.record.hash, {}, 0); assert.equal((await f.tracker.poll(f.record)).status, 'reverted');
  const pending = fixture(); pending.advance(100000); const result = await pending.tracker.poll(pending.record);
  assert.equal(result.status, 'unknown'); assert.notEqual(result.status, 'reverted');
  assert.equal(isTransactionBlocking(result, USER, pending.now()), false);
});

test('a speedup uses RPC-verified original nonce even after the original disappears', async () => {
  const f = fixture(); assert.equal((await f.tracker.poll(f.record)).status, 'pending');
  f.state.transactions.delete(f.record.hash);
  const unrelated = f.mine(h(40), { from: OTHER, chainId: '0x0', nonce: '0x1' }, 1, false);
  assert.equal(unrelated.chainId, '0x0'); // Unprotected signatures of unrelated senders do not stop scanning.
  f.mine(h(2)); const result = await f.tracker.poll(f.record);
  assert.equal(result.status, 'confirmed'); assert.equal(result.hash, h(1)); assert.equal(result.effectiveHash, h(2));
  assert.equal(result.replacementKind, 'repriced'); assert.equal(result.nonce, '7');
});

test('a mined wallet cancellation and a different replacement are not reported as a purchase', async () => {
  for (const [changes, expected] of [[{ to: USER, input: '0x' }, 'cancelled'], [{ to: OTHER, input: '0x', value: '0x1' }, 'replaced']]) {
    const f = fixture(); await f.tracker.poll(f.record); f.state.transactions.delete(f.record.hash);
    f.mine(h(2), changes, 1, false); const result = await f.tracker.poll(f.record);
    assert.equal(result.status, expected); assert.equal(result.evidence, null); assert.notEqual(result.status, 'confirmed');
  }
});

test('smart-account self-call is treated as another action, not assumed to be cancellation', async () => {
  const f = fixture(); await f.tracker.poll(f.record); f.state.transactions.delete(f.record.hash); f.state.code = '0xef0100' + OTHER.slice(2);
  f.mine(h(2), { to: USER, input: '0x' }, 1, false); assert.equal((await f.tracker.poll(f.record)).status, 'replaced');
});

test('same-action replacement can revert and cannot become a success', async () => {
  const f = fixture(); await f.tracker.poll(f.record); f.state.transactions.delete(f.record.hash); f.mine(h(2), {}, 0);
  const result = await f.tracker.poll(f.record); assert.equal(result.status, 'reverted'); assert.equal(result.replacementKind, 'repriced');
});

test('manual candidate requires the original sender and chain-observed nonce', async () => {
  const f = fixture(); await f.tracker.poll(f.record); f.state.transactions.delete(f.record.hash);
  f.mine(h(2), { nonce: '0x8' }); assert.equal((await f.tracker.reconcile(f.record, h(2))).reason, 'CANDIDATE_NOT_REPLACEMENT');
  f.mine(h(3)); const result = await f.tracker.reconcile(f.record, h(3)); assert.equal(result.status, 'confirmed'); assert.equal(result.effectiveHash, h(3));
});

test('restored success, fake nonce, hashes and future-version records are not trusted', async () => {
  const f = fixture(); const restored = restoreTransactionRecords(JSON.stringify([{ ...f.record, status: 'confirmed', nonce: '7', replacementHash: h(2), effectiveHash: h(2), evidence: { event: 'TicketsPurchased' } }, { ...f.record, hash: h(3), trackerVersion: 99 }]));
  assert.equal(restored.length, 1); assert.equal(restored[0].status, 'unknown'); assert.equal(restored[0].nonce, undefined); assert.equal(restored[0].effectiveHash, null);
  f.state.transactions.delete(f.record.hash); f.mine(h(2));
  const result = await f.tracker.reconcile(restored[0], h(2));
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'ORIGINAL_NONCE_UNKNOWN');
  assert.ok(!f.state.calls.some(([method]) => method === 'eth_getTransactionCount'));
  assert.equal(isTransactionBlocking(result, USER, f.now()), false);
  assert.deepEqual(restoreTransactionRecords('broken json'), []);
});

test('legacy v1 entries are rechecked; malformed calls and foreign destinations are rejected', () => {
  const f = fixture('approve'); const legacy = { ...f.record, trackerVersion: undefined, status: 'confirmed' };
  assert.equal(restoreTransactionRecords([legacy])[0].reason, 'RESTORED_RECHECK_REQUIRED');
  assert.deepEqual(restoreTransactionRecords([{ ...legacy, to: OTHER }, { ...legacy, data: legacy.data + '00' }, { ...legacy, roundId: 0 }]), []);
});

test('receipt identity, chain, event and canonical-block mismatches cannot confirm', async () => {
  const cases = [
    f => { f.state.chain = '0x61'; },
    f => { f.state.receipts.get(h(1)).transactionHash = h(9); },
    f => { f.state.receipts.get(h(1)).from = OTHER; },
    f => { f.state.receipts.get(h(1)).to = OTHER; },
    f => { f.state.receipts.get(h(1)).status = '0x2'; },
    f => { f.state.receipts.get(h(1)).logs = []; },
    f => { f.state.receipts.get(h(1)).logs[0].removed = true; },
    f => { f.state.blockTx.set(110, []); },
    f => { f.state.transactions.get(h(1)).value = '0x1'; },
    f => { f.state.changedHashes.set(110, h(666)); }
  ];
  for (const mutate of cases) { const f = fixture(); f.mine(); mutate(f); assert.notEqual((await f.tracker.poll(f.record)).status, 'confirmed'); }
});

test('inclusion awaits twelve confirmations, and a reorg can restore a pending state', async () => {
  const f = fixture(); f.mine(); f.state.tip = 112;
  const included = await f.tracker.poll(f.record); assert.equal(included.status, 'confirming'); assert.equal(included.confirmations, 3);
  f.state.receipts.delete(h(1)); f.state.transactions.set(h(1), f.transaction()); f.state.consumedAt = Infinity;
  assert.equal((await f.tracker.poll(included)).status, 'pending');
  f.advance(100000); assert.equal((await f.tracker.poll(included)).status, 'unknown');
  f.mine(); assert.equal((await f.tracker.poll(included)).status, 'confirmed');
});

test('RPC timeout is bounded and never converted into a failure or automatic transaction', async () => {
  const f = fixture('buy', { requestTimeoutMs: 5, pollTimeoutMs: 20 }); f.state.failure = () => new Promise(() => {});
  const waiting = await f.tracker.poll(f.record); assert.equal(waiting.reason, 'RPC_TIMEOUT'); assert.equal(waiting.status, 'pending');
  assert.equal(isTransactionBlocking(waiting, USER, f.now()), true); assert.equal(isTransactionBlocking(waiting, OTHER, f.now()), false);
  f.advance(100000); const later = await f.tracker.poll(waiting); assert.equal(later.status, 'unknown'); assert.equal(later.requiresReview, true);
});

test('replacement lookup resumes across a bounded request budget', async () => {
  const f = fixture('buy', { maxReadsPerPoll: 15 }); await f.tracker.poll(f.record); f.state.transactions.delete(h(1));
  for (let n = 20; n < 48; n++) f.mine(h(n), { from: OTHER, nonce: q(n), chainId: '0x0' }, 1, false);
  f.mine(h(2)); let result;
  for (let attempt = 0; attempt < 15; attempt++) {
    const before = f.state.calls.length; result = await f.tracker.poll(f.record); assert.ok(f.state.calls.length - before <= 15);
    if (result.status === 'confirmed') break;
    assert.equal(result.reason, 'CHECK_LIMIT');
  }
  assert.equal(result.status, 'confirmed'); assert.equal(result.effectiveHash, h(2));
});

test('concurrent polls for one transaction share one asynchronous check', async () => {
  const f = fixture(); const a = f.tracker.poll(f.record), b = f.tracker.poll(f.record);
  assert.equal(a, b); await Promise.all([a, b]); assert.equal(f.state.calls.filter(([method]) => method === 'eth_chainId').length, 1);
});
