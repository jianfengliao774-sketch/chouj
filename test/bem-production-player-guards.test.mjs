import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PINNED, validateManifest, createIntent, parseSelection, assertFixedSnapshot, assertPurchaseSnapshot, explorerLink } from '../bem-production-site/web/guards.js';

const artifact=JSON.parse(fs.readFileSync(new URL('../outputs/bem-raffle-2075/production/Bem2075RaffleBSC.artifact.json',import.meta.url),'utf8'));
const config={schemaVersion:1,mode:'production',chainId:56,gameAddress:PINNED.gameAddress,bemAddress:PINNED.bemAddress,containerAddress:PINNED.containerAddress,processorAddress:PINNED.processorAddress,runtimeCodeHash:PINNED.runtimeCodeHash,subscriptionId:PINNED.subscriptionId,circuitId:2075,rpcUrl:'/rpc',explorerBase:'https://bscscan.com',maxTickets:10000,maxTicketsPerPurchase:500,ticketPriceBaseUnits:'1000000',salesEnabled:true,gameAbi:artifact.abi,bemAbi:['function approve(address,uint256) returns(bool)']};
const account='0x304F06903324B8056cB1ED627144EfB2C34df3a8';
const makeIntent=()=>createIntent({mode:'selected',text:'1, 88, 10000',roundId:'3',account,epoch:9});
const snapshot=()=>({account,seriesAuthorized:true,roundId:'3',status:1,sold:42,timestamp:1000,fundingDeadline:2000,balance:10000000000n,allowance:3000000n,words:Array(625).fill(0n)});
const makeCheck=()=>({config,snapshot:snapshot(),intent:makeIntent(),walletAccount:account,walletChain:56,epoch:9,action:'buy'});
const rejects=(fn,code)=>assert.throws(fn,error=>error.code===code);

