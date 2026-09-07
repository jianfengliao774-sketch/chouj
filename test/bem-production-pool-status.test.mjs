import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface, keccak256, toQuantity } from 'ethers';
import { createPoolStatusReader } from '../bem-production-site/pool-status.mjs';
import { poolRegistry } from '../bem-production-site/pools.mjs';
import { POOL_DEPLOYMENTS } from '../bem-production-site/web/pool-deployments.js';
import { CONTAINER, COORDINATOR, SUBSCRIPTION } from '../bem-production-site/config.mjs';

const artifact = JSON.parse(fs.readFileSync(new URL('../outputs/bem-raffle-2075/production-v2/Bem2075Raffle13061Test1BSC.artifact.json', import.meta.url), 'utf8'));
const gameAbi = new Interface(artifact.abi);
const code = fs.readFileSync(new URL('./fixtures/start-test-runtime.hex', import.meta.url), 'utf8').trim();
const game = POOL_DEPLOYMENTS['1'].address;
const subscriptionOwner = '0x1111111111111111111111111111111111111111';
const containerOwner = '0x2222222222222222222222222222222222222222';
const otherGame = '0x3333333333333333333333333333333333333333';
const zero = '0x' + '0'.repeat(40);
const externalAbi = new Interface([
  'function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)',
  'function owner() view returns(address)', 'function EXEC_FEE() view returns(uint256)',
]);
const unstarted = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, zero];
const jsonValue = value => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry));

function harness(overrides = {}) {
  const state = { fault: null, authorized: false, roundId: 1n, nextRound: 0n, liability: 0n, consumers: [otherGame],
    nativeBalance: 12345678901234567n, containerBalance: 0n, execFee: 200000000000000n,
    rounds: new Map([['1', unstarted]]), ...overrides };
  const calls = [], block = { number: toQuantity(120420000), hash: '0x' + 'ab'.repeat(32), timestamp: toQuantity(1800000000) };
  async function rpc(method, params) {
    calls.push({ method, params });
    assert.ok(['eth_chainId', 'eth_getCode', 'eth_getBlockByNumber', 'eth_call', 'eth_getBalance'].includes(method), `Unexpected non-read method ${method}`);
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'latest') return { ...block };
      assert.equal(params[0], block.number);
      return { ...block, hash: state.fault === 'reorg' ? '0x' + 'cd'.repeat(32) : block.hash };
    }
    if (method === 'eth_chainId') return state.fault === 'chain' ? '0x1' : '0x38';
    if (method === 'eth_getCode') {
      assert.deepEqual(params, [game, block.number]);
      return state.fault === 'code' ? '0x6000' : code;
    }
    if (method === 'eth_getBalance') { assert.deepEqual(params, [CONTAINER, block.number]); return toQuantity(state.containerBalance); }
    assert.equal(params[1], block.number, 'Every contract read must use the same pinned snapshot block');
    const [transaction] = params;
    assert.equal(transaction.value, undefined, 'Read calls must not carry BNB');
    const isGame = transaction.to.toLowerCase() === game.toLowerCase();
    const abi = isGame ? gameAbi : externalAbi, parsed = abi.parseTransaction(transaction);
    let result;
    if (isGame) {
      switch (parsed.name) {
        case 'seriesAuthorized': result = [state.authorized]; break;
        case 'currentRoundId': result = [state.roundId]; break;
        case 'nextRoundOpensAt': result = [state.nextRound]; break;
        case 'totalLiability': result = [state.liability]; break;
        case 'rounds': result = state.rounds.get(parsed.args[0].toString()); assert.ok(result, 'Only the actual current and previous rounds may be queried'); break;
        default: throw Error(`Unexpected game read ${parsed.name}`);
      }
    } else if (parsed.name === 'getSubscription') {
      assert.equal(transaction.to, COORDINATOR); assert.equal(parsed.args[0].toString(), SUBSCRIPTION);
      if (state.fault === 'rpc') throw Error('Synthetic subscription RPC unavailable');
      result = [1000000000000000000n, state.nativeBalance, 17n, subscriptionOwner, state.consumers];
    } else {
      assert.equal(transaction.to, CONTAINER, 'Authority and execution fee belong to the 2075 authorization container');
      if (parsed.name === 'owner') result = [containerOwner];
      else if (parsed.name === 'EXEC_FEE') result = [state.execFee];
      else throw Error(`Unexpected external read ${parsed.name}`);
    }
    return abi.encodeFunctionResult(parsed.name, result);
  }
  return { state, calls, block, read: createPoolStatusReader({ rpc }) };
}

