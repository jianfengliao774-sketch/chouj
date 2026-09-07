import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as ethers from 'ethers';
import * as formalGuards from '../bem-production-site/web/deploy-formal-guards.js';
import { Interface, getCreateAddress, keccak256 } from 'ethers';
import { DEPLOY_FIXED as F, DEPLOY_MODES, CONSTRUCTOR, CONSTRUCTOR_ARGS, deploymentData, validateDeploymentArtifact,
  verifyDeploymentRuntime, assertContainerBindings, expectedReadback, assertDeploymentReadback,
  assertDeploymentTransaction, assertCreationTransaction, assertUnsuccessfulDeployment, assertDeploymentIntent, assertResolvedReset, assertDeployer, FORMAL_VERSION, FORMAL_STORAGE_KEY, FORMAL_LOCK_KEY } from '../bem-production-site/web/deploy-formal-guards.js';

const ACCOUNT = F.deployer;
const OLD_AUTH = '0x358BE84b95224d228f3A61964Fa3c9fB61D7B646';
const OTHER = '0x2222222222222222222222222222222222222222';
const HASH = '0x' + 'a'.repeat(64), BLOCK_HASH = '0x' + 'b'.repeat(64), CANCEL_HASH = '0x' + 'c'.repeat(64);
function artifactFixture(mode = 'pool100') {
  const m = DEPLOY_MODES[mode], bytecode = '0x60' + ({ pool10: '0a', pool50: '32', pool100: '64' })[mode] + '6000', deployedBytecode = '0x6000' + '0'.repeat(64) + '6002';
  return { contractName: m.contractName, testOnly: false, contractVersion: 3, architecture: FORMAL_VERSION, abi: JSON.parse(new Interface(CONSTRUCTOR).formatJson()),
    bytecode, deployedBytecode, creationBytecodeBytes: 4, runtimeBytecodeBytes: 36, immutableReferences: { '1': [{ start: 2, length: 32 }] },
    fixedBindings: { processor: F.processor, processorId: 2075, authorizationContainer: F.authorizationContainer, authorizationNft: F.authorizationNft, authorizationTokenId: 13061,
      revenueContainer: F.revenueContainer, revenueNft: F.revenueNft, revenueTokenId: 13061 },
    fixedRules: { partialFill: true, poolBaseUnits: m.pool, ticketPriceBaseUnits: m.ticketPrice, ticketsPerRound: 10000, maxTicketsPerPurchase: 1000,
      maxTicketsPerAddress: 5000, blackholeBaseUnits: m.blackhole, organizerBaseUnits: m.organizer, winnerBaseUnits: m.winner,
      fundingWindowSeconds: 86400, refundClaimWindowSeconds: 86400 } };
}
test('three formal deployments pin 10000 shares, individual prices, recipient, authorization and 24h+24h windows', async () => {
  assert.equal(Object.keys(DEPLOY_MODES).length, 3);
  for (const [mode, selected] of Object.entries(DEPLOY_MODES)) {
    const artifact = artifactFixture(mode); validateDeploymentArtifact(artifact, mode);
    const data = await deploymentData(artifact, mode);
    assert.equal(data, artifact.bytecode + new Interface(CONSTRUCTOR).encodeDeploy(CONSTRUCTOR_ARGS).slice(2));
    assert.equal(BigInt(selected.ticketPrice) * 10000n, BigInt(selected.pool));
    assert.equal(BigInt(selected.blackhole) + BigInt(selected.organizer) + BigInt(selected.winner), BigInt(selected.pool));
    assert.equal(BigInt(selected.winner) * 100n, BigInt(selected.pool) * 95n);
    const expected = expectedReadback(mode, 100); assertDeploymentReadback(expected, mode, 100);
    assert.equal(expected.CONTAINER, F.authorizationContainer); assert.equal(expected.organizer, F.revenueContainer);
    assert.equal(expected.fundingWindow, '86400'); assert.equal(expected.REFUND_CLAIM_WINDOW, '86400');
    assert.equal(expected.MAX_TICKETS_PER_PURCHASE, '1000'); assert.equal(expected.MAX_TICKETS_PER_ADDRESS, '5000');
  }
  assert.throws(() => validateDeploymentArtifact(artifactFixture(), null));
});
test('stale artifacts, wrong pool, old recipient and old limits are rejected before producing a creation transaction', () => {
  const mutations = [a => delete a.fixedRules.partialFill, a => a.fixedRules.partialFill = false,
    a => a.fixedRules.maxTicketsPerPurchase = 500, a => a.fixedRules.maxTicketsPerAddress = 10000,
    a => a.fixedRules.fundingWindowSeconds = 259200, a => a.fixedRules.refundClaimWindowSeconds = 172800,
    a => a.fixedRules.ticketPriceBaseUnits = '10000', a => a.fixedRules.ticketsPerRound = 100,
    a => a.fixedBindings.revenueContainer = OLD_AUTH, a => a.testOnly = true,
    a => a.fixedBindings.authorizationContainer = OLD_AUTH, a => a.fixedBindings.authorizationNft = F.processor,
    a => a.fixedBindings.authorizationTokenId = 2075, a => a.contractVersion = 2, a => a.architecture = 'legacy'];
  for (const mutate of mutations) { const artifact = artifactFixture(); mutate(artifact); assert.throws(() => validateDeploymentArtifact(artifact, 'pool100')); }
  assert.throws(() => formalGuards.deploymentMode('test'));
  assert.throws(() => formalGuards.deploymentMode('production'));
});
test('all compiled artifacts match current page review rules', async () => {
  const hashes = new Set();
  for (const [mode, selected] of Object.entries(DEPLOY_MODES)) {
    const artifact = JSON.parse(await fs.readFile(new URL(`../outputs/bem-raffle-2075/production-v3/${selected.contractName}.artifact.json`, import.meta.url), 'utf8'));
    validateDeploymentArtifact(artifact, mode);
    hashes.add(keccak256(await deploymentData(artifact, mode)));
  }
  assert.equal(hashes.size, 3);
});
test('runtime verifies compiler immutable ranges while altered instructions and malformed masks fail', () => {
  const artifact = artifactFixture();
  const code = '0x6000' + '12'.repeat(32) + '6002';
  assert.equal(verifyDeploymentRuntime(code, artifact, 'pool100'), keccak256(code));
  assert.throws(() => verifyDeploymentRuntime('0x6001' + '12'.repeat(32) + '6002', artifact, 'pool100'));
  assert.throws(() => verifyDeploymentRuntime(code + '00', artifact, 'pool100'));
  for (const range of [{ start: -1, length: 32 }, { start: 2, length: 34 }, { start: 3, length: 32 }]) {
    const invalid = structuredClone(artifact); invalid.immutableReferences = { '1': [range] };
    assert.throws(() => validateDeploymentArtifact(invalid, 'pool100'));
  }
});
test('immutable readback rejects wrong organizer, pool, processor, VRF and activation state', () => {
  const expected = expectedReadback('pool10', 200);
  for (const [key, value] of [['organizer', OLD_AUTH], ['CONTAINER', OLD_AUTH], ['ROUND_POOL', '10000000000'],
    ['TICKET_PRICE', '1000000'], ['PARTIAL_FILL', false], ['CIRCUIT_ID', '13061'], ['subscriptionId', '123'], ['seriesAuthorized', true], ['sourceVerifiedAtBlock', '199']]) {
    assert.throws(() => assertDeploymentReadback({ ...expected, [key]: value }, 'pool10', 200));
  }
});
function bindingFixture() {
  return { chainId: 56, authorization: { account: F.authorizationContainer, opened: true, token: [56n, F.authorizationNft, 13061n] },
    revenue: { account: F.revenueContainer, opened: true, token: [56n, F.revenueNft, 13061n] }, authorizationOwner: F.authorizationOwner, authorizationNftOwner: F.authorizationOwner, decimals: 8n,
    netlistHash: F.circuitHash, circuitInfo: [12n, 9n, 0n, 71n], dependencyCodes: Array(7).fill('0x6000') };
}
test('registry and ERC6551-style token bindings must agree for both containers', () => {
  assertContainerBindings(bindingFixture());
  for (const mutate of [b => b.revenue.token[2] = 2075n, b => b.authorization.account = OLD_AUTH,
    b => b.revenue.opened = false, b => b.authorization.token[0] = 1n, b => b.chainId = 1,
    b => b.dependencyCodes[0] = '0x', b => b.decimals = 18n, b => b.circuitInfo[3] = 72n,
    b => b.authorizationOwner = ACCOUNT, b => b.authorizationNftOwner = OTHER, b => b.authorization.token[1] = F.processor]) {
    const binding = bindingFixture(); mutate(binding); assert.throws(() => assertContainerBindings(binding));
  }
});

