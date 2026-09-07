import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { formatUnits } from 'ethers';
import { validateRecords, transactionUrl } from '../bem-production-site/web/public-record-guards.js';

const WEB = new URL('../bem-production-site/web/', import.meta.url);
const ADDRESS = '0x1234567890123456789012345678901234567890';
const HASH = '0x' + 'ab'.repeat(32);
const ROW = { poolId: '10', gameAddress: ADDRESS, transactionHash: HASH, roundId: '7',
  amountBaseUnits: '950000000', timeUtc: '2026-09-07T12:34:56Z', winner: ADDRESS };
const response = (rows = [], state = 'ready') => ({ ok: true, json: async () => ({ schemaVersion: 2,
  chainId: 56, rows, page: 1, totalPages: rows.length ? 1 : 0, total: rows.length, index: { state } }) });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this._text = '';
    this.hidden = false; this.classes = new Set();
    this.classList = { toggle: (key, on) => { if (on) this.classes.add(key); else this.classes.delete(key); } };
  }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  querySelectorAll(tag) { return this.children.flatMap(n => [...(n.tagName === tag ? [n] : []), ...n.querySelectorAll(tag)]); }
  cloneNode(deep) {
    const n = new Element(this.tagName); n.attributes = { ...this.attributes }; n._text = this._text;
    for (const key of ['href', 'target', 'rel', 'title', 'dateTime']) n[key] = this[key];
    if (deep) n.children = this.children.map(child => child.cloneNode(true));
    return n;
  }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) ?? []) fn(event); return true; }
  click() { this.dispatchEvent({ type: 'click' }); }
}

