// Share only requests that are still running. Completed data is never reused,
// so a refresh or a claim lookup still asks the server for its current view.
export function createInFlightReads(read,{now=Date.now}={}) {
  const pending = new Map(),cooldowns=new Map();
  return function load(key) {
    if (pending.has(key)) return pending.get(key);
    for(const [url,entry] of cooldowns)if(entry.until<=now())cooldowns.delete(url);
    const cooling=cooldowns.get(key);if(cooling)return Promise.reject(cooling.error);
    const request = Promise.resolve().then(() => read(key)).catch(error=>{
      if(error.status===429){
        const raw=error.retryAfter,seconds=typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw.trim())?Number(raw)*1000:NaN;
        const dated=typeof raw==='string'?Date.parse(raw)-now():NaN;
        const delay=Math.min(60000,Math.max(0,Number.isFinite(seconds)?seconds:Number.isFinite(dated)?dated:5000));
        cooldowns.set(key,{until:now()+delay,error});
      }
      throw error;
    });
    pending.set(key, request);
    const clear = () => { if (pending.get(key) === request) pending.delete(key); };
    request.then(clear, clear);
    return request;
  };
}