test('deployer remains 304F while 13061 authorization belongs to 7674, with isolated V3 records', () => {
  assertDeployer(ACCOUNT);
  assert.notEqual(F.authorizationOwner, ACCOUNT);
  assert.throws(() => assertDeployer(F.authorizationOwner));
  assertContainerBindings(bindingFixture());
  assert.equal(expectedReadback('pool10', 100).AUTHORIZATION_TOKEN_ID, '13061');
  assert.equal(expectedReadback('pool10', 100).CIRCUIT_ID, '2075');
  assert.equal(expectedReadback('pool10', 100).AUTHORIZATION_NFT, F.authorizationNft);
  assert.equal(FORMAL_STORAGE_KEY, 'bem13061-formal-deployment-records-v3');
  assert.equal(FORMAL_LOCK_KEY, 'bem13061-formal-deployment-v3');
});

test('reset requires fresh affirmative proof and exact record identity', () => {
  const record = { mode: 'pool10', status: 'resolved_failed', hash: HASH, account: ACCOUNT, nonce: '4' };
  assertResolvedReset({ ...record }, record, 'pool10');
  for (const result of [null, undefined, { ...record, hash: CANCEL_HASH }, { ...record, mode: 'pool50' },
    { ...record, account: OTHER }, { ...record, nonce: '5' }, { ...record, status: 'unknown' }]) {
    assert.throws(() => assertResolvedReset(result, record, 'pool10'));
  }
});

