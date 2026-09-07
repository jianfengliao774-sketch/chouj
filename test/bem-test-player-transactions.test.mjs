import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface, keccak256, toQuantity } from 'ethers';
import { createTestPlayerTransactions, TEST_PLAYER as F, TEST_PLAYER_ABI, TEST_PLAYER_STORAGE_KEY } from '../bem-production-site/web/test-player-transactions.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
const TXHASH = '0x' + 'a'.repeat(64), OTHERHASH = '0x' + 'b'.repeat(64), ZERO = '0x' + '0'.repeat(40);
const GAME = new Interface(TEST_PLAYER_ABI), TOKEN = new Interface(['function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)', 'event Approval(address indexed owner,address indexed spender,uint256 value)']);
const VRF = new Interface(['function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)']);
const artifact = JSON.parse(fs.readFileSync(new URL('../outputs/bem-raffle-2075/production-v2/Bem2075Raffle13061Test1BSC.artifact.json', import.meta.url)));
// Fixed immutable words read from the deployed test address. No network in tests.
const immutableValues = {
  51: F.processor.slice(2), 53: '081b', 55: F.container.slice(2), 849: '2710', 871: '05f5e100',
  873: '0f4240', 875: '3d0900', 877: '05a995c0', 963: F.bem.slice(2), 966: F.coordinator.slice(2),
  968: F.recipient.slice(2), 970: F.subscriptionId.toString(16),
  972: '130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4',
  974: '03', 976: '03d090', 978: '015180', 980: '0e10', 982: '072d6834',
};
let CODE = artifact.deployedBytecode.toLowerCase();
for (const [id, locations] of Object.entries(artifact.immutableReferences)) for (const { start, length } of locations) {
  assert.equal(length, 32); const word = immutableValues[id].toLowerCase().padStart(64, '0');
  CODE = CODE.slice(0, 2 + start * 2) + word + CODE.slice(2 + (start + length) * 2);
}
assert.equal(keccak256(CODE), F.runtimeHash, 'Fixture must represent the exact deployed contract, not a relaxed hash check');
const blockHash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const memoryStorage = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; };
function createLocks() {
  let tail = Promise.resolve();
  return { request(_name, operation) { const next = tail.then(operation); tail = next.catch(() => {}); return next; } };
}
function setup(overrides = {}) {
  const state = { tip: 100n, timestamp: 1000n, currentRound: 1n, roundStatus: 1, sold: 20n, fundingDeadline: 2000n,
    count: 2n, authorized: true, consumer: true, burned: false, balance: 100000000n, allowance: 10000000n,
    native: 10n ** 18n, nonce: 7n, chain: '0x38', walletChain: '0x38', walletAccount: ACCOUNT,
    code: CODE, estimate: 100000n, gasPrice: 50000000n, scheduledAt: 900n, ...overrides };
  const storage = overrides.storage ?? memoryStorage(), locks = overrides.locks ?? createLocks();
  const context = { poolId: '1', epoch: 1, account: ACCOUNT, chainId: 56, selection: { mode: 'auto', count: '2', text: '' } };
  const reads = [], walletReads = [], sent = [], receipts = new Map(), transactions = new Map();
  let hook = null, sendHook = null, estimateCalls = 0;
  const wallet = { async request({ method, params }) {
    walletReads.push(method);
    if (method === 'eth_accounts') return [state.walletAccount];
    if (method === 'eth_chainId') return state.walletChain;
    assert.equal(method, 'eth_sendTransaction'); sent.push(params[0]);
    if (sendHook) return sendHook(params[0]);
    return TXHASH;
  } };
  const fixed = { bem: F.bem, coordinator: F.coordinator, CIRCUITS: F.processor, CIRCUIT_ID: 2075n,
    CONTAINER: F.container, organizer: F.recipient, TEST_ONLY: true, TICKET_PRICE: F.ticketPrice,
    ROUND_POOL: F.pool, TICKETS_PER_ROUND: 10000n, MAX_TICKETS_PER_PURCHASE: 1000n,
    MAX_TICKETS_PER_ADDRESS: 5000n, fundingWindow: 86400n, REFUND_CLAIM_WINDOW: 86400n, subscriptionId: F.subscriptionId };
  async function rpc(method, params) {
    reads.push({ method, params }); if (hook) await hook(method, params);
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getBlockByNumber') { const number = params[0] === 'latest' ? state.tip : BigInt(params[0]);
      return { number: toQuantity(number), hash: state.reorg ? blockHash(number + 1n) : blockHash(number), timestamp: toQuantity(state.timestamp),
        transactions: [...transactions.values()].filter(tx => tx.blockNumber != null && BigInt(tx.blockNumber) === number).map(tx => tx.hash) }; }
    if (method === 'eth_getCode') return state.code;
    if (method === 'eth_getBalance') return toQuantity(state.native);
    if (method === 'eth_getTransactionCount') return toQuantity(state.nonce);
    if (method === 'eth_gasPrice') return toQuantity(state.gasPrice);
    if (method === 'eth_estimateGas') { estimateCalls++; return toQuantity(typeof state.estimate === 'function' ? state.estimate(estimateCalls) : state.estimate); }
    if (method === 'eth_getTransactionByHash') return transactions.get(params[0]) ?? null;
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0]) ?? null;
    assert.equal(method, 'eth_call');
    const [{ to, data }] = params;
    const iface = to.toLowerCase() === F.bem.toLowerCase() ? TOKEN : to.toLowerCase() === F.coordinator.toLowerCase() ? VRF : GAME;
    const parsed = iface.parseTransaction({ data }); let value;
    if (parsed.name in fixed) value = [fixed[parsed.name]];
    else switch (parsed.name) {
      case 'decimals': value = [state.decimals ?? 8]; break;
      case 'balanceOf': value = [state.balance]; break;
      case 'allowance': value = [state.allowance]; break;
      case 'getSubscription': value = [0n, 10000000000000000n, 0n, ACCOUNT, state.consumer ? [F.address] : []]; break;
      case 'seriesAuthorized': value = [state.authorized]; break;
      case 'currentRoundId': value = [state.currentRound]; break;
      case 'rounds': value = [state.roundStatus, state.sold, state.fundingDeadline, 0n, 1n, 0n, 0n, 0n, 0n, ZERO]; break;
      case 'drawTiming': value = [800n, 860n, state.scheduledAt, 0n]; break;
      case 'refundClaimDeadline': value = [state.fundingDeadline === 0n ? 0n : state.fundingDeadline + 86400n]; break;
      case 'unclaimedPrincipalBurned': value = [state.burned]; break;
      case 'ticketsOf': value = [state.count]; break;
      case 'approve': value = [true]; break;
      case 'buy': case 'buySelected': value = [parsed.args[0]]; break;
      case 'refund': case 'settle': value = []; break;
      default: assert.fail('Unhandled call: ' + parsed.name);
    }
    return iface.encodeFunctionResult(parsed.fragment, value);
  }
  const options = { wallet: () => wallet, getContext: () => context, readRpc: rpc, storage, locks };
  const manager = createTestPlayerTransactions(options);
  function event(name, args, index = 0) {
    const iface = name === 'Approval' ? TOKEN : GAME, encoded = iface.encodeEventLog(iface.getEvent(name), args);
    return { ...encoded, address: name === 'Approval' ? F.bem : F.address, transactionHash: TXHASH,
      blockNumber: '0x64', blockHash: blockHash(100), logIndex: toQuantity(index), removed: false };
  }
  function mine(logs, status = 1, txChanges = {}, receiptChanges = {}) {
    const tx = { ...sent.at(-1), input: sent.at(-1).data, hash: TXHASH, blockNumber: '0x64', blockHash: blockHash(100), ...txChanges };
    transactions.set(TXHASH, tx); receipts.set(TXHASH, { transactionHash: TXHASH, from: tx.from, to: tx.to,
      blockNumber: tx.blockNumber, blockHash: tx.blockHash, status: toQuantity(status), logs, ...receiptChanges }); state.tip = 111n;
  }
  return { state, context, manager, options, wallet, storage, locks, sent, reads, walletReads, fixed, transactions, receipts,
    event, mine, setHook: fn => hook = fn, setSendHook: fn => sendHook = fn };
}
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);

