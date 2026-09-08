// Share unfinished public-data reads even when an upstream request outlasts the
// cache lifetime. The lifetime starts only once a usable result is available.
export function createAsyncCache({now=Date.now}={}){
  const entries=new Map();
  return function cached(key,ttl,load){
    const old=entries.get(key);
    if(old&&(old.pending||now()-old.completedAt<ttl))return old.promise;
    const item={pending:true,completedAt:null,promise:null};
    item.promise=Promise.resolve().then(load).then(value=>{
      item.pending=false;item.completedAt=now();return value;
    },error=>{
      if(entries.get(key)===item)entries.delete(key);
      throw error;
    });
    entries.set(key,item);
    return item.promise;
  };
}
