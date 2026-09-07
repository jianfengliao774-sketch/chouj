// Restore only accounts already authorized by the wallet. Never request permissions here.
const KEY='sparkdraw:preferred-wallet';
export function createWalletSession({storage,onRestore,version}){
  let generation=0;
  function preference(){try{return JSON.parse(storage.getItem(KEY)||'null');}catch{return null;}}
  function remember(entry){try{storage.setItem(KEY,JSON.stringify({rdns:entry.rdns||'',name:entry.rdns?'':entry.name||''}));}catch{}}
  const cancel=()=>{generation++;};
  async function restore(entries){
    const run=++generation,revision=version(),saved=preference();
    const candidates=[...entries.values()].filter(e=>!saved||(saved.rdns?e.rdns===saved.rdns:e.name===saved.name));
    const results=await Promise.all(candidates.map(async entry=>{
      try{const accounts=await entry.provider.request({method:'eth_accounts'});if(!Array.isArray(accounts)||!/^0x[0-9a-fA-F]{40}$/.test(accounts[0]||''))return null;
        const chainId=await entry.provider.request({method:'eth_chainId'});return{entry,account:accounts[0],chainId};
      }catch{return null;}
    }));
    const authorized=results.filter(Boolean);
    if(run!==generation||revision!==version()||authorized.length!==1)return false;
    await onRestore(authorized[0]);remember(authorized[0].entry);return true;
  }
  return{restore,remember,cancel};
}
