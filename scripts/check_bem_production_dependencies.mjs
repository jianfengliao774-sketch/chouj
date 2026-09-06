// BSC production dependency snapshot. Public reads only; no wallet, signer,
// signing request, transaction, state override, account impersonation, or fork.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, getAddress, keccak256, formatUnits } from 'ethers';

const root = fileURLToPath(new URL('../', import.meta.url));
const folder = path.join(root, 'outputs/bem-raffle-2075');
const preferences = JSON.parse(await fs.readFile(path.join(folder, 'deployment-preferences.json'), 'utf8'));
const priorSubscription = JSON.parse(await fs.readFile(path.join(folder, 'subscription-readonly.json'), 'utf8'));
const priorCircuit = JSON.parse(await fs.readFile(path.join(folder, 'circuit-2075.json'), 'utf8'));
const endpoints = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed-public.bnbchain.org'];
const addresses = {
  bem: getAddress('0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'),
  evaluator: getAddress('0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C'),
  tapeout: getAddress('0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C'),
  opener: getAddress('0x021745DE2f42A7839d96f2d3634d0294487D81F1'),
  coordinator: getAddress(preferences.vrfCoordinator)
};
assert.equal(addresses.coordinator, getAddress('0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9'));
assert.equal(preferences.chainIdForFutureProduction, 56);
assert.equal(typeof preferences.vrfSubscriptionId, 'string', 'Subscription ID must never pass through a JS number');
assert.match(preferences.vrfSubscriptionId, /^[1-9][0-9]*$/, 'Expected a complete decimal subscription ID');
assert.ok(BigInt(preferences.vrfSubscriptionId) < (1n << 256n), 'Subscription ID exceeds uint256');
const abi = new Interface([
  ...priorSubscription.abi.filter(item => item.startsWith('function getSubscription(')),
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function accountOf(address,uint256) view returns(address)',
  'function isOpened(address,uint256) view returns(bool)',
  'function ownerOf(uint256) view returns(address)',
  'function owner() view returns(address)',
  'function token() view returns(uint256 chainId,address tokenContract,uint256 tokenId)',
  'function EXEC_FEE() view returns(uint256)',
  'function netlist(uint256) view returns(bytes)',
  'function circuitInfo(uint256) view returns(uint32,uint32,uint32,uint32)',
  'function eval(uint256,bytes) view returns(bytes)'
]);
const allowedMethods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_call']);
const viewSelectors = new Set(abi.fragments.filter(f => f.type === 'function').map(f => abi.getFunction(f.name).selector));
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const report = {
  schema: 'bem-production-dependencies-readonly/v1', status: 'running', checkedAt: new Date().toISOString(),
  readOnly: true, mainnetTransactionsSent: 0, walletSignaturesRequested: 0,
  scope: 'Public dependency reads at one latest block per attempt. No production deployment or end-to-end raffle verification. No permission claim is inferred from knowing an NFT owner address.',
  limits: 'This snapshot does not establish control of owner wallets, validate global mining rank, audit contract implementation, verify VRF delivery, or estimate whether the subscription balance is sufficient for a draw.',
  inputs: { addresses, subscriptionId: preferences.vrfSubscriptionId, expectedSubscriptionOwner: preferences.vrfSubscriptionOwner,
    expected2075NetlistHash: priorCircuit.netlistHash,
    priorPreferenceContainer: preferences.organizerAddress,
    candidateSelection: `Configured recipient ${preferences.organizerAddress}; both discussed containers are read without changing deployment preferences.` },
  safety: { allowedRpcMethods: [...allowedMethods], viewOnlySelectors: [...viewSelectors], stateOverrides: false, privateKeysRead: false },
  attempts: []
};

