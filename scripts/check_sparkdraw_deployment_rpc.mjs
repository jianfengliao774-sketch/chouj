import fs from 'node:fs';
import {formatEther,Interface} from 'ethers';
import {SPARKDRAW as F} from '../bem-production-site/web/sparkdraw-config.js';
import {deploymentData} from '../bem-production-site/web/sparkdraw-deployment-checks.js';
const artifacts=JSON.parse(fs.readFileSync(new URL('../bem-production-site/web/sparkdraw-artifacts.json',import.meta.url)));
const endpoint='https://bsc-rpc.publicnode.com';let serial=0;
async function rpc(method,params){
  if(!['eth_chainId','eth_blockNumber','eth_gasPrice','eth_estimateGas','eth_call'].includes(method))throw Error('Read only');
  const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++serial,method,params}),signal:AbortSignal.timeout(25000)});
  const v=await r.json();if(!r.ok||v.error)throw Error(JSON.stringify(v.error??r.status));return v.result;
}
if(BigInt(await rpc('eth_chainId',[]))!==56n)throw Error('Wrong chain');
const block=await rpc('eth_blockNumber',[]),price=BigInt(await rpc('eth_gasPrice',[]));
const verifier='0x000000000000000000000000000000000000da7a';
const override={[verifier]:{code:artifacts.contracts.DrandEvmnetVerifier.runtime}};
const results=[];
for(const kind of ['verifier','0.1','5','10','50','100']){
  const tx={from:F.deployer,data:deploymentData(artifacts,kind,verifier),value:'0x0'};
  const gas=BigInt(await rpc('eth_estimateGas',[tx,block,override]));
  const runtime=await rpc('eth_call',[{...tx,gas:'0x1000000'},block,override]);
  if((runtime.length-2)/2>24576)throw Error('Oversized runtime');
  results.push({kind,estimatedGas:gas.toString(),estimatedBnb:formatEther(gas*price),runtimeBytes:(runtime.length-2)/2});
}
console.log(JSON.stringify({mode:'BNB read-only creation simulation with temporary verifier code override; no transactions',block:String(BigInt(block)),gasPriceWei:price.toString(),results},null,2));
