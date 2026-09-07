import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { setup, sent, fails, activate, events, UNIT, GAS, GAS_CAP } from './helpers/bem-container-v2-fixture.mjs';

// Independent expectations for the final allocation. Deliberately simple and
// separate from the contract's cached two-phase implementation.
function expectedReplacement(occupied, requested) {
  const taken = new Set(occupied), allocated = [];
  for (const wanted of requested) {
    let actual = wanted, scanned = 0;
    while (taken.has(actual) && scanned < 10000) { actual = (actual + 1) % 10000; scanned++; }
    assert.ok(scanned < 10000, 'Reference allocation has insufficient tickets');
    taken.add(actual); allocated.push(actual);
  }
  return allocated.sort((a, b) => a - b);
}

function purchased(s, receipt, buyer) {
  const rows = events(s.game, receipt, 'TicketsPurchased');
  const tickets = [];
  for (const row of rows) {
    assert.equal(row.roundId, 1n); assert.equal(row.buyer, buyer);
    assert.ok(row.firstTicket >= 0n && row.endExclusive <= 10000n && row.firstTicket < row.endExclusive);
    assert.equal(row.paid, (row.endExclusive - row.firstTicket) * s.price);
    for (let ticket = Number(row.firstTicket); ticket < Number(row.endExclusive); ticket++) tickets.push(ticket);
  }
  assert.equal(new Set(tickets).size, tickets.length, 'Purchase events overlap or allocate a ticket twice');
  return tickets.sort((a, b) => a - b);
}
async function fundKeeper(s) {
  await sent(s.token.mint(s.addresses[3], 20n * UNIT));
  await sent(s.token.connect(s.keeper).approve(s.game.target, 20n * UNIT));
}

test('replacement: preserve available requests and replace sold requests without duplicates, including wrapping past 9999', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s));
  const occupied = [0, 2, 4, 9998, 9999], requested = [0, 1, 2, 3, 4, 9998, 9999];
  await sent(g.connect(s.alice).buySelected(1, occupied, GAS));
  const before = await s.token.balanceOf(s.addresses[2]);
  const receipt = await sent(g.connect(s.bob).buySelected(1, requested, GAS));
  const actual = purchased(s, receipt, s.addresses[2]);
  assert.deepEqual(actual, expectedReplacement(occupied, requested));
  assert.deepEqual(actual, [1, 3, 5, 6, 7, 8, 9]);
  for (const ticket of actual) assert.equal(await g.ticketOwner(1, ticket), s.addresses[2]);
  for (const ticket of occupied) assert.equal(await g.ticketOwner(1, ticket), s.addresses[1]);
  assert.equal(await s.token.balanceOf(s.addresses[2]), before - BigInt(requested.length) * s.price);
  assert.equal(await g.ticketsOf(1, s.addresses[2]), BigInt(requested.length));
  assert.equal(await g.totalLiability(), BigInt(occupied.length + requested.length) * s.price);
});

test('replacement: event ranges describe both sides of a wrap and preserve an unsold final ticket', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s));
  await sent(g.connect(s.alice).buySelected(1, [9999], GAS));
  const receipt = await sent(g.connect(s.bob).buySelected(1, [9998, 9999], GAS));
  assert.deepEqual(purchased(s, receipt, s.addresses[2]), [0, 9998]);
  assert.equal(await g.ticketOwner(1, 9999), s.addresses[1]);
  assert.equal(await g.ticketOwner(1, 9998), s.addresses[2]);
  assert.equal(await g.ticketOwner(1, 0), s.addresses[2]);
});

test('replacement: another buyer taking requested numbers after gas estimation is resolved at execution for the same price', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s));
  const requested = [10, 11, 12];
  assert.ok(await g.connect(s.alice).buySelected.estimateGas(1, requested) > 0n);
  await sent(g.connect(s.bob).buySelected(1, requested, GAS));
  const before = await s.token.balanceOf(s.addresses[1]);
  const receipt = await sent(g.connect(s.alice).buySelected(1, requested, GAS));
  assert.deepEqual(purchased(s, receipt, s.addresses[1]), [13, 14, 15]);
  assert.equal(await s.token.balanceOf(s.addresses[1]), before - 3n * s.price);
  for (const ticket of requested) assert.equal(await g.ticketOwner(1, ticket), s.addresses[2]);
});

