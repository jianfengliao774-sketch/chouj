import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { getAddress, formatEther, toQuantity, zeroPadValue } from 'ethers';
import * as guards from '../bem-production-site/web/start-test-guards.js';

const WEB = new URL('../bem-production-site/web/', import.meta.url);
const CODE = fs.readFileSync(new URL('./fixtures/start-test-runtime.hex', import.meta.url), 'utf8').trim();
const F = guards.START_FIXED, ABI = guards.START_ABI;
const A = '0x304F06903324B8056cB1ED627144EfB2C34df3a8', B = '0x1111111111111111111111111111111111111111';
const HASH = '0x' + 'ab'.repeat(32), STORAGE = 'bem2075-test1-start-configuration-v1';
const bh = n => zeroPadValue(toQuantity(n), 32);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(fn, label) { for (let n = 0; n < 150; n++) { if (fn()) return; await tick(); } throw Error(`Timed out: ${label}`); }
class Element {
  constructor() { this.children = []; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false; this.attributes = {}; this.listeners = new Map(); this.classList = { add() {}, toggle() {} }; }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== fn)); }
  async emit(type, event = {}) { await Promise.all((this.listeners.get(type) ?? []).map(fn => fn({ target: this, ...event }))); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  scrollIntoView() {} click() {}
}
async function harness({ saved = null, consumer = false, storageFailure = false } = {}) {
  const html = fs.readFileSync(new URL('start-test.html', WEB), 'utf8'), elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*)\bid="([^"]+)"[^>]*>/g)) {
    assert.ok(!elements.has(match[3]), `Duplicate actual HTML ID ${match[3]}`); const node = new Element();
    node.hidden = /\bhidden\b/.test(match[0]); node.disabled = /\bdisabled\b/.test(match[0]); elements.set(match[3], node);
  }
  const storage = new Map(saved ? [[STORAGE, JSON.stringify(saved)]] : []), surface = new Element(), wallet = new Element();
  Object.assign(wallet, { account: A, chain: '0x38', consumer, authorized: false, execFee: F.execFeeWei, calls: [], transactions: new Map(), receipt: null, tip: 100n, pendingNonce: 0n, failMethod: null, sendHook: null });
  wallet.on = wallet.addEventListener.bind(wallet);
  wallet.emitAccounts = async accounts => { for (const listener of wallet.listeners.get('accountsChanged') ?? []) await listener(accounts); };
  wallet.request = async ({ method, params = [] }) => {
    wallet.calls.push({ method, params });
    if (wallet.failMethod === method) throw Error('Synthetic RPC unavailable');
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.account];
    if (method === 'eth_chainId') return wallet.chain;
    if (method === 'eth_getCode') return guards.same(params[0], F.game) ? wallet.code ?? CODE : '0x60006000';
    if (method === 'eth_blockNumber') return toQuantity(wallet.tip);
    if (method === 'eth_getBlockByNumber') { const n = params[0] === 'latest' ? wallet.tip : BigInt(params[0]); return { number: toQuantity(n), hash: bh(n), transactions: [...wallet.transactions.keys()] }; }
    if (method === 'eth_getBalance') return guards.same(params[0], F.authorizationContainer) ? '0x0' : '0xde0b6b3a7640000';
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_estimateGas') return '0x30d40';
    if (method === 'eth_getTransactionCount') return toQuantity(wallet.pendingNonce);
    if (method === 'eth_getTransactionByHash') return wallet.transactions.get(params[0]) ?? null;
    if (method === 'eth_getTransactionReceipt') return wallet.receipt;
    if (method === 'eth_call') {
      const parsed = ABI.parseTransaction({ data: params[0].data }); let result;
      switch (parsed.name) {
        case 'getSubscription': result = [0n, 10000000000000000n, 0n, A, wallet.consumer ? [F.game] : []]; break;
        case 'owner': case 'ownerOf': result = [A]; break;
        case 'EXEC_FEE': result = [wallet.execFee]; break;
        case 'token': result = [56n, F.processor, 2075n]; break;
        case 'accountOf': result = [F.authorizationContainer]; break;
        case 'isOpened': result = [true]; break;
        case 'seriesAuthorized': result = [wallet.authorized]; break;
        case 'currentRoundId': result = [1n]; break;
        case 'subscriptionId': result = [F.subscriptionId]; break;
        case 'rounds': result = [wallet.authorized ? 1n : 0n, 0n, wallet.authorized ? 100000n : 0n, 0n, 0n, 0n, 0n, 0n, 0n, '0x' + '0'.repeat(40)]; break;
        default: throw Error(`Unexpected read ${parsed.name}`);
      }
      return ABI.encodeFunctionResult(parsed.name, result);
    }
    if (method === 'eth_sendTransaction') {
      const transaction = { ...params[0], hash: HASH, input: params[0].data, blockNumber: '0x64', blockHash: bh(100n) };
      wallet.transactions.set(HASH, transaction); wallet.pendingNonce++;
      if (wallet.sendHook) await wallet.sendHook(); return HASH;
    }
    throw Error(`Unexpected method ${method}`);
  };
  const document = { getElementById: id => { assert.ok(elements.has(id), `Missing actual HTML ID ${id}`); return elements.get(id); }, createElement: () => new Element(), activeElement: null };
  const sandbox = { ...guards, F, ABI, getAddress, formatEther, toQuantity, document, window: surface, location: { href: 'https://example.invalid/start-test.html' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (storageFailure) throw Error('Synthetic storage unavailable'); storage.set(key, value); } },
    navigator: { locks: { request: async (_name, _options, action) => action() }, clipboard: { writeText: async () => {} } },
    createWalletPicker: options => ({ open: () => options.onSelect({ provider: wallet }) }),
    fetch: async () => ({ ok: false }), Blob, URL, AbortSignal, setTimeout, clearTimeout, setInterval() {}, Date, console,
  };
  const source = fs.readFileSync(new URL('start-test.js', WEB), 'utf8').replace(/^import[\s\S]*?;\s*/gm, '');
  const context = vm.createContext(sandbox);
  new vm.Script(`(()=>{${source}\nglobalThis.testState=state;})()`, { filename: 'start-test.js' }).runInContext(context);
  await tick();
  const app = { $: id => elements.get(id), state: context.testState, wallet, storage, surface,
    async connect() { await elements.get('connect-wallet').emit('click'); await until(() => !context.testState.busy, 'connect'); },
    async review(action) { await elements.get(`review-${action}`).emit('click'); await until(() => !context.testState.busy, 'review'); },
    async send() { elements.get('confirm-review').checked = true; await elements.get('send-action').emit('click'); await until(() => !context.testState.busy && !context.testState.locking, 'send'); },
    async verify(action) { await elements.get(`verify-${action}`).emit('click'); await until(() => !context.testState.busy && !context.testState.locking, 'verify'); },
    confirmReceipt(action, success = true) {
      const tx = wallet.transactions.get(HASH), logs = [];
      if (success) for (const [name, values] of action === 'consumer' ? [['SubscriptionConsumerAdded', [F.subscriptionId, F.game]]] : [['ContainerSeriesAuthorized', [F.authorizationContainer]], ['RoundStarted', [1n, 100000n]]]) {
        logs.push({ ...ABI.encodeEventLog(ABI.getEvent(name), values), address: action === 'consumer' ? F.coordinator : F.game, transactionHash: HASH, blockHash: tx.blockHash, blockNumber: tx.blockNumber });
      }
      wallet.receipt = { transactionHash: HASH, from: tx.from, to: tx.to, blockHash: tx.blockHash, blockNumber: tx.blockNumber, status: success ? '0x1' : '0x0', logs };
      wallet.tip = 111n; if (success && action === 'consumer') wallet.consumer = true; if (success && action === 'authorize') wallet.authorized = true;
    },
  };
  return app;
}

