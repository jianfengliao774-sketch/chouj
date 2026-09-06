import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, Interface, Transaction, getAddress, keccak256 } from 'ethers';
import { decideKeeperAction, readKeeperSnapshot } from './run_bem_raffle_keeper.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const GAS_CAP = 4_000_000n;
export const CALLS = new Interface(['function settle(uint256 roundId)', 'function openNextRound()', 'function openRefunds(uint256 roundId)']);
export class KeeperError extends Error { constructor(code, message = code) { super(message); this.code = code; } }
const ensure = (value, code, message) => { if (!value) throw new KeeperError(code, message); };
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item, 2) + '\n';
const sha = value => createHash('sha256').update(value).digest('hex');
export function safeError(error) { return error instanceof KeeperError ? { code: error.code, message: error.message } : { code: 'RPC_OR_IO_ERROR', message: 'RPC or local I/O failed; sensitive error details suppressed.' }; }

export function loadRelease(directory = path.join(ROOT, 'outputs/bem-raffle-2075/production')) {
  const read = name => JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
  const plan = read('release-plan.json'), deployment = read('deployment-verified.json'), artifact = read('Bem2075RaffleBSC.artifact.json');
  ensure(plan.chainId === 56 && deployment.chainId === 56, 'RELEASE_CHAIN');
  ensure(plan.targetContract === 'Bem2075RaffleBSC' && deployment.contractName === plan.targetContract && artifact.contractName === plan.targetContract, 'RELEASE_CONTRACT');
  ensure(eq(plan.deployment.address, deployment.address) && eq(plan.deployment.runtimeCodeHash, deployment.runtimeCodeHash), 'RELEASE_BINDING');
  ensure(/^0x[0-9a-f]{64}$/i.test(deployment.runtimeCodeHash), 'RELEASE_CODE_HASH');
  ensure(Object.keys(deployment.sourceSha256s).length === 4, 'RELEASE_SOURCES');
  for (const [name, hash] of Object.entries(deployment.sourceSha256s)) {
    ensure(name.startsWith('contracts/production/') && !name.includes('..'), 'RELEASE_SOURCE_PATH');
    ensure(hash === artifact.sourceSha256s[name] && sha(readFileSync(path.join(ROOT, name))) === hash, 'RELEASE_SOURCE_HASH');
  }
  const expected = { ...deployment.checkedImmutablesAndRules,
    bem: plan.token.address, coordinator: plan.vrf.coordinator, subscriptionId: plan.vrf.subscriptionId,
    keyHash: plan.vrf.keyHash, CONTAINER: plan.container.selected.address, organizer: plan.container.selected.address,
    AUTHORIZATION_NFT: plan.container.selected.nft, AUTHORIZATION_TOKEN_ID: plan.container.selected.tokenId,
    requestConfirmations: plan.vrf.requestConfirmations, callbackGasLimit: plan.vrf.callbackGasLimit,
    fundingWindow: plan.rules.fundingWindowSeconds, MAX_TICKETS_PER_PURCHASE: plan.rules.maxTicketsPerPurchase,
    TICKETS_PER_ROUND: 10000, BLACKHOLE: plan.rules.blackholeAddress,
    NEXT_ROUND_DELAY: 60, DRAW_TARGET_SECONDS: 60, MIN_DRAW_DELAY: 8, MAX_DRAW_DELAY: 30 };
  const fixed = { bem: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
    coordinator: '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9',
    CONTAINER: '0x358BE84b95224d228f3A61964Fa3c9fB61D7B646',
    AUTHORIZATION_NFT: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
    AUTHORIZATION_TOKEN_ID: 2075, CIRCUIT_ID: 2075, fundingWindow: 259200,
    MAX_TICKETS_PER_PURCHASE: 500, TICKET_PRICE: '1000000', ROUND_POOL: '10000000000',
    WINNER_AMOUNT: '9500000000', ORGANIZER_AMOUNT: '100000000', BLACKHOLE_AMOUNT: '400000000' };
  for (const [name, value] of Object.entries(fixed)) ensure(eq(expected[name], value), 'RELEASE_FIXED_RULE');
  for (const [name, value] of Object.entries(deployment.checkedImmutablesAndRules)) ensure(eq(expected[name], value), 'RELEASE_PARAMETER_MISMATCH');
  return { plan, deployment, artifact, expected, address: getAddress(deployment.address), runtimeHash: deployment.runtimeCodeHash.toLowerCase() };
}

