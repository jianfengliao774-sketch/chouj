import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadRpcBatcher } from '../bem-production-site/web/read-rpc-batcher.js';
import { GAME } from '../bem-production-site/web/sparkdraw-transactions.js';
import { profile } from '../bem-production-site/web/sparkdraw-profiles.js';
import {withRequestTimeout} from '../bem-production-site/web/request-timeout.js';

const response = (rows, status = 200, retryAfter = null) => ({ ok: status === 200, status,
  headers: { get: name => name.toLowerCase()==='content-type'?'application/json':name.toLowerCase()==='retry-after'?retryAfter:null }, json: async () => rows });
const replies = options => JSON.parse(options.body).map(row => ({ jsonrpc: '2.0', id: row.id, result: row.params[0] ?? '0x38' }));

test('older wallet browsers without AbortSignal.timeout can load chain data', async t => {
  const descriptor=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
  Object.defineProperty(AbortSignal,'timeout',{value:undefined,configurable:true});
  t.after(()=>Object.defineProperty(AbortSignal,'timeout',descriptor));
  const rpc=createReadRpcBatcher({fetchImpl:async(_,options)=>response(replies(options))});
  assert.equal(await rpc('eth_chainId'),'0x38');
});

test('request deadlines cover body reads and clear after completion', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let completedSignal,bodySignal;
  assert.equal(await withRequestTimeout(50,async signal=>{completedSignal=signal;return 'done';}),'done');
  t.mock.timers.tick(100);assert.equal(completedSignal.aborted,false);
  const pending=withRequestTimeout(50,signal=>{bodySignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'}))));});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  t.mock.timers.tick(50);await rejected;assert.equal(bodySignal.aborted,true);
});

test('5000-ticket estimates are intact and concurrent large requests split below 512 KiB', async () => {
  const requests = [], tx = {to: profile('5').address, data: GAME.encodeFunctionData('buySelected', [1, Array.from({length: 5000}, (_, i) => i)])};
  const rpc = createReadRpcBatcher({fetchImpl: async (_, options) => {
    assert.ok(Buffer.byteLength(options.body) <= 524288);
    const rows = JSON.parse(options.body); requests.push(rows);
    return response(rows.map(r => ({jsonrpc:'2.0', id:r.id, result:'0x123'})));
  }});
  const values = await Promise.all([rpc('eth_estimateGas', [tx, 'latest']), rpc('eth_estimateGas', [tx, 'latest']), rpc('eth_gasPrice')]);
  assert.deepEqual(values, ['0x123', '0x123', '0x123']); assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.length), [1, 2]);
  for (const r of requests.flat().filter(r => r.method === 'eth_estimateGas')) assert.equal(GAME.decodeFunctionData('buySelected', r.params[0].data)[1].length, 5000);
});

test('60 concurrent reads use three HTTP requests of at most 25 and map unordered responses by ID', async () => {
  const requests = [], rpc = createReadRpcBatcher({ fetchImpl: async (_, options) => {
    requests.push(JSON.parse(options.body)); return response(replies(options).reverse());
  } });
  assert.deepEqual(await Promise.all(Array.from({ length: 60 }, (_, n) => rpc('eth_call', [n]))), Array.from({ length: 60 }, (_, n) => n));
  assert.deepEqual(requests.map(rows => rows.length), [25, 25, 10]);
});

test('cancelling one read never cancels or overwrites another wallet’s read', async () => {
  let complete, entered;
  const fetching = new Promise(resolve => { entered = resolve; });
  const rpc = createReadRpcBatcher({ fetchImpl: async (_, options) => {
    entered(); await new Promise(resolve => { complete = resolve; }); return response(replies(options));
  } });
  const controller = new AbortController();
  const first = rpc('eth_call', ['old'], controller.signal), rejected = assert.rejects(first, { name: 'AbortError' });
  const second = rpc('eth_call', ['new']);
  await fetching; controller.abort(); complete(); await rejected;
  assert.equal(await second, 'new');
});

test('wallet signing and broadcast methods cannot enter the retry transport', async () => {
  let calls = 0;
  const rpc = createReadRpcBatcher({ fetchImpl: async () => { calls++; } });
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign', 'eth_signTypedData_v4']) {
    await assert.rejects(rpc(method), /Read-only/);
  }
  assert.equal(calls, 0);
});

test('only temporary read failures retry, with at most three attempts', async () => {
  let calls = 0;
  const rpc = createReadRpcBatcher({ retryDelay: async () => {}, fetchImpl: async (_, options) => {
    calls++; return calls < 3 ? response(null, 503) : response(replies(options));
  } });
  assert.equal(await rpc('eth_chainId'), '0x38'); assert.equal(calls, 3);
  let failures = 0;
  const busy = createReadRpcBatcher({ retryDelay: async () => {}, fetchImpl: async () => { failures++; return response(null, 429); } });
  await assert.rejects(busy('eth_chainId'), { code: 'RPC_UNAVAILABLE', status: 429 }); assert.equal(failures, 1);
});