test('startup accepts initial permission accountsChanged and still reaches configuration with one connection', async () => {
  for (const timing of ['during-request', 'after-request']) {
    const app = await harness(), request = app.wallet.request; let emitted = false;
    app.wallet.request = async input => {
      const result = await request(input);
      if (!emitted && input.method === (timing === 'during-request' ? 'eth_requestAccounts' : 'eth_chainId')) {
        emitted = true; await app.wallet.emitAccounts([A]);
      }
      return result;
    };
    await app.connect();
    assert.equal(app.state.account, A, timing);
    assert.equal(app.$('review-consumer').disabled, false, timing);
    assert.equal(app.wallet.calls.filter(call => call.method === 'eth_requestAccounts').length, 1, timing);
    assert.equal(app.wallet.calls.filter(call => call.method === 'eth_sendTransaction').length, 0);
  }
});

test('startup rejects a mismatched initial permission event and late identity-read account changes', async () => {
  const app = await harness(), request = app.wallet.request;
  app.wallet.request = async input => {
    const result = await request(input);
    if (input.method === 'eth_requestAccounts') { app.wallet.account = B; await app.wallet.emitAccounts([B]); }
    return result;
  };
  await app.connect(); assert.equal(app.state.account, null); assert.equal(app.$('review-consumer').disabled, true);

  const late = await harness(), gate = deferred(), original = late.wallet.request; let accountReads = 0;
  late.wallet.request = async input => {
    const result = await original(input);
    if (input.method === 'eth_accounts' && ++accountReads === 3) await gate.promise;
    return result;
  };
  await late.$('connect-wallet').emit('click');
  await until(() => accountReads === 3, 'last startup identity response');
  late.wallet.account = B; await late.wallet.emitAccounts([B]); gate.resolve();
  await until(() => !late.state.busy, 'invalidated startup connection');
  assert.equal(late.state.account, null); assert.equal(late.state.snapshot, null); assert.equal(late.$('review-consumer').disabled, true);
  assert.equal(late.wallet.calls.filter(call => call.method === 'eth_sendTransaction').length, 0);
});

