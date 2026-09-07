import {t,getLocale} from './player-i18n.js';
import {validateRecords,transactionUrl} from './public-record-guards.js';
import {formatUnits} from 'ethers';
import './winner-broadcast.js';
const $=id=>document.getElementById(id);
let page=1,selectedPool='100',requestVersion=0,history=null;
const amount=value=>Number(formatUnits(value,8)).toLocaleString(getLocale(),{maximumFractionDigits:8});
const shortened=value=>`${value.slice(0,8)}…${value.slice(-6)}`;
function external(hash,label){const a=document.createElement('a');a.href=transactionUrl(hash);a.textContent=label;a.target='_blank';a.rel='noopener noreferrer';return a;}
function tier(row){return row.poolId==='legacy100'?t('原 100 BEM 场','Original 100 BEM pool'):`${row.poolId} BEM`;}
function renderHistory(){
  const target=$('history-list');if(!target)return;target.replaceChildren();
  $('history-summary').textContent=history?.deploymentPending?t('本场次待开放，暂无已确认开奖。','This pool is awaiting launch. No confirmed draws yet.'):history?.index?.state==='ready'?t('已确认 {count} 条中奖记录','{count} confirmed draws',{count:history.total}):t('链上记录尚在同步，稍后刷新。','Onchain records are syncing. Refresh shortly.');
  if(!history?.rows.length){const p=document.createElement('p');p.className='empty-state';p.textContent=t('暂无中奖记录','No winning records yet');target.append(p);}
  for(const row of history?.rows??[]){const section=document.createElement('article');section.className='public-history-row';const details=document.createElement('div');const label=document.createElement('small');label.textContent=t('{tier} · 第 {round} 期','{tier} · Round {round}',{tier:tier(row),round:row.roundId});const prize=document.createElement('b');prize.textContent=`${amount(row.amountBaseUnits)} BEM`;details.append(label,prize);const winner=document.createElement('div');winner.append(document.createTextNode(shortened(row.winner)));const date=document.createElement('time');date.dateTime=row.timeUtc;date.textContent=new Date(row.timeUtc).toLocaleString(getLocale());winner.append(document.createElement('br'),date);section.append(details,winner,external(row.transactionHash,t('链上凭证 ↗','Onchain receipt ↗')));target.append(section);}
  $('history-prev').disabled=page<=1;$('history-next').disabled=!history||page>=history.totalPages;$('history-page').textContent=`${page} / ${Math.max(1,history?.totalPages??1)}`;
}
async function get(path){const response=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error();return validateRecords(await response.json(),'winner');}
async function refreshHistory(next=page){const epoch=++requestVersion,pool=selectedPool;page=next;try{const result=await get(`/api/announcements?pool=${pool}&page=${page}`);if(epoch!==requestVersion)return;history=result;}catch{if(epoch!==requestVersion)return;history=null;}renderHistory();}
window.addEventListener('bem:poolchange',event=>{selectedPool=String(event.detail?.pool?.id??'100');history=null;page=1;renderHistory();refreshHistory(1);});
window.addEventListener('bem:historyrefresh',()=>refreshHistory());
window.addEventListener('bem:languagechange',renderHistory);
$('refresh-history')?.addEventListener('click',()=>refreshHistory());$('history-prev')?.addEventListener('click',()=>{if(page>1)refreshHistory(page-1);});$('history-next')?.addEventListener('click',()=>{if(page<(history?.totalPages??0))refreshHistory(page+1);});
refreshHistory();
