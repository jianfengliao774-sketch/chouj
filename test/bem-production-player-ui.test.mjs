import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Interface, formatUnits, getAddress, toQuantity } from 'ethers';
import * as guards from '../bem-production-site/web/guards.js';
import * as refundGuards from '../bem-production-site/web/refund-guards.js';
import * as transactionRecords from '../bem-production-site/web/transaction-tracker.js';

const APP = new URL('../bem-production-site/web/app.js', import.meta.url);
const HTML = new URL('../bem-production-site/web/index.html', import.meta.url);
const A = '0x304F06903324B8056cB1ED627144EfB2C34df3a8';
const B = '0x0000000000000000000000000000000000000012';
const HASH = '0x' + 'a'.repeat(64);
const TX_KEY = 'bem2075-mainnet-public-transactions-v1';
const p = guards.PINNED;
const config = {
  ...p, schemaVersion:1, mode:'production', rpcUrl:'/rpc', explorerBase:'https://bscscan.com',
  ticketPriceBaseUnits:'1000000', maxTickets:10000, maxTicketsPerPurchase:500, salesEnabled:false,
  gameAbi:['function buy(uint256,uint32)','function buySelected(uint256,uint16[])','function refund(uint256,address)'],
  bemAbi:['function approve(address,uint256) returns(bool)'],
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label = 'condition') { for(let i=0;i<100;i++){if(predicate())return;await tick();}throw new Error(`Timed out waiting for ${label}`); }

class Element {
  constructor(tag='div') {this.tagName=tag;this.children=[];this.listeners=new Map();this.dataset={};this.style={};this.attributes={};this.value='';this.textContent='';this.hidden=false;this.disabled=false;this.classList={add(){},remove(){},toggle(){}};}
  addEventListener(name,fn){const listeners=this.listeners.get(name)??[];listeners.push(fn);this.listeners.set(name,listeners);}
  removeEventListener(name,fn){this.listeners.set(name,(this.listeners.get(name)??[]).filter(value=>value!==fn));}
  async emit(name,event={}){await Promise.all((this.listeners.get(name)??[]).map(fn=>fn({target:this,preventDefault(){},...event})));}
  append(...nodes){this.children.push(...nodes.map(node=>typeof node==='string'?Object.assign(new Element('text'),{textContent:node}):node));}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  get firstElementChild(){return this.children[0];}
  querySelectorAll(tag){return this.children.flatMap(node=>[...(node.tagName===tag?[node]:[]),...node.querySelectorAll(tag)]);}
  scrollIntoView(){}focus(){}select(){}
}
class SyntheticWallet {
  constructor(){this.account=A;this.chain='0x38';this.calls=[];this.listeners=new Map();this.chainReads=0;this.timeline=[];this.onChainRead=null;this.sendHook=null;}
  request({method,params}){
    this.calls.push({method,params});
    if(method==='eth_chainId'){this.chainReads++;this.onChainRead?.(this.chainReads);return Promise.resolve(this.chain);}
    if(method==='eth_requestAccounts'||method==='eth_accounts')return Promise.resolve([this.account]);
    if(method==='eth_sendTransaction'){this.timeline.push('send');return this.sendHook?this.sendHook():Promise.resolve(HASH);}
    throw new Error(`Unexpected synthetic wallet call: ${method}`);
  }
  on(name,fn){const list=this.listeners.get(name)??[];list.push(fn);this.listeners.set(name,list);}
  removeListener(name,fn){this.listeners.set(name,(this.listeners.get(name)??[]).filter(value=>value!==fn));}
  changeAccount(account=B){this.account=account;this.timeline.push('accountsChanged');for(const fn of this.listeners.get('accountsChanged')??[])fn([account]);}
  get sends(){return this.calls.filter(call=>call.method==='eth_sendTransaction');}
}