test('real startup HTML connects and estimates without signing; both fixed actions are reviewed separately', async () => {
  const app = await harness(); await app.connect(); await app.review('consumer');
  assert.equal(app.state.estimate.to, F.coordinator); assert.equal(app.state.estimate.value, '0');
  assert.equal(app.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 0);
  app.wallet.consumer = true; await app.review('authorize');
  assert.equal(app.state.estimate.to, F.authorizationContainer); assert.equal(app.state.estimate.value, F.execFeeWei);
  const decoded = ABI.decodeFunctionData('execute', app.state.estimate.data);
  assert.equal(decoded[0], F.game); assert.equal(decoded[1], 0n); assert.equal(decoded[2], ABI.encodeFunctionData('authorizeSeries')); assert.equal(decoded[3], 0n);
  assert.equal(app.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 0);
});

test('holder wallet can review container execution when its provider returns numeric RPC quantities', async () => {
  const app = await harness({ consumer: true }), original = app.wallet.request;
  app.wallet.request = async input => {
    const value = await original(input);
    if (input.method === 'eth_getBlockByNumber') return { ...value, number: Number(BigInt(value.number)) };
    if (['eth_chainId', 'eth_gasPrice', 'eth_estimateGas', 'eth_getTransactionCount'].includes(input.method)) return Number(BigInt(value));
    if (input.method === 'eth_getBalance' && guards.same(input.params[0], F.authorizationContainer)) return 0;
    return value;
  };
  await app.connect();
  assert.equal(app.state.account, A);
  assert.equal(app.$('review-authorize').disabled, false);
  await app.review('authorize');
  assert.equal(app.state.estimate.account, A);
  assert.equal(app.state.estimate.to, F.authorizationContainer);
  assert.equal(ABI.decodeFunctionData('execute', app.state.estimate.data)[0], F.game);
  assert.equal(app.wallet.calls.filter(call => call.method === 'eth_sendTransaction').length, 0);
  assert.ok(app.wallet.calls.filter(call => call.method === 'eth_call').every(call => call.params[1] === '0x64'));
});

test('an inexact numeric block height keeps startup review disabled and never reaches a signature', async () => {
  const app = await harness({ consumer: true }), original = app.wallet.request;
  app.wallet.request = async input => {
    const value = await original(input);
    return input.method === 'eth_getBlockByNumber' ? { ...value, number: Number.MAX_SAFE_INTEGER + 1 } : value;
  };
  await app.connect();
  assert.equal(app.state.snapshot, null);
  assert.equal(app.$('review-authorize').disabled, true);
  assert.match(app.$('notice').textContent, /钱包区块高度格式异常/);
  assert.equal(app.wallet.calls.filter(call => call.method === 'eth_sendTransaction').length, 0);
});

