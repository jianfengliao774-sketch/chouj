import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { setup, sent, fails, at, activate, events, A, UNIT, GAS } from './helpers/bem-container-v2-fixture.mjs';

// Independent lifecycle review. Every dependency is a local mock; these tests
// never use public RPC endpoints, wallet secrets, or mainnet transactions.
const PRICE = 1_000_000n;
const DAY = 86_400n;
const GAS_CAP = 16_777_216n;
const transfers = (s, receipt) => events(s.token, receipt, 'Transfer').map(e => [e.from, e.to, e.amount]);

test('v2: both purchase entry points share a 5,000-ticket address limit; a closed-round refund cannot bypass it', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s));
  assert.equal(await g.MAX_TICKETS_PER_PURCHASE(), 1000n);
  await fails(g.connect(s.alice).buy(1, 1001, GAS));
  await fails(g.connect(s.alice).buySelected(1, Array.from({ length: 1001 }, (_, i) => i), GAS));
  for (let i = 0; i < 4; i++) await sent(g.connect(s.alice).buy(1, 1000, GAS));
  await sent(g.connect(s.alice).buySelected(1, Array.from({ length: 1000 }, (_, i) => 9000 + i), GAS));
  assert.equal(await g.ticketsOf(1, s.addresses[1]), 5000n);
  assert.equal((await g.rounds(1)).sold, 5000n);
  const liability = await g.totalLiability();
  await fails(g.connect(s.alice).buy(1, 1, GAS));
  await fails(g.connect(s.alice).buySelected(1, [5000], GAS));
  assert.equal(await g.totalLiability(), liability);
  await sent(g.connect(s.bob).buySelected(1, [5000], GAS));
  assert.equal(await g.ticketOwner(1, 5000), s.addresses[2]);
  const deadline = (await g.rounds(1)).fundingDeadline;
  await at(s, deadline);
  await sent(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  assert.equal(await g.ticketsOf(1, s.addresses[1]), 0n);
  await fails(g.connect(s.alice).buySelected(1, [5001], GAS));
  await fails(g.connect(s.alice).buy(2, 1, GAS));
  await at(s, deadline + 60n);
  await sent(g.openNextRound(GAS));
  await sent(g.connect(s.alice).buy(2, 1, GAS));
  assert.equal(await g.ticketsOf(2, s.addresses[1]), 1n);
});

