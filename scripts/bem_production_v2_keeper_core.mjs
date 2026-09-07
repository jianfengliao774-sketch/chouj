import { Interface, getAddress, ZeroAddress } from 'ethers';
import artifact from '../outputs/bem-raffle-2075/production-v2/Bem2075Raffle13061BSC.artifact.json' with { type: 'json' };

// Pure planning only: no provider, signer, key, RPC, journal or broadcast access.
// A caller must first verify runtime and getters at the SAME canonical block as
// the snapshots. This module validates their shape/binding; it cannot prove RPC truth.
export class V2KeeperPlanError extends Error {
  constructor(code) { super(code); this.name = 'V2KeeperPlanError'; this.code = code; }
}
const need = (value, code) => { if (!value) throw new V2KeeperPlanError(code); };
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const uint = (value, code) => {
  need(typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)), code);
  const n = BigInt(value); need(n >= 0n && n < (1n << 256n), code); return n;
};
const address = (value, code) => {
  try { const result = getAddress(value); need(result !== ZeroAddress, code); return result; }
  catch { throw new V2KeeperPlanError(code); }
};
const hash = (value, code) => { need(typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/.test(value), code); return value.toLowerCase(); };
const GAME_ABI = new Interface(artifact.abi);
export const V2_KEEPER_ACTIONS = Object.freeze(['settle', 'openNextRound', 'openRefunds', 'burnUnclaimed']);
export const V2_KEEPER_CALLS = new Interface(V2_KEEPER_ACTIONS.map(name => GAME_ABI.getFunction(name).format('full')));
export const V2_KEEPER_GETTERS = Object.freeze([
  'currentRoundId', 'seriesAuthorized', 'nextRoundOpensAt', 'totalLiability',
  'rounds', 'drawTiming', 'refundedPrincipal', 'unclaimedPrincipalBurned', 'refundClaimDeadline',
]);
for (const name of V2_KEEPER_GETTERS) need(GAME_ABI.getFunction(name), 'V2_ABI_MISSING_GETTER');
const MODES = Object.freeze({
  Bem2075Raffle13061Test1BSC: { pool: 100_000_000n, testOnly: true },
  Bem2075Raffle13061Pool10BSC: { pool: 1_000_000_000n, testOnly: false },
  Bem2075Raffle13061Pool50BSC: { pool: 5_000_000_000n, testOnly: false },
  Bem2075Raffle13061BSC: { pool: 10_000_000_000n, testOnly: false },
});
export const V2_KEEPER_FIXED_ADDRESSES = Object.freeze({
  bem: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  coordinator: '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9',
  CIRCUITS: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
  AUTHORIZATION_NFT: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
  CONTAINER: '0x358BE84b95224d228f3A61964Fa3c9fB61D7B646',
  organizer: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  REVENUE_CONTAINER: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  REVENUE_NFT: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
  OPENER: '0x021745DE2f42A7839d96f2d3634d0294487D81F1',
  BLACKHOLE: '0x000000000000000000000000000000000000dEaD',
});
const FIXED_NUMBERS = Object.freeze({
  CIRCUIT_ID: 2075, AUTHORIZATION_TOKEN_ID: 2075, REVENUE_TOKEN_ID: 13061,
  TICKETS_PER_ROUND: 10000, MAX_TICKETS_PER_PURCHASE: 1000, MAX_TICKETS_PER_ADDRESS: 5000,
  fundingWindow: 86400, REFUND_CLAIM_WINDOW: 86400, NEXT_ROUND_DELAY: 60,
  DRAW_TARGET_SECONDS: 60, MIN_DRAW_DELAY: 8, MAX_DRAW_DELAY: 30,
});
const OLD_GAME = '0xBee0848D0c77d434A52d1D0236FcBFdCA0834343';