test('only an explicit reviewed click sends; pending state survives wallet changes and prevents duplicate calls', async () => {
  const app = await harness(); await app.connect(); await app.review('consumer');
  app.wallet.sendHook = async () => { app.wallet.account = B; await app.wallet.emit('accountsChanged'); };
  await app.send();
  assert.equal(app.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
  const record = JSON.parse(app.storage.get(STORAGE)).consumer;
  assert.equal(record.account, A); assert.equal(record.hash, HASH); assert.equal(record.to, F.coordinator);
  await app.$('send-action').emit('click'); await tick();
  assert.equal(app.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
});

test('changed owner, network, code, nonce, protocol fee or missing user review cannot reach a signing method', async () => {
  for (const mutation of ['owner', 'network', 'code', 'nonce', 'fee', 'review']) {
    const app = await harness({ consumer: true }); await app.connect(); await app.review('authorize');
    if (mutation === 'owner') app.wallet.account = B;
    if (mutation === 'network') app.wallet.chain = '0x1';
    if (mutation === 'fee') app.wallet.execFee = '1000000000000000000';
    if (mutation === 'code') app.wallet.code = '0x6000';
    if (mutation === 'nonce') app.wallet.pendingNonce++;
    if (mutation === 'review') await app.$('send-action').emit('click'); else await app.send();
    await tick(); assert.equal(app.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 0, mutation);
  }
});

test('confirmed startup uses canonical events and fresh state; no historical-state RPC or automatic next step', async () => {
  const app = await harness(); await app.connect(); await app.review('consumer'); await app.send(); app.confirmReceipt('consumer');
  await app.verify('consumer'); assert.equal(app.state.records.consumer.status, 'verified');
  assert.equal(app.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
  const calls = app.wallet.calls.filter(c => c.method === 'eth_call');
  assert.ok(calls.slice(-15).every(c => c.params[1] === '0x6f'));
  assert.equal(app.$('review-authorize').disabled, false);
});

test('failed receipt reset requires a successful fresh recheck; RPC errors preserve the blocking record', async () => {
  const app = await harness(); await app.connect(); await app.review('consumer'); await app.send(); app.confirmReceipt('consumer', false);
  await app.verify('consumer'); assert.equal(app.state.records.consumer.status, 'failed');
  app.wallet.failMethod = 'eth_getTransactionByHash';
  await app.$('reset-consumer').emit('click'); await until(() => !app.state.locking, 'failed reset');
  assert.ok(app.state.records.consumer); assert.ok(JSON.parse(app.storage.get(STORAGE)).consumer);
  assert.equal(app.$('review-consumer').disabled, true);
  assert.equal(app.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
});

test('restored claimed success remains unknown and never signs automatically', async () => {
  const transaction = guards.actionTransaction('consumer');
  const saved = { consumer: { schemaVersion: 1, action: 'consumer', chainId: 56, game: F.game, account: A, nonce: '0', ...transaction, createdAt: new Date().toISOString(), hash: HASH, status: 'verified' } };
  const app = await harness({ saved }); await app.connect();
  assert.equal(app.state.records.consumer.status, 'unknown'); assert.equal(app.$('review-consumer').disabled, true);
  assert.equal(app.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 0);
});

test('container activation sends only the exact protocol fee and requires both startup events before reporting success', async () => {
  const app = await harness({ consumer: true }); await app.connect(); await app.review('authorize'); await app.send();
  const sent = app.wallet.calls.filter(c => c.method === 'eth_sendTransaction');
  assert.equal(sent.length, 1); assert.equal(BigInt(sent[0].params[0].value).toString(), F.execFeeWei);
  app.confirmReceipt('authorize');
  const complete = app.wallet.receipt.logs; app.wallet.receipt.logs = complete.slice(0, 1);
  await app.verify('authorize'); assert.equal(app.state.records.authorize.status, 'unknown');
  app.wallet.receipt.logs = complete; await app.verify('authorize');
  assert.equal(app.state.records.authorize.status, 'verified'); assert.equal(app.$('review-authorize').disabled, true);
  assert.equal(app.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
});

test('storage failures prevent signing, and fewer than 12 confirmations keep a submitted action locked', async () => {
  const blocked = await harness({ storageFailure: true }); await blocked.connect(); await blocked.review('consumer'); await blocked.send();
  assert.equal(blocked.wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 0);
  const app = await harness(); await app.connect(); await app.review('consumer'); await app.send(); app.confirmReceipt('consumer'); app.wallet.tip = 110n;
  await app.verify('consumer'); assert.equal(app.state.records.consumer.status, 'unknown');
  assert.match(app.$('notice').textContent, /12/); assert.equal(app.$('review-consumer').disabled, true);
});
