import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Interface } from 'ethers';
import { createAdminAuth, createAdminCredential } from '../bem-production-site/auth.mjs';
import { createProductionServer } from '../bem-production-site/server.mjs';
import { GAME, BEM, CONTAINER, PROCESSOR, COORDINATOR, OPENER, CODE_HASH, ROOT, loadManifest } from '../bem-production-site/config.mjs';
import { createReadRpc, validateReadRequest } from '../bem-production-site/rpc.mjs';

// No real HTTP request, wallet, key, chain transaction or server lifecycle is used.
const WALLET = '0x1111111111111111111111111111111111111111';
const HASH = '0x' + 'ab'.repeat(32);
const block = number => '0x' + number.toString(16);
const request = (method, params = []) => ({ jsonrpc: '2.0', id: 7, method, params });
function mockedRpc(result = '0x38') {
  const calls = [];
  const rpc = createReadRpc({ endpoint: 'https://example.invalid/rpc', fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body); calls.push({ url: String(url), payload });
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: payload.id, result }) };
  } });
  return { rpc, calls };
}
async function rejectedBeforeForward(method, params, code = -32602) {
  const { rpc, calls } = mockedRpc();
  await assert.rejects(rpc(method, params), error => { assert.equal(error.code, code); return true; });
  assert.equal(calls.length, 0, 'rejected input must not reach fetch');
}

test('every signing, transaction submission, node administration and unknown method is rejected before fetch', async () => {
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_signTransaction', 'eth_sign', 'personal_sign',
    'eth_signTypedData_v4', 'personal_unlockAccount', 'eth_accounts', 'eth_requestAccounts', 'wallet_sendCalls',
    'wallet_switchEthereumChain', 'evm_mine', 'evm_setAccountCode', 'debug_traceCall', 'admin_peers', 'not_a_method']) {
    await rejectedBeforeForward(method, ['0xdead'], -32601);
  }
});

test('read methods normalize a single request and valid wallet-origin simulations stay read-only', async () => {
  const { rpc, calls } = mockedRpc();
  assert.equal(await rpc('eth_chainId', []), '0x38');
  for (const to of [GAME, BEM, CONTAINER, PROCESSOR, COORDINATOR, OPENER]) {
    await rpc('eth_call', [{ to, from: WALLET, data: '0x', value: '0x0', chainId: '0x38' }, 'latest']);
  }
  await rpc('eth_estimateGas', [{ to: GAME, from: WALLET, input: '0x12345678', gas: '0x1000000' }]);
  assert.equal(calls.length, 8);
  for (const call of calls) assert.equal(call.payload.jsonrpc, '2.0');
  assert.equal(new Set(calls.map(call => call.payload.id)).size, calls.length);
});

test('unknown call targets, contract creation and transaction state overrides are never forwarded', async () => {
  for (const method of ['eth_call', 'eth_estimateGas']) {
    for (const tx of [{ to: WALLET }, {}, { to: null }, { to: GAME, accessList: [] },
      { to: GAME, stateOverride: {} }, { to: GAME, authorizationList: [] }, { to: GAME, unknown: 'x' }]) {
      await rejectedBeforeForward(method, [tx]);
    }
    await rejectedBeforeForward(method, [{ to: GAME }, 'latest', {}]);
    await rejectedBeforeForward(method, [{ to: GAME }, 'not-a-block']);
  }
});

test('nonzero BNB value, wrong chain, over-cap gas and malformed call bytes are never forwarded', async () => {
  for (const tx of [{ value: '0x1' }, { value: '0xffff' }, { chainId: '0x61' },
    { gas: '0x1000001' }, { gasLimit: '0x1000001' }, { data: '0x1' }, { input: 'hello' },
    { data: '0x' + 'ab'.repeat(65537) }, { gasPrice: '1' }, { nonce: '-1' }]) {
    await rejectedBeforeForward('eth_call', [{ to: GAME, ...tx }, 'latest']);
  }
});

test('transaction address fields require literal addresses, including every explicitly supplied sender', async () => {
  for (const tx of [{ to: [GAME] }, { to: GAME, from: [WALLET] }, { to: GAME, from: '' },
    { to: GAME, from: null }, { to: GAME, from: 0 }, { to: GAME, from: {} }]) {
    await rejectedBeforeForward('eth_call', [tx, 'latest']);
  }
});

