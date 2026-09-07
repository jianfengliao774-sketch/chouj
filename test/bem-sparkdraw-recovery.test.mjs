import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {toQuantity,Interface,solidityPacked} from 'ethers';
import {matchesIntent} from '../bem-production-site/web/transaction-recovery.js';
import {createSparkDrawTransactions,GAME} from '../bem-production-site/web/sparkdraw-transactions.js';
import {profile} from '../bem-production-site/web/sparkdraw-profiles.js';
import {validateReadRequest} from '../bem-production-site/rpc.mjs';
const p=profile('0.1'),account='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222';
const runtime=JSON.parse(fs.readFileSync(new URL('./fixtures/drand/deployed-test-runtime.json',import.meta.url))).code;
const key='sparkdraw:v5:pending',hash=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),blockHash=hash(999);
function fixture(){
  const values=new Map(),txs=new Map(),receipts=new Map(),sent=[],mined=[];
  const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  let ctx={account,key:'wallet-a'},next=5n,head=10n,tick=100000,nonceFailure=false;
  const locks={request:async(k,o,fn)=>fn({})};
  const wallet={async request(q){if(q.method==='eth_accounts')return[ctx.account];if(q.method==='eth_chainId')return'0x38';if(q.method==='eth_getTransactionCount')return toQuantity(next);
    if(q.method==='eth_sendTransaction'){const tx={...q.params[0],hash:hash(sent.length+1),input:q.params[0].data,blockHash:null,blockNumber:null};sent.push(tx);txs.set(tx.hash,tx);next=BigInt(tx.nonce)+1n;return tx.hash;}throw Error(q.method);}};
  const rpc=async(method,args)=>{
    if(method==='eth_blockNumber')return toQuantity(head);if(method==='eth_getCode')return runtime;
    if(method==='eth_estimateGas')return'0x186a0';if(method==='eth_gasPrice')return'0x2faf080';
    if(method==='eth_getTransactionByHash')return txs.get(args[0])||null;if(method==='eth_getTransactionReceipt')return receipts.get(args[0])||null;
    if(method==='eth_getBlockByNumber'){const number=args[0]==='latest'?head:BigInt(args[0]);return{number:toQuantity(number),hash:blockHash,transactions:args[1]?mined.filter(t=>BigInt(t.blockNumber)===number):[]};}
    if(method==='eth_getTransactionCount'){if(nonceFailure)throw Error('RPC offline');return toQuantity(BigInt(args[1])>=12n&&mined.length?6n:5n);}
    throw Error(method);
  };
  const manager=()=>createSparkDrawTransactions({rpc,wallet:()=>wallet,context:()=>ctx,locks,storage,now:()=>tick});
  const m=manager(),buy=()=>m.execute({poolId:'0.1',method:'buy',args:[1,1000],kind:'buy',roundId:1,count:1000});
  function replace(change={},logs=true,status='0x1'){
    const old=sent[0],tx={...old,hash:hash(100),blockHash,blockNumber:'0xc',...change};if(change.input!==undefined)tx.data=change.input;
    txs.delete(old.hash);txs.set(tx.hash,tx);mined.push(tx);head=12n;tick+=11000;
    const event=GAME.encodeEventLog(GAME.getEvent('PurchaseResult'),[1,account,1000,800,800n*p.ticketPrice,200n*p.ticketPrice]);
    receipts.set(tx.hash,{transactionHash:tx.hash,blockHash,blockNumber:'0xc',status,logs:logs?[{...event,address:p.address}]:[]});return tx;
  }
  return{m,manager,buy,replace,sent,storage,values,txs,receipts,mined,advance:()=>{tick+=11000;},offline:()=>{nonceFailure=true;},switchWallet:()=>{ctx={account:other,key:'wallet-b'};},claim:(method='claimPrizes',rounds=[1])=>m.execute({poolId:'0.1',method,args:[rounds,ctx.account],kind:method})};
}
test('speedup resolves the replacement hash and actual partial fill after a reload',async()=>{
  const f=fixture(),original=await f.buy();const replacement=f.replace({gasPrice:'0x5f5e100'}),reloaded=f.manager();
  const r=await reloaded.check();assert.equal(r.status,'confirmed');assert.equal(r.originalHash,original);assert.equal(r.hash,replacement.hash);assert.equal(r.result.filled,800);assert.equal(reloaded.pending,null);assert.equal(reloaded.result(original).status,'confirmed');
});
test('wallet cancellation frees the original intent; the cancellation is never purchase success',async()=>{
  const f=fixture();await f.buy();f.replace({to:account,input:'0x'},false);const r=await f.m.check();assert.equal(r.status,'cancelled');assert.equal(r.result,null);assert.equal(f.m.pending,null);await f.claim();assert.equal(f.sent.length,2);
});
test('unrelated replacement, including a reverted replacement, consumes nonce without crediting a purchase',async()=>{
  const f=fixture();await f.buy();f.replace({to:other,input:'0x',value:'0x1'},false,'0x0');assert.equal((await f.m.check()).status,'replaced');assert.equal(f.m.pending,null);
});
test('pending purchase does not lock prizes or refunds; duplicate and overlapping claims are blocked',async()=>{
  const f=fixture();await f.buy();await f.claim();await f.claim('refundMany',[1]);assert.equal(f.sent.length,3);
  assert.deepEqual(f.sent.map(t=>BigInt(t.nonce)),[5n,6n,7n]);await assert.rejects(f.buy(),{code:'TRANSACTION_PENDING'});
  await assert.rejects(f.claim('claimPrizes',[1,2]),{code:'TRANSACTION_PENDING'});await f.claim('claimPrizes',[2]);assert.equal(f.sent.length,4);
});
test('switching wallet scopes pending records instead of blocking the new account',async()=>{
  const f=fixture();await f.buy();f.switchWallet();assert.equal(f.m.pending,null);await f.claim();assert.equal(f.sent[1].from,other);assert.equal(JSON.parse(f.storage.getItem(key)).pending.length,2);
});
test('manual recovery accepts a replacement for an existing hash and rejects another nonce without modifying storage',async()=>{
  const f=fixture();await f.buy();const id=f.m.pending.id,wrong={...f.sent[0],hash:hash(50),nonce:'0x9'};f.txs.set(wrong.hash,wrong);
  const before=f.storage.getItem(key);await assert.rejects(f.m.attach(wrong.hash,id),{code:'TRANSACTION_MISMATCH'});assert.equal(f.storage.getItem(key),before);
  const replacement=f.replace({to:account,input:'0x'},false);assert.equal((await f.m.attach(replacement.hash,id)).status,'cancelled');assert.equal(f.m.pending,null);
});
test('missing transactions and transient RPC failure never clear pending records',async()=>{
  const f=fixture();await f.buy();f.txs.clear();assert.equal(await f.m.check(),null);assert.ok(f.m.pending);f.advance();f.offline();await assert.rejects(f.m.check());assert.ok(f.m.pending);
});
test('noncanonical replacement receipt leaves the original intent pending',async()=>{
  const f=fixture();await f.buy();const tx=f.replace();f.receipts.get(tx.hash).blockHash=hash(888);assert.equal(await f.m.check(),null);assert.ok(f.m.pending);
});
test('legacy pending migrates; an unbound consumed nonce is not assumed to cancel a wrapped transaction',async()=>{
  const f=fixture();await f.buy();const row=f.m.pending;delete row.id;delete row.boundNonce;delete row.startBlock;f.storage.setItem(key,JSON.stringify(row));
  const replacement=f.replace({to:account,input:'0x'},false),m=f.manager();assert.equal(await m.check(),null);assert.ok(m.pending.recoveryNeeded);
  assert.equal((await m.attach(replacement.hash,m.pending.id)).status,'cancelled');assert.equal(m.pending,null);
});
test('missing wallet response can be recovered from the matching mined transaction',async()=>{
  const f=fixture();await f.buy();const row=f.m.pending;row.hash=null;delete row.boundNonce;f.storage.setItem(key,JSON.stringify({version:6,pending:[row],history:[]}));
  f.replace();assert.equal((await f.manager().check()).status,'confirmed');
});
test('manual stop is unverified and cannot let an approval flow treat cancellation as success',async()=>{
  const f=fixture(),original=await f.buy();await f.m.stopTracking(f.m.pending.id);assert.equal(f.m.pending,null);assert.equal(f.m.result(original).status,'unverified');assert.equal(f.sent.length,1);
});
test('replacement discovery permits only explicitly numbered full-block reads',()=>{
  assert.ok(validateReadRequest({jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:['0xc',true]}));
  assert.throws(()=>validateReadRequest({jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:['pending',true]}));
});
test('once the wrapper nonce is known, another matching call with a different nonce cannot resolve it',async()=>{
  const f=fixture();await f.buy();const r=f.m.pending;
  const wrapper=new Interface(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
  const tx={...f.sent[0],to:'0xdb9b1e94b5b69df7e401ddbede43491141047db3',nonce:'0x6'};
  tx.input=tx.data=wrapper.encodeFunctionData('redeemDelegations',[['0x'],['0x'+'0'.repeat(64)],[solidityPacked(['address','uint256','bytes'],[r.to,0,r.data])]]);
  assert.equal(matchesIntent(tx,r),false);delete r.boundNonce;assert.equal(matchesIntent(tx,r),true);
});
