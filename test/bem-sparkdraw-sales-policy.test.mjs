import test from 'node:test';
import assert from 'node:assert/strict';
import {SALES_POOL_IDS,DEFAULT_POOL_ID,requirePoolSales} from '../bem-production-site/web/sparkdraw-sales-policy.js';
import {createSparkDrawTransactions} from '../bem-production-site/web/sparkdraw-transactions.js';

test('formal launch opens only three pools and rejects closed purchases before any wallet or RPC access',async()=>{
  assert.deepEqual(SALES_POOL_IDS,['5','10','50']);assert.equal(DEFAULT_POOL_ID,'5');
  let touched=0;const unexpected=()=>{touched++;throw Error('Unexpected external call');};
  const manager=createSparkDrawTransactions({rpc:unexpected,wallet:unexpected,context:unexpected,storage:{getItem:()=>null},locks:{request:unexpected}});
  for(const id of ['0.1','100'])for(const method of ['approve','buy','buySelected'])await assert.rejects(manager.execute({poolId:id,method,args:[],kind:'buy'}),{code:'POOL_SALES_CLOSED'});
  assert.equal(touched,0);
  for(const id of ['5','10','50'])for(const method of ['approve','buy','buySelected'])assert.doesNotThrow(()=>requirePoolSales(id,method));
  for(const id of ['0.1','100'])for(const method of ['refundMany','claimPrizes','burnUnclaimed','settle'])assert.doesNotThrow(()=>requirePoolSales(id,method));
});
