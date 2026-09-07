import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletRegistry, createWalletPicker } from '../bem-production-site/web/wallet-picker.js';

function provider() {
  const instance = { requests: [], request(args) { instance.requests.push(args); throw new Error('Discovery must not request wallet access'); } };
  return instance;
}
function announce(target, wallet, info = {}) {
  const event = new Event('eip6963:announceProvider');
  Object.defineProperty(event, 'detail', { value: { provider: wallet, info: { uuid: 'wallet-uuid', name: 'Wallet A', rdns: 'org.example.a', ...info } } });
  target.dispatchEvent(event);
}
const values = registry => [...registry.entries().values()];

test('TP and MetaMask mobile flags identify their own cards without wallet access', () => {
  for(const [flags,name,rdns] of [
    [{isTokenPocket:true,isMetaMask:true},'TokenPocket','pro.tokenpocket'],
    [{isTp:true,isMetaMask:true},'TokenPocket','pro.tokenpocket'],
    [{isMetaMask:true},'MetaMask','io.metamask'],
  ]){
    const target=new EventTarget(),wallet=Object.assign(provider(),flags);target.ethereum=wallet;
    const registry=createWalletRegistry(target,()=>{});registry.discover();
    assert.equal(values(registry).length,1);
    assert.equal(values(registry)[0].name,name);assert.equal(values(registry)[0].rdns,rdns);
    assert.equal(values(registry)[0].provider,wallet);assert.deepEqual(wallet.requests,[]);
  }
});

test('specific wallet flags take precedence over MetaMask compatibility flags', () => {
  for(const [flags,name] of [
    [{isTokenPocket:true},'TokenPocket'],[{isOkxWallet:true},'OKX Wallet'],
    [{isBinance:true},'Binance Wallet'],[{isTrust:true},'Trust Wallet'],
    [{isRabby:true},'Rabby Wallet'],[{isCoinbaseWallet:true},'Coinbase Wallet'],
  ]){
    const target=new EventTarget();target.ethereum=Object.assign(provider(),{isMetaMask:true},flags);
    const registry=createWalletRegistry(target,()=>{});registry.discover();
    assert.equal(values(registry)[0].name,name);
  }
});

test('OKX dedicated, nested and shared mobile providers expose the OKX card without account requests', () => {
  for (const injection of ['dedicated','nested','shared','legacyFlag']) {
    const target = new EventTarget(), okx = provider();
    if(injection==='dedicated')target.okxwallet=okx;
    else if(injection==='nested')target.okxwallet={ethereum:okx};
    else {okx[injection==='legacyFlag'?'isOKExWallet':'isOkxWallet']=true;target.ethereum=okx;}
    const registry=createWalletRegistry(target,()=>{});registry.discover();
    assert.equal(values(registry).length,1,injection);
    assert.equal(values(registry)[0].provider,okx);
    assert.equal(values(registry)[0].name,'OKX Wallet',injection);
    assert.equal(values(registry)[0].rdns,'com.okx.wallet');
    assert.deepEqual(okx.requests,[]);
  }
});

test('OKX aliases deduplicate by identity and do not take over another shared provider', () => {
  const target=new EventTarget(),okx=provider(),other=provider();
  target.okxwallet=okx;target.ethereum=other;other.providers=[other,okx];
  const registry=createWalletRegistry(target,()=>{});registry.discover();
  assert.equal(values(registry).length,2);
  assert.equal(values(registry).filter(e=>e.provider===okx).length,1);
  assert.equal(values(registry).find(e=>e.provider===okx).name,'OKX Wallet');
  assert.equal(values(registry).find(e=>e.provider===other).rdns,'');
});

test('Binance dedicated injection and mobile shared injection are detected without requesting accounts', () => {
  for (const dedicated of [true, false]) {
    const target = new EventTarget(), binance = provider();
    if (dedicated) target.binancew3w = {ethereum: binance};
    else { binance.isBinance = true; target.ethereum = binance; }
    const registry = createWalletRegistry(target, () => {}); registry.discover();
    assert.equal(values(registry).length, 1);
    assert.equal(values(registry)[0].provider, binance);
    assert.equal(values(registry)[0].rdns, 'com.binance.wallet');
    assert.equal(values(registry)[0].name, 'Binance Wallet');
    assert.deepEqual(binance.requests, []);
  }
});

