import {parseTickets} from './sparkdraw-transactions.js';
const POOLS=new Set(['5','10','50']);
export function isMobileBrowser(navigator={}){
  return navigator.userAgentData?.mobile===true||/Android|iPhone|iPad|iPod/i.test(navigator.userAgent||'')
    ||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
}
// Only public selection values cross into another app. Never forward arbitrary
// URL parameters, wallet addresses, admin state or a transaction/signature.
export function walletPageUrl(location,{pool='5',count='1',mode='auto',tickets=''}={}){
  let source;try{source=new URL(location?.href||location);}catch{return null;}
  if(!['https:','http:'].includes(source.protocol))return null;
  const url=new URL('/',source.origin);
  if(source.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(source.hostname))return null;
  url.searchParams.set('pool',POOLS.has(pool)?pool:'5');
  if(mode==='selected'){
    url.searchParams.set('mode','selected');
    try{
      const selected=parseTickets('selected',0,tickets).tickets.map(n=>n+1),ranges=[];
      for(let i=0;i<selected.length;i++){const start=selected[i];let end=start;while(selected[i+1]===end+1)end=selected[++i];ranges.push(start===end?String(start):start+'-'+end);}
      const compact=ranges.join(',');
      if(compact.length<=1200)url.searchParams.set('tickets',compact);else url.searchParams.set('reselect','1');
    }catch{url.searchParams.set('reselect','1');}
  }else if(/^[1-9][0-9]*$/.test(String(count))&&Number(count)<=5000)url.searchParams.set('count',String(Number(count)));
  return url.href;
}
export function walletDappLink(name,dappUrl){
  if(!dappUrl)return null;
  const url=new URL(dappUrl);if(url.protocol!=='https:')return null;
  // Formats verified against MetaMask docs and the TRON EVM wallet adapters.
  if(name==='TokenPocket')return 'tpdapp://open?params='+encodeURIComponent(JSON.stringify({url:url.href}));
  if(name==='OKX Wallet')return 'okx://wallet/dapp/url?dappUrl='+encodeURIComponent(url.href);
  if(name==='MetaMask')return 'https://link.metamask.io/dapp/'+url.href.slice('https://'.length);
  return null;
}