test('429 fails promptly without retrying and all reads pause until Retry-After, then fetch fresh data', async () => {
  let time=0,calls=0,retries=0;
  const rpc=createReadRpcBatcher({now:()=>time,retryDelay:async()=>{retries++;},fetchImpl:async(_,options)=>{
    calls++;return calls===1?response(null,429,'10'):response(replies(options));
  }});
  await assert.rejects(rpc('eth_chainId'),{code:'RPC_UNAVAILABLE',status:429});
  time=9999;
  const readers=await Promise.allSettled(Array.from({length:20},()=>rpc('eth_gasPrice')));
  assert.ok(readers.every(row=>row.status==='rejected'&&row.reason.status===429));
  assert.equal(calls,1);assert.equal(retries,0);
  time=10000;assert.equal(await rpc('eth_chainId'),'0x38');assert.equal(calls,2);
  assert.equal(await rpc('eth_chainId'),'0x38');assert.equal(calls,3,'Successful data is never cached');
});

test('RPC Retry-After defaults to five seconds, accepts HTTP dates, and caps waiting at sixty seconds', async () => {
  for(const [header,duration] of [[null,5000],['invalid',5000],['Thu, 01 Jan 1970 00:00:15 GMT',15000],['600',60000]]){
    let time=0,calls=0;
    const rpc=createReadRpcBatcher({now:()=>time,fetchImpl:async(_,options)=>{
      calls++;return calls===1?response(null,429,header):response(replies(options));
    }});
    await assert.rejects(rpc('eth_chainId'),{status:429});time=duration-1;
    await assert.rejects(rpc('eth_chainId'),{status:429});assert.equal(calls,1,String(header));
    time=duration;assert.equal(await rpc('eth_chainId'),'0x38');assert.equal(calls,2,String(header));
  }
});

test('an already scheduled temporary-failure retry stops if another batch receives 429', async () => {
  let calls=0,continueRetry,enteredRetry;
  const waitingForRetry=new Promise(resolve=>{enteredRetry=resolve;});
  const rpc=createReadRpcBatcher({now:()=>0,retryDelay:()=>{enteredRetry();return new Promise(resolve=>{continueRetry=resolve;});},fetchImpl:async()=>{
    calls++;return calls===1?response(null,503):response(null,429,'10');
  }});
  const first=rpc('eth_chainId'),rejected=assert.rejects(first,{code:'RPC_UNAVAILABLE',status:429});
  await waitingForRetry;await assert.rejects(rpc('eth_gasPrice'),{status:429});
  continueRetry();await rejected;assert.equal(calls,2);
});

test('Retry-After zero permits the next explicit read but never automatically replays the rejected batch', async () => {
  let calls=0,retries=0;
  const rpc=createReadRpcBatcher({now:()=>0,retryDelay:async()=>{retries++;},fetchImpl:async(_,options)=>{
    calls++;return calls===1?response(null,429,'0'):response(replies(options));
  }});
  await assert.rejects(rpc('eth_chainId'),{status:429});assert.equal(calls,1);assert.equal(retries,0);
  assert.equal(await rpc('eth_chainId'),'0x38');assert.equal(calls,2);
});

test('a batch retries only busy members, preserving already successful reads', async () => {
  const requests = [];
  const rpc = createReadRpcBatcher({ retryDelay: async () => {}, fetchImpl: async (_, options) => {
    const rows = replies(options); requests.push(rows);
    if (requests.length === 1) rows[1] = { jsonrpc: '2.0', id: rows[1].id, error: { code: -32005 } };
    return response(rows);
  } });
  assert.deepEqual(await Promise.all([rpc('eth_call', ['one']), rpc('eth_call', ['two'])]), ['one', 'two']);
  assert.deepEqual(requests.map(rows => rows.length), [2, 1]);
});

test('malformed, missing, duplicate and unrelated response IDs fail closed without retry', async () => {
  for (const corrupt of [rows => rows.slice(1), rows => [rows[0], rows[0]], rows => [rows[0], { ...rows[1], id: 999 }], () => ({ result: '0x38' })]) {
    let calls = 0;
    const rpc = createReadRpcBatcher({ fetchImpl: async (_, options) => { calls++; return response(corrupt(replies(options))); } });
    const settled = await Promise.allSettled([rpc('eth_chainId'), rpc('eth_chainId')]);
    assert.ok(settled.every(row => row.status === 'rejected' && row.reason.code === 'RPC_UNAVAILABLE'));
    assert.equal(calls, 1);
  }
});
