import {t,getLocale,getLanguage} from './player-i18n.js';
import {formatSiteTime} from './site-time.js';
import {quoteView} from './market-guards.js';
const $=id=>document.getElementById(id);
let quote=null,prize='9500000000',loading=false;
const number=(value,digits)=>value===null?'—':value.toLocaleString(getLocale(),{maximumFractionDigits:digits});
function render(){
  const view=quoteView(quote,prize);
  $('prize-usdt').textContent=view.usdt?`≈ ${number(view.usdt.prize,2)}`:'—';
  $('prize-bnb').textContent=view.bnb?`≈ ${number(view.bnb.prize,6)}`:'—';
  $('bem-unit-price').textContent=`1 BEM ≈ ${view.usdt?number(view.usdt.unitPrice,4):'—'} U · ${view.bnb?number(view.bnb.unitPrice,8):'—'} BNB`;
  $('market-time').textContent=view.current?t('更新 {time} · 参考市值','Updated {time} · Estimate',{time:formatSiteTime(new Date(view.updatedAt).toISOString(),getLanguage())}):t('币价暂不可用 · 稍后自动更新','Price unavailable · Retrying');
  const sources=$('market-sources');sources.replaceChildren();
}
async function refresh(){
  if(loading||document.hidden)return;loading=true;
  try{const response=await fetch('/api/market',{cache:'no-store',signal:AbortSignal.timeout(9000)});if(!response.ok)throw Error();quote=await response.json();}
  catch{quote=quote?{...quote,stale:true}:null;}finally{loading=false;render();}
}
window.addEventListener('bem:poolchange',event=>{const pool=event.detail?.pool;prize=pool?.winnerBaseUnits??pool?.rules?.winnerBaseUnits??'9500000000';render();});
window.addEventListener('bem:languagechange',render);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(refresh,60000);setInterval(render,15000);refresh();