async function harness(){
  const elements=new Map();
  for(const match of fs.readFileSync(HTML,'utf8').matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){
    const node=new Element(match[1]);node.id=match[2];node.disabled=/\sdisabled(?:\s|>)/.test(match[0]);node.hidden=/\shidden(?:\s|>)/.test(match[0]);node.value=/\bvalue="([^"]*)"/.exec(match[0])?.[1]??'';elements.set(node.id,node);
  }
  elements.get('funding-progress').append(new Element('i'));
  const document={getElementById:id=>{assert.ok(elements.has(id),`Missing real HTML element ${id}`);return elements.get(id);},createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element('text'),{textContent:text}),querySelectorAll:()=>[],body:new Element('body'),hidden:false};
  const surface=new Element('window'), wallet=new SyntheticWallet(), storage=new Map(), calls=[];
  let selected=wallet,block=100,timestamp=200,gasHook=null,ticketHook=null,clock=Date.now();
  const counts=new Map([[A.toLowerCase(),10n],[B.toLowerCase(),20n]]);
  const round={status:1n,sold:30n,fundingDeadline:100n,drawDeadline:0n,winningTicket:0n,winner:'0x'+'0'.repeat(40),requestId:0n};
  const fixed={bem:p.bemAddress,organizer:p.containerAddress,CONTAINER:p.containerAddress,CIRCUITS:p.processorAddress,coordinator:p.coordinator,AUTHORIZATION_NFT:p.processorAddress,AUTHORIZATION_TOKEN_ID:2075n,CIRCUIT_ID:2075n,TICKET_PRICE:1000000n,TICKETS_PER_ROUND:10000n,MAX_TICKETS_PER_PURCHASE:500n,ROUND_POOL:10000000000n,WINNER_AMOUNT:9500000000n,ORGANIZER_AMOUNT:100000000n,BLACKHOLE_AMOUNT:400000000n,BLACKHOLE:'0x000000000000000000000000000000000000dEaD',fundingWindow:259200n,NEXT_ROUND_DELAY:60n,subscriptionId:p.subscriptionId};
  const game={interface:new Interface(config.gameAbi),currentRoundId:async()=>1n,seriesAuthorized:async()=>false,nextRoundOpensAt:async()=>0n,rounds:async()=>({...round}),drawTiming:async()=>({}),ticketsOf:async(id,account)=>ticketHook?ticketHook(String(id),account):counts.get(account.toLowerCase())??0n,ticketBuyerId:async()=>0n,ticketWords:async()=>Array(625).fill(0n),...Object.fromEntries(Object.entries(fixed).map(([name,value])=>[name,async()=>value]))};
  const token={interface:new Interface(config.bemAbi),balanceOf:async()=>10000000000n,allowance:async()=>0n,decimals:async()=>8n};
  class ReadRpc {
    async getBlock(){return {number:block,timestamp,hash:'0x'+'b'.repeat(64)};}
    async getBalance(){return 1000000000000000000n;}
    async getCode(){return '0x6000';}
    async send(method,params){calls.push({method,params});if(method==='eth_chainId')return '0x38';if(method==='eth_call')return '0x';if(method==='eth_estimateGas')return gasHook?gasHook():'0x186a0';throw new Error(`Unexpected read RPC ${method}`);}
  }
  const translate=(zh,en,params={})=>zh.replace(/\{(\w+)\}/g,(all,name)=>String(params[name]??all));
  const sandbox={...guards,...refundGuards,...transactionRecords,Contract:class{constructor(address){return guards.same(address,p.gameAddress)?game:token;}},JsonRpcProvider:ReadRpc,formatUnits,getAddress,toQuantity,
    createTransactionRecord:args=>transactionRecords.createTransactionRecord({...args,submittedAt:args.submittedAt??new Date(clock).toISOString()}),
    isTransactionBlocking:(record,account)=>transactionRecords.isTransactionBlocking(record,account,clock),
    // Contract identity checks have independent tests. This fixture supplies a synthetic verified chain.
    keccak256:()=>p.runtimeCodeHash,
    createTransactionTracker:()=>({poll:async record=>({...record,status:'pending',reason:'AWAITING_RECEIPT'}),reconcile:async()=>{throw new Error('Reconcile not expected');}}),
    createWalletPicker:options=>{options.onChange(new Map([['fixture',{provider:wallet,name:'Synthetic Wallet'}]]));return {open:()=>options.onSelect({provider:selected,name:'Synthetic Wallet'})};},
    t:translate,getLocale:()=>'zh-CN',translateKnown:value=>value,initLanguage(){},document,window:surface,location:{href:'https://example.invalid/',origin:'https://example.invalid'},navigator:{clipboard:{writeText:async()=>{}}},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    fetch:async path=>{calls.push({method:'fetch',path});const body=path==='/api/config'?config:{schemaVersion:1,chainId:56,gameAddress:p.gameAddress,index:{state:'ready',indexedThrough:block,confirmations:12},rounds:[],page:1,totalPages:0};return {ok:true,headers:{get:()=> 'application/json'},json:async()=>body};},
    performance:{now:()=>1000},Date,URL,Event,CustomEvent,queueMicrotask,setInterval(){},requestAnimationFrame(){throw new Error('No draw should start in a refund fixture');},console,
  };
  const context=vm.createContext(sandbox);
  const source=fs.readFileSync(APP,'utf8').replace(/^import .*?;\r?\n/gm,'');
  new vm.Script(source,{filename:APP.pathname}).runInContext(context);
  await until(()=>elements.get('connection-status').textContent.includes('区块'),'initial readonly snapshot');
  const $=id=>elements.get(id);
  const api={$,wallet,storage,surface,calls,counts,round,game,
    async connect(other=wallet){selected=other;await $('connect-wallet').emit('click');await until(()=>$('wallet-address').textContent===other.account&&!$('check-refund').disabled,'wallet connected and refund query ready');},
    async inputRound(value){$('refund-round').value=value;await $('refund-round').emit('input');},
    setGasHook(fn){gasHook=fn;},setTicketHook(fn){ticketHook=fn;},
    advanceClock(milliseconds){clock+=milliseconds;},
    async query(){await $('check-refund').emit('click');},
  };
  return api;
}