test('Binance aliases deduplicate by object while other injected providers remain available', () => {
  const target = new EventTarget(), binance = provider(), other = provider();
  target.binancew3w = {ethereum: binance}; target.ethereum = binance; binance.providers = [other, binance];
  const registry = createWalletRegistry(target, () => {}); registry.discover();
  assert.equal(values(registry).length, 2);
  assert.equal(values(registry).filter(e => e.provider === binance).length, 1);
  assert.ok(values(registry).some(e => e.provider === other));
});

test('late native injection is discovered on initialization and focus without access requests', () => {
  const target = new EventTarget(), binance = provider(); let changes = 0;
  const registry = createWalletRegistry(target, () => { changes++; }); registry.discover();
  target.binancew3w = {ethereum: binance}; target.dispatchEvent(new Event('ethereum#initialized'));
  assert.equal(values(registry)[0].provider, binance);
  target.dispatchEvent(new Event('focus')); assert.equal(changes, 2);
  assert.deepEqual(binance.requests, []);
});

test('mixed EIP-6963 and legacy wallets stay independently selectable without requesting accounts', () => {
  const target = new EventTarget(), announced = provider(), legacy = provider();
  target.ethereum = legacy;
  target.addEventListener('eip6963:requestProvider', () => announce(target, announced));
  const registry = createWalletRegistry(target, () => {});
  registry.discover();
  assert.deepEqual(new Set(values(registry).map(entry => entry.provider)), new Set([announced, legacy]));
  assert.equal(values(registry).find(entry => entry.provider === announced).name, 'Wallet A');
  assert.deepEqual([...announced.requests, ...legacy.requests], []);
});

test('same provider in shared injection, providers array and multiple announcements appears once', () => {
  const target = new EventTarget(), a = provider(), b = provider();
  a.providers = [a, b, a, b]; target.ethereum = a;
  target.addEventListener('eip6963:requestProvider', () => {
    announce(target, a, { uuid: 'a1', name: 'MetaMask', rdns: 'io.metamask' });
    announce(target, a, { uuid: 'a2', name: 'A second announcement' });
  });
  const registry = createWalletRegistry(target, () => {});registry.discover();registry.discover();
  assert.equal(values(registry).length, 2);
  assert.equal(values(registry).filter(entry => entry.provider === a).length, 1);
  assert.equal(values(registry).find(entry => entry.provider === a).name, 'MetaMask');
  assert.deepEqual([...a.requests, ...b.requests], []);
});

test('late announcements upgrade metadata without removing other wallets or changing the provider id', () => {
  const target = new EventTarget(), a = provider(), b = provider();
  target.ethereum = { providers: [a, b] };
  const registry = createWalletRegistry(target, () => {});registry.discover();
  const originalId = values(registry).find(entry => entry.provider === a).id;
  announce(target, a, { name: 'Rabby Wallet', rdns: 'io.rabby' });
  assert.equal(values(registry).length, 2);
  assert.equal(values(registry).find(entry => entry.provider === a).id, originalId);
  assert.equal(values(registry).find(entry => entry.provider === a).name, 'Rabby Wallet');
  target.ethereum.providers = [b, a];registry.discover();
  assert.equal(values(registry).find(entry => entry.provider === a).id, originalId);
  assert.ok(values(registry).some(entry => entry.provider === b));
});

test('distinct providers never merge merely because UUID, brand name or rdns match', () => {
  const target = new EventTarget(), a = provider(), b = provider();
  const registry = createWalletRegistry(target, () => {});
  for (const wallet of [a, b]) announce(target, wallet, { uuid: 'same-uuid', name: 'MetaMask', rdns: 'io.metamask' });
  assert.equal(values(registry).length, 2);
  assert.equal(new Set(values(registry).map(entry => entry.id)).size, 2);
  assert.deepEqual(new Set(values(registry).map(entry => entry.provider)), new Set([a, b]));
});

