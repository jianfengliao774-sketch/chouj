import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Interface, getCreateAddress, keccak256 } from 'ethers';
import { DEPLOY_FIXED as F, DEPLOY_MODES, CONSTRUCTOR, CONSTRUCTOR_ARGS, deploymentData, validateDeploymentArtifact,
  verifyDeploymentRuntime, assertContainerBindings, expectedReadback, assertDeploymentReadback,
  assertDeploymentTransaction, assertCreationTransaction, assertUnsuccessfulDeployment, assertDeploymentIntent } from '../bem-production-site/web/deploy-container-guards.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const HASH = '0x' + 'a'.repeat(64), BLOCK_HASH = '0x' + 'b'.repeat(64), CANCEL_HASH = '0x' + 'c'.repeat(64);
function artifactFixture(mode = 'production') {
  const m = DEPLOY_MODES[mode], bytecode = '0x60016000', deployedBytecode = '0x6000' + '0'.repeat(64) + '6002';
  return { contractName: m.contractName, testOnly: mode === 'test', abi: JSON.parse(new Interface(CONSTRUCTOR).formatJson()),
    bytecode, deployedBytecode, creationBytecodeBytes: 4, runtimeBytecodeBytes: 36, immutableReferences: { '1': [{ start: 2, length: 32 }] },
    fixedBindings: { processor: F.processor, processorId: 2075, authorizationContainer: F.authorizationContainer,
      revenueContainer: F.revenueContainer, revenueNft: F.revenueNft, revenueTokenId: 13061 },
    fixedRules: { poolBaseUnits: m.pool, ticketPriceBaseUnits: m.ticketPrice, ticketsPerRound: 10000, maxTicketsPerPurchase: 1000,
      maxTicketsPerAddress: 5000, blackholeBaseUnits: m.blackhole, organizerBaseUnits: m.organizer, winnerBaseUnits: m.winner,
      fundingWindowSeconds: 86400, refundClaimWindowSeconds: 86400 } };
}
test('four deployments pin 10000 shares, individual prices, recipient, authorization and 24h+24h windows', async () => {
  assert.equal(Object.keys(DEPLOY_MODES).length, 4);
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
  const mutations = [a => a.fixedRules.maxTicketsPerPurchase = 500, a => a.fixedRules.maxTicketsPerAddress = 10000,
    a => a.fixedRules.fundingWindowSeconds = 259200, a => a.fixedRules.refundClaimWindowSeconds = 172800,
    a => a.fixedRules.ticketPriceBaseUnits = '10000', a => a.fixedRules.ticketsPerRound = 100,
    a => a.fixedBindings.revenueContainer = F.authorizationContainer, a => a.testOnly = true,
    a => a.fixedBindings.authorizationContainer = F.revenueContainer];
  for (const mutate of mutations) { const artifact = artifactFixture(); mutate(artifact); assert.throws(() => validateDeploymentArtifact(artifact, 'production')); }
  assert.throws(() => validateDeploymentArtifact(artifactFixture('test'), 'production'));
});
test('all compiled artifacts match current page review rules', async () => {
  const hashes = new Set();
  for (const [mode, selected] of Object.entries(DEPLOY_MODES)) {
    const artifact = JSON.parse(await fs.readFile(new URL(`../outputs/bem-raffle-2075/production-v2/${selected.contractName}.artifact.json`, import.meta.url), 'utf8'));
    validateDeploymentArtifact(artifact, mode);
    hashes.add(keccak256(await deploymentData(artifact, mode)));
  }
  assert.equal(hashes.size, 4);
});
test('runtime verifies compiler immutable ranges while altered instructions and malformed masks fail', () => {
  const artifact = artifactFixture();
  const code = '0x6000' + '12'.repeat(32) + '6002';
  assert.equal(verifyDeploymentRuntime(code, artifact, 'production'), keccak256(code));
  assert.throws(() => verifyDeploymentRuntime('0x6001' + '12'.repeat(32) + '6002', artifact, 'production'));
  assert.throws(() => verifyDeploymentRuntime(code + '00', artifact, 'production'));
  for (const range of [{ start: -1, length: 32 }, { start: 2, length: 34 }, { start: 3, length: 32 }]) {
    const invalid = structuredClone(artifact); invalid.immutableReferences = { '1': [range] };
    assert.throws(() => validateDeploymentArtifact(invalid, 'production'));
  }
});
test('immutable readback rejects wrong organizer, pool, processor, VRF and activation state', () => {
  const expected = expectedReadback('pool10', 200);
  for (const [key, value] of [['organizer', F.authorizationContainer], ['CONTAINER', F.revenueContainer], ['ROUND_POOL', '10000000000'],
    ['TICKET_PRICE', '1000000'], ['CIRCUIT_ID', '13061'], ['subscriptionId', '123'], ['seriesAuthorized', true], ['sourceVerifiedAtBlock', '199']]) {
    assert.throws(() => assertDeploymentReadback({ ...expected, [key]: value }, 'pool10', 200));
  }
});
function bindingFixture() {
  return { chainId: 56, authorization: { account: F.authorizationContainer, opened: true, token: [56n, F.processor, 2075n] },
    revenue: { account: F.revenueContainer, opened: true, token: [56n, F.revenueNft, 13061n] }, decimals: 8n,
    netlistHash: F.circuitHash, circuitInfo: [12n, 9n, 0n, 71n], dependencyCodes: Array(7).fill('0x6000') };
}
test('registry and ERC6551-style token bindings must agree for both containers', () => {
  assertContainerBindings(bindingFixture());
  for (const mutate of [b => b.revenue.token[2] = 2075n, b => b.authorization.account = F.revenueContainer,
    b => b.revenue.opened = false, b => b.authorization.token[0] = 1n, b => b.chainId = 1,
    b => b.dependencyCodes[0] = '0x', b => b.decimals = 18n, b => b.circuitInfo[3] = 72n]) {
    const binding = bindingFixture(); mutate(binding); assert.throws(() => assertContainerBindings(binding));
  }
});
test('selection and wallet changes invalidate the reviewed intent instead of reusing old fee checks', () => {
  const now = 5000, current = { mode: 'production', account: ACCOUNT, epoch: 5, chainId: 56 };
  const intent = { ...current, estimate: { createdAt: 4000, expiresAt: 94000 } };
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
