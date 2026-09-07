import {toQuantity} from 'ethers';
import {verifyWalletTransactionEnvelope} from './wallet-transaction-envelope.js';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const mismatch=()=>{throw Object.assign(Error('TRANSACTION_MISMATCH'),{code:'TRANSACTION_MISMATCH'});};
export function matchesIntent(tx,record){try{if(record.boundNonce!=null&&BigInt(tx.nonce)!==BigInt(record.boundNonce))return false;verifyWalletTransactionEnvelope(tx,{...record,hash:tx.hash,nonceFloor:record.nonce});return true;}catch{return false;}}
export function validReplacement(tx,record,{manual=false}={}){
  if(!tx||!same(tx.from,record.account)||BigInt(tx.chainId)!==56n)return false;
  const nonce=record.boundNonce??(manual?record.nonce:null);
  return nonce!==null&&BigInt(tx.nonce)===BigInt(nonce);
}
export async function canonicalReceipt(rpc,tx){
  const receipt=await rpc('eth_getTransactionReceipt',[tx.hash]);if(!receipt||!tx.blockHash)return null;
  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  if(!block||!same(block.hash,receipt.blockHash)||!same(block.hash,tx.blockHash)||!same(tx.hash,receipt.transactionHash))return null;
  if(tx.blockNumber!==receipt.blockNumber||!['0x0','0x1'].includes(receipt.status))mismatch();
  return receipt;
}
// Find the one canonical block where this sender's nonce was consumed. Numeric
// block reads avoid mixing "latest" snapshots; no mempool absence is finality.
async function replacementAtNonce(rpc,record,head,nonce){
  let low=0n,high=BigInt(head.number);
  if(record.startBlock!=null&&BigInt(record.startBlock)<=high){
    const start=BigInt(record.startBlock),count=BigInt(await rpc('eth_getTransactionCount',[record.account,toQuantity(start)]));
    if(count<=nonce)low=start;
  }
  while(low<high){const mid=(low+high)/2n,count=BigInt(await rpc('eth_getTransactionCount',[record.account,toQuantity(mid)]));if(count>nonce)high=mid;else low=mid+1n;}
  const block=await rpc('eth_getBlockByNumber',[toQuantity(low),true]);
  if(!block||!Array.isArray(block.transactions))return null;
  // EIP-7702 authorization can consume a nonce without a transaction from this
  // sender. That is not proof that the original purchase was cancelled.
  return block.transactions.find(tx=>tx&&same(tx.from,record.account)&&BigInt(tx.nonce)===nonce)||null;
}
export async function recoverTransaction(rpc,record,{discover=true}={}){
  let updated={...record};
  for(const hash of [...new Set([record.candidateHash,record.hash].filter(Boolean))]){
    const tx=await rpc('eth_getTransactionByHash',[hash]);if(!tx)continue;
    if(!same(tx.hash,hash))mismatch();
    const matches=matchesIntent(tx,updated);
    if(!matches&&!validReplacement(tx,updated))mismatch();
    if(matches)updated.boundNonce=String(BigInt(tx.nonce));
    const receipt=await canonicalReceipt(rpc,tx);
    if(receipt)return{updated,tx,receipt,matches};
  }
  if(!discover)return{updated};
  const head=await rpc('eth_getBlockByNumber',['latest',false]);if(!head)return{updated};
  const nonce=BigInt(updated.boundNonce??updated.nonce),count=BigInt(await rpc('eth_getTransactionCount',[updated.account,head.number]));
  if(count<=nonce)return{updated};
  const tx=await replacementAtNonce(rpc,updated,head,nonce);
  if(!tx)return{updated:{...updated,recoveryNeeded:true}};
  const matches=matchesIntent(tx,updated);
  if(!matches&&!validReplacement(tx,updated))return{updated:{...updated,recoveryNeeded:true}};
  const receipt=await canonicalReceipt(rpc,tx);if(!receipt)return{updated};
  return{updated:{...updated,boundNonce:String(BigInt(tx.nonce))},tx,receipt,matches};
}
export function replacementStatus(tx){return same(tx.to,tx.from)&&BigInt(tx.value)===0n&&(tx.input??tx.data)==='0x'?'cancelled':'replaced';}
