import test from 'node:test';
import assert from 'node:assert/strict';
import { planV2KeeperActions, validateV2KeeperProfile, V2_KEEPER_CALLS,
  V2_KEEPER_ACTIONS, V2_KEEPER_FIXED_ADDRESSES } from '../scripts/bem_production_v2_keeper_core.mjs';

// Pure synthetic snapshots only. No provider, network, signer or mainnet call.
const GAME = '0x2222222222222222222222222222222222222222';
const CODE = '0x' + 'aa'.repeat(32), BLOCK = '0x' + 'bb'.repeat(32);
const DAY = 86400n, DEADLINE = 100000n, CLAIM = DEADLINE + DAY;
const names = { 1: 'Bem2075Raffle13061Test1BSC', 10: 'Bem2075Raffle13061Pool10BSC',
  50: 'Bem2075Raffle13061Pool50BSC', 100: 'Bem2075Raffle13061BSC' };
function profile(pool = 100) {
  const total = BigInt(pool) * 100000000n;
  return { schemaVersion: 2, kind: 'bem2075-v2-verified', chainId: 56, address: GAME, contractName: names[pool], runtimeCodeHash: CODE,
    verification: { runtimeVerified: true, gettersVerified: true, chainId: 56, address: GAME,
      runtimeCodeHash: CODE, blockNumber: 100, blockHash: BLOCK },
    getters: { ...V2_KEEPER_FIXED_ADDRESSES, CIRCUIT_ID: 2075, AUTHORIZATION_TOKEN_ID: 2075, REVENUE_TOKEN_ID: 13061,
      TICKETS_PER_ROUND: 10000, MAX_TICKETS_PER_PURCHASE: 1000, MAX_TICKETS_PER_ADDRESS: 5000,
      fundingWindow: 86400, REFUND_CLAIM_WINDOW: 86400, NEXT_ROUND_DELAY: 60, DRAW_TARGET_SECONDS: 60, MIN_DRAW_DELAY: 8, MAX_DRAW_DELAY: 30,
      TEST_ONLY: pool === 1, ROUND_POOL: String(total), TICKET_PRICE: String(total / 10000n),
      ORGANIZER_AMOUNT: String(total / 100n), BLACKHOLE_AMOUNT: String(total * 4n / 100n), WINNER_AMOUNT: String(total * 95n / 100n),
      CIRCUIT_HASH: '0xa375924f2a31f5169606ea20e357efa2aeeb2355aff859f28f40a15519714eef',
      keyHash: '0x130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4',
      subscriptionId: '123', requestConfirmations: 3, callbackGasLimit: 250000 } };
}
function round(id, status = 1, changes = {}) {
  const started = status !== 0;
  return { roundId: id, status, sold: status >= 2 && status <= 5 ? 10000 : status === 0 ? 0 : 100,
    fundingDeadline: started ? DEADLINE : 0n, refundClaimDeadline: started ? CLAIM : 0n,
    refundedPrincipal: 0n, unclaimedPrincipalBurned: false, requestId: status >= 3 && status <= 5 ? 1n : 0n,
    timing: { lockedAt: 99900n, scheduledDrawAt: 99920n }, ...changes };
}
function snapshot(rounds = [round(1)], changes = {}, p = profile()) {
  const price = BigInt(p.getters.TICKET_PRICE);
  const liability = rounds.reduce((sum, row) => sum + (row.status === 5 || row.unclaimedPrincipalBurned ? 0n : BigInt(row.sold) * price - BigInt(row.refundedPrincipal)), 0n);
  return { chainId: 56, address: GAME, runtimeCodeHash: CODE, blockNumber: 100, blockHash: BLOCK,
    timestamp: DEADLINE, currentRoundId: Math.max(...rounds.map(row => Number(row.roundId))), seriesAuthorized: true,
    nextRoundOpensAt: 0, totalLiability: liability, historyComplete: true, rounds, ...changes };
}
const actions = plan => plan.eligible.map(row => row.action);
function rejected(p, s, code) { assert.throws(() => planV2KeeperActions(p, s), { code }); }