test('literal block and address types prevent arrays and null parameters from bypassing validation', async () => {
  for (const method of ['eth_getCode', 'eth_getBalance', 'eth_getTransactionCount']) {
    await rejectedBeforeForward(method, [[WALLET], 'latest']);
    await rejectedBeforeForward(method, [WALLET, ['0x1']]);
    await rejectedBeforeForward(method, [WALLET, { blockHash: HASH }]);
    await rejectedBeforeForward(method, [WALLET, null]);
  }
  await rejectedBeforeForward('eth_call', [{ to: GAME }, ['0x1']]);
  await rejectedBeforeForward('eth_chainId', null);
});

test('request envelopes, batch containers and excessive parameter arrays are rejected', async () => {
  for (const envelope of [null, [], [request('eth_chainId')], { ...request('eth_chainId'), jsonrpc: '1.0' },
    { ...request('eth_chainId'), id: null }, { ...request('eth_chainId'), id: {} },
    { ...request('eth_chainId'), id: Number.POSITIVE_INFINITY }, { ...request('eth_chainId'), id: Number.NaN },
    { ...request('eth_chainId'), id: 'x'.repeat(101) }, { ...request('eth_chainId'), params: {} }]) {
    assert.throws(() => validateReadRequest(envelope), error => error.code === -32602);
  }
  await rejectedBeforeForward('eth_chainId', ['0x1']);
  await rejectedBeforeForward('eth_call', [{ to: GAME }, 'latest', {}, {}, {}]);
  await rejectedBeforeForward(['eth_chainId', 'eth_sendRawTransaction'], [], -32601);
});

test('logs are restricted to the game and a bounded numeric block interval or one exact block hash', async () => {
  const { rpc, calls } = mockedRpc([]);
  await rpc('eth_getLogs', [{ address: GAME, fromBlock: block(100), toBlock: block(1099), topics: [HASH, null, [HASH]] }]);
  await rpc('eth_getLogs', [{ address: GAME, blockHash: HASH }]);
  assert.equal(calls.length, 2);
  for (const filter of [{ address: BEM, fromBlock: '0x1', toBlock: '0x2' },
    { address: GAME, fromBlock: 'latest', toBlock: 'latest' },
    { address: GAME, fromBlock: block(100), toBlock: block(1100) },
    { address: GAME, fromBlock: '0x2', toBlock: '0x1' },
    { address: GAME, blockHash: HASH, fromBlock: '0x0' },
    { address: GAME, blockHash: '0x12' },
    { address: GAME, blockHash: HASH, topics: [HASH, HASH, HASH, HASH, HASH] },
    { address: GAME, blockHash: HASH, topics: [Array.from({ length: 33 }, () => HASH)] },
    { address: GAME, blockHash: HASH, topics: ['not-a-topic'] },
    { address: GAME, blockHash: HASH, includeRemoved: true }]) {
    await rejectedBeforeForward('eth_getLogs', [filter]);
  }
});

test('log addresses and hashes cannot use arrays as coercible string substitutes', async () => {
  await rejectedBeforeForward('eth_getLogs', [{ address: [GAME], blockHash: HASH }]);
  await rejectedBeforeForward('eth_getLogs', [{ address: GAME, blockHash: [HASH] }]);
  await rejectedBeforeForward('eth_getTransactionReceipt', [[HASH]]);
});

test('header, transaction hash and fee-history queries reject malformed or excessive arguments', async () => {
  await rejectedBeforeForward('eth_getBlockByNumber', ['latest', true]);
  await rejectedBeforeForward('eth_getBlockByNumber', ['tomorrow', false]);
  await rejectedBeforeForward('eth_getTransactionByHash', ['0x12']);
  await rejectedBeforeForward('eth_getTransactionReceipt', [HASH, HASH]);
  for (const params of [['0x65', 'latest', []], ['0x5', 'latest', [101]], ['0x5', 'latest', [-1]],
    ['0x5', 'latest', Array(21).fill(1)], ['0x5', 'bad', []], ['0x5', 'latest', ['1']]]) {
    await rejectedBeforeForward('eth_feeHistory', params);
  }
});

test('proxy refuses insecure endpoints and hides upstream errors rather than leaking credentials', async () => {
  for (const endpoint of ['http://example.invalid', 'https://name:secret@example.invalid', 'file:///etc/passwd']) {
    assert.throws(() => createReadRpc({ endpoint }));
  }
  const secret = 'private-upstream-secret';
  const rpc = createReadRpc({ endpoint: 'https://example.invalid', fetchImpl: async () => ({ ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: secret, data: secret } }) }) });
  await assert.rejects(rpc('eth_chainId', []), error => { assert.equal(error.code, -32000); assert.ok(!error.message.includes(secret)); return true; });
});

