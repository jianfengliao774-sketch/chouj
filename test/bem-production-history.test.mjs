import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { createChainHistory, HISTORY_GAME, HISTORY_DEPLOYMENT_BLOCK as B } from '../bem-production-site/chain-history.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const abi = JSON.parse(await fs.readFile(path.join(root, 'outputs/bem-raffle-2075/production/Bem2075RaffleBSC.abi.json'), 'utf8'));
const iface = new Interface(abi);
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const hash = value => keccak256(toUtf8Bytes(value));
const hex = n => `0x${n.toString(16)}`;

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bem-history-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('bem-history-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const storagePath = path.join(directory, 'history.json');
  const network = { latest: B + 40, branchAt: Infinity, branch: 0, txs: [], calls: [], logError: null,
    rangeLimit: Infinity, corruptReceipt: false };
  const blockHash = n => hash(`block:${n}:${n >= network.branchAt ? network.branch : 0}`);
  function block(n) { return { number: hex(n), hash: blockHash(n), parentHash: blockHash(n - 1), timestamp: hex(1800000000 + n - B) }; }
  function add(offset, definitions, from = ALICE) {
    const n = B + offset, txIndex = network.txs.filter(tx => tx.blockNumber === n).length;
    const transactionHash = hash(`tx:${n}:${txIndex}:${network.branch}:${JSON.stringify(definitions)}`);
    const logs = definitions.map(([name, args], index) => {
      const encoded = iface.encodeEventLog(iface.getEvent(name), args);
      return { address: HISTORY_GAME, blockNumber: hex(n), blockHash: blockHash(n), transactionHash,
        transactionIndex: hex(txIndex), logIndex: hex(txIndex * 100 + index), topics: encoded.topics, data: encoded.data, removed: false };
    });
    network.txs.push({ hash: transactionHash, blockNumber: n, receipt: { transactionHash, blockNumber: hex(n),
      blockHash: blockHash(n), transactionIndex: hex(txIndex), status: '0x1', from, to: HISTORY_GAME,
      gasUsed: '0x30d40', effectiveGasPrice: '0x2faf080', logs } });
    return transactionHash;
  }
  async function rpc(method, params) {
    network.calls.push({ method, params });
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') return block(params[0] === 'latest' ? network.latest : Number(BigInt(params[0])));
    if (method === 'eth_getLogs') {
      if (network.logError) throw new Error(network.logError);
      const start = Number(BigInt(params[0].fromBlock)), end = Number(BigInt(params[0].toBlock));
      if (end - start + 1 > network.rangeLimit) throw new Error('block range limit exceeded');
      return network.txs.filter(tx => tx.blockNumber >= start && tx.blockNumber <= end).flatMap(tx => tx.receipt.logs).map(log => structuredClone(log));
    }
    if (method === 'eth_getTransactionReceipt') {
      const result = structuredClone(network.txs.find(tx => tx.hash === params[0])?.receipt || null);
      if (result && network.corruptReceipt) result.logs = [];
      return result;
    }
    throw new Error(`Forbidden method ${method}`);
  }
  const make = () => createChainHistory({ rpc, abi, storagePath, chunkSize: 5, maxBlocksPerSync: 400, ...options });
  return { network, add, rpc, make, storagePath, history: make() };
}

test('indexes the complete confirmed lifecycle with actual winners, receipts, and event payment ranges', async t => {
  const s = await fixture(t);
  const buy = s.add(0, [['RoundStarted', [1, 1900000000]],
    ['TicketsPurchased', [1, ALICE, 0, 2, 2000000]], ['TicketsPurchased', [1, ALICE, 9999, 10000, 1000000]]]);
  const lock = s.add(1, [['TicketsPurchased', [1, BOB, 2, 9999, 9997000000]],
    ['RoundLocked', [1, 1900000010]], ['DrawWindowOpened', [1, 1800000001, 1800000061]], ['DrawRequested', [1, 123456]]], BOB);
  const vrf = s.add(2, [['RandomnessReceived', [1, 123456, 111, 222]], ['DrawScheduled', [1, 1800000020, 1800000061]]]);
  const settle = s.add(3, [['AttemptEvaluated', [1, 0, 17, 243, 20, 245, 5365, true]],
    ['BlackholeTransfer', [1, 400000000]], ['Settled', [1, BOB, 5365]], ['NextRoundScheduled', [1, 2, 1800000063]]]);
  s.add(4, [['RoundStarted', [2, 1900000020]], ['TicketsPurchased', [2, ALICE, 42, 43, 1000000]]]);
  s.add(5, [['RefundsOpened', [2]], ['Refunded', [2, ALICE, 1000000]], ['NextRoundScheduled', [2, 3, 1900000080]]]);
  await s.history.sync();
  assert.equal(s.history.getStatus().state, 'ready'); assert.equal(s.history.getStatus().indexedThrough, B + 28);
  const page = s.history.listRounds({ page: 1, pageSize: 1 });
  assert.equal(page.total, 2); assert.equal(page.totalPages, 2); assert.equal(page.rounds[0].roundId, '2');
  assert.equal(page.rounds[0].status, 6); assert.equal(page.rounds[0].refundedBaseUnits, '1000000');
  const round = s.history.getRound('1');
  assert.equal(round.winner, BOB); assert.equal(round.winningTicket, 5365); assert.equal(round.status, 5);
  assert.equal(round.sold, 10000); assert.equal(round.raisedBaseUnits, '10000000000');
  assert.equal(round.blackholeBaseUnits, '400000000'); assert.equal(round.settlementTxHash, settle);
  assert.deepEqual(round.transactions, [buy, lock, vrf, settle]);
  assert.deepEqual(round.proof, { lockTxHash: lock, requestTxHash: lock, randomnessTxHash: vrf, settlementTxHash: settle, refundTxHashes: [] });
  assert.equal(round.transactionRecords.at(-1).receipt.transactionHash, settle);
  assert.equal(s.history.listTransactions({ roundId: '1', pageSize: 1 }).transactions[0].transactionHash, settle);
  const announcements=s.history.listAnnouncements();
  assert.equal(announcements.rows[0].winner,BOB);assert.equal(announcements.rows[0].amountBaseUnits,'9500000000');
  assert.equal(announcements.rows[0].poolId,'legacy100');assert.equal(announcements.rows[0].transactionHash,settle);
  const burns=s.history.listBurns();assert.equal(burns.rows[0].transactionHash,settle);assert.equal(burns.rows[0].amountBaseUnits,'400000000');
  assert.equal(burns.rows[0].kind,'settlement');assert.equal(burns.rows[0].timeUtc,round.settledAt);
  const recovered = s.make(); assert.equal(recovered.getStatus().state, 'syncing');
  assert.equal(recovered.getRound('1').winner, BOB); await recovered.sync();
  assert.equal(recovered.getRound('1').events.length, round.events.length, 'restart does not duplicate logs');
  const copy = recovered.getRound('1'); copy.winner = ALICE; assert.equal(recovered.getRound('1').winner, BOB);
});

