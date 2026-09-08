// Every request is fulfilled from local fixtures: no real wallet, signatures,
// approvals, transactions, production API calls, or chain requests are allowed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {GAME,TOKEN} from '../bem-production-site/web/sparkdraw-transactions.js';
import {profile} from '../bem-production-site/web/sparkdraw-profiles.js';
import {SPARKDRAW as F} from '../bem-production-site/web/sparkdraw-config.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dist=path.resolve(process.env.DIST_DIR||'bem-production-site/dist');
const origin='https://127.0.0.1:18797';
const account='0x1111111111111111111111111111111111111111';
const other='0x2222222222222222222222222222222222222222';
const runtime=JSON.parse(await fs.readFile(new URL('./fixtures/drand/deployed-five-runtime.json',import.meta.url)));
const bitmap=indices=>{
  const words=Array(40).fill(0n);
  for(const index of indices)words[Math.floor(index/256)]|=1n<<BigInt(index%256);
  return words.map(String);
};
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const purchase=(id,indices,extra={})=>({transactionHash:hash(id),timeUtc:'2026-09-08T12:00:00Z',tickets:indices.length,bitmap:bitmap(indices),...extra});
const bigPurchase=purchase(1,Array.from({length:5000},(_,index)=>index));
const boundaryPurchase=purchase(2,[0,255,256,9999]);
const partialPurchase=purchase(3,[6,42,9998],{requested:5000});
const missingPurchase={transactionHash:hash(4),timeUtc:'2026-09-08T12:00:00Z',tickets:2};
const invalidPurchase=purchase(5,[1],{tickets:2});
const emptyPurchase=purchase(6,[]);
const round=(id,purchases,owner=account,poolId='5')=>({
  account:owner,poolId,roundId:String(id),displayRoundId:String(id),status:1,
  tickets:purchases.reduce((count,p)=>count+p.tickets,0),purchases,paid:'250000000',
  refundablePrincipal:'0',burnedPrincipal:'0',burnedPrize:'0',burns:[]
});
const firstRows=[round(10,[bigPurchase]),round(11,[boundaryPurchase,partialPurchase],account,'10'),
  round(12,[missingPurchase,invalidPurchase,emptyPurchase])];