export function validateV2KeeperProfile(profile) {
  need(profile?.schemaVersion === 2 && profile.kind === 'bem2075-v2-verified', 'UNVERIFIED_V2_PROFILE');
  need(Object.hasOwn(MODES, profile.contractName), 'WRONG_V2_CONTRACT');
  const mode = MODES[profile.contractName], gameAddress = address(profile.address, 'PROFILE_ADDRESS');
  need(!equal(gameAddress, OLD_GAME), 'V1_ADDRESS_FORBIDDEN');
  need(uint(profile.chainId, 'PROFILE_CHAIN') === 56n, 'PROFILE_CHAIN');
  const runtimeCodeHash = hash(profile.runtimeCodeHash, 'PROFILE_RUNTIME_HASH');
  const v = profile.verification;
  need(v?.runtimeVerified === true && v.gettersVerified === true, 'UNVERIFIED_V2_PROFILE');
  need(equal(v.address, gameAddress) && uint(v.chainId, 'VERIFICATION_CHAIN') === 56n && equal(v.runtimeCodeHash, runtimeCodeHash), 'VERIFICATION_BINDING');
  const blockNumber = uint(v.blockNumber, 'VERIFICATION_BLOCK');
  const blockHash = hash(v.blockHash, 'VERIFICATION_BLOCK_HASH');
  const values = profile.getters;
  need(values && typeof values === 'object', 'PROFILE_GETTERS_REQUIRED');
  for (const [name, fixed] of Object.entries(V2_KEEPER_FIXED_ADDRESSES)) need(equal(values[name], fixed), 'PROFILE_FIXED_ADDRESS');
  for (const [name, fixed] of Object.entries(FIXED_NUMBERS)) need(uint(values[name], 'PROFILE_FIXED_RULE') === BigInt(fixed), 'PROFILE_FIXED_RULE');
  need(values.TEST_ONLY === mode.testOnly, 'PROFILE_TEST_FLAG');
  need(equal(values.CIRCUIT_HASH, '0xa375924f2a31f5169606ea20e357efa2aeeb2355aff859f28f40a15519714eef'), 'PROFILE_CIRCUIT_HASH');
  need(equal(values.keyHash, '0x130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4'), 'PROFILE_VRF_KEY');
  const amounts = { ROUND_POOL: mode.pool, TICKET_PRICE: mode.pool / 10000n,
    BLACKHOLE_AMOUNT: mode.pool * 4n / 100n, ORGANIZER_AMOUNT: mode.pool / 100n, WINNER_AMOUNT: mode.pool * 95n / 100n };
  for (const [name, fixed] of Object.entries(amounts)) need(uint(values[name], 'PROFILE_DENOMINATION') === fixed, 'PROFILE_DENOMINATION');
  need(uint(values.subscriptionId, 'PROFILE_VRF_SUBSCRIPTION') > 0n, 'PROFILE_VRF_SUBSCRIPTION');
  const confirmations = uint(values.requestConfirmations, 'PROFILE_VRF_CONFIRMATIONS');
  need(confirmations >= 3n && confirmations <= 200n, 'PROFILE_VRF_CONFIRMATIONS');
  const callbackGas = uint(values.callbackGasLimit, 'PROFILE_VRF_GAS');
  need(callbackGas >= 150000n && callbackGas <= 2000000n, 'PROFILE_VRF_GAS');
  return Object.freeze({ address: gameAddress, chainId: 56, runtimeCodeHash, blockNumber, blockHash,
    contractName: profile.contractName, testOnly: mode.testOnly, pool: mode.pool, price: mode.pool / 10000n });
}

