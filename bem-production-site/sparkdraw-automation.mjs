import fs from 'node:fs/promises';
import path from 'node:path';
import {Wallet,Interface,keccak256} from 'ethers';
import {POOL_IDS,profile,VERIFIER,VERIFIER_HASH} from './web/sparkdraw-profiles.js';
import {AUTOMATION_WALLET} from './web/automation-wallet.js';
import {SPARKDRAW as F} from './web/sparkdraw-config.js';
import {ACTIONS,AUTOMATION_LIMITS as L,chooseAutomationAction,validateAutomationTransaction} from './sparkdraw-automation-core.mjs';
const root=process.env.STATE_DIRECTORY,publicRoot=process.env.RUNTIME_DIRECTORY,credentials=process.env.CREDENTIALS_DIRECTORY;
if(!root||!publicRoot||!credentials||!process.env.SPARKDRAW_CONTROL)throw Error('AUTOMATION_CONFIGURATION_REQUIRED');
const signer=new Wallet((await fs.readFile(path.join(credentials,'sparkdraw-key'),'utf8')).trim());
if(signer.address!==AUTOMATION_WALLET)throw Error('EXECUTION_WALLET_MISMATCH');
const address=signer.address,game=new Interface(JSON.parse(await fs.readFile(new URL('./web/sparkdraw-abi.json',import.meta.url),'utf8')));
const endpoint=process.env.BEM_RPC_URL||'https://bsc-dataseed.bnbchain.org';
if(new URL(endpoint).protocol!=='https:')throw Error('HTTPS_RPC_REQUIRED');
let serial=0,stopped=false,enabled=false,balance='0',lastError=null,lastCheck=0,poolCursor=0;
const journalFile=path.join(root,'journal.json');
let journal,freshJournal=false;try{journal=JSON.parse(await fs.readFile(journalFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('INVALID_JOURNAL');freshJournal=true;journal={version:1,address,pending:null,spending:{},pools:{},history:[]};}
if(journal.address!==address||journal.version!==1||!journal.pools||!journal.spending)throw Error('JOURNAL_BINDING_MISMATCH');
const atomic=async(file,data,mode)=>{await fs.writeFile(file+'.tmp',JSON.stringify(data),{mode});await fs.rename(file+'.tmp',file);};
const save=()=>atomic(journalFile,journal,0o600);
const rpc=async(method,params)=>{const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++serial,method,params}),signal:AbortSignal.timeout(15000)});let d;try{d=await r.json();}catch{throw Error('RPC_UNAVAILABLE');}if(!r.ok||d.error)throw Error('RPC_UNAVAILABLE');return d.result;};
const read=async(id,name,args=[],tag='latest')=>game.decodeFunctionResult(name,await rpc('eth_call',[{to:profile(id).address,data:game.encodeFunctionData(name,args)},tag]));
const day=()=>new Date().toISOString().slice(0,10);
async function identity(){
  if(BigInt(await rpc('eth_chainId',[]))!==56n||keccak256(await rpc('eth_getCode',[VERIFIER,'latest']))!==VERIFIER_HASH)throw Error('CHAIN_IDENTITY_MISMATCH');
  for(const id of POOL_IDS)if(keccak256(await rpc('eth_getCode',[profile(id).address,'latest']))!==profile(id).runtimeHash)throw Error('POOL_IDENTITY_MISMATCH');
  lastCheck=Date.now();
}
async function publish(state){await atomic(path.join(publicRoot,'status.json'),{version:1,address,updatedAt:new Date().toISOString(),enabled,state,balanceWei:balance,error:lastError,
  dailyLimitWei:String(L.daily),spentTodayWei:journal.spending[day()]||'0',maxTransactionFeeWei:String(L.fee),
  pending:journal.pending?{hash:journal.pending.hash,pool:journal.pending.poolId,round:journal.pending.roundId,method:journal.pending.method}:null,
  history:journal.history.slice(-20).reverse()},0o644);}