test('V2 planner pins all four denominations and forbids changed rules, addresses or V1 identity', () => {
  for (const pool of [1, 10, 50, 100]) assert.equal(validateV2KeeperProfile(profile(pool)).pool, BigInt(pool) * 100000000n);
  for (const change of [p => p.schemaVersion = 1, p => p.verification.runtimeVerified = false, p => p.verification.gettersVerified = false]) {
    const p = profile(); change(p); rejected(p, snapshot(), 'UNVERIFIED_V2_PROFILE');
  }
  const contract = profile(); contract.contractName = 'Bem2075RaffleBSC'; rejected(contract, snapshot(), 'WRONG_V2_CONTRACT');
  const old = profile(); old.address = '0xBee0848D0c77d434A52d1D0236FcBFdCA0834343'; rejected(old, snapshot(), 'V1_ADDRESS_FORBIDDEN');
  for (const field of ['organizer', 'CONTAINER', 'CIRCUITS']) {
    const p = profile(); p.getters[field] = GAME; rejected(p, snapshot(), 'PROFILE_FIXED_ADDRESS');
  }
  for (const [field, value] of [['fundingWindow', 259200], ['REFUND_CLAIM_WINDOW', 1], ['MAX_TICKETS_PER_ADDRESS', 10000], ['MAX_TICKETS_PER_PURCHASE', 500]]) {
    const p = profile(); p.getters[field] = value; rejected(p, snapshot(), 'PROFILE_FIXED_RULE');
  }
  const amount = profile(10); amount.getters.TICKET_PRICE = '1000000'; rejected(amount, snapshot(), 'PROFILE_DENOMINATION');
});

test('V2 planner requires the same verified block, chain, code hash and game for snapshots', () => {
  for (const mutation of [{ blockNumber: 101 }, { blockHash: '0x' + 'cc'.repeat(32) }]) rejected(profile(), snapshot(undefined, mutation), 'SNAPSHOT_VERIFICATION_BLOCK');
  for (const mutation of [{ chainId: 97 }, { address: '0x3333333333333333333333333333333333333333' }, { runtimeCodeHash: '0x' + 'cc'.repeat(32) }]) {
    rejected(profile(), snapshot(undefined, mutation), 'SNAPSHOT_BINDING');
  }
});

test('empty expired rounds always open refunds, including after the claim deadline; never burn zero', () => {
  for (const now of [DEADLINE, CLAIM, CLAIM + DAY]) {
    const s = snapshot([round(1, 1, { sold: 0 })], { timestamp: now });
    const plan = planV2KeeperActions(profile(), s);
    assert.deepEqual(actions(plan), ['openRefunds']); assert.equal(plan.nextAction.reason, 'EMPTY_ROUND_EXPIRED');
  }
  assert.deepEqual(actions(planV2KeeperActions(profile(), snapshot([round(1, 1, { sold: 0 })], { timestamp: DEADLINE - 1n }))), []);
});

test('funding expiry and fixed burn deadline are half-open boundaries with openRefunds first', () => {
  assert.deepEqual(actions(planV2KeeperActions(profile(), snapshot(undefined, { timestamp: DEADLINE - 1n }))), []);
  assert.deepEqual(actions(planV2KeeperActions(profile(), snapshot())), ['openRefunds']);
  assert.deepEqual(actions(planV2KeeperActions(profile(), snapshot(undefined, { timestamp: CLAIM - 1n }))), ['openRefunds']);
  const plan = planV2KeeperActions(profile(), snapshot(undefined, { timestamp: CLAIM }));
  assert.deepEqual(actions(plan), ['openRefunds', 'burnUnclaimed']);
  assert.equal(plan.nextAction.action, 'openRefunds'); assert.equal(plan.eligible[1].amountBaseUnits, '100000000');
});

test('old partial-refund rounds burn only remaining principal while later funding stays untouched', () => {
  const rows = [round(1, 6, { sold: 100, refundedPrincipal: 30_000_000n }),
    round(2, 1, { sold: 20, fundingDeadline: CLAIM + DAY, refundClaimDeadline: CLAIM + 2n * DAY })];
  const plan = planV2KeeperActions(profile(), snapshot(rows, { timestamp: CLAIM }));
  assert.deepEqual(actions(plan), ['burnUnclaimed']); assert.equal(plan.nextAction.roundId, '1');
  assert.equal(plan.nextAction.amountBaseUnits, '70000000');
  const before = planV2KeeperActions(profile(), snapshot(rows, { timestamp: CLAIM - 1n }));
  assert.deepEqual(before.eligible, []);
});

