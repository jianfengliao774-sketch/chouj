import fs from 'node:fs/promises';
import path from 'node:path';
import {Interface} from 'ethers';
import {POOL_IDS,profile} from './web/sparkdraw-profiles.js';
import {sparkDrawRecords} from './sparkdraw-records.mjs';
import {globalRoundLabels} from './sparkdraw-round-numbering.mjs';
const plain=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v));
export async function createSparkDrawIndex({rpc,abi,directory,confirmations=12}){
  const iface=new Interface(abi),states=new Map();let running=false,roundLabels=new Map();
  await fs.mkdir(directory,{recursive:true});
  for(const id of POOL_IDS){
    const p=profile(id),file=path.join(directory,'sparkdraw-v5-'+id+'.json');
    let s={version:5,address:p.address,through:p.deploymentBlock-1,hash:null,events:[]};
    try{const saved=JSON.parse(await fs.readFile(file,'utf8'));if(saved.version!==5||saved.address!==p.address||!Array.isArray(saved.events))throw Error('Index identity mismatch');s=saved;}catch(e){if(e.code!=='ENOENT')throw e;}
    states.set(id,{s,file,status:'syncing',target:s.through,view:sparkDrawRecords(s.events,{pool:id,address:p.address})});
  }
  function refreshLabels(){
    const through=Math.min(...[...states.values()].map(x=>x.s.through));
    const next=globalRoundLabels([...states.entries()].map(([poolId,x])=>({poolId,events:x.s.events})),through);
    if(JSON.stringify([...next])===JSON.stringify([...roundLabels]))return;
    roundLabels=next;for(const[id,x]of states)x.view=sparkDrawRecords(x.s.events,{pool:id,address:profile(id).address,roundLabels});
  }
  refreshLabels();
  const metadata=id=>{const x=states.get(id);return{state:x.status,indexedThrough:x.s.through,targetBlock:x.target,confirmations};};
  async function sync(){
    if(running)return;running=true;
    try{
      const target=Number(BigInt(await rpc('eth_blockNumber',[])))-confirmations+1;
      for(const id of POOL_IDS){const x=states.get(id),p=profile(id);x.target=target;
        try{
          if(x.s.hash){const checkpoint=await rpc('eth_getBlockByNumber',['0x'+x.s.through.toString(16),false]);if(checkpoint?.hash!==x.s.hash){x.s.through=p.deploymentBlock-1;x.s.hash=null;x.s.events=[];}}
          if(x.s.through>=target){x.status='ready';continue;}
          const end=Math.min(target,x.s.through+1000),logs=await rpc('eth_getLogs',[{address:p.address,fromBlock:'0x'+(x.s.through+1).toString(16),toBlock:'0x'+end.toString(16)}]);
          const headers=new Map();const events=[];
          for(const log of logs){
            if(log.removed||log.address.toLowerCase()!==p.address.toLowerCase())throw Error('Invalid indexed log');
            let parsed;try{parsed=iface.parseLog(log);}catch{continue;}if(!parsed)continue;
            if(!headers.has(log.blockNumber))headers.set(log.blockNumber,await rpc('eth_getBlockByNumber',[log.blockNumber,false]));
            const b=headers.get(log.blockNumber);if(!b||b.hash!==log.blockHash)throw Error('Index block changed');
            events.push({name:parsed.name,args:plain(Object.fromEntries(parsed.fragment.inputs.map((input,i)=>[input.name,parsed.args[i]]))),transactionHash:log.transactionHash,
              logIndex:Number(BigInt(log.logIndex)),blockNumber:Number(BigInt(log.blockNumber)),timeUtc:new Date(Number(BigInt(b.timestamp))*1000).toISOString()});
          }
          const endBlock=await rpc('eth_getBlockByNumber',['0x'+end.toString(16),false]);
          const next={...x.s,through:end,hash:endBlock.hash,events:[...x.s.events,...events]};
          await fs.writeFile(x.file+'.tmp',JSON.stringify(next));await fs.rename(x.file+'.tmp',x.file);x.s=next;
          x.view=sparkDrawRecords(next.events,{pool:id,address:p.address,roundLabels});x.status=end>=target?'ready':'syncing';
        }catch{x.status='stale';}
      }
      refreshLabels();
    }finally{running=false;}
  }
  return{sync,metadata,roundLabel:(id,roundId)=>roundLabels.get(id+':'+roundId),view:id=>states.get(id).view,events:id=>states.get(id).s.events};
}