test('v2: the fixed 24h claim boundary burns only unclaimed principal, preserving the next round and donated tokens', async t => {
  const s = await setup(t, 100), g = s.game;
  const participant = s.addresses[3];
  await sent(s.token.mint(participant, 20n * UNIT));
  await sent(s.token.connect(s.keeper).approve(g.target, 20n * UNIT));
  const activation = await sent(activate(s));
  const deadline = (await g.rounds(1)).fundingDeadline;
  assert.equal(deadline, BigInt((await s.provider.getBlock(activation.blockNumber)).timestamp) + DAY);
  await sent(g.connect(s.alice).buy(1, 500, GAS));
  await sent(g.connect(s.bob).buy(1, 300, GAS));
  await sent(g.connect(s.keeper).buy(1, 200, GAS));
  await at(s, deadline - 1n);
  await fails(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  await fails(g.burnUnclaimed(1, GAS));
  await at(s, deadline);
  await fails(g.connect(s.alice).buy(1, 1, GAS));
  const aliceRefund = await sent(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  assert.deepEqual(transfers(s, aliceRefund), [[getAddress(g.target), s.addresses[1], 5n * UNIT]]);
  assert.equal(await g.totalLiability(), 5n * UNIT);
  await fails(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  const nextOpening = await g.nextRoundOpensAt();
  assert.equal(nextOpening, deadline + 60n);
  await at(s, nextOpening);
  await sent(g.openNextRound(GAS));
  await sent(g.connect(s.alice).buy(2, 20, GAS));
  await sent(s.token.mint(g.target, 7n * UNIT));
  const nextPrincipal = 20n * PRICE;
  await at(s, deadline + DAY - 1n);
  await fails(g.burnUnclaimed(1, GAS));
  const bobRefund = await sent(g.connect(s.bob).refund(1, s.addresses[2], GAS));
  assert.deepEqual(transfers(s, bobRefund), [[getAddress(g.target), s.addresses[2], 3n * UNIT]]);
  await at(s, deadline + DAY);
  await fails(g.connect(s.keeper).refund(1, participant, GAS));
  // Reopening an already-refunding round cannot restart its clock or the next round.
  await sent(g.openRefunds(1, GAS));
  assert.equal(await g.nextRoundOpensAt(), nextOpening);
  const deadBefore = await s.token.balanceOf(A.dead), supplyBefore = await s.token.totalSupply();
  await sent(s.token.setFailure(A.dead, 1));
  await fails(g.burnUnclaimed(1, GAS));
  assert.equal(await g.totalLiability(), 2n * UNIT + nextPrincipal);
  assert.equal(await s.token.balanceOf(A.dead), deadBefore);
  await sent(s.token.setFailure(A.dead, 0));
  const burn = await sent(g.connect(s.bob).burnUnclaimed(1, GAS));
  assert.deepEqual(Array.from(events(g, burn, 'UnclaimedPrincipalBurned')[0]), [1n, 2n * UNIT]);
  assert.equal(await g.refundedPrincipal(1), 8n * UNIT);
  assert.equal(await g.unclaimedPrincipalBurned(1), true);
  assert.deepEqual(transfers(s, burn), [[getAddress(g.target), A.dead, 2n * UNIT]]);
  assert.equal(await g.totalLiability(), nextPrincipal);
  assert.equal(await s.token.balanceOf(g.target), 7n * UNIT + nextPrincipal);
  assert.equal(await s.token.totalSupply(), supplyBefore);
  assert.equal(await g.ticketsOf(2, s.addresses[1]), 20n);
  assert.equal((await g.rounds(2)).status, 1n);
  assert.equal(await g.nextRoundOpensAt(), nextOpening);
  assert.equal(await s.token.balanceOf(A.revenue), 0n);
  assert.equal(await s.token.balanceOf(A.activation), 0n);
  const balanceAfter = await s.token.balanceOf(g.target);
  try { const again = await sent(g.burnUnclaimed(1, GAS)); assert.deepEqual(transfers(s, again), []); }
  catch (error) { assert.equal(error.receipt?.status, 0); }
  assert.equal(await s.token.balanceOf(g.target), balanceAfter);
  assert.equal(await g.totalLiability(), nextPrincipal);
  await fails(g.connect(s.keeper).refund(1, participant, GAS));
});

test('v2: fully refunded and empty rounds never emit a zero-value unclaimed-principal burn', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s));
  await sent(g.connect(s.alice).buy(1, 10, GAS));
  const deadline = (await g.rounds(1)).fundingDeadline;
  assert.equal(await g.refundClaimDeadline(1), deadline + DAY);
  await at(s, deadline);
  await sent(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  await at(s, deadline + DAY);
  await fails(g.burnUnclaimed(1, GAS));
  assert.equal(await g.unclaimedPrincipalBurned(1), false);
  assert.equal(await g.totalLiability(), 0n);
  await sent(g.openNextRound(GAS));
  const emptyDeadline = (await g.rounds(2)).fundingDeadline;
  await at(s, emptyDeadline + DAY);
  await sent(g.openRefunds(2, GAS));
  await fails(g.burnUnclaimed(2, GAS));
  assert.equal(await g.unclaimedPrincipalBurned(2), false);
  assert.equal(await s.token.balanceOf(A.dead), 0n);
  assert.equal(await g.totalLiability(), 0n);
});

test('v2: opening refunds late never extends the fixed claim window, and anyone may clear the expired round', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s));
  await sent(g.connect(s.alice).buy(1, 123, GAS));
  const deadline = (await g.rounds(1)).fundingDeadline;
  await at(s, deadline + DAY);
  await fails(g.connect(s.alice).refund(1, s.addresses[1], GAS));
  const receipt = await sent(g.connect(s.keeper).burnUnclaimed(1, GAS));
  assert.deepEqual(transfers(s, receipt), [[getAddress(g.target), A.dead, 123n * PRICE]]);
  assert.equal(await g.totalLiability(), 0n);
  assert.equal(await s.token.balanceOf(g.target), 0n);
  assert.equal(await g.currentRoundId(), 2n);
  assert.equal(await s.coordinator.requestCount(), 0n);
  await fails(g.connect(s.alice).refund(1, s.addresses[1], GAS));
});

