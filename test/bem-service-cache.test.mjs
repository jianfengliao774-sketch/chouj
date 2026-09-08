import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createAsyncCache} from '../bem-production-site/async-cache.mjs';

test('200 readers of one public state share one loader, including readers arriving after its TTL',async()=>{
  let now=0,calls=0,release;
  const cached=createAsyncCache({now:()=>now});
  const load=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  const requests=Array.from({length:100},()=>cached('state:5',3000,load));
  await tick();assert.equal(calls,1);
  now=10000;
  requests.push(...Array.from({length:100},()=>cached('state:5',3000,load)));
  await tick();assert.equal(calls,1);
  release({blockNumber:100});
  for(const result of await Promise.all(requests))assert.equal(result.blockNumber,100);
});

test('successful data keeps its full TTL after a slow read finishes, then refreshes once',async()=>{
  let now=0,calls=0,release;
  const cached=createAsyncCache({now:()=>now});
  const load=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  const first=cached('state:5',3000,load);await tick();
  now=5000;release({blockNumber:100});await first;
  now=7999;assert.equal((await cached('state:5',3000,load)).blockNumber,100);assert.equal(calls,1);
  now=8000;
  const next=Array.from({length:20},()=>cached('state:5',3000,load));
  await tick();assert.equal(calls,2);release({blockNumber:101});
  for(const result of await Promise.all(next))assert.equal(result.blockNumber,101);
});

test('a failed shared loader rejects all readers and the next call retries immediately',async()=>{
  const cached=createAsyncCache();let calls=0,reject;
  const failure=new Error('upstream unavailable');
  const load=()=>{calls++;return new Promise((_,no)=>{reject=no;});};
  const readers=Array.from({length:20},()=>cached('state:5',3000,load));
  const settled=Promise.allSettled(readers);await tick();reject(failure);
  assert.ok((await settled).every(result=>result.status==='rejected'&&result.reason===failure));
  const result=await cached('state:5',3000,()=>{calls++;return {blockNumber:102};});
  assert.equal(result.blockNumber,102);assert.equal(calls,2);
});

test('different pools and public data keys never share values or wait for each other',async()=>{
  const cached=createAsyncCache();let release;
  const slow=cached('state:5',3000,()=>new Promise(resolve=>{release=resolve;}));
  assert.deepEqual(await cached('state:10',3000,()=>({pool:'10'})),{pool:'10'});
  assert.deepEqual(await cached('beacon:10',30000,()=>({round:'10'})),{round:'10'});
  release({pool:'5'});assert.deepEqual(await slow,{pool:'5'});
});

test('synchronous loaders and synchronous failures preserve caching and retry behavior',async()=>{
  const cached=createAsyncCache();let calls=0;
  await assert.rejects(cached('summary',300000,()=>{calls++;throw Error('read failed');}),/read failed/);
  assert.equal(await cached('summary',300000,()=>{calls++;return 42;}),42);
  assert.equal(await cached('summary',300000,()=>{calls++;return 99;}),42);
  assert.equal(calls,2);
});
