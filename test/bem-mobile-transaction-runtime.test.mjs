import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSparkDrawTransactions} from '../bem-production-site/web/sparkdraw-transactions.js';
import {transactionId} from '../bem-production-site/web/transaction-runtime.js';

const key='sparkdraw:v5:pending',account='0x1111111111111111111111111111111111111111';
const runtime=JSON.parse(fs.readFileSync(new URL('./fixtures/drand/deployed-five-runtime.json',import.meta.url))).code;
const purchase={poolId:'5',method:'buySelected',args:[1,[0,17,9999]],kind:'buy',roundId:1,count:3};
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture(options={}){
  const values=new Map(),sent=[],requests=[],txs=new Map();
  const storage=options.storage??{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const wallet={async request(q){
    requests.push(q.method);
    if(options.hang===q.method)return new Promise(()=>{});
    if(q.method==='eth_accounts'){options.onIdentity?.(storage);return[account];}
    if(q.method==='eth_chainId')return'0x38';
    if(q.method==='eth_getTransactionCount')return'0x0';
    if(q.method==='eth_sendTransaction'){
      if(options.sendWait)await options.sendWait;
      const tx={...q.params[0],hash:hash(sent.length+1)};sent.push(tx);txs.set(tx.hash,tx);return tx.hash;
    }
    throw Error(q.method);
  }};
  const rpc=async(method,args)=>{
    if(method==='eth_getCode')return runtime;
    if(method==='eth_estimateGas')return'0x186a0';
    if(method==='eth_gasPrice')return'0x2faf080';
    if(method==='eth_blockNumber')return'0x100';
    if(method==='eth_getTransactionByHash')return txs.get(args[0])||null;
    throw Error(method);
  };
  const config={rpc,wallet:()=>wallet,context:()=>({account,key:'same'}),storage,
    locks:{request:async(k,o,run)=>run({})},...options};
  if(options.defaultStorage)delete config.storage;
  const create=()=>createSparkDrawTransactions(config);
  return{manager:create(),create,values,storage,requests,sent};
}
function safePreview(manager,code){
  assert.equal(manager.availabilityError,code);
  assert.equal(manager.pending,null);assert.deepEqual(manager.pendings,[]);assert.deepEqual(manager.history,[]);
  assert.equal(manager.result(hash(1)),null);assert.equal(manager.blocked(purchase),true);
}

test('a throwing localStorage property does not crash construction or public rendering and never sends',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('storage denied');}});
  try{
    const f=fixture({defaultStorage:true});safePreview(f.manager,'PENDING_STORAGE_UNAVAILABLE');
    assert.throws(()=>f.manager.prepare(purchase),{code:'PENDING_STORAGE_UNAVAILABLE'});
    await assert.rejects(f.manager.execute(purchase),{code:'PENDING_STORAGE_UNAVAILABLE'});
    assert.deepEqual(f.requests,[]);assert.deepEqual(f.sent,[]);
  }finally{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete globalThis.localStorage;}
});

test('denied reads and malformed JSON or rows preserve the journal and remain safely unpurchasable',async()=>{
  const denied=fixture({storage:{getItem(){throw Error('denied');},setItem(){throw Error('must not write');}}});
  safePreview(denied.manager,'PENDING_STORAGE_UNAVAILABLE');
  await assert.rejects(denied.manager.execute(purchase),{code:'PENDING_STORAGE_UNAVAILABLE'});
  for(const raw of ['{broken','null','',JSON.stringify({version:6,pending:[null],history:[]}),JSON.stringify({version:6,pending:[],history:[{}]})]){
    const f=fixture();f.values.set(key,raw);safePreview(f.manager,'PENDING_STORAGE_INVALID');
    assert.throws(()=>f.manager.prepare(purchase),{code:'PENDING_STORAGE_INVALID'});
    await assert.rejects(f.manager.execute(purchase),{code:'PENDING_STORAGE_INVALID'});
    assert.equal(f.values.get(key),raw);assert.deepEqual(f.requests,[]);assert.deepEqual(f.sent,[]);
  }
});