test('v2: requested, ready and settled draws cannot be refunded or swept after 48 hours', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s));
  for (const signer of [s.alice, s.bob]) for (let i = 0; i < 5; i++) await sent(g.connect(signer).buy(1, 1000, GAS));
  assert.equal((await g.rounds(1)).status, 3n);
  await at(s, (await g.rounds(1)).fundingDeadline + DAY);
  const cannotExpire = async () => {
    await fails(g.openRefunds(1, GAS));
    await fails(g.connect(s.alice).refund(1, s.addresses[1], GAS));
    await fails(g.burnUnclaimed(1, GAS));
  };
  await cannotExpire();
  assert.equal(await g.totalLiability(), 100n * UNIT);
  await sent(s.coordinator.fulfillWithGas(g.target, 1, [0n, 123n], 150000, { gasLimit: 500000 }));
  assert.equal((await g.rounds(1)).status, 4n);
  await cannotExpire();
  const receipt = await sent(g.connect(s.keeper).settle(1, GAS));
  assert.deepEqual(transfers(s, receipt), [
    [getAddress(g.target), A.dead, 4n * UNIT],
    [getAddress(g.target), A.revenue, UNIT],
    [getAddress(g.target), s.addresses[1], 95n * UNIT],
  ]);
  assert.equal((await g.rounds(1)).status, 5n);
  assert.equal(await g.totalLiability(), 0n);
  await cannotExpire();
});

test('v2: measure 1,000 isolated tickets in all 625 fresh words and prove an over-cap transaction cannot buy', async t => {
  // A higher local block limit is used only to measure the complete operation.
  // The first attempted transaction still uses the real BSC per-transaction cap.
  const s = await setup(t, 100, { blockGasLimit: 30_000_000 }), g = s.game;
  await sent(activate(s));
  const selected = [
    ...Array.from({ length: 625 }, (_, i) => i * 16),
    ...Array.from({ length: 375 }, (_, i) => i * 16 + 8),
  ].sort((a, b) => a - b);
  assert.equal(selected.length, 1000);
  assert.equal(new Set(selected.map(ticket => ticket >> 4)).size, 625);
  assert.ok(selected.every((ticket, i) => i === 0 || ticket > selected[i - 1] + 1));
  const estimate = await g.connect(s.alice).buySelected.estimateGas(1, selected);
  if (estimate > GAS_CAP) {
    await fails(g.connect(s.alice).buySelected(1, selected, GAS));
    assert.equal(await g.ticketsOf(1, s.addresses[1]), 0n);
    assert.equal(await g.totalLiability(), 0n);
  }
  const receipt = await sent(g.connect(s.alice).buySelected(1, selected, { gasLimit: 30_000_000 }));
  assert.ok(receipt.gasUsed > 0n && receipt.gasUsed <= estimate);
  assert.equal(await g.ticketsOf(1, s.addresses[1]), 1000n);
  assert.equal(await g.totalLiability(), 1000n * PRICE);
  t.diagnostic(`1,000 isolated tickets / 625 fresh words: ${receipt.gasUsed} actual gas, ${estimate} estimated (cap ${GAS_CAP}); over-cap selection must be rejected by the frontend, never sent or silently split.`);
});
