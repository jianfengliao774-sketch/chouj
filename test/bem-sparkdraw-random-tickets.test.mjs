import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomBelow,randomUnsoldTickets} from '../bem-production-site/web/random-tickets.js';
const empty=()=>Array(556).fill(0n);
function occupy(words,n){words[Math.floor(n/18)]|=1n<<BigInt(n%18*14);}
test('random selection excludes occupied numbers, padding and duplicates, including storage boundaries',()=>{
  const words=empty(),sold=[0,17,18,255,256,9999];sold.forEach(n=>occupy(words,n));
  const picked=randomUnsoldTickets(words,5000);
  assert.equal(picked.length,5000);assert.equal(new Set(picked).size,5000);
  assert.deepEqual(picked,[...picked].sort((a,b)=>a-b));assert.ok(picked.every(n=>n>=0&&n<10000&&!sold.includes(n)));
});
test('sampling can span the number space and partial stock returns only the available quantity',()=>{
  let step=0;const chosen=randomUnsoldTickets(empty(),3,limit=>[8000,2000,6000][step++]%limit);
  assert.deepEqual(chosen,[2001,6002,8000]);
  const words=empty();for(let i=0;i<10000;i++)if(![2,18,9999].includes(i))occupy(words,i);
  assert.deepEqual(randomUnsoldTickets(words,5000),[2,18,9999]);occupy(words,2);occupy(words,18);occupy(words,9999);
  assert.deepEqual(randomUnsoldTickets(words,1),[]);
  assert.throws(()=>randomUnsoldTickets([],2));assert.throws(()=>randomUnsoldTickets(empty(),5001));
});
test('random integer rejects the modulo-bias tail rather than mapping it onto a ticket',()=>{
  const original=globalThis.crypto.getRandomValues;let calls=0;
  try{globalThis.crypto.getRandomValues=buffer=>{buffer[0]=calls++===0?0xffffffff:10002;return buffer;};assert.equal(randomBelow(10000),2);assert.equal(calls,2);}
  finally{globalThis.crypto.getRandomValues=original;}
});
const source=fs.readFileSync(new URL('../bem-production-site/web/sparkdraw-player.js',import.meta.url),'utf8');
function flow({changeContext=false,changeRound=false,readFailure=false,quota=4998n,balance=1000000n,chosen=null,allSold=false}={}){
  const sent=[],reads=[],failures=[],words=empty();occupy(words,0);
  if(allSold)for(let n=0;n<10000;n++)occupy(words,n);
  let contextChanged=false;
  const c=vm.createContext({account:'wallet',pool:'0.1',flow:false,GAME:'game',TOKEN:'token',F:{bem:'bem'},
    context:()=>({key:contextChanged?'changed':'same'}),selection:()=>({count:chosen?.length||4,tickets:chosen}),profile:()=>({address:'game',ticketPrice:1000n}),
    call:async(iface,to,method,args,block)=>{reads.push({method,block});if(method==='currentRoundId')return [block&&changeRound?2n:1n];if(method==='rounds')return [1n,100n];if(method==='ticketsOf')return [quota];if(method==='balanceOf')return [balance];if(method==='allowance')return [1000000n];if(method==='ticketWords'){if(readFailure)throw Error('RPC_UNAVAILABLE');contextChanged=changeContext;return [words];}throw Error(method);},
    rpc:async()=> '0x100',randomUnsoldTickets,manager:{execute:async args=>{sent.push(args);}},render(){},note(){},failure:e=>failures.push(e),t:zh=>zh,
  });
  vm.runInContext(source.slice(source.indexOf('async function buy()'),source.indexOf('async function action(')),c);
  return {run:()=>c.buy(),sent,reads,failures};
}
test('auto purchase reads one block after approval and sends random numbers through existing buySelected',async()=>{
  const f=flow();await f.run();assert.equal(f.failures.length,0);assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].method,'buySelected');assert.equal(f.sent[0].count,2);assert.ok(f.sent[0].args[1].every(n=>n!==0));
  assert.equal(f.reads.find(r=>r.method==='ticketWords').block,'0x100');
});
test('wallet context or round changes prevent the randomly prepared purchase from being sent',async()=>{
  for(const config of [{changeContext:true},{changeRound:true}]){const f=flow(config);await f.run();assert.equal(f.sent.length,0);assert.equal(f.failures.length,1);}
});

test('RPC failure, sold-out stock, wallet quota and insufficient BEM never fall back to sequential buying',async()=>{
  for(const config of [{readFailure:true},{allSold:true},{quota:5000n},{balance:0n}]){const f=flow(config);await f.run();assert.equal(f.sent.length,0);assert.equal(f.failures.length,1);}
});
test('manual number selection remains the exact user selection without random replacement in the browser',async()=>{
  const chosen=[17,5000,9999],f=flow({chosen,quota:0n});await f.run();assert.equal(f.failures.length,0);
  assert.deepEqual(f.sent[0].args[1],chosen);assert.equal(f.reads.some(r=>r.method==='ticketWords'),false);
});
