import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, sent, events } from './helpers/bem-formal-v4-fixture.mjs';
test('V4 5000-ticket automatic and scattered-selected purchases fit one transaction', async t => {
  const s = await setup(t, 5, { blockGasLimit: 60000000 });
  await sent(s.revenue.execute(s.game.target, 0, s.game.interface.encodeFunctionData('authorizeSeries'), 0, { gasLimit: 1000000, value: 200000000000000n }));
  const checkpoint = await s.rpc.request({ method: 'evm_snapshot', params: [] });
  const auto = await sent(s.game.connect(s.alice).buy(1, 5000, { gasLimit: 50000000 }));
  console.log('V4 auto5000 gas',auto.gasUsed.toString());
  assert.equal(await s.game.ticketsOf(1,s.addresses[1]),5000n);
  await s.rpc.request({ method: 'evm_revert', params: [checkpoint] });
  const selected = await sent(s.game.connect(s.alice).buySelected(1, Array.from({length:5000},(_,i)=>i*2), { gasLimit: 50000000 }));
  console.log('V4 scattered5000 gas',selected.gasUsed.toString());
  assert.equal(events(s.game,selected,'PurchaseResult')[0].filled,5000n);
  assert.ok(auto.gasUsed < 16777216n); assert.ok(selected.gasUsed < 16777216n);
});
