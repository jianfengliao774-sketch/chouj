import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSparkDrawTransactions,GAME} from '../bem-production-site/web/sparkdraw-transactions.js';
import {profile} from '../bem-production-site/web/sparkdraw-profiles.js';

const account='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222';
const code=JSON.parse(fs.readFileSync(new URL('./fixtures/drand/deployed-five-runtime.json',import.meta.url))).code;
const purchase={poolId:'5',method:'buySelected',args:[1,[0,17,9999]],kind:'buy',roundId:1,count:3};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function fixture({initialAccounts,estimate,changeAtNonce,wrongCode=false,expensive=false,walletError=null,nonceError=null,now=Date.now}={}){
  const requests=[],sent=[],values=new Map();let accountsReads=0,key='same',currentAccount=account;
  const wallet={async request(q){
    requests.push(q.method);
    if(q.method==='eth_accounts'){accountsReads++;return accountsReads===1&&initialAccounts?initialAccounts.promise:[currentAccount];}
    if(q.method==='eth_chainId')return'0x38';
    if(q.method==='eth_getTransactionCount'){
      if(nonceError)throw nonceError;
      if(changeAtNonce==='account')currentAccount=other;
      if(changeAtNonce==='context')key='changed';
      return'0x3';
    }
    if(q.method==='eth_sendTransaction'){sent.push(q.params[0]);throw walletError||Object.assign(Error('Fixture cancellation'),{code:4001});}
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
    now,storage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},locks:{request:async(k,o,fn)=>fn({})}});
  return{manager,requests,sent};
}

test('fee reads run together; fresh nonce and final identity still precede send',async()=>{
  const initialAccounts=deferred(),estimate=deferred(),f=fixture({initialAccounts,estimate});
  const run=assert.rejects(f.manager.execute(purchase),{code:4001});
  await new Promise(r=>setImmediate(r));
  for(const method of ['eth_getCode','eth_estimateGas','eth_gasPrice','eth_blockNumber'])assert.ok(f.requests.includes(method),method);
  assert.equal(f.requests.includes('eth_getTransactionCount'),true);assert.equal(f.manager.pending,null);
  initialAccounts.resolve([account]);estimate.resolve('0xf4240');await run;
  assert.equal(f.sent.length,1);assert.equal(f.requests.filter(m=>m==='eth_accounts').length,1);
  assert.equal(f.requests.filter(m=>m==='eth_chainId').length,1);
  assert.deepEqual(f.requests.slice(-3),['eth_accounts','eth_chainId','eth_sendTransaction']);
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

test('background preparation never touches the wallet; clicking reuses its estimate with fresh wallet identity and nonce',async()=>{
  const f=fixture();await f.manager.prepare(purchase);
  assert.deepEqual(f.requests,['eth_getCode','eth_estimateGas','eth_gasPrice','eth_blockNumber']);
  assert.equal(f.sent.length,0);assert.equal(f.manager.pending,null);
  await assert.rejects(f.manager.execute(purchase),{code:4001});
  assert.equal(f.requests.filter(m=>m==='eth_estimateGas').length,1);
  assert.deepEqual(f.requests.slice(-4),['eth_getTransactionCount','eth_accounts','eth_chainId','eth_sendTransaction']);
});

test('wrapped rejection clears the record, but an ambiguous send error stays tracked',async()=>{
  for(const [walletError,rejected] of [[{code:'4001'},true],[{code:-32603,data:{originalError:{code:4001}}},true],[{code:-32603,message:'transport failed'},false]]){
    const f=fixture({walletError});await assert.rejects(f.manager.execute(purchase));
    assert.equal(f.manager.pending===null,rejected);
  }
});


test('input loading overlaps the wallet nonce; send waits for preparation and final identity',async()=>{
  const input=deferred(),f=fixture();const run=assert.rejects(f.manager.execute(()=>input.promise),{code:4001});
  await new Promise(r=>setImmediate(r));assert.deepEqual(f.requests,['eth_getTransactionCount']);
  assert.equal(f.manager.pending,null);input.resolve(purchase);await run;
  assert.equal(f.sent.length,1);assert.deepEqual(f.requests.slice(-3),['eth_accounts','eth_chainId','eth_sendTransaction']);
});
test('a slow preparation refreshes the early nonce, and a failed branch never sends',async()=>{
  let time=0;const input=deferred(),f=fixture({now:()=>time});
  const run=assert.rejects(f.manager.execute(()=>input.promise),{code:4001});await new Promise(r=>setImmediate(r));
  time=5000;input.resolve(purchase);await run;assert.equal(f.requests.filter(m=>m==='eth_getTransactionCount').length,2);
  const bad=fixture({nonceError:Error('nonce offline')});await assert.rejects(bad.manager.execute(purchase),/nonce offline/);
  assert.equal(bad.sent.length,0);assert.equal(bad.manager.pending,null);
  const rejected=fixture();await assert.rejects(rejected.manager.execute(()=>{throw Error('load failed');}),/load failed/);
  assert.equal(rejected.sent.length,0);assert.equal(rejected.manager.pending,null);
});
test('editing a warmed ticket array invalidates calldata; identical values reuse preparation',async()=>{
  const f=fixture(),input={...purchase,args:[1,Array.from({length:5000},(_,i)=>i)]};
  const prepared=await f.manager.prepare(input);assert.strictEqual(await f.manager.prepare(input),prepared);
  input.args[1][4999]=9999;await assert.rejects(f.manager.execute(input),{code:4001});
  assert.equal(f.requests.filter(m=>m==='eth_estimateGas').length,2);
  assert.equal(Number(GAME.decodeFunctionData('buySelected',f.sent[0].data)[1][4999]),9999);
});
