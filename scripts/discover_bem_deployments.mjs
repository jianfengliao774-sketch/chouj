// Read-only recovery of public CREATE addresses for the two known project wallets.
import fs from 'node:fs';
import {getCreateAddress,keccak256} from 'ethers';
import {verifyDeploymentRuntime} from '../bem-production-site/web/deploy-container-guards.js';
const endpoint='https://tapeout.cc.cd/rpc';
const owners=[{address:'0x304F06903324B8056cB1ED627144EfB2C34df3a8',firstNonce:422},{address:'0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',firstNonce:0}];
const artifactNames={test:'Bem2075Raffle13061Test1BSC',pool10:'Bem2075Raffle13061Pool10BSC',pool50:'Bem2075Raffle13061Pool50BSC',production:'Bem2075Raffle13061BSC'};
const artifacts=Object.fromEntries(Object.entries(artifactNames).map(([mode,name])=>[mode,JSON.parse(fs.readFileSync(new URL(`../outputs/bem-raffle-2075/production-v2/${name}.artifact.json`,import.meta.url)))]));
let serial=0;
async function readMany(calls){const payload=calls.map(([method,params])=>({jsonrpc:'2.0',id:++serial,method,params}));const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});if(!response.ok)throw Error(`RPC ${response.status}`);const values=await response.json();return payload.map(p=>{const row=values.find(x=>x.id===p.id);if(row?.error||!row||!Object.hasOwn(row,'result'))throw Error('Public RPC read failed');return row.result;});}
const [block]=await readMany([['eth_getBlockByNumber',['latest',false]]]);
const snapshot={blockNumber:Number(BigInt(block.number)),blockHash:block.hash,timeUtc:new Date(Number(BigInt(block.timestamp))*1000).toISOString()};
const work=[],wallets=[];
for(const owner of owners){const [count]=await readMany([['eth_getTransactionCount',[owner.address,block.number]]]);const total=Number(BigInt(count));if(total-owner.firstNonce>600)throw Error('Unexpected nonce scan range');wallets.push({...owner,nextNonce:total});for(let nonce=total-1;nonce>=owner.firstNonce;nonce--)work.push({owner:owner.address,nonce,address:getCreateAddress({from:owner.address,nonce})});}
const contracts=[];
for(let offset=0;offset<work.length;offset+=6){const batch=work.slice(offset,offset+6),codes=await readMany(batch.map(row=>['eth_getCode',[row.address,block.number]]));for(let i=0;i<batch.length;i++){const code=codes[i];if(code==='0x')continue;const row={...batch[i],bytes:(code.length-2)/2,runtimeCodeHash:keccak256(code),matches:[]};for(const [mode,artifact] of Object.entries(artifacts))try{verifyDeploymentRuntime(code,artifact,mode);row.matches.push(mode);}catch{}contracts.push(row);console.log(JSON.stringify(row));}if(offset%30===0)console.log(JSON.stringify({scanned:Math.min(offset+6,work.length),total:work.length}));}
const [sameBlock]=await readMany([['eth_getBlockByNumber',[block.number,false]]]);if(sameBlock.hash!==block.hash)throw Error('Canonical block changed');
const result={checkedAt:new Date().toISOString(),readOnly:true,snapshot,wallets,scanned:work.length,contracts};
const file=new URL('../outputs/bem-raffle-2075/production-v2/deployment-discovery-readonly.json',import.meta.url);fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({complete:true,scanned:work.length,contracts:contracts.length}));
