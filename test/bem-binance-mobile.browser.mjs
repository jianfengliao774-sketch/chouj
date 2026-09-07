// Run after building. Uses an isolated browser, mocked chain and mocked wallet;
// all network requests are intercepted. No real account, signature or broadcast.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {keccak256,Interface,solidityPacked,toQuantity} from 'ethers';
import {GAME,TOKEN} from '../bem-production-site/web/sparkdraw-transactions.js';
import {profile} from '../bem-production-site/web/sparkdraw-profiles.js';
import {SPARKDRAW as F} from '../bem-production-site/web/sparkdraw-config.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const p=profile('5'),account='0x1111111111111111111111111111111111111111',hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64);
const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/drand/deployed-five-runtime.json',import.meta.url)));
assert.equal(keccak256(fixture.code),p.runtimeHash);
const browser=await chromium.launch({headless:true,args:['--disable-gpu'],...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const wrapper=new Interface(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
const dist=path.resolve('bem-production-site/dist');
const rpcDelay=Number(process.env.RPC_DELAY_MS??40),walletDelay=Number(process.env.WALLET_DELAY_MS??0);
try{
  for(const scenario of [
    {name:'desktop Binance, automatic 5000, already approved',mobile:false,approval:false,selected:false},
    {name:'mobile late Binance namespace, approval then automatic 5000',mobile:true,approval:true,selected:false},
    {name:'desktop Binance, manually selected 5000',mobile:false,approval:false,selected:true},
    {name:'mobile all quantities clamp to wallet remainder, then follow account switch',mobile:true,approval:false,selected:false,sold:6500,held:4200,switchAccount:true},
    {name:'desktop quantity clamps to the pool remainder',mobile:false,approval:false,selected:false,sold:8800,held:0},
    {name:'mobile prepared purchase opens promptly',mobile:true,approval:false,selected:false,warm:true},
    {name:'mobile wrapped approval rejection unlocks retry',mobile:true,approval:true,selected:false,rejectApproval:true},
    {name:'wallet-wrapped 5000 purchase confirms and unlocks',mobile:false,approval:false,selected:false,confirmPurchase:'wrapped'},
    {name:'wallet-selected direct nonce confirms and unlocks',mobile:false,approval:false,selected:false,confirmPurchase:'nonce',holdReceipt:true},
    {name:'sold-out pool disables purchasing and shows zero available',mobile:false,approval:false,selected:false,sold:10000,held:0},
  ]){
    let receiptAvailable=!scenario.holdReceipt;
    let expected=Math.min(5000,10000-(scenario.sold||0),5000-(scenario.held||0));
    const context=await browser.newContext({viewport:scenario.mobile?{width:390,height:844}:{width:1280,height:900},isMobile:scenario.mobile,hasTouch:scenario.mobile});
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({account,hash,blockHash,mobile,walletDelay,rejectApproval,confirmPurchase})=>{
      window.__walletRequests=[];let authorized=false,currentAccount=account;const listeners={};
      document.addEventListener('click',e=>{if(e.target.closest?.('#buy'))window.__buyClickedAt=performance.now();},true);
      const provider={isBinance:true,on(name,fn){(listeners[name]??=[]).push(fn);},async request(q){
        window.__walletRequests.push({method:q.method,params:q.params,at:performance.now()});
        if(['eth_accounts','eth_chainId','eth_getTransactionCount'].includes(q.method))await new Promise(r=>setTimeout(r,walletDelay));
        if(q.method==='eth_requestAccounts'){authorized=true;return[currentAccount];}
        if(q.method==='eth_accounts')return authorized?[currentAccount]:[];
        if(q.method==='eth_chainId')return'0x38';
        if(q.method==='eth_getTransactionCount')return window.__approval?'0x2':'0x1';
        if(q.method==='eth_sendTransaction'){
          const tx=q.params[0];
          if(tx.data.startsWith('0x095ea7b3')){if(rejectApproval)throw{code:-32603,data:{originalError:{code:4001}}};window.__approval={...tx,input:tx.data,hash,blockHash,blockNumber:'0x100'};return hash;}
          if(confirmPurchase){window.__purchase={...tx,input:tx.data,hash:'0x'+'c'.repeat(64),blockHash,blockNumber:'0x100'};return window.__purchase.hash;}
          throw Object.assign(Error('Fixture rejects payment; nothing broadcast'),{code:4001});
        }
        throw Error('Unexpected wallet method: '+q.method);
      }};
      window.__installWallet=()=>{if(mobile)window.binancew3w={ethereum:provider};else window.ethereum=provider;};
      window.__switchWallet=()=>{currentAccount='0x2222222222222222222222222222222222222222';for(const fn of listeners.accountsChanged||[])fn([currentAccount]);};
      if(!mobile)window.__installWallet();
    },{account,hash,blockHash,mobile:scenario.mobile,walletDelay,rejectApproval:scenario.rejectApproval,confirmPurchase:scenario.confirmPurchase});
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      assert.equal(url.origin,'http://127.0.0.1:18796','No external requests allowed');
      const reply=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
      if(url.pathname==='/rpc'){
        assert.ok(Buffer.byteLength(request.postData())<=524288);
        const input=request.postDataJSON(),rows=Array.isArray(input)?input:[input];requests.push(rows);
        // Simulated round-trip delay reveals accidental serial query dependencies.
        await new Promise(r=>setTimeout(r,rpcDelay));
        const result=[];
        for(const row of rows){
          const [arg]=row.params;let value;
          if(row.method==='eth_call'){
            const iface=arg.to.toLowerCase()===F.bem.toLowerCase()?TOKEN:GAME,c=iface.parseTransaction(arg);
            const approval=await page.evaluate(()=>!!window.__approval);
            const words=Array(556).fill(0n);for(let n=0;n<(scenario.sold||0);n++)words[Math.floor(n/18)]|=1n<<BigInt(n%18*14);
            const held=c.name==='ticketsOf'&&c.args[1].toLowerCase()===account.toLowerCase()?(scenario.held||0):0;
            const values={currentRoundId:[1],rounds:[0,scenario.sold||0,0,0,0,0,0,0,0,'0x'+'0'.repeat(40)],ticketsOf:[held],ticketWords:[words],balanceOf:[10000000000n],allowance:[!scenario.approval||approval?10000000000n:0n]};
            assert.ok(values[c.name],c.name);value=iface.encodeFunctionResult(c.fragment,values[c.name]);
          }else if(row.method==='eth_getCode')value=fixture.code;
          else if(row.method==='eth_estimateGas')value='0xb71b00';
          else if(row.method==='eth_gasPrice')value='0x2faf080';
          else if(row.method==='eth_blockNumber')value='0x100';
          else if(row.method==='eth_getBalance')value='0xde0b6b3a7640000';
          else if(row.method==='eth_getTransactionByHash'){
            const tx=await page.evaluate(h=>window.__purchase?.hash===h?window.__purchase:window.__approval?.hash===h?window.__approval:null,arg);
            value=tx;
            if(tx&&scenario.confirmPurchase&&tx.hash==='0x'+'c'.repeat(64)){
              value={...tx,nonce:toQuantity(BigInt(tx.nonce)+1n)};
              if(scenario.confirmPurchase==='wrapped'){
                const data=wrapper.encodeFunctionData('redeemDelegations',[['0x'],['0x'+'0'.repeat(64)],[solidityPacked(['address','uint256','bytes'],[tx.to,0,tx.data])]]);
                value={...value,to:'0xdb9b1e94b5b69df7e401ddbede43491141047db3',input:data,data};
              }
            }
          }
          else if(row.method==='eth_getTransactionReceipt'){
            const tx=await page.evaluate(h=>window.__purchase?.hash===h?window.__purchase:null,arg);
            const decoded=tx?GAME.decodeFunctionData('buySelected',tx.data):null;
            const event=decoded?GAME.encodeEventLog(GAME.getEvent('PurchaseResult'),[decoded[0],tx.from,decoded[1].length,decoded[1].length,BigInt(decoded[1].length)*p.ticketPrice,0]):null;
            value=tx&&!receiptAvailable?null:{transactionHash:arg,status:'0x1',blockNumber:'0x100',blockHash,logs:event?[{...event,address:p.address}]:[]};
          }
          else if(row.method==='eth_getBlockByNumber')value={number:'0x100',hash:blockHash,transactions:[]};
          else if(row.method==='eth_getTransactionCount')value='0x2';
          else throw Error('Unexpected RPC: '+row.method);
          result.push({jsonrpc:'2.0',id:row.id,result:value});
        }
        return reply(Array.isArray(input)?result:result[0]);
      }
      if(url.pathname==='/api/sparkdraw/state')return reply({version:5,address:p.address,currentRoundId:'1',time:Math.floor(Date.now()/1000),rounds:[{roundId:'1',status:0,sold:scenario.sold||0}],keeper:{}});
      if(url.pathname==='/api/sparkdraw/records')return reply({rows:[],claims:[],total:0,page:1,totalPages:1});
      if(url.pathname==='/api/burns/summary')return reply({totalBaseUnits:'0',updatedAt:new Date().toISOString()});
      if(url.pathname==='/api/market')return reply({});
      const name=url.pathname==='/'?'index.html':url.pathname.slice(1),file=path.resolve(dist,name);
      assert.ok(file.startsWith(dist+path.sep));
      try{return await route.fulfill({status:200,path:file,contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]});}
      catch{return route.fulfill({status:404,body:''});}
    });
    await page.goto('http://127.0.0.1:18796/?pool=5');
    await page.locator('#connect-wallet').click();
    if(scenario.mobile){
      assert.equal(await page.getByRole('button',{name:/Binance Wallet/}).isDisabled(),true);
      await page.evaluate(()=>window.__installWallet());
    }
    const walletButton=page.getByRole('button',{name:/Binance Wallet/});
    await walletButton.click();
    await page.waitForFunction(()=>document.getElementById('wallet-address').textContent.startsWith('0x'));
    await page.waitForFunction(()=>document.getElementById('purchase-limit').textContent.includes('当前最多可买'));
    assert.ok((await page.locator('#purchase-limit').textContent()).replaceAll(',','').includes(`当前最多可买 ${expected}`));
    if(expected===0){
      assert.equal(await page.locator('#buy').isDisabled(),true);assert.equal(await page.locator('#ticket-count').inputValue(),'0');
      assert.equal(await page.locator('#purchase-total').textContent(),'0 BEM');
      assert.equal(await page.evaluate(()=>window.__walletRequests.some(q=>q.method==='eth_sendTransaction')),false);
      assert.deepEqual(errors,[]);console.log(JSON.stringify({scenario:scenario.name,available:0,passed:true}));await page.unrouteAll({behavior:'ignoreErrors'});await context.close();continue;
    }
    if(scenario.switchAccount){
      for(const count of ['1000','3000','5000']){
        await page.locator('#ticket-count').fill(count);assert.equal(await page.locator('#ticket-count').inputValue(),'800');
      }
      for(const count of ['1000','5000']){await page.locator(`[data-count="${count}"]`).click();assert.equal(await page.locator('#ticket-count').inputValue(),'800');}
      assert.equal(await page.locator('#purchase-total').textContent(),'0.4 BEM');
      await page.locator('[data-count="500"]').click();assert.equal(await page.locator('#ticket-count').inputValue(),'500');
      await page.locator('[data-count="5000"]').click();
      if(process.env.PURCHASE_SCREENSHOT)await page.locator('#purchase-card').screenshot({path:process.env.PURCHASE_SCREENSHOT});
      await page.evaluate(()=>window.__switchWallet());
      // A different account must obtain its own quota, not inherit 800 tickets.
      await page.waitForFunction(()=>document.getElementById('purchase-limit').textContent.replaceAll(',','').includes('当前最多可买 3500'));
      expected=3500;
    }
    if(scenario.selected){await page.locator('#mode-selected').click();await page.locator('#selected-tickets').fill('1-5000');}
    else {await page.locator('[data-count="5000"]').click();assert.equal(await page.locator('#ticket-count').inputValue(),String(expected));}
    await page.waitForFunction(()=>!document.getElementById('buy').disabled);
    if(scenario.warm){
      const deadline=Date.now()+5000;
      while(!requests.some(rows=>rows.some(row=>row.method==='eth_estimateGas'&&GAME.decodeFunctionData('buySelected',row.params[0].data)[1].length===expected))){assert.ok(Date.now()<deadline,'preparation starts before click');await new Promise(resolve=>setTimeout(resolve,20));}
      await new Promise(resolve=>setTimeout(resolve,rpcDelay+100));
      assert.equal(await page.evaluate(()=>window.__walletRequests.some(q=>q.method==='eth_sendTransaction')),false);
    }
    const started=Date.now();await page.locator('#buy').click();
    const clickedAt=await page.evaluate(()=>window.__buyClickedAt);
    assert.equal(await page.locator('#buy').isDisabled(),true,'Immediate busy state before preflight');
    if(scenario.rejectApproval){
      await page.waitForFunction(()=>window.__walletRequests.some(q=>q.method==='eth_sendTransaction')&&!document.getElementById('buy').disabled);
      assert.equal(await page.evaluate(()=>window.__walletRequests.filter(q=>q.method==='eth_sendTransaction').length),1);
      assert.equal(await page.locator('#buy').textContent(),'授权并购买');
      assert.deepEqual(errors,[]);console.log(JSON.stringify({scenario:scenario.name,unlocked:true,passed:true}));await page.unrouteAll({behavior:'ignoreErrors'});await context.close();continue;
    }
    await page.waitForFunction(()=>window.__walletRequests.some(q=>q.method==='eth_sendTransaction'&&!q.params[0].data.startsWith('0x095ea7b3')),null,{timeout:15000});
    const sent=await page.evaluate(()=>window.__walletRequests.filter(q=>q.method==='eth_sendTransaction'));
    assert.equal(sent.length,scenario.approval?2:1);
    const tx=sent.at(-1).params[0],decoded=GAME.decodeFunctionData('buySelected',tx.data);
    assert.equal(tx.to,p.address);assert.equal(decoded[1].length,expected);assert.equal(new Set(decoded[1].map(String)).size,expected);
    assert.equal(BigInt(tx.gas)*BigInt(tx.gasPrice)<=1000000000000000n,true);
    if(scenario.selected)assert.deepEqual(decoded[1].map(Number),Array.from({length:5000},(_,i)=>i));
    if(scenario.approval)assert.equal(TOKEN.decodeFunctionData('approve',sent[0].params[0].data)[1],5000n*p.ticketPrice);
    assert.ok(requests.some(rows=>rows.length>=3),'Independent reads use batches');
    assert.deepEqual(errors,[]);
    if(scenario.confirmPurchase){
      if(scenario.holdReceipt){
        await page.waitForFunction(()=>document.getElementById('buy').textContent==='核对购买结果'&&!document.getElementById('buy').disabled);
        await page.locator('#buy').click();
        await page.waitForFunction(()=>!document.getElementById('buy').disabled);
        assert.equal(await page.evaluate(()=>window.__walletRequests.filter(q=>q.method==='eth_sendTransaction').length),1,'Check result must never send another purchase');
        receiptAvailable=true;
        await page.locator('#buy').click();
      }
      await page.waitForFunction(()=>document.getElementById('transaction-list').textContent.includes('购买 · 已确认'),null,{timeout:10000});
      assert.equal(await page.locator('#buy').isDisabled(),false);assert.equal(await page.locator('#buy').textContent(),'购买');
      assert.ok((await page.locator('#notice').textContent()).includes('购买已确认'));
    }
    if(scenario.warm)assert.ok(sent[0].at-clickedAt<walletDelay*2+400,'warm click must not repeat chain preparation');
    console.log(JSON.stringify({scenario:scenario.name,rpcDelay,walletDelay,firstWalletPromptMs:Math.round(sent[0].at-clickedAt),purchaseWalletPromptMs:Math.round(sent.at(-1).at-clickedAt),mockPaymentPromptMs:Date.now()-started,tickets:expected,walletPrompts:sent.length,passed:true}));
    await page.unrouteAll({behavior:'ignoreErrors'});await context.close();
  }
}finally{await browser.close();}