test('wallet numeric quantities normalize without accepting unsafe, fractional or missing values', () => {
  assert.equal(formalGuards.rpcQuantity(120443889), '0x72dd3f1');
  assert.equal(formalGuards.rpcQuantity('100'), '0x64');
  assert.equal(formalGuards.rpcBlockTag('latest'), 'latest');
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.1, -1, null, undefined, true, NaN, '1e6', '']) {
    assert.throws(() => formalGuards.rpcQuantity(value));
  }
  const value = formalGuards.normalizeReadResult('eth_getTransactionReceipt', { status: 0, blockNumber: 100 });
  assert.deepEqual(value, { status: '0x0', blockNumber: '0x64' });
});

const pageSource = await fs.readFile(new URL('../bem-production-site/web/deploy-formal.js', import.meta.url), 'utf8');
const pageHtml = await fs.readFile(new URL('../bem-production-site/web/deploy-formal.html', import.meta.url), 'utf8');
const netlist = JSON.parse(await fs.readFile(new URL('../outputs/bem-raffle-2075/circuit-2075.json', import.meta.url), 'utf8')).netlist;
class Element {
  constructor(id = '') { this.id = id; this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; this.checked = false; this.children = []; this.listeners = new Map(); this.classList = { add() {}, remove() {}, toggle() {} }; }
  addEventListener(name, fn) { const rows = this.listeners.get(name) ?? []; rows.push(fn); this.listeners.set(name, rows); }
  setAttribute(name, value) { this[name] = value; }
  replaceChildren(...nodes) { this.children = nodes; }
  append(...nodes) { this.children.push(...nodes); }
  async click() { if (!this.disabled) for (const fn of this.listeners.get('click') ?? []) await fn({ target: this }); }
  async fire(name) { for (const fn of this.listeners.get(name) ?? []) await fn({ target: this }); }
  querySelectorAll() { return []; }
}
async function pageHarness(options = {}) {
  const elements = new Map([...pageHtml.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element(match[1])]));
  const calls = [], saved = options.saved ?? new Map(), listeners = new Map();
  let api, walletAccount = options.account ?? ACCOUNT, owner = F.authorizationOwner, requestOverride = null, locked = false;
  const wallet = {
    on(event, fn) { const rows = listeners.get(event) ?? new Set(); rows.add(fn); listeners.set(event, rows); },
    removeListener(event, fn) { listeners.get(event)?.delete(fn); },
    emit(event) { for (const fn of listeners.get(event) ?? []) fn(); },
    async request({ method, params = [] }) {
      calls.push({ method, params });
      if (requestOverride) { const result = await requestOverride(method, params); if (result?.handled) return result.value; }
      if (method === 'eth_requestAccounts') { if (options.initialAccountEvent) wallet.emit('accountsChanged'); return [walletAccount]; }
      if (method === 'eth_accounts') return [walletAccount];
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_blockNumber') return '0x6f';
      if (method === 'eth_getBlockByNumber') return { number: params[0] === 'latest' ? '0x6f' : params[0], hash: BLOCK_HASH, transactions: [HASH] };
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_estimateGas') return '0x5b8d80';
      if (method === 'eth_gasPrice') return '0x2faf080';
      if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
      if (method === 'eth_getTransactionCount') return '0x4';
      if (method === 'eth_call') {
        const tx = api.rpcInterface.parseTransaction({ data: params[0].data });
        const name = tx.name;
        let values;
        if (name === 'accountOf' || name === 'isOpened') {
          assert.equal(tx.args[0], F.authorizationNft); assert.equal(tx.args[1], 13061n);
          values = [name === 'accountOf' ? F.authorizationContainer : true];
        } else if (name === 'token') values = [56n, F.authorizationNft, 13061n];
        else if (name === 'owner' || name === 'ownerOf') values = [owner];
        else if (name === 'decimals') values = [8];
        else if (name === 'netlist') values = [netlist];
        else if (name === 'circuitInfo') values = [12, 9, 0, 71];
        else if (name === 'getSubscription') values = [0n, 10000000000000000n, 0n, ACCOUNT, []];
        else throw Error('Unexpected simulated read: ' + name);
        return api.rpcInterface.encodeFunctionResult(name, values);
      }
      if (method === 'eth_sendTransaction') return HASH;
      throw Error('Unexpected wallet method: ' + method);
    },
  };
  const localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const document = { getElementById(id) { assert.ok(elements.has(id), 'Actual HTML lacks ' + id); return elements.get(id); },
    createElement: () => new Element(), activeElement: null };
  const context = vm.createContext({ ...ethers, ...formalGuards, F, document, localStorage, console,
    window: { addEventListener() {} }, navigator: { clipboard: { async writeText() {} }, locks: { async request(_key, _options, callback) {
      assert.equal(_key, FORMAL_LOCK_KEY); if (locked) return callback(null); locked = true; try { return await callback({}); } finally { locked = false; }
    } } }, location: { href: 'https://example.invalid/deploy-formal.html' }, Blob, URL,
    setTimeout, clearTimeout, setInterval: () => 0,
    createWalletPicker: () => ({ open() {} }),
    pool10Artifact: artifactFixture('pool10'), pool50Artifact: artifactFixture('pool50'), pool100Artifact: artifactFixture('pool100'),
  });
  const source = pageSource.replace(/^import[\s\S]*?;\s*/gm, '');
  vm.runInContext(source + '\nglobalThis.__formal = { state, connect, estimate, deploy, verifyReceipt, exclusive, saveRecord, rpcInterface };', context);
  api = context.__formal;
  for (let index = 0; index < 10 && !api.state.ready && !api.state.storageError; index++) await new Promise(resolve => setImmediate(resolve));
  return { api, elements, calls, saved, wallet, setOwner: value => { owner = value; },
    override: fn => { requestOverride = fn; }, connect: () => api.connect({ provider: wallet }),
    async choose(mode) { await elements.get('mode-' + mode).click(); },
    async review(mode = 'pool10') { await this.choose(mode); await this.connect(); await elements.get('estimate').click();
      assert.ok(api.state.estimate, elements.get('notice').textContent); elements.get('confirm-review').checked = true; await elements.get('confirm-review').fire('change'); },
  };
}
const sends = page => page.calls.filter(call => call.method === 'eth_sendTransaction');

