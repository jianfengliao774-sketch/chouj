import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { createChainHistory, HISTORY_GAME } from '../bem-production-site/chain-history.mjs';
import { POOL_DEPLOYMENTS } from '../bem-production-site/web/pool-deployments.js';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const RECEIVER = '0x001f110422F04a90bF7D6eC96714f75046BD7126';
const REVENUE_NFT = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const CONTRACTS = { '1': 'Bem2075Raffle13061Test1BSC', '10': 'Bem2075Raffle13061Pool10BSC',
  '50': 'Bem2075Raffle13061Pool50BSC', '100': 'Bem2075Raffle13061BSC' };
const abis = Object.fromEntries(await Promise.all(Object.entries(CONTRACTS).map(async ([id, name]) => [id,
  JSON.parse(await fs.readFile(new URL(`../outputs/bem-raffle-2075/production-v2/${name}.abi.json`, import.meta.url), 'utf8'))])));
const legacyAbi = JSON.parse(await fs.readFile(new URL('../outputs/bem-raffle-2075/production/Bem2075RaffleBSC.abi.json', import.meta.url), 'utf8'));
const hash = value => keccak256(toUtf8Bytes(value));
const hex = value => '0x' + BigInt(value).toString(16);

async function fixture(t, poolId = '1', options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bem-v2-history-'));
  t.after(async () => {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('bem-v2-history-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const profile = POOL_DEPLOYMENTS[poolId], B = profile.deploymentBlock, abi = abis[poolId], iface = new Interface(abi);
  const price = BigInt(poolId) * 10000n, pool = BigInt(poolId) * 100000000n;
  const storagePath = path.join(directory, 'history.json');
  const network = { latest: B + 40, branchAt: Infinity, branch: 0, txs: [], calls: [],
    extraLogs: [], corruptReceipt: false, interval: 1 };
  const blockHash = n => hash(`v2:${poolId}:block:${n}:${n >= network.branchAt ? network.branch : 0}`);
  const timestamp = n => 1800000000 + (n - B) * network.interval;
  const block = n => ({ number: hex(n), hash: blockHash(n), parentHash: blockHash(n - 1), timestamp: hex(timestamp(n)) });
  function add(offset, definitions, from = ALICE) {
    const n = B + offset, txIndex = network.txs.filter(tx => tx.blockNumber === n).length;
    const transactionHash = hash(`v2:${poolId}:tx:${n}:${txIndex}:${network.branch}:${JSON.stringify(definitions, (_, value) => typeof value === 'bigint' ? value.toString() : value)}`);
    const logs = definitions.map(([name, args], index) => ({ ...iface.encodeEventLog(iface.getEvent(name), args),
      address: profile.address, blockNumber: hex(n), blockHash: blockHash(n), transactionHash,
      transactionIndex: hex(txIndex), logIndex: hex(txIndex * 100 + index), removed: false }));
    network.txs.push({ hash: transactionHash, blockNumber: n, receipt: { transactionHash, blockNumber: hex(n),
      blockHash: blockHash(n), transactionIndex: hex(txIndex), status: '0x1', from, to: profile.address, logs } });
    return transactionHash;
  }
  function completeRound({ winner = BOB, winningTicket = 5365 } = {}) {
    add(0, [['RevenueBindingFixed', [RECEIVER, REVENUE_NFT, 13061]], ['RoundStarted', [1, 1800086400]]]);
    for (let i = 0; i < 10; i++) {
      const buyer = i < 5 ? ALICE : BOB;
      const events = [['TicketsPurchased', [1, buyer, i * 1000, (i + 1) * 1000, price * 1000n]]];
      if (i === 9) events.push(['RoundLocked', [1, 1800003610]], ['DrawWindowOpened', [1, 1800000010, 1800000070]], ['DrawRequested', [1, 123n]]);
      add(i + 1, events, buyer);
    }
    add(11, [['RandomnessReceived', [1, 123n, 111n, 222n]], ['DrawScheduled', [1, 1800000012, 1800000070]]]);
    return add(12, [['AttemptEvaluated', [1, 0, 17, 243, 20, 245, winningTicket, true]],
      ['BlackholeTransfer', [1, pool * 4n / 100n]], ['Settled', [1, winner, winningTicket]],
      ['NextRoundScheduled', [1, 2, 1800000072]]]);
  }
  async function rpc(method, params) {
    network.calls.push({ method, params });
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') return block(params[0] === 'latest' ? network.latest : Number(BigInt(params[0])));
    if (method === 'eth_getLogs') {
      const filter = params[0]; assert.equal(filter.address, profile.address, 'Every query must use this pool address');
      const first = Number(BigInt(filter.fromBlock)), last = Number(BigInt(filter.toBlock));
      return structuredClone([...network.txs.filter(tx => tx.blockNumber >= first && tx.blockNumber <= last).flatMap(tx => tx.receipt.logs),
        ...network.extraLogs.filter(log => Number(BigInt(log.blockNumber)) >= first && Number(BigInt(log.blockNumber)) <= last)]);
    }
    if (method === 'eth_getTransactionReceipt') {
      const receipt = structuredClone(network.txs.find(tx => tx.hash === params[0])?.receipt ?? null);
      if (receipt && network.corruptReceipt) receipt.logs = [];
      return receipt;
    }
    assert.fail(`History must never issue ${method}`);
  }
  const make = (changes = {}) => createChainHistory({ rpc, poolId, gameAddress: profile.address,
    deploymentBlock: B, abi, storagePath, chunkSize: 5, maxBlocksPerSync: 400, ...options, ...changes });
  return { poolId, profile, B, price, pool, abi, iface, storagePath, network, block, add, completeRound, rpc, make, history: make() };
}

test('each deployed denomination indexes its own complete lifecycle and publishes its exact 95% prize', async t => {
  for (const poolId of ['1', '10', '50', '100']) {
    const s = await fixture(t, poolId), settlement = s.completeRound();
    await s.history.sync(); const round = s.history.getRound('1'), announcement = s.history.listAnnouncements().rows[0];
    assert.equal(round.status, 5); assert.equal(round.sold, 10000); assert.equal(round.raisedBaseUnits, s.pool.toString());
    assert.equal(round.blackholeBaseUnits, (s.pool * 4n / 100n).toString());
    assert.equal(announcement.poolId, poolId); assert.equal(announcement.gameAddress, s.profile.address);
    assert.equal(announcement.poolBaseUnits, s.pool.toString()); assert.equal(announcement.amountBaseUnits, (s.pool * 95n / 100n).toString());
    assert.equal(announcement.winner, BOB); assert.equal(announcement.transactionHash, settlement);
    const burn = s.history.listBurns({ all: true }).rows[0];
    assert.equal(burn.amountBaseUnits, (s.pool * 4n / 100n).toString()); assert.equal(burn.kind, 'settlement');
    assert.equal(burn.gameAddress, s.profile.address); assert.equal(burn.destination, DEAD);
    assert.equal(s.history.listAnnouncements({ all: true }).total, 1);
    const admin = s.history.getAdminSummary({ now: 1800000012000 });
    assert.equal(admin.completedCount, 1); assert.equal(admin.todayCompletedCount, 1); assert.equal(admin.purchaseCount, 10); assert.equal(admin.walletCount, 2);
    const purchases = s.history.getAdminRound('1', { wallet: BOB, pageSize: 3 });
    assert.equal(purchases.round.fillSeconds, 10); assert.equal(purchases.round.purchaseCount, 10);
    assert.equal(purchases.wallets.total, 2); assert.equal(purchases.wallets.rows.find(row => row.address === BOB).tickets, 5000);
    assert.equal(purchases.purchases.total, 5); assert.equal(purchases.purchases.rows.length, 3);
    assert.ok(purchases.purchases.rows.every(row => row.buyer === BOB && row.paidBaseUnits === (s.price * 1000n).toString()));
    assert.equal(s.history.listAdminRounds({ pageSize: 1 }).rows[0].purchases, undefined);
    assert.ok(s.network.calls.every(call => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getTransactionReceipt'].includes(call.method)));
    const restored = s.make(); await restored.sync(); assert.equal(restored.getRound('1').events.length, round.events.length);
    assert.equal(restored.listAnnouncements().rows[0].amountBaseUnits, announcement.amountBaseUnits);
  }
});

test('unclaimed principal burn preserves its actual amount and is distinct from a settlement burn', async t => {
  const s = await fixture(t, '1'); s.network.interval = 8640;
  s.add(0, [['RoundStarted', [1, 1800086400]]]);
  s.add(1, [['TicketsPurchased', [1, ALICE, 0, 1000, 1000n * s.price]]]);
  s.add(2, [['TicketsPurchased', [1, BOB, 1000, 1500, 500n * s.price]]], BOB);
  const refund = s.add(10, [['RefundsOpened', [1]], ['Refunded', [1, ALICE, 1000n * s.price]], ['NextRoundScheduled', [1, 2, 1800086460]]]);
  const unclaimed = s.add(20, [['UnclaimedPrincipalBurned', [1, 500n * s.price]]]);
  await s.history.sync();
  assert.equal(s.history.listAnnouncements().total, 0, 'Failed funding must never become a winning announcement');
  const rows = s.history.listBurns({ all: true }).rows; assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'unclaimed'); assert.equal(rows[0].amountBaseUnits, '5000000');
  assert.notEqual(rows[0].amountBaseUnits, '4000000', 'Unclaimed principal is not the fixed 4% payout');
  assert.equal(rows[0].poolId, '1'); assert.equal(rows[0].transactionHash, unclaimed);
  const round = s.history.getRound(1); assert.equal(round.status, 6); assert.equal(round.refundedBaseUnits, '10000000');
  assert.deepEqual(round.proof.refundTxHashes, [refund]);
  assert.ok(round.events.some(event => event.name === 'UnclaimedPrincipalBurned' && event.transactionHash === unclaimed));
  assert.equal(s.history.listTransactions({ roundId: '1' }).transactions[0].receipt.transactionHash, unclaimed);
});

test('new profiles reject foreign addresses, swapped deployment blocks, old ABI, changed event indexing and cache cross-use', async t => {
  const s = await fixture(t, '10');
  assert.throws(() => s.make({ gameAddress: HISTORY_GAME }));
  assert.throws(() => s.make({ gameAddress: POOL_DEPLOYMENTS['1'].address }));
  assert.throws(() => s.make({ deploymentBlock: POOL_DEPLOYMENTS['1'].deploymentBlock }));
  assert.throws(() => s.make({ poolId: '2' }), /Unknown history profile/);
  assert.throws(() => s.make({ abi: legacyAbi }), /Unexpected production event ABI/);
  const altered = structuredClone(s.abi);
  altered.find(item => item.type === 'event' && item.name === 'UnclaimedPrincipalBurned').inputs[0].indexed = false;
  assert.throws(() => s.make({ abi: altered }), /Unexpected production event ABI/);
  await s.history.sync();
  assert.throws(() => s.make({ poolId: '1', gameAddress: POOL_DEPLOYMENTS['1'].address,
    deploymentBlock: POOL_DEPLOYMENTS['1'].deploymentBlock, abi: abis['1'] }), /History identity mismatch/);
});

test('RPC logs from another real pool cannot pollute winners or burns, even with the same event ABI', async t => {
  const s = await fixture(t, '1');
  s.add(1, [['BlackholeTransfer', [1, 4000000]], ['Settled', [1, ALICE, 5]]]);
  const foreign = structuredClone(s.network.txs[0].receipt.logs[0]); foreign.address = POOL_DEPLOYMENTS['10'].address;
  s.network.extraLogs.push(foreign);
  await assert.rejects(s.history.sync(), /foreign game log/);
  assert.equal(s.history.getStatus().indexedThrough, s.B - 1); assert.equal(s.history.listAnnouncements().total, 0);
  assert.equal(s.history.listBurns().total, 0); assert.equal(s.history.getStatus().state, 'stale');
});

test('an unclaimed burn without matching successful receipt evidence cannot advance the index', async t => {
  const s = await fixture(t, '10'); s.add(1, [['UnclaimedPrincipalBurned', [1, 9000000]]]);
  s.network.corruptReceipt = true;
  await assert.rejects(s.history.sync(), /missing from its receipt/);
  assert.equal(s.history.getStatus().indexedThrough, s.B - 1); assert.equal(s.history.listBurns().total, 0);
});

test('reorg withdraws old payout and unclaimed-burn announcements and erases orphaned receipt cache', async t => {
  const s = await fixture(t, '10'), oldSettlement = s.completeRound();
  s.add(13, [['RoundStarted', [2, 1800086500]]]);
  s.add(14, [['TicketsPurchased', [2, ALICE, 0, 100, 100n * s.price]]]);
  s.add(24, [['RefundsOpened', [2]]]);
  const oldUnclaimed = s.add(25, [['UnclaimedPrincipalBurned', [2, 100n * s.price]]]);
  await s.history.sync(); assert.equal(s.history.listBurns().total, 2);
  assert.equal(s.history.getAdminSummary().roundCount, 2);
  assert.equal(s.history.getAdminRound('2').round.purchaseCount, 1);
  s.network.branchAt = s.B + 12; s.network.branch = 1;
  s.network.txs = s.network.txs.filter(tx => tx.blockNumber < s.network.branchAt);
  const replacement = s.add(12, [['BlackholeTransfer', [1, s.pool * 4n / 100n]], ['Settled', [1, ALICE, 0]]]);
  await s.history.sync();
  const announcement = s.history.listAnnouncements().rows[0]; assert.equal(announcement.winner, ALICE);
  assert.equal(announcement.amountBaseUnits, '950000000'); assert.equal(announcement.transactionHash, replacement);
  const burns = s.history.listBurns({ all: true }).rows; assert.equal(burns.length, 1); assert.equal(burns[0].transactionHash, replacement);
  assert.ok(!burns.some(row => [oldSettlement, oldUnclaimed].includes(row.transactionHash)));
  assert.equal(s.history.getRound('2'), null);
  assert.equal(s.history.getAdminRound('2'), null, 'An orphaned participation round must leave the admin cache');
  assert.equal(s.history.getAdminSummary().roundCount, 1);
  assert.equal(s.history.getAdminRound('1').round.settlementTxHash, replacement);
  const saved = JSON.parse(await fs.readFile(s.storagePath, 'utf8'));
  assert.equal(saved.receipts[oldSettlement], undefined); assert.equal(saved.receipts[oldUnclaimed], undefined);
  const restarted = s.make(); await restarted.sync(); assert.equal(restarted.listBurns().total, 1);
  assert.equal(restarted.listAnnouncements().rows[0].transactionHash, replacement);
});

test('recent V2 burn and winner remain unpublished until the configured confirmation cutoff', async t => {
  const s = await fixture(t, '1');
  const tx = s.add(35, [['BlackholeTransfer', [1, 4000000]], ['Settled', [1, BOB, 9999]]]);
  await s.history.sync(); assert.equal(s.history.listBurns().total, 0); assert.equal(s.history.listAnnouncements().total, 0);
  assert.equal(s.history.getAdminSummary().completedCount, 0);
  s.network.latest = s.B + 47; await s.history.sync();
  assert.equal(s.history.listBurns().rows[0].transactionHash, tx);
  assert.equal(s.history.listAnnouncements().rows[0].amountBaseUnits, '95000000');
  assert.equal(s.history.getAdminSummary().completedCount, 1);
});


test('personal purchases survive an index restart and include only receipt-confirmed records for that wallet and round', async t => {
  const s = await fixture(t, '1'); s.completeRound(); await s.history.sync();
  const records = s.history.walletParticipation(ALICE);
  assert.equal(records.length, 1); assert.equal(records[0].tickets, 5000); assert.equal(records[0].purchaseCount, 5);
  assert.equal(records[0].paidBaseUnits, '50000000');
  assert.ok(records[0].purchases.every(row => row.buyer === ALICE));
  assert.deepEqual(s.history.walletParticipation(ALICE, '2'), []);
  const restarted = s.make(); assert.deepEqual(restarted.walletParticipation(ALICE), records);
  s.add(39, [['TicketsPurchased', [2, ALICE, 0, 100, 1000000n]]]);
  await restarted.sync(); assert.deepEqual(restarted.walletParticipation(ALICE, '2'), []);
});
