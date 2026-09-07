import {Interface,keccak256,getAddress,toQuantity} from 'ethers';
import abi from './sparkdraw-abi.json' with {type:'json'};
import {profile} from './sparkdraw-profiles.js';
import {requirePoolSales} from './sparkdraw-sales-policy.js';
import {SPARKDRAW as F} from './sparkdraw-config.js';
import {enforcePurchaseGasBudget} from './purchase-gas-policy.js';
import {matchesIntent,validReplacement,recoverTransaction,replacementStatus} from './transaction-recovery.js';
import {walletRequestRejected} from './wallet-request-errors.js';
import {createTransactionJournal,transactionId} from './transaction-runtime.js';
import {waitForWalletResponse} from './wallet-response.js';
export const GAME=new Interface(abi);
export const TOKEN=new Interface(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
const KEY='sparkdraw:v5:pending';
const fail=code=>{throw Object.assign(Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const actions=new Set(['buy','buySelected','approve','refundMany','claimPrizes','closeRound','fulfillRandomness','settle','openRefunds','burnUnclaimed','burnUnclaimedPrize']);
const address=v=>typeof v==='string'&&/^0x[\da-f]{40}$/i.test(v);
const hash=v=>v==null||typeof v==='string'&&/^0x[\da-f]{64}$/i.test(v);
const uint=v=>typeof v==='string'&&(/^(0|[1-9]\d*)$/.test(v)||/^0x[\da-f]+$/i.test(v));
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function validateJournal(value){
  // Structural validation keeps malformed rows out of rendering, nonce selection
  // and claim comparison. Preserve the original bytes on every validation error.
  if(!object(value))fail('PENDING_STORAGE_INVALID');
  const legacy=value.version!==6&&value.account&&value.to&&value.data&&value.nonce!=null;
  const state=legacy?{version:6,pending:[{...value,id:'legacy:'+(value.hash||value.account+':'+value.nonce+':'+value.at)}],history:[]}:value;
  if(state.version!==6||!Array.isArray(state.pending)||!Array.isArray(state.history))fail('PENDING_STORAGE_INVALID');
  const basic=r=>object(r)&&typeof r.id==='string'&&r.id.length>0&&address(r.account)&&['0.1','5','10','50','100'].includes(r.poolId)&&
    (r.kind==='buy'||actions.has(r.kind))&&uint(r.roundId)&&Number.isFinite(r.at)&&r.at>=0;
  for(const r of state.pending){
    if(!basic(r)||!address(r.to)||typeof r.data!=='string'||r.data.length%2!==0||!/^0x[\da-f]{8,}$/i.test(r.data)||
      !uint(r.nonce)||(r.boundNonce!=null&&!uint(r.boundNonce))||(r.startBlock!=null&&!uint(r.startBlock))||
      !hash(r.hash)||!hash(r.candidateHash)||!Number.isInteger(r.count)||r.count<0||r.count>5000||
      (r.method!=null&&!actions.has(r.method)))fail('PENDING_STORAGE_INVALID');
  }
  for(const r of state.history){
    if(!basic(r)||!hash(r.originalHash)||!hash(r.hash)||!['confirmed','reverted','cancelled','replaced','unverified'].includes(r.status))fail('PENDING_STORAGE_INVALID');
    if(r.result!=null&&(!object(r.result)||!Number.isInteger(r.result.requested)||!Number.isInteger(r.result.filled)||
      r.result.requested<0||r.result.requested>5000||r.result.filled<0||r.result.filled>r.result.requested||!uint(r.result.paid)||!uint(r.result.unspent)))fail('PENDING_STORAGE_INVALID');
  }
  if(new Set(state.pending.map(r=>r.id)).size!==state.pending.length)fail('PENDING_STORAGE_INVALID');
  return state;
}
export function parseTickets(mode,count,text){
  if(mode==='auto'){if(!/^[1-9][0-9]*$/.test(String(count))||Number(count)>5000)fail('TICKET_LIMIT');return{count:Number(count),tickets:null};}
  const set=new Set();for(const part of text.trim().split(/[,，\s]+/).filter(Boolean)){
    const m=/^(\d{1,5})(?:[-–](\d{1,5}))?$/.exec(part);if(!m)fail('TICKET_RANGE');
    const from=Number(m[1]),to=Number(m[2]||m[1]);if(from<1||to>10000||to<from)fail('TICKET_RANGE');
    for(let n=from;n<=to;n++){set.add(n-1);if(set.size>5000)fail('TICKET_LIMIT');}
  }
  if(!set.size)fail('TICKET_RANGE');return{count:set.size,tickets:[...set].sort((a,b)=>a-b)};
}
export function createSparkDrawTransactions({rpc,wallet,context,storage,onChange=()=>{},locks=globalThis.navigator?.locks,now=Date.now,checkSales=requirePoolSales,random=globalThis.crypto,walletReadTimeout=5000}){
  let busy=false,polling=false,cursor=0,prepared=null;const discovery=new Map(),inspections=new Map();
  const journal=createTransactionJournal({key:KEY,storage,validate:validateJournal,onChange}),{load,save}=journal;
  const lockAvailable=()=>typeof locks?.request==='function';
  const availabilityError=()=>journal.error||(!lockAvailable()?'LOCK_UNAVAILABLE':
    typeof random?.randomUUID!=='function'&&typeof random?.getRandomValues!=='function'?'SECURE_RANDOM_UNAVAILABLE':null);
  function requireAvailable(){const code=availabilityError();if(code&&code!=='PENDING_STORAGE_WRITE_FAILED')fail(code);journal.requireWritable();}
  const own=rows=>rows.filter(r=>same(r.account,context().account));
  const methodOf=r=>r.method||(r.kind==='approve'?'approve':GAME.parseTransaction({data:r.data})?.name);
  const claims=new Set(['claimPrizes','refundMany']);
  function conflicts(r,input){
    const next=input.method||input.kind;
    // Each explicit purchase/approval is an independent intent. Pending records
    // still reserve distinct nonces and retain their own confirmation history.
    if(['buy','buySelected','approve'].includes(next))return false;
    const method=methodOf(r);
    if(method!==next||r.poolId!==input.poolId)return false;
    if(!claims.has(next))return true;
    const existing=GAME.decodeFunctionData(method,r.data)[0].map(String),requested=(input.args?.[0]||[]).map(String);
    return !requested.length||requested.some(n=>existing.includes(n));
  }
  const hasConflict=input=>own(load().pending).some(r=>conflicts(r,input));
  const blocked=input=>{try{return hasConflict(input);}catch{return true;}};
  async function mutate(record,fn){
    if(!lockAvailable())return false;
    return locks.request(KEY,{ifAvailable:true},lock=>{
      if(!lock)return false;const state=load(),index=state.pending.findIndex(r=>r.id===record.id);
      if(index<0||JSON.stringify(state.pending[index])!==JSON.stringify(record))return false;
      fn(state,index);save(state);return true;
    });
  }
  const walletRead=(p,request)=>waitForWalletResponse(()=>p.request(request),{timeout:walletReadTimeout});
  const identity=async(p,c)=>{const[a,chain]=await Promise.all([walletRead(p,{method:'eth_accounts'}),walletRead(p,{method:'eth_chainId'})]);if(BigInt(chain)!==56n||!a[0]||!same(a[0],c.account)||context().key!==c.key)fail('CONTEXT_CHANGED');};
  function prepare({poolId,method,args,kind}){
    checkSales(poolId,method);
    requireAvailable();
    const c=context(),provider=wallet(),dest=profile(poolId);if(!c.account||!provider)fail('CONNECT_WALLET');
    if(!actions.has(method))fail('ACTION_NOT_SUPPORTED');
    if(method==='approve'&&(!same(args[0],dest.address)||BigInt(args[1])<=0n||BigInt(args[1])>5000n*dest.ticketPrice))fail('APPROVAL_AMOUNT');
    if(claims.has(method)&&!same(args[1],c.account))fail('CONTEXT_CHANGED');
    // Compare values before ABI encoding: 5,000 tickets produce 320 KB of data.
    // Never cache by array identity; callers may edit their selection in place.
    const key=JSON.stringify([c.key,poolId,method,kind,args],(_,v)=>typeof v==='bigint'?String(v):v);
    if(prepared&&prepared.key===key&&prepared.provider===provider&&(!prepared.done||now()-prepared.at<5000))return prepared.promise;
    const to=method==='approve'?F.bem:dest.address,data=(method==='approve'?TOKEN:GAME).encodeFunctionData(method,args),tx={from:c.account,to,data,value:'0x0'};
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
  async function inspectRecord(record,{force=false,discover:allowDiscovery=true}={}){
    const discover=allowDiscovery&&(force||now()>=(discovery.get(record.id)||0));if(discover)discovery.set(record.id,now()+10000);
    const found=await recoverTransaction(rpc,record,{discover});
    if(found.receipt){const result=outcome(record,found);const changed=await mutate(record,(s,i)=>{s.pending.splice(i,1);s.history.push(result);s.history=s.history.slice(-50);});return changed?result:null;}
    if(JSON.stringify(found.updated)!==JSON.stringify(record))await mutate(record,(s,i)=>{s.pending[i]=found.updated;});
    return null;
  }
  function inspect(record,options){
    // A returned hash can arrive while an older no-hash lookup is still running.
    // Share only identical snapshots; the new hash must not wait for discovery.
    const key=JSON.stringify(record);
    if(inspections.has(key))return inspections.get(key);
    const run=inspectRecord(record,options).finally(()=>inspections.delete(key));
    inspections.set(key,run);return run;
  }
  async function checkHash(hash,{discover=false}={}){
    const record=own(load().pending).find(r=>same(r.hash,hash)||same(r.candidateHash,hash));
    return record?inspect(record,{discover}):null;
  }
  async function check({force=false}={}){
    const records=own(load().pending);if(!records.length||polling)return null;polling=true;
    try{for(let n=0;n<Math.min(records.length,4);n++){const record=records[(cursor+n)%records.length],r=await inspect(record,{force});if(r)return r;}return null;}
    finally{cursor++;polling=false;}
  }
  async function execute(request){
    if(typeof request!=='function')checkSales(request.poolId,request.method);
    requireAvailable();
    const work=async()=>{
      if(busy)fail('TRANSACTION_IN_FLIGHT');busy=true;
      try{
        const c=context(),p=wallet();if(!c.account||!p)fail('CONNECT_WALLET');
        // Start the wallet bridge read on the user action, alongside read-only
        // chain preparation. Signing still waits for both and a final identity check.
        const nonceStarted=now();
        const nonceRead=walletRead(p,{method:'eth_getTransactionCount',params:[c.account,'pending']}).then(value=>({value}),error=>({error}));
        const plan=Promise.resolve().then(()=>typeof request==='function'?request():request).then(async input=>{
          checkSales(input.poolId,input.method);if(hasConflict(input))fail('TRANSACTION_PENDING');
          return{input,prepared:await prepare(input)};
        });
        const [nonceResult,{input,prepared:ready}]=await Promise.all([nonceRead,plan]);
        if(nonceResult.error)throw nonceResult.error;
        const rawNonce=nonceResult.value;
        const {poolId,method,kind,count,roundId}=input,{to,data,tx,gas,price,startBlock}=ready;
        // A slow RPC retry must not carry an early nonce across a long wait.
        let nonce=BigInt(now()-nonceStarted<5000?rawNonce:await walletRead(p,{method:'eth_getTransactionCount',params:[c.account,'pending']}));
        for(const r of own(load().pending))nonce=nonce>BigInt(r.boundNonce??r.nonce)?nonce:BigInt(r.boundNonce??r.nonce)+1n;
        await identity(p,c);if(wallet()!==p||hasConflict(input))fail(wallet()!==p?'CONTEXT_CHANGED':'TRANSACTION_PENDING');
        const record={id:transactionId(random),poolId,method,kind,roundId:String(roundId||0),count:count||0,account:getAddress(c.account),to,data,nonce:String(nonce),startBlock,hash:null,at:now()};
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
    if(!lockAvailable())fail('LOCK_UNAVAILABLE');return locks.request(KEY,{ifAvailable:true},lock=>{if(!lock)fail('TRANSACTION_IN_FLIGHT');return work();});
  }
  return{execute,prepare,check,checkHash,blocked,get pending(){return own(journal.read().pending)[0]||null;},get pendings(){return own(journal.read().pending);},get history(){return own(journal.read().history);},get busy(){return busy;},
    get storageError(){return journal.error;},get availabilityError(){return availabilityError();},
    result(hash){const history=own(journal.read().history);for(let i=history.length-1;i>=0;i--)if(same(history[i].originalHash,hash)||same(history[i].hash,hash))return history[i];return null;},
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
