import test from 'node:test';
import assert from 'node:assert/strict';
import { publicDrawState, duration } from '../bem-production-site/web/public-draw-state.js';
const zero = '0x' + '0'.repeat(40), wallet = '0x' + 'a'.repeat(40);
const snapshot = { runtimeVerified: true, currentRoundId: '2', currentRound: { status: '0', sold: '0', winner: zero },
  previousRound: { status: '3', sold: '10000', winner: zero, winningTicket: '0' },
  previousDrawTiming: { targetDrawBy: '1060', scheduledDrawAt: '0' } };
test('public draw remains on the sealed round without a wallet when currentRoundId already advanced', () => {
  const draw = publicDrawState(snapshot, 1050);
  assert.equal(draw.roundId, '1'); assert.equal(draw.sold, 10000); assert.equal(draw.status, 3);
  assert.equal(draw.remaining, 10); assert.equal(draw.winner, null);
  const delayed = publicDrawState(snapshot, 1200);
  assert.equal(delayed.remaining, 0); assert.equal(delayed.overdue, true); assert.equal(delayed.winner, null);
});
test('VRF Ready uses onchain schedule; only Settled with a nonzero wallet exposes a winning ticket', () => {
  const ready = structuredClone(snapshot); ready.previousRound.status = '4'; ready.previousDrawTiming.scheduledDrawAt = '1030';
  assert.equal(publicDrawState(ready, 1020).remaining, 10);
  assert.equal(publicDrawState(ready, 1031).winner, null);
  ready.previousRound.status = '5';
  assert.equal(publicDrawState(ready, 1031).winner, null);
  ready.previousRound.winner = wallet;
  assert.deepEqual(publicDrawState(ready, 1031).winner, { roundId: '1', winner: wallet, winningTicket: 0 });
  ready.previousRound.winningTicket = '9999'; assert.equal(publicDrawState(ready, 1031).winner.winningTicket, 9999);
  ready.previousRound.winningTicket = '10000'; assert.equal(publicDrawState(ready, 1031).winner, null);
});
test('a newly funding round uses its own deadline; countdown is clock-based and never negative', () => {
  const next = structuredClone(snapshot); next.previousRound.status = '5'; next.currentRound = { status: '1', sold: '0', fundingDeadline: '2000' };
  assert.equal(publicDrawState(next, 1900).roundId, '2'); assert.equal(publicDrawState(next, 1900).remaining, 100);
  assert.equal(duration(3661), '01:01:01'); assert.equal(duration(-1), '00:00:00');
  assert.equal(publicDrawState(null, 0), null);
});