test('rediscovery drops removed legacy providers, preserves surviving ids and handles empty provider arrays', () => {
  const target = new EventTarget(), a = provider(), b = provider();
  target.ethereum = { providers: [a, b] };
  const registry = createWalletRegistry(target, () => {});registry.discover();
  const bId = values(registry).find(entry => entry.provider === b).id;
  target.ethereum.providers = [b];registry.discover();
  assert.equal(values(registry).length, 1);assert.equal(values(registry)[0].id, bId);
  b.providers = [];target.ethereum = b;registry.discover();
  assert.equal(values(registry).length, 1);assert.equal(values(registry)[0].provider, b);
  target.ethereum = null;registry.discover();assert.equal(values(registry).length, 0);
});

test('malformed announcements and invalid injections do not break discovery or trigger a wallet request', () => {
  const target = new EventTarget(), valid = provider();
  target.ethereum = { providers: [undefined, null, {}, { request: true }, valid] };
  const registry = createWalletRegistry(target, () => {});
  announce(target, valid, { uuid: '', name: 'Ignored' });
  announce(target, valid, { name: '   ' });
  announce(target, { request: 'not callable' });
  registry.discover();assert.equal(values(registry).length, 1);assert.equal(values(registry)[0].provider, valid);
  registry.entries().clear();assert.equal(values(registry).length, 1);
  assert.deepEqual(valid.requests, []);
});

// A small DOM fixture tests actual card rendering and click routing, without a browser or wallet.
class Element extends EventTarget {
  constructor(tag = 'div') { super();this.tagName = tag;this.children = [];this.dataset = {};this.textContent = '';this.attributes = {};this.classList = { add() {}, remove() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  querySelectorAll(tag) { return this.children.flatMap(child => [ ...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag) ]); }
  focus() { document.activeElement = this; }
}
function fixture(t, wallets) {
  const originalDocument = globalThis.document;
  const document = { activeElement: null, createElement: tag => new Element(tag), body: new Element('body') };
  globalThis.document = document;
  t.after(() => { dialog.close(); if (originalDocument === undefined) delete globalThis.document;else globalThis.document = originalDocument; });
  const dialog = new Element('dialog');
  const nodes = Object.fromEntries(['wallet-options','wallet-picker-hint','wallet-picker-close','wallet-picker-refresh'].map(id => [id, new Element()]));
  dialog.querySelector = selector => nodes[selector.slice(1)];
  dialog.close = () => { dialog.open = false;dialog.dispatchEvent(new Event('close')); };
  dialog.showModal = () => { dialog.open = true; };
  const target = new EventTarget();
  target.addEventListener('eip6963:requestProvider', () => wallets.forEach(({provider, info}) => announce(target, provider, info)));
  const selected = [];
  const picker = createWalletPicker({dialog, target, onChange() {}, onSelect: entry => selected.push(entry)});
  return {nodes, dialog, target, selected, picker, cards: () => nodes['wallet-options'].children};
}
const cardName = card => card.querySelectorAll('strong')[0].textContent;
const cardIcon = card => card.querySelectorAll('img')[0]?.src;

test('TP and MetaMask injected together remain separately selectable with their own icons', t => {
  const ui=fixture(t,[]),tp=Object.assign(provider(),{isTokenPocket:true,isMetaMask:true}),fox=Object.assign(provider(),{isMetaMask:true});
  ui.target.ethereum={providers:[tp,fox]};ui.picker.open();
  const tpCard=ui.cards().find(c=>cardName(c)==='TokenPocket'),foxCard=ui.cards().find(c=>cardName(c)==='MetaMask');
  assert.equal(tpCard.disabled,false);assert.equal(foxCard.disabled,false);
  assert.equal(cardIcon(tpCard),'/wallet-icons/tokenpocket.png');assert.equal(cardIcon(foxCard),'/wallet-icons/metamask.svg');
  tpCard.dispatchEvent(new Event('click'));assert.equal(ui.selected[0].provider,tp);
  ui.picker.open();ui.cards().find(c=>cardName(c)==='MetaMask').dispatchEvent(new Event('click'));
  assert.equal(ui.selected[1].provider,fox);assert.deepEqual([...tp.requests,...fox.requests],[]);
});

test('OKX injected after the original three-second window remains discoverable until the picker closes', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const ui=fixture(t,[]),okx=provider();ui.picker.open();
  t.mock.timers.tick(5000);
  assert.equal(ui.cards().find(c=>cardName(c)==='OKX Wallet').disabled,true);
  ui.target.okxwallet=okx;t.mock.timers.tick(1000);
  const card=ui.cards().find(c=>cardName(c)==='OKX Wallet');
  assert.equal(card.disabled,false);assert.equal(cardIcon(card),'/wallet-icons/okx.png');
  card.dispatchEvent(new Event('click'));assert.equal(ui.selected[0].provider,okx);
  ui.target.okxwallet=null;t.mock.timers.tick(5000);
  assert.equal(ui.cards().find(c=>cardName(c)==='OKX Wallet').disabled,false,'Closing stops periodic discovery');
});

