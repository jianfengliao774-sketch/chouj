import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transaction, Wallet, keccak256 } from 'ethers';
import { CALLS, GAS_CAP, KeeperStore, ROOT, createChainGuard, loadRelease, safeError, tickKeeper, validateSignedIntent } from '../scripts/bem_production_keeper_core.mjs';
import { parseOptions } from '../scripts/run_bem_production_keeper.mjs';

// Public deterministic TEST ONLY bytes, never an environment key, generated key,
// production signer, RPC connection or network transaction. All RPCs below are mocks.
const testWallet = new Wallet('0x' + '11'.repeat(32));
const GAME = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const HASH = '0x' + 'aa'.repeat(32), BLOCK = '0x' + 'bb'.repeat(32), FORK = '0x' + 'cc'.repeat(32);
const snapshot = () => ({ authorized: true, currentRoundId: 2n, current: { status: 0 },
  previous: { status: 4, requestId: 7n }, now: 1020n, nextRoundOpensAt: 0n,
  blockNumber: 100, blockHash: BLOCK, timing: { lockedAt: 1000n, targetDrawBy: 1060n, scheduledDrawAt: 1020n } });
const reports = [];
function check(name, fn) { test(name, async t => {
  const result = { name, passed: false }; reports.push(result);
  try { await fn(t); result.passed = true; } catch (error) { result.error = error.message; throw error; }
}); }
test.after(() => writeFileSync(path.join(ROOT, 'outputs/bem-raffle-2075/production/verification-keeper.json'), JSON.stringify({
  checkedAt: new Date().toISOString(), status: reports.every(row => row.passed) ? 'passed' : 'failed',
  scope: 'mock_rpc_and_private_temporary_files', mainnetTransactionsSent: 0,
  sourceSha256s: Object.fromEntries(['scripts/run_bem_production_keeper.mjs', 'scripts/bem_production_keeper_core.mjs',
    'scripts/run_bem_raffle_keeper.mjs', 'test/bem-production-keeper.test.mjs'].map(name => [name, createHash('sha256').update(readFileSync(path.join(ROOT, name))).digest('hex')])),
  tests: reports
}, null, 2) + '\n'));

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bem-keeper-private-test-'));
  const binding = { chainId: 56, address: GAME, runtimeHash: HASH, keeper: testWallet.address };
  let store = new KeeperStore(directory, binding); store.lock();
  const state = { nonce: 0, pendingNonce: 0, head: 100, receipt: null, known: null, hash: BLOCK,
    balance: 10n ** 18n, gasPrice: 1_000_000_000n, estimate: 200_000n, signatures: [], broadcasts: [],
    checks: { ready: true, reasons: [] }, decisionSnapshot: snapshot(), guardCalls: 0 };
  const provider = {
    getBlock: async number => ({ number: number === 'latest' ? state.head : number, hash: state.hash }),
    getTransactionReceipt: async () => state.receipt,
    getTransactionCount: async (_address, tag) => tag === 'latest' ? state.nonce : state.pendingNonce,
    getTransaction: async () => state.known,
    call: async () => '0x', estimateGas: async () => state.estimate,
    getFeeData: async () => ({ gasPrice: state.gasPrice }), getBalance: async () => state.balance,
    broadcastTransaction: async raw => {
      // Actual disk journal must already contain these exact bytes before any RPC write.
      const durable = JSON.parse(readFileSync(path.join(directory, 'journal.json'), 'utf8'));
      assert.equal(durable.pending.rawTransaction, raw); assert.equal(durable.pending.phase, 'broadcasting');
      state.broadcasts.push(raw); return { hash: keccak256(raw) };
    }
  };
  const signer = { getAddress: async () => testWallet.address,
    signTransaction: async tx => { state.signatures.push(tx); return testWallet.signTransaction(tx); } };
  const context = { provider, game: {}, signer, store, binding, execute: true,
    guard: async () => { state.guardCalls++; return state.checks; }, readSnapshot: async () => state.decisionSnapshot };
  const restart = () => { store.close(); store = new KeeperStore(directory, binding); store.lock(); context.store = store; return store; };
  t.after(() => {
    store.close();
    const resolved = realpathSync(directory), tmp = realpathSync(os.tmpdir());
    assert.ok(path.relative(tmp, resolved).startsWith('bem-keeper-private-test-'));
    rmSync(resolved, { recursive: true });
  });
  return { directory, binding, state, provider, context, restart, get store() { return store; } };
}
async function prepared(f) { const result = await tickKeeper(f.context); assert.ok(result.prepared); return f.store.read().pending; }
const confirmedReceipt = p => ({ hash: p.hash, to: GAME, from: testWallet.address, blockNumber: 100, blockHash: BLOCK, status: 1 });

