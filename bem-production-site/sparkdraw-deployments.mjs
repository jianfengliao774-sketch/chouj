import fs from 'node:fs/promises';
import path from 'node:path';
import {artifactFor,deploymentData,verifyCreation} from './web/sparkdraw-deployment-checks.js';
import {SPARKDRAW as F} from './web/sparkdraw-config.js';

export async function createSparkDrawDeployments({rpc,storagePath,artifacts}){
  let state={version:5,chainId:56,verifier:null,pools:{}},pending=Promise.resolve();
  async function validate(kind,hash){
    if(!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('请填写部署交易哈希');
    if(kind!=='verifier'&&!state.verifier)throw Error('请先登记验证合约');
    const data=deploymentData(artifacts,kind,state.verifier?.address);
    const [tx,receipt,latest,chain]=await Promise.all([rpc('eth_getTransactionByHash',[hash]),rpc('eth_getTransactionReceipt',[hash]),rpc('eth_blockNumber',[]),rpc('eth_chainId',[])]);
    if(BigInt(chain)!==56n||!receipt?.contractAddress)throw Error('等待 BNB 主网部署成功');
    const [block,code]=await Promise.all([rpc('eth_getBlockByNumber',[receipt.blockNumber,false]),rpc('eth_getCode',[receipt.contractAddress,receipt.blockNumber])]);
    const address=verifyCreation({tx,receipt,block,latest,code,data,artifact:artifactFor(artifacts,kind)});
    return {kind,address,transactionHash:hash,blockNumber:Number(BigInt(receipt.blockNumber)),blockHash:receipt.blockHash,
      registeredAt:new Date().toISOString(),deployer:F.deployer,verifier:kind==='verifier'?null:state.verifier.address};
  }
  let stored=null;
  try{stored=JSON.parse(await fs.readFile(storagePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(stored){
    if(stored.version!==5||stored.chainId!==56)throw Error('Deployment registry version mismatch');
    if(stored.verifier)state.verifier=await validate('verifier',stored.verifier.transactionHash);
    for(const [kind,record] of Object.entries(stored.pools))state.pools[kind]=await validate(kind,record.transactionHash);
  }
  return {snapshot:()=>structuredClone(state),register(kind,hash){
    const task=pending.then(async()=>{
      artifactFor(artifacts,kind);
      const old=kind==='verifier'?state.verifier:state.pools[kind];
      if(old){if(old.transactionHash.toLowerCase()!==hash.toLowerCase())throw Error('此档已登记部署，不重复覆盖');return structuredClone(old);}
      const record=await validate(kind,hash),next=structuredClone(state);
      if(kind==='verifier')next.verifier=record;else next.pools[kind]=record;
      await fs.mkdir(path.dirname(storagePath),{recursive:true});
      const temporary=storagePath+'.tmp';await fs.writeFile(temporary,JSON.stringify(next,null,2));await fs.rename(temporary,storagePath);
      state=next;return structuredClone(record);
    });
    pending=task.catch(()=>{});return task;
  }};
}
