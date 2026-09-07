import { createApprovalPurchaseFlow, purchaseContextKey } from '../bem-production-site/web/approval-purchase-flow.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Interface, formatUnits, getAddress, toQuantity } from 'ethers';
import { createTestPlayerTransactions } from '../bem-production-site/web/test-player-transactions.js';
import { createFormalPlayerTransactions } from '../bem-production-site/web/formal-player-transactions.js';
import { createPartialFillResult } from '../bem-production-site/web/partial-fill-result.js';
import { createPendingReadPoller, hasFastPendingRead } from '../bem-production-site/web/pending-read-poller.js';
import { poolRegistry } from '../bem-production-site/pools.mjs';
import { quoteView } from '../bem-production-site/web/market-guards.js';
import { validateRecords, transactionUrl } from '../bem-production-site/web/public-record-guards.js';
import { playerPageHtml } from '../bem-production-site/player-page-template.mjs';

const WEB = new URL('../bem-production-site/web/', import.meta.url);
const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
const token = new Interface(['function balanceOf(address) view returns(uint256)']);
const tick = () => new Promise(resolve => setTimeout(resolve, 1));
async function until(condition, label) { for (let n = 0; n < 100; n++) { if (condition()) return; await tick(); } throw new Error(`Timed out: ${label}`); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('the player accepts the first permission accountsChanged event without requiring another connection', async () => {
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
    assert.equal(app.$('wallet-address').textContent, A, timing);
    assert.equal(app.wallet.calls.filter(call => call.method === 'eth_requestAccounts').length, 1, timing);
    assert.ok(app.wallet.calls.every(call => !['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'].includes(call.method)));
  }
});

test('burn records share the player shell and preserve the connected wallet and ticket selection across tabs', async () => {
  const app = await harness({ search: '?pool=1' });
  await app.connect();
  app.$('ticket-count').value = '1000'; await app.$('ticket-count').emit('input');
  assert.equal(app.calls.filter(call => call.path.startsWith('/api/burns')).length, 0);
  await app.$('tab-burns').emit('click'); await tick();
  assert.equal(app.$('panel-burns').hidden, false);
  assert.equal(app.$('panel-draw').hidden, true);
  assert.equal(app.$('wallet-address').textContent, A);
  assert.equal(app.$('ticket-count').value, '1000');
  assert.equal(app.context.location.pathname, '/burns.html');
  assert.match(app.context.document.title, /销毁记录 · Tapeout 芯火夺宝/);
  await app.$('language-en').emit('click');
  assert.match(app.context.document.title, /Burn records · Tapeout SparkDraw/);
  assert.equal(app.$('burn-refresh').textContent, 'Refresh records');
  await app.$('tab-draw').emit('click');
  assert.equal(app.$('panel-draw').hidden, false);
  assert.equal(app.$('panel-burns').hidden, true);
  assert.equal(app.$('ticket-count').value, '1000');
  assert.equal(app.$('wallet-address').textContent, A);
  assert.equal(app.wallet.calls.filter(call => call.method === 'eth_requestAccounts').length, 1);
  assert.equal(app.wallet.calls.filter(call => call.method === 'eth_sendTransaction').length, 0);
  await app.choose('50');
  assert.equal(new URLSearchParams(app.context.location.search).get('pool'), '50');
  assert.equal(app.$('tab-burns').getAttribute('href'), '/burns.html?pool=50');
  await app.$('tab-burns').emit('click');
  assert.equal(app.context.location.pathname, '/burns.html');
  assert.equal(new URLSearchParams(app.context.location.search).get('pool'), '50');
});