test('production manifest pins chain, addresses, runtime, subscription, amounts and ABI',()=>{
  assert.equal(validateManifest(config),config);
  for(const mutation of [{chainId:97},{mode:'local'},{gameAddress:account},{bemAddress:account},{containerAddress:account},{runtimeCodeHash:'0x'+'0'.repeat(64)},{subscriptionId:Number(PINNED.subscriptionId)},{salesEnabled:undefined},{maxTicketsPerPurchase:10000},{ticketPriceBaseUnits:'10000000000000000'},{rpcUrl:'https://other.example'},{explorerBase:'https://phishing.example'},{gameAbi:['function buy(uint256,uint256)','function buySelected(uint256,uint16[])']}])rejects(()=>validateManifest({...config,...mutation}),'MANIFEST');
});
test('numbers include 00001 and 10000; ranges are sorted unique and bounded before conversion',()=>{
  assert.deepEqual(parseSelection('10000，00001, 88, 86-88'),[0,85,86,87,9999]);
  assert.equal(parseSelection('1-500').length,500);
  rejects(()=>parseSelection('1-501'),'TICKET_LIMIT');rejects(()=>parseSelection('0'),'TICKET_RANGE');rejects(()=>parseSelection('10001'),'TICKET_RANGE');rejects(()=>parseSelection('5-1'),'TICKET_RANGE');rejects(()=>parseSelection('1.2'),'TICKET_FORMAT');rejects(()=>parseSelection(''),'NO_TICKETS');
});
test('exact allowance and eligible selected tickets permit a purchase, never approval plus automatic purchase',()=>{
  assert.doesNotThrow(()=>assertPurchaseSnapshot(makeCheck()));
  rejects(()=>assertPurchaseSnapshot({...makeCheck(),action:'approve'}),'ALREADY_APPROVED');
  for(const allowance of [0n,2999999n,3000001n,2n**256n-1n])rejects(()=>assertPurchaseSnapshot({...makeCheck(),snapshot:{...snapshot(),allowance}}),'ALLOWANCE');
  assert.doesNotThrow(()=>assertPurchaseSnapshot({...makeCheck(),action:'approve',snapshot:{...snapshot(),allowance:0n}}));
});
test('closed launch gates, changed account/network/intent/round and expired funding prevent every signature',()=>{
  for(const action of ['buy','approve']){
    const base={...makeCheck(),action,snapshot:{...snapshot(),allowance:action==='approve'?0n:3000000n}};
    rejects(()=>assertPurchaseSnapshot({...base,config:{...config,salesEnabled:false}}),'NOT_LAUNCHED');
    rejects(()=>assertPurchaseSnapshot({...base,snapshot:{...base.snapshot,seriesAuthorized:false}}),'NOT_LAUNCHED');
    rejects(()=>assertPurchaseSnapshot({...base,walletAccount:PINNED.gameAddress}),'WALLET_CHANGED');
    rejects(()=>assertPurchaseSnapshot({...base,snapshot:{...base.snapshot,account:PINNED.gameAddress}}),'WALLET_CHANGED');
    rejects(()=>assertPurchaseSnapshot({...base,walletChain:97}),'NETWORK');
    rejects(()=>assertPurchaseSnapshot({...base,epoch:10}),'WALLET_CHANGED');
    rejects(()=>assertPurchaseSnapshot({...base,snapshot:{...base.snapshot,roundId:'4'}}),'ROUND_CHANGED');
    for(const status of [0,2,3,4,5,6])rejects(()=>assertPurchaseSnapshot({...base,snapshot:{...base.snapshot,status}}),'ROUND_CLOSED');
    rejects(()=>assertPurchaseSnapshot({...base,snapshot:{...base.snapshot,timestamp:2000}}),'ROUND_CLOSED');
    rejects(()=>assertPurchaseSnapshot({...base,snapshot:{...base.snapshot,balance:2999999n}}),'BALANCE');
  }
});
test('packed-ticket conflicts include boundaries and never substitute a ticket or exceed remaining capacity',()=>{
  for(const ticket of [0,87,9999]){const words=Array(625).fill(0n);words[Math.floor(ticket/16)]=7n<<BigInt(ticket%16*16);rejects(()=>assertPurchaseSnapshot({...makeCheck(),snapshot:{...snapshot(),words}}),'TICKET_SOLD');}
  rejects(()=>assertPurchaseSnapshot({...makeCheck(),snapshot:{...snapshot(),sold:9999}}),'TICKET_SOLD');
  rejects(()=>assertPurchaseSnapshot({...makeCheck(),snapshot:{...snapshot(),words:[]}}),'TICKET_LOOKUP');
  rejects(()=>createIntent({mode:'auto',count:501,roundId:3,account,epoch:0}),'TICKET_LIMIT');
});
test('deployed immutable and rules checks reject a different recipient or token precision',()=>{
  const fixed={chainId:56,runtimeCodeHash:PINNED.runtimeCodeHash,bem:PINNED.bemAddress,organizer:PINNED.containerAddress,CONTAINER:PINNED.containerAddress,CIRCUITS:PINNED.processorAddress,coordinator:PINNED.coordinator,AUTHORIZATION_NFT:PINNED.processorAddress,AUTHORIZATION_TOKEN_ID:2075,CIRCUIT_ID:2075,TICKET_PRICE:1000000,TICKETS_PER_ROUND:10000,MAX_TICKETS_PER_PURCHASE:500,ROUND_POOL:10000000000,WINNER_AMOUNT:9500000000,ORGANIZER_AMOUNT:100000000,BLACKHOLE_AMOUNT:400000000,BLACKHOLE:'0x000000000000000000000000000000000000dEaD',fundingWindow:259200,NEXT_ROUND_DELAY:60,decimals:8,subscriptionId:PINNED.subscriptionId};
  assert.doesNotThrow(()=>assertFixedSnapshot(fixed));
  for(const mutation of [{organizer:account},{decimals:18},{chainId:97},{CIRCUIT_ID:13043},{subscriptionId:'768'},{TICKET_PRICE:10000000}])rejects(()=>assertFixedSnapshot({...fixed,...mutation}),'IDENTITY');
});
test('explorer links cannot be replaced with script URLs or another explorer',()=>{
  assert.equal(explorerLink('address',PINNED.gameAddress),`https://bscscan.com/address/${PINNED.gameAddress}`);
  assert.equal(explorerLink('tx','javascript:alert(1)'),null);assert.equal(explorerLink('address','https://evil.example'),null);
});
