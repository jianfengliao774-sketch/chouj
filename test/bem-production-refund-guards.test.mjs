import test from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest } from '../bem-production-site/config.mjs';
import { parseRefundRound, refundEligibility, createRefundIntent, assertRefundSnapshot } from '../bem-production-site/web/refund-guards.js';

const account='0x1111111111111111111111111111111111111111';
const base={roundId:'1',account,myCount:10n,status:1,timestamp:100,fundingDeadline:100,drawDeadline:200,seriesAuthorized:false};
const config=await loadManifest();
const intent=createRefundIntent({roundId:'1',account,epoch:1,snapshot:base});
const args={config,snapshot:base,intent,walletAccount:account,walletChain:56,epoch:1};
const fails=(overrides,code)=>assert.throws(()=>assertRefundSnapshot({...args,...overrides}),{code});

test('refund opens exactly at funding deadline; 10 tickets return 0.1 BEM',()=>{
  assert.deepEqual(refundEligibility(base),{eligible:true,reason:null,amount:10000000n});
  assert.equal(refundEligibility({...base,timestamp:99}).reason,'REFUND_TOO_EARLY');
});
test('locked rounds use draw deadline, requested/ready/settled rounds cannot refund',()=>{
  assert.equal(refundEligibility({...base,status:2,timestamp:199}).eligible,false);
  assert.equal(refundEligibility({...base,status:2,timestamp:200}).eligible,true);
  for(const status of [0,3,4,5]) assert.equal(refundEligibility({...base,status,timestamp:10000}).eligible,false);
  assert.equal(refundEligibility({...base,status:6,timestamp:1}).eligible,true);
});
test('refund survives closed sales, disabled series and a later current round',()=>{
  assert.equal(config.salesEnabled,false);
  assert.doesNotThrow(()=>assertRefundSnapshot({...args,snapshot:{...base,currentRoundId:'20'}}));
});
test('already refunded/zero holdings do not produce another transaction',()=>{
  fails({snapshot:{...base,myCount:0n,status:6}},'NOTHING_TO_REFUND');
});
test('refund intent rejects changed identity, network, amount and round',()=>{
  fails({walletChain:97},'NETWORK');
  fails({epoch:2},'WALLET_CHANGED');
  fails({walletAccount:'0x2222222222222222222222222222222222222222'},'WALLET_CHANGED');
  fails({snapshot:{...base,account:null}},'WALLET_CHANGED');
  fails({snapshot:{...base,myCount:100n}},'REFUND_CHANGED');
  fails({snapshot:{...base,roundId:'2'}},'REFUND_ROUND');
  fails({config:{...config,chainId:97}},'MANIFEST');
});
test('refund round input is strict uint256 and does not lose precision',()=>{
  assert.equal(parseRefundRound('999999999999999999'),'999999999999999999');
  for(const value of ['0','-1','1.1','1e2','01','',String(2n**256n)]) assert.throws(()=>parseRefundRound(value),{code:'REFUND_ROUND'});
});
