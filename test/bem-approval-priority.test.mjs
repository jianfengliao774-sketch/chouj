import test from 'node:test';
import assert from 'node:assert/strict';
import {createSparkDrawTransactions,TOKEN} from '../bem-production-site/web/sparkdraw-transactions.js';
import {profile} from '../bem-production-site/web/sparkdraw-profiles.js';
import {SPARKDRAW as F} from '../bem-production-site/web/sparkdraw-config.js';

const account='0x'+'1'.repeat(40),hash=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture({older=false,holdHash=null,holdDiscovery=false}={}){
  const p=profile('0.1'),calls=[],block={number:'0xc',hash:hash(99)};
  const make=(id,nonce)=>({id:String(id),hash:hash(id),poolId:'0.1',method:'approve',kind:'approve',account,to:F.bem,
    data:TOKEN.encodeFunctionData('approve',[p.address,1000n*p.ticketPrice]),nonce:String(nonce),boundNonce:String(nonce),roundId:'0',count:0,at:1});
  const target=make(2,6),old=make(1,5),state={version:6,pending:older?[old,target]:[target],history:[]};
  const rows=new Map(),receipts=new Map(),stored=new Map([['sparkdraw:v5:pending',JSON.stringify(state)]]);
  for(const r of state.pending){
    rows.set(r.hash,{hash:r.hash,from:r.account,to:r.to,input:r.data,value:'0x0',chainId:'0x38',nonce:'0x'+Number(r.nonce).toString(16),blockHash:block.hash,blockNumber:block.number});
    receipts.set(r.hash,{transactionHash:r.hash,blockHash:block.hash,blockNumber:block.number,status:'0x1',logs:[]});
  }
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const rpc=async(method,args)=>{
    calls.push([method,args]);
    if(method==='eth_getTransactionByHash'){if(args[0]===holdHash)await gate;return rows.get(args[0])||null;}
    if(method==='eth_getTransactionReceipt')return receipts.get(args[0])||null;
    if(method==='eth_getBlockByNumber'){
      if(args[0]==='latest'){if(!holdDiscovery)return null;await gate;}
      return args[1]?{...block,transactions:[]}:block;
    }
    if(method==='eth_getTransactionCount'&&holdDiscovery)return '0x7';
    throw Error(method);
  };
  const manager=createSparkDrawTransactions({rpc,wallet:()=>null,context:()=>({account,key:'same'}),checkSales:()=>{},
    storage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)},locks:{request:async(key,options,fn)=>fn({})}});
  return{manager,target,old,rows,receipts,calls,release,stored};
}

test('current approval confirms while an unrelated global pending check is still waiting',{timeout:2000},async()=>{
  const f=fixture({older:true,holdHash:hash(1)}),globalCheck=f.manager.check();
  try{
    assert.equal(f.calls[0][1][0],f.old.hash);
    const result=await f.manager.checkHash(f.target.hash);
    assert.equal(result.status,'confirmed');assert.equal(result.originalHash,f.target.hash);
    assert.equal(f.manager.result(f.target.hash).status,'confirmed');
    assert.equal(f.manager.pendings.length,1);assert.equal(f.manager.pending.id,f.old.id);
  }finally{f.release();await globalCheck;}
});

test('simultaneous targeted and global checks of the same record share one RPC inspection',{timeout:2000},async()=>{
  const f=fixture({holdHash:hash(2)});
  const first=f.manager.checkHash(f.target.hash),second=f.manager.checkHash(f.target.hash),globalCheck=f.manager.check();
  assert.equal(f.calls.filter(([method])=>method==='eth_getTransactionByHash').length,1);
  assert.equal(f.calls.filter(([method])=>method==='eth_getTransactionReceipt').length,1);
  f.release();
  const results=await Promise.all([first,second,globalCheck]);
  assert.ok(results.every(r=>r?.status==='confirmed'));
  assert.equal(f.manager.history.length,1);assert.equal(f.manager.pendings.length,0);
});

test('targeted approval checks do not discover replacements by default or accept mismatched intent',async()=>{
  const f=fixture();f.rows.get(f.target.hash).from='0x'+'3'.repeat(40);
  await assert.rejects(f.manager.checkHash(f.target.hash),{code:'TRANSACTION_MISMATCH'});
  assert.equal(f.manager.result(f.target.hash),null);assert.equal(f.manager.pendings.length,1);
  assert.equal(f.calls.some(([method,args])=>method==='eth_getBlockByNumber'&&args[0]==='latest'),false);
  f.rows.delete(f.target.hash);f.receipts.delete(f.target.hash);
  assert.equal(await f.manager.checkHash(f.target.hash),null);
  assert.equal(f.calls.some(([method,args])=>method==='eth_getBlockByNumber'&&args[0]==='latest'),false);
});

test('targeted approval cancellation and revert are terminal outcomes, never confirmation',async()=>{
  for(const kind of ['cancelled','reverted']){
    const f=fixture();
    if(kind==='cancelled'){
      const candidate=hash(3),original=f.rows.get(f.target.hash),receipt=f.receipts.get(f.target.hash);
      f.rows.set(candidate,{...original,hash:candidate,to:account,input:'0x'});
      f.receipts.set(candidate,{...receipt,transactionHash:candidate});
      const stored=JSON.parse(f.stored.get('sparkdraw:v5:pending'));stored.pending[0].candidateHash=candidate;
      f.stored.set('sparkdraw:v5:pending',JSON.stringify(stored));
    }else f.receipts.get(f.target.hash).status='0x0';
    const result=await f.manager.checkHash(f.target.hash);
    assert.equal(result.status,kind);assert.equal(f.manager.result(f.target.hash).status,kind);
    assert.equal(f.manager.pendings.length,0);
  }
});

test('a newly bound hash does not join or get overwritten by its older no-hash inspection',{timeout:2000},async()=>{
  const f=fixture({holdDiscovery:true}),storageKey='sparkdraw:v5:pending';
  const oldRecord={...f.target,hash:null,nonce:'5'};delete oldRecord.boundNonce;
  f.stored.set(storageKey,JSON.stringify({version:6,pending:[oldRecord],history:[]}));
  const oldCheck=f.manager.check();
  try{
    assert.deepEqual(f.calls,[['eth_getBlockByNumber',['latest',false]]]);
    const returned={...oldRecord,hash:f.target.hash,boundNonce:'6'};
    f.stored.set(storageKey,JSON.stringify({version:6,pending:[returned],history:[]}));
    const currentCheck=f.manager.checkHash(f.target.hash);
    assert.ok(f.calls.some(([method,args])=>method==='eth_getTransactionByHash'&&args[0]===f.target.hash),
      'The updated record starts its own inspection before old nonce discovery is released');
    const result=await currentCheck;
    assert.equal(result.status,'confirmed');assert.equal(result.originalHash,f.target.hash);
    const confirmed=f.stored.get(storageKey);
    f.release();await oldCheck;
    assert.equal(f.stored.get(storageKey),confirmed,'A late old-snapshot result cannot restore or overwrite the confirmed record');
    assert.equal(f.manager.history.length,1);assert.equal(f.manager.pendings.length,0);
  }finally{f.release();await oldCheck;}
});
