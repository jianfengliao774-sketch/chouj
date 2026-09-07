import test from 'node:test';
import assert from 'node:assert/strict';
import {isMobileBrowser,walletPageUrl,walletDappLink} from '../bem-production-site/web/wallet-mobile-links.js';
import {waitForWalletResponse} from '../bem-production-site/web/wallet-response.js';

test('mobile routing includes iPad desktop UA without treating desktop Chrome as a phone',()=>{
  for(const nav of [{userAgent:'Mozilla Android Chrome'},{userAgent:'iPhone CriOS'},{userAgent:'iPhone Safari'},{platform:'MacIntel',maxTouchPoints:5},{userAgentData:{mobile:true}}])assert.equal(isMobileBrowser(nav),true);
  assert.equal(isMobileBrowser({userAgent:'Chrome Macintosh',platform:'MacIntel',maxTouchPoints:0}),false);
});
test('wallet handoff includes only validated public selection and no sensitive URL fields',()=>{
  const current='https://tapeout.cc.cd/admin.html?token=secret&wallet=private#salt';
  assert.equal(walletPageUrl(current,{pool:'10',count:'3000'}),'https://tapeout.cc.cd/?pool=10&count=3000');
  assert.equal(walletPageUrl(current,{pool:'100',count:'5001'}),'https://tapeout.cc.cd/?pool=5');
  assert.equal(walletPageUrl('http://tapeout.cc.cd/',{}),null);
  assert.equal(walletPageUrl('javascript:alert(1)',{}),null);
});
test('manual selection is compacted losslessly; uncompressible long selections request re-selection',()=>{
  const valid=new URL(walletPageUrl('https://tapeout.cc.cd/',{pool:'5',mode:'selected',tickets:'1-5000'}));
  assert.equal(valid.searchParams.get('tickets'),'1-5000');
  const dense=new URL(walletPageUrl('https://tapeout.cc.cd/',{mode:'selected',tickets:Array.from({length:500},(_,i)=>i+1).join(',')}));assert.equal(dense.searchParams.get('tickets'),'1-500');
  const long=new URL(walletPageUrl('https://tapeout.cc.cd/',{mode:'selected',tickets:Array.from({length:500},(_,i)=>i*2+1).join(',')}));
  assert.equal(long.searchParams.get('mode'),'selected');assert.equal(long.searchParams.has('tickets'),false);assert.equal(long.searchParams.get('reselect'),'1');
});
test('verified wallet links encode the exact public page; unknown brands use explicit copy guidance',()=>{
  const page='https://tapeout.cc.cd/?pool=5&count=1000';
  assert.equal(walletDappLink('MetaMask',page),'https://link.metamask.io/dapp/tapeout.cc.cd/?pool=5&count=1000');
  assert.equal(new URL(walletDappLink('OKX Wallet',page)).searchParams.get('dappUrl'),page);
  assert.deepEqual(JSON.parse(new URL(walletDappLink('TokenPocket',page)).searchParams.get('params')),{url:page});
  assert.equal(walletDappLink('Binance Wallet',page),null);
  assert.equal(walletDappLink('MetaMask','http://tapeout.cc.cd'),null);
});
test('a missing native callback ends with a clear error and never retries; completed calls leave no timer',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let calls=0;
  const run=assert.rejects(waitForWalletResponse(()=>{calls++;return new Promise(()=>{});},{timeout:5000}),{code:'WALLET_RESPONSE_TIMEOUT'});
  await Promise.resolve();t.mock.timers.tick(5000);await run;assert.equal(calls,1);
  assert.equal(await waitForWalletResponse(()=>42),42);t.mock.timers.tick(10000);
});