test('financial calls, reads and event indexing match the frozen deployed artifact ABI', () => {
  const compiled = new Interface(artifact.abi);
  for (const fragment of GAME.fragments) {
    const target = fragment.type === 'function' ? compiled.getFunction(fragment.name) : compiled.getEvent(fragment.name);
    assert.equal(fragment.format('sighash'), target.format('sighash'));
    assert.deepEqual(fragment.inputs.map(i => [i.type, !!i.indexed]), target.inputs.map(i => [i.type, !!i.indexed]));
    if (fragment.type === 'function') {
      assert.equal(fragment.stateMutability, target.stateMutability);
      assert.deepEqual(fragment.outputs.map(i => i.type), target.outputs.map(i => i.type));
    }
  }
});

test('state reads are fixed-block, verify exact runtime and rules, and never request accounts or send', async () => {
  const s = setup(); const r = await s.manager.readState(ACCOUNT);
  assert.equal(r.roundId, 1n); assert.equal(r.round.status, 1); assert.equal(r.round.sold, 20n); assert.equal(r.bemBalance, 100000000n);
  assert.equal(r.canBuy, true); assert.equal(r.canRefund, false); assert.equal(s.walletReads.length, 0);
  assert.ok(s.reads.filter(x => x.method === 'eth_call').every(x => x.params.length === 2 && x.params[1] === '0x64'));
  s.state.code = '0x6000'; await rejects(() => s.manager.readState(ACCOUNT), 'RUNTIME_MISMATCH');
  s.state.code = CODE; s.fixed.TICKET_PRICE = 1000000n; await rejects(() => s.manager.readState(ACCOUNT), 'FIXED_RULE_MISMATCH');
  assert.equal(s.sent.length, 0);
});

