import test from 'node:test';
import assert from 'node:assert/strict';
import { POOL_IDS, POOL_RULES, getPoolRules, validatePoolManifest, createPoolController, poolMetadata } from '../bem-production-site/web/pool-selection.js';
import { poolRegistry } from '../bem-production-site/pools.mjs';

const manifest = () => { const fixture=structuredClone(poolRegistry()); for(const row of fixture.pools)row.deployment=null; return fixture; };
test('actual server registry schema validates with the frontend and pins network/token/containers', () => {
  const result = validatePoolManifest(poolRegistry()); assert.equal(result.size, 4);
  for (const mutate of [m => m.chainId = 1, m => m.bemAddress = '0x1111111111111111111111111111111111111111',
    m => m.containerAddress = m.authorizationContainer, m => m.circuitId = 13061, m => m.subscriptionId = '123']) {
    const wrong = manifest(); mutate(wrong); assert.throws(() => validatePoolManifest(wrong));
  }
});
test('formal pools preview exact totals, ticket prices and distributions with 10000 tickets', () => {
  assert.deepEqual(POOL_IDS, ['10', '50', '100']);
  const expected = { '1': ['0.0001', '0.95', '0.01', '0.04'], '10': ['0.001', '9.5', '0.1', '0.4'],
    '50': ['0.005', '47.5', '0.5', '2'], '100': ['0.01', '95', '1', '4'] };
  for (const [id, numbers] of Object.entries(expected)) {
    const rules = getPoolRules(id), metadata = poolMetadata({ rules, message: '该场次暂未开放' });
    assert.deepEqual([metadata.unitPrice, metadata.winnerAmount, metadata.organizerAmount, metadata.blackholeAmount], numbers);
    assert.equal(BigInt(rules.ticketPriceBaseUnits) * 10000n, BigInt(rules.poolBaseUnits));
    assert.equal(rules.maxTicketsPerPurchase, 1000); assert.equal(rules.maxTicketsPerAddress, 5000);
    assert.equal(rules.fundingWindow, 86400); assert.equal(rules.refundClaimWindow, 86400);
  }
});
test('pending registry cannot enable any new pool or reuse the old mainnet game', () => {
  const rows = validatePoolManifest(manifest()); assert.equal(rows.size, 4);
  for (const row of rows.values()) { assert.equal(row.available, false); assert.equal(row.deployment, null); }
  const forged = manifest(); forged.pools[0].deployment = { address: '0xBee0848D0c77d434A52d1D0236FcBFdCA0834343', chainId: 56, verified: true, runtimeCodeHash: '0x' + 'a'.repeat(64) };
  forged.pools[0].salesEnabled = true; assert.throws(() => validatePoolManifest(forged));
  const noDeployment = manifest(); noDeployment.pools[0].salesEnabled = true;
  assert.equal(validatePoolManifest(noDeployment).get('1').available, false);
});
test('malformed, swapped and stale rules fail closed instead of displaying another pool amount', () => {
  for (const mutate of [m => m.schemaVersion = 1, m => m.pools[1].ticketPriceBaseUnits = '1000000',
    m => m.pools[1].maxTicketsPerPurchase = 500, m => m.pools[1].maxTicketsPerAddress = 10000,
    m => m.pools[1].fundingWindowSeconds = 259200, m => m.pools[1].refundClaimWindowSeconds = 0,
    m => m.pools[1].testOnly = true, m => m.pools[1].id = '100', m => m.pools.pop()]) {
    const broken = manifest(); mutate(broken); assert.throws(() => validatePoolManifest(broken));
    const controller = createPoolController(); controller.replaceManifest(broken);
    assert.equal(controller.getState().available, false); assert.ok(controller.getState().error);
  }
});
test('pool selection increments epoch, invalidates old query intents and does not execute transactions', () => {
  const changes = [], controller = createPoolController({ onChange: row => changes.push(row) });
  controller.replaceManifest(manifest()); const first = controller.getState(); assert.equal(first.id, '100');
  assert.equal(controller.getState().available, false);
  const second = controller.select('10'); assert.equal(second.rules.poolBaseUnits, '1000000000');
  assert.equal(second.epoch, first.epoch + 1); assert.equal(controller.isCurrent(first), false);
  assert.equal(controller.isCurrent(second), true); assert.equal(changes.at(-1).reason, 'selection');
  controller.select('10'); assert.equal(controller.getState().epoch, second.epoch);
  assert.throws(() => controller.select('1'));
});
test('the one-BEM pool remains explicitly internal and requires opt-in', () => {
  assert.throws(() => createPoolController({ initialPool: '1' }));
  const controller = createPoolController({ initialPool: '1', allowInternal: true });
  controller.replaceManifest(manifest()); const current = controller.getState();
  assert.equal(current.rules.testOnly, true); assert.equal(current.available, false);
  assert.equal(current.rules.maxTickets, 10000); assert.ok(current.visibleIds.includes('1'));
});
test('verified deployment registration changes invalidate selection snapshots and require independent addresses', () => {
  const controller = createPoolController({ initialPool: '10' }); controller.replaceManifest(manifest()); const prior = controller.getState();
  const m = manifest(); const target = m.pools.find(row => row.id === '10');
  target.deployment = { address: '0x1111111111111111111111111111111111111111', chainId: 56, verified: true, runtimeCodeHash: '0x' + 'b'.repeat(64) };
  target.salesEnabled = true; controller.replaceManifest(m);
  assert.equal(controller.getState().available, true); assert.equal(controller.isCurrent(prior), false);
  m.pools.find(row => row.id === '50').deployment = { ...target.deployment };
  assert.throws(() => validatePoolManifest(m));
  controller.fail(); assert.equal(controller.getState().available, false); assert.equal(controller.getState().deployment, null);
});
