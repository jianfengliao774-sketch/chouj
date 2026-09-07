import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Interface} from 'ethers';
import {createSparkDrawService} from '../bem-production-site/sparkdraw-service.mjs';
import {createAdminCredential} from '../bem-production-site/auth.mjs';
import {POOL_IDS,profile} from '../bem-production-site/web/sparkdraw-profiles.js';
import {totpCode} from '../bem-production-site/sparkdraw-vault.mjs';
const abi=JSON.parse(await fs.readFile(new URL('../bem-production-site/web/sparkdraw-abi.json',import.meta.url),'utf8')),iface=new Interface(abi);
test('V5 service exposes only the five new pools, routes old pages away and rejects old RPC calls',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sparkdraw-service-')),credential=await createAdminCredential('fixture-admin','test-only-password');
  const rpc=async(method,params)=>{
    if(method==='eth_estimateGas')return'0x5208';
    if(method==='eth_blockNumber')return'0x1';
    if(method==='eth_getBlockByNumber')return{number:'0x1',hash:'0x'+'b'.repeat(64),timestamp:'0x64'};
    if(method==='eth_call'){const c=iface.parseTransaction(params[0]),values={currentRoundId:[1],rounds:[0,0,0,0,0,0,0,0,0,'0x'+'0'.repeat(40)],earlyDrawDeadline:[0],sealedAt:[0],beaconRound:[0],prizes:[0,0,0,false,false],unclaimedPrincipalBurned:[false]};return iface.encodeFunctionResult(c.fragment,values[c.name]);}
    throw Error('Unexpected '+method);
  };
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const staticRoot=path.join(directory,'public');await fs.cp(path.resolve('bem-production-site/web/public'),staticRoot,{recursive:true});
  const guide=await fs.readFile('bem-production-site/web/draw-guide.html','utf8');await fs.writeFile(path.join(staticRoot,'draw-guide.html'),guide);
  const service=await createSparkDrawService({rpc,directory,credential,vaultSecret:secret,verify:false,staticRoot,origin:'http://127.0.0.1:18991'});await new Promise(r=>service.server.listen(18991,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>service.server.close(r));assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true});});
  const request=(url,options)=>fetch('http://127.0.0.1:18991'+url,options);
  const health=await(await request('/api/health')).json();assert.equal(health.version,5);assert.deepEqual(health.pools,POOL_IDS);assert.equal(health.salesEnabled,true);
  assert.deepEqual(health.openPools,['5','10','50']);
  const config=await(await request('/api/config')).json();assert.equal(config.defaultPool,'5');
  assert.deepEqual(Object.keys(config.pools).sort(),['10','5','50']);for(const p of Object.values(config.pools))assert.equal(p.salesEnabled,true);
  const estimate=async(to,data)=>(await(await request('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_estimateGas',params:[{to,data},'latest']})})).json());
  const token=new Interface(['function approve(address,uint256) returns(bool)']);
  for(const id of ['0.1','100']){
    for(const [method,args] of [['buy',[1,1]],['buySelected',[1,[0]]]])assert.match((await estimate(profile(id).address,iface.encodeFunctionData(method,args))).error.message,/POOL_SALES_CLOSED/);
    assert.match((await estimate('0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',token.encodeFunctionData('approve',[profile(id).address,100]))).error.message,/POOL_SALES_CLOSED/);
    for(const method of ['refundMany','claimPrizes'])assert.equal((await estimate(profile(id).address,iface.encodeFunctionData(method,[[1],'0x1111111111111111111111111111111111111111']))).result,'0x5208');
  }
  for(const id of ['5','10','50'])assert.equal((await estimate(profile(id).address,iface.encodeFunctionData('buy',[1,1]))).result,'0x5208');
  // Exercise HTTP body parsing as well as RPC validation: 5,000 tickets exceed 256 KiB.
  const largeData=iface.encodeFunctionData('buySelected',[1,Array.from({length:5000},(_,i)=>i)]);
  assert.ok(Buffer.byteLength(largeData)>262144);
  assert.equal((await estimate(profile('5').address,largeData)).result,'0x5208');
  assert.equal((await request('/deploy-sparkdraw.html',{redirect:'manual'})).headers.get('location'),'/?pool=5');
  const publicGuide=await request('/draw-guide.html');assert.equal(publicGuide.status,200);assert.match(publicGuide.headers.get('content-type'),/^text\/html/);assert.equal(await publicGuide.text(),guide);
  for(const id of POOL_IDS){const state=await(await request('/api/sparkdraw/state?pool='+id)).json();assert.equal(state.address,profile(id).address);assert.equal(state.rounds[0].status,0);}
  assert.equal((await request('/legacy.html',{redirect:'manual'})).status,302);assert.equal((await request('/start-test.html',{redirect:'manual'})).headers.get('location'),'/?pool=5');
  const old=await(await request('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:'0xE7D8dF903050d875f09cE1BBcE20E837fB55bC0c',data:'0x'},'latest']})})).json();assert.equal(old.error.code,-32602);
  for(const name of ['metamask.svg','okx.png','binance.svg','trust.svg','rabby.png','coinbase.svg']){
    const response=await request('/wallet-icons/'+name);assert.equal(response.status,200,name);
    assert.equal(response.headers.get('content-type'),name.endsWith('.svg')?'image/svg+xml':'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),await fs.readFile(path.join('bem-production-site/web/public/wallet-icons',name)));
  }
  assert.equal((await request('/wallet-icons/unknown.svg')).status,404);
  assert.equal((await request('/api/admin/overview')).status,401);
  assert.equal((await request('/api/admin/vault')).status,401);
  assert.equal((await request('/api/admin/vault/key',{method:'POST',headers:{origin:'http://127.0.0.1:18991'}})).status,401);
  assert.equal((await request('/api/admin/vault/setup',{method:'POST',headers:{origin:'http://127.0.0.1:18991'}})).status,401);
  const login=await request('/api/admin/login',{method:'POST',headers:{origin:'http://127.0.0.1:18991','content-type':'application/json'},body:JSON.stringify({username:'fixture-admin',password:'test-only-password'})});
  const headers={cookie:login.headers.get('set-cookie').split(';')[0],origin:'http://127.0.0.1:18991','content-type':'application/json'};
  assert.equal((await request('/api/admin/vault/setup',{method:'POST',headers:{...headers,origin:'https://other.invalid'}})).status,403);
  assert.equal((await request('/api/admin/vault/key',{method:'POST',headers:{...headers,origin:'https://other.invalid'}})).status,403);
  assert.equal((await(await request('/api/admin/vault/setup',{method:'POST',headers})).json()).secret,secret);
  assert.equal((await request('/api/admin/vault/control',{method:'POST',headers,body:JSON.stringify({enabled:true,enroll:true,code:'bad'})})).status,403);
  assert.equal((await request('/api/admin/vault/control',{method:'POST',headers,body:JSON.stringify({enabled:true,enroll:true,code:totpCode(secret,Math.floor(Date.now()/30000))})})).status,200);
  assert.equal((await request('/api/admin/vault/setup',{method:'POST',headers})).status,409);
  assert.ok(!JSON.stringify(await(await request('/api/admin/vault',{headers})).json()).includes(secret));
  const loginBody={username:'fixture-admin',password:'test-only-password'};
  const noOtp=await request('/api/admin/login',{method:'POST',headers,body:JSON.stringify(loginBody)});assert.equal(noOtp.status,403);assert.equal(noOtp.headers.get('set-cookie'),null);
  const withOtp={...loginBody,code:totpCode(secret,Math.floor(Date.now()/30000))};
  const verified=await request('/api/admin/login',{method:'POST',headers,body:JSON.stringify(withOtp)});assert.equal(verified.status,200);
  const replay=await request('/api/admin/login',{method:'POST',headers,body:JSON.stringify(withOtp)});assert.equal(replay.status,403);assert.equal(replay.headers.get('set-cookie'),null);
  const records=await(await request('/api/sparkdraw/records?kind=wallet&address=0x1111111111111111111111111111111111111111')).json();assert.equal(records.rows.length,0);assert.equal(records.claims.length,3);
});