async function pending(){
  const p=journal.pending;if(!p)return false;
  const {tx,poolId,roundId,method}=validateAutomationTransaction(p.raw,address);
  if(tx.hash!==p.hash||poolId!==p.poolId||roundId!==p.roundId||method!==p.method)throw Error('PENDING_BINDING_MISMATCH');
  const receipt=await rpc('eth_getTransactionReceipt',[p.hash]);
  if(receipt){
    const [header,latest]=await Promise.all([rpc('eth_getBlockByNumber',[receipt.blockNumber,false]),rpc('eth_blockNumber',[])]);
    if(!header||header.hash!==receipt.blockHash||BigInt(latest)-BigInt(receipt.blockNumber)<2n){await publish('confirming');return true;}
    if(receipt.from?.toLowerCase()!==address.toLowerCase()||receipt.to?.toLowerCase()!==tx.to.toLowerCase())throw Error('RECEIPT_MISMATCH');
    const spent=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice||tx.gasPrice),chargedDay=p.day;
    journal.spending[chargedDay]=String(BigInt(journal.spending[chargedDay]||0)+spent);
    const ok=BigInt(receipt.status)===1n;
    journal.history.push({hash:p.hash,pool:poolId,round:roundId,method,success:ok,gasWei:String(spent),at:new Date().toISOString()});journal.history=journal.history.slice(-200);
    journal.pools[poolId].rounds[roundId]={next:ok?0:Math.floor(Date.now()/1000)+60};journal.pending=null;await save();await publish(ok?'running':'transaction_reverted');return true;
  }
  const latestNonce=BigInt(await rpc('eth_getTransactionCount',[address,'latest']));
  if(latestNonce>BigInt(tx.nonce))throw Error('NONCE_REQUIRES_REVIEW');
  if(enabled&&Date.now()-(p.sentAt||0)>15000){p.sentAt=Date.now();await save();const hash=await rpc('eth_sendRawTransaction',[p.raw]);if(hash!==p.hash)throw Error('BROADCAST_HASH_MISMATCH');}
  await publish(enabled?'transaction_pending':'paused');return true;
}
async function inspect(id,rid,now,tag){
  const r=await read(id,'rounds',[rid],tag),status=Number(r[0]);
  const state={status,sold:Number(r[1]),trigger:Number([3,4].includes(status)?r[3]:r[3]||r[2])};
  if(status===1)state.early=Number((await read(id,'earlyDrawDeadline',[rid],tag))[0]);
  if(status===3){state.beacon=String((await read(id,'beaconRound',[rid],tag))[0]);state.available=F.genesis+(Number(state.beacon)-1)*F.beaconPeriod;}
  if(status===5){const p=await read(id,'prizes',[rid],tag);Object.assign(state,{prizeAmount:BigInt(p[0]),prizeDeadline:Number(p[2]),prizeClaimed:p[3],prizeBurned:p[4]});}
  if(status===6){state.principalBurned=(await read(id,'unclaimedPrincipalBurned',[rid],tag))[0];state.unclaimed=BigInt(state.sold)*profile(id).ticketPrice-(await read(id,'refundedPrincipal',[rid],tag))[0];}
  return{...chooseAutomationAction(state,now),beacon:state.beacon};
}
async function prepare(id,rid,job,now){
  let args=[rid];
  if(job.method==='fulfillRandomness'){
    const r=await fetch(`https://api.drand.sh/${F.beaconHash}/public/${job.beacon}`,{signal:AbortSignal.timeout(12000)});const proof=await r.json();
    if(!r.ok||String(proof.round)!==job.beacon||!/^[0-9a-f]{128}$/i.test(proof.signature))throw Error('BEACON_UNAVAILABLE');args.push('0x'+proof.signature);
  }
  const data=ACTIONS.encodeFunctionData(job.method,args),to=profile(id).address;
  const [estimate,price,latestNonce,pendingNonce,available]=await Promise.all([rpc('eth_estimateGas',[{from:address,to,data,value:'0x0'}]),rpc('eth_gasPrice',[]),rpc('eth_getTransactionCount',[address,'latest']),rpc('eth_getTransactionCount',[address,'pending']),rpc('eth_getBalance',[address,'latest'])]);
  if(latestNonce!==pendingNonce)throw Error('NONCE_REQUIRES_REVIEW');
  const gas=(BigInt(estimate)*120n+99n)/100n,gasPrice=BigInt(price),fee=gas*gasPrice;balance=String(BigInt(available));
  if(gas>L.gasLimit||gasPrice>L.gasPrice||gasPrice<=0n||fee>L.fee)throw Error('GAS_BUDGET_EXCEEDED');
  if(BigInt(journal.spending[day()]||0)+fee>L.daily)throw Error('DAILY_BUDGET_REACHED');
  if(BigInt(balance)<fee)throw Error('GAS_BALANCE_LOW');
  const control=JSON.parse(await fs.readFile(process.env.SPARKDRAW_CONTROL,'utf8'));if(control.enabled!==true)return;
  const raw=await signer.signTransaction({chainId:56n,type:0,to,data,value:0n,nonce:Number(BigInt(latestNonce)),gasLimit:gas,gasPrice});
  validateAutomationTransaction(raw,address);
  journal.pending={raw,hash:keccak256(raw),poolId:id,roundId:String(rid),method:job.method,day:day(),sentAt:0};await save();
}
async function tick(){
  try{const control=JSON.parse(await fs.readFile(process.env.SPARKDRAW_CONTROL,'utf8'));enabled=control.enabled===true;}catch{enabled=false;}
  balance=String(BigInt(await rpc('eth_getBalance',[address,'latest'])));
  if(Date.now()-lastCheck>60000)await identity();
  if(await pending())return;
  if(!enabled){await publish('paused');return;}
  if(BigInt(balance)<10000000000000n){await publish('awaiting_gas');return;}
  const block=await rpc('eth_getBlockByNumber',['latest',false]),now=Number(BigInt(block.timestamp)),id=POOL_IDS[poolCursor++%POOL_IDS.length];
  const current=Number((await read(id,'currentRoundId',[],block.number))[0]);if(!Number.isSafeInteger(current)||current>10000000)throw Error('ROUND_RANGE');
  const p=journal.pools[id]??={discovered:0,rounds:{}};
  for(let n=p.discovered+1;n<=Math.min(current,p.discovered+50);n++)p.rounds[n]??={next:0};p.discovered=Math.min(current,p.discovered+50);
  const due=Object.keys(p.rounds).filter(n=>!p.rounds[n].done&&p.rounds[n].next<=now).sort((a,b)=>p.rounds[a].next-p.rounds[b].next).slice(0,4);
  for(const rid of due){
    try{const job=await inspect(id,rid,now,block.number);p.rounds[rid]={done:!!job.done,next:job.wait||now+5};await save();
      if(job.method){await prepare(id,rid,job,now);await publish(journal.pending?'preparing':'paused');return;}
    }catch(e){p.rounds[rid].next=now+10;await save();throw e;}
  }
  await save();await publish('running');
}
await identity();
if(freshJournal&&BigInt(await rpc('eth_getTransactionCount',[address,'pending']))!==0n)throw Error('JOURNAL_RECOVERY_REQUIRED');
await save();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopped=true;});
console.log('SparkDraw automation started; private keys and signed payloads are never logged.');
while(!stopped){try{lastError=null;await tick();}catch(e){lastError=/^[A-Z_]+$/.test(e.message)?e.message:'RPC_OR_IO_UNAVAILABLE';await publish('attention').catch(()=>{});}await new Promise(r=>setTimeout(r,1000));}