function normalizeRound(row, fixed, currentRoundId, now) {
  need(row && typeof row === 'object', 'ROUND_REQUIRED');
  const id = uint(row.roundId, 'ROUND_ID'); need(id > 0n && id <= currentRoundId, 'ROUND_ID');
  const status = Number(uint(row.status, 'ROUND_STATUS')); need(status <= 6, 'ROUND_STATUS');
  const sold = uint(row.sold, 'ROUND_SOLD'); need(sold <= 10000n, 'ROUND_SOLD');
  const fundingDeadline = uint(row.fundingDeadline, 'ROUND_FUNDING_DEADLINE');
  const claimDeadline = uint(row.refundClaimDeadline, 'ROUND_CLAIM_DEADLINE');
  need(claimDeadline === (fundingDeadline === 0n ? 0n : fundingDeadline + 86400n), 'ROUND_CLAIM_DEADLINE');
  const refunded = uint(row.refundedPrincipal, 'ROUND_REFUNDED');
  const paid = sold * fixed.price; need(refunded <= paid, 'ROUND_REFUNDED');
  need(typeof row.unclaimedPrincipalBurned === 'boolean', 'ROUND_BURN_FLAG');
  const burned = row.unclaimedPrincipalBurned;
  need(!burned || status === 6, 'ROUND_BURN_STATE');
  need(refunded === 0n || status === 6, 'ROUND_REFUND_STATE');
  if (status === 0) need(id === currentRoundId && sold === 0n && fundingDeadline === 0n, 'ROUND_UNSTARTED_STATE');
  else need(fundingDeadline > 0n, 'ROUND_FUNDING_DEADLINE');
  if (status === 1) need(id === currentRoundId && sold < 10000n, 'ROUND_FUNDING_STATE');
  if (status >= 2 && status <= 5) need(id < currentRoundId && sold === 10000n, 'ROUND_FULL_STATE');
  if (status === 6) need(id < currentRoundId && sold < 10000n && now >= fundingDeadline, 'ROUND_REFUND_STATE');
  const requestId = uint(row.requestId, 'ROUND_REQUEST_ID');
  if (status >= 3 && status <= 5) need(requestId > 0n, 'ROUND_REQUEST_ID');
  if (status === 0 || status === 1 || status === 6) need(requestId === 0n, 'ROUND_REQUEST_ID');
  let scheduledDrawAt = 0n;
  if (status === 4) {
    const lockedAt = uint(row.timing?.lockedAt, 'ROUND_DRAW_TIME');
    scheduledDrawAt = uint(row.timing?.scheduledDrawAt, 'ROUND_DRAW_TIME');
    need(lockedAt > 0n && scheduledDrawAt >= lockedAt + 8n && scheduledDrawAt <= lockedAt + 30n, 'ROUND_DRAW_TIME');
  }
  const remainingPrincipal = burned ? 0n : paid - refunded;
  return { id, status, sold, fundingDeadline, claimDeadline, refunded, burned, requestId, scheduledDrawAt,
    remainingPrincipal, liability: status === 5 ? 0n : remainingPrincipal };
}

/** Return snapshot-eligible alternatives. Execute at most ONE after independent
 * simulation/authorization, then fetch and verify a new snapshot before replanning.
 * Profile verification, chain reads, fee checks and all sending remain external.
 */