test('the player rejects a different account emitted while initial permission is still pending', async () => {
  const app = await harness(), request = app.wallet.request;
  app.wallet.request = async input => {
    const result = await request(input);
    if (input.method === 'eth_requestAccounts') { app.wallet.account = B; await app.wallet.emitAccounts([B]); }
    return result;
  };
  await app.$('connect-wallet').emit('click');
  await until(() => !app.$('connect-wallet').disabled, 'rejected initial permission identity');
  assert.equal(app.$('wallet-address').textContent, '');
  assert.equal(app.wallet.calls.filter(call => call.method === 'eth_sendTransaction').length, 0);
});

test('a wallet account-change event during the last connect response cannot restore the old account', async () => {
  const app=await harness(), gate=deferred(); let chainReads=0;
  const request=app.wallet.request;
  app.wallet.request=async input=>{
    if(input.method==='eth_chainId'&&++chainReads===2){await gate.promise;return '0x38';}
    return request(input);
  };
  await app.$('connect-wallet').emit('click');
  await until(()=>chainReads===2,'last chain response');
  app.wallet.account=B;await app.wallet.emitAccounts([B]);
  gate.resolve();await tick();await tick();
  assert.equal(app.$('wallet-address').textContent,'');
  assert.equal(app.$('connect-wallet').disabled,false);
});

test('the real player entry forwards only explicit test actions and keeps a new funding round active after the prior settlement', async () => {
  const actions=[], reads=[];let allowance=0n;
  const app=await harness({search:'?pool=1',testFactory: options=>({
    getState:()=>({busy:false,blocking:false,records:[]}),checkPending:async()=>{},attachHash:async()=>{},
    readState:async(account,{roundId}={})=>{
      reads.push(roundId);return {account,roundId:2n,currentRoundId:2n,blockNumber:120000001,timestamp:100n,
        round:{status:1,sold:1000n,fundingDeadline:10000n},myCount:0n,allowance,bemBalance:100000000n,bnbBalance:1000000000000000n,
        seriesAuthorized:true,consumerAuthorized:true,canBuy:true,canRefund:false,canSettle:false,refundAmount:0n,refundDeadline:96400n};
    },
    execute:async(kind,payload)=>{actions.push({kind,payload,context:options.getContext()});if(kind==='approve')allowance=10000n;},
  })});
  await app.connect();await until(()=>app.$('approve').disabled===false,'test approve enabled');
  assert.match(app.$('round-phase').textContent,/购买中/);assert.ok(reads.every(id=>id===undefined));
  assert.equal(app.$('funding-amount').textContent, '0.1 / 1 BEM', 'verified wallet reads populate progress even without the public status API');
  assert.equal(app.$('funding-tickets').textContent, '1,000 / 10,000 份');
  assert.equal(app.$('funding-progress').firstElementChild.style.width, '10%');
  assert.equal(actions.length,0);await app.$('approve').emit('click');
  await until(()=>app.$('buy').disabled===false,'exact approval permits explicit purchase');
  assert.deepEqual(actions.map(a=>a.kind),['approve']);
  await app.$('buy').emit('click');await until(()=>actions.length===2,'purchase action');
  assert.equal(actions[1].context.poolId,'1');assert.equal(actions[1].payload.roundId,2n);assert.equal(actions[1].payload.quantity,1);
  await app.choose('10');await app.$('buy').emit('click');await tick();
  assert.equal(app.$('buy').disabled,true);assert.equal(actions.length,2);
});

test('an open test pool explains a zero BEM balance without calling it unstarted', async () => {
  const app = await harness({ search: '?pool=1', openTest: true, testFactory: () => ({
    getState: () => ({ busy: false, blocking: false, records: [] }), checkPending: async () => {},
    readState: async account => ({ account, blockNumber: 120000001, roundId: 1n, currentRoundId: 1n, timestamp: 100n,
      round: { status: 1, sold: 0n, fundingDeadline: 10000n }, myCount: 0n, allowance: 0n, bemBalance: 0n,
      seriesAuthorized: true, consumerAuthorized: true, canBuy: true, canRefund: false, canSettle: false }),
  }) });
  await app.connect(); await until(() => /余额不足/.test(app.$('purchase-state').textContent), 'actual zero balance explanation');
  assert.match(app.$('purchase-state').textContent, /场次已开放.*0 BEM.*0\.0001 BEM/);
  assert.equal(app.$('approve').disabled, true); assert.equal(app.$('buy').disabled, true);
  assert.equal(app.wallet.calls.filter(call => call.method === 'eth_sendTransaction').length, 0);
});

