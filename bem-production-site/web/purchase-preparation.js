// A short-lived, exact-context preparation. This only reads; a user click is
// still required to send. Changed selection/account/pool and old results expire.
export function createPurchasePreparation({context,load,now=Date.now,ttl=5000}) {
  let job=null;
  function get(){
    const key=context().key;
    if(job&&job.key===key&&(!job.done||now()-job.at<ttl))return job.promise;
    const next={key,at:now(),done:false,promise:null};job=next;
    next.promise=Promise.resolve().then(load).then(value=>{
      if(context().key!==key)throw Object.assign(Error('CONTEXT_CHANGED'),{code:'CONTEXT_CHANGED'});
      return value;
    }).catch(error=>{if(job===next)job=null;throw error;}).finally(()=>{next.done=true;});
    return next.promise;
  }
  return {get,warm(){void get().catch(()=>{});},clear(){job=null;}};
}
