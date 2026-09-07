import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { previewPoolSelection, createPendingPlayerState } from '../bem-production-site/web/player-v2-state.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
test('1000 tickets preview uses the selected pool price exactly and rejects 1001', () => {
  for (const [poolId, amount] of [['1', '10000000'], ['10', '100000000'], ['50', '500000000'], ['100', '1000000000']]) {
    const result = previewPoolSelection({ poolId, count: '1000' });
    assert.equal(result.quantity, 1000); assert.equal(result.amountBaseUnits, amount);
    assert.equal(result.writeEnabled, false); assert.equal(result.maxTicketsPerAddress, 5000);
    assert.throws(() => previewPoolSelection({ poolId, count: '1001' }), { code: 'TICKET_LIMIT' });
  }
  for (const count of ['0', '-1', '0.1', '1e3', ' 10 ', '10000']) assert.throws(() => previewPoolSelection({ poolId: '10', count }));
});
test('preferred numbers support boundary tickets, Chinese commas and ranges without duplicated cost', () => {
  const preview = previewPoolSelection({ poolId: '10', mode: 'selected', text: '1，88，100 - 110, 10000, 88' });
  assert.deepEqual(preview.tickets, [1, 88, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 10000]);
  assert.equal(preview.quantity, 14); assert.equal(preview.amountBaseUnits, '1400000');
  assert.equal(previewPoolSelection({ poolId: '50', mode: 'selected', text: '1-1000' }).quantity, 1000);
  for (const text of ['0', '10001', '10-1', '1-1001', 'abc', '', '1-10000']) assert.throws(() => previewPoolSelection({ poolId: '10', mode: 'selected', text }));
});
test('switching pools clears selected tickets and discards the previous asynchronous wallet balance', () => {
  const model = createPendingPlayerState({ poolId: '100' }); model.setWallet(ACCOUNT, 56);
  model.setSelection({ mode: 'selected', text: '1-50' }); const old = model.getState();
  assert.equal(model.preview().amountBaseUnits, '50000000');
  const switched = model.selectPool('10'); assert.equal(switched.epoch, old.epoch + 1);
  assert.deepEqual(switched.selection, { mode: 'auto', count: '1', text: '' });
  assert.equal(model.preview().amountBaseUnits, '100000');
  assert.equal(model.acceptBalance(old, { bem: '1', bnb: '2', block: 100 }), false);
  assert.equal(model.getState().balance, null);
  assert.equal(model.acceptBalance(switched, { bem: '1', bnb: '2', block: 100 }), true);
});
test('wallet and network changes invalidate pending balances and never enable transactions', () => {
  const model = createPendingPlayerState(); const saved = model.setWallet(ACCOUNT, 56);
  model.setWallet(OTHER, 56); assert.equal(model.acceptBalance(saved, { bem: '100', bnb: '200', block: 10 }), false);
  const wrongNetwork = model.setWallet(ACCOUNT, 1);
  assert.equal(model.acceptBalance(wrongNetwork, { bem: '100', bnb: '200', block: 10 }), false);
  for (const id of ['1', '10', '50', '100']) {
    model.selectPool(id); model.setWallet(ACCOUNT, 56);
    assert.equal(model.getState().writeEnabled, false); assert.equal(model.getState().available, false);
    assert.throws(() => model.requireWriteAllowed(), { code: 'POOL_NOT_LAUNCHED' });
  }
});
test('pending player entry contains no financial signing API, old game address or old history endpoint', async () => {
  const source = await fs.readFile(new URL('../bem-production-site/web/player-v2.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /eth_sendTransaction|eth_sendRawTransaction|eth_sign|personal_sign|\.sendTransaction\(|0xBee0848D|\/api\/history/i);
  assert.match(source, /model\.requireWriteAllowed\(\)/);
  assert.match(source, /bem:poolchange/); assert.match(source, /bem:historyrefresh/);
  assert.doesNotMatch(source, /BEM (?:进入|转入) 2075 容器|BEM to the 2075 container/);
});
