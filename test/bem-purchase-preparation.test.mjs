import test from 'node:test';
import assert from 'node:assert/strict';
import {createPurchasePreparation} from '../bem-production-site/web/purchase-preparation.js';
test('warming and clicking share one exact-context read; expiry and changed selection force fresh preparation',async()=>{
  let key='A',time=0,reads=0;
  const p=createPurchasePreparation({context:()=>({key}),now:()=>time,load:async()=>++reads});
  p.warm();assert.equal(await p.get(),1);assert.equal(await p.get(),1);
  time=5000;assert.equal(await p.get(),2);
  key='B';assert.equal(await p.get(),3);
  p.clear();assert.equal(await p.get(),4);
});
test('account or round change while preparing rejects the old result and never reuses it',async()=>{
  let key='A',resolve;
  const p=createPurchasePreparation({context:()=>({key}),load:()=>new Promise(r=>{resolve=r;})});
  const run=assert.rejects(p.get(),{code:'CONTEXT_CHANGED'});await Promise.resolve();key='B';resolve('old');await run;
  const next=p.get();await Promise.resolve();resolve('new');assert.equal(await next,'new');
});
test('a failed background query is retried on click instead of poisoning the preparation',async()=>{
  let reads=0;const p=createPurchasePreparation({context:()=>({key:'A'}),load:async()=>{if(++reads===1)throw Error('offline');return'fresh';}});
  await assert.rejects(p.get(),/offline/);assert.equal(await p.get(),'fresh');
});


test('a changed selection cannot extend the underlying state freshness window',async()=>{
  let time=0,key='100',stateReads=0;
  const state=createPurchasePreparation({context:()=>({key:'account/pool/round'}),now:()=>time,load:async()=>({value:++stateReads,expiresAt:time+5000})});
  const plan=createPurchasePreparation({context:()=>({key}),now:()=>time,load:()=>state.get(),expiresAt:value=>value.expiresAt});
  assert.equal((await plan.get()).value,1);
  time=4000;key='5000';assert.equal((await plan.get()).value,1);
  time=6000;assert.equal((await plan.get()).value,2);
});
test('clearing during an in-flight load prevents it repopulating the new cache',async()=>{
  const resolves=[];const p=createPurchasePreparation({context:()=>({key:'A'}),load:()=>new Promise(r=>resolves.push(r))});
  const old=p.get();await Promise.resolve();p.clear();const fresh=p.get();await Promise.resolve();
  resolves[1]('new');assert.equal(await fresh,'new');resolves[0]('old');await old;
  assert.equal(await p.get(),'new');
});