test('upstream response identity must match the exact read request', async () => {
  for (const data of [{ jsonrpc: '2.0', id: 999, result: '0x38' }, { id: 1, result: '0x38' },
    { jsonrpc: '1.0', id: 1, result: '0x38' }]) {
    const rpc = createReadRpc({ endpoint: 'https://example.invalid', fetchImpl: async () => ({ ok: true, json: async () => data }) });
    await assert.rejects(rpc('eth_chainId', []));
  }
});

test('concurrent reads reserve at most six upstream slots and reject overflow without forwarding', async () => {
  let active = 0, maximum = 0, forwarded = 0;
  const gates = [];
  const rpc = createReadRpc({ endpoint: 'https://example.invalid', fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body); active++; forwarded++; maximum = Math.max(maximum, active);
    await new Promise(resolve => gates.push(resolve)); active--;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: payload.id, result: '0x38' }) };
  } });
  const results = Array.from({ length: 107 }, () => rpc('eth_chainId', []).then(value => ({ value }), error => ({ code: error.code })));
  assert.equal(forwarded, 6);
  for (let turn = 0; turn < 30 && forwarded < 106; turn++) {
    gates.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  gates.splice(0).forEach(resolve => resolve());
  const all = await Promise.all(results);
  assert.equal(maximum, 6); assert.equal(forwarded, 106);
  assert.equal(all.filter(result => result.value === '0x38').length, 106);
  assert.deepEqual(all.filter(result => result.code), [{ code: -32005 }]);
});

const records = Object.fromEntries(await Promise.all(['release-plan.json', 'deployment-verified.json', 'Bem2075RaffleBSC.artifact.json'].map(async name =>
  [name, JSON.parse(await fs.readFile(path.join(ROOT, 'outputs/bem-raffle-2075/production', name), 'utf8'))])));
async function withManifest(mutate, body) {
  const copy = structuredClone(records), original = fs.readFile; mutate(copy);
  fs.readFile = async (file, ...args) => Object.hasOwn(copy, path.basename(String(file))) ? JSON.stringify(copy[path.basename(String(file))]) : original(file, ...args);
  try { await body(); } finally { fs.readFile = original; }
}

test('published manifest fixes mainnet address/runtime and keeps sales disabled', async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.chainId, 56); assert.equal(manifest.mode, 'production');
  assert.equal(manifest.gameAddress, GAME); assert.equal(manifest.runtimeCodeHash, CODE_HASH);
  assert.equal(manifest.containerAddress, CONTAINER); assert.equal(manifest.salesEnabled, false);
  assert.equal(manifest.maxTicketsPerPurchase, 500); assert.equal(manifest.rpcUrl, '/rpc');
});

test('the production event set used by history indexing fits the bounded log filter', async () => {
  const manifest = await loadManifest(), iface = new Interface(manifest.gameAbi);
  const topics = iface.fragments.filter(fragment => fragment.type === 'event').map(fragment => iface.getEvent(fragment.name).topicHash);
  assert.equal(topics.length, 17);
  const { rpc, calls } = mockedRpc([]);
  await rpc('eth_getLogs', [{ address: GAME, fromBlock: block(manifest.deploymentBlock), toBlock: block(manifest.deploymentBlock), topics: [topics] }]);
  assert.equal(calls.length, 1);
});

test('manifest rejects wrong network, deployment address, runtime hash, subscription or source bytes', async () => {
  for (const mutate of [r => { r['release-plan.json'].chainId = 97; },
    r => { r['deployment-verified.json'].address = WALLET; },
    r => { r['release-plan.json'].deployment.runtimeCodeHash = HASH; },
    r => { r['deployment-verified.json'].runtimeCodeHash = HASH; },
    r => { r['release-plan.json'].vrf.subscriptionId = '1'; },
    r => { const a = r['Bem2075RaffleBSC.artifact.json']; a.sourceSha256s[Object.keys(a.sourceSha256s)[0]] = '0'.repeat(64); }]) {
    await withManifest(mutate, async () => assert.rejects(loadManifest()));
  }
});

test('manifest cannot skip source binding with an empty artifact source set', async () => {
  await withManifest(r => { r['Bem2075RaffleBSC.artifact.json'].sourceSha256s = {}; }, async () => assert.rejects(loadManifest()));
});