test('Unstarted test pool reports the independently verified contract and distinct current permission owners without enabling sales', async () => {
  assert.equal(keccak256(code), POOL_DEPLOYMENTS['1'].runtimeCodeHash, 'Fixture must be the actual pinned runtime');
  const app = harness(), status = jsonValue(await app.read('1'));
  assert.equal(status.gameAddress, game); assert.equal(status.runtimeVerified, true);
  assert.equal(status.currentRoundId, '1'); assert.equal(status.currentRound.status, '0'); assert.equal(status.previousRound, null);
  assert.equal(status.launchState, 'needs_vrf_consumer'); assert.equal(status.seriesAuthorized, false);
  assert.equal(status.vrf.owner, subscriptionOwner); assert.equal(status.container.owner, containerOwner);
  assert.equal(status.vrf.subscriptionId, SUBSCRIPTION); assert.deepEqual(status.vrf.consumers, [otherGame]); assert.equal(status.vrf.consumerAuthorized, false);
  assert.equal(status.vrf.nativeBalanceWei, '12345678901234567'); assert.equal(status.container.nativeBalanceWei, '0');
  assert.equal(status.container.execFeeWei, '200000000000000'); assert.equal(status.container.address, CONTAINER);
  assert.equal(status.salesEnabled, false); assert.deepEqual(status.keeper, { configured: false, serviceRunning: false });
  assert.equal(status.snapshot.blockNumber, 120420000); assert.equal(status.snapshot.blockHash, app.block.hash);
});

test('configured test entry preserves Ready and previous-settled DTOs while individual purchases still need a Funding phase', async () => {
  const requestId = 2n ** 200n + 37n;
  const ready = [4n, 10000n, 1800000100n, 1800000200n, requestId, 2n ** 180n, 2n ** 170n, 17n, 0n, zero];
  const previous = [5n, 10000n, 1799900000n, 1799900200n, 123n, 456n, 789n, 71n, 8899n, containerOwner];
  const app = harness({ authorized: true, consumers: [otherGame, game.toLowerCase()], roundId: 3n, nextRound: 1800000300n,
    liability: 100000000n, rounds: new Map([['2', previous], ['3', ready]]) });
  const status = jsonValue(await app.read('1'));
  assert.equal(status.launchState, 'configured'); assert.equal(status.vrf.consumerAuthorized, true);
  assert.equal(status.currentRoundId, '3'); assert.equal(status.currentRound.status, '4'); assert.equal(status.currentRound.sold, '10000');
  assert.equal(status.currentRound.requestId, requestId.toString()); assert.equal(status.currentRound.ticketWord, (2n ** 180n).toString());
  assert.equal(status.previousRound.status, '5'); assert.equal(status.previousRound.winningTicket, '8899'); assert.equal(status.previousRound.winner, containerOwner);
  assert.equal(status.totalLiability, '100000000'); assert.equal(status.nextRoundOpensAt, '1800000300');
  assert.equal(status.salesEnabled, true); assert.equal(status.testRequested, true);
  for (const pool of poolRegistry().pools) {
    assert.equal(pool.salesEnabled, false, `Registration cannot open ${pool.id} BEM sales`);
    if (pool.id !== '1') assert.equal(pool.testOnly, false);
  }
});

test('an authorized 1 BEM test remains disabled when its VRF consumer is missing or its native subscription balance is empty', async () => {
  const funding = [1n, 0n, 1800000100n, 0n, 0n, 0n, 0n, 0n, 0n, zero];
  for (const missing of ['consumer', 'native']) {
    const app = harness({ authorized: true, rounds: new Map([['1', funding]]),
      consumers: missing === 'consumer' ? [otherGame] : [game], nativeBalance: missing === 'native' ? 0n : 12345678901234567n });
    const status = await app.read('1');
    assert.equal(status.seriesAuthorized, true); assert.equal(status.currentRound.status, 1n);
    assert.equal(status.salesEnabled, false, `Missing ${missing} must close the test entry`);
    assert.equal(status.vrf.consumerAuthorized, missing !== 'consumer');
    if (missing === 'native') assert.equal(status.vrf.nativeBalanceWei, '0');
  }
});

test('wrong chain, changed code, snapshot reorg and RPC failures publish no status and do not poison retry state', async () => {
  for (const fault of ['chain', 'code', 'reorg', 'rpc']) {
    const app = harness({ fault });
    await assert.rejects(app.read('1'), /mismatch|changed|unavailable/, fault);
    const before = app.calls.length; app.state.fault = null;
    const recovered = await app.read('1');
    assert.equal(recovered.runtimeVerified, true); assert.equal(recovered.salesEnabled, false);
    assert.ok(app.calls.length > before, 'A failed result must not be cached as a successful status');
  }
});

test('consumer membership alone still requires container authorization; concurrent requests share one read-only snapshot', async () => {
  const app = harness({ consumers: [game.toLowerCase()] });
  const [first, second] = await Promise.all([app.read('1'), app.read('1')]);
  assert.strictEqual(first, second); assert.equal(first.launchState, 'needs_container_authorization');
  assert.equal(first.vrf.consumerAuthorized, true); assert.equal(first.seriesAuthorized, false); assert.equal(first.salesEnabled, false);
  assert.equal(app.calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === 'latest').length, 1);
  const before = app.calls.length; await assert.rejects(app.read('999'), /Unknown pool/); assert.equal(app.calls.length, before);
});
