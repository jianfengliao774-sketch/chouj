import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { createBurnSummary } from '../bem-production-site/burn-summary.mjs';
import { validateBurnSummary } from '../bem-production-site/web/burn-summary.js';
import { createProductionServer } from '../bem-production-site/server.mjs';
import { createAdminCredential } from '../bem-production-site/auth.mjs';
const dead='0x000000000000000000000000000000000000dEaD';
const row=(amount,logIndex,kind='settlement')=>({amountBaseUnits:amount,logIndex,kind,destination:dead,
  gameAddress:'0x1111111111111111111111111111111111111111',transactionHash:'0x'+'a'.repeat(64)});
const index=(rows,state='ready')=>({getStatus:()=>({state}),listBurns:options=>{assert.equal(options.all,true);return {rows};}});
test('all confirmed burn types count exactly once, without float rounding, pagination or pending claims',()=>{
  const rows=[row('9007199254740993',0),row('12345678',1,'unclaimed_principal'),row('2',2,'unclaimed_prize')];
  const read=createBurnSummary({sources:()=>[index(rows),index([rows[0]])]});
  const summary=validateBurnSummary(read());
  assert.equal(summary.amountBaseUnits,'9007199267086673');assert.equal(summary.burnCount,3);
  assert.equal(summary.index.state,'ready');assert.equal(summary.scope,'all_registered_pools');
  assert.equal('pendingRefunds' in summary,false);
});
test('shares a five-minute snapshot across visitors and replaces it at the boundary, including chain rollback',()=>{
  let now=1800000000000,rows=[row('10000000',0)],reads=0;
  const read=createBurnSummary({now:()=>now,sources:()=>{reads++;return[index(rows)];}});
  const first=read();rows.push(row('20000000',1));now+=299999;
  assert.equal(read().amountBaseUnits,'10000000');assert.equal(reads,1);
  first.amountBaseUnits='999';assert.equal(read().amountBaseUnits,'10000000');
  now++;assert.equal(read().amountBaseUnits,'30000000');assert.equal(reads,2);
  rows=[];now+=300000;assert.equal(read().amountBaseUnits,'0');
});
test('incomplete or missing indexes mark the confirmed subtotal as incomplete; malformed sources cannot be counted',()=>{
  const read=createBurnSummary({sources:()=>[index([row('1',0)],'stale'),null]});
  assert.equal(read().index.state,'syncing');assert.equal(read().amountBaseUnits,'1');
  assert.throws(()=>createBurnSummary({sources:()=>[index([{...row('9',0),kind:'pending_prize'}])]})());
  assert.throws(()=>createBurnSummary({sources:()=>[index([row('1',0),row('2',0)])]})());
});
test('public endpoint reports all registered confirmed burns without wallet, authentication or RPC requests',async t=>{
  const {server}=await createProductionServer({port:0,history:index([row('10000000',0)]),
    adminCredential:await createAdminCredential('summary-test','local-fixture-only'),
    poolHistories:{'1':index([row('20000000',1)])},rpc:()=>{throw Error('Unexpected RPC');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await new Promise((resolve,reject)=>get(`http://127.0.0.1:${server.address().port}/api/burns/summary`,{headers:{host:'127.0.0.1:0'}},res=>{
    let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));
  }).on('error',reject));
  assert.equal(response.status,200);const result=validateBurnSummary(JSON.parse(response.body));
  assert.equal(result.amountBaseUnits,'30000000');assert.equal(result.burnCount,2);
  assert.equal(result.index.state,'syncing');
});