// Synthetic test account created only in memory. Never read environment variables
// or a credential file, and never connect to the running site's admin service.
const ADMIN = { username: 'synthetic-admin', password: 'test-only-not-a-real-credential' };
const credential = await createAdminCredential(ADMIN.username, ADMIN.password);
const ORIGIN = 'http://127.0.0.1:8788';
function authFixture() {
  const state = { now: 0 };
  const auth = createAdminAuth({ credential, now: () => state.now });
  const login = (overrides = {}) => auth.login({ ...ADMIN, ip: '203.0.113.10', ...overrides });
  return { state, auth, login };
}

test('password authentication requires the configured hash profile and does not retain plaintext credentials', () => {
  assert.equal(credential.password, undefined); assert.equal(credential.algorithm, 'scrypt');
  assert.match(credential.salt, /^[a-f0-9]{32}$/); assert.match(credential.hash, /^[a-f0-9]{128}$/);
  for (const mutation of [{ N: 2 }, { r: 1 }, { p: 1 }, { algorithm: 'plaintext' }, { hash: 'invalid' }, { salt: '' }, { username: '../admin' }]) {
    assert.throws(() => createAdminAuth({ credential: { ...credential, ...mutation } }));
  }
  assert.throws(() => createAdminAuth({}));
});

test('wrong account, wrong password and malformed login requests receive the same 401 response', async () => {
  const f = authFixture();
  const messages = [];
  for (const overrides of [{ username: 'other-admin' }, { password: 'wrong-test-password' }, { username: null }, { password: null }]) {
    await assert.rejects(f.login(overrides), error => { assert.equal(error.authStatus, 401); messages.push(error.message); return true; });
  }
  assert.equal(new Set(messages).size, 1);
  const login = await f.login(); assert.equal(login.username, ADMIN.username);
  assert.match(login.token, /^[a-f0-9]{64}$/); assert.equal(login.password, undefined);
});

test('password sessions expire at 15 minutes, logout invalidates them, and a restart cannot restore memory-only sessions', async () => {
  const f = authFixture();
  const login = await f.login(), cookie = `bem2075_admin=${login.token}`;
  assert.equal((await f.auth.session(cookie)).username, ADMIN.username);
  assert.equal(await authFixture().auth.session(cookie), null);
  f.state.now = login.expiresAt - 1; assert.ok(await f.auth.session(cookie));
  f.state.now = login.expiresAt; assert.equal(await f.auth.session(cookie), null);
  const last = await f.login(); f.auth.logout(`bem2075_admin=${last.token}`);
  assert.equal(await f.auth.session(`bem2075_admin=${last.token}`), null);
});

test('five failed attempts lock only that IP until the 15-minute window ends, including otherwise valid credentials', async () => {
  const f = authFixture();
  for (let i = 0; i < 5; i++) await assert.rejects(f.login({ password: 'wrong-test-password' }), error => error.authStatus === 401);
  await assert.rejects(f.login(), error => error.authStatus === 429);
  assert.equal((await f.login({ ip: '203.0.113.11' })).username, ADMIN.username);
  f.state.now = 900000; assert.equal((await f.login()).username, ADMIN.username);
});

test('global login attempts and concurrent scrypt work are bounded', async () => {
  const f = authFixture();
  for (let i = 0; i < 100; i++) await assert.rejects(f.login({ ip: `test-ip-${i}`, username: null }), error => error.authStatus === 401);
  await assert.rejects(f.login({ ip: 'fresh-ip' }), error => error.authStatus === 429);
  f.state.now = 900000;
  const outcomes = await Promise.allSettled([f.login({ ip: 'one' }), f.login({ ip: 'two' }), f.login({ ip: 'three' })]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 2);
  assert.equal(outcomes.find(item => item.status === 'rejected').reason.authStatus, 429);
});

