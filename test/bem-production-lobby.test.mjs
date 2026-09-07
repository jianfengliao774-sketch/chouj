import test from 'node:test';
import assert from 'node:assert/strict';
import {poolRegistry} from '../bem-production-site/pools.mjs';
import {quoteView,MARKET_BEM} from '../bem-production-site/web/market-guards.js';
import {validateRecords,transactionUrl} from '../bem-production-site/web/public-record-guards.js';

test('V2 registry does not reuse the deployed V1 contract or imply any pool is live',()=>{
  const registry=poolRegistry();assert.equal(registry.chainId,56);
  for(const p of registry.pools){assert.equal(p.deployment,null);assert.equal(p.salesEnabled,false);assert.equal(p.ticketsPerRound,10000);assert.equal(BigInt(p.ticketPriceBaseUnits)*10000n,BigInt(p.poolBaseUnits));assert.equal(BigInt(p.winnerBaseUnits)+BigInt(p.organizerBaseUnits)+BigInt(p.blackholeBaseUnits),BigInt(p.poolBaseUnits));assert.equal(p.maxTicketsPerPurchase,1000);assert.equal(p.maxTicketsPerAddress,5000);assert.equal(p.fundingWindowSeconds,86400);assert.equal(p.refundClaimWindowSeconds,86400);}
  registry.pools[0].salesEnabled=true;assert.equal(poolRegistry().pools[0].salesEnabled,false);
});
const now=1800000000000,price={chainId:56,token:MARKET_BEM,source:'DEX Screener',updatedAt:new Date(now).toISOString(),stale:false,usdt:{price:'10',pairAddress:'0x'+'1'.repeat(40),url:'https://evil.invalid'},bnb:{price:'0.013',pairAddress:'0x'+'2'.repeat(40)}};
test('prize conversions change with pool amount and preserve independent USDT and BNB quotes',()=>{
  assert.equal(quoteView(price,'9500000000',now).usdt.prize,950);
  assert.equal(quoteView(price,'950000000',now).usdt.prize,95);
  assert.equal(quoteView(price,'95000000',now).bnb.prize,.95*.013);
  assert.equal(quoteView({...price,bnb:null},'9500000000',now).bnb,null);
  assert.match(quoteView(price,'9500000000',now).usdt.url,/^https:\/\/dexscreener.com\/bsc\//);
});
test('stale prices, another token, future timestamps and invalid numbers never appear as live quotes',()=>{
  for(const p of [{...price,stale:true},{...price,token:'0x'+'3'.repeat(40)},{...price,chainId:1},{...price,updatedAt:new Date(now-180001).toISOString()},{...price,updatedAt:new Date(now+30001).toISOString()}])assert.equal(quoteView(p,'9500000000',now).usdt,null);
  for(const v of ['0','-1','NaN','Infinity','1e99','<script>'])assert.equal(quoteView({...price,usdt:{...price.usdt,price:v}},'9500000000',now).usdt,null);
});
test('public records accept only valid chain rows and build links on the fixed explorer',()=>{
  const row={gameAddress:'0x'+'1'.repeat(40),transactionHash:'0x'+'2'.repeat(64),poolId:'legacy100',roundId:'1',amountBaseUnits:'9500000000',timeUtc:new Date(now).toISOString(),winner:'0x'+'3'.repeat(40)};
  const input={schemaVersion:2,chainId:56,page:1,totalPages:1,rows:[row]};assert.equal(validateRecords(input,'winner').rows.length,1);
  assert.equal(validateRecords({...input,rows:[{...row,transactionHash:'javascript:alert(1)'}]},'winner').rows.length,0);
  assert.equal(validateRecords({...input,rows:[{...row,kind:'unclaimed',destination:'0x'+'4'.repeat(40)}]},'burn').rows.length,0);
  assert.equal(transactionUrl('javascript:alert(1)'),null);assert.throws(()=>validateRecords({...input,chainId:1},'winner'));
});
