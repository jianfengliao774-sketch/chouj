// Public reads only. No private keys, state overrides, signatures or broadcasts.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Interface,AbiCoder,keccak256,sha256} from 'ethers';
import {GAME} from '../bem-production-site/web/sparkdraw-transactions.js';
import {POOL_IDS,profile,VERIFIER,VERIFIER_HASH} from '../bem-production-site/web/sparkdraw-profiles.js';
import {SPARKDRAW as F} from '../bem-production-site/web/sparkdraw-config.js';
const endpoint='https://bsc-dataseed.bnbchain.org';let serial=0;
async function rpc(method,params){
  assert.ok(['eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_call','eth_chainId'].includes(method));
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++serial,method,params}),signal:AbortSignal.timeout(25000)});
  const d=await response.json();if(!response.ok)throw Error('HTTP '+response.status);if(d.error)throw Error(d.error.message);return d.result;
}
const block=await rpc('eth_blockNumber',[]);assert.equal(BigInt(await rpc('eth_chainId',[])),56n);
const call=async(abi,to,name,args=[])=>abi.decodeFunctionResult(name,await rpc('eth_call',[{to,data:abi.encodeFunctionData(name,args)},block]));
const token=new Interface(['function balanceOf(address) view returns(uint256)']);
const artifacts=JSON.parse(await fs.readFile(new URL('../bem-production-site/web/sparkdraw-artifacts.json',import.meta.url)));
const verifier=new Interface(artifacts.contracts.DrandEvmnetVerifier.abi);
const input=JSON.parse(await fs.readFile(new URL('../bem-production-site/web/public/sparkdraw/standard-input.json',import.meta.url)));
const sourceChecks=[];
for(const [name,source] of Object.entries(input.sources)){
  const current=await fs.readFile(new URL('../contracts/drand-candidate/'+name,import.meta.url),'utf8');
  assert.equal(current.replace(/\r\n/g,'\n'),source.content.replace(/\r\n/g,'\n'));sourceChecks.push(name);
}
assert.equal(keccak256(await rpc('eth_getCode',[VERIFIER,block])),VERIFIER_HASH);
const pools=[];
for(const id of POOL_IDS){
  const p=profile(id);assert.equal(keccak256(await rpc('eth_getCode',[p.address,block])),p.runtimeHash);
  const [balance,liability,rid]=await Promise.all([call(token,F.bem,'balanceOf',[p.address]),call(GAME,p.address,'totalLiability'),call(GAME,p.address,'currentRoundId')]);
  assert.ok(balance[0]>=liability[0]);const r=await call(GAME,p.address,'rounds',[rid[0]]);
  pools.push({pool:id,address:p.address,codeMatches:true,balanceBaseUnits:String(balance[0]),liabilityBaseUnits:String(liability[0]),solvent:true,currentRound:String(rid[0]),status:Number(r[0]),sold:Number(r[1])});
}
const p=profile('0.1'),rid=2n;
const [r,beacon,random,proof,sealed]=await Promise.all(['rounds','beaconRound','beaconRandomness','randomnessProof','sealedAt'].map(n=>call(GAME,p.address,n,[rid])));
assert.equal(r[0],5n);assert.equal(sha256(proof[0]),random[0]);
assert.equal((await call(verifier,VERIFIER,'verifyBeacon',[beacon[0],proof[0]]))[0],random[0]);
const available=F.genesis+(Number(beacon[0])-1)*F.beaconPeriod;assert.ok(available-Number(sealed[0])>=60&&available-Number(sealed[0])<63);
const coder=AbiCoder.defaultAbiCoder(),seed=domain=>BigInt(keccak256(coder.encode(['string','uint256','address','uint256','uint32','bytes32','uint64','bytes32'],[domain,56,p.address,rid,r[1],'0x'+F.beaconHash,beacon[0],random[0]])));
const w0=seed('Tapeout drand tickets v1'),w1=seed('Tapeout drand circuit v1');assert.equal(w0,r[5]);assert.equal(w1,r[6]);
const attempts=[];let winner,ticket;
for(let cursor=0;cursor<100;cursor++){
  const group=Math.floor(cursor/10),word=group===0?w0:group===1?w1:BigInt(keccak256(coder.encode(['string','uint256','uint256','uint256'],['BEM2075_INPUTS_V1',w0,w1,group]))),shift=BigInt(cursor%10*24);
  const input0=Number((word>>shift)&4095n),input1=Number((word>>(shift+12n))&4095n);
  const output=n=>((n&255)+(n>>8))&255,candidate=output(input0)*256+output(input1),accepted=candidate<60000;
  const onchain=(await call(GAME,p.address,'previewAttempt',[w0,w1,cursor]))[0];assert.equal(Number(onchain.candidate),candidate);assert.equal(onchain.accepted,accepted);
  if(!accepted){attempts.push({cursor,candidate,accepted:false});continue;}
  const n=candidate%10000,owner=(await call(GAME,p.address,'ticketOwner',[rid,n]))[0];attempts.push({cursor,candidate,ticket:n+1,owner});
  if(owner!=='0x'+'0'.repeat(40)){winner=owner;ticket=n;break;}
}
assert.equal(ticket,Number(r[8]));assert.equal(winner.toLowerCase(),r[9].toLowerCase());
const info=await(await fetch('https://api.drand.sh/'+F.beaconHash+'/info',{signal:AbortSignal.timeout(15000)})).json();
assert.equal(info.hash,F.beaconHash);assert.equal(info.period,F.beaconPeriod);assert.equal(info.genesis_time,F.genesis);
const publicKey=(await call(verifier,VERIFIER,'publicKey'))[0],hex=n=>n.toString(16).padStart(64,'0');
assert.equal([publicKey.x[1],publicKey.x[0],publicKey.y[1],publicKey.y[0]].map(hex).join(''),info.public_key);
let rejection=false;try{await call(verifier,VERIFIER,'verifyBeacon',[beacon[0]+1n,proof[0]]);}catch(e){if(/revert/i.test(e.message))rejection=true;else throw e;}assert.ok(rejection);
const output={checkedAt:new Date().toISOString(),chainId:56,block:Number(BigInt(block)),sourceChecks,pools,drand:{chainHash:info.hash,scheme:info.schemeID,period:info.period,keyMatches:true},replayedRound:{pool:'0.1',round:String(rid),sold:Number(r[1]),sealedAt:Number(sealed[0]),beaconRound:String(beacon[0]),beaconAvailableAt:available,randomness:random[0],proof:proof[0],wrongRoundProofRejected:rejection,attempts,winningNumber:String(ticket+1).padStart(5,'0'),winner},transactionsSent:0};
const folder=new URL('../outputs/sparkdraw-security-review/',import.meta.url);await fs.mkdir(folder,{recursive:true});await fs.writeFile(new URL('live-evidence.json',folder),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
