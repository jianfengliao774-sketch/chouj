// Verify a user-signed deployment receipt and record its public identity.
// This command never signs, broadcasts, adds consumers or activates sales.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, getAddress, keccak256 } from 'ethers';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'outputs/bem-raffle-2075/production');
const transactionHash = process.argv[2];
assert.match(transactionHash || '', /^0x[0-9a-fA-F]{64}$/, 'Usage: node scripts/record_bem_production_deployment.mjs 0xTRANSACTION_HASH');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const saveJson = (file, data) => fs.writeFile(file, JSON.stringify(data, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2) + '\n');
const [plan, review, artifact] = await Promise.all([
  readJson(path.join(dir, 'release-plan.json')), readJson(path.join(dir, 'deployment-review.json')),
  readJson(path.join(dir, 'Bem2075RaffleBSC.artifact.json'))
]);
assert.equal(review.contractName, 'Bem2075RaffleBSC');
assert.equal(plan.chainId, 56); assert.equal(review.chainId, 56);
assert.equal(plan.vrf.subscriptionId, review.subscription.id);
assert.equal(keccak256(artifact.bytecode), review.creationCodeHash);
for (const [file, hash] of Object.entries(artifact.sourceSha256s)) {
  const actual = createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex');
  assert.equal(actual, hash, `Source changed: ${file}`); assert.equal(review.sourceSha256s[file], hash);
}
const rpcUrl = 'https://bsc-dataseed.bnbchain.org';
const allowed = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call']);
let id = 0;
async function rpc(method, params) {
  assert.ok(allowed.has(method), 'Read-only methods only');
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const data = await response.json(); if (data.error) throw new Error(data.error.message); return data.result;
}
assert.equal(BigInt(await rpc('eth_chainId', [])), 56n);
const [tx, receipt, latest] = await Promise.all([
  rpc('eth_getTransactionByHash', [transactionHash]), rpc('eth_getTransactionReceipt', [transactionHash]),
  rpc('eth_getBlockByNumber', ['latest', false])
]);
assert.ok(tx && receipt, 'Transaction is unknown or still pending');
assert.equal(BigInt(receipt.status), 1n, 'Deployment transaction reverted');
assert.equal(tx.to, null, 'Expected contract creation');
assert.equal(getAddress(tx.from), getAddress(review.expectedDeployer));
assert.equal(BigInt(tx.chainId), 56n); assert.equal(BigInt(tx.value), 0n);
assert.equal(BigInt(tx.nonce), BigInt(review.transaction.nonce));
assert.equal(keccak256(tx.input), review.deploymentDataHash);
assert.equal(tx.input.toLowerCase(), review.transaction.data.toLowerCase());
assert.equal(receipt.transactionHash.toLowerCase(), transactionHash.toLowerCase());
assert.equal(tx.blockHash, receipt.blockHash, 'Transaction/receipt block mismatch');
assert.equal(BigInt(tx.blockNumber), BigInt(receipt.blockNumber));
const confirmations = BigInt(latest.number) - BigInt(receipt.blockNumber) + 1n;
assert.ok(confirmations >= 12n, `Wait for 12 confirmations before recording (currently ${confirmations})`);
const address = getAddress(receipt.contractAddress);
assert.equal(address, getAddress(review.expectedAddress), 'Unexpected CREATE address');
if (plan.deployment) assert.equal(getAddress(plan.deployment.address), address, 'Another deployment is already recorded');
const [code, minedBlock] = await Promise.all([
  rpc('eth_getCode', [address, latest.number]), rpc('eth_getBlockByNumber', [receipt.blockNumber, false])
]);
assert.equal(minedBlock.hash, receipt.blockHash, 'Deployment block was reorganized');
assert.notEqual(code, '0x', 'No deployed game code');
const actual = Buffer.from(code.slice(2), 'hex');
const template = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
assert.equal(actual.length, template.length, 'Unexpected deployed code size');
for (const ranges of Object.values(artifact.immutableReferences)) for (const { start, length } of ranges) {
  actual.fill(0, start, start + length); template.fill(0, start, start + length);
}
assert.ok(actual.equals(template), 'Runtime differs outside compiler-defined immutables');
const iface = new Interface(artifact.abi);
const call = async fn => iface.decodeFunctionResult(fn, await rpc('eth_call', [{ to: address,
  data: iface.encodeFunctionData(fn, []) }, latest.number]))[0];