test('real app boot, wallet connection and refund lookup never submit a transaction while sales are disabled',async()=>{
  const app=await harness();assert.equal(app.wallet.calls.length,0);
  await app.connect();await app.query();
  assert.equal(app.$('approve').disabled,true);assert.equal(app.$('buy').disabled,true);
  assert.equal(app.$('refund').disabled,false);assert.match(app.$('refund-amount').textContent,/0\.1 BEM/);
  assert.equal(app.wallet.sends.length,0);
  assert.ok(app.calls.every(call=>call.method!=='eth_sendTransaction'));
});

test('explicit refund clicks submit only one transaction, addressed to the frozen account and round',async()=>{
  const app=await harness();await app.connect();const gas=deferred();let estimating=false;
  app.setGasHook(()=>{estimating=true;return gas.promise;});
  const first=app.$('refund').emit('click');await until(()=>estimating,'refund gas estimate');
  await app.$('refund').emit('click');assert.equal(app.wallet.sends.length,0);
  gas.resolve('0x186a0');await first;
  assert.equal(app.wallet.sends.length,1);
  const tx=app.wallet.sends[0].params[0],call=app.game.interface.parseTransaction({data:tx.data});
  assert.equal(call.name,'refund');assert.equal(call.args[0],1n);assert.equal(call.args[1],A);
  assert.equal(tx.from,A);assert.equal(tx.to,p.gameAddress);assert.equal(tx.chainId,'0x38');
  const saved=JSON.parse(app.storage.get(TX_KEY));assert.equal(saved[0].action,'refund');assert.equal(saved[0].account,A);
});

test('account change during refund preflight cancels the signing request and keeps the new identity isolated',async()=>{
  const app=await harness();await app.connect();const gas=deferred();let estimating=false;
  app.setGasHook(()=>{estimating=true;return gas.promise;});
  const refund=app.$('refund').emit('click');await until(()=>estimating,'refund gas estimate');
  app.wallet.changeAccount();gas.resolve('0x186a0');await refund;
  assert.equal(app.wallet.sends.length,0);assert.equal(app.$('refund').disabled,true);
  assert.match(app.$('notice').textContent,/改变/);
});

test('account change queued after final wallet identity responses cannot pass through the await boundary into signing',async()=>{
  const app=await harness();await app.connect();
  app.wallet.onChainRead=number=>{if(number!==3)return;let steps=4;const next=()=>{if(--steps===0)app.wallet.changeAccount();else queueMicrotask(next);};queueMicrotask(next);};
  await app.$('refund').emit('click');
  assert.ok(app.wallet.timeline.includes('accountsChanged'),'fixture reached the final identity boundary');
  assert.equal(app.wallet.sends.length,0,`must cancel when account changes before signing: ${app.wallet.timeline.join(' -> ')}`);
});

test('another refund or a network change during preflight prevents a stale or duplicate refund submission',async()=>{
  for(const change of ['amount','network']){
    const app=await harness();await app.connect();const gas=deferred();let estimating=false;
    app.setGasHook(()=>{estimating=true;return gas.promise;});
    const refund=app.$('refund').emit('click');await until(()=>estimating,'refund estimate');
    if(change==='amount')app.counts.set(A.toLowerCase(),0n);else app.wallet.chain='0x1';
    gas.resolve('0x186a0');await refund;assert.equal(app.wallet.sends.length,0,change);
  }
});

