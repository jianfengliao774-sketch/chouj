import test from 'node:test';
import assert from 'node:assert/strict';
import {createInFlightReads} from '../bem-production-site/web/in-flight-reads.js';

test('overlapping readers share only the exact URL and refresh after completion',async()=>{
  const calls=[],pending=[];
  const read=createInFlightReads(key=>{calls.push(key);return new Promise(resolve=>pending.push(resolve));});
  const first=read('/records?address=one&page=1');
  assert.equal(read('/records?address=one&page=1'),first);
  const second=read('/records?address=two&page=1');
  assert.notEqual(first,second);
  await Promise.resolve();assert.equal(calls.length,2);
  pending[0]({account:'one'});pending[1]({account:'two'});
  assert.deepEqual(await first,{account:'one'});await second;
  const fresh=read('/records?address=one&page=1');assert.notEqual(fresh,first);
  await Promise.resolve();assert.equal(calls.length,3);pending[2]({fresh:true});await fresh;
});

test('a failed request does not pin future refreshes to its rejection',async()=>{
  let attempts=0;
  const read=createInFlightReads(()=>{if(++attempts===1)throw Error('Temporary failure');return 'recovered';});
  await assert.rejects(read('/records'),/Temporary failure/);
  assert.equal(await read('/records'),'recovered');assert.equal(attempts,2);
});

test('429 Retry-After pauses only the affected URL without automatic retries',async()=>{
  let time=0,attempts=0;
  const read=createInFlightReads(key=>{attempts++;if(key==='/busy')throw Object.assign(Error('Busy'),{status:429,retryAfter:'10'});return 'ready';},{now:()=>time});
  await assert.rejects(read('/busy'));time=9000;await assert.rejects(read('/busy'));assert.equal(attempts,1);
  assert.equal(await read('/other'),'ready');assert.equal(attempts,2);
  time=10001;await assert.rejects(read('/busy'));assert.equal(attempts,3);
});

test('429 delay defaults to five seconds, respects HTTP dates and caps at sixty seconds',async()=>{
  for(const [retryAfter,expected] of [[null,5000],['invalid',5000],['600',60000],['Thu, 01 Jan 1970 00:00:15 GMT',15000]]){
    let time=0,attempts=0;const read=createInFlightReads(()=>{attempts++;throw Object.assign(Error('Busy'),{status:429,retryAfter});},{now:()=>time});
    await assert.rejects(read('/busy'));time=expected-1;await assert.rejects(read('/busy'));assert.equal(attempts,1);
    time=expected;await assert.rejects(read('/busy'));assert.equal(attempts,2);
  }
});