test('approve authorizes only the chosen amount, requires a separate buy click and need not have an active series', async () => {
  const s = setup({ authorized: false, consumer: false, allowance: 0n });
  await s.manager.execute('approve', { roundId: 1n, quantity: 2 });
  assert.equal(s.sent.length, 1); const tx = s.sent[0];
  assert.equal(tx.to, F.bem); assert.equal(tx.value, '0x0'); assert.equal(tx.nonce, '0x7');
  assert.deepEqual([...TOKEN.parseTransaction({ data: tx.data }).args], [F.address, 20000n]);
  assert.equal(BigInt(tx.gas), 120000n); assert.equal(s.manager.getState().blocking, true);
  await rejects(() => s.manager.execute('buy', { roundId: 1n, quantity: 2 }), 'TRANSACTION_UNRESOLVED');
});

test('buy supports 1000 automatic tickets and one-based selected endpoints without implicit approvals', async () => {
  for (const selected of [false, true]) {
    const s = setup(); const quantity = selected ? 2 : 1000, tickets = selected ? [1, 10000] : null;
    s.context.selection = selected ? { mode: 'selected', count: '1', text: '1,10000' } : { mode: 'auto', count: '1000', text: '' };
    await s.manager.execute('buy', { roundId: 1n, quantity, tickets });
    const parsed = GAME.parseTransaction({ data: s.sent[0].data }); assert.equal(parsed.name, selected ? 'buySelected' : 'buy');
    if (selected) assert.deepEqual([...parsed.args[1]], [0n, 9999n]);
    if (!selected) assert.equal(parsed.args[1], 1000n);
    assert.equal(s.sent.length, 1); assert.equal(s.sent[0].to, F.address);
  }
});

test('only test1 pool and the current visible selection can send', async () => {
  const mutations = [s => s.context.poolId = '100', s => s.context.address = OTHER,
    s => s.context.selection.count = '3'];
  for (const mutate of mutations) { const s = setup(); mutate(s); await assert.rejects(() => s.manager.execute('buy', { roundId: 1n, quantity: 2 })); assert.equal(s.sent.length, 0); }
  for (const payload of [{ roundId: 1n, quantity: 1001 }, { roundId: 1n, quantity: 2, tickets: [1, 1] },
    { roundId: 1n, quantity: 2, tickets: [0, 10000] }, { roundId: 1n, quantity: 2, tickets: [10000, 1] }]) {
    const s = setup(); await assert.rejects(() => s.manager.execute('buy', payload)); assert.equal(s.sent.length, 0);
  }
});

