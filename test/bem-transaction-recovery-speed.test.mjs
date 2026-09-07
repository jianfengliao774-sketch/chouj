import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalReceipt,recoverTransaction} from '../bem-production-site/web/transaction-recovery.js';

const hash=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture(){
  const record={account:'0x'+'1'.repeat(40),to:'0x'+'2'.repeat(40),data:'0x12345678',nonce:'5',hash:hash(1)};
  const tx={hash:record.hash,from:record.account,to:record.to,input:record.data,value:'0x0',chainId:'0x38',nonce:'0x5',blockHash:hash(9),blockNumber:'0x10'};
  const receipt={transactionHash:tx.hash,blockHash:tx.blockHash,blockNumber:tx.blockNumber,status:'0x1',logs:[]};
  const block={hash:tx.blockHash,number:tx.blockNumber};
  const state={tx,receipt,block},calls=[];
  const rpc=async(method,args)=>{
    calls.push([method,args]);
    if(method==='eth_getTransactionByHash')return state.tx;
    if(method==='eth_getTransactionReceipt')return state.receipt;
    if(method==='eth_getBlockByNumber')return state.block;
    throw Error(method);
  };
  return{record,state,calls,rpc};
}

test('known-hash recovery starts transaction and receipt reads together and reuses the receipt',async()=>{
  const f=fixture();let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const rpc=(method,args)=>{
    const value=f.rpc(method,args);
    return method==='eth_getTransactionByHash'?gate.then(()=>value):value;
  };
  const pending=recoverTransaction(rpc,f.record,{discover:false});
  assert.deepEqual(f.calls.map(([method])=>method),['eth_getTransactionByHash','eth_getTransactionReceipt']);
  release();
  const found=await pending;
  assert.equal(found.receipt,f.state.receipt);assert.equal(found.matches,true);assert.equal(found.updated.boundNonce,'5');
  assert.deepEqual(f.calls.map(([method])=>method),['eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber']);
});

test('a missing transaction or pending receipt cannot confirm an intent',async()=>{
  for(const change of [{tx:null},{receipt:null},{tx:{blockHash:null,blockNumber:null}}]){
    const f=fixture();
    if(change.tx===null)f.state.tx=null;
    else if(change.tx)Object.assign(f.state.tx,change.tx);
    else f.state.receipt=null;
    const found=await recoverTransaction(f.rpc,f.record,{discover:false});
    assert.equal(found.receipt,undefined);
    assert.equal(f.calls.some(([method])=>method==='eth_getBlockByNumber'),false);
  }
});

test('parallel receipt reads retain canonical-block, transaction-hash, nonce and status checks',async()=>{
  for(const change of [
    f=>{f.state.block.hash=hash(10);},
    f=>{f.state.receipt.blockHash=hash(10);},
    f=>{f.state.receipt.transactionHash=hash(10);}
  ]){
    const f=fixture();change(f);
    assert.equal((await recoverTransaction(f.rpc,f.record,{discover:false})).receipt,undefined);
  }
  for(const change of [
    f=>{f.state.tx.hash=hash(10);},
    f=>{f.record.boundNonce='5';f.state.tx.nonce='0x6';},
    f=>{f.state.tx.blockNumber='0x11';},
    f=>{f.state.receipt.status='0x2';}
  ]){
    const f=fixture();change(f);
    await assert.rejects(recoverTransaction(f.rpc,f.record,{discover:false}),{code:'TRANSACTION_MISMATCH'});
  }
});

test('canonical receipt verification still fetches a receipt for replacement discovery',async()=>{
  const f=fixture();
  assert.equal(await canonicalReceipt(f.rpc,f.state.tx),f.state.receipt);
  assert.deepEqual(f.calls.map(([method])=>method),['eth_getTransactionReceipt','eth_getBlockByNumber']);
});
