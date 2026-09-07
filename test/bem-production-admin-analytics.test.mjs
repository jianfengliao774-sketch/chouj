import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { formatUnits, getAddress } from 'ethers';
import { adminDayWindow, buildAdminRounds, adminRoundSummary, summarizeAdminRounds } from '../bem-production-site/admin-analytics.mjs';
import { createProductionServer } from '../bem-production-site/server.mjs';
import { createAdminCredential } from '../bem-production-site/auth.mjs';
import { loadManifest, GAME } from '../bem-production-site/config.mjs';
import { POOL_DEPLOYMENTS } from '../bem-production-site/web/pool-deployments.js';

const ALICE = '0x1111111111111111111111111111111111111111', BOB = '0x2222222222222222222222222222222222222222';
const h = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const DAY = Date.parse('2026-09-07T06:00:00Z');
function event(name, args, { tx = 1, block = tx, log = 0, time = '2026-09-07T00:00:00Z' } = {}) {
  return { name, args: { roundId: '1', ...args }, transactionHash: h(tx), blockHash: h(block + 10000),
    blockNumber: block, transactionIndex: 0, logIndex: log, timeUtc: time };
}
const purchase = (buyer, firstTicket, endExclusive, options = {}) => event('TicketsPurchased',
  { buyer, firstTicket: String(firstTicket), endExclusive: String(endExclusive), paid: String((endExclusive - firstTicket) * 10000) }, options);
function completedEvents() {
  return [event('RoundStarted', {}, { time: '2026-09-06T23:00:00Z' }),
    purchase(ALICE, 0, 500, { tx: 2, log: 0 }), purchase(ALICE, 1500, 2000, { tx: 2, log: 1 }),
    purchase(ALICE, 500, 1500, { tx: 3 }), purchase(BOB, 2000, 10000, { tx: 4, time: '2026-09-07T00:30:00Z' }),
    event('Settled', { winner: BOB, winningTicket: '9000' }, { tx: 5, time: '2026-09-07T00:35:00Z' })];
}

test('Shanghai today uses exact local midnight, independent of server locale and midnight-adjacent completion times', () => {
  assert.deepEqual(adminDayWindow(DAY), { timeZone: 'Asia/Shanghai', date: '2026-09-07',
    startUtc: '2026-09-06T16:00:00.000Z', endUtc: '2026-09-07T16:00:00.000Z' });
  const times = ['2026-09-06T15:59:59Z', '2026-09-06T16:00:00Z', '2026-09-07T15:59:59Z', '2026-09-07T16:00:00Z'];
  const rounds = buildAdminRounds(times.map((time, i) => event('Settled', { roundId: String(i + 1), winner: ALICE }, { tx: i + 1, time })));
  const summary = summarizeAdminRounds(rounds, DAY);
  assert.equal(summary.completedCount, 4); assert.equal(summary.todayCompletedCount, 2);
  assert.equal(adminDayWindow(Date.parse('2026-09-07T16:00:00Z')).date, '2026-09-08');
});

test('multiple selected-ticket ranges in one successful transaction count once per wallet and retain every share and payment', () => {
  const source = completedEvents(), rounds = buildAdminRounds([...source].reverse().concat(source[1]));
  const round = rounds[0];
  assert.equal(round.purchaseCount, 3); assert.equal(round.walletCount, 2); assert.equal(round.sold, 10000);
  assert.equal(round.paidBaseUnits, '100000000'); assert.equal(round.fillSeconds, 5400);
  assert.equal(round.filledTxHash, h(4)); assert.equal(round.settlementTxHash, h(5));
  const alice = round.wallets.find(wallet => wallet.address === ALICE);
  assert.equal(alice.purchaseCount, 2); assert.equal(alice.tickets, 2000); assert.equal(alice.paidBaseUnits, '20000000');
  const selected = round.purchases.find(tx => tx.transactionHash === h(2));
  assert.equal(selected.tickets, 1000); assert.equal(selected.ticketRanges.length, 2);
  assert.equal(selected.paidBaseUnits, '10000000');
  assert.equal(summarizeAdminRounds(rounds, DAY).todayPurchaseCount, 3);
  assert.equal(adminRoundSummary(round).wallets, undefined); assert.equal(adminRoundSummary(round).purchases, undefined);
});