test('RPC errors leave the confirmed cursor intact, mark stale, and never become an empty history', async t => {
  const s = await fixture(t); s.add(1, [['RoundStarted', [1, 1900000000]]]);
  await s.history.sync(); const before = s.history.getStatus().indexedThrough;
  s.network.latest += 20; s.network.logError = 'provider unavailable';
  await assert.rejects(s.history.sync(), /provider unavailable/);
  assert.equal(s.history.getStatus().state, 'stale'); assert.equal(s.history.getStatus().indexedThrough, before);
  assert.equal(s.history.listRounds().total, 1);
  s.network.logError = null; await s.history.sync(); assert.equal(s.history.getStatus().state, 'ready');
});

test('a confirmed-chain reorg rolls back old winner and receipt before rebuilding canonical events', async t => {
  const s = await fixture(t); s.add(1, [['RoundStarted', [1, 1900000000]]]);
  const old = s.add(10, [['Settled', [1, ALICE, 0]]]); await s.history.sync();
  s.network.branchAt = B + 8; s.network.branch = 1;
  s.network.txs = s.network.txs.filter(tx => tx.blockNumber < s.network.branchAt);
  const replacement = s.add(10, [['Settled', [1, BOB, 9999]]]);
  await s.history.sync(); const row = s.history.getRound('1');
  assert.equal(row.winner, BOB); assert.equal(row.winningTicket, 9999); assert.equal(row.settlementTxHash, replacement);
  assert.ok(!row.transactions.includes(old));
  assert.equal(s.history.listAnnouncements().rows[0].transactionHash,replacement);
  const saved = JSON.parse(await fs.readFile(s.storagePath, 'utf8')); assert.equal(saved.receipts[old], undefined);
  assert.equal(s.make().getRound('1').winner, BOB);
});

test('confirmation cutoff, bounded catch-up, adaptive ranges, and concurrent sync are explicit', async t => {
  const s = await fixture(t, { chunkSize: 50, maxBlocksPerSync: 10 }); s.network.rangeLimit = 3;
  s.add(1, [['RoundStarted', [1, 1900000000]]]); s.add(35, [['Settled', [1, ALICE, 123]]]);
  const first = s.history.sync(); assert.equal(first, s.history.sync()); await first;
  assert.equal(s.history.getStatus().indexedThrough, B + 9); assert.equal(s.history.getStatus().state, 'syncing');
  await s.history.sync(); await s.history.sync();
  assert.equal(s.history.getStatus().state, 'ready'); assert.equal(s.history.getRound('1').winner, null);
  s.network.latest = B + 47; await s.history.sync(); assert.equal(s.history.getRound('1').winner, ALICE);
  s.network.latest = B + 40; await assert.rejects(s.history.sync(), /cannot confirm/);
  assert.equal(s.history.getStatus().state, 'stale');
});

test('receipt inconsistency cannot advance cursor or publish an unverified winner', async t => {
  const s = await fixture(t); s.add(1, [['Settled', [1, ALICE, 0]]]); s.network.corruptReceipt = true;
  await assert.rejects(s.history.sync(), /missing from its receipt/);
  assert.equal(s.history.getStatus().indexedThrough, B - 1); assert.equal(s.history.listRounds().total, 0);
  assert.equal(s.history.getStatus().state, 'stale');
});

test('foreign deployment, changed event ABI, and corrupted cache identity fail closed', async t => {
  const s = await fixture(t);
  assert.throws(() => createChainHistory({ rpc: s.rpc, abi, storagePath: s.storagePath, gameAddress: ALICE }));
  assert.throws(() => createChainHistory({ rpc: s.rpc, abi: [], storagePath: s.storagePath }), /Unexpected production event ABI/);
  const renamed = structuredClone(abi);
  renamed.find(item => item.type === 'event' && item.name === 'RoundStarted').inputs[0].name = 'unrecognizedRoundId';
  assert.throws(() => createChainHistory({ rpc: s.rpc, abi: renamed, storagePath: s.storagePath }), /Unexpected production event ABI/);
  await s.history.sync(); const saved = JSON.parse(await fs.readFile(s.storagePath, 'utf8')); saved.chainId = 97;
  await fs.writeFile(s.storagePath, JSON.stringify(saved)); assert.throws(s.make, /History identity mismatch/);
});
