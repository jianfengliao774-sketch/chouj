import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Interface, formatUnits, getAddress, toQuantity } from 'ethers';
import { poolRegistry } from '../bem-production-site/pools.mjs';
import { quoteView } from '../bem-production-site/web/market-guards.js';
import { validateRecords, transactionUrl } from '../bem-production-site/web/public-record-guards.js';

const WEB = new URL('../bem-production-site/web/', import.meta.url);
const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
const token = new Interface(['function balanceOf(address) view returns(uint256)']);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition, label) { for (let n = 0; n < 100; n++) { if (condition()) return; await tick(); } throw new Error(`Timed out: ${label}`); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

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

async function harness({ language = 'zh', search = '', balanceHook = null } = {}) {
  const html = fs.readFileSync(new URL('index.html', WEB), 'utf8'), elements = new Map(), all = [];
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
  wallet.request = async ({ method, params }) => { wallet.calls.push({ method, params });
    if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [wallet.account];
    if (method === 'eth_chainId') return wallet.chain;
    if (method === 'wallet_switchEthereumChain') { wallet.chain = params[0].chainId; await wallet.emit('chainChanged'); return null; }
    throw new Error(`Unexpected wallet method ${method}`);
  };
  const storage = new Map([['bem2075-player-language', language]]), quote = { chainId: 56, token: poolRegistry().bemAddress,
    source: 'DEX Screener', stale: false, updatedAt: new Date().toISOString(),
    usdt: { price: '2', pairAddress: A }, bnb: { price: '0.001', pairAddress: B } };
  const sandbox = { Interface, formatUnits, getAddress, toQuantity, quoteView, validateRecords, transactionUrl,
    document, window: surface, location: { href: `https://example.invalid/${search}`, origin: 'https://example.invalid', search },
    navigator: { clipboard: { writeText: async () => {} } }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    createWalletPicker: options => { options.onChange(new Map([['fixture', { provider: wallet, name: 'Synthetic wallet' }]])); return { open: () => options.onSelect({ provider: wallet }) }; },
    fetch: async (path, options = {}) => {
      calls.push({ path, options }); let result;
      if (path === '/api/pools') result = poolRegistry();
      else if (path === '/api/market') result = quote;
      else if (path.startsWith('/api/announcements')) result = { schemaVersion: 2, chainId: 56, rows: [], page: 1, totalPages: 0, total: 0, deploymentPending: true, index: { state: 'ready' } };
      else if (path === '/rpc') {
        const request = JSON.parse(options.body); let value;
        if (request.method === 'eth_chainId') value = '0x38';
        else if (request.method === 'eth_blockNumber') value = '0x64';
        else if (request.method === 'eth_getBalance') value = '0xde0b6b3a7640000';
        else if (request.method === 'eth_call') {
          const account = token.decodeFunctionData('balanceOf', request.params[0].data)[0];
          value = token.encodeFunctionResult('balanceOf', [balanceHook ? await balanceHook(account) : 100000000n]);
        } else throw new Error(`Unexpected RPC method ${request.method}`);
        result = { jsonrpc: '2.0', id: request.id, result: value };
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
  evaluate('player-i18n.js', ['t', 'getLocale', 'initLanguage', 'translateKnown', 'setLanguage']);
  evaluate('pool-selection.js', ['createPoolSelection', 'poolMetadata', 'getPoolRules']);
  evaluate('player-v2-state.js', ['createPendingPlayerState']);
  const entries = [...html.matchAll(/<script type="module" src="\/([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(entries, ['prize-market.js', 'public-records.js', 'player-v2.js'], 'actual module order installs price/history listeners before the pool event');
  for (const file of entries) evaluate(file);
  await until(() => elements.get('prize-usdt').textContent.includes('U') && calls.some(call => call.path === '/api/pools'), 'initial rendering');
  await tick();
  return { $: id => elements.get(id), calls, events, wallet, surface, context,
    async connect() { await elements.get('connect-wallet').emit('click'); await until(() => elements.get('wallet-address').textContent === wallet.account, 'wallet connection'); },
    async choose(id) { const button = elements.get('pool-selection').querySelectorAll('button').find(node => node.dataset.pool === id); assert.ok(button); await button.emit('click'); },
  };
}

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
  const rpcCalls = app.calls.filter(call => call.path === '/rpc').map(call => JSON.parse(call.options.body));
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