test('a registered formal fixture permits 1000 requested with 800 remaining while passing the original quantity', async () => {
  const actions = [];
  const app = await harness({ search: '?pool=10', formalFactory: options => options.poolId !== '10'
    ? createFormalPlayerTransactions(options) : ({
      getState: () => ({ busy: false, blocking: false, registered: true, records: [] }), checkPending: async () => {},
      readState: async account => ({ account, blockNumber: 120000001, roundId: 1n, currentRoundId: 1n, timestamp: 100n,
        round: { status: 1, sold: 9200n, fundingDeadline: 10000n }, myCount: 0n, allowance: 80000000n, bemBalance: 80000000n,
        seriesAuthorized: true, consumerAuthorized: true, canBuy: true, canRefund: false, canSettle: false }),
      execute: async (kind, payload) => actions.push({ kind, payload }),
    }) });
  await app.connect(); await until(() => app.$('buy').disabled === false, 'registered formal purchase');
  app.$('ticket-count').value = '1000'; await app.$('ticket-count').emit('input');
  assert.equal(app.$('buy').disabled, false); assert.equal(app.$('approve').disabled, true);
  assert.match(app.$('purchase-state').textContent, /实际成交扣款/);
  await app.$('buy').emit('click'); await until(() => actions.length === 1, 'explicit formal purchase');
  assert.equal(actions[0].payload.quantity, 1000); assert.equal(actions[0].payload.roundId, 1n);
  await app.choose('50'); await app.$('buy').emit('click'); await tick();
  assert.equal(actions.length, 1); assert.equal(app.$('buy').disabled, true);
});

test('disconnected purchase buttons open the wallet picker, preserve 1000 tickets and never continue into a transaction', async () => {
  for (const poolId of ['1', '10']) for (const button of ['approve', 'buy']) {
    const actions = [];
    const app = await harness({ search: `?pool=${poolId}`, testFactory: () => ({
      getState: () => ({ busy: false, blocking: false, records: [] }),
      readState: async account => ({ account, blockNumber: 120000001, roundId: 1n, currentRoundId: 1n, timestamp: 100n,
        round: { status: 1, sold: 0n, fundingDeadline: 10000n }, myCount: 0n, allowance: 0n, bemBalance: 100000000n,
        seriesAuthorized: true, consumerAuthorized: true, canBuy: true, canRefund: false, canSettle: false }),
      execute: async kind => actions.push(kind),
    }) });
    app.$('ticket-count').value = '1000'; await app.$('ticket-count').emit('input');
    assert.equal(app.$(button).disabled, false); await app.$(button).emit('click');
    await until(() => app.$('wallet-address').textContent === A, 'purchase-area wallet connection');
    await tick(); assert.equal(app.$('ticket-count').value, '1000'); assert.deepEqual(actions, []);
    assert.equal(app.wallet.calls.filter(call => call.method === 'eth_requestAccounts').length, 1);
    assert.equal(app.wallet.calls.filter(call => call.method === 'eth_sendTransaction').length, 0);
    if (poolId === '10') { assert.equal(app.$('approve').disabled, true); assert.equal(app.$('buy').disabled, true); }
  }
});