async function attempt(rpc) {
  const result = { rpc, startedAt: new Date().toISOString(), status: 'running', failures: [], rawRpc: [] };
  let sequence = 0;
  const allowedTargets = new Set(Object.values(addresses).map(address => address.toLowerCase()));
  async function request(method, params) {
    assert.ok(allowedMethods.has(method), `Prohibited remote method: ${method}`);
    if (method === 'eth_call') {
      assert.equal(params.length, 2, 'State overrides prohibited');
      assert.deepEqual(Object.keys(params[0]).sort(), ['data', 'to']);
      assert.ok(allowedTargets.has(params[0].to.toLowerCase()), 'Unknown call target');
      assert.ok(viewSelectors.has(params[0].data.slice(0, 10)), 'Only declared view selectors allowed');
    }
    const body = { jsonrpc: '2.0', id: ++sequence, method, params };
    const entry = { request: body };
    result.rawRpc.push(entry);
    try {
      const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      entry.response = payload;
      if (payload.error) throw new Error(payload.error.message || 'Unknown RPC error');
      assert.notEqual(payload.result, undefined, 'Missing RPC result');
      return payload.result;
    } catch (error) {
      entry.error = error.shortMessage || error.message;
      throw error;
    }
  }
  async function capture(name, task) {
    try { return await task(); }
    catch (error) {
      const failure = { check: name, error: error.shortMessage || error.message };
      result.failures.push(failure);
      return { status: 'unknown', error: failure.error };
    }
  }
  try {
    assert.equal(BigInt(await request('eth_chainId', [])), 56n, 'Expected BNB Chain mainnet (56)');
    const block = await request('eth_getBlockByNumber', ['latest', false]);
    assert.ok(block?.number && block?.hash && block?.timestamp, 'Snapshot unavailable');
    const tag = block.number;
    result.snapshot = { chainId: 56, blockNumber: Number(BigInt(tag)), blockTag: tag, blockHash: block.hash,
      timestamp: Number(BigInt(block.timestamp)), timeUtc: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() };
    const read = async (to, fn, args = []) => abi.decodeFunctionResult(fn,
      await request('eth_call', [{ to, data: abi.encodeFunctionData(fn, args) }, tag]));
    const code = async address => {
      const runtime = await request('eth_getCode', [address, tag]);
      return { exists: runtime !== '0x', runtimeBytes: (runtime.length - 2) / 2, runtimeKeccak256: keccak256(runtime) };
    };
    async function container(name, tokenContract, tokenId) {
      const [account, opened, nftOwner] = await Promise.all([
        read(addresses.opener, 'accountOf', [tokenContract, tokenId]),
        read(addresses.opener, 'isOpened', [tokenContract, tokenId]),
        read(tokenContract, 'ownerOf', [tokenId])
      ]);
      const address = getAddress(account[0]);
      allowedTargets.add(address.toLowerCase());
      const [runtime, native] = await Promise.all([code(address), request('eth_getBalance', [address, tag])]);
      const base = { project: name, tokenContract, tokenId, address, nftOwner: getAddress(nftOwner[0]),
        nftOwnerMatchesSubscriptionOwner: getAddress(nftOwner[0]) === getAddress(preferences.vrfSubscriptionOwner),
        opened: opened[0], runtime, nativeBalanceWei: BigInt(native), nativeBalanceBnb: formatUnits(BigInt(native), 18) };
      if (!runtime.exists) return { ...base, status: opened[0] ? 'inconsistent' : 'not_created',
        bindingVerified: false, ownerMatchesNft: null, note: 'The deterministic account address has no deployed code at this snapshot.' };
      const [owner, binding, fee, balance] = await Promise.all([
        read(address, 'owner'), read(address, 'token'), read(address, 'EXEC_FEE'), read(addresses.bem, 'balanceOf', [address])
      ]);
      const bindingMatches = binding[0] === 56n && getAddress(binding[1]) === tokenContract && binding[2] === BigInt(tokenId);
      const ownerMatches = getAddress(owner[0]) === getAddress(nftOwner[0]);
      return { ...base, status: opened[0] && bindingMatches && ownerMatches ? 'verified' : 'inconsistent',
        owner: getAddress(owner[0]), ownerMatchesNft: ownerMatches, bindingVerified: bindingMatches,
        binding: { chainId: binding[0], tokenContract: getAddress(binding[1]), tokenId: binding[2] },
        execFeeWei: fee[0], execFeeBnb: formatUnits(fee[0], 18), bemBalanceBaseUnits: balance[0] };
    }
    const checks = [
      ['bem', async () => {
        const [decimals, runtime] = await Promise.all([read(addresses.bem, 'decimals'), code(addresses.bem)]);
        return { address: addresses.bem, decimals: Number(decimals[0]), expectedDecimals: 8,
          decimalsMatch: decimals[0] === 8n, runtime };
      }],
      ['subscription', async () => {
        const [sub, runtime] = await Promise.all([
          read(addresses.coordinator, 'getSubscription', [preferences.vrfSubscriptionId]), code(addresses.coordinator)
        ]);
        return { coordinator: addresses.coordinator, subscriptionId: preferences.vrfSubscriptionId,
          owner: getAddress(sub[3]), ownerMatchesPreference: getAddress(sub[3]) === getAddress(preferences.vrfSubscriptionOwner),
          linkBalanceBaseUnits: sub[0], linkBalance: formatUnits(sub[0], 18), nativeBalanceWei: sub[1], nativeBalanceBnb: formatUnits(sub[1], 18),
          requestCount: sub[2], consumers: Array.from(sub[4], getAddress), consumerCount: sub[4].length,
          nativeFunded: sub[1] > 0n, fundingSufficiency: 'not_estimated', runtime };
      }],
      ['evaluator2075', async () => {
        const [owner, netlist, info, sampleA, sampleB, runtime] = await Promise.all([
          read(addresses.evaluator, 'ownerOf', [2075]), read(addresses.evaluator, 'netlist', [2075]),
          read(addresses.evaluator, 'circuitInfo', [2075]), read(addresses.evaluator, 'eval', [2075, '0x1103']),
          read(addresses.evaluator, 'eval', [2075, '0xf302']), code(addresses.evaluator)
        ]);
        const hash = keccak256(netlist[0]);
        return { address: addresses.evaluator, circuitId: 2075, owner: getAddress(owner[0]), runtime,
          info: { inputBits: info[0], outputBits: info[1], stateBits: info[2], gateCount: info[3] },
          netlistHash: hash, netlistBytes: (netlist[0].length - 2) / 2, netlistMatchesPinnedSource: hash === priorCircuit.netlistHash,
          samples: [
            { input: '0x1103', meaning: '17 + 3', output: sampleA[0], expected: '0x1400', matches: sampleA[0] === '0x1400' },
            { input: '0xf302', meaning: '243 + 2', output: sampleB[0], expected: '0xf500', matches: sampleB[0] === '0xf500' }
          ], note: 'Fixed deterministic evaluator samples; not a lottery draw or unpredictability test.' };
      }],
      ['container2075', () => container('BEHEMOTH', addresses.evaluator, 2075)],
      ['container13043', () => container('TapeOut', addresses.tapeout, 13043)]
    ];
    const values = await Promise.allSettled(checks.map(([name, task]) => capture(name, task)));
    for (let index = 0; index < values.length; index++) {
      const item = values[index];
      assert.equal(item.status, 'fulfilled', 'capture must retain every check result');
      result[checks[index][0]] = item.value;
    }
    const stable = await request('eth_getBlockByNumber', [tag, false]);
    result.snapshotStable = stable.hash === block.hash;
    assert.ok(result.snapshotStable, 'Snapshot block hash changed during reads');
    result.status = result.failures.length ? 'partial' : 'read_complete';
  } catch (error) {
    result.status = 'failed';
    result.failures.push({ check: 'snapshot', error: error.shortMessage || error.message });
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

// At most one fallback, beginning a new latest snapshot. Never combine fields
// from different blocks and never restart an old fork integration here.
for (const rpc of endpoints) {
  const result = await attempt(rpc);
  report.attempts.push(result);
  if (result.status === 'read_complete') break;
}
const final = report.attempts.at(-1);
report.status = final.status;
report.selectedAttempt = report.attempts.length - 1;
report.snapshot = final.snapshot || null;
report.dependencies = Object.fromEntries(['bem', 'subscription', 'evaluator2075', 'container2075', 'container13043']
  .map(key => [key, final[key] || { status: 'unknown', error: 'Snapshot could not be established' }]));
report.readiness = {
  productionReady: false,
  nativeSubscriptionFunded: final.subscription?.nativeFunded ?? null,
  existingSubscriptionConsumers: final.subscription?.consumerCount ?? null,
  containers: { behemoth2075: final.container2075?.status ?? 'unknown', tapeout13043: final.container13043?.status ?? 'unknown' },
  blockers: ['Production rules contract and deployment parameters require final review.',
    'A deployed production game must be added as an authorized VRF consumer and its complete lifecycle verified.'],
  note: 'Read completion is not production readiness. A positive subscription balance is not proof that a draw is affordable.'
};
if (final.subscription?.nativeFunded === false) report.readiness.blockers.push('Native BNB funding is zero at this snapshot.');
report.finishedAt = new Date().toISOString();
const productionFolder = path.join(folder, 'production');
await fs.mkdir(productionFolder, { recursive: true });
let output = path.join(productionFolder, 'dependencies-readonly.json');
try { await fs.writeFile(output, serialize(report) + '\n', { flag: 'wx' }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  output = path.join(productionFolder, `dependencies-readonly-${report.checkedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(output, serialize(report) + '\n', { flag: 'wx' });
}
console.log(serialize({ status: report.status, snapshot: report.snapshot, dependencies: report.dependencies,
  readiness: report.readiness, output: path.relative(root, output) }));
if (report.status !== 'read_complete') process.exitCode = 1;