check('CLI defaults and watch stay read-only; invalid execution and insecure RPC options fail closed', () => {
  assert.equal(parseOptions(['--rpc', 'https://example.test']).execute, false);
  assert.equal(parseOptions(['--rpc', 'https://example.test', '--watch']).execute, false);
  assert.throws(() => parseOptions(['--rpc', 'https://example.test', '--execute']), /state-dir/);
  assert.throws(() => parseOptions(['--rpc', 'http://example.test']), { code: 'RPC_TLS_REQUIRED' });
  assert.throws(() => parseOptions(['--rpc', 'https://example.test', '--confirmations', '1']), { code: 'CONFIRMATIONS_RANGE' });
  const release = loadRelease(); assert.equal(release.address, release.plan.deployment.address);
});

check('read-only snapshots never access signer or execution journal', async t => {
  const f = fixture(t); f.context.execute = false;
  f.context.store = { read() { throw new Error('journal must not be opened'); } };
  f.context.signer = { getAddress() { throw new Error('key must not be touched'); } };
  const result = await tickKeeper(f.context); assert.equal(result.mode, 'read-only');
  assert.equal(result.decision.action, 'settle'); assert.equal(f.state.signatures.length, 0); assert.equal(f.state.broadcasts.length, 0);
});

check('single-instance lock refuses even a stale PID and never deletes it automatically', t => {
  const f = fixture(t), contender = new KeeperStore(f.directory, f.binding);
  assert.throws(() => contender.lock(), { code: 'LOCK_EXISTS' });
  f.store.close(); writeFileSync(path.join(f.directory, 'keeper.lock'), JSON.stringify({ pid: 99999999, host: 'stale', token: 'stale' }));
  assert.throws(() => contender.lock(), { code: 'LOCK_EXISTS' });
  assert.equal(JSON.parse(readFileSync(path.join(f.directory, 'keeper.lock'))).token, 'stale');
  unlinkSync(path.join(f.directory, 'keeper.lock')); // Test fixture only; explicitly verified stale record.
  f.store.lock();
});

check('private state cannot be placed in repository or static hosting paths', () => {
  assert.throws(() => new KeeperStore(path.join(ROOT, 'local-bem-demo/web/keeper'), {}), { code: 'PUBLIC_STATE_DIRECTORY' });
  assert.throws(() => new KeeperStore(path.join(os.tmpdir(), 'public/keeper'), {}), { code: 'PUBLIC_STATE_DIRECTORY' });
  assert.throws(() => new KeeperStore('./keeper', {}), { code: 'STATE_DIRECTORY_REQUIRED' });
});

check('crash after signing resumes the same durable raw/hash/nonce without a second signature', async t => {
  const f = fixture(t), p = await prepared(f);
  assert.equal(f.state.broadcasts.length, 0); f.restart();
  const result = await tickKeeper(f.context);
  assert.equal(result.submitted.hash, p.hash); assert.equal(f.state.signatures.length, 1);
  assert.deepEqual(f.state.broadcasts, [p.rawTransaction]); assert.ok(f.state.guardCalls >= 3);
});

check('dropped transaction recovery replays identical raw bytes and never increments nonce', async t => {
  const f = fixture(t), p = await prepared(f); await tickKeeper(f.context);
  const state = f.store.read(); state.pending.lastBroadcastAt = 0; f.store.save(state); f.restart();
  await tickKeeper(f.context);
  assert.deepEqual(f.state.broadcasts, [p.rawTransaction, p.rawTransaction]); assert.equal(f.state.signatures.length, 1);
  assert.equal(f.store.read().pending.nonce, 0);
});

check('unknown broadcast persistently pauses yet continues querying its original receipt', async t => {
  const f = fixture(t), p = await prepared(f);
  f.provider.broadcastTransaction = async raw => { f.state.broadcasts.push(raw); throw new Error('secret RPC URL and raw bytes must not escape'); };
  assert.equal((await tickKeeper(f.context)).paused.code, 'BROADCAST_UNKNOWN'); f.restart();
  assert.equal((await tickKeeper(f.context)).paused.code, 'BROADCAST_UNKNOWN'); assert.equal(f.state.broadcasts.length, 1);
  f.state.receipt = confirmedReceipt(p); f.state.head = 111;
  const confirmed = await tickKeeper(f.context); assert.equal(confirmed.confirmed.hash, p.hash); assert.equal(confirmed.paused.code, 'BROADCAST_UNKNOWN');
});

