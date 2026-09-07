import test from 'node:test';
import assert from 'node:assert/strict';
import { participationQuery } from '../bem-production-site/participation.mjs';
const wallet = '0x'+'1'.repeat(40);
const source = { getStatus: () => ({state:'syncing'}), walletParticipation: (address, round) => {
  assert.equal(address, wallet); return !round || round === '1' ? [{ roundId:'1', tickets:1000, purchaseCount:2, paidBaseUnits:'10000000', lastPurchaseAt:'2026-09-07T00:00:00Z', purchases:[] }] : [];
} };
test('participation query filters per pool and round and totals integer BEM units', () => {
  const result = participationQuery(new URLSearchParams({wallet,pool:'1',round:'1'}), {'1':source,'10':source});
  assert.equal(result.rows.length,1); assert.equal(result.rows[0].poolId,'1'); assert.equal(result.totals.paidBaseUnits,'10000000');
  assert.equal(result.sources[0].index.state,'syncing');
  assert.equal(participationQuery(new URLSearchParams({wallet,round:'2'}), {'1':source}).total,0);
  assert.equal(participationQuery(new URLSearchParams({wallet}), {'1':source,'10':source}).totals.paidBaseUnits,'20000000');
});
test('invalid query never causes chain reads or address coercion', () => {
  for(const query of [{wallet:'no'},{wallet,pool:'2'},{wallet,round:'0'},{wallet,page:'NaN'},{wallet,page:'100001'}])
    assert.throws(()=>participationQuery(new URLSearchParams(query), {'1':source}));
});
