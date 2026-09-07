// Read-only verification of the registry against successful BNB creation receipts.
import fs from 'node:fs/promises';
import { Interface, keccak256 } from 'ethers';
import { artifactFor, deploymentData, verifyCreation, same } from '../bem-production-site/web/sparkdraw-deployment-checks.js';
import { SPARKDRAW as F } from '../bem-production-site/web/sparkdraw-config.js';
const artifacts=JSON.parse(await fs.readFile(new URL('../bem-production-site/web/sparkdraw-artifacts.json',import.meta.url),'utf8'));
const registry=await (await fetch('https://tapeout.cc.cd/api/sparkdraw/deployments')).json();
const endpoint='https://bsc-dataseed.bnbchain.org';let serial=0;
async function rpc(method,params){
  if(!['eth_chainId','eth_blockNumber','eth_gasPrice','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber','eth_getCode','eth_call'].includes(method))throw Error('Read only');
  const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++serial,method,params}),signal:AbortSignal.timeout(25000)});
  const value=await r.json();if(!r.ok||value.error)throw Error(JSON.stringify(value.error??r.status));return value.result;
}
if(BigInt(await rpc('eth_chainId',[]))!==56n)throw Error('Wrong chain');
const latest=await rpc('eth_blockNumber',[]),gasPriceWei=await rpc('eth_gasPrice',[]),rows=[];
for(const kind of ['verifier','0.1','5','10','50','100']){
  const entry=kind==='verifier'?registry.verifier:registry.pools[kind];if(!entry)throw Error('Missing deployment: '+kind);
  const [tx,receipt]=await Promise.all([rpc('eth_getTransactionByHash',[entry.transactionHash]),rpc('eth_getTransactionReceipt',[entry.transactionHash])]);
  const [block,code]=await Promise.all([rpc('eth_getBlockByNumber',[receipt.blockNumber,false]),rpc('eth_getCode',[entry.address,'latest'])]);
  const artifact=artifactFor(artifacts,kind);
  const address=verifyCreation({tx,receipt,block,latest,code,data:deploymentData(artifacts,kind,registry.verifier.address),artifact});
  if(!same(address,entry.address))throw Error('Registry address mismatch');
  const result={...entry,runtimeHash:keccak256(code),gasUsed:BigInt(receipt.gasUsed).toString()};
  if(kind!=='verifier'){
    const abi=new Interface(artifact.abi);
    const read=async(name,args=[])=>abi.decodeFunctionResult(name,await rpc('eth_call',[{to:address,data:abi.encodeFunctionData(name,args)},'latest']));
    const [pool,verifier,organizer,roundId,authorized]=await Promise.all(['ROUND_POOL','verifier','organizer','currentRoundId','seriesAuthorized'].map(n=>read(n)));
    if(pool[0]!==BigInt(F.pools[kind].units)||!same(verifier[0],registry.verifier.address)||!same(organizer[0],F.revenue)||!authorized[0])throw Error('Deployed settings mismatch');
    const round=await read('rounds',[roundId[0]]);
    Object.assign(result,{currentRoundId:roundId[0].toString(),status:Number(round[0]),sold:Number(round[1])});
  }
  rows.push(result);
}
const evidence={checkedAt:new Date().toISOString(),chainId:56,blockNumber:BigInt(latest).toString(),gasPriceWei:BigInt(gasPriceWei).toString(),deployments:rows};
if(process.argv.includes('--save'))await fs.writeFile(new URL('../bem-production-site/web/public/sparkdraw/deployed-contracts.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
