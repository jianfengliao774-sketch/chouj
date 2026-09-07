import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { formatUnits } from 'ethers';
import { POOL_IDS, profile } from '../bem-production-site/web/sparkdraw-profiles.js';
import { playerPageHtml } from '../bem-production-site/player-page-template.mjs';
import { formatWalletBalance3 } from '../bem-production-site/web/balance-display.js';

const web = new URL('../bem-production-site/web/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, web), 'utf8');
const player = read('sparkdraw-player.js');
const selector = player.slice(player.indexOf('function renderSelector()'), player.indexOf('\nasync function refresh'));

test('wallet balances round to exactly three decimal places without floating-point loss', () => {
  assert.equal(formatWalletBalance3(3586919046n, 8), '35.869');
  assert.equal(formatWalletBalance3(232611110125002939n, 18), '0.233');
  assert.equal(formatWalletBalance3(0n, 8), '0.000');
  assert.equal(formatWalletBalance3(100000000n, 8), '1.000');
  assert.equal(formatWalletBalance3(99950000n, 8), '1.000');
  assert.equal(formatWalletBalance3(49999n, 8), '0.000');
  assert.equal(formatWalletBalance3(50000n, 8), '0.001');
  assert.equal(formatWalletBalance3(123456789012345678901234567890n, 18), '123456789012.346');
  assert.equal(formatWalletBalance3(1n, 3), '0.001');
  assert.throws(() => formatWalletBalance3(-1n, 8));
  assert.throws(() => formatWalletBalance3(1n, 2));
});

test('rounded values are used only for wallet text and full precision remains available', () => {
  const lines = player.split('\n').filter(line => line.includes('formatWalletBalance3('));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("$('wallet-balances').textContent"));
  assert.match(player, /Full balance: BEM \{bem\} · BNB \{bnb\}/);
  assert.doesNotMatch(read('sparkdraw-transactions.js'), /formatWalletBalance3|balance-display/);
});

test('personal participation is displayed before secondary contract details', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('id="panel-mine"') < html.indexOf('class="card verification-card"'));
});
class Node {
  constructor(tag, text = '') { this.tag = tag; this.text = text; this.children = []; this.attributes = {}; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(' '); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
}
function fixture(language) {
  const list = new Node('section');
  const ctx = vm.createContext({
    $: () => list, el: (tag, text) => new Node(tag, text),
    t: (zh, en, params = {}) => (language === 'en' ? en : zh).replace(/\{(\w+)\}/g, (_, key) => params[key]),
    money: value => formatUnits(value, 8).replace(/\.0$/, ''), profile, POOL_IDS,
    button: (label, onClick) => Object.assign(new Node('button', label), { onClick }),
    pool: '0.1', revision: 0, snapshot: {}, held: 3n, historyPage: 2,
    url: new URL('https://example.invalid/?pool=0.1#mine'),
    history: { replaceState() {} }, render() {}, refresh() {}, refreshRecords() {},
  });
  vm.runInContext(selector + '; renderSelector();', ctx);
  return { list, ctx };
}

test('both languages show the common 10000-ticket heading and current five-pool prices', () => {
  for (const language of ['zh', 'en']) {
    const { list } = fixture(language), [heading, group] = list.children;
    assert.equal(heading.textContent, language === 'zh' ? '选择场次（每个场次均为10,000份）' : 'Choose a pool (10,000 tickets per pool)');
    assert.equal(group.children.length, 5);
    group.children.forEach((button, index) => {
      const id = POOL_IDS[index], price = formatUnits(profile(id).ticketPrice, 8);
      assert.ok(button.children[0].textContent.startsWith(`${id} BEM`));
      assert.equal(button.children[1].textContent, language === 'zh' ? `每份 ${price} BEM` : `${price} BEM per ticket`);
      assert.equal(button.attributes.role, 'radio');
      assert.equal(button.attributes['aria-checked'], String(id === '0.1'));
    });
  }
});
test('restyled pool buttons preserve selection invalidation and the current tab', () => {
  const { list, ctx } = fixture('zh');
  list.children[1].children[0].onClick();
  assert.equal(ctx.revision, 0);
  list.children[1].children[4].onClick();
  assert.equal(ctx.pool, '100'); assert.equal(ctx.revision, 1);
  assert.equal(ctx.snapshot, null); assert.equal(ctx.held, 0n); assert.equal(ctx.historyPage, 1);
  assert.equal(ctx.url.searchParams.get('pool'), '100'); assert.equal(ctx.url.hash, '#mine');
});
test('shared pages retain current transaction controls, drand and Vite-managed branding', () => {
  const index = read('index.html'), burns = read('burns.html');
  for (const isBurnPage of [false, true]) {
    const html = playerPageHtml(index, burns, isBurnPage);
    for (const id of ['buy', 'approve', 'draw-actions', 'refund', 'panel-mine', 'pending-prizes', 'pending-refunds', 'burn-wallet-records']) assert.ok(html.includes(`id="${id}"`), id);
    assert.match(html, /src="\/sparkdraw-player\.js"/);
    assert.doesNotMatch(html, /src="\/player-v2\.js"|Chainlink VRF/);
    assert.match(html, /drand/); assert.match(html, /max="5000"/);
    assert.match(html, /href="\.\/assets\/sparkdraw-mark\.svg"/);
    assert.match(html, /src="\.\/assets\/sparkdraw-emblem\.svg"/);
    assert.doesNotMatch(html, /src="\/sparkdraw-(?:mark|emblem)\.svg"/);
  }
});
test('community copy stays multiline without reverting new burn percentages or claim rules', () => {
  assert.match(player, /Tapeout 生态建设添一份力量。\\n每次成功开奖，实收金额的 \{burn\}%/);
  assert.match(player, /\{burn:p\.burnPercent\}/);
  assert.match(player, /本期开奖（第\{round\}期）/);
  assert.match(player, /奖金也须在结算后 24 小时内领取/);
  assert.match(read('sparkdraw.css'), /community-copy \{ white-space: pre-line/);
});