check('occupied or untracked nonce persistently pauses without replacement signing', async t => {
  const f = fixture(t); f.state.pendingNonce = 1;
  assert.equal((await tickKeeper(f.context)).paused.code, 'UNTRACKED_PENDING_NONCE'); assert.equal(f.state.signatures.length, 0);
});

check('a mined different transaction at the stored nonce pauses recovery', async t => {
  const f = fixture(t); await prepared(f); f.state.nonce = 1; f.state.pendingNonce = 1;
  assert.equal((await tickKeeper(f.context)).paused.code, 'NONCE_CONSUMED'); assert.equal(f.state.broadcasts.length, 0);
});

check('unexpected nonce advancement after a confirmed keeper transaction stops the next signature', async t => {
  const f = fixture(t), p = await prepared(f); f.state.receipt = confirmedReceipt(p); f.state.head = 111;
  await tickKeeper(f.context); f.state.nonce = 2; f.state.pendingNonce = 2;
  assert.equal((await tickKeeper(f.context)).paused.code, 'UNTRACKED_NONCE_ADVANCE'); assert.equal(f.state.signatures.length, 1);
});

check('journal write failure before broadcast cannot send a transaction', async t => {
  const f = fixture(t); f.context.store = { read: () => f.store.read(), save() { throw new Error('simulated full disk'); } };
  await assert.rejects(tickKeeper(f.context)); assert.equal(f.state.broadcasts.length, 0);
});

check('journal from another deployment or keeper cannot be recovered', async t => {
  const f = fixture(t); await prepared(f); const state = f.store.read(); state.binding.address = OTHER; f.store.save(state);
  assert.throws(() => f.store.read(), { code: 'JOURNAL_BINDING_MISMATCH' }); assert.equal(f.state.broadcasts.length, 0);
});

check('receipt needs 12 canonical confirmations before allowing another action', async t => {
  const f = fixture(t), p = await prepared(f); f.state.receipt = confirmedReceipt(p); f.state.head = 110;
  assert.equal((await tickKeeper(f.context)).pending.confirmations, 11); assert.ok(f.store.read().pending);
  f.state.head = 111; const report = await tickKeeper(f.context);
  assert.equal(report.confirmed.status, 1); assert.equal(f.store.read().pending, null); assert.equal(f.state.signatures.length, 1);
});

check('unconfirmed reorg resumes only the original transaction; confirmed reorg pauses new writes', async t => {
  const f = fixture(t), p = await prepared(f);
  f.state.receipt = { ...confirmedReceipt(p), blockHash: FORK };
  assert.equal((await tickKeeper(f.context)).pending.phase, 'reorg-observed'); assert.equal(f.state.broadcasts.length, 0);
  f.state.receipt = null; await tickKeeper(f.context); assert.deepEqual(f.state.broadcasts, [p.rawTransaction]);
  f.state.receipt = confirmedReceipt(p); f.state.head = 111; await tickKeeper(f.context);
  f.state.hash = FORK; assert.equal((await tickKeeper(f.context)).paused.code, 'CONFIRMED_REORG'); assert.equal(f.state.signatures.length, 1);
});

check('a reverted transaction has a durable terminal failure and cannot generate infinite paid retries', async t => {
  const f = fixture(t), p = await prepared(f); f.state.receipt = { ...confirmedReceipt(p), status: 0 }; f.state.head = 111;
  assert.equal((await tickKeeper(f.context)).paused.code, 'TRANSACTION_FAILED'); f.restart();
  assert.equal((await tickKeeper(f.context)).paused.code, 'TRANSACTION_FAILED'); assert.equal(f.state.signatures.length, 1); assert.equal(f.state.broadcasts.length, 0);
});

check('consumer removal stops a prepared broadcast and a new paid action', async t => {
  const f = fixture(t); await prepared(f); f.state.checks = { ready: false, reasons: ['VRF_CONSUMER_REMOVED_OR_MISSING'] };
  assert.deepEqual((await tickKeeper(f.context)).writeBlocked, f.state.checks.reasons); assert.equal(f.state.broadcasts.length, 0);
});

check('gas cap, fee cap and insufficient BNB prevent signing', async t => {
  const f = fixture(t); f.state.estimate = GAS_CAP;
  assert.deepEqual((await tickKeeper(f.context)).writeBlocked, ['FEE_CAP']);
  f.state.estimate = 200000n; f.state.gasPrice = 2_000_000_000n;
  assert.deepEqual((await tickKeeper(f.context)).writeBlocked, ['FEE_CAP']);
  f.state.gasPrice = 1_000_000_000n; f.state.balance = 0n;
  assert.deepEqual((await tickKeeper(f.context)).writeBlocked, ['LOW_KEEPER_BALANCE']); assert.equal(f.state.signatures.length, 0);
});

