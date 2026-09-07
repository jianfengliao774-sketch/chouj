import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Interface,keccak256,getAddress} from 'ethers';
import {SPARKDRAW as F} from './web/sparkdraw-config.js';
import {POOL_IDS,POOLS,profile,VERIFIER,VERIFIER_HASH} from './web/sparkdraw-profiles.js';
import {createReadRpc,validateReadRequest} from './rpc.mjs';
import {createSparkDrawIndex} from './sparkdraw-index.mjs';
import {createAdminAuth} from './auth.mjs';
import {createMarketPriceService} from './market-price.mjs';
const SITE=path.dirname(fileURLToPath(import.meta.url));
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
const int=x=>Number(BigInt(x));
export async function createSparkDrawService({rpc=createReadRpc(),directory,credential,origin='http://127.0.0.1:8788',staticRoot=path.join(SITE,'dist'),verify=true}={}){
  const abi=JSON.parse(await fs.readFile(path.join(SITE,'web/sparkdraw-abi.json'),'utf8')),game=new Interface(abi);
  const call=async(id,name,args=[],block='latest')=>game.decodeFunctionResult(name,await rpc('eth_call',[{to:profile(id).address,data:game.encodeFunctionData(name,args)},block]));
  if(verify){
    if(BigInt(await rpc('eth_chainId',[]))!==56n||keccak256(await rpc('eth_getCode',[VERIFIER,'latest']))!==VERIFIER_HASH)throw Error('Verifier identity mismatch');
    for(const id of POOL_IDS){const p=profile(id);if(keccak256(await rpc('eth_getCode',[p.address,'latest']))!==p.runtimeHash)throw Error('Pool identity mismatch');
      const [pool,verifier,revenue]=await Promise.all(['ROUND_POOL','verifier','organizer'].map(n=>call(id,n)));
      if(pool[0]!==BigInt(p.units)||verifier[0].toLowerCase()!==VERIFIER.toLowerCase()||revenue[0].toLowerCase()!==F.revenue.toLowerCase())throw Error('Pool binding mismatch');
    }
  }
  const index=await createSparkDrawIndex({rpc,abi,directory}),auth=createAdminAuth({credential}),market=createMarketPriceService();
  const evidence=JSON.parse(await fs.readFile(path.join(SITE,'web/public/sparkdraw/deployed-contracts.json'),'utf8'));
  const registry={version:5,chainId:56,verifier:evidence.deployments[0],pools:Object.fromEntries(evidence.deployments.slice(1).map(x=>[x.kind,x]))};
  const cache=new Map();
  function cached(key,ttl,fn){const old=cache.get(key);if(old&&Date.now()-old.at<ttl)return old.promise;
    const item={at:Date.now(),promise:Promise.resolve().then(fn)};cache.set(key,item);item.promise.catch(()=>{if(cache.get(key)===item)cache.delete(key);});return item.promise;}
  async function readRound(id,roundId,tag){
    const [r,early,sealed,beacon,prize,burned]=await Promise.all(['rounds','earlyDrawDeadline','sealedAt','beaconRound','prizes','unclaimedPrincipalBurned'].map(n=>call(id,n,[roundId],tag)));
    return{poolId:id,roundId:String(roundId),status:int(r[0]),sold:int(r[1]),fundingDeadline:int(r[2]),drawDeadline:int(r[3]),winningTicket:int(r[8]),winner:r[9],
      earlyDrawDeadline:int(early[0]),sealedAt:int(sealed[0]),beaconRound:String(beacon[0]),beaconAvailableAt:beacon[0]?F.genesis+(int(beacon[0])-1)*F.beaconPeriod:0,
      prize:{amount:String(prize[0]),settledAt:int(prize[1]),claimDeadline:int(prize[2]),claimed:prize[3],burned:prize[4]},principalBurned:burned[0]};
  }
  const state=id=>cached('state:'+id,3000,async()=>{
    const b=await rpc('eth_getBlockByNumber',['latest',false]),current=(await call(id,'currentRoundId',[],b.number))[0];
    const ids=[current];if(current>1n)ids.push(current-1n);
    const rounds=await Promise.all(ids.map(n=>readRound(id,n,b.number)));
    return{version:5,chainId:56,poolId:id,address:profile(id).address,blockNumber:int(b.number),blockHash:b.hash,time:int(b.timestamp),currentRoundId:String(current),rounds,index:index.metadata(id),keeper:{configured:false}};
  });
  function selected(params){const id=params.get('pool')||'all';if(id==='all')return POOL_IDS;profile(id);return[id];}
  function pageRows(rows,params){const page=Number(params.get('page')||1);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw Error('Invalid page');
    return{rows:rows.slice((page-1)*20,page*20),page,total:rows.length,totalPages:Math.max(1,Math.ceil(rows.length/20))};}
  const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
  const respond=(res,code,data,extra={})=>{res.writeHead(code,{...headers,...extra});res.end(json(data));};
  async function body(req){if(!/^application\/json/.test(req.headers['content-type']||''))throw Error('JSON required');let size=0;const chunks=[];
    for await(const c of req){size+=c.length;if(size>524288)throw Error('Request too large');chunks.push(c);}return JSON.parse(Buffer.concat(chunks));}
  const rate=new Map();
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try{
      if(req.headers.host!==new URL(origin).host)return respond(res,403,{error:'Unexpected host'});
      const url=new URL(req.url,origin),isApi=url.pathname.startsWith('/api/')||url.pathname==='/rpc';
      if(req.headers.origin&&req.headers.origin!==origin)return respond(res,403,{error:'Unexpected origin'});
      const peer=req.socket.remoteAddress,ip=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)?String(req.headers['x-real-ip']||peer):peer;
      if(isApi){const now=Date.now();if(rate.size>5000)for(const[k,v]of rate)if(now-v.at>60000)rate.delete(k);
        const key=ip+':'+(url.pathname==='/rpc'?'rpc':'api');let r=rate.get(key);if(!r||now-r.at>60000){r={at:now,n:0};rate.set(key,r);}if(++r.n>1200)return respond(res,429,{error:'Too many requests'},{'retry-after':'5'});}
      if(req.method==='GET'&&url.pathname==='/api/health')return respond(res,200,{mode:'production',version:5,chainId:56,salesEnabled:true,pools:POOL_IDS});
      if(req.method==='GET'&&['/api/config','/api/pools'].includes(url.pathname))return respond(res,200,{version:5,mode:'production',chainId:56,verifier:VERIFIER,bem:F.bem,revenue:F.revenue,pools:POOLS});
      if(req.method==='GET'&&url.pathname==='/api/sparkdraw/deployments')return respond(res,200,registry);
      if(req.method==='GET'&&url.pathname==='/api/market')return respond(res,200,await market.getQuote());
      if(req.method==='POST'&&url.pathname==='/rpc'){
        const input=await body(req),batch=Array.isArray(input),items=batch?input:[input];if(items.length<1||items.length>25)throw Error('Invalid batch');
        const results=await Promise.all(items.map(async q=>{try{const s=validateReadRequest(q);return{jsonrpc:'2.0',id:s.id,result:await rpc(s.method,s.params)};}catch(e){return{jsonrpc:'2.0',id:q?.id??null,error:{code:e.code||-32000,message:'Chain read unavailable: '+String(e.message).slice(0,90)}};}}));return respond(res,200,batch?results:results[0]);
      }
      if(req.method==='GET'&&url.pathname==='/api/sparkdraw/state'){const id=url.searchParams.get('pool');profile(id);return respond(res,200,await state(id));}
      if(req.method==='GET'&&url.pathname==='/api/sparkdraw/beacon'){
        const id=url.searchParams.get('pool');profile(id);const rid=url.searchParams.get('round');if(!/^[1-9][0-9]{0,20}$/.test(rid))throw Error('Invalid round');
        const s=await readRound(id,BigInt(rid),'latest');if(s.status!==3||!Number(s.beaconRound))throw Error('No beacon requested');
        const proof=await cached('beacon:'+s.beaconRound,30000,async()=>{const r=await fetch(`https://api.drand.sh/${F.beaconHash}/public/${s.beaconRound}`,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('Beacon not available yet');const data=await r.json();if(String(data.round)!==s.beaconRound||!/^[a-f0-9]{128}$/i.test(data.signature))throw Error('Invalid beacon response');return{round:s.beaconRound,signature:'0x'+data.signature};});return respond(res,200,proof);
      }
      if(req.method==='GET'&&url.pathname==='/api/sparkdraw/records'){
        const ids=selected(url.searchParams),kind=url.searchParams.get('kind')||'rounds',now=Math.floor(Date.now()/1000);let rows;
        if(kind==='wallet'){const address=getAddress(url.searchParams.get('address'));rows=ids.flatMap(id=>index.view(id).wallet(address,now));}
        else if(kind==='burns')rows=ids.flatMap(id=>index.view(id).burns);
        else if(kind==='refunds')rows=ids.flatMap(id=>index.view(id).refundNotices(now));
        else if(kind==='prizes')rows=ids.flatMap(id=>index.view(id).pendingPrizes);
        else if(kind==='rounds')rows=ids.flatMap(id=>index.view(id).publicRounds);
        else if(kind==='winners')rows=ids.flatMap(id=>index.view(id).publicRounds).filter(r=>r.status===5);
        else throw Error('Invalid records kind');
        const round=url.searchParams.get('round');if(round){if(!/^[1-9][0-9]{0,20}$/.test(round))throw Error('Invalid round');rows=rows.filter(x=>x.roundId===round);}
        rows.sort((a,b)=>Number(b.roundId)-Number(a.roundId));
        const claims=kind==='wallet'?ids.map(poolId=>({poolId,
          refunds:rows.filter(r=>r.poolId===poolId&&BigInt(r.refundablePrincipal)>0n).map(r=>r.roundId).sort((a,b)=>Number(a)-Number(b)).slice(0,64),
          prizes:rows.filter(r=>r.poolId===poolId&&BigInt(r.claimablePrize)>0n).map(r=>r.roundId).sort((a,b)=>Number(a)-Number(b)).slice(0,64)})):undefined;
        return respond(res,200,{version:5,...pageRows(rows,url.searchParams),claims,indexes:Object.fromEntries(ids.map(id=>[id,index.metadata(id)]))});
      }
      if(req.method==='GET'&&url.pathname==='/api/burns/summary')return respond(res,200,await cached('burn-summary',300000,()=>({totalBaseUnits:POOL_IDS.flatMap(id=>index.view(id).burns).reduce((a,b)=>a+BigInt(b.amountBaseUnits),0n).toString(),updatedAt:new Date().toISOString(),indexes:Object.fromEntries(POOL_IDS.map(id=>[id,index.metadata(id)]))})));
      if(url.pathname.startsWith('/api/admin/')){
        if(req.method==='POST'&&req.headers.origin!==origin)return respond(res,403,{error:'Same-origin request required'});
        if(url.pathname==='/api/admin/login'&&req.method==='POST'){const d=await body(req),login=await auth.login({...d,ip});auth.logout(req.headers.cookie);return respond(res,200,{username:login.username},{'set-cookie':`bem2075_admin=${login.token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=900${origin.startsWith('https:')?'; Secure':''}`});}
        if(url.pathname==='/api/admin/logout'&&req.method==='POST'){auth.logout(req.headers.cookie);return respond(res,200,{signedOut:true},{'set-cookie':'bem2075_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0'});}
        const session=await auth.session(req.headers.cookie);if(!session)return respond(res,401,{error:'请先登录'});
        if(url.pathname==='/api/admin/overview'){
          const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
          return respond(res,200,{session,day,pools:POOL_IDS.map(id=>{const rounds=index.view(id).publicRounds,events=index.events(id);return{poolId:id,address:profile(id).address,index:index.metadata(id),todayCompleted:events.filter(e=>e.name==='Settled'&&new Date(Date.parse(e.timeUtc)+8*3600000).toISOString().startsWith(day)).length,rounds:rounds.slice(0,100).map(r=>({...r,startedAt:events.find(e=>e.name==='RoundStarted'&&e.args.roundId===r.roundId)?.timeUtc,lockedAt:events.find(e=>e.name==='RoundLocked'&&e.args.roundId===r.roundId)?.timeUtc}))};})});
        }
        if(url.pathname==='/api/admin/round'){const id=url.searchParams.get('pool');profile(id);const rid=url.searchParams.get('round');return respond(res,200,{events:index.events(id).filter(e=>e.args.roundId===rid)});}
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return respond(res,405,{error:'Method not allowed'});
      if(['/legacy.html','/start-test.html','/deploy-formal.html','/deploy-container.html'].includes(url.pathname)){res.writeHead(302,{location:'/?pool=0.1'});return res.end();}
      const name=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
      const allowed=['index.html','burns.html','admin.html','deploy-sparkdraw.html'].includes(name)||/^assets\/[a-zA-Z0-9_.-]+$/.test(name)||/^sparkdraw\/(standard-input|deployed-contracts)\.json$/.test(name);
      if(!allowed)return respond(res,404,{error:'Not found'});
      const file=path.resolve(staticRoot,name);if(!file.startsWith(path.resolve(staticRoot)+path.sep))throw Error('Invalid path');
      let bytes;try{bytes=await fs.readFile(file);}catch{return respond(res,404,{error:'Not found'});}
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.webp':'image/webp'};
      res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':name.startsWith('assets/')?'public, max-age=31536000, immutable':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);
    }catch(e){respond(res,e.authStatus||503,{error:e.authStatus?e.message:'读取暂时未完成，请稍后刷新。'});}
  });
  const timer=setInterval(()=>index.sync().catch(()=>{}),5000);timer.unref();index.sync().catch(()=>{});server.on('close',()=>clearInterval(timer));
  return{server,index,state};
}
export async function startSparkDraw(){
  const port=Number(process.argv[3]||8788);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  const directory=process.env.BEM_DATA_DIR;if(!directory||!path.isAbsolute(directory))throw Error('Absolute data directory required');
  const credential=JSON.parse(await fs.readFile(process.env.BEM_ADMIN_CREDENTIALS_FILE,'utf8'));
  const {server}=await createSparkDrawService({directory,credential,origin:process.env.BEM_PUBLIC_ORIGIN,rpc:createReadRpc({endpoint:process.env.BEM_RPC_URL,logsEndpoint:process.env.BEM_LOGS_RPC_URL})});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
  console.log('SparkDraw V5 serving five verified pools; signing remains in user wallets.');
}