test('authorization, consumer, deadline, inventory, cumulative cap, BEM and exact allowance guard buys', async () => {
  const cases = [[{ authorized: false }, 'PURCHASE_UNAVAILABLE'], [{ consumer: false }, 'PURCHASE_UNAVAILABLE'],
    [{ timestamp: 2000n }, 'PURCHASE_UNAVAILABLE'], [{ roundStatus: 3 }, 'PURCHASE_UNAVAILABLE'],
    [{ sold: 9999n }, 'INSUFFICIENT_TICKETS'], [{ count: 4999n }, 'ADDRESS_TICKET_LIMIT'],
    [{ balance: 19999n }, 'INSUFFICIENT_BEM'], [{ allowance: 19999n }, 'APPROVAL_REQUIRED'], [{ native: 0n }, 'INSUFFICIENT_BNB']];
  for (const [values, code] of cases) { const s = setup(values); await rejects(() => s.manager.execute('buy', { roundId: 1n, quantity: 2 }), code); assert.equal(s.sent.length, 0); }
});

test('context, provider account and chain changes while estimating block the wallet transaction', async () => {
  const changes = [s => s.context.epoch++, s => s.context.poolId = '10', s => s.context.selection.text = '9',
    s => s.state.walletAccount = OTHER, s => s.state.walletChain = '0x1'];
  for (const change of changes) {
    const s = setup(); let changed = false; s.setHook(method => { if (method === 'eth_estimateGas' && !changed) { changed = true; change(s); } });
    await assert.rejects(() => s.manager.execute('buy', { roundId: 1n, quantity: 2 })); assert.equal(s.sent.length, 0);
    assert.equal(s.storage.getItem(TEST_PLAYER_STORAGE_KEY), null);
  }
});

test('one fresh gas estimate is buffered, capped, and never split into extra sends', async () => {
  const a = setup({ estimate: 9484958n });
  await a.manager.execute('buy', { roundId: 1n, quantity: 2 }); assert.equal(BigInt(a.sent[0].gas), (9484958n * 120n + 99n) / 100n);
  assert.equal(a.reads.filter(read => read.method === 'eth_estimateGas').length, 1);
  for (const estimate of [0n, 18369353n]) {
    const s = setup({ estimate }); await rejects(() => s.manager.execute('buy', { roundId: 1n, quantity: 2 }), 'GAS_LIMIT_EXCEEDED'); assert.equal(s.sent.length, 0);
  }
  const s = setup({ estimate: 16000000n }); await s.manager.execute('buy', { roundId: 1n, quantity: 2 }); assert.equal(BigInt(s.sent[0].gas), F.gasCap);
});

test('refund is always to the connected user, supports older rounds and the exact 24h claim interval', async () => {
  const s = setup({ authorized: false, consumer: false, currentRound: 2n, timestamp: 2000n });
  const r = await s.manager.readState(ACCOUNT, { roundId: 1n }); assert.equal(r.canRefund, true); assert.equal(r.refundAmount, 20000n);
  await s.manager.execute('refund', { roundId: 1n }); const parsed = GAME.parseTransaction({ data: s.sent[0].data });
  assert.deepEqual([...parsed.args], [1n, ACCOUNT]); assert.equal(s.sent[0].from, ACCOUNT);
  for (const values of [{ timestamp: 1999n }, { timestamp: 88400n }, { timestamp: 2000n, burned: true },
    { timestamp: 2000n, count: 0n }, ...[2, 3, 4, 5].map(roundStatus => ({ timestamp: 2000n, roundStatus }))]) {
    const n = setup(values); await rejects(() => n.manager.execute('refund', { roundId: 1n }), 'REFUND_UNAVAILABLE'); assert.equal(n.sent.length, 0);
  }
});

test('permissionless settlement requires Ready and scheduled time, never automatically runs', async () => {
  const s = setup({ roundStatus: 4, scheduledAt: 1000n }); const r = await s.manager.readState(ACCOUNT); assert.equal(r.canSettle, true);
  assert.equal(s.sent.length, 0); await s.manager.execute('settle', { roundId: 1n }); assert.equal(GAME.parseTransaction({ data: s.sent[0].data }).name, 'settle');
  for (const values of [{ roundStatus: 3 }, { roundStatus: 4, scheduledAt: 1001n }, { roundStatus: 5 }]) {
    const n = setup(values); await rejects(() => n.manager.execute('settle', { roundId: 1n }), 'SETTLEMENT_NOT_DUE');
  }
});

