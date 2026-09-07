import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface, keccak256, toQuantity } from 'ethers';
import vm from 'node:vm';
import { getAddress, formatUnits } from 'ethers';
import { previewPoolSelection } from '../bem-production-site/web/player-v2-state.js';
import { FORMAL_PLAYER_PROFILES, getFormalPlayerProfile } from '../bem-production-site/web/formal-player-profiles.js';
import { createFormalPlayerTransactions as realFactory } from '../bem-production-site/web/formal-player-transactions.js';
import { verifyWalletTransactionEnvelope } from '../bem-production-site/web/wallet-transaction-envelope.js';
import { enforcePurchaseGasBudget } from '../bem-production-site/web/purchase-gas-policy.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
const TXHASH = '0x' + 'a'.repeat(64), OTHERHASH = '0x' + 'b'.repeat(64), ZERO = '0x' + '0'.repeat(40);
const CODE = '0x6001600055';
// Isolated fixture only: the production address table stays empty and rejects sends.
const F = Object.freeze({ poolId: '10', chainId: 56n, address: '0x4444444444444444444444444444444444444444', runtimeHash: keccak256(CODE),
  bem: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a', coordinator: '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9',
  subscriptionId: 77582411398321098948652233841078712279496169525251928512909841261362926957679n,
  container: '0x001f110422F04a90bF7D6eC96714f75046BD7126', recipient: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  authorizationNft: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', authorizationTokenId: 13061n,
  processor: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C', ticketPrice: 100000n, pool: 1000000000n, gasCap: 16777216n });
const context = vm.createContext({ Interface, getAddress, keccak256, toQuantity, previewPoolSelection, verifyWalletTransactionEnvelope, enforcePurchaseGasBudget,
  getFormalPlayerProfile: id => id === '10' ? F : null, setTimeout, clearTimeout, JSON, crypto: globalThis.crypto });
const source = fs.readFileSync(new URL('../bem-production-site/web/formal-player-transactions.js', import.meta.url), 'utf8');
vm.runInContext(source.replace(/^import .*;$/gm, '').replace(/^export /gm, '') +
  '\nthis.exports = { createFormalPlayerTransactions, FORMAL_PLAYER_ABI, formalPlayerStorageKey, isVerifiedFormalResult };', context);
const { createFormalPlayerTransactions, FORMAL_PLAYER_ABI, formalPlayerStorageKey, isVerifiedFormalResult } = context.exports;
context.formatUnits = formatUnits;
vm.runInContext(fs.readFileSync(new URL('../bem-production-site/web/partial-fill-result.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '\nthis.popupExports = { partialFillMessage, createPartialFillResult };', context);
const { partialFillMessage, createPartialFillResult } = context.popupExports;
const STORAGE_KEY = formalPlayerStorageKey('10');
const GAME = new Interface(FORMAL_PLAYER_ABI), TOKEN = new Interface(['function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)', 'event Approval(address indexed owner,address indexed spender,uint256 value)']);
const VRF = new Interface(['function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)']);
const blockHash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const memoryStorage = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; };
function createLocks() {
  let tail = Promise.resolve();
  return { request(_name, operation) { const next = tail.then(operation); tail = next.catch(() => {}); return next; } };
}
function setup(overrides = {}) {
  const state = { tip: 100n, timestamp: 1000n, currentRound: 1n, roundStatus: 1, sold: 20n, fundingDeadline: 2000n,
    count: 2n, authorized: true, consumer: true, burned: false, balance: 100000000n, allowance: 1000000000n,
    native: 10n ** 18n, nonce: 7n, chain: '0x38', walletChain: '0x38', walletAccount: ACCOUNT,
    code: CODE, estimate: 100000n, gasPrice: 50000000n, scheduledAt: 900n, ...overrides };
  const storage = overrides.storage ?? memoryStorage(), locks = overrides.locks ?? createLocks();
  const context = { poolId: '10', epoch: 1, account: ACCOUNT, chainId: 56, selection: { mode: 'auto', count: '2', text: '' } };
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
    CONTAINER: F.container, organizer: F.recipient, PARTIAL_FILL: true, AUTHORIZATION_NFT: F.authorizationNft, AUTHORIZATION_TOKEN_ID: 13061n, TICKET_PRICE: F.ticketPrice,
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
  const options = { poolId: '10', wallet: () => wallet, getContext: () => context, readRpc: rpc, storage, locks };
  const manager = createFormalPlayerTransactions(options);
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

test('formal purchase fee ceiling blocks expensive estimates without sending, and permits a cheaper retry', async()=>{
  const s=setup({estimate:1_000_000n,gasPrice:1_000_000_000n});
  await rejects(()=>s.manager.execute('buy',{roundId:1n,quantity:2}),'GAS_FEE_CAP_EXCEEDED');
  assert.equal(s.sent.length,0);
  s.state.gasPrice=50_000_000n;
  await s.manager.execute('buy',{roundId:1n,quantity:2});
  assert.equal(s.sent.length,1);
  assert.equal(BigInt(s.sent[0].gas),1_200_000n);
  assert.ok(BigInt(s.sent[0].gas)*BigInt(s.sent[0].gasPrice)<=10n**15n);
});

test('unregistered formal pools cannot read or send even with injected old addresses', async () => {
  assert.deepEqual(Object.keys(FORMAL_PLAYER_PROFILES), []); assert.ok(Object.isFrozen(FORMAL_PLAYER_PROFILES));
  for (const poolId of ['10', '50', '100']) {
    assert.equal(getFormalPlayerProfile(poolId), null);
    let requests = 0;
    const manager = realFactory({ poolId, profile: F, wallet: { request() { requests++; } },
      readRpc() { requests++; }, getContext: () => ({ poolId, address: F.address }) });
    assert.equal(manager.getState().registered, false); assert.equal(manager.getState().blocking, true);
    await rejects(() => manager.execute('buy', { roundId: 1n, quantity: 1000 }), 'FORMAL_NOT_REGISTERED');
    await rejects(() => manager.readState(ACCOUNT), 'FORMAL_NOT_REGISTERED');
    await manager.checkPending(); assert.equal(requests, 0);
  }
  assert.throws(() => realFactory({ poolId: '1' }), /FORMAL_POOL_ONLY/);
  assert.notEqual(formalPlayerStorageKey('10'), formalPlayerStorageKey('50'));
});

test('registered V3 fixture requires exact runtime, container binding and partial-fill getter', async () => {
  const s = setup(); assert.equal((await s.manager.readState(ACCOUNT)).canBuy, true);
  assert.equal(s.walletReads.length, 0);
  assert.ok(s.reads.filter(x => x.method === 'eth_call').every(x => x.params[1] === '0x64'));
  s.state.code = '0x6000'; await rejects(() => s.manager.readState(ACCOUNT), 'RUNTIME_MISMATCH');
  s.state.code = CODE; s.fixed.PARTIAL_FILL = false; await rejects(() => s.manager.readState(ACCOUNT), 'FIXED_RULE_MISMATCH');
  s.fixed.PARTIAL_FILL = true; s.fixed.CONTAINER = OTHER; await rejects(() => s.manager.readState(ACCOUNT), 'FIXED_RULE_MISMATCH');
  assert.equal(s.sent.length, 0);
});

test('formal transaction functions and purchase-result indexing match all compiled V3 artifacts', () => {
  for (const poolId of ['10', '50', '100']) {
    const artifact = JSON.parse(fs.readFileSync(new URL(`../outputs/bem-raffle-2075/production-v3/BemOwnContainer13061Pool${poolId}BSC.artifact.json`, import.meta.url)));
    const compiled = new Interface(artifact.abi);
    assert.equal(artifact.contractVersion, 3); assert.equal(artifact.fixedRules.partialFill, true);
    for (const fragment of GAME.fragments) {
      const target = fragment.type === 'function' ? compiled.getFunction(fragment.name) : compiled.getEvent(fragment.name);
      assert.equal(fragment.format('sighash'), target.format('sighash'));
      assert.deepEqual(fragment.inputs.map(i => [i.type, !!i.indexed]), target.inputs.map(i => [i.type, !!i.indexed]));
      if (fragment.type === 'function') assert.deepEqual(fragment.outputs.map(i => i.type), target.outputs.map(i => i.type));
    }
  }
});

async function purchase(s, quantity = 1000, selected = false) {
  s.context.selection = selected ? { mode: 'selected', count: '1', text: `1-${quantity}` } : { mode: 'auto', count: String(quantity), text: '' };
  await s.manager.execute('buy', { roundId: 1n, quantity, tickets: selected ? Array.from({ length: quantity }, (_, i) => i + 1) : null });
}
function logs(s, requested, filled, first = 9200n) {
  return [...(filled ? [s.event('TicketsPurchased', [1n, ACCOUNT, first, first + BigInt(filled), BigInt(filled) * F.ticketPrice])] : []),
    s.event('PurchaseResult', [1n, ACCOUNT, requested, filled, BigInt(filled) * F.ticketPrice, BigInt(requested - filled) * F.ticketPrice], 1)];
}

test('1000 requested with 800 remaining sends the original request and confirms only 800 paid', async () => {
  for (const selected of [false, true]) {
    const s = setup({ sold: 9200n, balance: 800n * F.ticketPrice, allowance: 800n * F.ticketPrice });
    await purchase(s, 1000, selected); assert.equal(s.sent.length, 1);
    const call = GAME.parseTransaction({ data: s.sent[0].data });
    assert.equal(call.name, selected ? 'buySelected' : 'buy');
    assert.equal(selected ? call.args[1].length : Number(call.args[1]), 1000);
    let result = await s.manager.checkPending(); assert.equal(result.blocking, true); assert.equal(isVerifiedFormalResult(result.records[0]), false);
    s.mine(logs(s, 1000, 800)); s.state.tip = 100n; result = await s.manager.checkPending();
    assert.equal(result.blocking, false); const record = result.records[0];
    assert.equal(record.confirmations, 1); assert.equal(record.requiredConfirmations, 1);
    assert.equal(isVerifiedFormalResult(record), true); assert.ok(Object.isFrozen(record)); assert.ok(Object.isFrozen(record.evidence));
    assert.equal(record.evidence.requested, '1000'); assert.equal(record.evidence.filled, '800');
    assert.equal(record.evidence.paid, '80000000'); assert.equal(record.evidence.unspent, '20000000');
    assert.equal(record.evidence.tickets.length, 800); assert.equal(record.evidence.tickets[0], 9201);
    assert.equal(isVerifiedFormalResult({ ...record }), false);
    assert.throws(() => { record.evidence.paid = '0'; }, TypeError);
  }
});

test('remaining quota also reduces actual charge without splitting the purchase', async () => {
  const s = setup({ count: 4700n, sold: 5000n, balance: 300n * F.ticketPrice, allowance: 300n * F.ticketPrice });
  await purchase(s); s.mine(logs(s, 1000, 300, 5000n));
  const result = await s.manager.checkPending(); assert.equal(result.records[0].evidence.filled, '300');
  assert.equal(result.records[0].evidence.unspent, '70000000'); assert.equal(s.sent.length, 1);
});

test('partial purchase can authorize the selected maximum even when the balance covers only available tickets', async () => {
  const s = setup({ sold: 9200n, balance: 800n * F.ticketPrice, allowance: 0n }); s.context.selection.count = '1000';
  await s.manager.execute('approve', { roundId: 1n, quantity: 1000 });
  assert.deepEqual([...TOKEN.parseTransaction({ data: s.sent[0].data }).args], [F.address, 1000n * F.ticketPrice]);
  assert.equal(s.sent.length, 1);
});

test('a last-ticket race records zero fill for the original round and never enters the next one', async () => {
  const s = setup({ sold: 9200n }); let changed = false;
  s.setHook(method => { if (method === 'eth_estimateGas' && !changed) { changed = true; s.state.currentRound = 2n; s.state.sold = 10000n; s.state.roundStatus = 3; s.state.balance = 0n; s.state.allowance = 0n; } });
  await purchase(s); assert.equal(GAME.parseTransaction({ data: s.sent[0].data }).args[0], 1n);
  s.mine(logs(s, 1000, 0)); const record = (await s.manager.checkPending()).records[0];
  assert.equal(record.status, 'confirmed'); assert.equal(record.evidence.filled, '0'); assert.deepEqual(record.evidence.tickets, []);
  assert.equal(record.evidence.paid, '0'); assert.equal(record.evidence.unspent, '100000000'); assert.equal(s.sent.length, 1);
});

test('full purchase result verifies without pretending that money was returned', async () => {
  const s = setup(); await purchase(s, 2); s.mine(logs(s, 2, 2, 21n));
  const record = (await s.manager.checkPending()).records[0];
  assert.equal(record.evidence.paid, '200000'); assert.equal(record.evidence.unspent, '0');
  assert.deepEqual(record.evidence.tickets, [22, 23]); assert.equal(isVerifiedFormalResult(record), true);
});

test('duplicate, missing or inconsistent PurchaseResult evidence remains unresolved', async () => {
  const cases = [events => events.slice(0, 1), events => [...events, events[1]],
    (_events, s) => [s.event('TicketsPurchased', [1n, ACCOUNT, 9200n, 10000n, 80000000n]), s.event('PurchaseResult', [1n, ACCOUNT, 1000, 799, 80000000n, 20000000n])],
    (_events, s) => [s.event('PurchaseResult', [1n, OTHER, 1000, 0, 0n, 100000000n])],
    (_events, s) => [s.event('PurchaseResult', [1n, ACCOUNT, 1000, 0, 0n, 99999999n])]];
  for (const mutate of cases) {
    const s = setup({ sold: 9200n }); await purchase(s); s.mine(mutate(logs(s, 1000, 800), s));
    const result = await s.manager.checkPending(); assert.equal(result.blocking, true); assert.equal(result.records[0].status, 'unknown');
    assert.equal(isVerifiedFormalResult(result.records[0]), false);
  }
});

test('expiry, authorization, balance and allowance still reject non-executable purchases', async () => {
  for (const [values, code] of [[{ timestamp: 2000n }, 'PURCHASE_UNAVAILABLE'], [{ authorized: false }, 'PURCHASE_UNAVAILABLE'],
    [{ consumer: false }, 'PURCHASE_UNAVAILABLE'], [{ balance: 79999999n, sold: 9200n }, 'INSUFFICIENT_BEM'],
    [{ allowance: 79999999n, sold: 9200n }, 'APPROVAL_REQUIRED']]) {
    const s = setup(values); await rejects(() => purchase(s), code); assert.equal(s.sent.length, 0);
  }
});

test('wallet, pool and selection changes during reads prevent any send', async () => {
  for (const mutate of [s => s.context.epoch++, s => s.context.poolId = '50', s => s.state.walletAccount = OTHER,
    s => s.context.selection.count = '999', s => s.state.walletChain = '0x1']) {
    const s = setup(); let changed = false; s.setHook(method => { if (method === 'eth_estimateGas' && !changed) { changed = true; mutate(s); } });
    await assert.rejects(() => purchase(s)); assert.equal(s.sent.length, 0);
  }
});

test('unknown wallet outcome persists a lock across reload and never automatically resends', async () => {
  const s = setup(); s.setSendHook(() => { throw new Error('connection lost'); });
  await assert.rejects(() => purchase(s)); assert.equal(s.sent.length, 1);
  const restored = createFormalPlayerTransactions(s.options); await restored.checkPending();
  await rejects(() => restored.execute('buy', { roundId: 1n, quantity: 1000 }), 'TRANSACTION_UNRESOLVED');
  assert.equal(s.sent.length, 1);
});

test('same pool cross-tab lock permits only one wallet send', async () => {
  const s = setup(), second = createFormalPlayerTransactions(s.options);
  s.context.selection.count = '1000';
  const results = await Promise.allSettled([s.manager.execute('buy', { roundId: 1n, quantity: 1000 }), second.execute('buy', { roundId: 1n, quantity: 1000 })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(s.sent.length, 1);
});

test('principal refunds use actual held tickets and always target the current wallet', async () => {
  const s = setup({ timestamp: 2000n, count: 800n }); const state = await s.manager.readState(ACCOUNT);
  assert.equal(state.refundAmount, 800n * F.ticketPrice); await s.manager.execute('refund', { roundId: 1n });
  assert.deepEqual([...GAME.parseTransaction({ data: s.sent[0].data }).args], [1n, ACCOUNT]);
  s.mine([s.event('Refunded', [1n, ACCOUNT, 800n * F.ticketPrice])]); assert.equal((await s.manager.checkPending()).blocking, false);
});

test('partial-fill copy appears on the first verified receipt and switches between Chinese and English', async () => {
  const s = setup({ sold: 9200n }); await purchase(s);
  assert.equal(partialFillMessage((await s.manager.checkPending()).records[0]), null);
  s.mine(logs(s, 1000, 800)); s.state.tip = 100n; const record = (await s.manager.checkPending()).records[0];
  const zh = partialFillMessage(record), en = partialFillMessage(record, 'en');
  assert.match(zh.quantity, /1000.*800.*200/); assert.match(zh.payment, /0\.8 BEM.*0\.2 BEM.*未扣除/);
  assert.match(en.payment, /not charged and remains in your wallet/);
  assert.equal(en.href, `https://bscscan.com/tx/${TXHASH}`); assert.equal(partialFillMessage({ ...record }), null);
  const full = setup(); await purchase(full, 2); full.mine(logs(full, 2, 2, 21n));
  assert.equal(partialFillMessage((await full.manager.checkPending()).records[0]), null);
});

test('result dialog is shown once per confirmed hash and language refresh changes its visible content', async () => {
  const s = setup({ sold: 9200n }); await purchase(s); s.mine(logs(s, 1000, 800)); const record = (await s.manager.checkPending()).records[0];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.open = false; this.shows = 0; }
    append(child) { this.children.push(child); } setAttribute(name, value) { this[name] = value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    showModal() { this.open = true; this.shows++; } close() { this.open = false; this.listeners.close?.(); }
  }
  const document = { body: new Element('body'), createElement: tag => new Element(tag) }; let lang = 'zh';
  const popup = createPartialFillResult({ document, getLanguage: () => lang });
  popup.accept([{ ...record }]); assert.equal(document.body.children.length, 0);
  popup.accept([record]); const dialog = document.body.children[0]; assert.equal(dialog.open, true);
  assert.equal(dialog.children[0].textContent, '购买结果已确认');
  lang = 'en'; popup.refreshLanguage(); assert.equal(dialog.children[0].textContent, 'Purchase result confirmed');
  assert.equal(dialog.children[4].href, `https://bscscan.com/tx/${TXHASH}`);
  dialog.children[5].listeners.click(); popup.accept([record]); assert.equal(dialog.shows, 1); assert.equal(dialog.open, false);
});

test('MetaMask-wrapped partial purchase verifies the original inner intent and actual PurchaseResult', async () => {
  const s = setup({ sold: 9200n }); await purchase(s);
  const delegation = new Interface(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
  const packed = F.address + '0'.repeat(64) + s.sent[0].data.slice(2);
  const input = delegation.encodeFunctionData('redeemDelegations', [['0x'], ['0x' + '0'.repeat(64)], [packed]]);
  const outer = '0xdb9b1e94b5b69df7e401ddbede43491141047db3';
  s.mine(logs(s, 1000, 800), 1, { to: outer, input, data: undefined, nonce: '0x8', type: '0x4' });
  const result = await s.manager.checkPending(), record = result.records[0];
  assert.equal(result.blocking, false); assert.equal(record.walletWrapped, true); assert.equal(record.to, F.address);
  assert.equal(record.evidence.filled, '800'); assert.equal(record.evidence.unspent, '20000000');
  assert.equal(isVerifiedFormalResult(record), true);
});