test('all supplied old unclaimed rounds are examined once; zero/refunded/burned rounds are excluded', () => {
  const rows = [round(1, 6), round(2, 6, { refundedPrincipal: 100_000_000n }),
    round(3, 6, { unclaimedPrincipalBurned: true }), round(4, 6, { sold: 0 }),
    round(5, 6, { refundedPrincipal: 40_000_000n }), round(6, 0)];
  const plan = planV2KeeperActions(profile(), snapshot(rows, { timestamp: CLAIM }));
  assert.deepEqual(plan.eligible.map(row => [row.action, row.roundId]), [['burnUnclaimed', '1'], ['burnUnclaimed', '5'], ['openNextRound', '6']]);
  assert.deepEqual(plan.eligible.filter(row => row.action === 'burnUnclaimed').map(row => row.amountBaseUnits), ['100000000', '60000000']);
});

test('requested/ready/settled rounds never refund or burn even beyond 48 hours', () => {
  for (const status of [3, 4, 5]) {
    const plan = planV2KeeperActions(profile(), snapshot([round(1, status), round(2, 0)], { timestamp: CLAIM + DAY }));
    assert.ok(!actions(plan).includes('openRefunds')); assert.ok(!actions(plan).includes('burnUnclaimed'));
    assert.deepEqual(actions(plan), status === 3 ? [] : status === 4 ? ['settle'] : ['openNextRound']);
  }
});

test('settlement respects the actual VRF schedule; next rounds require resolved predecessor and cooldown', () => {
  const rows = [round(1, 4), round(2, 0)];
  assert.deepEqual(actions(planV2KeeperActions(profile(), snapshot(rows, { timestamp: 99919n }))), []);
  assert.deepEqual(actions(planV2KeeperActions(profile(), snapshot(rows, { timestamp: 99920n }))), ['settle']);
  const done = [round(1, 5), round(2, 0)];
  assert.deepEqual(actions(planV2KeeperActions(profile(), snapshot(done, { timestamp: CLAIM - 1n, nextRoundOpensAt: CLAIM }))), []);
  assert.deepEqual(actions(planV2KeeperActions(profile(), snapshot(done, { timestamp: CLAIM, nextRoundOpensAt: CLAIM }))), ['openNextRound']);
});

test('unactivated series has no callable action; participant refund is never an automated plan', () => {
  const plan = planV2KeeperActions(profile(), snapshot([round(1, 0)], { seriesAuthorized: false }));
  assert.deepEqual(plan.eligible, []); assert.ok(plan.warnings.includes('SERIES_NOT_AUTHORIZED'));
  assert.equal(V2_KEEPER_CALLS.getFunction('refund'), null);
  assert.deepEqual(V2_KEEPER_ACTIONS, ['settle', 'openNextRound', 'openRefunds', 'burnUnclaimed']);
});

test('bad round accounting, a shifted claim deadline and duplicate/missing coverage fail closed', () => {
  rejected(profile(), snapshot([round(1, 1, { refundClaimDeadline: CLAIM + 1n })]), 'ROUND_CLAIM_DEADLINE');
  rejected(profile(), snapshot([round(1, 6, { refundedPrincipal: 101_000_000n }), round(2, 0)], { timestamp: CLAIM }), 'ROUND_REFUNDED');
  rejected(profile(), snapshot([round(1), round(1)]), 'ROUND_SNAPSHOT_COVERAGE');
  rejected(profile(), snapshot([round(2, 0)], { historyComplete: true }), 'ROUND_SNAPSHOT_COVERAGE');
  rejected(profile(), snapshot(undefined, { totalLiability: 0 }), 'SNAPSHOT_LIABILITY');
});

test('partial history is reported and cannot open a new round without its immediate predecessor', () => {
  const plan = planV2KeeperActions(profile(), snapshot([round(3, 0)], { historyComplete: false }));
  assert.equal(plan.historyComplete, false); assert.deepEqual(plan.eligible, []);
  assert.ok(plan.warnings.includes('OLD_ROUND_HISTORY_INCOMPLETE')); assert.ok(plan.warnings.includes('PREVIOUS_ROUND_SNAPSHOT_REQUIRED'));
});

test('plans are zero-value ABI-encoded alternatives and do not mutate frozen inputs', () => {
  const p = profile(), s = snapshot(undefined, { timestamp: CLAIM });
  const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
  const plan = planV2KeeperActions(freeze(p), freeze(s));
  for (const action of plan.eligible) {
    assert.equal(action.to, GAME); assert.equal(action.value, '0'); assert.equal(action.chainId, 56);
    assert.equal(V2_KEEPER_CALLS.parseTransaction({ data: action.data }).name, action.action);
    assert.equal(action.requiresFreshVerificationBeforeSend, true);
  }
  assert.equal(plan.mode, 'plan-only'); assert.equal(plan.mainnetTransactionsSent, 0); assert.equal(plan.signaturesRequested, 0);
});
