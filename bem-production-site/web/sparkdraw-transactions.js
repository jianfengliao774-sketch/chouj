import {Interface,keccak256,getAddress,toQuantity} from 'ethers';
import abi from './sparkdraw-abi.json' with {type:'json'};
import {profile} from './sparkdraw-profiles.js';
import {requirePoolSales} from './sparkdraw-sales-policy.js';
import {SPARKDRAW as F} from './sparkdraw-config.js';
import {enforcePurchaseGasBudget} from './purchase-gas-policy.js';
import {matchesIntent,validReplacement,recoverTransaction,replacementStatus} from './transaction-recovery.js';
import {walletRequestRejected} from './wallet-request-errors.js';
export const GAME=new Interface(abi);
export const TOKEN=new Interface(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
const KEY='sparkdraw:v5:pending';
const fail=code=>{throw Object.assign(Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function parseTickets(mode,count,text){
  if(mode==='auto'){if(!/^[1-9][0-9]*$/.test(String(count))||Number(count)>5000)fail('TICKET_LIMIT');return{count:Number(count),tickets:null};}
  const set=new Set();for(const part of text.trim().split(/[,，\s]+/).filter(Boolean)){
    const m=/^(\d{1,5})(?:[-–](\d{1,5}))?$/.exec(part);if(!m)fail('TICKET_RANGE');
    const from=Number(m[1]),to=Number(m[2]||m[1]);if(from<1||to>10000||to<from)fail('TICKET_RANGE');
    for(let n=from;n<=to;n++){set.add(n-1);if(set.size>5000)fail('TICKET_LIMIT');}
  }
  if(!set.size)fail('TICKET_RANGE');return{count:set.size,tickets:[...set].sort((a,b)=>a-b)};
}
export function createSparkDrawTransactions({rpc,wallet,context,storage=localStorage,onChange=()=>{},locks=globalThis.navigator?.locks,now=Date.now,checkSales=requirePoolSales}){
  let busy=false,polling=false,cursor=0,prepared=null;const discovery=new Map();
  const load=()=>{
    const raw=storage.getItem(KEY),value=raw?JSON.parse(raw):null;
    if(!value)return{version:6,pending:[],history:[]};
    if(value.version===6&&Array.isArray(value.pending)&&Array.isArray(value.history))return value;
    if(value.account&&value.to&&value.data&&value.nonce!=null)return{version:6,pending:[{...value,id:'legacy:'+(value.hash||value.account+':'+value.nonce+':'+value.at)}],history:[]};
    fail('PENDING_STORAGE_INVALID');
  };
  const own=rows=>rows.filter(r=>same(r.account,context().account));
  const save=state=>{storage.setItem(KEY,JSON.stringify(state));onChange();};
  const methodOf=r=>r.method||(r.kind==='approve'?'approve':GAME.parseTransaction({data:r.data})?.name);
  const claims=new Set(['claimPrizes','refundMany']);
  function conflicts(r,input){
    const method=methodOf(r),next=input.method||input.kind;
    if(['buy','buySelected','approve'].includes(next))return ['buy','buySelected','approve'].includes(method);
    if(method!==next||r.poolId!==input.poolId)return false;
    if(!claims.has(next))return true;
    const existing=GAME.decodeFunctionData(method,r.data)[0].map(String),requested=(input.args?.[0]||[]).map(String);
    return !requested.length||requested.some(n=>existing.includes(n));
  }
  const blocked=input=>own(load().pending).some(r=>conflicts(r,input));
  async function mutate(record,fn){
    if(!locks)return false;
    return locks.request(KEY,{ifAvailable:true},lock=>{
      if(!lock)return false;const state=load(),index=state.pending.findIndex(r=>r.id===record.id);
      if(index<0||JSON.stringify(state.pending[index])!==JSON.stringify(record))return false;
      fn(state,index);save(state);return true;
    });
  }
  const identity=async(p,c)=>{const[a,chain]=await Promise.all([p.request({method:'eth_accounts'}),p.request({method:'eth_chainId'})]);if(BigInt(chain)!==56n||!a[0]||!same(a[0],c.account)||context().key!==c.key)fail('CONTEXT_CHANGED');};
  function prepare({poolId,method,args,kind}){
    checkSales(poolId,method);
    const c=context(),provider=wallet(),dest=profile(poolId);if(!c.account||!provider)fail('CONNECT_WALLET');
    if(!['buy','buySelected','approve','refundMany','claimPrizes','closeRound','fulfillRandomness','settle','openRefunds','burnUnclaimed','burnUnclaimedPrize'].includes(method))fail('ACTION_NOT_SUPPORTED');
    if(method==='approve'&&(!same(args[0],dest.address)||BigInt(args[1])<=0n||BigInt(args[1])>5000n*dest.ticketPrice))fail('APPROVAL_AMOUNT');
    if(claims.has(method)&&!same(args[1],c.account))fail('CONTEXT_CHANGED');
    const to=method==='approve'?F.bem:dest.address,data=(method==='approve'?TOKEN:GAME).encodeFunctionData(method,args),tx={from:c.account,to,data,value:'0x0'};
    const key=JSON.stringify([c.key,poolId,method,kind,to,data]);
    if(prepared&&prepared.key===key&&prepared.provider===provider&&(!prepared.done||now()-prepared.at<5000))return prepared.promise;
    const job={key,provider,at:now(),done:false,promise:null};prepared=job;
    job.promise=Promise.all([rpc('eth_getCode',[dest.address,'latest']),rpc('eth_estimateGas',[tx,'latest']),rpc('eth_gasPrice',[]),rpc('eth_blockNumber',[])]).then(([code,rawGas,rawPrice,startBlock])=>{
      if(keccak256(code)!==dest.runtimeHash)fail('CONTRACT_MISMATCH');
      const estimate=BigInt(rawGas),price=BigInt(rawPrice);if(estimate<=0n||estimate>16777216n)fail('GAS_LIMIT_EXCEEDED');if(price<=0n)fail('GAS_PRICE_UNAVAILABLE');
      const buffered=(estimate*120n+99n)/100n,gas=buffered>16777216n?16777216n:buffered;
      enforcePurchaseGasBudget(kind,gas,price);
      if(context().key!==c.key||wallet()!==provider)fail('CONTEXT_CHANGED');
      return {to,data,tx,gas,price,startBlock};
    }).catch(error=>{if(prepared===job)prepared=null;throw error;}).finally(()=>{job.done=true;});
    return job.promise;
  }
  function outcome(record,found){
    const {tx,receipt,matches}=found,p=profile(record.poolId);let result=null;
    if(matches&&BigInt(receipt.status)===1n&&record.kind==='buy'){
      const events=receipt.logs.filter(l=>same(l.address,p.address)).flatMap(l=>{try{const x=GAME.parseLog(l);return x?.name==='PurchaseResult'?[x]:[];}catch{return[];}});
      if(events.length!==1)fail('TRANSACTION_MISMATCH');const a=events[0].args;
      if(!same(a.buyer,record.account)||String(a.roundId)!==record.roundId||Number(a.requested)!==record.count||a.filled>a.requested||a.paid!==a.filled*p.ticketPrice||a.unspent!==(a.requested-a.filled)*p.ticketPrice)fail('TRANSACTION_MISMATCH');
      result={requested:Number(a.requested),filled:Number(a.filled),paid:String(a.paid),unspent:String(a.unspent)};
    }
    return{id:record.id,account:record.account,poolId:record.poolId,kind:record.kind,roundId:record.roundId,originalHash:record.hash,hash:tx.hash,
      status:matches?(BigInt(receipt.status)===1n?'confirmed':'reverted'):replacementStatus(tx),result,at:now()};
  }
  async function inspect(record,{force=false}={}){
    const discover=force||now()>=(discovery.get(record.id)||0);if(discover)discovery.set(record.id,now()+10000);
    const found=await recoverTransaction(rpc,record,{discover});
    if(found.receipt){const result=outcome(record,found);const changed=await mutate(record,(s,i)=>{s.pending.splice(i,1);s.history.push(result);s.history=s.history.slice(-50);});return changed?result:null;}
    if(JSON.stringify(found.updated)!==JSON.stringify(record))await mutate(record,(s,i)=>{s.pending[i]=found.updated;});
    return null;
  }
  async function check({force=false}={}){
    const records=own(load().pending);if(!records.length||polling)return null;polling=true;
    try{for(let n=0;n<Math.min(records.length,4);n++){const record=records[(cursor+n)%records.length],r=await inspect(record,{force});if(r)return r;}return null;}
    finally{cursor++;polling=false;}
  }
  async function execute({poolId,method,args,kind,count,roundId}){
    checkSales(poolId,method);
    const input={poolId,method,args,kind};
    const work=async()=>{
      if(busy)fail('TRANSACTION_IN_FLIGHT');busy=true;
      try{
        const c=context(),p=wallet();if(!c.account||!p)fail('CONNECT_WALLET');if(blocked(input))fail('TRANSACTION_PENDING');
        const {to,data,tx,gas,price,startBlock}=await prepare(input);
        let nonce=BigInt(await p.request({method:'eth_getTransactionCount',params:[c.account,'pending']}));
        for(const r of own(load().pending))nonce=nonce>BigInt(r.boundNonce??r.nonce)?nonce:BigInt(r.boundNonce??r.nonce)+1n;
        await identity(p,c);if(blocked(input))fail('TRANSACTION_PENDING');
        const record={id:globalThis.crypto.randomUUID(),poolId,method,kind,roundId:String(roundId||0),count:count||0,account:getAddress(c.account),to,data,nonce:String(nonce),startBlock,hash:null,at:now()};
        const state=load();state.pending.push(record);save(state);
        try{
          const hash=await p.request({method:'eth_sendTransaction',params:[{...tx,chainId:'0x38',nonce:toQuantity(nonce),gas:toQuantity(gas),gasPrice:toQuantity(price)}]});
          if(!/^0x[a-f0-9]{64}$/i.test(hash))fail('UNKNOWN_WALLET_RESULT');
          // Capture the actual outer nonce (including wallet wrappers) whenever
          // visible. A transient RPC miss must not turn a sent transaction into failure.
          let boundNonce;try{const sent=await rpc('eth_getTransactionByHash',[hash]);if(sent&&same(sent.hash,hash)&&matchesIntent(sent,{...record,hash}))boundNonce=String(BigInt(sent.nonce));}catch{}
          const latest=load(),i=latest.pending.findIndex(r=>r.id===record.id);if(i>=0){latest.pending[i]={...latest.pending[i],hash,...(boundNonce!=null?{boundNonce}:{})};save(latest);}return hash;
        }catch(e){if(walletRequestRejected(e)){const latest=load();latest.pending=latest.pending.filter(r=>r.id!==record.id);save(latest);}throw e;}
      }finally{busy=false;prepared=null;}
    };
    if(!locks)fail('LOCK_UNAVAILABLE');return locks.request(KEY,{ifAvailable:true},lock=>{if(!lock)fail('TRANSACTION_IN_FLIGHT');return work();});
  }
  return{execute,prepare,check,blocked,get pending(){return own(load().pending)[0]||null;},get pendings(){return own(load().pending);},get history(){return own(load().history);},get busy(){return busy;},
    result(hash){return own(load().history).findLast(r=>same(r.originalHash,hash)||same(r.hash,hash))||null;},
    async attach(hash,id){
      const record=own(load().pending).find(r=>id?r.id===id:true);if(!record||!/^0x[a-f0-9]{64}$/i.test(hash))fail('TRANSACTION_MISMATCH');
      const tx=await rpc('eth_getTransactionByHash',[hash]);if(!tx||!same(tx.hash,hash)||!matchesIntent(tx,record)&&!validReplacement(tx,record,{manual:true}))fail('TRANSACTION_MISMATCH');
      const updated={...record,candidateHash:hash,boundNonce:String(BigInt(tx.nonce))};
      if(!await mutate(record,(s,i)=>{s.pending[i]=updated;}))fail('TRANSACTION_IN_FLIGHT');
      return inspect(updated,{force:true});
    },
    async stopTracking(id){const record=own(load().pending).find(r=>r.id===id);if(!record)return;
      await mutate(record,(s,i)=>{s.pending.splice(i,1);s.history.push({id:record.id,account:record.account,poolId:record.poolId,kind:record.kind,roundId:record.roundId,originalHash:record.hash,hash:record.candidateHash||record.hash,status:'unverified',at:now()});s.history=s.history.slice(-50);});
    }
  };
}