async function httpFixture({ publicOrigin } = {}) {
  const forwarded = [], manifest = await loadManifest();
  const gameAbi = new Interface(manifest.gameAbi);
  const subAbi = new Interface(['function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)']);
  const rpc = async (method, params) => {
    forwarded.push({ method, params });
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') return { number: block(120311700), hash: HASH, timestamp: '0x6a9d6b85' };
    if (method === 'eth_getCode') return '0x60006000'; // Deliberately not the verified production runtime.
    if (method === 'eth_getBalance') return '0x0';
    if (method === 'eth_call' && params[0].to === COORDINATOR) return subAbi.encodeFunctionResult('getSubscription', [0, 1, 0, WALLET, [GAME]]);
    if (method === 'eth_call' && params[0].to === GAME) {
      const name = gameAbi.parseTransaction({ data: params[0].data }).name;
      const results = { seriesAuthorized: [false], currentRoundId: [1], nextRoundOpensAt: [0] };
      if (Object.hasOwn(results, name)) return gameAbi.encodeFunctionResult(name, results[name]);
    }
    throw new Error('Upstream secret must not appear in responses');
  };
  const empty = ({page=1,pageSize=20}={}) => ({rows:[],page,pageSize,total:0,totalPages:0});
  const history = { getStatus: () => ({ state: 'ready' }), listRounds: empty, listBurns: empty, listAnnouncements: empty };
  const market = { getQuote: async () => ({chainId:56,token:BEM,updatedAt:null,stale:true,usdt:null,bnb:null}) };
  const { server } = await createProductionServer({ port: 8788, rpc, manifest, history, publicOrigin, adminCredential: credential, market });
  // Dispatch directly through the HTTP request listener: no listen(), port,
  // socket connection or network request is created by these tests.
  const send = ({ url = '/rpc', method = 'POST', body = request('eth_chainId'), host = new URL(publicOrigin ?? ORIGIN).host,
    origin = publicOrigin ?? ORIGIN, cookie, extraHeaders = {}, peer = '127.0.0.1' } = {}) => new Promise(resolve => {
    const headers = { host, 'content-type': 'application/json', ...extraHeaders };
    if (origin !== null) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    const req = { url, method, headers, socket: { remoteAddress: peer },
      async *[Symbol.asyncIterator]() { if (body !== null) yield Buffer.from(JSON.stringify(body)); } };
    const result = { status: null, headers: {} };
    const res = { setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
      writeHead(status, extra) { result.status = status; for (const [name, value] of Object.entries(extra)) result.headers[name.toLowerCase()] = value; },
      end(data) { result.text = data?.toString() ?? ''; try { result.body = JSON.parse(result.text); } catch {} resolve(result); } };
    server.emit('request', req, res);
  });
  return { server, send, forwarded };
}

test('new pool, burn, announcement and price endpoints remain read-only and distinguish undeployed pools', async()=>{
  const f=await httpFixture();
  const pools=await f.send({url:'/api/pools',method:'GET'});assert.equal(pools.status,200);assert.equal(pools.body.schemaVersion,2);
  assert.ok(pools.body.pools.every(p=>p.deployment?.verified===true&&p.salesEnabled===false));
  for(const endpoint of ['/api/burns','/api/announcements']){
    const current=await f.send({url:endpoint+'?pool=100',method:'GET'});assert.equal(current.status,200);assert.equal(current.body.deploymentPending,false);assert.equal(current.body.index.state,'syncing');assert.deepEqual(current.body.rows,[]);
    const original=await f.send({url:endpoint+'?pool=legacy100',method:'GET'});assert.equal(original.body.deploymentPending,false);assert.equal(original.body.index.state,'ready');
    for(const query of ['?pool=untrusted','?page=-1','?pageSize=100000'])assert.equal((await f.send({url:endpoint+query,method:'GET'})).status,400);
  }
  const price=await f.send({url:'/api/market',method:'GET'});assert.equal(price.status,200);assert.equal(price.body.stale,true);assert.equal(price.body.usdt,null);
  assert.ok(f.forwarded.length > 0);
  assert.ok(f.forwarded.every(call=>['eth_getBlockByNumber','eth_chainId','eth_getCode','eth_call','eth_getBalance'].includes(call.method)));
});

