import {withRequestTimeout} from './request-timeout.js';
const METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance',
  'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);

// Coalesce one render's reads into the server's existing 25-item JSON-RPC batches.
// No wallet request or signing method is supported here.
export function createReadRpcBatcher({ fetchImpl = globalThis.fetch, endpoint = '/rpc', now = Date.now,
  retryDelay = attempt => new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt + Math.floor(Math.random() * 200))) } = {}) {
  let serial = 0, scheduled = false, queue = [], retryAt = 0;
  const unavailable = () => Object.assign(new Error('Chain reads are temporarily unavailable'), { code: 'RPC_UNAVAILABLE' });
  const rateLimited = () => Object.assign(unavailable(), { status: 429, retryAfter: Math.max(0, retryAt-now())/1000 });
  function pauseReads(raw) {
    const time=now(),seconds=typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw.trim())?Number(raw)*1000:NaN;
    const dated=typeof raw==='string'?Date.parse(raw)-time:NaN;
    const delay=Math.min(60000,Math.max(0,Number.isFinite(seconds)?seconds:Number.isFinite(dated)?dated:5000));
    retryAt=Math.max(retryAt,time+delay);
  }
  async function dispatch(items, attempt = 0) {
    items = items.filter(item => !item.finished);
    if (!items.length) return;
    if(now()<retryAt){for(const item of items)item.finish(false,rateLimited());return;}
    try {
      const rows = await withRequestTimeout(20000, async signal => {
        let response;
        try {
          response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items.map(item => item.request)), signal });
        } catch { throw Object.assign(unavailable(), { retryable: true }); }
        if(response.status===429){
          // A busy endpoint must not receive immediate retries from every open
          // page. Fail fast during Retry-After instead of holding wallet flows.
          pauseReads(response.headers.get('retry-after'));throw rateLimited();
        }
        if ([502, 503, 504].includes(response.status)) throw Object.assign(unavailable(), { retryable: true });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw unavailable();
        return response.json();
      }), expected = new Set(items.map(item => item.request.id));
      if (!Array.isArray(rows) || rows.length !== items.length || rows.some(row => !row || row.jsonrpc !== '2.0' || !expected.has(row.id)) ||
        new Set(rows.map(row => row.id)).size !== rows.length) throw unavailable();
      const byId = new Map(rows.map(row => [row.id, row]));
      const busy = [];
      for (const item of items) {
        const row = byId.get(item.request.id);
        if (row.error?.code === -32005 && attempt < 2) busy.push(item);
        else if (row.error || !Object.hasOwn(row, 'result')) item.finish(false, unavailable());
        else item.finish(true, row.result);
      }
      if (busy.length) { await retryDelay(attempt); await dispatch(busy, attempt + 1); }
    } catch (error) {
      if (error.retryable && attempt < 2) { await retryDelay(attempt); await dispatch(items, attempt + 1); }
      else for (const item of items) item.finish(false, error.status===429?rateLimited():unavailable());
    }
  }
  function flush() {
    scheduled = false;
    const items = queue.filter(item => !item.finished); queue = [];
    // buySelected(5000) alone is ~320 KB. Count AND byte limits must match the
    // server's 512 KiB body cap when estimates share a flush with other reads.
    let batch = [], bytes = 2;
    for (const item of items) {
      const size = new TextEncoder().encode(JSON.stringify(item.request)).length;
      if (size + 2 > 524288) { item.finish(false, unavailable()); continue; }
      if (batch.length && (batch.length === 25 || bytes + size + 1 > 524288)) {
        void dispatch(batch); batch = []; bytes = 2;
      }
      bytes += size + (batch.length ? 1 : 0); batch.push(item);
    }
    if (batch.length) void dispatch(batch);
  }
  return function rpc(method, params = [], signal) {
    if (!METHODS.has(method)) return Promise.reject(new Error('Read-only method required'));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Read cancelled'), { name: 'AbortError' }));
    if(now()<retryAt)return Promise.reject(rateLimited());
    if (queue.length >= 250) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const item = { request: { jsonrpc: '2.0', id: ++serial, method, params }, finished: false };
      const abort = () => item.finish(false, Object.assign(new Error('Read cancelled'), { name: 'AbortError' }));
      item.finish = (success, value) => {
        if (item.finished) return; item.finished = true; signal?.removeEventListener('abort', abort);
        (success ? resolve : reject)(value);
      };
      signal?.addEventListener('abort', abort, { once: true });
      queue.push(item);
      if (!scheduled) { scheduled = true; setTimeout(flush, 0); }
    });
  };
}