test('late results for an old queried round cannot replace the current round or re-enable its refund button',async()=>{
  const app=await harness();await app.connect();const older=deferred();let waiting=false;
  app.setTicketHook((id,account)=>{if(id==='2'){waiting=true;return older.promise;}return app.counts.get(account.toLowerCase())??0n;});
  await app.inputRound('2');const staleQuery=app.query();await until(()=>waiting,'old round lookup');
  await app.inputRound('1');await app.query();assert.match(app.$('refund-state').textContent,/第 1 期可退 0\.1/);
  older.resolve(99n);await staleQuery;
  assert.equal(app.$('refund-round').value,'1');assert.match(app.$('refund-state').textContent,/第 1 期可退 0\.1/);
  assert.equal(app.wallet.sends.length,0);
});

test('storage updates and malformed public records never invoke a wallet or fabricate confirmed transactions',async()=>{
  const app=await harness();await app.connect();
  app.storage.set(TX_KEY,JSON.stringify([{hash:HASH,account:A,to:p.gameAddress,data:'0x',action:'refund',roundId:'1',status:'confirmed',nonce:7}]));
  await app.surface.emit('storage',{key:TX_KEY});
  assert.equal(app.$('transactions').hidden,true);assert.equal(app.wallet.sends.length,0);
  await app.inputRound('invalid');await app.query();assert.equal(app.$('refund').disabled,true);assert.equal(app.wallet.sends.length,0);
});

test('wallet changes after a submitted request preserve the original account, round and returned transaction hash',async()=>{
  const app=await harness();await app.connect();const hash=deferred();app.wallet.sendHook=()=>hash.promise;
  const refund=app.$('refund').emit('click');await until(()=>app.wallet.sends.length===1,'wallet signing request');
  app.wallet.changeAccount();hash.resolve(HASH);await refund;
  const record=JSON.parse(app.storage.get(TX_KEY))[0];
  assert.equal(record.hash,HASH);assert.equal(record.account,A);assert.equal(record.roundId,'1');
  assert.equal(app.wallet.sends.length,1);assert.equal(app.$('refund').disabled,true);
});

test('an expired pending wait requires explicit review; reviewing never retries or marks the transaction failed',async()=>{
  const app=await harness();await app.connect();await app.$('refund').emit('click');
  await until(()=>!app.$('check-transactions').disabled,'transaction poll complete');
  assert.equal(app.$('refund').disabled,true);
  assert.ok(!app.$('transaction-list').querySelectorAll('button').some(button=>button.textContent==='我已核对钱包，继续操作'),'a fresh pending request must remain in its initial waiting period');
  app.advanceClock(91000);await app.$('ticket-count').emit('input');
  assert.equal(app.$('refund').disabled,true,'elapsed time alone must not permit a duplicate');
  const review=app.$('transaction-list').querySelectorAll('button').find(button=>button.textContent==='我已核对钱包，继续操作');
  assert.ok(review,'there is a separate explicit review action');
  await review.emit('click');assert.equal(app.$('refund').disabled,false);
  assert.equal(app.wallet.sends.length,1,'review itself must not resend');
  assert.equal(JSON.parse(app.storage.get(TX_KEY))[0].status,'pending','review is not a receipt or failure');
});

test('a valid restored record claiming success is treated as unknown and requires review without wallet calls',async()=>{
  const app=await harness();await app.connect();
  const record=transactionRecords.createTransactionRecord({hash:HASH,account:A,action:'refund',roundId:'1',to:p.gameAddress,data:app.game.interface.encodeFunctionData('refund',[1,A])});
  app.storage.set(TX_KEY,JSON.stringify([{...record,status:'confirmed',nonce:'999',effectiveHash:HASH}]));
  await app.surface.emit('storage',{key:TX_KEY});
  assert.equal(app.$('refund').disabled,true);
  const titles=app.$('transaction-list').querySelectorAll('b').map(node=>node.textContent).join(' ');
  assert.match(titles,/结果待核实/);assert.doesNotMatch(titles,/已确认/);
  assert.equal(app.wallet.sends.length,0);
});

test('another tab cannot remove this tab’s pending transaction by saving an older empty list',async()=>{
  const app=await harness();await app.connect();await app.$('refund').emit('click');
  await until(()=>!app.$('check-transactions').disabled,'transaction poll complete');
  app.storage.set(TX_KEY,'[]');await app.surface.emit('storage',{key:TX_KEY});
  assert.equal(app.$('transactions').hidden,false,'locally submitted evidence must survive an unrelated storage update');
  assert.equal(app.$('refund').disabled,true,'the unresolved transaction must still require waiting or explicit review');
  assert.equal(app.wallet.sends.length,1);
});
