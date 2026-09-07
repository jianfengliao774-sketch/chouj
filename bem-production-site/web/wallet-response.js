// Bound bridge reads/connection prompts that may lose their native callback.
// This never retries and must not wrap transaction submission/signing requests.
export async function waitForWalletResponse(run,{timeout=5000}={}){
  let timer;
  try{return await Promise.race([
    Promise.resolve().then(run),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Wallet did not respond'),{code:'WALLET_RESPONSE_TIMEOUT'})),timeout);})
  ]);}finally{clearTimeout(timer);}
}
