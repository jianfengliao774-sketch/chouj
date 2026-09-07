import { initLanguage, getLanguage, t } from './player-i18n.js';
import { formatSiteTime } from './site-time.js';
import { profile } from './sparkdraw-profiles.js';
import { SPARKDRAW as F } from './sparkdraw-config.js';

const $ = id => document.getElementById(id);
let result = null;
const node = (tag,value) => {const e=document.createElement(tag);e.textContent=value;return e;};
function link(type,value){
  const valid=type==='address'?/^0x[0-9a-fA-F]{40}$/:/^0x[0-9a-fA-F]{64}$/;
  if(!valid.test(value))return node('span',t('暂不可用','Unavailable'));
  const a=node('a',value);a.className='hash';a.href='https://bscscan.com/'+type+'/'+value;a.target='_blank';a.rel='noopener noreferrer';return a;
}
function render(){
  document.title=t('开奖说明 · Tapeout 芯火夺宝','How draws work · Tapeout SparkDraw');
  if(!result)return;
  const box=$('query-results');box.replaceChildren();
  if(result.error){$('query-status').textContent=t('读取暂时失败，请稍后重试。可使用下方 BscScan 链接独立核对。','Read failed. Try again later or verify independently with the BscScan links below.');return;}
  const rows=result.rows;
  $('query-status').textContent=rows.length?t('已找到 {n} 条已确认记录。','Found {n} confirmed records.',{n:rows.length}):t('索引中暂未找到该期，请核对场次与期号；这不代表链上不存在。','No indexed record found. Check the pool and round ID; this does not prove absence onchain.');
  for(const r of rows){
    const card=node('article','');card.className='query-card';
    card.append(node('h3',r.poolId+' BEM · '+(r.displayRoundId||t('链上第 {n} 期','Internal round {n}',{n:r.roundId}))));
    const dl=node('dl','');const add=(label,value)=>{const row=node('div','');row.append(node('dt',label));const dd=node('dd','');dd.append(typeof value==='string'?document.createTextNode(value):value);row.append(dd);dl.append(row);};
    add(t('场次合约','Pool contract'),link('address',profile(r.poolId).address));
    add(t('链上内部期号 / 实售份数','Internal round ID / sold tickets'),r.roundId+' / '+r.sold);
    const names={0:['未开始','Not started'],1:['募集中','Funding'],3:['等待随机证明','Waiting for proof'],4:['等待结算','Ready to settle'],5:['已开奖','Settled'],6:['退款阶段','Refunds']};
    add(t('索引状态','Indexed status'),t(...(names[r.status]||['未知状态','Unknown state'])));
    if(r.sealedAt)add(t('封盘时间','Closed at'),formatSiteTime(r.sealedAt,getLanguage()));
    if(/^[1-9][0-9]{0,20}$/.test(String(r.beaconRound))){add(t('固定 drand 轮次','Fixed drand round'),String(r.beaconRound));const a=node('a',t('查看该轮原始信标与签名','View original beacon and signature'));a.href='https://api.drand.sh/'+F.beaconHash+'/public/'+r.beaconRound;a.target='_blank';a.rel='noopener noreferrer';add(t('独立信标来源','Independent beacon source'),a);}
    if(r.beaconRandomness)add(t('随机数 · SHA-256(signature)','Randomness · SHA-256(signature)'),node('code',r.beaconRandomness));
    if(r.signature)add(t('BLS 证明签名（不是哈希）','BLS proof signature (not a hash)'),node('code',r.signature));
    if(r.proofTransactionHash)add(t('证明交易哈希','Proof transaction hash'),link('tx',r.proofTransactionHash));
    if(r.status===5){
      add(t('中奖号码','Winning number'),String(Number(r.winningTicket)+1).padStart(5,'0'));add(t('中奖钱包','Winning wallet'),link('address',r.winner));
      if(r.settlementTransactionHash)add(t('结算交易哈希','Settlement transaction hash'),link('tx',r.settlementTransactionHash));
      if(r.prize){add(t('奖金领取状态','Prize claim status'),r.prize.claimed?t('已领取','Claimed'):r.prize.burned?t('已销毁','Burned'):t('未领取（是否到期请核对截止时间与链上状态）','Unclaimed (check deadline and current chain state)'));add(t('奖金领取截止','Prize claim deadline'),formatSiteTime(r.prize.claimDeadline,getLanguage()));}
    }
    card.append(dl);box.append(card);
  }
}
initLanguage();render();window.addEventListener('bem:languagechange',render);
$('guide-query').addEventListener('submit',async event=>{
  event.preventDefault();const round=$('guide-round').value.trim(),pool=$('guide-pool').value;
  if(!/^[1-9][0-9]{0,20}$/.test(round)){$('query-status').textContent=t('请输入有效的纯数字期号。','Enter a valid numeric round ID.');return;}
  const button=event.currentTarget.querySelector('button');button.disabled=true;result=null;$('query-results').replaceChildren();$('query-status').textContent=t('正在查询已确认链上记录…','Reading confirmed onchain records…');
  try{
    const response=await fetch('/api/sparkdraw/records?'+new URLSearchParams({kind:'rounds',pool,round}),{signal:AbortSignal.timeout(15000)});
    if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('Read failed');
    const data=await response.json();
    if(!Array.isArray(data.rows)||data.rows.some(r=>r.poolId!==pool||r.gameAddress?.toLowerCase()!==profile(pool).address.toLowerCase()||(String(r.roundId)!==round&&r.displayRoundId!==round)))throw Error('Unexpected record identity');
    result=data;
  }catch{result={error:true};}finally{button.disabled=false;render();}
});