test('an approval shows submitted status then the fast read loop refreshes allowance and enables buy without another click', async () => {
  const timers = new Map(), actions = []; let nextTimer = 0, pending = null, history = [], allowance = 0n, reads = 0, checks = 0;
  const getState = () => ({ busy: false, blocking: !!pending, records: pending ? [{ ...pending }] : history });
  const app = await harness({ search: '?pool=1', pendingTimers: {
    setTimer(fn, delay) { assert.equal(delay, 2000); const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id),
  }, testFactory: options => ({
    getState,
    readState: async account => { reads++; return { account, blockNumber: 120000001, roundId: 1n, currentRoundId: 1n, timestamp: 100n,
      round: { status: 1, sold: 0n, fundingDeadline: 10000n }, myCount: 0n, allowance, bemBalance: 100000000n,
      seriesAuthorized: true, consumerAuthorized: true, canBuy: true, canRefund: false, canSettle: false }; },
    execute: async kind => { actions.push(kind); pending = { id: 'approval', hash: '0x' + 'a'.repeat(64), kind, status: 'pending', account: A, input: { roundId: '1' } }; options.onUpdate(getState()); },
    checkPending: async () => {
      if (++checks === 1) return getState();
      history = [{ ...pending, status: 'confirmed', confirmations: 1 }]; pending = null; allowance = 10000n; options.onUpdate(getState()); return getState();
    },
  }) });
  await app.connect(); await until(() => !app.$('approve').disabled, 'approval available');
  await app.$('approve').emit('click'); await until(() => checks === 1 && timers.size === 1, 'pending fast read scheduled');
  assert.match(app.$('transaction-list').textContent, /已提交.*等待上链/); assert.equal(app.$('buy').disabled, true);
  const [id, callback] = [...timers][0]; timers.delete(id); callback();
  await until(() => !app.$('buy').disabled, 'confirmed allowance refreshed');
  assert.match(app.$('transaction-list').textContent, /已上链确认/);
  assert.match(app.$('notice').textContent, /授权成功，可以确认购买/);
  assert.equal(reads, 2, 'one initial view and one completion refresh'); assert.equal(checks, 2);
  assert.equal(timers.size, 0); assert.deepEqual(actions, ['approve']);
  await app.surface.emit('beforeunload');
});

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = new Map(); this.dataset = {}; this.style = {}; this.attributes = {};
    this.value = ''; this._text = ''; this.hidden = false; this.disabled = false; this.classList = { add() {}, remove() {}, toggle() {} }; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  addEventListener(event, fn) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]); }
  removeEventListener(event, fn) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(item => item !== fn)); }
  async emit(event, extra = {}) { await Promise.all((this.listeners.get(event) ?? []).map(fn => fn({ target: this, preventDefault() {}, ...extra }))); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) ?? []) fn(event); return true; }
  append(...nodes) { this.children.push(...nodes.map(node => typeof node === 'string' ? Object.assign(new Element('text'), { textContent: node }) : node)); }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1); }
  querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tagName === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
  cloneNode(deep) { const clone = new Element(this.tagName); clone.attributes = { ...this.attributes }; clone._text = this._text;
    if (deep) clone.children = this.children.map(child => child.cloneNode(true)); return clone; }
  focus() {} scrollIntoView() {} select() {}
}

