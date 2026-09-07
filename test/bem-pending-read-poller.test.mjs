import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingReadPoller, hasFastPendingRead } from '../bem-production-site/web/pending-read-poller.js';

const HASH = '0x' + 'a'.repeat(64);
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function setup() {
  let now = 0, next = 0, reads = 0, resolved = 0, errors = 0, handler = async () => {};
  const timers = new Map(), listeners = new Map();
  const document = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const state = { busy: false, blocking: true, records: [{ id: 'one', kind: 'approve', status: 'pending', hash: HASH }] };
  const manager = { getState: () => ({ ...state, records: state.records.map(record => ({ ...record })) }),
    async checkPending() { reads++; await handler(); }, execute() { assert.fail('A receipt poller must never submit transactions'); } };
  let current = manager;
  const poller = createPendingReadPoller({ getManager: () => current, document,
    onResolved: () => { resolved++; }, onError: () => { errors++; },
    setTimer(fn, ms) { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; }, clearTimer: id => timers.delete(id) });
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > end) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await flush();
    }
    now = end; await flush();
  }
  return { poller, state, manager, timers, advance, document, listeners,
    counts: () => ({ reads, resolved, errors }), setHandler: fn => handler = fn, setManager: value => current = value,
    async visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; listeners.get('visibilitychange')?.(); await flush(); } };
}

test('only unresolved approve/buy hashes trigger a two-second read loop', async () => {
  const s = setup(); s.poller.update(); await s.advance(1999); assert.equal(s.counts().reads, 0);
  await s.advance(1); assert.equal(s.counts().reads, 1); await s.advance(2000); assert.equal(s.counts().reads, 2);
  assert.equal(s.counts().resolved, 0); s.poller.destroy(); assert.equal(s.timers.size, 0);
  for (const record of [{ kind: 'refund', status: 'pending', hash: HASH }, { kind: 'settle', status: 'confirming', hash: HASH },
    { kind: 'buy', status: 'awaiting_wallet', hash: null }, { kind: 'buy', status: 'confirmed', hash: HASH },
    { kind: 'buy', status: 'reverted', hash: HASH }]) assert.equal(hasFastPendingRead({ records: [record] }), false);
});

test('a confirmed receipt stops fast polling and refreshes the newly unlocked wallet once', async () => {
  const s = setup(); s.setHandler(async () => { s.state.records[0].status = 'confirmed'; s.state.blocking = false; });
  s.poller.update(); await s.advance(2000);
  assert.deepEqual(s.counts(), { reads: 1, resolved: 1, errors: 0 }); assert.equal(s.timers.size, 0);
  await s.advance(30000); assert.equal(s.counts().reads, 1); s.poller.destroy();
});

test('slow reads and manual refreshes never overlap the poller request', async () => {
  const s = setup(); let release;
  s.setHandler(() => new Promise(resolve => release = resolve)); s.poller.update(); await s.advance(2000);
  await s.advance(10000); s.poller.update(); const manual = s.poller.checkNow();
  assert.equal(s.counts().reads, 1); assert.equal(s.timers.size, 0);
  release(); await manual; assert.equal(s.timers.size, 1); s.poller.destroy();
});

test('hidden pages pause receipt reads and becoming visible checks immediately', async () => {
  const s = setup(); s.poller.update(); await s.visible(false); await s.advance(20000);
  assert.equal(s.counts().reads, 0); assert.equal(s.timers.size, 0);
  await s.visible(true); assert.equal(s.counts().reads, 1); await s.advance(2000); assert.equal(s.counts().reads, 2);
  await s.visible(false); await s.poller.checkNow(); assert.equal(s.counts().reads, 2); s.poller.destroy();
});

test('a pending result from an old selected pool cannot refresh the new pool', async () => {
  const s = setup(); let release;
  s.setHandler(() => new Promise(resolve => release = () => { s.state.blocking = false; s.state.records[0].status = 'confirmed'; resolve(); }));
  s.poller.update(); await s.advance(2000); s.setManager(null); release(); await flush();
  assert.equal(s.counts().resolved, 0); assert.equal(s.timers.size, 0); s.poller.destroy();
});

test('read errors retry only the receipt read and preserve unresolved status', async () => {
  const s = setup(); s.setHandler(async () => { throw new Error('temporary RPC failure'); });
  s.poller.update(); await s.advance(4000);
  assert.deepEqual(s.counts(), { reads: 2, resolved: 0, errors: 2 }); assert.equal(s.state.blocking, true); s.poller.destroy();
});

test('manual checks can inspect slow refund/settlement records without starting fast polling', async () => {
  const s = setup(); s.state.records[0].kind = 'refund'; s.poller.update(); assert.equal(s.timers.size, 0);
  await s.poller.checkNow(); assert.equal(s.counts().reads, 1); assert.equal(s.timers.size, 0); s.poller.destroy();
});

test('destroy removes visibility listeners and cannot reschedule an unfinished read', async () => {
  const s = setup(); let release;
  s.setHandler(() => new Promise(resolve => release = resolve)); s.poller.update(); await s.advance(2000);
  s.poller.destroy(); assert.equal(s.listeners.size, 0); release(); await flush();
  assert.equal(s.timers.size, 0); await s.poller.checkNow(); assert.equal(s.counts().reads, 1);
});