test('durable intent exists before send and wallet unknown errors remain blocked across reload', async () => {
  const s = setup(); s.setSendHook(() => { const row = JSON.parse(s.storage.getItem(TEST_PLAYER_STORAGE_KEY)); assert.equal(row.hash, null); assert.equal(row.nonce, '7'); throw new Error('connection lost'); });
  await assert.rejects(() => s.manager.execute('buy', { roundId: 1n, quantity: 2 })); assert.equal(s.manager.getState().blocking, true);
  const restored = createTestPlayerTransactions(s.options); await restored.checkPending();
  await rejects(() => restored.execute('buy', { roundId: 1n, quantity: 2 }), 'TRANSACTION_UNRESOLVED'); assert.equal(s.sent.length, 1);
});

test('explicit wallet rejection releases intent; missing storage and Web Locks fail before send', async () => {
  const s = setup(); s.setSendHook(() => { const error = new Error('rejected'); error.code = 4001; throw error; });
  await rejects(() => s.manager.execute('buy', { roundId: 1n, quantity: 2 }), 4001); assert.equal(s.manager.getState().blocking, false);
  const unavailable = createTestPlayerTransactions({ ...s.options, storage: null }); await rejects(() => unavailable.execute('buy', { roundId: 1n, quantity: 2 }), 'PENDING_STORAGE_UNAVAILABLE');
  const noLocks = createTestPlayerTransactions({ ...s.options, locks: null }); await rejects(() => noLocks.execute('buy', { roundId: 1n, quantity: 2 }), 'TRANSACTION_LOCK_UNAVAILABLE');
  assert.equal(s.sent.length, 1);
});

