import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {walletClaimGroups} from '../bem-production-site/sparkdraw-claims.mjs';
const source=fs.readFileSync(new URL('../bem-production-site/web/sparkdraw-player.js',import.meta.url),'utf8');
test('refund totals cover all rounds beyond pagination and the batch prioritizes expiring claims',()=>{
  const rows=Array.from({length:80},(_,i)=>({poolId:'5',roundId:String(i+1),refundablePrincipal:'10',claimablePrize:'0',refundClaimDeadline:1000-i}));
  rows.push({poolId:'10',roundId:'1',refundablePrincipal:'100',claimablePrize:'0',refundClaimDeadline:900});
  const [a,b]=walletClaimGroups(rows,['5','10']);assert.equal(a.refundablePrincipal,'800');assert.equal(a.refundCount,80);assert.equal(a.refunds.length,64);assert.equal(a.refundBatchAmount,'640');assert.equal(a.refunds[0],'17');assert.equal(a.refunds.at(-1),'80');assert.equal(b.refundablePrincipal,'100');
});
function fixture(){
  const nodes=new Map(),sent=[],requests=[];let connections=0;
  const address='0x1111111111111111111111111111111111111111';
  const c=vm.createContext({account:address,pool:'5',revision:1,chain:56,refundFlow:false,refundData:null,refundError:false,F:{refundBatchLimit:64},
    $:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);},money:String,t:s=>s,manager:{busy:false,blocked:()=>false},picker:{open(){connections++;}},
    queryRecords:async(kind,filter)=>{requests.push({kind,filter});return {claims:[{poolId:'5',refunds:['7','9'],refundCount:2,refundablePrincipal:'30'}]};},
    action:async(...args)=>sent.push(args),refreshRecords:async()=>{}});
  vm.runInContext(source.slice(source.indexOf('function renderRefund(){'),source.indexOf('async function queryRecords(')),c);
  return{c,nodes,sent,requests,address,connections:()=>connections};
}
test('one click connects or rechecks all wallet refunds and sends one aggregate claim without a round input',async()=>{
  const f=fixture();f.c.account=null;await f.c.claimRefunds();assert.equal(f.connections(),1);assert.equal(f.sent.length,0);
  f.c.account=f.address;await f.c.claimRefunds();assert.equal(f.requests[0].filter.round,undefined);assert.equal(f.requests[0].filter.address,f.address);
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent)),[['5','refundMany',[['7','9'],f.address]]]);assert.equal(f.nodes.get('refund').textContent,'领取全部本金');
});
test('wallet changes while querying never send another wallet’s refund; empty results never open a claim',async()=>{
  const f=fixture();f.c.queryRecords=async()=>{f.c.account='0x2222222222222222222222222222222222222222';return{claims:[]};};
  await assert.rejects(()=>f.c.claimRefunds(),/CONTEXT_CHANGED/);assert.equal(f.sent.length,0);
  f.c.queryRecords=async()=>({claims:[{poolId:'5',refunds:[],refundCount:0,refundablePrincipal:'0'}]});await f.c.claimRefunds();assert.equal(f.sent.length,0);assert.equal(f.nodes.get('refund').disabled,true);
});
