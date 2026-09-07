import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {keccak256,toQuantity} from 'ethers';
import {createSparkDrawTransactions,parseTickets,GAME} from '../bem-production-site/web/sparkdraw-transactions.js';
import {profile} from '../bem-production-site/web/sparkdraw-profiles.js';
import {validateReadRequest} from '../bem-production-site/rpc.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/drand/deployed-test-runtime.json',import.meta.url))),p=profile('0.1');
const account='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222',hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64);
function setup(){let ctx={account,key:'same'},price=50_000_000n,receipt=null,tx=null;const storage=new Map(),sent=[];
  const wallet={async request(q){if(q.method==='eth_accounts')return[ctx.account];if(q.method==='eth_chainId')return'0x38';if(q.method==='eth_getTransactionCount')return'0x1';if(q.method==='eth_sendTransaction'){sent.push(q.params[0]);return hash;}throw Error(q.method);}};
  const rpc=async(method,args)=>{if(method==='eth_blockNumber')return'0x60';if(method==='eth_getTransactionCount')return'0x1';if(method==='eth_getCode')return fixture.code;if(method==='eth_estimateGas')return'0xf4240';if(method==='eth_gasPrice')return toQuantity(price);if(method==='eth_getTransactionReceipt')return receipt;if(method==='eth_getTransactionByHash')return tx;if(method==='eth_getBlockByNumber')return{number:'0x64',hash:blockHash};throw Error(method);};
  const manager=createSparkDrawTransactions({rpc,wallet:()=>wallet,context:()=>ctx,locks:{request:async(k,o,fn)=>fn({})},storage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  return{manager,sent,setPrice:n=>price=n,change:()=>ctx={account:other,key:'changed'},mine({filled=800,requested=1000,recipient=account}={}){const data=GAME.encodeEventLog(GAME.getEvent('PurchaseResult'),[1,recipient,requested,filled,BigInt(filled)*p.ticketPrice,BigInt(requested-filled)*p.ticketPrice]);tx={...sent[0],input:sent[0].data,hash,blockNumber:'0x64',blockHash};receipt={transactionHash:hash,status:'0x1',blockNumber:'0x64',blockHash,logs:[{...data,address:p.address}]};}};
}
test('new pools accept 5000 tickets and old RPC destinations are removed',()=>{
  assert.equal(keccak256(fixture.code),p.runtimeHash);
  assert.equal(parseTickets('selected',0,'1-5000').count,5000);assert.equal(parseTickets('auto','5000','').count,5000);
  assert.throws(()=>parseTickets('auto','5001',''));assert.throws(()=>parseTickets('selected',0,'0,10001'));
  const data=GAME.encodeFunctionData('buySelected',[1,Array.from({length:5000},(_,i)=>i)]);
  assert.ok(validateReadRequest({jsonrpc:'2.0',id:1,method:'eth_estimateGas',params:[{to:p.address,data},'latest']}));
  for(const old of ['0xBee0848D0c77d434A52d1D0236FcBFdCA0834343','0xE7D8dF903050d875f09cE1BBcE20E837fB55bC0c','0x3335ec04A7509aDE8E6C4Bc851fE409EE063a2bc'])assert.throws(()=>validateReadRequest({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:old,data},'latest']}));
});
test('V5 purchase caps fees, retries only on user action and confirms actual partial fill',async()=>{
  const s=setup(),input={poolId:'0.1',method:'buy',args:[1,1000],kind:'buy',count:1000,roundId:1};s.setPrice(1_000_000_000n);
  await assert.rejects(s.manager.execute(input),{code:'GAS_FEE_CAP_EXCEEDED'});assert.equal(s.sent.length,0);assert.equal(s.manager.pending,null);
  s.setPrice(50_000_000n);await s.manager.execute(input);assert.equal(s.sent.length,1);assert.equal(BigInt(s.sent[0].gas),1200000n);
  await assert.rejects(s.manager.execute(input),{code:'TRANSACTION_PENDING'});s.mine();const result=await s.manager.check();assert.equal(result.result.filled,800);assert.equal(result.result.unspent,'200000');assert.equal(s.manager.pending,null);
});
test('receipt with another recipient never clears a submitted purchase',async()=>{
  const s=setup();await s.manager.execute({poolId:'0.1',method:'buy',args:[1,1000],kind:'buy',count:1000,roundId:1});s.mine({recipient:other});await assert.rejects(s.manager.check(),{code:'TRANSACTION_MISMATCH'});assert.ok(s.manager.pending);
});
test('aggregate claim recipient is the connected wallet and the target is always the selected new pool',async()=>{
  const s=setup();await assert.rejects(s.manager.execute({poolId:'0.1',method:'refundMany',args:[[1,2],other],kind:'refundMany'}),{code:'CONTEXT_CHANGED'});assert.equal(s.sent.length,0);
  await s.manager.execute({poolId:'0.1',method:'claimPrizes',args:[[1,2],account],kind:'claimPrizes'});const parsed=GAME.parseTransaction({data:s.sent[0].data});assert.equal(parsed.name,'claimPrizes');assert.equal(parsed.args[1],account);assert.equal(s.sent[0].to,p.address);
});

test('a purchase losing the last shares resolves as zero fill without blocking subsequent claims',async()=>{
  const s=setup();await s.manager.execute({poolId:'0.1',method:'buySelected',args:[1,[0,17,9999]],kind:'buy',count:3,roundId:1});
  s.mine({requested:3,filled:0});const r=await s.manager.check();
  assert.equal(r.status,'confirmed');assert.equal(r.result.filled,0);assert.equal(r.result.paid,'0');assert.equal(r.result.unspent,String(3n*p.ticketPrice));assert.equal(s.manager.pending,null);
  assert.equal(s.manager.blocked({method:'claimPrizes',args:[[1],account]}),false);
});
