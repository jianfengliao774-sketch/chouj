import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSparkDrawTransactions,GAME} from '../bem-production-site/web/sparkdraw-transactions.js';
import {profile} from '../bem-production-site/web/sparkdraw-profiles.js';

const account='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222';
const code=JSON.parse(fs.readFileSync(new URL('./fixtures/drand/deployed-five-runtime.json',import.meta.url))).code;
const purchase={poolId:'5',method:'buySelected',args:[1,[0,17,9999]],kind:'buy',roundId:1,count:3};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function fixture({initialAccounts,estimate,changeAtNonce,wrongCode=false,expensive=false}={}){
  const requests=[],sent=[],values=new Map();let accountsReads=0,key='same',currentAccount=account;
  const wallet={async request(q){
    requests.push(q.method);
    if(q.method==='eth_accounts'){accountsReads++;return accountsReads===1&&initialAccounts?initialAccounts.promise:[currentAccount];}
    if(q.method==='eth_chainId')return'0x38';
    if(q.method==='eth_getTransactionCount'){
      if(changeAtNonce==='account')currentAccount=other;
      if(changeAtNonce==='context')key='changed';
      return'0x3';
    }
    if(q.method==='eth_sendTransaction'){sent.push(q.params[0]);throw Object.assign(Error('Fixture cancellation'),{code:4001});}
    throw Error(q.method);
  }};
  const rpc=async method=>{
    requests.push(method);
    if(method==='eth_getCode')return wrongCode?'0x00':code;
    if(method==='eth_estimateGas')return estimate?estimate.promise:'0xf4240';
    if(method==='eth_gasPrice')return expensive?'0x3b9aca00':'0x2faf080';
    if(method==='eth_blockNumber')return'0x100';
    throw Error(method);
  };
  const manager=createSparkDrawTransactions({rpc,wallet:()=>wallet,context:()=>({account,key}),
    storage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},locks:{request:async(k,o,fn)=>fn({})}});
  return{manager,requests,sent};
}

test('identity, code and fee reads start together; fresh nonce and final identity still precede send',async()=>{
  const initialAccounts=deferred(),estimate=deferred(),f=fixture({initialAccounts,estimate});
  const run=assert.rejects(f.manager.execute(purchase),{code:4001});
  for(const method of ['eth_accounts','eth_chainId','eth_getCode','eth_estimateGas','eth_gasPrice','eth_blockNumber'])assert.ok(f.requests.includes(method),method);
  assert.equal(f.requests.includes('eth_getTransactionCount'),false);assert.equal(f.manager.pending,null);
  initialAccounts.resolve([account]);estimate.resolve('0xf4240');await run;
  assert.equal(f.sent.length,1);assert.equal(f.requests.filter(m=>m==='eth_accounts').length,2);
  assert.equal(f.requests.filter(m=>m==='eth_chainId').length,2);
  assert.deepEqual(f.requests.slice(-4),['eth_getTransactionCount','eth_accounts','eth_chainId','eth_sendTransaction']);
  const tx=f.sent[0];assert.equal(tx.to,profile('5').address);assert.equal(tx.nonce,'0x3');assert.equal(tx.chainId,'0x38');
  assert.equal(tx.data,GAME.encodeFunctionData('buySelected',purchase.args));assert.equal(BigInt(tx.gas),1200000n);
  assert.equal(f.manager.pending,null);
});

test('final identity catches an account switch without an event, and a changed UI context during nonce read',async()=>{
  for(const changeAtNonce of ['account','context']){
    const f=fixture({changeAtNonce});await assert.rejects(f.manager.execute(purchase),{code:'CONTEXT_CHANGED'});
    assert.equal(f.sent.length,0);assert.equal(f.manager.pending,null);
  }
});

test('parallel preflight cannot bypass wrong code, fee ceiling or the initial wallet identity',async()=>{
  for(const [options,code] of [[{wrongCode:true},'CONTRACT_MISMATCH'],[{expensive:true},'GAS_FEE_CAP_EXCEEDED'],[{initialAccounts:{promise:Promise.resolve([other])}},'CONTEXT_CHANGED']]){
    const f=fixture(options);await assert.rejects(f.manager.execute(purchase),{code});
    assert.equal(f.sent.length,0);assert.equal(f.manager.pending,null);
  }
});

test('each user retry obtains fresh contract and fee reads; no completed preflight is cached',async()=>{
  const f=fixture();for(let i=0;i<2;i++)await assert.rejects(f.manager.execute(purchase),{code:4001});
  for(const method of ['eth_getCode','eth_estimateGas','eth_gasPrice','eth_getTransactionCount'])assert.equal(f.requests.filter(m=>m===method).length,2);
  assert.equal(f.sent.length,2);assert.equal(f.manager.pending,null);
});