test('HTTP envelope blocks foreign hosts/origins and refuses write methods inside a mixed batch', async () => {
  const f = await httpFixture();
  assert.equal((await f.send({ host: 'evil.invalid' })).status, 403);
  assert.equal((await f.send({ origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.send({ method: 'OPTIONS' })).status, 405); assert.equal(f.forwarded.length, 0);
  const batch = await f.send({ body: [request('eth_sendRawTransaction', ['0xdead']), { ...request('eth_chainId'), id: 8 }] });
  assert.equal(batch.status, 200); assert.equal(batch.body[0].error.code, -32601); assert.equal(batch.body[1].result, '0x38');
  assert.deepEqual(f.forwarded.map(call => call.method), ['eth_chainId']);
  const before = f.forwarded.length;
  assert.equal((await f.send({ body: Array(26).fill(request('eth_chainId')) })).status, 400);
  assert.equal(f.forwarded.length, before);
});

test('admin HTTP requires same-origin credentials, rejects the removed wallet flow, and rotates the scoped cookie', async () => {
  const f = await httpFixture();
  assert.equal((await f.send({ url: '/api/admin/login', origin: null, body: ADMIN })).status, 403);
  assert.equal((await f.send({ url: '/api/admin/login', origin: 'https://evil.invalid', body: ADMIN })).status, 403);
  assert.equal((await f.send({ url: '/api/admin/status', method: 'GET', body: null })).status, 401);
  assert.equal((await f.send({ url: '/api/admin/challenge', body: { address: WALLET } })).status, 404);
  assert.equal((await f.send({ url: '/api/admin/login', body: { id: 'removed', signature: '0xdead' } })).status, 401);
  const login = await f.send({ url: '/api/admin/login', body: ADMIN });
  assert.equal(login.status, 200); assert.equal(login.body.token, undefined);
  const cookie = login.headers['set-cookie']; assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/api\/admin/);
  assert.doesNotMatch(cookie, /; Secure/); assert.equal(login.body.username, ADMIN.username);
  const unknown = await f.send({ url: '/api/admin/withdraw', method: 'POST', cookie, body: {} });
  assert.equal(unknown.status, 404); assert.equal(f.forwarded.length, 0, 'account login must not call ownerOf or a wallet/chain provider');
  const again = await f.send({ url: '/api/admin/login', cookie, body: ADMIN }); assert.equal(again.status, 200);
  assert.notEqual(again.headers['set-cookie'], cookie);
  assert.equal((await f.send({ url: '/api/admin/status', method: 'GET', cookie, body: null })).status, 401);
  const currentCookie = again.headers['set-cookie'];
  assert.equal((await f.send({ url: '/api/admin/logout', cookie: currentCookie, body: {} })).status, 200);
  assert.equal((await f.send({ url: '/api/admin/status', method: 'GET', cookie: currentCookie, body: null })).status, 401);
});

test('HTTPS admin uses Secure cookies and trusts X-Real-IP only from its local reverse proxy', async () => {
  const f = await httpFixture({ publicOrigin: 'https://tapeout.cc.cd' });
  assert.equal((await f.send({ url: '/api/health', method: 'GET', host: '127.0.0.1:8788', body: null })).status, 403);
  const ip = { 'x-real-ip': '203.0.113.10' };
  for (let i = 0; i < 5; i++) assert.equal((await f.send({ url: '/api/admin/login', body: { ...ADMIN, password: 'incorrect-test-password' }, extraHeaders: ip })).status, 401);
  const locked = await f.send({ url: '/api/admin/login', body: ADMIN, extraHeaders: { ...ip, 'x-forwarded-for': '203.0.113.99' } });
  assert.equal(locked.status, 429); assert.equal(locked.headers['retry-after'], '900');
  const otherIp = await f.send({ url: '/api/admin/login', body: ADMIN, extraHeaders: { 'x-real-ip': '203.0.113.11' } });
  assert.equal(otherIp.status, 200); assert.match(otherIp.headers['set-cookie'], /; Secure/);
  for (let i = 0; i < 5; i++) assert.equal((await f.send({ url: '/api/admin/login', body: { ...ADMIN, password: 'incorrect-test-password' },
    peer: '198.51.100.20', extraHeaders: { 'x-real-ip': `203.0.113.${20 + i}` } })).status, 401);
  assert.equal((await f.send({ url: '/api/admin/login', body: ADMIN, peer: '198.51.100.20', extraHeaders: { 'x-real-ip': '203.0.113.90' } })).status, 429);
  assert.equal(f.forwarded.length, 0);
});

test('HTTP status and RPC failures do not leak upstream messages or publish an unverified status', async () => {
  const f = await httpFixture();
  const rpc = await f.send({ body: request('eth_getTransactionReceipt', [HASH]) });
  assert.equal(rpc.body.error.code, -32000); assert.ok(!rpc.text.includes('Upstream secret'));
  const status = await f.send({ url: '/api/status', method: 'GET', body: null });
  assert.equal(status.status, 503); assert.equal(status.body.runtimeVerified, undefined); assert.ok(!status.text.includes('Upstream secret'));
  assert.ok(f.forwarded.some(call => call.method === 'eth_getCode'), 'status must inspect the actual runtime before rejecting its mismatch');
});