// Identical purchase identity with different owner evidence checks that open state
// cannot leak merely because pool/round/transaction keys happen to be reused.
const otherRows=[round(10,[purchase(1,[777,9999])],other)];
const expectedBig=Array.from({length:5000},(_,index)=>String(index+1).padStart(5,'0')).join(' ');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  for(const mode of ['desktop-restored-wallet','mobile-manual-address']){
    const mobile=mode.startsWith('mobile');
    const context=await browser.newContext({serviceWorkers:'block',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},
      ...(mobile?{isMobile:true,hasTouch:true,deviceScaleFactor:3,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'}:{})});
    const page=await context.newPage(),errors=[],requests=[],walletCalls=[],numberDimensions=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({account,other,connected})=>{
      const intervals=new Map(),listeners={};let current=account;
      window.setInterval=(fn,delay)=>{const fns=intervals.get(delay)||[];fns.push(fn);intervals.set(delay,fns);return fns.length;};
      window.__tick=delay=>{for(const fn of intervals.get(delay)||[])fn();};
      window.__changeAccount=()=>{current=other;for(const fn of listeners.accountsChanged||[])fn([other]);};
      window.__clipboardFail=false;window.__copied=[];window.__walletCalls=[];
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{
        if(window.__clipboardFail)throw Error('Fixture clipboard unavailable');window.__copied.push(value);
      }}});
      if(connected)window.ethereum={isMetaMask:true,on(name,fn){(listeners[name]??=[]).push(fn);},request:async({method})=>{
        window.__walletCalls.push(method);
        if(method==='eth_accounts')return[current];if(method==='eth_chainId')return'0x38';
        throw Error('Fixture forbids interactive wallet requests: '+method);
      }};
    },{account,other,connected:!mobile});
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      assert.equal(url.origin,origin,'External requests are forbidden');
      const reply=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
      if(url.pathname.startsWith('/api/')||url.pathname==='/rpc')requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams)});
      if(url.pathname==='/api/sparkdraw/state')return reply({version:5,address:profile(url.searchParams.get('pool')||'5').address,
        currentRoundId:'1',time:Math.floor(Date.now()/1000),rounds:[{roundId:'1',status:0,sold:0}],keeper:{}});
      if(url.pathname==='/api/sparkdraw/records'){
        const rows=url.searchParams.get('kind')==='wallet'?(url.searchParams.get('address')?.toLowerCase()===other?otherRows:firstRows):[];
        return reply({rows,claims:[],total:rows.length,page:1,totalPages:1});
      }
      if(url.pathname==='/api/burns/summary')return reply({totalBaseUnits:'0',updatedAt:new Date().toISOString()});
      if(url.pathname==='/api/market')return reply({});
      if(url.pathname==='/rpc'){
        const input=request.postDataJSON(),calls=Array.isArray(input)?input:[input];
        const results=calls.map(call=>{
          let value;
          if(call.method==='eth_call'){
            const tx=call.params[0],iface=tx.to.toLowerCase()===F.bem.toLowerCase()?TOKEN:GAME,decoded=iface.parseTransaction(tx);
            const values={currentRoundId:[1],rounds:[0,0,0,0,0,0,0,0,0,'0x'+'0'.repeat(40)],ticketsOf:[0],ticketWords:[Array(556).fill(0)],balanceOf:[10000000000n],allowance:[10000000000n]};
            assert.ok(values[decoded.name],`Unexpected read ${decoded.name}`);value=iface.encodeFunctionResult(decoded.fragment,values[decoded.name]);
          }else value={eth_getCode:runtime.code,eth_gasPrice:'0x2faf080',eth_blockNumber:'0x100',eth_getBalance:'0xde0b6b3a7640000'}[call.method];
          assert.notEqual(value,undefined,`Unexpected RPC method ${call.method}`);return{jsonrpc:'2.0',id:call.id,result:value};
        });return reply(Array.isArray(input)?results:results[0]);
      }
      const file=path.resolve(dist,url.pathname==='/'?'index.html':url.pathname.slice(1));
      assert.ok(file.startsWith(dist+path.sep),'Only built files are exposed');
      try{return await route.fulfill({status:200,path:file,contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'}[path.extname(file)]});}
      catch{return route.fulfill({status:404,body:''});}
    });
    const details=id=>page.locator(`#personal-list details[data-purchase-key*="${hash(id)}"]`);
    const open=async id=>{const item=details(id);if(!await item.evaluate(node=>node.open))await item.locator('summary').click();await item.locator('.purchased-ticket-body').waitFor();return item;};
    const checkCompactNumbers=async()=>{
      const dimensions=await details(1).evaluate(node=>{
        const field=node.querySelector('textarea'),style=getComputedStyle(field),rect=field.getBoundingClientRect();
        return{viewport:innerWidth,height:rect.height,detailsHeight:node.getBoundingClientRect().height,
          clientHeight:field.clientHeight,scrollHeight:field.scrollHeight,resize:style.resize,overflowY:style.overflowY,
          overscrollBehavior:style.overscrollBehavior,left:rect.left,right:rect.right,
          documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,
          children:[...node.querySelectorAll('summary,.purchased-ticket-body,button,p')].map(child=>{
            const css=getComputedStyle(child);return{tag:child.tagName,height:child.getBoundingClientRect().height,
              marginTop:css.marginTop,marginBottom:css.marginBottom,paddingTop:css.paddingTop,paddingBottom:css.paddingBottom,fontSize:css.fontSize,lineHeight:css.lineHeight};
          })};
      });
      if(mobile&&process.env.ARTIFACT_DIR){
        await fs.mkdir(process.env.ARTIFACT_DIR,{recursive:true});
        await details(1).scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(process.env.ARTIFACT_DIR,`purchased-numbers-mobile-${dimensions.viewport}.png`)});
      }
      assert.equal(dimensions.height,160,'A 5000-number list retains the fixed 160px height');
      assert.ok(dimensions.scrollHeight>dimensions.clientHeight,'Remaining numbers scroll inside the field');
      assert.equal(dimensions.resize,'none','Dragging cannot expand the number field');
      assert.equal(dimensions.overflowY,'auto','Number field owns its vertical scrolling');
      assert.equal(dimensions.overscrollBehavior,'contain','Reaching the list edge does not scroll the surrounding page');
      assert.ok(dimensions.detailsHeight<320,`Expanded number details stay below 320px: ${JSON.stringify(dimensions)}`);
      if(mobile){
        assert.ok(dimensions.documentWidth<=dimensions.viewport+1&&dimensions.bodyWidth<=dimensions.viewport+1,JSON.stringify(dimensions));
        assert.ok(dimensions.left>=0&&dimensions.right<=dimensions.viewport+1,'Compact number field fits a narrow mobile viewport');
      }
      numberDimensions.push(dimensions);
    };
    const waitRows=async count=>page.waitForFunction(count=>document.querySelectorAll('#personal-list details').length===count,count);
    const refresh=async()=>{
      await details(1).evaluate(node=>{node.dataset.beforeRefresh='yes';});
      await page.evaluate(()=>window.__tick(10000));
      await page.waitForFunction(()=>!document.querySelector('#personal-list [data-before-refresh]'));
    };
    await page.goto(origin+'/#mine');
    if(mobile){
      await page.locator('#personal-wallet').fill(account);await page.locator('#personal-search').click();
    }else await page.waitForFunction(()=>document.getElementById('wallet-address').textContent.length===42);
    await waitRows(6);
    assert.equal(await page.locator('#personal-list article').count(),3,'Multiple rounds remain separate');
    assert.equal(await page.locator('#personal-list textarea').count(),0,'Numbers are not rendered before expansion');
    assert.equal(await page.locator('#personal-list details[open]').count(),0,'Every purchase initially stays collapsed');
    await open(1);
    assert.equal(await details(1).locator('textarea').inputValue(),expectedBig,'Every one of 5000 numbers is present without truncation');
    assert.equal((await details(1).locator('textarea').inputValue()).split(' ').length,5000);
    await checkCompactNumbers();
    if(mobile){
      await page.setViewportSize({width:320,height:844});
      await checkCompactNumbers();
      if(process.env.ARTIFACT_DIR){
        await fs.mkdir(process.env.ARTIFACT_DIR,{recursive:true});
        await details(1).scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(process.env.ARTIFACT_DIR,'purchased-numbers-mobile-320.png')});
      }
      await page.setViewportSize({width:390,height:844});
      if(process.env.ARTIFACT_DIR){
        await details(1).scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(process.env.ARTIFACT_DIR,'purchased-numbers-mobile-390.png')});
      }
    }
    await open(2);
    assert.equal(await details(2).locator('textarea').inputValue(),'00001 00256 00257 10000','Zero-based boundary indices map to the correct player numbers');
    await open(3);
    assert.equal(await details(3).locator('textarea').inputValue(),'00007 00043 09999','Partial fills show the actual three allocated numbers');
    assert.match(await details(3).locator('summary').textContent(),/3 个/);
    for(const id of [4,5]){
      await open(id);assert.match(await details(id).textContent(),/号码记录暂不可用/,'Missing or inconsistent evidence is explicit');
      assert.equal(await details(id).locator('textarea,button').count(),0,'Unavailable records expose no fabricated numbers or copy action');
    }
    await open(6);assert.match(await details(6).textContent(),/本次未分配号码/);
    await details(1).getByRole('button',{name:'复制全部号码',exact:true}).click();
    await page.waitForFunction(()=>window.__copied.length===1);
    assert.equal(await page.evaluate(()=>window.__copied[0]),expectedBig,'Copy contains the complete 5000-number allocation');
    assert.match(await details(1).locator('[role="status"]').textContent(),/已复制全部 5000 个号码/);
    await page.evaluate(()=>{window.__clipboardFail=true;});
    await details(2).getByRole('button',{name:'复制全部号码',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('textarea:focus')?.selectionEnd===23);
    assert.deepEqual(await details(2).locator('textarea').evaluate(node=>({start:node.selectionStart,end:node.selectionEnd,length:node.value.length})),{start:0,end:23,length:23});
    assert.match(await details(2).locator('[role="status"]').textContent(),/号码已选中/);
    // Keeping a large textarea scrolled is essential during ten-second refreshes.
    const scrollBefore=await details(1).locator('textarea').evaluate(node=>{node.scrollTop=180;return node.scrollTop;});
    assert.ok(scrollBefore>0,'Large allocation is internally scrollable');
    await refresh();
    assert.equal(await details(1).evaluate(node=>node.open),true,'Refresh preserves expansion for the same viewer');
    await page.waitForFunction(({key,scrollBefore})=>Math.abs(document.querySelector(`details[data-purchase-key*="${key}"] textarea`).scrollTop-scrollBefore)<=1,{key:hash(1),scrollBefore});
    assert.equal(await details(1).locator('textarea').inputValue(),expectedBig,'Refresh preserves full contents');
    await page.locator('#language-en').click();
    await page.waitForFunction(()=>document.querySelector('#personal-list details summary')?.textContent==='View numbers (5000)');
    assert.equal(await details(1).evaluate(node=>node.open),true,'Language changes retain expanded purchase');
    assert.equal(await details(1).getByRole('button',{name:'Copy all numbers',exact:true}).count(),1);
    assert.equal(await details(1).locator('textarea').getAttribute('aria-label'),'Numbers purchased in this transaction');
    await page.locator('#language-zh').click();
    await page.waitForFunction(()=>document.querySelector('#personal-list details summary')?.textContent==='查看号码（5000 个）');
    if(mobile){
      const dimensions=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth,
        fields:[...document.querySelectorAll('#personal-list textarea')].map(node=>({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right}))}));
      assert.ok(dimensions.document<=dimensions.width+1&&dimensions.body<=dimensions.width+1,JSON.stringify(dimensions));
      assert.ok(dimensions.fields.every(field=>field.left>=0&&field.right<=dimensions.width+1),'Expanded numbers fit the mobile viewport');
      await page.locator('#personal-wallet').fill(other);await page.locator('#personal-search').click();
    }else await page.evaluate(()=>window.__changeAccount());
    await waitRows(1);
    assert.equal(await details(1).evaluate(node=>node.open),false,'Changing the owner or connected account clears old expansion state');
    assert.equal(await details(1).locator('textarea').count(),0,'New owner starts with unrendered details');
    await open(1);assert.equal(await details(1).locator('textarea').inputValue(),'00778 10000','Only the newly queried owner allocation is rendered');
    const lastWalletRead=requests.filter(request=>request.query.kind==='wallet').at(-1);
    assert.equal(lastWalletRead.query.address.toLowerCase(),other);
    walletCalls.push(...await page.evaluate(()=>window.__walletCalls));
    assert.ok(walletCalls.every(method=>['eth_accounts','eth_chainId'].includes(method)),'No interactive wallet requests occurred');
    assert.deepEqual(errors,[],'No page runtime errors');
    console.log(JSON.stringify({case:mode,passed:true,largeAllocation:5000,boundaries:[0,255,256,9999],partialAllocation:3,
      scenarios:['lazy-details','fixed-height-scrollable-list','multiple-purchases-and-rounds','missing-and-invalid-evidence','empty-allocation','clipboard-success-and-fallback','refresh-open-and-scroll','language','identity-change',...(mobile?['mobile-width-390-and-320']:[])],numberDimensions,walletCalls,errors}));
    await context.close();
  }
}finally{await browser.close();}
