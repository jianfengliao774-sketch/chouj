import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Interface} from 'ethers';
import {createSparkDrawService} from '../bem-production-site/sparkdraw-service.mjs';
import {createAdminCredential} from '../bem-production-site/auth.mjs';
import {POOL_IDS,profile} from '../bem-production-site/web/sparkdraw-profiles.js';
const abi=JSON.parse(await fs.readFile(new URL('../bem-production-site/web/sparkdraw-abi.json',import.meta.url),'utf8')),iface=new Interface(abi);
test('V5 service exposes only the five new pools, routes old pages away and rejects old RPC calls',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sparkdraw-service-')),credential=await createAdminCredential('fixture-admin','test-only-password');
  const rpc=async(method,params)=>{
    if(method==='eth_blockNumber')return'0x1';
    if(method==='eth_getBlockByNumber')return{number:'0x1',hash:'0x'+'b'.repeat(64),timestamp:'0x64'};
    if(method==='eth_call'){const c=iface.parseTransaction(params[0]),values={currentRoundId:[1],rounds:[0,0,0,0,0,0,0,0,0,'0x'+'0'.repeat(40)],earlyDrawDeadline:[0],sealedAt:[0],beaconRound:[0],prizes:[0,0,0,false,false],unclaimedPrincipalBurned:[false]};return iface.encodeFunctionResult(c.fragment,values[c.name]);}
    throw Error('Unexpected '+method);
  };
  const service=await createSparkDrawService({rpc,directory,credential,verify:false,origin:'http://127.0.0.1:18991'});await new Promise(r=>service.server.listen(18991,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>service.server.close(r));assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true});});
  const request=(url,options)=>fetch('http://127.0.0.1:18991'+url,options);
  const health=await(await request('/api/health')).json();assert.equal(health.version,5);assert.deepEqual(health.pools,POOL_IDS);assert.equal(health.salesEnabled,true);
  for(const id of POOL_IDS){const state=await(await request('/api/sparkdraw/state?pool='+id)).json();assert.equal(state.address,profile(id).address);assert.equal(state.rounds[0].status,0);}
  assert.equal((await request('/legacy.html',{redirect:'manual'})).status,302);assert.equal((await request('/start-test.html',{redirect:'manual'})).headers.get('location'),'/?pool=0.1');
  const old=await(await request('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:'0xE7D8dF903050d875f09cE1BBcE20E837fB55bC0c',data:'0x'},'latest']})})).json();assert.equal(old.error.code,-32602);
  assert.equal((await request('/api/admin/overview')).status,401);
  const records=await(await request('/api/sparkdraw/records?kind=wallet&address=0x1111111111111111111111111111111111111111')).json();assert.equal(records.rows.length,0);assert.equal(records.claims.length,5);
});
