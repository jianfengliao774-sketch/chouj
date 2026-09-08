// Fully intercepted browser fixture: no production requests, wallet signatures,
// approvals or transactions. Deterministic interval ticks count work by tab.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {GAME,TOKEN} from '../bem-production-site/web/sparkdraw-transactions.js';
import {profile} from '../bem-production-site/web/sparkdraw-profiles.js';
import {SPARKDRAW as F} from '../bem-production-site/web/sparkdraw-config.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dist=path.resolve(process.env.DIST_DIR||'bem-production-site/dist'),origin='https://127.0.0.1:18798';
const account='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222';
const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/drand/deployed-five-runtime.json',import.meta.url)));
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const verify=(actual,expected,label)=>{if(!process.env.REPORT_ONLY)assert.deepEqual(actual,expected,label);};
try{
  for(const connected of [false,true])for(const tab of ['draw','proof','burns','mine']){
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
    const errors=[],requests=[];let recordDelay=40,rateLimitedState=false;page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({connected,account,other})=>{
      let offset=0,hidden=false,current=account;const now=Date.now.bind(Date),intervals=new Map(),listeners={};
      Date.now=()=>now()+offset;window.setInterval=(fn,delay)=>{const list=intervals.get(delay)||[];list.push(fn);intervals.set(delay,list);return list.length;};
      window.__tick=ms=>{offset+=ms;for(const fn of intervals.get(ms)||[])fn();};
      Object.defineProperty(document,'hidden',{get:()=>hidden});
      window.__hidden=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));};
      window.__changeAccount=()=>{current=other;for(const fn of listeners.accountsChanged||[])fn([other]);};
      if(connected)window.ethereum={isMetaMask:true,on(name,fn){(listeners[name]??=[]).push(fn);},request:async({method})=>{
        if(method==='eth_accounts')return[current];if(method==='eth_chainId')return'0x38';
        throw Error('Fixture forbids interactive wallet requests: '+method);
      }};
    },{connected,account,other});
    await context.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());assert.equal(url.origin,origin,'No external network');
      const reply=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
      if(url.pathname.startsWith('/api/')||url.pathname==='/rpc')requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),body:req.postDataJSON()});
      if(url.pathname==='/api/sparkdraw/state'){
        if(rateLimitedState)return route.fulfill({status:429,headers:{'retry-after':'10'},contentType:'application/json',body:JSON.stringify({error:'Fixture rate limit'})});
        return reply({version:5,address:profile(url.searchParams.get('pool')||'5').address,currentRoundId:'1',time:Math.floor(Date.now()/1000),rounds:[{roundId:'1',status:0,sold:0}],keeper:{}});
      }
      if(url.pathname==='/api/sparkdraw/records'){
        // A small delay makes duplicate consumers overlap on the same request.
        await new Promise(resolve=>setTimeout(resolve,recordDelay));
        return reply({rows:[],claims:connected?[{poolId:'5',refunds:[],prizes:[],refundCount:0,refundablePrincipal:'0'}]:[],total:0,page:1,totalPages:1});
      }
      if(url.pathname==='/api/burns/summary')return reply({totalBaseUnits:'0',updatedAt:new Date().toISOString()});
      if(url.pathname==='/api/market')return reply({});
      if(url.pathname==='/rpc'){
        const input=req.postDataJSON(),rows=Array.isArray(input)?input:[input];
        const result=rows.map(row=>{
          let value;
          if(row.method==='eth_call'){
            const tx=row.params[0],iface=tx.to.toLowerCase()===F.bem.toLowerCase()?TOKEN:GAME,call=iface.parseTransaction(tx);
            const values={currentRoundId:[1],rounds:[0,0,0,0,0,0,0,0,0,'0x'+'0'.repeat(40)],ticketsOf:[0],ticketWords:[Array(556).fill(0)],balanceOf:[10000000000n],allowance:[10000000000n]};
            assert.ok(values[call.name],call.name);value=iface.encodeFunctionResult(call.fragment,values[call.name]);
          }else value={eth_getCode:fixture.code,eth_estimateGas:'0xb71b00',eth_gasPrice:'0x2faf080',eth_blockNumber:'0x100',eth_getBalance:'0xde0b6b3a7640000'}[row.method];
          assert.notEqual(value,undefined,row.method);return{jsonrpc:'2.0',id:row.id,result:value};
        });return reply(Array.isArray(input)?result:result[0]);
      }
      const file=path.resolve(dist,url.pathname==='/'?'index.html':url.pathname.slice(1));assert.ok(file.startsWith(dist+path.sep));
      try{return await route.fulfill({status:200,path:file,contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]});}catch{return route.fulfill({status:404,body:''});}
    });
    const settle=()=>page.waitForTimeout(350),summary=rows=>({api:rows.filter(r=>r.path.startsWith('/api/')).length,records:rows.filter(r=>r.path==='/api/sparkdraw/records').length,state:rows.filter(r=>r.path==='/api/sparkdraw/state').length,burnSummary:rows.filter(r=>r.path==='/api/burns/summary').length,estimates:rows.flatMap(r=>r.path==='/rpc'?(Array.isArray(r.body)?r.body:[r.body]):[]).filter(r=>r.method==='eth_estimateGas').length});
    await page.goto(origin+(tab==='burns'?'/burns.html':`/#${tab}`));await settle();
    if(connected)await page.waitForFunction(()=>document.getElementById('wallet-address').textContent.length===42);
    await settle();const startup=summary(requests);
    if(!connected){verify(startup.records,tab==='burns'?6:3,'Only visible records plus ticker load');verify(startup.burnSummary,tab==='burns'?1:0,'Hidden burn summary is deferred');}
    if(connected&&tab!=='draw')verify(startup.estimates,0,'Non-purchase tab never estimates gas');
    if(connected&&tab==='draw')assert.match(await page.locator('#refund-state').textContent(),/暂无可退本金/,'Homepage refund remains populated');
    if(connected&&tab==='mine')assert.match(await page.locator('#personal-status').textContent(),/已确认/,'Personal records remain populated');
    requests.length=0;await page.evaluate(()=>window.__tick(10000));await settle();const recordsTick=summary(requests);
    verify(recordsTick.records,tab==='burns'?(connected?7:6):tab==='draw'||tab==='mine'?(connected?4:3):3,'One records tick requests only current content');
    requests.length=0;for(let i=0;i<5;i++){await page.evaluate(()=>window.__tick(2000));await settle();}const stateTicks=summary(requests);
    verify(stateTicks.state,tab==='draw'?5:1,'Non-draw state refresh slows to ten seconds');
    if(connected&&tab!=='draw')verify(stateTicks.estimates,0,'Non-draw polling never estimates gas');
    requests.length=0;await page.evaluate(()=>{window.__hidden(true);window.__tick(10000);window.__tick(2000);window.__tick(300000);});await settle();verify(summary(requests).api,0,'Hidden tab issues no automatic API reads');verify(summary(requests).estimates,0,'Hidden tab does not prewarm');
    await page.evaluate(()=>window.__hidden(false));await settle();
    if(connected){requests.length=0;await page.evaluate(()=>window.__changeAccount());await settle();const walletRows=requests.filter(r=>r.query.kind==='wallet');verify(walletRows.every(r=>r.query.address===other),true,'Changed identity only queries the new account');if(tab==='draw'||tab==='mine'||tab==='burns')assert.ok(walletRows.length,'Relevant account records refresh');}
    await page.locator('#language-en').click();await settle();
    if(!connected&&tab==='proof'){
      requests.length=0;recordDelay=250;
      await page.evaluate(()=>{document.getElementById('refresh-history').click();document.getElementById('refresh-history').click();});await settle();
      verify(summary(requests).records,3,'Rapid refreshes share pending ticker and proof reads');
    }
    if(!connected&&tab==='draw'){
      requests.length=0;rateLimitedState=true;
      await page.evaluate(()=>window.__tick(2000));await settle();
      for(let i=0;i<4;i++){await page.evaluate(()=>window.__tick(2000));await settle();}
      verify(summary(requests).state,1,'429 suppresses repeated state reads until Retry-After');
      await page.evaluate(()=>window.__tick(2000));await settle();verify(summary(requests).state,2,'Next scheduled refresh retries after Retry-After');
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({case:tab,connected,startup,recordsTick,stateTicks,errors}));await context.close();
  }
}finally{await browser.close();}