const expected = {
  bem: plan.token.address, coordinator: plan.vrf.coordinator, organizer: plan.container.selected.address,
  subscriptionId: BigInt(plan.vrf.subscriptionId), keyHash: plan.vrf.keyHash,
  requestConfirmations: 3n, callbackGasLimit: 250000n, fundingWindow: 259200n, drawWindow: 3600n,
  sourceVerifiedAtBlock: BigInt(receipt.blockNumber), AUTHORIZATION_NFT: plan.evaluator.contract,
  AUTHORIZATION_TOKEN_ID: 2075n, CONTAINER: plan.container.selected.address,
  ROUND_POOL: 10_000_000_000n, TICKET_PRICE: 1_000_000n, MAX_TICKETS_PER_PURCHASE: 500n,
  BLACKHOLE_AMOUNT: 400_000_000n, ORGANIZER_AMOUNT: 100_000_000n, WINNER_AMOUNT: 9_500_000_000n,
  CIRCUIT_ID: 2075n, CIRCUIT_HASH: plan.evaluator.netlistHash
};
const checked = {};
await Promise.all(Object.entries(expected).map(async ([name, value]) => {
  const observed = await call(name);
  if (typeof value === 'string') assert.equal(observed.toLowerCase(), value.toLowerCase(), `Wrong ${name}`);
  else assert.equal(observed, value, `Wrong ${name}`);
  checked[name] = observed;
}));
const seriesAuthorized = await call('seriesAuthorized');
assert.equal((await rpc('eth_getBlockByNumber', [latest.number, false])).hash, latest.hash, 'Read snapshot reorg');
const record = { schemaVersion: 1, status: 'verified_user_signed_deployment', verifiedAt: new Date().toISOString(),
  chainId: 56, address, contractName: 'Bem2075RaffleBSC', transactionHash, deployer: tx.from,
  deploymentBlock: Number(BigInt(receipt.blockNumber)), deploymentBlockHash: receipt.blockHash,
  runtimeCodeHash: keccak256(code), creationCodeHash: review.creationCodeHash,
  sourceSha256s: artifact.sourceSha256s, checkedImmutablesAndRules: checked,
  snapshotBlock: Number(BigInt(latest.number)), confirmations, seriesAuthorized,
  gasUsed: BigInt(receipt.gasUsed), effectiveGasPriceWei: BigInt(receipt.effectiveGasPrice),
  deploymentFeeWei: BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice),
  explorer: `https://bscscan.com/address/${address}`, transactionsSentByThisScript: 0,
  rawTransaction: tx, rawReceipt: receipt };
await saveJson(path.join(dir, 'deployment-verified.json'), record);
plan.deployment = { address, transactionHash, deploymentBlock: record.deploymentBlock, runtimeCodeHash: record.runtimeCodeHash,
  verifiedAt: record.verifiedAt, report: 'production/deployment-verified.json' };
plan.stage = 'deployed_configuration_pending';
await saveJson(path.join(dir, 'release-plan.json'), plan);
const preferencesFile = path.join(root, 'outputs/bem-raffle-2075/deployment-preferences.json');
const preferences = await readJson(preferencesFile);
preferences.status = 'verified_user_signed_deployment';
preferences.currentWork = 'production_deployed_configuration_pending';
preferences.productionRaffleDeployed = true;
preferences.productionWalletSignaturePerformed = true;
preferences.productionWalletSignaturePerformedBy = 'user_wallet';
preferences.productionRaffleAddress = address;
preferences.productionDeploymentTransaction = transactionHash;
preferences.productionDeploymentVerificationReport = 'production/deployment-verified.json';
await saveJson(preferencesFile, preferences);
await saveJson(path.join(root, 'local-bem-demo/web/production-deployment.json'), {
  schemaVersion: 1, stage: 'already_deployed', address, transactionHash, message: 'Verified deployment recorded; do not deploy again.'
});
console.log(JSON.stringify({ status: record.status, address, transactionHash, seriesAuthorized, transactionsSent: 0 }));