check('a stale openNextRound intent cannot be replayed to open a different round', async t => {
  const f = fixture(t); f.state.decisionSnapshot = { ...snapshot(), previous: { status: 5 }, nextRoundOpensAt: 1000n };
  await prepared(f); f.state.decisionSnapshot.currentRoundId = 3n;
  assert.equal((await tickKeeper(f.context)).paused.code, 'STALE_PENDING_ACTION'); assert.equal(f.state.broadcasts.length, 0);
});

check('journal raw transaction tampering cannot change target, value, chain, caller, method, round, nonce or gas', async t => {
  const f = fixture(t), p = await prepared(f), original = Transaction.from(p.rawTransaction);
  const tx = { type: 0, chainId: 56n, to: GAME, value: 0n, nonce: 0, gasLimit: original.gasLimit, gasPrice: original.gasPrice, data: original.data };
  for (const change of [{ to: OTHER }, { value: 1n }, { chainId: 97n }, { data: CALLS.encodeFunctionData('settle', [2]) },
    { data: '0xdeadbeef' }, { gasLimit: GAS_CAP + 1n }, { gasPrice: 2_000_000_000n }, { nonce: 1 }]) {
    const rawTransaction = await testWallet.signTransaction({ ...tx, ...change });
    const bad = { ...p, rawTransaction, hash: keccak256(rawTransaction) };
    assert.throws(() => validateSignedIntent(bad, f.binding, 1_000_000_000n));
  }
  assert.throws(() => validateSignedIntent(p, { ...f.binding, keeper: OTHER }, 1_000_000_000n));
  assert.throws(() => validateSignedIntent({ ...p, action: 'buy' }, f.binding, 1_000_000_000n));
  const state = f.store.read(); state.pending.rawTransaction = '0xdead'; f.store.save(state);
  assert.equal((await tickKeeper(f.context)).paused.code, 'INVALID_SIGNED_TRANSACTION'); assert.equal(f.state.broadcasts.length, 0);
});

check('live guard rejects chain, code, immutable, holder and missing consumer using one pinned block', async () => {
  const code = '0x60006000', keeper = testWallet.address;
  const release = { address: GAME, runtimeHash: keccak256(code), expected: { coordinator: OTHER, AUTHORIZATION_NFT: OTHER, CONTAINER: OTHER, subscriptionId: '1', fundingWindow: '259200' },
    plan: { gas: { keeperAddress: keeper }, vrf: { subscriptionOwner: OTHER } }, deployment: { deployer: OTHER } };
  const state = { chain: 56n, code, fundingWindow: 259200n, owner: OTHER, consumers: [GAME] };
  const provider = { getNetwork: async () => ({ chainId: state.chain }), getCode: async (address, block) => { assert.equal(block, 100); return address === GAME ? state.code : '0x'; },
    getBlock: async () => ({ hash: BLOCK }) };
  const game = { getFunction: name => ({ staticCall: async opts => { assert.equal(opts.blockTag, 100); return name === 'fundingWindow' ? state.fundingWindow : release.expected[name]; } }) };
  const guard = createChainGuard(provider, game, release, {
    nft: { ownerOf: async (_id, opts) => { assert.equal(opts.blockTag, 100); return state.owner; } },
    subscription: { getSubscription: async (_id, opts) => { assert.equal(opts.blockTag, 100); return { consumers: state.consumers, owner: OTHER, nativeBalance: 1n }; } }
  });
  assert.equal((await guard(snapshot(), keeper)).ready, true);
  state.chain = 97n; await assert.rejects(guard(snapshot(), keeper), { code: 'WRONG_CHAIN' }); state.chain = 56n;
  state.code = '0x'; await assert.rejects(guard(snapshot(), keeper), { code: 'RUNTIME_MISMATCH' }); state.code = code;
  state.fundingWindow = 1n; await assert.rejects(guard(snapshot(), keeper), { code: 'IMMUTABLE_MISMATCH' }); state.fundingWindow = 259200n;
  state.owner = keeper; await assert.rejects(guard(snapshot(), keeper), { code: 'FORBIDDEN_KEEPER' }); state.owner = OTHER;
  state.consumers = []; assert.equal((await guard(snapshot(), keeper)).ready, false);
});

check('external errors never expose raw transactions, private keys or RPC URLs', () => {
  const secret = 'https://rpc.example.test/private-secret';
  assert.ok(!JSON.stringify(safeError(new Error(secret))).includes(secret));
});