async function harness({ language = 'zh', search = '', balanceHook = null, announcements = [], testFactory = null, formalFactory = null, openTest = false, pendingTimers = null } = {}) {
  const html = playerPageHtml(fs.readFileSync(new URL('index.html', WEB), 'utf8'), fs.readFileSync(new URL('burns.html', WEB), 'utf8')), elements = new Map(), all = [];
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*)>([^<]*)/g)) {
    const node = new Element(match[1]); node.textContent = match[3];
    for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
    node.id = node.getAttribute('id'); node.value = node.getAttribute('value') ?? '';
    node.hidden = /\bhidden\b/.test(match[2]); node.disabled = /\bdisabled\b/.test(match[2]);
    if (node.getAttribute('data-count')) node.dataset.count = node.getAttribute('data-count');
    all.push(node); if (node.id) elements.set(node.id, node);
  }
  const surface = new Element('window'), document = new Element('document');
  Object.assign(document, { getElementById: id => { assert.ok(elements.has(id), `Missing actual index.html ID: ${id}`); return elements.get(id); },
    createElement: tag => Object.assign(new Element(tag), { ownerDocument: document }),
    createTextNode: text => Object.assign(new Element('text'), { textContent: text, ownerDocument: document }),
    querySelector: selector => selector.startsWith('#') ? elements.get(selector.slice(1)) : null,
    querySelectorAll: selector => { const attr = /^\[([\w-]+)\]$/.exec(selector)?.[1]; return attr ? all.filter(node => node.getAttribute(attr) != null) : []; },
    documentElement: { lang: 'zh-CN' }, body: new Element('body'), defaultView: surface, hidden: false, visibilityState: 'visible', activeElement: null });
  for (const node of all) node.ownerDocument = document;
  elements.get('funding-progress').append(new Element('i'));
  const calls = [], events = [], wallet = new Element('wallet'); wallet.account = A; wallet.chain = '0x38'; wallet.calls = [];
  wallet.on = wallet.addEventListener.bind(wallet); wallet.removeListener = wallet.removeEventListener.bind(wallet);
  wallet.emitAccounts = async accounts => { for (const listener of wallet.listeners.get('accountsChanged') ?? []) await listener(accounts); };
  wallet.request = async ({ method, params }) => { wallet.calls.push({ method, params });
    if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [wallet.account];
    if (method === 'eth_chainId') return wallet.chain;
    if (method === 'wallet_switchEthereumChain') { wallet.chain = params[0].chainId; await wallet.emit('chainChanged'); return null; }
    throw new Error(`Unexpected wallet method ${method}`);
  };
  const storage = new Map([['bem2075-player-language', language]]), quote = { chainId: 56, token: poolRegistry().bemAddress,
    source: 'DEX Screener', stale: false, updatedAt: new Date().toISOString(),
    usdt: { price: '2', pairAddress: A }, bnb: { price: '0.001', pairAddress: B } };
  // Public draw/personal DOM is exercised in the real-browser integration checks;
  // this minimal DOM harness isolates wallet, balance and transaction regression cases.
  const sandbox = { createApprovalPurchaseFlow, purchaseContextKey,
    createPublicDrawDisplay: () => ({ render() {} }), initPersonalRecords() {},
    createTestPlayerTransactions: testFactory ?? createTestPlayerTransactions, createFormalPlayerTransactions: formalFactory ?? createFormalPlayerTransactions,
    createPartialFillResult, hasFastPendingRead, createPendingReadPoller: options => createPendingReadPoller({ ...options, document, ...(pendingTimers ?? {}) }),
    Interface, formatUnits, getAddress, toQuantity, quoteView, validateRecords, transactionUrl,
    document, window: surface, location: { href: `https://example.invalid/${search}`, origin: 'https://example.invalid', pathname: '/', hash: '', search },
    history: { pushState(_state, _title, url) { Object.assign(sandbox.location, { href: String(url), pathname: url.pathname, hash: url.hash, search: url.search }); },
      replaceState(...args) { this.pushState(...args); } },
    navigator: { clipboard: { writeText: async () => {} } }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    createWalletPicker: options => { options.onChange(new Map([['fixture', { provider: wallet, name: 'Synthetic wallet' }]])); return { open: () => options.onSelect({ provider: wallet }) }; },
    fetch: async (path, options = {}) => {
      calls.push({ path, options }); let result;
      if (path === '/api/pools') result = poolRegistry();
      else if (path === '/api/pools/1/status' && openTest) result = { schemaVersion: 2, chainId: 56, poolId: '1', runtimeVerified: true,
        gameAddress: poolRegistry().pools.find(pool => pool.id === '1').deployment.address, seriesAuthorized: true,
        vrf: { consumerAuthorized: true }, currentRound: { sold: '0' }, snapshot: { blockNumber: 120000001 } };
      else if (path === '/api/market') result = quote;
      else if (path === '/api/burns/summary') result = { schemaVersion: 1, chainId: 56, scope: 'all_registered_pools', decimals:8, amountBaseUnits:'12345678',burnCount:2,updatedAt:'2026-09-07T09:00:00Z',nextUpdateAt:'2026-09-07T09:05:00Z',refreshIntervalMs:300000,index:{state:'ready'} };
      else if (path.startsWith('/api/burns')) result = { schemaVersion: 2, chainId: 56, rows: [], page: 1, totalPages: 0, total: 0, index: { state: 'ready' } };
      else if (path.startsWith('/api/announcements')) result = { schemaVersion: 2, chainId: 56, rows: announcements, page: 1, totalPages: announcements.length ? 1 : 0, total: announcements.length, deploymentPending: true, index: { state: 'ready' } };
      else if (path === '/rpc') {
        const payload = JSON.parse(options.body);
        const respond = async request => { let value;
        if (request.method === 'eth_chainId') value = '0x38';
        else if (request.method === 'eth_blockNumber') value = '0x64';
        else if (request.method === 'eth_getBalance') value = '0xde0b6b3a7640000';
        else if (request.method === 'eth_call') {
          const account = token.decodeFunctionData('balanceOf', request.params[0].data)[0];
          value = token.encodeFunctionResult('balanceOf', [balanceHook ? await balanceHook(account) : 100000000n]);
        } else throw new Error(`Unexpected RPC method ${request.method}`);
        return { jsonrpc: '2.0', id: request.id, result: value }; };
        result = Array.isArray(payload) ? await Promise.all(payload.map(respond)) : await respond(payload);
      } else throw new Error(`Unexpected fetch ${path}`);
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => result };
    },
    URL, URLSearchParams, Event, CustomEvent, AbortController, AbortSignal, Date, console, setTimeout, clearTimeout, setInterval() {},
  };
  surface.addEventListener('bem:poolchange', event => events.push(event.detail.pool));
  const context = vm.createContext(sandbox);
  function evaluate(file, exports = []) {
    const source = fs.readFileSync(new URL(file, WEB), 'utf8').replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
    new vm.Script(`(()=>{${source}\n${exports.length ? `Object.assign(globalThis,{${exports.join(',')}});` : ''}\n})()`, { filename: file }).runInContext(context);
  }
  evaluate('player-i18n.js', ['t', 'getLocale', 'initLanguage', 'translateKnown', 'setLanguage', 'updatePageTitle']);
  evaluate('burn-summary.js', ['showBurnSummary']);
  evaluate('burns.js', ['showBurnRecords']);
  evaluate('pool-selection.js', ['createPoolSelection', 'poolMetadata', 'getPoolRules']);
  evaluate('player-v2-state.js', ['createPendingPlayerState']);
  evaluate('read-rpc-batcher.js', ['createReadRpcBatcher']);
  const entries = [...html.matchAll(/<script type="module" src="\/([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(entries, ['prize-market.js', 'public-records.js', 'player-v2.js'], 'actual module order installs price/history listeners before the pool event');
  for (const file of entries) {
    // Execute the shared side-effect dependency that a browser imports for public-records.js.
    if (file === 'public-records.js') evaluate('winner-broadcast.js');
    evaluate(file);
  }
  await until(() => elements.get('prize-usdt').textContent.includes('U') && calls.some(call => call.path === '/api/pools'), 'initial rendering');
  await tick();
  return { $: id => elements.get(id), calls, events, wallet, surface, context,
    async connect() { await elements.get('connect-wallet').emit('click'); await until(() => elements.get('wallet-address').textContent === wallet.account, 'wallet connection'); },
    async choose(id) { const button = elements.get('pool-selection').querySelectorAll('button').find(node => node.dataset.pool === id); assert.ok(button); await button.emit('click'); },
  };
}

test('open test pool asks for a wallet; unavailable RPC is never labelled as an unopened pool', async () => {
  const app = await harness({ search: '?pool=1', openTest: true, testFactory: () => ({
    getState: () => ({ busy: false, blocking: false, records: [] }),
    readState: async () => { throw Object.assign(new Error('busy'), { code: 'RPC_UNAVAILABLE' }); },
  }) });
  await until(() => app.$('purchase-state').textContent.includes('请先连接钱包'), 'open pool copy');
  await app.connect();
  await until(() => app.$('purchase-state').textContent.includes('读取暂时失败'), 'read failure copy');
  assert.doesNotMatch(app.$('purchase-state').textContent, /未开放/);
  assert.equal(app.$('approve').disabled, true); assert.equal(app.$('buy').disabled, true);
  const unavailable = await harness({ search: '?pool=1' });
  await until(() => unavailable.$('purchase-state').textContent.includes('读取暂时失败'), 'public status failure copy');
  assert.doesNotMatch(unavailable.$('round-phase').textContent, /待启动/);
});

test('actual index modules boot in initial English and selected-pool event updates all BEM/U/BNB figures', async () => {
  const app = await harness({ language: 'en', search: '?pool=10' });
  assert.equal(app.$('prize-bem').textContent, '9.5'); assert.match(app.$('prize-usdt').textContent, /19 U/);
  assert.match(app.$('prize-bnb').textContent, /0\.0095 BNB/);
  assert.equal(app.$('payout-container').textContent, '0.1 BEM');
  assert.match(app.$('community-copy').textContent, /0\.1 BEM to the container/);
  assert.doesNotMatch(app.$('community-copy').textContent, /2075 container|2075 容器/);
  assert.match(app.$('purchase-state').textContent, /not open/);
  await app.choose('50'); assert.equal(app.$('prize-bem').textContent, '47.5'); assert.match(app.$('prize-usdt').textContent, /95 U/);
  assert.match(app.$('prize-bnb').textContent, /0\.0475 BNB/); assert.equal(app.$('payout-container').textContent, '0.5 BEM');
  assert.equal(app.events.at(-1).id, '50');
  assert.equal(app.wallet.calls.length, 0);
});
test('actual index wallet connection, selection and even forced write-button handlers never sign a financial transaction', async () => {
  const app = await harness(); await app.connect();
  await until(() => app.$('wallet-balances').textContent.includes('1 BEM'), 'readonly balance');
  app.$('ticket-count').value = '1000'; await app.$('ticket-count').emit('input'); assert.equal(app.$('purchase-total').textContent, '10 BEM');
  await app.choose('10'); assert.equal(app.$('ticket-count').value, '1'); assert.equal(app.$('purchase-total').textContent, '0.001 BEM');
  for (const id of ['approve', 'buy', 'refund', 'check-refund']) { assert.equal(app.$(id).disabled, true); await app.$(id).emit('click'); }
  assert.ok(app.wallet.calls.every(call => ['eth_requestAccounts', 'eth_accounts', 'eth_chainId'].includes(call.method)));
  const rpcCalls = app.calls.filter(call => call.path === '/rpc').flatMap(call => JSON.parse(call.options.body));
  assert.ok(rpcCalls.every(call => ['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getBalance'].includes(call.method)));
  assert.ok(app.calls.every(call => !String(call.options.body ?? '').includes('0xBee0848D')));
});
test('a late old-account balance cannot overwrite the newly connected wallet in the actual player entry', async () => {
  const older = deferred(); let firstSeen = false;
  const app = await harness({ balanceHook: account => account.toLowerCase() === A.toLowerCase() ? (firstSeen = true, older.promise) : 200000000n });
  await app.connect(); await until(() => firstSeen, 'first-account balance query');
  app.wallet.account = B; await app.wallet.emit('accountsChanged'); await app.connect();
  await until(() => app.$('wallet-balances').textContent.startsWith('2 BEM'), 'new-account balance');
  older.resolve(99900000000n); await tick(); await tick();
  assert.equal(app.$('wallet-address').textContent, B); assert.match(app.$('wallet-balances').textContent, /^2 BEM/);
  assert.doesNotMatch(app.$('wallet-balances').textContent, /999/);
});

test('shared winner announcements render only validated rows, preserve pause across language changes and stay read-only', async () => {
  const row = { poolId: '10', gameAddress: A, transactionHash: '0x' + 'ab'.repeat(32), roundId: '1', amountBaseUnits: '950000000', timeUtc: '2026-09-07T12:00:00Z', winner: B };
  const app = await harness({ language: 'en', announcements: [row, { ...row, roundId: '2' }, { ...row, transactionHash: 'javascript:alert(1)', winner: '<script>bad</script>' }] });
  const ticker = app.$('winner-ticker'), pause = app.$('ticker-pause');
  assert.match(ticker.textContent, /won 9.5 BEM/);
  assert.doesNotMatch(ticker.textContent, /bad|javascript/);
  assert.equal(pause.hidden, false);
  const [original, duplicate] = ticker.children[0].children;
  assert.equal(original.children.length, 2);
  assert.ok(original.querySelectorAll('a').every(link => link.href === `https://bscscan.com/tx/${row.transactionHash}` && link.rel === 'noopener noreferrer'));
  assert.equal(duplicate.getAttribute('aria-hidden'), 'true');
  assert.ok(duplicate.querySelectorAll('a').every(link => link.tabIndex === -1));
  await pause.emit('click');
  assert.equal(pause.getAttribute('aria-pressed'), 'true');
  assert.equal(pause.textContent, 'Resume');
  await app.$('language-zh').emit('click');
  assert.equal(pause.textContent, '继续');
  assert.equal(pause.getAttribute('aria-pressed'), 'true');
  assert.match(ticker.textContent, /中了 9.5 BEM/);
  assert.equal(app.calls.filter(call => call.path === '/api/announcements?pageSize=20').length, 1, 'one shared feed request, no duplicate ticker initialization');
  assert.equal(app.wallet.calls.length, 0);
});


test('the single visible purchase button confirms its approval then submits the same purchase without a second page click', async () => {
  const actions = []; let pending = null, records = [], allowance = 0n;
  const getState = () => ({busy:false, blocking:!!pending, records:pending?[pending]:records});
  const app = await harness({search:'?pool=1', testFactory: options => ({
    getState,
    readState: async account => ({account,blockNumber:120000001,roundId:1n,currentRoundId:1n,timestamp:100n,
      round:{status:1,sold:0n,fundingDeadline:10000n},myCount:0n,allowance,bemBalance:100000000n,
      seriesAuthorized:true,consumerAuthorized:true,canBuy:true,canRefund:false,canSettle:false}),
    execute:async (kind,input) => { actions.push({kind,input}); pending={id:kind,hash:'0x'+(kind==='approve'?'a':'b').repeat(64),kind,input,account:A,status:'pending'}; options.onUpdate(); return {...pending}; },
    checkPending:async()=>{if(pending){records=[{...pending,status:'confirmed'}];if(pending.kind==='approve')allowance=10000n;pending=null;options.onUpdate();}return getState();},
  })});
  await app.connect();await until(()=>!app.$('buy').disabled,'single purchase available');
  assert.equal(app.$('approve').hidden,true);
  await app.$('buy').emit('click');await until(()=>actions.length===2,'automatic purchase continuation');
  assert.deepEqual(actions.map(x=>x.kind),['approve','buy']);
  assert.equal(actions[0].input.roundId,actions[1].input.roundId);assert.equal(actions[1].input.quantity,1);
  await app.surface.emit('beforeunload');
});
