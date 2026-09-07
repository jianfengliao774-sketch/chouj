import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletSession } from '../bem-production-site/web/wallet-connection.js';

const ACCOUNT = '0x0000000000000000000000000000000000000001';
const KEY = 'sparkdraw:preferred-wallet';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function clock() {
  let time = 0, serial = 0; const timers = new Map();
  return {
    setTimer(fn, delay) { const id = ++serial; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(delay) {
      time += delay;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    },
    get pending() { return timers.size; },
  };
}
function wallet(name, { accounts = [ACCOUNT], chain = '0x38' } = {}) {
  const requests = [];
  return { name, rdns: `wallet.${name}`, requests, provider: { request({ method }) {
    requests.push(method);
    if (method === 'eth_accounts') return Promise.resolve(accounts);
    if (method === 'eth_chainId') return Promise.resolve(chain);
    assert.fail(`Restoration must not request permissions or a transaction: ${method}`);
  } } };
}
const entries = (...wallets) => new Map(wallets.map((entry, index) => [index, entry]));
function fixture(saved, timing = {}) {
  const timer = clock(), values = new Map(), restored = []; let revision = 0;
  if (saved) values.set(KEY, JSON.stringify(saved));
  const session = createWalletSession({
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    onRestore: value => { restored.push(value); }, version: () => revision,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer, ...timing,
  });
  return { timer, restored, values, session, changeContext() { revision++; } };
}

test('restores exactly one authorized wallet and clears completed probe timers', async () => {
  const ui = fixture(), active = wallet('active'), disconnected = wallet('disconnected', { accounts: [] });
  assert.equal(await ui.session.restore(entries(active, disconnected)), true);
  assert.equal(ui.restored[0].entry, active);
  assert.deepEqual(active.requests, ['eth_accounts', 'eth_chainId']);
  assert.deepEqual(disconnected.requests, ['eth_accounts']);
  assert.equal(ui.timer.pending, 0);
  assert.deepEqual(JSON.parse(ui.values.get(KEY)), { rdns: active.rdns, name: '' });
});

test('never selects between two authorized providers without a saved preference', async () => {
  const ui = fixture();
  assert.equal(await ui.session.restore(entries(wallet('a'), wallet('b'))), false);
  assert.deepEqual(ui.restored, []); assert.equal(ui.timer.pending, 0);
});

test('saved preferred wallet excludes an unrelated silent provider from probing', async () => {
  const preferred = wallet('preferred'), silent = wallet('silent', { accounts: deferred().promise });
  const ui = fixture({ rdns: preferred.rdns });
  assert.equal(await ui.session.restore(entries(preferred, silent)), true);
  assert.equal(ui.restored[0].entry, preferred); assert.deepEqual(silent.requests, []);
  assert.equal(ui.timer.pending, 0);
});

test('legacy saved wallet name is still honored', async () => {
  const preferred = wallet('preferred'); preferred.rdns = '';
  const ui = fixture({ rdns: '', name: preferred.name }), other = wallet('other');
  assert.equal(await ui.session.restore(entries(other, preferred)), true);
  assert.equal(ui.restored[0].entry, preferred); assert.deepEqual(other.requests, []);
});

test('a silent accounts probe finishes in three seconds without guessing another wallet', async () => {
  const reply = deferred(), silent = wallet('silent', { accounts: reply.promise }), healthy = wallet('healthy');
  const ui = fixture(); let settled = false;
  const result = ui.session.restore(entries(silent, healthy)).then(value => { settled = true; return value; });
  await flush(); ui.timer.advance(2999); await flush(); assert.equal(settled, false);
  ui.timer.advance(1); assert.equal(await result, false);
  assert.deepEqual(ui.restored, []); assert.equal(ui.timer.pending, 0);
  reply.resolve([ACCOUNT]); await flush();
  assert.deepEqual(silent.requests, ['eth_accounts'], 'A late reply must not start an extra bridge read');
  assert.deepEqual(ui.restored, []);
});

test('accounts and chain share one deadline instead of each waiting three seconds', async () => {
  const accounts = deferred(), chain = deferred(), selected = wallet('selected', { accounts: accounts.promise, chain: chain.promise });
  const ui = fixture({ rdns: selected.rdns }); let settled = false;
  const result = ui.session.restore(entries(selected)).then(value => { settled = true; return value; });
  ui.timer.advance(2000); accounts.resolve([ACCOUNT]); await flush();
  assert.deepEqual(selected.requests, ['eth_accounts', 'eth_chainId']);
  ui.timer.advance(999); await flush(); assert.equal(settled, false);
  ui.timer.advance(1); assert.equal(await result, false); assert.equal(ui.timer.pending, 0);
  chain.resolve('0x38'); await flush(); assert.deepEqual(ui.restored, []);
});

test('same-brand providers remain ambiguous even with a saved brand preference', async () => {
  const active = wallet('same'), silent = wallet('same', { accounts: deferred().promise });
  const ui = fixture({ rdns: active.rdns });
  const result = ui.session.restore(entries(active, silent));
  await flush(); ui.timer.advance(3000);
  assert.equal(await result, false); assert.deepEqual(ui.restored, []);
});

test('a failed or malformed probe is not treated as proof that a wallet is unauthorized', async () => {
  for (const accounts of [null, { address: ACCOUNT }, ['invalid']]) {
    const ui = fixture();
    assert.equal(await ui.session.restore(entries(wallet('healthy'), wallet('unknown', { accounts }))), false);
    assert.deepEqual(ui.restored, []); assert.equal(ui.timer.pending, 0);
  }
  const ui = fixture(), failed = wallet('failed'); failed.provider.request = () => { throw Error('Native bridge unavailable'); };
  assert.equal(await ui.session.restore(entries(wallet('healthy'), failed)), false);
  assert.deepEqual(ui.restored, []); assert.equal(ui.timer.pending, 0);
});

test('manual connection cancellation invalidates a still-running restoration', async () => {
  const response = deferred(), selected = wallet('selected', { accounts: response.promise }), ui = fixture();
  const result = ui.session.restore(entries(selected));
  ui.session.cancel(); response.resolve([ACCOUNT]);
  assert.equal(await result, false); assert.deepEqual(ui.restored, []); assert.equal(ui.timer.pending, 0);
});

test('context changes invalidate a still-running restoration', async () => {
  const response = deferred(), selected = wallet('selected', { chain: response.promise }), ui = fixture();
  const result = ui.session.restore(entries(selected));
  await flush(); ui.changeContext(); response.resolve('0x38');
  assert.equal(await result, false); assert.deepEqual(ui.restored, []); assert.equal(ui.timer.pending, 0);
});

test('a later restore wins and late failure does not affect its chosen wallet', async () => {
  const response = deferred(), old = wallet('old', { accounts: response.promise }), chosen = wallet('chosen'), ui = fixture();
  const stale = ui.session.restore(entries(old));
  assert.equal(await ui.session.restore(entries(chosen)), true);
  response.reject(Error('Late native failure'));
  assert.equal(await stale, false); assert.deepEqual(ui.restored.map(value => value.entry), [chosen]);
  assert.equal(ui.timer.pending, 0);
});

test('probe deadline can be injected without real sleeps', async () => {
  const ui = fixture(null, { probeTimeoutMs: 17 }), selected = wallet('silent', { accounts: deferred().promise });
  const result = ui.session.restore(entries(selected));
  ui.timer.advance(17);
  assert.equal(await result, false); assert.equal(ui.timer.pending, 0);
});