test('same wallet in separate periods is independently listed, while the all-time wallet count deduplicates addresses', () => {
  const records = [purchase(ALICE, 0, 2), event('TicketsPurchased', { roundId: '2', buyer: ALICE,
    firstTicket: '0', endExclusive: '3', paid: '30000' }, { tx: 2 })];
  const rounds = buildAdminRounds(records), summary = summarizeAdminRounds(rounds, DAY);
  assert.deepEqual(rounds.map(row => [row.roundId, row.purchaseCount, row.wallets[0].tickets]), [['2', 1, 3], ['1', 1, 2]]);
  assert.equal(summary.walletCount, 1); assert.equal(summary.purchaseCount, 2);
});

test('unfilled, missing start-time and inconsistent timestamp records never fabricate a fill duration or a completion', () => {
  const noStart = buildAdminRounds(completedEvents().filter(item => item.name !== 'RoundStarted'))[0];
  assert.equal(noStart.filledAt, '2026-09-07T00:30:00Z'); assert.equal(noStart.fillSeconds, null);
  const partial = buildAdminRounds([event('RoundStarted', {}), purchase(ALICE, 0, 5, { tx: 2 }),
    event('RefundsOpened', {}, { tx: 3 }), event('UnclaimedPrincipalBurned', { amount: '50000' }, { tx: 4 })])[0];
  assert.equal(partial.status, 6); assert.equal(partial.fillSeconds, null); assert.equal(partial.filledAt, null);
  assert.equal(summarizeAdminRounds([partial], DAY).completedCount, 0);
  const invalid = completedEvents(); invalid[0].timeUtc = '2026-09-07T01:00:00Z';
  assert.equal(buildAdminRounds(invalid)[0].fillSeconds, null);
  const zero = completedEvents(); zero[0].timeUtc = '2026-09-07T00:30:00Z';
  assert.equal(buildAdminRounds(zero)[0].fillSeconds, 0, 'same-block completion is a real zero-second duration');
});

test('very large token base-unit values remain exact without floating-point rounding', () => {
  const value = '9007199254740993123456789', p = purchase(ALICE, 0, 1); p.args.paid = value;
  const round = buildAdminRounds([p])[0];
  assert.equal(round.paidBaseUnits, value); assert.equal(round.wallets[0].paidBaseUnits, value);
  assert.equal(round.purchases[0].paidBaseUnits, value);
});

const ADMIN = { username: 'synthetic-analytics-admin', password: 'test-only-not-real-password' };
const credential = await createAdminCredential(ADMIN.username, ADMIN.password);
async function httpFixture() {
  const accesses = [], rpcCalls = [], round = buildAdminRounds(completedEvents())[0];
  const indexes = Object.fromEntries(['1', '10', '50', '100', 'legacy100'].map(poolId => [poolId, {
    getStatus: () => ({ state: 'ready', indexedThrough: 123456789, confirmations: 12 }),
    getAdminSummary: ({ now }) => { accesses.push({ poolId, kind: 'summary' }); return summarizeAdminRounds([round], now); },
    listAdminRounds: options => { accesses.push({ poolId, kind: 'rounds', options }); return { rows: [adminRoundSummary(round)], page: options.page, pageSize: options.pageSize, total: 1, totalPages: 1 }; },
    getAdminRound: (roundId, options) => { accesses.push({ poolId, kind: 'detail', roundId, options }); return roundId === '1'
      ? { round: adminRoundSummary(round), wallets: { rows: round.wallets, page: options.walletPage, total: 2, totalPages: 1 }, purchases: { rows: round.purchases.filter(tx => !options.wallet || tx.buyer.toLowerCase() === options.wallet.toLowerCase()), page: options.transactionPage, total: 3, totalPages: 1 } } : null; },
  }]));
  const { server } = await createProductionServer({ port: 8788, manifest: await loadManifest(), adminCredential: credential,
    history: indexes.legacy100, poolHistories: indexes, rpc: async method => { rpcCalls.push(method); throw Error('No chain reads expected for confirmed analytics'); } });
  const send = ({ url, method = 'GET', payload, cookie, origin = 'http://127.0.0.1:8788' }) => new Promise(resolve => {
    const headers = { host: '127.0.0.1:8788', origin, 'content-type': 'application/json' }; if (cookie) headers.cookie = cookie;
    const req = { url, method, headers, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(JSON.stringify(payload)); } };
    const result = { headers: {} }, res = { setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
      writeHead(status, fields) { result.status = status; for (const [name, value] of Object.entries(fields)) result.headers[name.toLowerCase()] = value; },
      end(value) { result.body = JSON.parse(String(value)); resolve(result); } };
    server.emit('request', req, res);
  });
  return { send, accesses, rpcCalls };
}