export function createChainGuard(provider, game, release, dependencies = {}) {
  const subscription = dependencies.subscription ?? new Contract(release.expected.coordinator,
    ['function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)'], provider);
  const nft = dependencies.nft ?? new Contract(release.expected.AUTHORIZATION_NFT, ['function ownerOf(uint256) view returns(address)'], provider);
  return async (snapshot, keeperAddress = null) => {
    ensure((await provider.getNetwork()).chainId === 56n, 'WRONG_CHAIN', 'Expected BSC chain 56.');
    const opts = { blockTag: snapshot.blockNumber };
    const code = await provider.getCode(release.address, snapshot.blockNumber);
    ensure(code !== '0x' && eq(keccak256(code), release.runtimeHash), 'RUNTIME_MISMATCH', 'Deployed runtime does not match the verified release.');
    const names = Object.keys(release.expected);
    const [values, sub, nftOwner] = await Promise.all([
      Promise.all(names.map(name => game.getFunction(name).staticCall(opts))),
      subscription.getSubscription(release.expected.subscriptionId, opts), nft.ownerOf(2075, opts)
    ]);
    names.forEach((name, i) => ensure(eq(values[i], release.expected[name]), 'IMMUTABLE_MISMATCH', `Fixed getter differs: ${name}.`));
    const ready = snapshot.authorized && sub.consumers.some(address => eq(address, release.address));
    const reasons = [];
    if (!snapshot.authorized) reasons.push('SERIES_NOT_AUTHORIZED');
    if (!sub.consumers.some(address => eq(address, release.address))) reasons.push('VRF_CONSUMER_REMOVED_OR_MISSING');
    if (keeperAddress) {
      ensure(eq(keeperAddress, release.plan.gas.keeperAddress), 'KEEPER_MISMATCH');
      const forbidden = [release.expected.CONTAINER, nftOwner, sub.owner, release.plan.vrf.subscriptionOwner, release.deployment.deployer];
      ensure(!forbidden.filter(Boolean).some(address => eq(address, keeperAddress)), 'FORBIDDEN_KEEPER', 'Keeper must be a dedicated EOA, separate from the container, NFT holder, subscription owner and deployer.');
      ensure(await provider.getCode(keeperAddress, snapshot.blockNumber) === '0x', 'KEEPER_HAS_CODE');
    }
    ensure((await provider.getBlock(snapshot.blockNumber))?.hash === snapshot.blockHash, 'GUARD_REORGANIZED');
    return { ready, reasons, nativeSubscriptionBalance: String(sub.nativeBalance), nftOwner, subscriptionOwner: sub.owner };
  };
}

