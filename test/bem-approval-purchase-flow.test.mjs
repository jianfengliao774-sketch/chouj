import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalPurchaseFlow } from '../bem-production-site/web/approval-purchase-flow.js';
const record = { id:'approval',hash:'0xabc',status:'confirmed' }, input = {roundId:1n,quantity:1000,tickets:null};
test('one click buys directly with allowance or continues only after its own confirmed approval', async () => {
  for (const needsApproval of [false,true]) {
    const calls=[];
    const flow=createApprovalPurchaseFlow({getKey:()=> 'same',send:async(kind,args)=>{calls.push(kind);assert.deepEqual(args,input);return record;},waitForApproval:async()=>record});
    await flow.run({needsApproval,input}); assert.deepEqual(calls,needsApproval?['approve','buy']:['buy']); assert.equal(flow.busy,false);
  }
});
test('rejection, reverted or different approval cannot cause a purchase', async()=>{
  for(const mode of ['reject','reverted','different']) {
    const calls=[];
    const flow=createApprovalPurchaseFlow({getKey:()=> 'same',send:async kind=>{calls.push(kind);if(mode==='reject')throw Error('Rejected');return record;},
      waitForApproval:async()=>mode==='reverted'?{...record,status:'reverted'}:{...record,id:'other'}});
    await assert.rejects(flow.run({needsApproval:true,input}));assert.deepEqual(calls,['approve']);
  }
});
test('wallet, pool or selection changes cancel continuation, including changed-then-restored selections', async()=>{
  for(const mode of ['context','cancel']) {
    let key='before'; const calls=[];
    const flow=createApprovalPurchaseFlow({getKey:()=>key,send:async kind=>{calls.push(kind);return record;},waitForApproval:async()=>{if(mode==='context')key='after';else flow.cancel();return record;}});
    await assert.rejects(flow.run({needsApproval:true,input}),{code:'CONTEXT_CHANGED'});assert.deepEqual(calls,['approve']);
  }
});