test('admin overview and purchase details require a valid existing session before touching any index', async () => {
  const f = await httpFixture();
  for (const url of ['/api/admin/overview', '/api/admin/pools/1/rounds', '/api/admin/pools/1/rounds/1']) assert.equal((await f.send({ url })).status, 401);
  assert.equal(f.accesses.length, 0);
  const login = await f.send({ url: '/api/admin/login', method: 'POST', payload: ADMIN });
  assert.equal(login.status, 200); const cookie = login.headers['set-cookie'];
  const overview = await f.send({ url: '/api/admin/overview', cookie }); assert.equal(overview.status, 200);
  assert.equal(overview.body.day.timeZone, 'Asia/Shanghai');
  assert.deepEqual(overview.body.pools.map(pool => pool.poolId), ['1', '10', '50', '100', 'legacy100']);
  assert.equal(overview.body.pools[0].gameAddress, POOL_DEPLOYMENTS['1'].address);
  assert.equal(overview.body.pools.at(-1).gameAddress, GAME);
  assert.equal(overview.headers['cache-control'], 'no-store');
  assert.equal((await f.send({ url: '/api/admin/overview', cookie, origin: 'https://foreign.invalid' })).status, 403);
  await f.send({ url: '/api/admin/logout', method: 'POST', payload: {}, cookie });
  assert.equal((await f.send({ url: '/api/admin/overview', cookie })).status, 401);
  assert.deepEqual(f.rpcCalls, []);
});

