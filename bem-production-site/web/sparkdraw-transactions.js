import {Interface,keccak256,getAddress,toQuantity} from 'ethers';
import abi from './sparkdraw-abi.json' with {type:'json'};
import {profile} from './sparkdraw-profiles.js';
import {SPARKDRAW as F} from './sparkdraw-config.js';
import {enforcePurchaseGasBudget} from './purchase-gas-policy.js';
import {verifyWalletTransactionEnvelope} from './wallet-transaction-envelope.js';
export const GAME=new Interface(abi);
export const TOKEN=new Interface(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
const KEY='sparkdraw:v5:pending';
const fail=code=>{throw Object.assign(Error(code),{code});};
export function parseTickets(mode,count,text){
  if(mode==='auto'){if(!/^[1-9][0-9]*$/.test(String(count))||Number(count)>5000)fail('TICKET_LIMIT');return{count:Number(count),tickets:null};}
  const set=new Set();for(const part of text.trim().split(/[,，\s]+/).filter(Boolean)){
    const m=/^(\d{1,5})(?:[-–](\d{1,5}))?$/.exec(part);if(!m)fail('TICKET_RANGE');
    const from=Number(m[1]),to=Number(m[2]||m[1]);if(from<1||to>10000||to<from)fail('TICKET_RANGE');
    for(let n=from;n<=to;n++){set.add(n-1);if(set.size>5000)fail('TICKET_LIMIT');}
  }
  if(!set.size)fail('TICKET_RANGE');return{count:set.size,tickets:[...set].sort((a,b)=>a-b)};
}
export function createSparkDrawTransactions({rpc,wallet,context,storage=localStorage,onChange=()=>{},locks=globalThis.navigator?.locks,now=Date.now}){
  let busy=false,polling=false,pending=null;
  const load=()=>{const raw=storage.getItem(KEY);pending=raw?JSON.parse(raw):null;};load();
  const save=record=>{if(record)storage.setItem(KEY,JSON.stringify(record));else storage.removeItem(KEY);pending=record;onChange(record);};
  const identity=async(p,c)=>{const[a,chain]=await Promise.all([p.request({method:'eth_accounts'}),p.request({method:'eth_chainId'})]);if(BigInt(chain)!==56n||!a[0]||a[0].toLowerCase()!==c.account.toLowerCase()||context().key!==c.key)fail('CONTEXT_CHANGED');};
  async function check(){
    load();if(!pending?.hash||polling)return null;polling=true;
    try{
      const record=pending,p=profile(record.poolId),hash=record.hash;
      if(!/^0x[a-f0-9]{64}$/i.test(hash))fail('TRANSACTION_MISMATCH');
      const receipt=await rpc('eth_getTransactionReceipt',[hash]);if(!receipt)return null;
      const[tx,block]=await Promise.all([rpc('eth_getTransactionByHash',[hash]),rpc('eth_getBlockByNumber',[receipt.blockNumber,false])]);
      if(!tx||!block||receipt.blockHash!==block.hash||tx.blockHash!==block.hash||receipt.transactionHash.toLowerCase()!==hash.toLowerCase())return null;
      verifyWalletTransactionEnvelope(tx,{...record,hash,nonceFloor:record.nonce});
      let result=null;
      if(BigInt(receipt.status)===1n&&record.kind==='buy'){
        const events=receipt.logs.filter(l=>l.address.toLowerCase()===p.address.toLowerCase()).flatMap(l=>{try{const x=GAME.parseLog(l);return x?.name==='PurchaseResult'?[x]:[];}catch{return[];}});
        if(events.length!==1)fail('TRANSACTION_MISMATCH');const a=events[0].args;
        if(a.buyer.toLowerCase()!==record.account.toLowerCase()||String(a.roundId)!==record.roundId||Number(a.requested)!==record.count||a.filled>a.requested||a.paid!==a.filled*p.ticketPrice||a.unspent!==(a.requested-a.filled)*p.ticketPrice)fail('TRANSACTION_MISMATCH');
        result={requested:Number(a.requested),filled:Number(a.filled),paid:String(a.paid),unspent:String(a.unspent)};
      }
      load();if(pending?.hash===hash)save(null);
      return{...record,status:BigInt(receipt.status)===1n?'confirmed':'reverted',result};
    }finally{polling=false;}
  }
  async function execute({poolId,method,args,kind,count,roundId}){
    const work=async()=>{
      if(busy)fail('TRANSACTION_IN_FLIGHT');busy=true;
      try{
        load();if(pending)fail('TRANSACTION_PENDING');const c=context(),p=wallet();if(!c.account||!p)fail('CONNECT_WALLET');
        const dest=profile(poolId);await identity(p,c);
        if(keccak256(await rpc('eth_getCode',[dest.address,'latest']))!==dest.runtimeHash)fail('CONTRACT_MISMATCH');
        if(!['buy','buySelected','approve','refundMany','claimPrizes','closeRound','fulfillRandomness','settle','openRefunds','burnUnclaimed','burnUnclaimedPrize'].includes(method))fail('ACTION_NOT_SUPPORTED');
        if(method==='approve'&&(args[0].toLowerCase()!==dest.address.toLowerCase()||BigInt(args[1])<=0n||BigInt(args[1])>5000n*dest.ticketPrice))fail('APPROVAL_AMOUNT');
        if(['refundMany','claimPrizes'].includes(method)&&args[1].toLowerCase()!==c.account.toLowerCase())fail('CONTEXT_CHANGED');
        const to=method==='approve'?F.bem:dest.address,data=(method==='approve'?TOKEN:GAME).encodeFunctionData(method,args);
        const tx={from:c.account,to,data,value:'0x0'};
        const [rawGas,rawPrice]=await Promise.all([rpc('eth_estimateGas',[tx,'latest']),rpc('eth_gasPrice',[])]);
        const estimate=BigInt(rawGas),price=BigInt(rawPrice);if(estimate<=0n||estimate>16777216n)fail('GAS_LIMIT_EXCEEDED');if(price<=0n)fail('GAS_PRICE_UNAVAILABLE');
        const buffered=(estimate*120n+99n)/100n,gas=buffered>16777216n?16777216n:buffered;
        enforcePurchaseGasBudget(kind,gas,price);await identity(p,c);
        const nonce=BigInt(await p.request({method:'eth_getTransactionCount',params:[c.account,'pending']}));
        await identity(p,c);load();if(pending)fail('TRANSACTION_PENDING');
        const record={poolId,kind,roundId:String(roundId||0),count:count||0,account:getAddress(c.account),to,data,nonce:String(nonce),hash:null,at:now()};save(record);
        try{const hash=await p.request({method:'eth_sendTransaction',params:[{...tx,chainId:'0x38',nonce:toQuantity(nonce),gas:toQuantity(gas),gasPrice:toQuantity(price)}]});
          if(!/^0x[a-f0-9]{64}$/i.test(hash))fail('UNKNOWN_WALLET_RESULT');save({...record,hash});return hash;
        }catch(e){if(e.code===4001||e.code==='ACTION_REJECTED')save(null);throw e;}
      }finally{busy=false;}
    };
    if(!locks)fail('LOCK_UNAVAILABLE');return locks.request(KEY,{ifAvailable:true},lock=>{if(!lock)fail('TRANSACTION_IN_FLIGHT');return work();});
  }
  return{execute,check,get pending(){load();return pending;},get busy(){return busy;},async attach(hash){load();if(!pending||pending.hash||!/^0x[a-f0-9]{64}$/i.test(hash))fail('TRANSACTION_MISMATCH');save({...pending,hash});return check();}};
}