function harness({ page = 'index.html', language = 'zh', fetchReply = () => response() } = {}) {
  const html = fs.readFileSync(new URL(page, WEB), 'utf8');
  for (const id of ['winner-ticker', 'ticker-pause', 'language-zh', 'language-en']) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${page}: one ${id}`);
  }
  if (page === 'legacy.html') assert.match(html, /src="\/winner-broadcast\.js"/);
  else assert.match(fs.readFileSync(new URL('public-records.js', WEB), 'utf8'), /import '\.\/winner-broadcast\.js'/);
  const elements = new Map(), all = [];
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*)>([^<]*)/g)) {
    const node = new Element(match[1]); node.textContent = match[3];
    for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
    all.push(node); if (node.getAttribute('id')) elements.set(node.getAttribute('id'), node);
  }
  const window = new Element(), document = {
    documentElement: { lang: 'zh-CN' }, hidden: false,
    getElementById: id => elements.get(id),
    querySelectorAll: selector => all.filter(node => node.getAttribute(selector.slice(1, -1)) !== null),
    createElement: tag => new Element(tag),
    createTextNode: value => { const n = new Element('#text'); n.textContent = value; return n; },
  };
  const calls = [], intervals = [], storage = new Map([['bem2075-player-language', language]]);
  const context = vm.createContext({ document, window, formatUnits, validateRecords, transactionUrl,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (url, options) => { calls.push({ url, options }); return fetchReply(calls.length); },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); }, AbortSignal, Date, CustomEvent });
  function load(file, exports = []) {
    const source = fs.readFileSync(new URL(file, WEB), 'utf8').replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
    new vm.Script(`(()=>{${source}\nObject.assign(globalThis,{${exports.join(',')}});})()`, { filename: file }).runInContext(context);
  }
  load('player-i18n.js', ['t', 'getLocale', 'initLanguage']);
  load('winner-broadcast.js');
  context.initLanguage();
  return { $: id => elements.get(id), document, window, calls, intervals,
    heading: all.find(n => n.getAttribute('data-en') === 'WINNERS'),
    switchTo: lang => elements.get(`language-${lang}`).click(),
    refresh: () => window.dispatchEvent(new CustomEvent('bem:historyrefresh')) };
}

for (const page of ['index.html', 'legacy.html']) {
  test(`${page}: saved English, initial loading and ready-empty states follow both language buttons`, async () => {
    const gate = deferred(), app = harness({ page, language: 'en', fetchReply: () => gate.promise });
    assert.equal(app.$('winner-ticker').textContent, 'Reading confirmed draws…');
    assert.equal(app.heading.textContent, 'WINNERS');
    app.switchTo('zh');
    assert.equal(app.$('winner-ticker').textContent, '正在读取已确认开奖…');
    gate.resolve(response()); await tick();
    assert.equal(app.$('winner-ticker').textContent, '等待首位中奖者 · 开奖后自动播报');
    app.switchTo('en');
    assert.equal(app.$('winner-ticker').textContent, 'Awaiting the first winner · Confirmed draws appear here');
    assert.equal(app.$('ticker-pause').hidden, true);
    assert.equal(app.calls.length, 1, 'language changes do not fetch or send transactions');
  });
}

test('confirmed indexed winners remain visible while the index catches up with newer blocks', async () => {
  const app = harness({ fetchReply: () => response([ROW], 'syncing') }); await tick();
  assert.match(app.$('winner-ticker').textContent, /中了 9.5 BEM/);
  app.switchTo('en'); assert.match(app.$('winner-ticker').textContent, /won 9.5 BEM/);
  assert.equal(app.$('winner-ticker').querySelectorAll('a').length, 1);
});

test('unavailable and invalid responses have translated error states and recover on the read-only refresh', async () => {
  const app = harness({ fetchReply: number => number === 1 ? { ok: false } : number === 2
    ? { ok: true, json: async () => ({ ...response(), schemaVersion: 2, chainId: 1 }) } : response() });
  await tick(); assert.match(app.$('winner-ticker').textContent, /暂时无法加载/);
  app.switchTo('en'); assert.match(app.$('winner-ticker').textContent, /temporarily unavailable/);
  app.refresh(); await tick(); assert.match(app.$('winner-ticker').textContent, /temporarily unavailable/);
  app.refresh(); await tick(); assert.match(app.$('winner-ticker').textContent, /Awaiting the first winner/);
  assert.ok(app.calls.every(call => call.url === '/api/announcements?pageSize=20' && !call.options.method));
  assert.equal(app.intervals[0].ms, 30000);
});

test('confirmed winners localize amount, dates, receipt labels and pause while retaining exact addresses and evidence', async () => {
  const app = harness({ fetchReply: () => response([ROW, { ...ROW, poolId: 'legacy100', roundId: '9', amountBaseUnits: '9500000000' },
    { ...ROW, winner: '<script>bad</script>', transactionHash: 'javascript:alert(1)' }]) }); await tick();
  const ticker = app.$('winner-ticker'), pause = app.$('ticker-pause');
  assert.match(ticker.textContent, /中了 9.5 BEM/); assert.match(ticker.textContent, /原 100 BEM 场/);
  pause.click(); assert.equal(pause.textContent, '继续'); assert.equal(pause.getAttribute('aria-pressed'), 'true');
  app.switchTo('en');
  assert.match(ticker.textContent, /won 9.5 BEM/); assert.match(ticker.textContent, /Original 100 BEM pool/);
  assert.doesNotMatch(ticker.textContent, /中了|原 |bad|javascript/);
  const [group, duplicate] = ticker.children[0].children, link = group.querySelectorAll('a')[0];
  assert.equal(group.querySelectorAll('a').length, 2);
  assert.equal(link.href, `https://bscscan.com/tx/${HASH}`);
  assert.equal(link.rel, 'noopener noreferrer');
  assert.match(link.getAttribute('aria-label'), new RegExp(`Winner address ${ADDRESS}`));
  assert.match(link.getAttribute('aria-label'), /Round 7.*Winning time.*Prize 9.5 BEM.*View onchain receipt/);
  assert.equal(link.querySelectorAll('time')[0].dateTime, ROW.timeUtc);
  assert.equal(link.querySelectorAll('time')[0].textContent, new Date(ROW.timeUtc).toLocaleString('en-US'));
  assert.equal(duplicate.getAttribute('aria-hidden'), 'true');
  assert.ok(duplicate.querySelectorAll('a').every(n => n.tabIndex === -1));
  assert.equal(pause.textContent, 'Resume'); assert.equal(pause.getAttribute('aria-pressed'), 'true');
  pause.click(); assert.equal(pause.textContent, 'Pause'); assert.equal(pause.getAttribute('aria-pressed'), 'false');
  app.switchTo('zh'); assert.equal(pause.textContent, '暂停');
  assert.equal(ticker.children[0].children[0].querySelectorAll('time')[0].textContent, new Date(ROW.timeUtc).toLocaleString('zh-CN'));
  assert.equal(app.calls.length, 1);
});

test('an older failed request cannot replace a newer confirmed feed after an explicit refresh', async () => {
  const first = deferred(), app = harness({ fetchReply: number => number === 1 ? first.promise : response([ROW]) });
  app.refresh(); await tick(); assert.match(app.$('winner-ticker').textContent, /中了 9.5 BEM/);
  app.switchTo('en'); first.resolve({ ok: false }); await tick();
  assert.match(app.$('winner-ticker').textContent, /won 9.5 BEM/);
  assert.doesNotMatch(app.$('winner-ticker').textContent, /unavailable/);
});