export function planV2KeeperActions(profile, snapshot) {
  const fixed = validateV2KeeperProfile(profile);
  need(snapshot && equal(snapshot.address, fixed.address) && uint(snapshot.chainId, 'SNAPSHOT_CHAIN') === 56n &&
    equal(snapshot.runtimeCodeHash, fixed.runtimeCodeHash), 'SNAPSHOT_BINDING');
  need(uint(snapshot.blockNumber, 'SNAPSHOT_BLOCK') === fixed.blockNumber && equal(snapshot.blockHash, fixed.blockHash), 'SNAPSHOT_VERIFICATION_BLOCK');
  const now = uint(snapshot.timestamp, 'SNAPSHOT_TIME'), currentRoundId = uint(snapshot.currentRoundId, 'CURRENT_ROUND');
  need(currentRoundId > 0n && typeof snapshot.seriesAuthorized === 'boolean', 'CURRENT_ROUND');
  const nextRoundOpensAt = uint(snapshot.nextRoundOpensAt, 'NEXT_ROUND_TIME');
  need(Array.isArray(snapshot.rounds) && snapshot.rounds.length > 0, 'ROUND_SNAPSHOTS_REQUIRED');
  const rounds = snapshot.rounds.map(row => normalizeRound(row, fixed, currentRoundId, now));
  const byId = new Map(rounds.map(row => [String(row.id), row]));
  need(byId.size === rounds.length && byId.has(String(currentRoundId)), 'ROUND_SNAPSHOT_COVERAGE');
  const liability = uint(snapshot.totalLiability, 'SNAPSHOT_LIABILITY');
  const knownLiability = rounds.reduce((sum, row) => sum + row.liability, 0n);
  need(knownLiability <= liability, 'SNAPSHOT_LIABILITY');
  const historyComplete = snapshot.historyComplete === true;
  if (historyComplete) need(BigInt(rounds.length) === currentRoundId && knownLiability === liability, 'ROUND_SNAPSHOT_COVERAGE');
  const eligible = [], warnings = historyComplete ? [] : ['OLD_ROUND_HISTORY_INCOMPLETE'];
  const add = (action, roundId, reason, amount = null) => {
    need(V2_KEEPER_ACTIONS.includes(action), 'ACTION_FORBIDDEN');
    const args = action === 'openNextRound' ? [] : [String(roundId)];
    eligible.push({ action, roundId: String(roundId), args, reason, to: fixed.address, chainId: 56,
      value: '0', data: V2_KEEPER_CALLS.encodeFunctionData(action, args),
      ...(amount == null ? {} : { amountBaseUnits: String(amount) }), requiresFreshVerificationBeforeSend: true });
  };
  if (!snapshot.seriesAuthorized) warnings.push('SERIES_NOT_AUTHORIZED');
  else {
    for (const row of rounds) {
      if (row.status === 4 && now >= row.scheduledDrawAt) add('settle', row.id, 'VERIFIED_RANDOMNESS_DRAW_DUE');
      if (row.status === 1 && now >= row.fundingDeadline) add('openRefunds', row.id, row.sold === 0n ? 'EMPTY_ROUND_EXPIRED' : 'FUNDING_EXPIRED');
      if ((row.status === 1 || row.status === 6) && row.claimDeadline > 0n && now >= row.claimDeadline &&
        !row.burned && row.remainingPrincipal > 0n) add('burnUnclaimed', row.id, 'FIXED_CLAIM_DEADLINE_EXPIRED', row.remainingPrincipal);
    }
    const current = byId.get(String(currentRoundId)), previous = byId.get(String(currentRoundId - 1n));
    if (current.status === 0 && now >= nextRoundOpensAt) {
      if (currentRoundId === 1n || previous?.status === 5 || previous?.status === 6) add('openNextRound', currentRoundId, 'PREVIOUS_ROUND_RESOLVED_COOLDOWN_COMPLETE');
      else if (!previous) warnings.push('PREVIOUS_ROUND_SNAPSHOT_REQUIRED');
    }
  }
  const priority = { settle: 0, openRefunds: 1, burnUnclaimed: 2, openNextRound: 3 };
  eligible.sort((a, b) => priority[a.action] - priority[b.action] || (BigInt(a.roundId) < BigInt(b.roundId) ? -1 : BigInt(a.roundId) > BigInt(b.roundId) ? 1 : 0));
  return { schemaVersion: 2, mode: 'plan-only', chainId: 56, address: fixed.address, contractName: fixed.contractName,
    blockNumber: String(fixed.blockNumber), blockHash: fixed.blockHash, timestamp: String(now),
    historyComplete, checkedRoundIds: [...byId.keys()], eligible, nextAction: eligible[0] ?? null, warnings,
    mainnetTransactionsSent: 0, signaturesRequested: 0,
    executionNote: 'Planner only. Requires separately configured and verified keeper, fresh chain verification, simulation and fee checks. Never auto-claim participant refunds.' };
}