export function assertPrivateStateDirectory(directory) {
  ensure(directory && path.isAbsolute(directory), 'STATE_DIRECTORY_REQUIRED', '--execute requires an absolute --state-dir outside the repository and static hosting directories.');
  const resolved = path.resolve(directory), relative = path.relative(ROOT, resolved);
  ensure(relative.startsWith('..') || path.isAbsolute(relative), 'PUBLIC_STATE_DIRECTORY', 'State directory must be outside the repository.');
  ensure(!resolved.split(/[\\/]/).some(segment => /^(web|public|static|dist|www|wwwroot|htdocs|html)$/i.test(segment)), 'PUBLIC_STATE_DIRECTORY');
  let ancestor = resolved;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  ensure(!lstatSync(ancestor).isSymbolicLink() && eq(realpathSync(ancestor), path.resolve(ancestor)), 'STATE_DIRECTORY_SYMLINK');
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

// The journal contains a replayable signed transaction, never a private key.
// mode 0600 is not a Windows ACL: the operator must secure the account directory.
export class KeeperStore {
  constructor(directory, binding) {
    this.directory = assertPrivateStateDirectory(directory); this.binding = binding;
    this.lockPath = path.join(this.directory, 'keeper.lock'); this.statePath = path.join(this.directory, 'journal.json');
    this.token = randomUUID(); this.locked = false;
  }
  lock() {
    let fd;
    try { fd = openSync(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new KeeperError('LOCK_EXISTS', 'Single-instance lock exists. Verify that its host/PID is stopped, back up journal.json privately, then manually remove only keeper.lock. No stale lock is removed automatically.');
      throw error;
    }
    try { writeFileSync(fd, json({ token: this.token, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })); fsyncSync(fd); this.locked = true; }
    finally { closeSync(fd); }
  }
  read() {
    ensure(this.locked, 'LOCK_REQUIRED');
    if (!existsSync(this.statePath)) return { version: 1, binding: this.binding, pending: null, lastConfirmed: null, pause: null };
    ensure(!lstatSync(this.statePath).isSymbolicLink(), 'STATE_SYMLINK');
    let state;
    try { state = JSON.parse(readFileSync(this.statePath, 'utf8')); }
    catch { throw new KeeperError('JOURNAL_INVALID', 'Journal cannot be parsed. Preserve it privately and inspect; it will never be reset automatically.'); }
    ensure(state.version === 1 && json(state.binding) === json(this.binding), 'JOURNAL_BINDING_MISMATCH');
    return state;
  }
  save(state) {
    ensure(this.locked, 'LOCK_REQUIRED');
    const temporary = path.join(this.directory, `.journal-${this.token}-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, json(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.statePath);
    const durable = openSync(this.statePath, 'r+'); try { fsyncSync(durable); } finally { closeSync(durable); }
    // Windows does not expose directory fsync through Node. File fsync plus
    // atomic rename protects process-crash recovery; power-loss guarantees depend on the filesystem.
    if (process.platform !== 'win32') { const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
  }
  close() {
    if (!this.locked) return;
    const own = JSON.parse(readFileSync(this.lockPath, 'utf8'));
    ensure(own.token === this.token, 'LOCK_CHANGED'); unlinkSync(this.lockPath); this.locked = false;
  }
}

export function validateSignedIntent(pending, binding, maxGasPrice, gasCap = GAS_CAP) {
  let tx;
  try { tx = Transaction.from(pending.rawTransaction); } catch { throw new KeeperError('INVALID_SIGNED_TRANSACTION'); }
  ensure(tx.signature && eq(tx.hash, pending.hash) && eq(tx.from, binding.keeper), 'SIGNED_IDENTITY_MISMATCH');
  ensure(tx.chainId === 56n && eq(tx.to, binding.address) && tx.value === 0n, 'SIGNED_TARGET_MISMATCH');
  ensure(tx.type === 0 && tx.gasLimit > 0n && tx.gasLimit <= gasCap && tx.gasPrice > 0n && tx.gasPrice <= maxGasPrice, 'SIGNED_FEE_MISMATCH');
  ensure(tx.nonce === pending.nonce, 'SIGNED_NONCE_MISMATCH');
  ensure(['settle', 'openNextRound', 'openRefunds'].includes(pending.action), 'SIGNED_ACTION_FORBIDDEN');
  const roundId = BigInt(pending.roundId); ensure(roundId > 0n, 'SIGNED_ROUND_MISMATCH');
  const args = pending.action === 'openNextRound' ? [] : [roundId];
  ensure(tx.data === CALLS.encodeFunctionData(pending.action, args), 'SIGNED_CALLDATA_MISMATCH');
  return tx;
}

export async function tickKeeper(context) {
  const { provider, game, signer, store, guard, binding, execute = false,
    confirmations = 12, maxGasPrice = 1_000_000_000n, minBalance = 1_000_000_000_000_000n,
    readSnapshot = () => readKeeperSnapshot(provider, game) } = context;
  ensure(Number.isInteger(confirmations) && confirmations >= 3 && confirmations <= 200, 'CONFIRMATIONS_RANGE');
  const snapshot = await readSnapshot(), checks = await guard(snapshot, execute ? binding.keeper : null);
  const decision = decideKeeperAction(snapshot);
  const report = { mode: execute ? 'execute' : 'read-only', blockNumber: snapshot.blockNumber, address: binding.address, checks, decision };
  if (!execute) return report; // No key, journal or signed transaction is needed/read in this path.
  let state = store.read();
  const pause = (code, message) => { state.pause = { code, message, at: new Date().toISOString() }; store.save(state); return { ...report, paused: state.pause }; };
  if (state.lastConfirmed) {
    const anchor = await provider.getBlock(state.lastConfirmed.blockNumber);
    if (anchor?.hash !== state.lastConfirmed.blockHash) return pause('CONFIRMED_REORG', 'A previously confirmed transaction was reorganized. Inspect chain history before any further transaction.');
  }
  if (state.pending) {
    const p = state.pending;
    try { validateSignedIntent(p, binding, maxGasPrice); }
    catch (error) { return pause(error.code || 'INVALID_SIGNED_TRANSACTION', 'Stored signed transaction fails the fixed intent checks; nothing broadcast.'); }
    const receipt = await provider.getTransactionReceipt(p.hash);
    if (receipt) {
      const canonical = await provider.getBlock(receipt.blockNumber);
      if (canonical?.hash !== receipt.blockHash) {
        p.phase = 'reorg-observed'; p.observedReceipt = null; store.save(state);
        return { ...report, pending: { hash: p.hash, phase: p.phase } };
      }
      if (receipt.hash && !eq(receipt.hash, p.hash)) return pause('RECEIPT_IDENTITY_MISMATCH', 'Receipt hash differs from the stored transaction.');
      if ((receipt.to && !eq(receipt.to, binding.address)) || (receipt.from && !eq(receipt.from, binding.keeper))) return pause('RECEIPT_IDENTITY_MISMATCH', 'Receipt participants differ from the stored transaction.');
      const head = await provider.getBlock('latest'), count = head.number - receipt.blockNumber + 1;
      p.observedReceipt = { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status }; p.phase = 'confirming'; store.save(state);
      if (count < confirmations) return { ...report, pending: { hash: p.hash, phase: p.phase, confirmations: count, required: confirmations } };
      if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) return { ...report, pending: { hash: p.hash, phase: 'reorg-observed' } };
      if (receipt.status !== 0 && receipt.status !== 1) return pause('UNKNOWN_RECEIPT_STATUS', 'Receipt has no recognized final status.');
      state.lastConfirmed = { hash: p.hash, nonce: p.nonce, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status };
      state.pending = null; store.save(state);
      if (receipt.status === 0) return pause('TRANSACTION_FAILED', 'The keeper transaction reverted. Automatic paid retries are paused; inspect the public receipt and current round.');
      return { ...report, confirmed: state.lastConfirmed, paused: state.pause };
    }
    const latest = await provider.getTransactionCount(binding.keeper, 'latest');
    const pendingNonce = await provider.getTransactionCount(binding.keeper, 'pending');
    if (latest > p.nonce) return pause('NONCE_CONSUMED', 'The nonce was mined without a matching receipt. Inspect the keeper wallet; no new nonce will be signed.');
    if (latest < p.nonce) return pause('NONCE_GAP', 'Stored nonce is ahead of confirmed account nonce; inspect journal and account history.');
    const known = await provider.getTransaction(p.hash);
    if (known && !eq(known.hash, p.hash)) return pause('TRANSACTION_IDENTITY_MISMATCH', 'RPC returned a different transaction.');
    if (pendingNonce > p.nonce && !known) return pause('UNKNOWN_PENDING_NONCE', 'Another or unrecognized pending transaction occupies this nonce.');
    if (pendingNonce > p.nonce + 1) return pause('UNTRACKED_QUEUED_NONCE', 'An additional untracked transaction is queued behind this keeper transaction.');
    if (state.pause) return { ...report, paused: state.pause, pending: { hash: p.hash, phase: p.phase } };
    if (known) return { ...report, pending: { hash: p.hash, phase: 'in-mempool' } };
    if (!checks.ready) return { ...report, writeBlocked: checks.reasons, pending: { hash: p.hash, phase: p.phase } };
    if (p.broadcastAttempts >= 3) return pause('REPLAY_LIMIT', 'The original transaction is still unlocated after three identical broadcasts; inspect the RPC and wallet.');
    if (p.lastBroadcastAt && Date.now() - p.lastBroadcastAt < 60_000) return { ...report, pending: { hash: p.hash, phase: 'awaiting-propagation' } };
    const fresh = await readSnapshot(), freshChecks = await guard(fresh, binding.keeper);
    if (!freshChecks.ready) return { ...report, writeBlocked: freshChecks.reasons };
    const currentAction = decideKeeperAction(fresh);
    if (currentAction.action !== p.action || String(currentAction.roundId) !== p.roundId) {
      return pause('STALE_PENDING_ACTION', 'The original action or round is no longer due. No other round or replacement transaction will be signed.');
    }
    const storedTx = validateSignedIntent(p, binding, maxGasPrice);
    if (await provider.getBalance(binding.keeper) < storedTx.gasLimit * storedTx.gasPrice + minBalance) {
      return { ...report, writeBlocked: ['LOW_KEEPER_BALANCE'], pending: { hash: p.hash, phase: p.phase } };
    }
    // Persist the exact signed bytes, hash, nonce and intent BEFORE network I/O.
    p.broadcastAttempts++; p.lastBroadcastAt = Date.now(); p.phase = 'broadcasting'; store.save(state);
    try {
      const sent = await provider.broadcastTransaction(p.rawTransaction);
      if (!eq(sent.hash, p.hash)) return pause('BROADCAST_HASH_MISMATCH', 'RPC broadcast returned an unexpected hash.');
      p.phase = 'broadcast'; store.save(state);
      return { ...report, submitted: { hash: p.hash, nonce: p.nonce, action: p.action, roundId: p.roundId } };
    } catch { return pause('BROADCAST_UNKNOWN', 'Broadcast outcome is unknown. Only receipt queries continue; no replacement transaction is signed or broadcast.'); }
  }
  if (state.pause) return { ...report, paused: state.pause };
  if (!checks.ready) return { ...report, writeBlocked: checks.reasons };
  if (decision.action === 'wait') return report;
  ensure(['settle', 'openNextRound', 'openRefunds'].includes(decision.action), 'ACTION_FORBIDDEN');
  const keeperAddress = await signer.getAddress(); ensure(eq(keeperAddress, binding.keeper), 'KEEPER_MISMATCH');
  const [latestNonce, pendingNonce] = await Promise.all([
    provider.getTransactionCount(binding.keeper, 'latest'), provider.getTransactionCount(binding.keeper, 'pending')]);
  if (latestNonce !== pendingNonce) return pause('UNTRACKED_PENDING_NONCE', 'Dedicated keeper has an untracked pending transaction; inspect it before proceeding.');
  if (state.lastConfirmed && latestNonce !== state.lastConfirmed.nonce + 1) {
    return pause('UNTRACKED_NONCE_ADVANCE', 'Account nonce differs from the last confirmed keeper transaction. Inspect other account activity before signing.');
  }
  const data = CALLS.encodeFunctionData(decision.action, decision.args);
  const transaction = { to: binding.address, from: binding.keeper, data, value: 0n };
  let estimate;
  try { await provider.call(transaction); estimate = await provider.estimateGas(transaction); }
  catch { return { ...report, writeBlocked: ['PREFLIGHT_FAILED'], message: 'Public action simulation failed; no signature or paid retry.' }; }
  const fees = await provider.getFeeData(), gasLimit = estimate * 120n / 100n + 20_000n;
  if (gasLimit > GAS_CAP || !fees.gasPrice || fees.gasPrice > maxGasPrice) return { ...report, writeBlocked: ['FEE_CAP'], gasLimit: String(gasLimit), gasPrice: fees.gasPrice == null ? null : String(fees.gasPrice) };
  const balance = await provider.getBalance(binding.keeper);
  if (balance < gasLimit * fees.gasPrice + minBalance) return { ...report, writeBlocked: ['LOW_KEEPER_BALANCE'], balanceWei: String(balance) };
  const rawTransaction = await signer.signTransaction({ to: binding.address, data, value: 0n, chainId: 56n, type: 0, nonce: latestNonce, gasLimit, gasPrice: fees.gasPrice });
  const pending = { rawTransaction, hash: keccak256(rawTransaction), nonce: latestNonce, action: decision.action,
    roundId: String(decision.roundId), phase: 'prepared', broadcastAttempts: 0, lastBroadcastAt: null };
  validateSignedIntent(pending, binding, maxGasPrice);
  state.pending = pending; store.save(state);
  // The next tick uses the same recovery path whether this process survives or restarts.
  return { ...report, prepared: { hash: pending.hash, nonce: pending.nonce, action: pending.action, roundId: pending.roundId } };
}
