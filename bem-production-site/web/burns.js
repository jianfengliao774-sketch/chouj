import {t,getLocale} from './player-i18n.js';
import {formatUnits} from 'ethers';
import {validateRecords,transactionUrl} from './public-record-guards.js';
const $=id=>document.getElementById(id);let data=null,page=1,version=0,loading=false,error=false;
function render(){
  $('burn-status').textContent=loading?t('读取链上记录…','Reading onchain records…'):error?t('记录暂不可用，请稍后刷新。','Records unavailable. Refresh shortly.'):data?.deploymentPending?t('本场次待开放，暂无销毁记录。','This pool is awaiting launch. No burn records yet.'):data?.index?.state==='ready'?t('已确认 {count} 笔销毁','{count} confirmed burns',{count:data.total}):t('链上记录同步中，仅展示已取得的确认记录。','Syncing. Only previously confirmed records are shown.');
  const target=$('burn-records');target.replaceChildren();
  if(!data?.rows?.length){const p=document.createElement('p');p.className='empty-state';p.textContent=error?t('无法读取记录','Could not read records'):t('暂无已确认销毁记录。完成链上销毁后，这里将展示金额、时间及完整交易哈希。','No confirmed burns yet. Amounts, times and full transaction hashes appear here after an onchain burn.');target.append(p);}
  else {const table=document.createElement('table');table.className='burn-table';const headers=[t('场次 / 期号','Pool / round'),t('销毁金额','Amount burned'),t('时间','Time'),t('交易哈希','Transaction hash')];const head=document.createElement('thead'),tr=document.createElement('tr');for(const title of headers){const th=document.createElement('th');th.scope='col';th.textContent=title;tr.append(th);}head.append(tr);table.append(head);const body=document.createElement('tbody');for(const row of data.rows){const tr=document.createElement('tr');const cells=headers.map(label=>{const td=document.createElement('td');td.dataset.label=label;tr.append(td);return td;});cells[0].textContent=(row.poolId==='legacy100'?t('原 100 BEM','Original 100 BEM'):`${row.poolId} BEM`)+t(' · 第 {round} 期',' · Round {round}',{round:row.roundId});const amt=document.createElement('strong');amt.textContent=Number(formatUnits(row.amountBaseUnits,8)).toLocaleString(getLocale(),{maximumFractionDigits:8})+' BEM';const kind=document.createElement('small');kind.textContent=row.kind==='unclaimed'?t('逾期未领本金','Expired unclaimed principal'):t('开奖分配 4%','4% settlement allocation');cells[1].append(amt,kind);cells[2].textContent=new Date(row.timeUtc).toLocaleString(getLocale());cells[3].className='hash';const a=document.createElement('a');a.href=transactionUrl(row.transactionHash);a.textContent=row.transactionHash;a.target='_blank';a.rel='noopener noreferrer';cells[3].append(a);body.append(tr);}table.append(body);target.append(table);}
  $('burn-page').textContent=`${page} / ${Math.max(1,data?.totalPages??1)}`;$('burn-prev').disabled=loading||page<=1;$('burn-next').disabled=loading||!data||page>=data.totalPages;$('burn-refresh').disabled=loading;
}
async function load(next=1){const request=++version;page=next;loading=true;error=false;render();try{const response=await fetch(`/api/burns?pool=${encodeURIComponent($('burn-pool').value)}&page=${page}`,{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error();const result=validateRecords(await response.json(),'burn');if(request!==version)return;data=result;}catch{if(request!==version)return;data=null;error=true;}finally{if(request===version){loading=false;render();}}}
let initialized=false;
export function showBurnRecords(){
  if(!$('panel-burns'))return;
  if(!initialized){
    initialized=true;
    $('burn-pool').addEventListener('change',()=>{data=null;load();});$('burn-refresh').addEventListener('click',()=>load(page));$('burn-prev').addEventListener('click',()=>{if(page>1)load(page-1);});$('burn-next').addEventListener('click',()=>{if(page<(data?.totalPages??0))load(page+1);});window.addEventListener('bem:languagechange',render);
    load();
  }else render();
}