test('replacement: duplicate, unsorted, out-of-range or oversized inputs still revert the entire purchase', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s));
  const before = await s.token.balanceOf(s.addresses[1]);
  for (const requested of [[9, 9], [10, 9], [9999, 10000], Array.from({ length: 1001 }, (_, i) => i)]) {
    await fails(g.connect(s.alice).buySelected(1, requested, GAS));
    assert.equal(await s.token.balanceOf(s.addresses[1]), before);
    assert.equal(await g.totalLiability(), 0n); assert.equal((await g.rounds(1)).sold, 0n);
  }
  assert.equal(await g.ticketOwner(1, 9), ZeroAddress);
  assert.equal(await g.ticketOwner(1, 9999), ZeroAddress);
});

test('replacement: insufficient remaining supply and failed final VRF revert all assignments and payments', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s)); await fundKeeper(s);
  for (let i = 0; i < 5; i++) await sent(g.connect(s.alice).buy(1, 1000, GAS));
  for (let i = 0; i < 4; i++) await sent(g.connect(s.bob).buy(1, 1000, GAS));
  await sent(g.connect(s.bob).buy(1, 998, GAS));
  // A full address cannot use replacements as an extra purchase path.
  await fails(g.connect(s.alice).buySelected(1, [0], GAS));
  const before = await s.token.balanceOf(s.addresses[3]);
  await fails(g.connect(s.keeper).buySelected(1, [0, 1, 2], GAS));
  await sent(s.coordinator.setNextRequestId(0));
  await fails(g.connect(s.keeper).buySelected(1, [0, 1], GAS));
  assert.equal(await s.token.balanceOf(s.addresses[3]), before);
  assert.equal(await g.ticketOwner(1, 9998), ZeroAddress); assert.equal(await g.ticketOwner(1, 9999), ZeroAddress);
  assert.equal(await g.ticketsOf(1, s.addresses[3]), 0n);
  assert.equal((await g.rounds(1)).sold, 9998n); assert.equal(await g.currentRoundId(), 1n);
  assert.equal(await g.totalLiability(), 9998n * s.price);
  await sent(s.coordinator.setNextRequestId(1));
  const receipt = await sent(g.connect(s.keeper).buySelected(1, [0, 1], GAS));
  assert.deepEqual(purchased(s, receipt, s.addresses[3]), [9998, 9999]);
  assert.equal((await g.rounds(1)).status, 3n); assert.equal(await s.coordinator.requestCount(), 1n);
  assert.equal(await g.totalLiability(), s.pool);
});

test('replacement: 1,000 sold requests use one wrap scan rather than rescanning 9,000 occupied tickets per request', async t => {
  const s = await setup(t, 100), g = s.game;
  await sent(activate(s)); await fundKeeper(s);
  for (let i = 0; i < 5; i++) await sent(g.connect(s.alice).buy(1, 1000, GAS));
  for (let i = 0; i < 3; i++) await sent(g.connect(s.bob).buy(1, 1000, GAS));
  const requested = Array.from({ length: 1000 }, (_, i) => 9000 + i);
  await sent(g.connect(s.bob).buySelected(1, requested, GAS));
  assert.equal((await g.rounds(1)).sold, 9000n);
  const receipt = await sent(g.connect(s.keeper).buySelected(1, requested, GAS));
  const actual = purchased(s, receipt, s.addresses[3]);
  assert.deepEqual(actual, Array.from({ length: 1000 }, (_, i) => 8000 + i));
  assert.equal(await g.ticketOwner(1, 8000), s.addresses[3]); assert.equal(await g.ticketOwner(1, 8999), s.addresses[3]);
  assert.equal(await g.ticketOwner(1, 9000), s.addresses[2]); assert.equal(await g.ticketOwner(1, 9999), s.addresses[2]);
  assert.equal(await g.ticketsOf(1, s.addresses[3]), 1000n);
  assert.equal((await g.rounds(1)).status, 3n); assert.equal(await s.coordinator.requestCount(), 1n);
  assert.ok(receipt.gasUsed <= GAS_CAP);
  t.diagnostic(`1,000 replacement tickets after 9,000 occupied numbers and a wrap: ${receipt.gasUsed} gas.`);
});
