import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { keccak256 } from 'ethers';
import { START_FIXED as F, START_ABI as ABI, actionTransaction, assertSnapshot, assertActionReady, assertIntent, restoreRecord, assertReceiptEvents, uint } from '../bem-production-site/web/start-test-guards.js';

const code = fs.readFileSync(new URL('./fixtures/start-test-runtime.hex', import.meta.url), 'utf8').trim();
const owner = '0x304F06903324B8056cB1ED627144EfB2C34df3a8';
test('wallet quantities accept exact numeric representations without rounding or coercing malformed values', () => {
  for (const value of [56, 56n, '56', '0x38']) assert.equal(uint(value), 56n);
  assert.equal(uint(0), 0n);
  assert.equal(uint(Number.MAX_SAFE_INTEGER), 9007199254740991n);
  assert.equal(uint('1000000000000000000'), 1000000000000000000n);
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1e18, 0.5, NaN, Infinity, -1, null, true, {}, '0x', '', ' 56', '5e1'])
    assert.throws(() => uint(value));
  assert.throws(() => uint((2n ** 256n).toString()));
});
function snapshot() { return { chainId: '56', block: '100', blockHash: '0x' + 'ab'.repeat(32), code, subscriptionId: F.subscriptionId, dependencyCodes: Array(4).fill('0x6000'),
  containerOpened: true, containerAccount: F.authorizationContainer, containerToken: ['56', F.processor, '2075'], containerOwner: owner, nftOwner: owner, subscriptionOwner: owner,
  consumers: [F.game], seriesAuthorized: false, execFeeWei: F.execFeeWei, subscriptionNativeWei: '10000000000000000', containerNativeWei: '0', currentRound: '1', round: ['0'] }; }

test('exact public runtime, owner bindings, chain, subscription and 0.0002 BNB protocol fee are required', () => {
  assert.equal(keccak256(code), F.runtimeHash); assertSnapshot(snapshot());
  for (const changes of [{ chainId: '1' }, { code: '0x6000' }, { subscriptionId: '1' }, { execFeeWei: '1000000000000000000' }, { containerAccount: F.revenueContainer }, { containerToken: ['56', F.processor, '13061'] }, { nftOwner: F.game }, { dependencyCodes: ['0x'] }])
    assert.throws(() => assertSnapshot({ ...snapshot(), ...changes }));
  assert.equal(assertActionReady('authorize', snapshot(), owner).value, F.execFeeWei, 'zero container balance is valid: the caller supplies the protocol fee');
  assert.throws(() => assertActionReady('authorize', { ...snapshot(), consumers: [] }, owner));
  assert.throws(() => assertActionReady('authorize', { ...snapshot(), subscriptionNativeWei: '0' }, owner));
  assert.throws(() => assertActionReady('authorize', { ...snapshot(), seriesAuthorized: true }, owner));
  assert.throws(() => assertActionReady('consumer', snapshot(), owner));
});

test('action calldata cannot authorize a foreign recipient, use delegatecall, approve tokens or transfer extra BNB', () => {
  const add = actionTransaction('consumer'), start = actionTransaction('authorize', F.execFeeWei);
  assert.deepEqual([...ABI.decodeFunctionData('addConsumer', add.data)], [BigInt(F.subscriptionId), F.game]);
  assert.deepEqual([...ABI.decodeFunctionData('execute', start.data)], [F.game, 0n, ABI.encodeFunctionData('authorizeSeries'), 0n]);
  assert.throws(() => actionTransaction('authorize', '1')); assert.throws(() => actionTransaction('approve'));
  const row = { schemaVersion: 1, action: 'authorize', chainId: 56, game: F.game, account: owner, nonce: '0', ...start, hash: null, createdAt: new Date().toISOString(), status: 'verified' };
  assert.equal(restoreRecord(row, 'authorize').status, 'unknown');
  for (const changes of [{ to: F.game }, { value: '1' }, { data: add.data }, { game: F.revenueContainer }]) assert.throws(() => restoreRecord({ ...row, ...changes }, 'authorize'));
});

test('review identity, expiry and existing pending reservation are checked immediately before signing', () => {
  const wallet = {}, c = { action: 'consumer', wallet, account: owner, epoch: 1 }, now = Date.now();
  const state = { ...c, estimate: { ...c, createdAt: now, expiresAt: now + 90000 }, records: {}, storageError: false };
  assertIntent(c, state, now);
  assert.throws(() => assertIntent(c, state, now + 90000));
  assert.throws(() => assertIntent(c, { ...state, epoch: 2 }, now));
  assert.throws(() => assertIntent(c, { ...state, records: { consumer: {} } }, now));
  assert.throws(() => assertIntent(c, { ...state, storageError: true }, now));
});

test('configuration success requires matching canonical transaction events for the fixed game', () => {
  const transactionHash = '0x' + 'ab'.repeat(32), blockHash = '0x' + 'cd'.repeat(32), blockNumber = '0x64';
  const make = (name, values, address) => ({ ...ABI.encodeEventLog(ABI.getEvent(name), values), transactionHash, blockHash, blockNumber, address });
  const receipt = { transactionHash, blockHash, blockNumber, logs: [make('ContainerSeriesAuthorized', [F.authorizationContainer], F.game), make('RoundStarted', [1n, 100000n], F.game)] };
  assertReceiptEvents('authorize', receipt);
  assert.throws(() => assertReceiptEvents('authorize', { ...receipt, logs: receipt.logs.slice(0, 1) }));
  assert.throws(() => assertReceiptEvents('authorize', { ...receipt, logs: receipt.logs.map(log => ({ ...log, address: F.revenueContainer })) }));
  assert.throws(() => assertReceiptEvents('authorize', { ...receipt, logs: receipt.logs.map(log => ({ ...log, removed: true })) }));
});
