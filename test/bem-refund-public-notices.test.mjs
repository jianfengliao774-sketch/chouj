import test from 'node:test';
import assert from 'node:assert/strict';
import { sparkDrawRecords } from '../bem-production-site/sparkdraw-records.mjs';
const A='0x1111111111111111111111111111111111111111',B='0x2222222222222222222222222222222222222222';
const trigger=1800000000, hash='0x'+'a'.repeat(64);
const event=(name,args)=>({name,args:{roundId:'1',...args},timeUtc:new Date((trigger-86400)*1000).toISOString(),transactionHash:hash,logIndex:0});
const funding=[event('RoundStarted',{fundingDeadline:String(trigger)}),
  event('TicketsAllocated',{buyer:A,count:'100',paid:'100000',bitmap:[]}),
  event('TicketsAllocated',{buyer:A,count:'200',paid:'200000',bitmap:[]}),
  event('TicketsAllocated',{buyer:B,count:'50',paid:'50000',bitmap:[]})];
const records=events=>sparkDrawRecords(events,{pool:'0.1',address:B});
test('first 12 hours stay personal; exactly 12 hours exposes only outstanding wallets and accumulated actual shares',()=>{
  const data=records(funding);
  assert.equal(data.wallet(A,trigger).at(0).refundablePrincipal,'300000');
  assert.deepEqual(data.refundNotices(trigger+43199),[]);
  assert.equal(JSON.stringify(data.publicRounds).includes(A),false);
  const rows=data.refundNotices(trigger+43200);
  assert.deepEqual(rows.map(r=>[r.account,r.tickets,r.amountBaseUnits]),[[A,300,'300000'],[B,50,'50000']]);
  assert.equal(rows[0].claimDeadline,trigger+86400);assert.equal(rows[0].publicAt,trigger+43200);
  assert.equal(rows[0].state,'claimable');assert.equal('purchases' in rows[0],false);
});
test('confirmed claim removes the wallet, late opening cannot restart clocks, and expired rows remain until actual burn',()=>{
  const claimed=[...funding,event('RefundsOpened',{}),event('Refunded',{buyer:A,amount:'300000'})];
  assert.deepEqual(records(claimed).refundNotices(trigger+43201).map(r=>r.account),[B]);
  const late=records(claimed).refundNotices(trigger+86400);
  assert.equal(late[0].state,'awaiting_burn');assert.equal(late[0].claimDeadline,trigger+86400);
  assert.deepEqual(records(claimed).burns,[],'pending amounts never count as actual burned');
  const burned=records([...claimed,event('UnclaimedPrincipalBurned',{amount:'50000'})]);
  assert.deepEqual(burned.refundNotices(trigger+86401),[]);
  assert.equal(burned.burns[0].amountBaseUnits,'50000');assert.equal(burned.burns[0].kind,'unclaimed_principal');
});
test('sealed failure uses the draw timeout, while settled prizes never become principal-refund notices',()=>{
  const drawDeadline=trigger+900;
  const sealed=[...funding,event('RoundLocked',{drawDeadline:String(drawDeadline)}),event('RandomnessReceived',{})];
  assert.deepEqual(records(sealed).refundNotices(trigger+43200),[]);
  assert.equal(records(sealed).refundNotices(drawDeadline+43200).length,2);
  const settled=records([...sealed,event('Settled',{winner:A,winningTicket:'10'}),event('PrizeAvailable',{winner:A,amount:'9500000',claimDeadline:String(drawDeadline+86400)})]);
  assert.deepEqual(settled.refundNotices(drawDeadline+43200),[]);
  assert.equal(settled.pendingPrizes.length,1);
});