test('concurrent modules sharing a tab lock can issue only one request', async () => {
  const s = setup(), second = createTestPlayerTransactions(s.options);
  const results = await Promise.allSettled([s.manager.execute('buy', { roundId: 1n, quantity: 2 }), second.execute('buy', { roundId: 1n, quantity: 2 })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(s.sent.length, 1);
});

test('receipt checking holds the same cross-tab lock and cannot erase the next transaction intent', async () => {
  const s = setup(); await s.manager.execute('buy', { roundId: 1n, quantity: 2 });
  s.mine([s.event('TicketsPurchased', [1n, ACCOUNT, 1n, 3n, 20000n])]); s.state.nonce = 8n;
  let entered, release, blocked = false;
  const reached = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  s.setHook(async method => { if (method === 'eth_getTransactionByHash' && !blocked) { blocked = true; entered(); await gate; } });
  const checking = s.manager.checkPending(); await reached;
  const second = createTestPlayerTransactions(s.options); s.setSendHook(() => OTHERHASH);
  const buying = second.execute('buy', { roundId: 1n, quantity: 2 });
  await Promise.resolve(); assert.equal(s.sent.length, 1);
  release(); await checking; await buying;
  const stored = JSON.parse(s.storage.getItem(TEST_PLAYER_STORAGE_KEY));
  assert.equal(stored.hash, OTHERHASH); assert.equal(stored.nonce, '8'); assert.equal(s.sent.length, 2);
  assert.equal((await s.manager.checkPending()).blocking, true);
  assert.equal(JSON.parse(s.storage.getItem(TEST_PLAYER_STORAGE_KEY)).hash, OTHERHASH);
});

test('selected purchase unlocks on the first verified receipt and accepts actual replacement numbers', async () => {
  const s = setup(); s.context.selection = { mode: 'selected', text: '1,10000', count: '2' };
  await s.manager.execute('buy', { roundId: 1n, quantity: 2, tickets: [1, 10000] });
  assert.equal((await s.manager.checkPending()).blocking, true, 'no receipt remains pending');
  s.mine([s.event('TicketsPurchased', [1n, ACCOUNT, 21n, 23n, 20000n])]); s.state.tip = 100n;
  const r = await s.manager.checkPending(); assert.equal(r.blocking, false); assert.equal(r.records[0].status, 'confirmed');
  assert.equal(r.records[0].confirmations, 1); assert.equal(r.records[0].requiredConfirmations, 1);
  assert.deepEqual(r.records[0].evidence.tickets, [22, 23]); assert.equal(s.sent.length, 1);
});

test('forged transaction identity, nonce, receipt or event cannot clear pending', async () => {
  const cases = [s => s.transactions.get(TXHASH).from = OTHER, s => s.transactions.get(TXHASH).to = OTHER,
    s => s.transactions.get(TXHASH).input = '0x', s => s.transactions.get(TXHASH).nonce = '0x8',
    s => s.transactions.get(TXHASH).value = '0x1', s => s.transactions.get(TXHASH).chainId = '0x1',
    s => s.receipts.get(TXHASH).to = OTHER, s => s.receipts.get(TXHASH).status = '0x2',
    s => s.receipts.get(TXHASH).logs = [s.event('TicketsPurchased', [1n, OTHER, 1n, 3n, 20000n])], s => s.state.reorg = true];
  for (const mutate of cases) {
    const s = setup(); await s.manager.execute('buy', { roundId: 1n, quantity: 2 }); s.mine([s.event('TicketsPurchased', [1n, ACCOUNT, 1n, 3n, 20000n])]); mutate(s);
    const result = await s.manager.checkPending(); assert.equal(result.blocking, true); assert.equal(result.records[0].status, 'unknown');
    assert.equal(s.sent.length, 1);
  }
});

test('confirmed reverted transaction clears only after canonical identity verification', async () => {
  const s = setup(); await s.manager.execute('buy', { roundId: 1n, quantity: 2 }); s.mine([], 0);
  const result = await s.manager.checkPending(); assert.equal(result.blocking, false); assert.equal(result.records[0].status, 'reverted');
});

test('unknown hash recovery rejects same calldata at a higher nonce and accepts exact intent identity', async () => {
  const s = setup(); s.setSendHook(() => { throw new Error('timeout'); });
  await assert.rejects(() => s.manager.execute('buy', { roundId: 1n, quantity: 2 }));
  s.mine([s.event('TicketsPurchased', [1n, ACCOUNT, 1n, 3n, 20000n])]);
  const higher = { ...s.transactions.get(TXHASH), hash: OTHERHASH, nonce: '0x8' }; s.transactions.set(OTHERHASH, higher);
  await rejects(() => s.manager.attachHash(OTHERHASH), 'NONCE_MISMATCH'); assert.equal(s.manager.getState().blocking, true);
  const result = await s.manager.attachHash(TXHASH); assert.equal(result.blocking, false); assert.equal(result.records[0].status, 'confirmed');
});

test('successful settlement progress with four rejected attempts clears pending without claiming a payout', async () => {
  const s = setup({ roundStatus: 4 }); await s.manager.execute('settle', { roundId: 1n });
  const logs = Array.from({ length: 4 }, (_, i) => s.event('AttemptEvaluated', [1n, BigInt(8 + i), 0n, 0n, 0n, 0n, 60000n, false], i));
  logs.push(s.event('DrawProgress', [1n, 12n], 4)); s.mine(logs);
  const result = await s.manager.checkPending(); assert.equal(result.blocking, false); assert.deepEqual(result.records[0].evidence, { progress: true, nextCursor: '12' });
  assert.equal(result.records[0].evidence.winner, undefined);
});

test('exact approve and self-refund receipts confirm, altered paid amounts stay unknown', async () => {
  const a = setup({ allowance: 0n }); await a.manager.execute('approve', { roundId: 1n, quantity: 2 });
  a.mine([a.event('Approval', [ACCOUNT, F.address, 20000n])]); a.state.tip = 100n;
  assert.equal((await a.manager.checkPending()).blocking, false);
  const b = setup({ timestamp: 2000n }); await b.manager.execute('refund', { roundId: 1n });
  b.mine([b.event('Refunded', [1n, ACCOUNT, 20000n])]); b.state.tip = 100n;
  assert.equal((await b.manager.checkPending()).blocking, true, 'refund retains its independent confirmation threshold');
  b.state.tip = 111n; assert.equal((await b.manager.checkPending()).blocking, false);
  const c = setup(); await c.manager.execute('buy', { roundId: 1n, quantity: 2 });
  c.mine([c.event('TicketsPurchased', [1n, ACCOUNT, 1n, 3n, 10000n])]); assert.equal((await c.manager.checkPending()).blocking, true);
});
