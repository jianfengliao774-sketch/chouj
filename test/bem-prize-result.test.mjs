import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { prizeResult } from '../bem-production-site/web/prize-result.js';

const WINNER = '0x' + 'a'.repeat(40), PLAYER = '0x' + 'b'.repeat(40), VISITOR = '0x' + 'c'.repeat(40);
const round = (patch = {}) => ({ poolId: '5', roundId: '7', status: 5, winner: WINNER,
  prize: { amount: '9500000000000000000', claimDeadline: 200, claimed: false, burned: false }, ...patch });

test('only the winning wallet receives a claimable result for a positive unexpired prize', () => {
  const r = round();
  assert.equal(prizeResult(r, WINNER, 100), 'claimable');
  assert.equal(prizeResult(r, WINNER.toUpperCase(), 100), 'claimable');
  assert.equal(prizeResult(r, PLAYER, 100), null);
  assert.equal(prizeResult(r, null, 100), null);
  assert.equal(prizeResult({ poolId: '5', roundId: '7', prize: { ...r.prize, winner: WINNER } }, WINNER, 100), 'claimable',
    'pending-prize notices identify the winner inside the prize');
});

test('a losing message requires ticket evidence for the connected wallet on the settled record', () => {
  for (const evidence of [{ account: PLAYER, tickets: 2 }, { viewerAccount: PLAYER, viewerTickets: 2 }]) {
    const r = round(evidence);
    assert.equal(prizeResult(r, PLAYER, 100), 'lost');
    assert.equal(prizeResult(r, PLAYER.toUpperCase(), 100), 'lost');
    assert.equal(prizeResult(r, WINNER, 100), 'claimable');
    assert.equal(prizeResult(r, VISITOR, 100), null, 'late previous-wallet evidence cannot identify another wallet as a participant');
    assert.equal(prizeResult(r, null, 100), null);
    for (const status of [0, 1, 3, 4, 6]) assert.equal(prizeResult({ ...r, status }, PLAYER, 100), null);
  }
  for (const evidence of [{ tickets: 2 }, { viewerTickets: 2 }, { account: PLAYER, tickets: 0 },
    { viewerAccount: PLAYER, viewerTickets: 0 }, { account: PLAYER, tickets: -1 },
    { viewerAccount: PLAYER, viewerTickets: 'unknown' }, { account: VISITOR, tickets: 2 },
    { viewerAccount: VISITOR, viewerTickets: 2 }]) {
    assert.equal(prizeResult(round(evidence), PLAYER, 100), null);
  }
});

test('claim status distinguishes claimed, burned and expired prizes and omits incomplete prizes', () => {
  const r = round();
  for (const [patch, expected] of [[{ claimed: true }, 'claimed'], [{ burned: true }, 'burned'],
    [{ claimDeadline: 100 }, 'expired'], [{ claimDeadline: 99 }, 'expired'], [{ amount: '0' }, null],
    [{ amount: '-1' }, null], [{ claimDeadline: 0 }, null], [{ claimDeadline: undefined }, null],
    [{ claimDeadline: 'invalid' }, null]]) {
    assert.equal(prizeResult({ ...r, prize: { ...r.prize, ...patch } }, WINNER, 100), expected);
  }
  assert.equal(prizeResult({ ...r, prize: null }, WINNER, 100), null);
  assert.equal(prizeResult({ ...r, prize: { ...r.prize, claimed: true, claimDeadline: 90 } }, WINNER, 100), 'claimed');
  assert.equal(prizeResult({ ...r, prize: { ...r.prize, burned: true, claimDeadline: 90 } }, WINNER, 100), 'burned');
  assert.equal(prizeResult({ ...r, account: PLAYER, tickets: 1, prize: { ...r.prize, claimed: true } }, PLAYER, 100), 'lost');
});

const source = await readFile(new URL('../bem-production-site/web/sparkdraw-player.js', import.meta.url), 'utf8');
function claimHarness(account, locale = 'zh') {
  const actions = [], context = vm.createContext({ account, now: 100, refreshes: 0, prizeResult,
    chainNow: () => context.now, t: (zh, en) => locale === 'en' ? en : zh,
    el: (tag, textContent) => ({ tag, textContent }),
    button: (textContent, click) => ({ tag: 'button', textContent, click }),
    action: (...args) => actions.push(args), refreshRecords: () => context.refreshes++ });
  vm.runInContext(source.slice(source.indexOf('function claimButton('), source.indexOf('function renderRefund(')), context);
  return { context, actions, render: r => context.claimButton(r, r.poolId) };
}

test('settled losing participants see friendly Chinese and English text without a claim control', () => {
  for (const [locale, expected] of [['zh', '本期未中奖，感谢参与'], ['en', 'No win this round. Thank you for participating.']]) {
    const h = claimHarness(PLAYER, locale), node = h.render(round({ viewerAccount: PLAYER, viewerTickets: 2 }));
    assert.equal(node.tag, 'p');
    assert.equal(node.textContent, expected);
    assert.equal(node.hidden, false);
    assert.equal(node.click, undefined);
    assert.equal(h.actions.length, 0);
    h.context.account = VISITOR;
    const visitor = h.render(round({ viewerAccount: PLAYER, viewerTickets: 2 }));
    assert.equal(visitor.hidden, true);
    assert.equal(visitor.textContent, '');
  }
});

test('winner claim controls submit the correct pool, round and wallet and recheck eligibility at click time', () => {
  const h = claimHarness(WINNER), r = round(), button = h.render(r);
  assert.equal(button.tag, 'button');
  assert.equal(button.textContent, '领取奖金');
  button.click();
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions)), [['5', 'claimPrizes', [['7'], WINNER]]]);
  for (const update of [() => { h.context.account = PLAYER; }, () => { h.context.account = null; },
    () => { h.context.account = WINNER; h.context.now = 200; },
    () => { h.context.now = 100; r.prize.claimed = true; }]) {
    update(); button.click();
    assert.equal(h.actions.length, 1, 'an outdated button must not submit a claim');
  }
  assert.equal(h.context.refreshes, 4);
});
