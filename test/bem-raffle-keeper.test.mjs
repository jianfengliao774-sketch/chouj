import test from "node:test";
import assert from "node:assert/strict";
import { decideKeeperAction } from "../scripts/run_bem_raffle_keeper.mjs";

const pending = (status, overrides = {}) => ({ authorized: true, currentRoundId: 2n,
  current: { status: 0 }, previous: { status, requestId: 7n }, now: 1020n, nextRoundOpensAt: 0n,
  timing: { lockedAt: 1000n, targetDrawBy: 1060n, scheduledDrawAt: status === 4 ? 1020n : 0n }, ...overrides });

test("keeper never replaces an overdue VRF request", () => {
  const result = decideKeeperAction(pending(3, { now: 9000n }));
  assert.equal(result.action, "wait");
  assert.equal(result.targetOverdue, true);
  assert.equal(result.roundId, 1n);
});

test("keeper settles the funded previous round at its schedule, including late delivery", () => {
  assert.equal(decideKeeperAction(pending(4, { now: 1019n })).action, "wait");
  assert.deepEqual(decideKeeperAction(pending(4)), { action: "settle", roundId: 1n, args: [1n], targetOverdue: false });
  assert.equal(decideKeeperAction(pending(4, { now: 9000n })).action, "settle");
  assert.equal(decideKeeperAction(pending(4, { timing: null })).action, "wait");
});

test("keeper opens the next round exactly at the cooldown boundary", () => {
  const state = pending(5, { nextRoundOpensAt: 1080n, now: 1079n });
  assert.equal(decideKeeperAction(state).action, "wait");
  assert.deepEqual(decideKeeperAction({ ...state, now: 1080n }), { action: "openNextRound", roundId: 2n, args: [] });
  assert.equal(decideKeeperAction({ ...state, now: 1080n, authorized: false }).action, "wait");
});

test("keeper opens refunds only for an expired funding round and never retries a missing locked request", () => {
  const state = { authorized: true, currentRoundId: 1n, current: { status: 1, fundingDeadline: 4000n },
    previous: null, now: 3999n, nextRoundOpensAt: 0n, timing: null };
  assert.equal(decideKeeperAction(state).action, "wait");
  assert.equal(decideKeeperAction({ ...state, now: 4000n }).action, "openRefunds");
  assert.equal(decideKeeperAction(pending(2, { now: 999999n })).action, "wait");
});