test('quota or silent writes cannot produce an untracked payment, including failure of the actual intent write',async()=>{
  for(const failure of ['quota','silent','intent-only']){
    const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem(k,v){
      if(failure==='silent')return;
      if(failure==='quota'||k===key)throw Error('quota exceeded');values.set(k,v);
    },removeItem:k=>values.delete(k)};
    const f=fixture({storage});await assert.rejects(f.manager.execute(purchase),{code:'PENDING_STORAGE_WRITE_FAILED'});
    assert.equal(f.manager.storageError,'PENDING_STORAGE_WRITE_FAILED');assert.equal(f.manager.availabilityError,'PENDING_STORAGE_WRITE_FAILED');
    assert.equal(f.manager.pending,null);assert.equal(f.sent.length,0);assert.equal(f.manager.busy,false);
  }
});

test('corruption during a wallet bridge read is checked again before transaction submission',async()=>{
  const f=fixture({onIdentity:storage=>storage.setItem(key,'not-json')});
  await assert.rejects(f.manager.execute(purchase),{code:'PENDING_STORAGE_INVALID'});
  assert.equal(f.sent.length,0);assert.equal(f.storage.getItem(key),'not-json');safePreview(f.manager,'PENDING_STORAGE_INVALID');
});

test('WebViews without randomUUID use CSPRNG UUIDs and preserve independent pending purchases after reload',async()=>{
  const random={getRandomValues:values=>globalThis.crypto.getRandomValues(values)},f=fixture({random});
  const first=await f.manager.execute(purchase),second=await f.manager.execute(purchase);
  assert.notEqual(first,second);assert.deepEqual(f.sent.map(tx=>BigInt(tx.nonce)),[0n,1n]);
  const reloaded=f.create(),rows=reloaded.pendings;
  assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.id)).size,2);
  for(const r of rows)assert.match(r.id,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.equal(reloaded.availabilityError,null);assert.equal(reloaded.blocked(purchase),false);
  assert.equal(rows[0].hash,first);assert.equal(rows[1].hash,second);
});

test('missing secure random and missing Web Locks have explicit capability errors and never start a payment',async()=>{
  assert.throws(()=>transactionId({}),{code:'SECURE_RANDOM_UNAVAILABLE'});
  for(const [options,code] of [[{random:{}},'SECURE_RANDOM_UNAVAILABLE'],[{locks:null},'LOCK_UNAVAILABLE'],[{locks:{}},'LOCK_UNAVAILABLE']]){
    const f=fixture(options);assert.equal(f.manager.availabilityError,code);
    assert.throws(()=>f.manager.prepare(purchase),{code});await assert.rejects(f.manager.execute(purchase),{code});
    assert.equal(f.sent.length,0);assert.deepEqual(f.requests,[]);assert.equal(f.manager.pending,null);
  }
});

test('latest history lookup works without Array.findLast and does not mutate persisted records',()=>{
  const f=fixture(),record={id:'one',account,poolId:'5',kind:'approve',roundId:'0',originalHash:hash(1),hash:hash(2),status:'confirmed',at:1};
  const raw=JSON.stringify({version:6,pending:[],history:[{...record,id:'old',at:0},record]});f.values.set(key,raw);
  const findLast=Array.prototype.findLast;
  try{Array.prototype.findLast=undefined;assert.equal(f.manager.result(hash(1)).id,'one');}
  finally{Array.prototype.findLast=findLast;}
  assert.equal(f.storage.getItem(key),raw);
});

test('a lost readonly wallet callback releases busy state without sending or automatically retrying',async()=>{
  for(const method of ['eth_getTransactionCount','eth_accounts','eth_chainId']){
    const f=fixture({hang:method,walletReadTimeout:10});await assert.rejects(f.manager.execute(purchase),{code:'WALLET_RESPONSE_TIMEOUT'});
    assert.equal(f.manager.busy,false);assert.equal(f.manager.pending,null);assert.equal(f.sent.length,0);
    assert.equal(f.requests.filter(m=>m===method).length,1);
  }
});

test('wallet signing remains pending beyond the readonly timeout and retains its durable record',async()=>{
  let release;const sendWait=new Promise(resolve=>{release=resolve;});
  const f=fixture({sendWait,walletReadTimeout:10});const run=f.manager.execute(purchase);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(f.manager.busy,true);assert.ok(f.manager.pending);assert.equal(f.sent.length,0);
  release();assert.equal(await run,hash(1));assert.equal(f.manager.busy,false);assert.equal(f.sent.length,1);
});