test('Binance injected after opening appears on its own card and clicks route to that provider', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = fixture(t, []), binance = provider(); ui.picker.open();
  assert.ok(ui.cards().find(c => cardName(c) === 'Binance Wallet').disabled);
  ui.target.binancew3w = {ethereum: binance}; t.mock.timers.tick(750);
  const card = ui.cards().find(c => cardName(c) === 'Binance Wallet');
  assert.equal(card.disabled, false); assert.equal(cardIcon(card), '/wallet-icons/binance.svg');
  card.dispatchEvent(new Event('click'));
  assert.equal(ui.selected[0].provider, binance); assert.equal(ui.dialog.open, false);
  assert.deepEqual(binance.requests, []);
});

test('cards preserve separate same-brand providers and connect only the exact clicked provider', t => {
  const a = provider(), b = provider();
  const ui = fixture(t, [{provider:a,info:{uuid:'a',name:'MetaMask',rdns:'io.metamask'}},{provider:b,info:{uuid:'b',name:'MetaMask',rdns:'io.metamask'}}]);
  ui.picker.open();assert.equal(ui.dialog.open,true);
  const active = ui.cards().filter(card => !card.disabled);
  assert.equal(active.length,2);assert.deepEqual(ui.selected,[]);
  active[1].dispatchEvent(new Event('click'));
  assert.equal(ui.selected.length,1);assert.equal(ui.selected[0].provider,b);assert.equal(ui.dialog.open,false);
  assert.deepEqual([...a.requests,...b.requests],[]);
});

test('partial or conflicting wallet names cannot adopt another wallet brand or hide its undetected card', t => {
  const ui = fixture(t, [
    {provider:provider(),info:{uuid:'compatible',name:'MetaMask Compatible',rdns:''}},
    {provider:provider(),info:{uuid:'conflict',name:'MetaMask',rdns:'org.example.independent'}},
    {provider:provider(),info:{uuid:'trust',name:'Distrust Wallet',rdns:''}},
  ]);
  const active = ui.cards().filter(card => !card.disabled);
  assert.equal(active.length,3);
  assert.ok(active.every(card => !cardIcon(card)));
  assert.ok(ui.cards().some(card => card.disabled && cardName(card)==='MetaMask'));
  assert.ok(ui.cards().some(card => card.disabled && cardName(card)==='Trust Wallet'));
});

test('known rdns takes precedence over a conflicting name, while unknown injected wallets remain usable', t => {
  const rabby=provider(),unknown=provider();
  const ui=fixture(t,[{provider:rabby,info:{uuid:'a',name:'MetaMask Compatible',rdns:'io.rabby'}},{provider:unknown,info:{uuid:'b',name:'Independent Wallet',rdns:'org.example.wallet'}}]);
  const active=ui.cards().filter(card=>!card.disabled);
  assert.equal(cardIcon(active[0]),'/wallet-icons/rabby.png');
  assert.equal(cardName(active[1]),'Independent Wallet');
  active[1].dispatchEvent(new Event('click'));assert.equal(ui.selected[0].provider,unknown);
  assert.ok(ui.cards().some(card=>card.disabled&&cardName(card)==='MetaMask'));
});
