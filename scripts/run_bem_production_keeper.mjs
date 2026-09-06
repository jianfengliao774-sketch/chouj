// Production keeper: one read-only inspection unless --execute is explicit.
// Never creates a key, authorizes the series, funds subscriptions or buys tickets.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, Wallet, getAddress, parseEther, parseUnits } from 'ethers';
import { KeeperError, KeeperStore, createChainGuard, loadRelease, safeError, tickKeeper } from './bem_production_keeper_core.mjs';

export function parseOptions(argv) {
  const options = { execute: false, watch: false, intervalMs: 2000, confirmations: 12,
    maxGasPrice: 1_000_000_000n, minBalance: 1_000_000_000_000_000n, rpc: null, stateDir: null };
  const values = ['--rpc', '--state-dir', '--interval-ms', '--confirmations', '--max-gas-price-gwei', '--min-balance-bnb'];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help') options.help = true;
    else if (flag === '--execute') options.execute = true;
    else if (flag === '--watch') options.watch = true;
    else if (values.includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const value = argv[++i];
      if (flag === '--rpc') options.rpc = value;
      if (flag === '--state-dir') options.stateDir = value;
      if (flag === '--interval-ms') options.intervalMs = Number(value);
      if (flag === '--confirmations') options.confirmations = Number(value);
      if (flag === '--max-gas-price-gwei') options.maxGasPrice = parseUnits(value, 'gwei');
      if (flag === '--min-balance-bnb') options.minBalance = parseEther(value);
    } else throw new KeeperError('ARGUMENTS', 'Unknown or missing argument. Use --help.');
  }
  if (options.help) return options;
  if (!options.rpc) throw new KeeperError('RPC_REQUIRED', 'Supply --rpc. No RPC URL or secret is printed.');
  let url; try { url = new URL(options.rpc); } catch { throw new KeeperError('RPC_URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new KeeperError('RPC_URL');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new KeeperError('RPC_TLS_REQUIRED');
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1000 || options.intervalMs > 60000) throw new KeeperError('INTERVAL_RANGE');
  if (!Number.isInteger(options.confirmations) || options.confirmations < 3 || options.confirmations > 200) throw new KeeperError('CONFIRMATIONS_RANGE');
  if (options.maxGasPrice <= 0n || options.maxGasPrice > 10_000_000_000n || options.minBalance < 0n) throw new KeeperError('FEE_CONFIGURATION');
  if (options.execute && !options.stateDir) throw new KeeperError('STATE_DIRECTORY_REQUIRED', 'Execution needs a private absolute --state-dir outside the repository.');
  return options;
}

const print = item => console.log(JSON.stringify(item, (_key, value) => typeof value === 'bigint' ? String(value) : value));
export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(`Usage: node scripts/run_bem_production_keeper.mjs --rpc <URL> [--watch]
Default: one READ-ONLY snapshot. --watch remains read-only. No key or journal is loaded.
Execute only with --execute --state-dir <absolute-private-directory>.
The release-plan keeperAddress must be a configured, separate dedicated EOA and
BEM_KEEPER_PRIVATE_KEY must match it. No key is generated or printed.
Options: --interval-ms 2000 --confirmations 12 --max-gas-price-gwei 1 --min-balance-bnb 0.001
Signed raw transactions are private journal data. Keep the state directory outside
repositories and all static/public hosting paths. Windows mode 0600 does not set an ACL;
secure this directory through the service account's Windows permissions.
LOCK_EXISTS: verify the recorded host/PID has stopped, back up journal.json privately,
then manually remove only keeper.lock. The script never removes a stale lock.
Persistent pauses require operator inspection of the public receipt, nonce and journal.
Do not delete pending state, edit raw transactions, or run another sender with this key.`);
    return;
  }
  const release = loadRelease();
  // Reject an unconfigured account BEFORE touching the private-key environment variable.
  let keeper = null;
  if (options.execute) {
    if (!release.plan.gas.keeperAddress) throw new KeeperError('KEEPER_NOT_CONFIGURED', 'release-plan.gas.keeperAddress is unset; execution is disabled.');
    keeper = getAddress(release.plan.gas.keeperAddress);
    if ([release.expected.CONTAINER, release.plan.vrf.subscriptionOwner, release.deployment.deployer].filter(Boolean).some(address => address.toLowerCase() === keeper.toLowerCase())) {
      throw new KeeperError('FORBIDDEN_KEEPER', 'A container, holder, subscription owner or deployer cannot be the dedicated keeper.');
    }
  }
  const provider = new JsonRpcProvider(options.rpc, undefined, { cacheTimeout: -1 });
  const game = new Contract(release.address, release.artifact.abi, provider);
  const binding = { chainId: 56, address: release.address, runtimeHash: release.runtimeHash, keeper };
  let store, signer, stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (options.execute) {
      store = new KeeperStore(options.stateDir, binding); store.lock();
      let key;
      try { key = process.env.BEM_KEEPER_PRIVATE_KEY; signer = new Wallet(key || ''); }
      catch { throw new KeeperError('KEEPER_KEY_CONFIGURATION', 'A valid dedicated BEM_KEEPER_PRIVATE_KEY is required.'); }
      finally { key = undefined; }
      if ((await signer.getAddress()) !== keeper) throw new KeeperError('KEEPER_MISMATCH', 'The configured keeper key does not match release-plan.gas.keeperAddress.');
    }
    const context = { ...options, provider, game, binding, signer, store, guard: createChainGuard(provider, game, release) };
    print({ mode: options.execute ? 'execute-public-actions' : 'read-only', chainId: 56,
      address: release.address, runtimeHash: release.runtimeHash, keeper, confirmations: options.confirmations });
    do {
      try {
        const report = await tickKeeper(context); print(report);
        // Single-shot execute performs durable preparation, then the same recovery
        // path used after a restart. It never waits or allocates a second nonce.
        if (options.execute && report.prepared && !stopped) print(await tickKeeper(context));
      } catch (error) { print({ error: safeError(error), writesThisTickStopped: true }); process.exitCode = 1; }
      if (options.watch && !stopped) await new Promise(resolve => setTimeout(resolve, options.intervalMs));
    } while (options.watch && !stopped);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    try { store?.close(); } finally { provider.destroy(); }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { print({ startupError: safeError(error), started: false }); process.exitCode = 1; });
}
