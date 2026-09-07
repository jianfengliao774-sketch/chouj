import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ContractFactory, MaxUint256, ZeroAddress, getAddress } from 'ethers';
import { setup, sent, fails, at, events, A, UNIT, GAS, ROOT } from './helpers/bem-own-container-fixture.mjs';

// All dependencies and transactions are Ganache mocks. These tests do not
// establish ownership of the real container or send any mainnet transaction.
const DIR = ROOT + 'outputs/bem-raffle-2075/production-v3/';
const readJson = name => JSON.parse(readFileSync(DIR + name, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const preserved = readJson('preserved-v1-v2.sha256.json');
const artifacts = Object.fromEntries([10, 50, 100].map(pool => [pool, readJson(`BemOwnContainer13061Pool${pool}BSC.artifact.json`)]));
const checks = [];
const DAY = 86400n;
const EXEC_FEE = 200000000000000n;
function guardOldFiles() {
  assert.equal(hash(JSON.stringify(preserved.files)), '5e32b076506d2c447da57116a07d30a04476cc11df8a1b1fa1a3ab0c10a5d299');
  for (const [name, expected] of Object.entries(preserved.files)) assert.equal(hash(readFileSync(ROOT + name)), expected, name);
}
guardOldFiles();
function check(name, body) {
  test(name, async t => {
    const row = { name, passed: false }; checks.push(row);
    try { await body(t, row); row.passed = true; } catch (error) { row.error = error.message; throw error; }
  });
}
test.after(() => {
  guardOldFiles();
  writeFileSync(DIR + 'verification-own-container.json', JSON.stringify({
    status: checks.length === 10 && checks.every(row => row.passed) ? 'passed' : 'incomplete_or_failed', expectedTestCount: 10, executedTestCount: checks.length, checkedAt: new Date().toISOString(),
    contractVersion: 3, scope: 'local_mocks_only', tests: checks,
    preservedDeployedFileCount: Object.keys(preserved.files).length, preservedDeployedTreeSha256: preserved.treeSha256,
    sourceSha256s: artifacts[10].sourceSha256s, unchangedTest1: true, mainnetTransactionsSent: 0,
  }, null, 2) + '\n');
});
async function setupOwn(t, pool = 10) {
  const s = await setup(t, pool);
  // No 2075 container registration or deployer ownership is needed to activate.
  await sent(s.opener.configure(A.circuit, 2075, ZeroAddress, false));
  await sent(s.revenue.setOwnerForTest(s.addresses[4]));
  return s;
}
const activateOwn = (s, owner = s.nextHolder) => s.revenue.connect(owner).execute(s.game.target, 0,
  s.game.interface.encodeFunctionData('authorizeSeries'), 0, { ...GAS, value: EXEC_FEE });
const transfers = (s, receipt) => events(s.token, receipt, 'Transfer').map(e => [e.from, e.to, e.amount]);

check('V3 artifacts preserve deployed V1/V2 bytes and fixed formal bindings, exposing partial-fill gameplay', async () => {
  const old = readFileSync(ROOT + 'contracts/production-v2/BemContainer13061SeriesBSC.sol', 'utf8').replaceAll('\r\n', '\n');
  const next = readFileSync(ROOT + 'contracts/production-v3/BemOwnContainer13061SeriesBSC.sol', 'utf8').replaceAll('\r\n', '\n');
  // Activation and all subsequent timing hooks are identical; only the fixed
  // immutable identities set by the constructor differ.
  const tail = value => value.slice(value.indexOf('    function authorizeSeries()'));
  assert.equal(tail(next), tail(old).replaceAll('ISeries13061Container', 'IOwnSeries13061Container'));
  assert.match(next, /import "\.\/BemSelectableRaffle13061V3BSC\.sol"/);
  assert.equal(new Set(Object.values(artifacts).map(a => a.bytecode)).size, 3);
  for (const [denomination, a] of Object.entries(artifacts)) {
    assert.equal(a.contractVersion, 3); assert.equal(a.testOnly, false);
    assert.equal(a.fixedRules.partialFill, true);
    assert.ok(a.abi.find(item => item.name === 'PurchaseResult' && item.type === 'event'));
    assert.ok(a.abi.find(item => item.name === 'PARTIAL_FILL' && item.type === 'function'));
    assert.deepEqual(a.abi.find(item => item.type === 'constructor').inputs.map(item => item.type), ['uint256', 'uint16', 'uint32']);
    assert.equal(a.fixedBindings.authorizationContainer, A.revenue);
    assert.equal(a.fixedBindings.authorizationNft, A.revenueNft);
    assert.equal(a.fixedBindings.authorizationTokenId, 13061);
    assert.equal(a.fixedBindings.processor, A.circuit); assert.equal(a.fixedBindings.processorId, 2075);
    assert.equal(a.fixedRules.poolBaseUnits, String(BigInt(denomination) * UNIT));
    assert.equal(a.fixedRules.ticketPriceBaseUnits, String(BigInt(denomination) * 10000n));
    assert.equal(a.runtimeBytecodeBytes <= 24576, true);
    for (const [name, expected] of Object.entries(a.sourceSha256s)) assert.equal(hash(readFileSync(ROOT + name)), expected);
  }
  const test1 = JSON.parse(readFileSync(ROOT + 'outputs/bem-raffle-2075/production-v2/Bem2075Raffle13061Test1BSC.artifact.json', 'utf8'));
  assert.equal(test1.fixedBindings.authorizationContainer, A.activation);
  assert.equal(test1.fixedRules.poolBaseUnits, String(UNIT));
});

for (const pool of [10, 50, 100]) check(`${pool} BEM formal: only 13061 may activate once, independently of the 2075 container or deployer`, async t => {
  const s = await setupOwn(t, pool), g = s.game;
  assert.equal(await g.organizer(), A.revenue); assert.equal(await g.CONTAINER(), A.revenue);
  assert.equal(await g.AUTHORIZATION_NFT(), A.revenueNft); assert.equal(await g.AUTHORIZATION_TOKEN_ID(), 13061n);
  assert.equal(await g.CIRCUITS(), A.circuit); assert.equal(await g.CIRCUIT_ID(), 2075n);
  assert.equal(await g.REVENUE_CONTAINER(), A.revenue); assert.equal(await g.REVENUE_NFT(), A.revenueNft);
  assert.equal(await g.REVENUE_TOKEN_ID(), 13061n); assert.equal(await g.TEST_ONLY(), false);
  assert.equal(await g.ROUND_POOL(), s.pool); assert.equal(await g.TICKET_PRICE(), s.price);
  assert.equal(await g.BLACKHOLE_AMOUNT(), s.pool * 4n / 100n);
  assert.equal(await g.ORGANIZER_AMOUNT(), s.pool / 100n); assert.equal(await g.WINNER_AMOUNT(), s.pool * 95n / 100n);
  assert.equal(await g.TICKETS_PER_ROUND(), 10000n); assert.equal(await g.MAX_TICKETS_PER_PURCHASE(), 1000n);
  assert.equal(await g.MAX_TICKETS_PER_ADDRESS(), 5000n); assert.equal(await g.fundingWindow(), DAY);
  assert.equal(await g.PARTIAL_FILL(), true); assert.equal(await g.REFUND_CLAIM_WINDOW(), DAY); assert.equal(await g.NEXT_ROUND_DELAY(), 60n);
  for (const name of ['setOrganizer', 'setContainer', 'setFundingWindow', 'withdraw', 'reroll', 'upgradeTo']) assert.equal(g.interface.getFunction(name), null);
  const deployment = await g.deploymentTransaction().wait();
  for (const name of ['ContainerBindingFixed', 'RevenueBindingFixed']) {
    assert.deepEqual(Array.from(events(g, deployment, name)[0]), [A.revenue, A.revenueNft, 13061n]);
  }
  await fails(g.authorizeSeries(GAS)); await fails(g.connect(s.nextHolder).authorizeSeries(GAS));
  await fails(activateOwn(s, s.admin));
  await fails(s.activation.execute(g.target, 0, g.interface.encodeFunctionData('authorizeSeries'), 0, { ...GAS, value: EXEC_FEE }));
  await fails(g.connect(s.alice).buy(1, 1, GAS));
  assert.equal(await g.seriesAuthorized(), false);
  await sent(s.opener.configure(A.revenueNft, 13061, A.revenue, false)); await fails(activateOwn(s));
  await sent(s.opener.configure(A.revenueNft, 13061, A.revenue, true));
  await sent(s.revenue.configure(s.addresses[4], 56, A.circuit, 2075)); await fails(activateOwn(s));
  await sent(s.revenue.configure(s.addresses[4], 56, A.revenueNft, 13061));
  const receipt = await sent(activateOwn(s));
  assert.deepEqual(Array.from(events(g, receipt, 'ContainerSeriesAuthorized')[0]), [A.revenue]);
  assert.equal(await g.seriesAuthorized(), true); assert.equal((await g.rounds(1)).status, 1n);
  assert.equal((await g.rounds(1)).fundingDeadline, BigInt((await s.provider.getBlock(receipt.blockNumber)).timestamp) + DAY);
  await fails(activateOwn(s));
});

check('V3 deployment rejects wrong, unopened and incorrectly bound 13061 containers', async t => {
  const s = await setupOwn(t);
  const rejectDeploy = () => assert.rejects(async () => { const game = await s.factory.deploy(...s.args, GAS); await game.waitForDeployment(); });
  await sent(s.opener.configure(A.revenueNft, 13061, A.activation, true)); await rejectDeploy();
  await sent(s.opener.configure(A.revenueNft, 13061, A.revenue, false)); await rejectDeploy();
  await sent(s.opener.configure(A.revenueNft, 13061, A.revenue, true));
  for (const [chain, nft, id] of [[97, A.revenueNft, 13061], [56, A.circuit, 13061], [56, A.revenueNft, 2075]]) {
    await sent(s.revenue.configure(s.addresses[4], chain, nft, id)); await rejectDeploy();
  }
});

check('10 BEM V3 preserves address limits, auto replacement, VRF atomicity, 2075 computation and exact 4/1/95 distribution', async (t, row) => {
  const s = await setupOwn(t), g = s.game; await sent(activateOwn(s));
  await fails(g.connect(s.alice).buy(1, 1001, GAS));
  await fails(g.connect(s.alice).buySelected(1, Array.from({ length: 1001 }, (_, i) => i), GAS));
  await sent(g.connect(s.alice).buySelected(1, [0, 5365, 9999], GAS));
  // An already sold selection keeps the requested count and advances to a free ticket.
  await sent(g.connect(s.bob).buySelected(1, [0, 2], GAS));
  assert.equal(await g.ticketOwner(1, 1), s.addresses[2]); assert.equal(await g.ticketOwner(1, 2), s.addresses[2]);
  for (let left = 4997; left > 0; left -= 1000) await sent(g.connect(s.alice).buy(1, Math.min(1000, left), GAS));
  assert.equal(await g.ticketsOf(1, s.addresses[1]), 5000n);
  const before = { liability: await g.totalLiability(), balance: await s.token.balanceOf(s.addresses[1]), word: (await g.ticketWords(1, 400, 1))[0] };
  for (const selected of [false, true]) {
    const receipt = await sent(selected ? g.connect(s.alice).buySelected(1, [7000], GAS) : g.connect(s.alice).buy(1, 1, GAS));
    assert.deepEqual(Array.from(events(g, receipt, 'PurchaseResult')[0]), [1n, s.addresses[1], 1n, 0n, 0n, s.price]);
    assert.equal(events(g, receipt, 'TicketsPurchased').length, 0); assert.deepEqual(transfers(s, receipt), []);
  }
  assert.equal(await g.totalLiability(), before.liability); assert.equal(await s.token.balanceOf(s.addresses[1]), before.balance);
  assert.equal((await g.ticketWords(1, 400, 1))[0], before.word);
  for (let i = 0; i < 4; i++) await sent(g.connect(s.bob).buy(1, 1000, GAS));
  // Force the local coordinator's request counter to overflow. A failure in
  // the final purchase must roll back ownership, payment and the lock together.
  await sent(s.coordinator.setNextRequestId(MaxUint256));
  const preLock = { liability: await g.totalLiability(), sold: (await g.rounds(1)).sold, balance: await s.token.balanceOf(s.addresses[2]) };
  await fails(g.connect(s.bob).buy(1, 998, GAS));
  assert.equal(await g.totalLiability(), preLock.liability); assert.equal((await g.rounds(1)).sold, preLock.sold);
  assert.equal((await g.rounds(1)).status, 1n); assert.equal(await s.token.balanceOf(s.addresses[2]), preLock.balance);
  assert.equal(await s.coordinator.requestCount(), 0n);
  await sent(s.coordinator.setNextRequestId(1));
  const lock = await sent(g.connect(s.bob).buy(1, 998, GAS));
  assert.equal(await g.ticketsOf(1, s.addresses[2]), 5000n); assert.equal((await g.rounds(1)).sold, 10000n);
  assert.equal((await g.rounds(1)).status, 3n); assert.equal(await g.totalLiability(), s.pool);
  assert.equal(await s.coordinator.requestCount(), 1n); assert.equal(await s.coordinator.lastSubId(), s.args[0]);
  assert.equal(await s.coordinator.lastConfirmations(), 3n); assert.equal(await s.coordinator.lastCallbackGasLimit(), 150000n);
  assert.equal(await g.ticketOwner(1, 9999), s.addresses[1]);
  // Rejected 16-bit candidates are still rejected before the fixed 2075 evaluation.
  const rejected = await g.previewAttempt(234n | (96n << 12n), 0, 0);
  assert.equal(rejected.candidate, 60000n); assert.equal(rejected.accepted, false);
  await sent(s.coordinator.fulfillWithGas(g.target, 1, [39n | (15n << 12n), 123n], 150000, { gasLimit: 500000 }));
  await at(s, (await g.drawTiming(1)).scheduledDrawAt);
  await sent(s.circuit.setEvalMode(1)); await fails(g.settle(1, GAS));
  assert.equal(await g.totalLiability(), s.pool); await sent(s.circuit.setEvalMode(0));
  await sent(s.token.setFailure(A.revenue, 1)); await fails(g.settle(1, GAS));
  assert.equal(await s.token.balanceOf(A.dead), 0n); assert.equal((await g.rounds(1)).winner, ZeroAddress);
  await sent(s.token.setFailure(A.revenue, 0));
  const settlement = await sent(g.connect(s.keeper).settle(1, GAS));
  assert.deepEqual(transfers(s, settlement), [[getAddress(g.target), A.dead, s.pool * 4n / 100n],
    [getAddress(g.target), A.revenue, s.pool / 100n], [getAddress(g.target), s.addresses[1], s.pool * 95n / 100n]]);
  assert.equal((await g.rounds(1)).winningTicket, 9999n); assert.equal((await g.rounds(1)).winner, s.addresses[1]);
  assert.equal(await s.token.balanceOf(g.target), 0n); assert.equal(await g.totalLiability(), 0n);
  assert.equal(await s.token.balanceOf(A.activation), 0n);
  await at(s, (await g.rounds(1)).fundingDeadline + DAY);
  await fails(g.openRefunds(1, GAS)); await fails(g.burnUnclaimed(1, GAS));
  await fails(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  await sent(g.openNextRound(GAS)); await sent(g.connect(s.alice).buy(2, 1, GAS));
  assert.equal(await g.ticketsOf(2, s.addresses[1]), 1n);
  row.finalPurchaseGas = String(lock.gasUsed); row.settlementGas = String(settlement.gasUsed);
});

check('10 BEM V3 keeps fixed 24h self-claim and 48h unclaimed burn boundaries, protecting the next round', async (t, row) => {
  const s = await setupOwn(t), g = s.game; await sent(activateOwn(s));
  const original = await s.token.balanceOf(s.addresses[1]);
  await sent(g.connect(s.alice).buy(1, 10, GAS)); await sent(g.connect(s.bob).buy(1, 20, GAS));
  const deadline = (await g.rounds(1)).fundingDeadline;
  assert.equal(await g.refundClaimDeadline(1), deadline + DAY);
  await at(s, deadline - 1n); await fails(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  await at(s, deadline);
  const beforeGas = await s.provider.getBalance(s.addresses[1]);
  const refund = await sent(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  assert.equal(await s.provider.getBalance(s.addresses[1]), beforeGas - refund.fee);
  assert.equal(await s.token.balanceOf(s.addresses[1]), original);
  assert.deepEqual(transfers(s, refund), [[getAddress(g.target), s.addresses[1], s.price * 10n]]);
  await fails(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  await at(s, deadline + 60n); await sent(g.openNextRound(GAS));
  await sent(g.connect(s.alice).buy(2, 5, GAS));
  await at(s, deadline + DAY - 1n); await fails(g.burnUnclaimed(1, GAS));
  await at(s, deadline + DAY); await fails(g.connect(s.bob).refund(1, s.addresses[2], GAS));
  const burn = await sent(g.connect(s.keeper).burnUnclaimed(1, GAS));
  assert.deepEqual(Array.from(events(g, burn, 'UnclaimedPrincipalBurned')[0]), [1n, s.price * 20n]);
  assert.deepEqual(transfers(s, burn), [[getAddress(g.target), A.dead, s.price * 20n]]);
  assert.equal(await g.totalLiability(), s.price * 5n); assert.equal(await s.token.balanceOf(g.target), s.price * 5n);
  assert.equal((await g.rounds(2)).status, 1n); assert.equal(await g.ticketsOf(2, s.addresses[1]), 5n);
  assert.equal(await s.token.balanceOf(A.revenue), 0n); assert.equal(await s.token.balanceOf(A.activation), 0n);
  await fails(g.burnUnclaimed(1, GAS));
  row.refundBaseUnits = String(s.price * 10n); row.unclaimedBurnBaseUnits = String(s.price * 20n);
});

function assertPurchase(s, receipt, requested, filled, buyer = s.addresses[2], roundId = 1n) {
  assert.deepEqual(events(s.game, receipt, 'PurchaseResult').map(args => Array.from(args)),
    [[roundId, buyer, BigInt(requested), BigInt(filled), BigInt(filled) * s.price, BigInt(requested - filled) * s.price]]);
  const tickets = events(s.game, receipt, 'TicketsPurchased');
  assert.equal(tickets.reduce((n, event) => n + event.endExclusive - event.firstTicket, 0n), BigInt(filled));
  assert.equal(tickets.reduce((n, event) => n + event.paid, 0n), BigInt(filled) * s.price);
  if (!filled) assert.deepEqual(transfers(s, receipt), []);
}

for (const selected of [false, true]) check(`Partial ${selected ? 'selected' : 'automatic'} order: 1000 requested / 800 left charges only 800 and preserves zero-fill races`, async (t, row) => {
  const s = await setupOwn(t), g = s.game; await sent(activateOwn(s));
  for (let i = 0; i < 5; i++) await sent(g.connect(s.alice).buy(1, 1000, GAS));
  for (let i = 0; i < 4; i++) await sent(g.connect(s.bob).buy(1, 1000, GAS));
  await sent(g.connect(s.bob).buy(1, 200, GAS));
  assert.equal((await g.rounds(1)).sold, 9200n);
  const balance = await s.token.balanceOf(s.addresses[2]);
  // Allow only the actual debit: requesting 1000 must not require allowance for 1000.
  await sent(s.token.connect(s.bob).approve(g.target, s.price * 800n));
  const order = () => selected ? g.connect(s.bob).buySelected(1, Array.from({ length: 1000 }, (_, i) => i), GAS) : g.connect(s.bob).buy(1, 1000, GAS);
  // Both invalid tails would fall outside the filled prefix, but must still revert.
  if (selected) {
    const duplicateTail = Array.from({ length: 1000 }, (_, i) => i); duplicateTail[999] = 998;
    const outOfRangeTail = Array.from({ length: 1000 }, (_, i) => i); outOfRangeTail[999] = 10000;
    await fails(g.connect(s.bob).buySelected(1, duplicateTail, GAS));
    await fails(g.connect(s.bob).buySelected(1, outOfRangeTail, GAS));
  }
  await sent(s.coordinator.setNextRequestId(MaxUint256));
  await fails(order());
  assert.equal((await g.rounds(1)).sold, 9200n); assert.equal(await g.currentRoundId(), 1n);
  assert.equal(await s.token.balanceOf(s.addresses[2]), balance); assert.equal(await g.totalLiability(), 9200n * s.price);
  assert.equal(await g.ticketOwner(1, 9200), ZeroAddress); assert.equal(await s.coordinator.requestCount(), 0n);
  assert.equal(await s.token.allowance(s.addresses[2], g.target), s.price * 800n);
  await sent(s.coordinator.setNextRequestId(1));
  const receipt = await sent(order()); assertPurchase(s, receipt, 1000, 800);
  assert.equal(await s.token.balanceOf(s.addresses[2]), balance - 800n * s.price);
  assert.equal(await s.token.allowance(s.addresses[2], g.target), 0n);
  assert.deepEqual(transfers(s, receipt), [[s.addresses[2], getAddress(g.target), 800n * s.price]]);
  assert.equal((await g.rounds(1)).sold, 10000n); assert.equal(await g.ticketsOf(1, s.addresses[2]), 5000n);
  assert.equal(await g.totalLiability(), s.pool); assert.equal(await s.token.balanceOf(g.target), s.pool);
  assert.equal(await g.currentRoundId(), 2n); assert.equal(await s.coordinator.requestCount(), 1n);
  assert.equal(await g.ticketOwner(1, 9200), s.addresses[2]); assert.equal(await g.ticketOwner(1, 9999), s.addresses[2]);
  // The submitted order still names round 1. It succeeds with zero even though
  // VRF is pending, without approval, tokens, new owner IDs or any round 2 write.
  const zero = await sent(order()); assertPurchase(s, zero, 1000, 0);
  assert.equal(await g.totalLiability(), s.pool); assert.equal(await s.coordinator.requestCount(), 1n);
  assert.equal((await g.rounds(2)).sold, 0n); assert.equal(await g.ticketsOf(2, s.addresses[2]), 0n);
  await fails(g.connect(s.bob).buy(0, 1, GAS)); await fails(g.connect(s.bob).buy(3, 1, GAS));
  await fails(g.connect(s.bob).buy(1, 0, GAS)); await fails(g.connect(s.bob).buy(1, 1001, GAS));
  await fails(g.connect(s.bob).buySelected(1, [0, 0], GAS));
  await fails(g.connect(s.bob).buySelected(1, [0, 10000], GAS));
  await sent(s.coordinator.fulfillWithGas(g.target, 1, [39n | (15n << 12n), 123n], 150000, { gasLimit: 500000 }));
  await at(s, (await g.drawTiming(1)).scheduledDrawAt); await sent(g.settle(1, GAS));
  await at(s, await g.nextRoundOpensAt()); await sent(g.openNextRound(GAS));
  const laterZero = await sent(order()); assertPurchase(s, laterZero, 1000, 0);
  assert.equal((await g.rounds(2)).sold, 0n); assert.equal(await g.totalLiability(), 0n);
  row.requested = 1000; row.filled = 800; row.unspentBaseUnits = String(200n * s.price); row.partialFillGas = String(receipt.gasUsed);
});

check('Address quota partial fill charges actual tickets and self-refunds only paid principal; expired and nonfull old rounds still reject', async (t, row) => {
  const s = await setupOwn(t), g = s.game; await sent(activateOwn(s));
  const balance = await s.token.balanceOf(s.addresses[1]);
  for (let i = 0; i < 4; i++) await sent(g.connect(s.alice).buy(1, 1000, GAS));
  await sent(g.connect(s.alice).buy(1, 800, GAS));
  await sent(s.token.connect(s.alice).approve(g.target, 200n * s.price));
  const receipt = await sent(g.connect(s.alice).buySelected(1, Array.from({ length: 1000 }, (_, i) => 9000 + i), GAS));
  assertPurchase(s, receipt, 1000, 200, s.addresses[1]);
  assert.equal(await g.ticketOwner(1, 9000), s.addresses[1]); assert.equal(await g.ticketOwner(1, 9199), s.addresses[1]);
  assert.equal(await g.ticketOwner(1, 9200), ZeroAddress); assert.equal((await g.rounds(1)).sold, 5000n);
  assert.equal(await g.ticketsOf(1, s.addresses[1]), 5000n);
  assert.equal(await s.token.balanceOf(s.addresses[1]), balance - 5000n * s.price);
  const zero = await sent(g.connect(s.alice).buy(1, 1000, GAS)); assertPurchase(s, zero, 1000, 0, s.addresses[1]);
  assert.equal(await g.totalLiability(), 5000n * s.price); assert.equal(await s.coordinator.requestCount(), 0n);
  const deadline = (await g.rounds(1)).fundingDeadline; await at(s, deadline);
  await fails(g.connect(s.alice).buy(1, 1, GAS)); await fails(g.connect(s.bob).buy(1, 1000, GAS));
  const refund = await sent(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  assert.deepEqual(transfers(s, refund), [[getAddress(g.target), s.addresses[1], 5000n * s.price]]);
  assert.equal(await s.token.balanceOf(s.addresses[1]), balance); assert.equal(await g.totalLiability(), 0n);
  await at(s, await g.nextRoundOpensAt()); await sent(g.openNextRound(GAS));
  await fails(g.connect(s.alice).buy(1, 1, GAS)); await fails(g.connect(s.alice).buySelected(1, [0], GAS));
  assert.equal((await g.rounds(2)).sold, 0n); assert.equal(await s.token.balanceOf(g.target), 0n);
  row.paidRefundedBaseUnits = String(5000n * s.price); row.unspentLastOrderBaseUnits = String(800n * s.price);
});