test('authenticated per-pool details validate pagination and wallets without exposing receipts, credentials or write operations', async () => {
  const f = await httpFixture(), login = await f.send({ url: '/api/admin/login', method: 'POST', payload: ADMIN }), cookie = login.headers['set-cookie'];
  for (const pool of ['1', '10', '50', '100', 'legacy100']) {
    const list = await f.send({ url: `/api/admin/pools/${pool}/rounds?page=2&pageSize=10`, cookie }); assert.equal(list.status, 200); assert.equal(list.body.poolId, pool);
    const detail = await f.send({ url: `/api/admin/pools/${pool}/rounds/1?wallet=${ALICE}&transactionPage=2&pageSize=25`, cookie });
    assert.equal(detail.status, 200); assert.ok(detail.body.purchases.rows.every(row => row.buyer === ALICE));
    assert.ok(!JSON.stringify(detail.body).includes('receipt')); assert.ok(!JSON.stringify(detail.body).includes(ADMIN.password));
  }
  for (const query of ['?page=0', '?pageSize=51', '?transactionPage=-1', '?walletPage=1.5', '?wallet=not-an-address', '?wallet=0x001F110422f04a90bf7d6ec96714f75046bd7126']) {
    assert.equal((await f.send({ url: `/api/admin/pools/1/rounds/1${query}`, cookie })).status, 400);
  }
  assert.equal((await f.send({ url: '/api/admin/pools/1/rounds/999', cookie })).status, 404);
  assert.equal((await f.send({ url: '/api/admin/pools/2/rounds', cookie })).status, 404);
  assert.equal((await f.send({ url: '/api/admin/overview', method: 'POST', payload: {}, cookie })).status, 404);
  assert.deepEqual(f.rpcCalls, []);
});

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this._text = ''; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get childNodes() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  emit(name) { for (const fn of this.listeners.get(name) ?? []) fn({ target: this }); }
  descendants(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.descendants(tag)]); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function uiFixture() {
  const ids = ['activity-pools', 'today-completed', 'today-caption', 'activity-day', 'activity-generated'];
  const html = fs.readFileSync(new URL('../bem-production-site/web/admin.html', import.meta.url), 'utf8');
  ids.forEach(id => assert.ok(html.includes(`id="${id}"`), `Actual admin page provides ${id}`));
  const elements = new Map(ids.map(id => [id, new Element()]));
  const calls = [], failures = [], round = buildAdminRounds(completedEvents())[0];
  const data = { day: adminDayWindow(DAY), generatedAt: new Date(DAY).toISOString(), pools: ['1', '10', '50', '100', 'legacy100'].map(poolId => ({ poolId,
    gameAddress: poolId === 'legacy100' ? GAME : POOL_DEPLOYMENTS[poolId].address, index: { state: 'ready' }, summary: summarizeAdminRounds([round], DAY) })) };
  const api = async path => { calls.push(path); return path.includes('/rounds/1?') ? { index: { state: 'ready' }, round: adminRoundSummary(round),
    wallets: { rows: round.wallets, page: 1, total: 2, totalPages: 1 }, purchases: { rows: round.purchases, page: 1, total: 3, totalPages: 1 } }
    : { index: { state: 'ready' }, rows: [adminRoundSummary(round)], page: 1, total: 1, totalPages: 1 }; };
  const context = vm.createContext({ formatUnits, getAddress, Date, URLSearchParams, document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag) } });
  const source = fs.readFileSync(new URL('../bem-production-site/web/admin-activity.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
  new vm.Script(`(()=>{${source}\nglobalThis.createAdminActivity=createAdminActivity;globalThis.fillDuration=fillDuration;})()`).runInContext(context);
  const activity = context.createAdminActivity({ api, onError: error => failures.push(error) });
  return { activity, data, calls, failures, elements, context };
}

test('Chinese admin displays five independent pools and lazily expands each round, wallet and confirmed transaction', async () => {
  const f = uiFixture(); f.activity.render(f.data);
  assert.equal(f.elements.get('today-completed').textContent, '5');
  const pools = f.elements.get('activity-pools').children; assert.equal(pools.length, 5);
  assert.match(pools[0].textContent, /1 BEM 场 · 测试场/); assert.match(pools[4].textContent, /原 100 BEM 合约/);
  assert.equal(f.calls.length, 0, 'overview does not eagerly request every wallet');
  const poolDetails = pools[0].descendants('details')[0]; poolDetails.open = true; poolDetails.emit('toggle'); await tick();
  assert.equal(f.calls[0], '/api/admin/pools/1/rounds?page=1&pageSize=10');
  const roundDetails = poolDetails.descendants('details')[0]; assert.match(roundDetails.textContent, /1小时 30分/);
  roundDetails.open = true; roundDetails.emit('toggle'); await tick();
  assert.match(roundDetails.textContent, new RegExp(ALICE)); assert.match(roundDetails.textContent, new RegExp(h(2)));
  assert.match(roundDetails.textContent, /本期钱包汇总/); assert.match(roundDetails.textContent, /本期逐笔购买/);
  const filter = roundDetails.descendants('button').find(button => button.textContent === '查看购买'); filter.emit('click'); await tick();
  assert.match(f.calls.at(-1), /wallet=0x/); assert.match(roundDetails.textContent, /该钱包逐笔购买/);
  assert.deepEqual(f.failures, []);
  assert.equal(f.context.fillDuration({ sold: 10000, fillSeconds: null }), '时间记录缺失');
  assert.equal(f.context.fillDuration({ sold: 9, fillSeconds: null }), '尚未售满');
  assert.equal(f.context.fillDuration({ sold: 10000, fillSeconds: 0 }), '0秒');
});

test('a missing index never appears as a complete zero and logout clears rendered participant data', () => {
  const f = uiFixture(); f.data.pools.forEach(pool => { pool.summary = null; pool.index = { state: 'awaiting_index' }; });
  f.activity.render(f.data); assert.equal(f.elements.get('today-completed').textContent, '—');
  assert.match(f.elements.get('today-caption').textContent, /尚未完整/);
  f.activity.clear(); assert.equal(f.elements.get('activity-pools').children.length, 0);
});