test('actual formal HTML has only three modes and connecting/estimating sends no transaction', async () => {
  assert.ok(!pageHtml.includes('id="mode-test"')); assert.ok(!pageSource.includes('production-v2/'));
  const p = await pageHarness({ initialAccountEvent: true });
  assert.equal(p.api.state.ready, true); await p.review();
  assert.equal(sends(p).length, 0); assert.equal(p.api.state.account, ACCOUNT);
  const wrong = await pageHarness({ account: F.authorizationOwner }); await wrong.choose('pool10'); await wrong.connect();
  assert.equal(wrong.elements.get('estimate').disabled, true); assert.equal(sends(wrong).length, 0);
});

test('changing modes invalidates an actual fee review and rechecking changed 13061 owner prevents signing', async () => {
  const p = await pageHarness(); await p.review('pool10'); await p.choose('pool50');
  assert.equal(p.api.state.estimate, null); assert.equal(p.elements.get('deploy').disabled, true);
  await p.review('pool10'); p.setOwner(ACCOUNT); await p.elements.get('deploy').click();
  assert.equal(sends(p).length, 0); assert.equal(p.api.state.records.pool10, undefined);
  assert.match(p.elements.get('notice').textContent, /持有人/);
});

test('pending signature is reserved first, preserves original wallet hash through events and cannot duplicate', async () => {
  const p = await pageHarness(); await p.review();
  let resolveSend;
  p.override(async method => method === 'eth_sendTransaction' ? { handled: true, value: await new Promise(resolve => { resolveSend = resolve; }) } : null);
  const pending = p.elements.get('deploy').click();
  for (let index = 0; index < 30 && !resolveSend; index++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(resolveSend); assert.equal(JSON.parse(p.saved.get(FORMAL_STORAGE_KEY)).pool10.status, 'awaiting_wallet');
  await p.elements.get('deploy').click(); assert.equal(sends(p).length, 1);
  p.wallet.emit('accountsChanged'); resolveSend(HASH); await pending;
  const record = JSON.parse(p.saved.get(FORMAL_STORAGE_KEY)).pool10;
  assert.equal(record.account, ACCOUNT); assert.equal(record.hash, HASH); assert.equal(record.status, 'submitted');
  assert.equal(record.schemaVersion, 3); assert.equal(record.architecture, FORMAL_VERSION);
  assert.equal(p.api.state.account, null); await p.connect(); await p.api.deploy(); assert.equal(sends(p).length, 1);
});

test('unknown wallet outcome stays locked after reload while explicit wallet rejection is retryable', async () => {
  const p = await pageHarness(); await p.review();
  p.override(async method => { if (method === 'eth_sendTransaction') throw Error('wallet response lost'); });
  await p.elements.get('deploy').click(); assert.equal(p.api.state.records.pool10.status, 'unknown');
  const restored = await pageHarness({ saved: p.saved }); await restored.choose('pool10'); await restored.connect();
  assert.equal(restored.elements.get('estimate').disabled, true); assert.equal(sends(restored).length, 0);
  const rejected = await pageHarness(); await rejected.review();
  rejected.override(async method => { if (method === 'eth_sendTransaction') throw Object.assign(Error('cancelled'), { code: 4001 }); });
  await rejected.elements.get('deploy').click(); assert.equal(rejected.api.state.records.pool10, undefined);
});

test('cross-tab record change blocks signing and fresh failed-receipt read error cannot clear a prior resolved lock', async () => {
  const p = await pageHarness(); await p.review();
  const row = { schemaVersion: 3, architecture: FORMAL_VERSION, mode: 'pool10', account: ACCOUNT, chainId: 56, nonce: '4',
    createdAt: new Date().toISOString(), dataHash: keccak256(p.api.state.data.pool10), hash: HASH, status: 'resolved_failed' };
  p.saved.set(FORMAL_STORAGE_KEY, JSON.stringify({ pool10: row })); await p.elements.get('deploy').click();
  assert.equal(sends(p).length, 0);
  p.api.saveRecord('pool10', row); p.elements.get('reset-resolved').hidden = false;
  p.override(async method => { if (method === 'eth_getTransactionReceipt') throw Error('receipt RPC unavailable'); });
  await p.elements.get('reset-resolved').click();
  assert.equal(JSON.parse(p.saved.get(FORMAL_STORAGE_KEY)).pool10.hash, HASH);
  assert.equal(sends(p).length, 0); assert.match(p.elements.get('notice').textContent, /部署锁已保留/);
});

test('actual receipt recovery accepts safe numeric blocks, sends hex tags, and only then permits reset', async () => {
  const p = await pageHarness(); await p.choose('pool10'); await p.connect();
  const address = getCreateAddress({ from: ACCOUNT, nonce: 4 });
  p.override(async (method, params) => {
    if (method === 'eth_blockNumber') return { handled: true, value: 111 };
    if (method === 'eth_getTransactionByHash') return { handled: true, value: {
      hash: HASH, from: ACCOUNT, to: null, nonce: 4, chainId: 56, value: 0,
      input: p.api.state.data.pool10, blockNumber: 100, blockHash: BLOCK_HASH,
    } };
    if (method === 'eth_getTransactionReceipt') return { handled: true, value: {
      transactionHash: HASH, from: ACCOUNT, to: null, status: 0, contractAddress: address,
      blockNumber: 100, blockHash: BLOCK_HASH, logs: [],
    } };
    if (method === 'eth_getBlockByNumber') {
      assert.equal(params[0], '0x64');
      return { handled: true, value: { number: 100, hash: BLOCK_HASH, transactions: [HASH] } };
    }
    if (method === 'eth_getCode' && params[0] === address) {
      assert.equal(params[1], '0x64'); return { handled: true, value: '0x' };
    }
    return null;
  });
  p.elements.get('recovery-hash').value = HASH;
  await p.elements.get('verify-receipt').click();
  assert.equal(p.api.state.records.pool10.status, 'resolved_failed', p.elements.get('notice').textContent);
  await p.elements.get('reset-resolved').click();
  assert.equal(p.api.state.records.pool10, undefined); assert.equal(sends(p).length, 0);
});

test('unsafe numeric snapshot is refused before fee review or a signature request', async () => {
  const p = await pageHarness(); await p.choose('pool10'); await p.connect();
  p.override(async method => method === 'eth_getBlockByNumber'
    ? { handled: true, value: { number: Number.MAX_SAFE_INTEGER + 1, hash: BLOCK_HASH } } : null);
  await p.elements.get('estimate').click();
  assert.equal(p.api.state.estimate, null); assert.equal(p.elements.get('deploy').disabled, true);
  assert.equal(sends(p).length, 0);
});
test('selection and wallet changes invalidate the reviewed intent instead of reusing old fee checks', () => {
  const now = 5000, current = { mode: 'pool100', account: ACCOUNT, epoch: 5, chainId: 56, wallet: {} };
  const intent = { ...current, estimate: { ...current, createdAt: 4000, expiresAt: 94000 } };
  assertDeploymentIntent(intent, current, now);
  for (const update of [{ mode: 'pool10' }, { mode: 'test' }, { account: OTHER }, { epoch: 6 }, { chainId: 1 }]) {
    assert.throws(() => assertDeploymentIntent(intent, { ...current, ...update }, now));
  }
  assert.throws(() => assertDeploymentIntent(intent, current, 94000));
  assert.throws(() => assertDeploymentIntent({ ...intent, estimate: { createdAt: 6000, expiresAt: 96000 } }, current, now));
});
function evidence() {
  const data = '0x60016000', nonce = '4', address = getCreateAddress({ from: ACCOUNT, nonce });
  return { account: ACCOUNT, data, nonce, latestBlock: '0x6f',
    transaction: { hash: HASH, from: ACCOUNT, to: null, nonce: '0x4', chainId: '0x38', input: data, value: '0x0', blockNumber: '0x64', blockHash: BLOCK_HASH },
    receipt: { transactionHash: HASH, from: ACCOUNT, to: null, status: '0x1', contractAddress: address, blockNumber: '0x64', blockHash: BLOCK_HASH, logs: [] },
    block: { number: '0x64', hash: BLOCK_HASH, transactions: [HASH] } };
}
test('creation receipt needs matching sender/data/nonce/address, canonical inclusion and 12 confirmations', () => {
  const valid = evidence(); assert.equal(assertDeploymentTransaction(valid), valid.receipt.contractAddress);
  assertCreationTransaction(valid.transaction, ACCOUNT, valid.data);
  for (const mutate of [e => e.transaction.from = OTHER, e => e.transaction.value = '0x1', e => e.transaction.chainId = '0x1',
    e => e.transaction.input = '0x6002', e => e.nonce = '5', e => e.receipt.contractAddress = OTHER,
    e => e.block.hash = CANCEL_HASH, e => e.block.transactions = [], e => e.latestBlock = '0x6e', e => e.receipt.status = '0x0']) {
    const invalid = evidence(); mutate(invalid); assert.throws(() => assertDeploymentTransaction(invalid));
  }
});
test('only independently confirmed failed creation or a verified same-nonce EOA cancellation permits explicit reset', () => {
  const failed = evidence(); failed.receipt.status = '0x0'; failed.receipt.contractAddress = null; failed.deployedCode = '0x';
  assert.equal(assertUnsuccessfulDeployment(failed), 'resolved_failed');
  const failedWithPredicted = evidence(); failedWithPredicted.receipt.status = '0x0'; failedWithPredicted.deployedCode = '0x';
  assert.equal(assertUnsuccessfulDeployment(failedWithPredicted), 'resolved_failed');
  assert.throws(() => assertUnsuccessfulDeployment({ ...failedWithPredicted, deployedCode: '0x6000' }));
  assert.throws(() => assertUnsuccessfulDeployment({ ...failedWithPredicted, receipt: { ...failedWithPredicted.receipt, contractAddress: OTHER } }));
  const cancel = evidence(); cancel.originalTransaction = { ...cancel.transaction };
  cancel.transaction = { ...cancel.transaction, hash: CANCEL_HASH, to: ACCOUNT, input: '0x' };
  cancel.receipt = { ...cancel.receipt, transactionHash: CANCEL_HASH, to: ACCOUNT, contractAddress: null };
  cancel.block.transactions = [CANCEL_HASH]; cancel.senderCode = '0x';
  assert.equal(assertUnsuccessfulDeployment(cancel), 'resolved_cancelled');
  for (const mutate of [e => e.originalTransaction = null, e => e.senderCode = '0xef0100' + '12'.repeat(20),
    e => e.originalTransaction.nonce = '0x3', e => e.originalTransaction.input = '0x1234',
    e => e.receipt.logs = [{ address: ACCOUNT }], e => e.latestBlock = '0x6e', e => e.block.hash = HASH]) {
    const invalid = structuredClone(cancel); mutate(invalid); assert.throws(() => assertUnsuccessfulDeployment(invalid));
  }
  assert.throws(() => assertUnsuccessfulDeployment(evidence()));
});
