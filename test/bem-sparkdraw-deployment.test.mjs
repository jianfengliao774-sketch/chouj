import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {getCreateAddress} from 'ethers';
import {createSparkDrawDeployments} from '../bem-production-site/sparkdraw-deployments.mjs';
import {deploymentData,verifyCreation,artifactFor} from '../bem-production-site/web/sparkdraw-deployment-checks.js';
import {SPARKDRAW as F} from '../bem-production-site/web/sparkdraw-config.js';
const artifacts=JSON.parse(await fs.readFile(new URL('../bem-production-site/web/sparkdraw-artifacts.json',import.meta.url)));
const h=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture(kind,nonce,verifier){
  const hash=h(nonce+100),address=getCreateAddress({from:F.deployer,nonce}),data=deploymentData(artifacts,kind,verifier),artifact=artifactFor(artifacts,kind);
  return {kind,hash,address,data,artifact,latest:'0x70',code:artifact.runtime,
    tx:{hash,from:F.deployer,to:null,input:data,value:'0x0',nonce:'0x'+nonce.toString(16),chainId:'0x38',blockNumber:'0x64',blockHash:h(1)},
    receipt:{transactionHash:hash,from:F.deployer,to:null,status:'0x1',contractAddress:address,blockNumber:'0x64',blockHash:h(1)},block:{number:'0x64',hash:h(1)}};
}
test('deployment receipts bind the exact denomination, creator, runtime and confirmed canonical block',()=>{
  const f=fixture('verifier',0);assert.equal(verifyCreation(f),f.address);
  for(const patch of [{tx:{...f.tx,from:'0x'+'1'.repeat(40)}},{tx:{...f.tx,input:f.data+'00'}},
    {receipt:{...f.receipt,status:'0x0'}},{latest:'0x64'},{block:{...f.block,hash:h(2)}},{code:'0x00'},
    {receipt:{...f.receipt,contractAddress:'0x'+'2'.repeat(40)}}])assert.throws(()=>verifyCreation({...f,...patch}));
  const pool=fixture('0.1',1,f.address);assert.equal(verifyCreation(pool),pool.address);
  assert.throws(()=>verifyCreation({...pool,data:deploymentData(artifacts,'5',f.address)}));
});
test('successful deployments persist across restart, reject replacement and never broadcast transactions',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sparkdraw-deploy-test-'));
  t.after(async()=>{assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('sparkdraw-deploy-test-'));await fs.rm(dir,{recursive:true});});
  const verifier=fixture('verifier',0),pool=fixture('0.1',1,verifier.address),all=[verifier,pool];
  async function rpc(method,args){
    if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x70';
    if(method==='eth_getTransactionByHash')return all.find(x=>x.hash===args[0])?.tx;
    if(method==='eth_getTransactionReceipt')return all.find(x=>x.hash===args[0])?.receipt;
    if(method==='eth_getBlockByNumber')return verifier.block;
    if(method==='eth_getCode'){
      assert.equal(args[1],'latest','restarts must not depend on pruned deployment-block state');
      return all.find(x=>x.address===args[0])?.code;
    }
    throw Error('Unexpected method '+method);
  }
  const options={rpc,artifacts,storagePath:path.join(dir,'deployments.json')};
  const registry=await createSparkDrawDeployments(options);
  await assert.rejects(registry.register('0.1',pool.hash),/验证合约/);
  await registry.register('verifier',verifier.hash);await registry.register('0.1',pool.hash);
  assert.equal(registry.snapshot().pools['0.1'].address,pool.address);
  await registry.register('0.1',pool.hash);await assert.rejects(registry.register('0.1',h(999)),/不重复覆盖/);
  const resumed=await createSparkDrawDeployments(options);assert.equal(resumed.snapshot().pools['0.1'].address,pool.address);
  const copy=resumed.snapshot();copy.pools={};assert.ok(resumed.snapshot().pools['0.1']);
});
