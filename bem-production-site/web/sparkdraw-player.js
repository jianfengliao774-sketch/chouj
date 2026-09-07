import {formatUnits,formatEther,getAddress} from 'ethers';
import {formatWalletBalance3} from './balance-display.js';
import {roundDisplay} from './round-display.js';
import {formatSiteTime} from './site-time.js';
import {POOL_IDS,POOLS,profile,VERIFIER} from './sparkdraw-profiles.js';
import {SPARKDRAW as F} from './sparkdraw-config.js';
import {createWalletPicker} from './wallet-picker.js';
import {createWalletSession} from './wallet-connection.js';
import {t,getLanguage,initLanguage,translateKnown} from './player-i18n.js';
import {createSparkDrawTransactions,parseTickets,GAME,TOKEN} from './sparkdraw-transactions.js';
const $=id=>document.getElementById(id),money=x=>formatUnits(BigInt(x||0),8).replace(/\.0$/,''),el=(tag,text)=>Object.assign(document.createElement(tag),{textContent:text});
const burnMoney=x=>{const milli=(BigInt(x||0)+50000n)/100000n;return `${milli/1000n}.${String(milli%1000n).padStart(3,'0')}`;};
const url=new URL(location.href);let pool=POOL_IDS.includes(url.searchParams.get('pool'))?url.searchParams.get('pool'):'0.1';
let wallet=null,account=null,chain=null,revision=0,mode='auto',snapshot=null,balance=null,allowance=0n,held=0n,loading=false,flow=false,serial=0,tab=document.body.dataset.initialTab||location.hash.slice(1)||'draw';
let personalPage=1,burnPage=1,burnWalletPage=1,historyPage=1,recordsVersion=0,activeResult=null;
let refundData=null,refundError=false,refundFlow=false;
const roundName=r=>r?.displayRoundId?roundDisplay(r):r?.status===0?t('待开盘','Not opened'):t('期号同步中','Number syncing');
const context=()=>({account,key:JSON.stringify([revision,account,pool,chain,mode,$('ticket-count').value,$('selected-tickets').value])});
const note=x=>{$('notice').textContent=x;};
async function api(path,body){const r=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(15000),...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});let d;try{d=await r.json();}catch{throw Error(t('服务暂时无法响应，正在自动重试。','Service temporarily unavailable; retrying.'));}if(!r.ok)throw Error(d.error||'Network unavailable');return d;}
const rpc=async(method,params)=>{const d=await api('/rpc',{jsonrpc:'2.0',id:++serial,method,params});if(d.error)throw Error(d.error.message);return d.result;};
const call=async(iface,to,name,args)=>iface.decodeFunctionResult(name,await rpc('eth_call',[{to,data:iface.encodeFunctionData(name,args)},'latest']));
const manager=createSparkDrawTransactions({rpc,wallet:()=>wallet,context,onChange:()=>render()});
const links=(kind,value,label=value)=>{const a=el('a',label);a.href='https://bscscan.com/'+kind+'/'+value;a.target='_blank';a.rel='noopener noreferrer';a.className='mono';return a;};
const errors={GAS_FEE_CAP_EXCEEDED:['预计网络费超过 0.001 BNB，未发送。请减少份数或等待网络费用下降。','The maximum network fee exceeds 0.001 BNB. Nothing was sent. Reduce the quantity or wait.'],TICKET_LIMIT:['每笔请选择 1–5,000 份。','Choose 1–5,000 tickets per transaction.'],TICKET_RANGE:['请输入 00001–10000 内的号码或连续区间。','Enter numbers or ranges within 00001–10000.'],CONTEXT_CHANGED:['钱包或选择已变化，请重新操作。','Wallet or selection changed. Try again.'],TRANSACTION_PENDING:['上一笔交易仍在等待确认，请查看交易记录。','The previous transaction is pending. See its transaction record.'],GAS_LIMIT_EXCEEDED:['该组合的 Gas 超过单笔限制，请减少份数或使用自动分配。','Gas exceeds the transaction limit. Reduce tickets or use auto-assign.'],INSUFFICIENT_BEM:['BEM 余额不足。','Insufficient BEM balance.'],ADDRESS_LIMIT:['本钱包本期已达到 5,000 份。','This wallet has reached 5,000 tickets this round.']};
function failure(e){note(e.code===4001||e.code==='ACTION_REJECTED'?t('已取消钱包确认。','Wallet request cancelled.'):errors[e.code]?t(...errors[e.code]):t('操作未完成：','Could not complete: ')+String(e.shortMessage||e.message||e).slice(0,150));}
function button(label,fn){const b=el('button',label);b.type='button';b.onclick=()=>Promise.resolve(fn()).catch(failure);return b;}
const bound=new WeakSet();
function bind(p){if(bound.has(p))return;bound.add(p);
  p.on?.('accountsChanged',a=>{if(wallet!==p)return;const next=a[0]?getAddress(a[0]):null;if(next===account)return;account=next;revision++;balance=null;allowance=0n;$('personal-wallet').value=account||'';render();refresh();refreshRecords();});
  p.on?.('chainChanged',c=>{if(wallet!==p)return;const next=Number(BigInt(c));if(next===chain)return;chain=next;revision++;snapshot=null;render();refresh();});
}
let discoveredWallets=new Map(),restoreTimer,connectingWallet=false;
let sessionStorage;try{sessionStorage=window.localStorage;}catch{sessionStorage={getItem:()=>null,setItem(){}};}
const walletSession=createWalletSession({storage:sessionStorage,version:()=>revision,onRestore:async({entry,account:restored,chainId})=>{
  if(account)return;wallet=entry.provider;account=getAddress(restored);chain=Number(BigInt(chainId));revision++;bind(wallet);
  $('personal-wallet').value=account;render();await refresh();await refreshRecords();
}});
function restoreConnection(){clearTimeout(restoreTimer);if(account||connectingWallet)return;restoreTimer=setTimeout(()=>{if(!account&&!connectingWallet&&!$('wallet-picker').open)walletSession.restore(discoveredWallets).catch(()=>{});},120);}
window.addEventListener('focus',restoreConnection);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)restoreConnection();});
const picker=createWalletPicker({dialog:$('wallet-picker'),onChange(entries){discoveredWallets=entries;restoreConnection();},onSelect:async(entry)=>{
  const {provider}=entry;connectingWallet=true;walletSession.cancel();clearTimeout(restoreTimer);
  try{const r=++revision;const a=await provider.request({method:'eth_requestAccounts'});if(r!==revision)return;
    wallet=provider;account=a[0]?getAddress(a[0]):null;chain=Number(BigInt(await provider.request({method:'eth_chainId'})));bind(provider);
    if(account)walletSession.remember(entry);$('personal-wallet').value=account||'';render();await refresh();await refreshRecords();
  }catch(e){failure(e);}finally{connectingWallet=false;}
}});
$('connect-wallet').onclick=()=>{walletSession.cancel();clearTimeout(restoreTimer);picker.open();};$('burn-connect').onclick=()=>account?refreshRecords():picker.open();
$('switch-network').onclick=async()=>{try{await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});}catch(e){failure(e);}};
$('copy-browser-url').onclick=()=>navigator.clipboard.writeText(location.href);
$('copy-wallet-address').onclick=async()=>{
  const address=account;if(!address)return;
  try{await navigator.clipboard.writeText(address);note(t('钱包地址已复制。','Wallet address copied.'));}
  catch{note(t('复制未成功，请选择钱包地址手动复制。','Copy failed. Select the wallet address and copy it manually.'));}
};
function selection(){return parseTickets(mode,$('ticket-count').value,$('selected-tickets').value);}
function render(){
  $('site-time').textContent=formatSiteTime(chainNow(),getLanguage());
  const p=profile(pool),r=snapshot?.rounds.find(x=>x.roundId===snapshot.currentRoundId),gross=BigInt(p.units),prize=gross*(99n-BigInt(p.burnPercent))/100n;
  $('connect-wallet').textContent=account?t('切换钱包','Switch wallet'):t('连接钱包','Connect wallet');
  $('wallet-label').textContent=account?t('已连接钱包','Wallet connected'):t('连接钱包，查看余额与持票','Connect wallet to view balances and tickets');$('wallet-address').textContent=account||'';
  $('copy-wallet-address').hidden=!account;$('copy-wallet-address').disabled=!account;
  $('wallet-balances').textContent=t('您目前持有：BEM：{bem}，BNB：{bnb}','Your balances: BEM: {bem}, BNB: {bnb}',{bem:balance?formatWalletBalance3(balance.bem,8):'—',bnb:balance?formatWalletBalance3(balance.bnb,18):'—'});$('switch-network').hidden=!wallet||chain===56;
  $('wallet-balances').title=balance?t('完整余额：BEM {bem} · BNB {bnb}','Full balance: BEM {bem} · BNB {bnb}',{bem:money(balance.bem),bnb:formatEther(balance.bnb)}):'';
  $('launch-status').textContent=t('新五档合约已部署','Five new pools deployed');$('sale-note').textContent=p.test?t('0.1 BEM 测试场，使用 BNB 主网真实 BEM。','0.1 BEM test with real BEM on BNB mainnet.'):t('首次购买开始 24 小时募集。','The first purchase starts the 24-hour funding period.');
  $('prize-bem').textContent=money(prize);$('payout-burn').textContent=money(gross*BigInt(p.burnPercent)/100n)+' BEM';$('payout-container').textContent=money(gross/100n)+' BEM';$('payout-winner').textContent=money(prize)+' BEM';
  $('community-copy').textContent=t('您的每一份参与，都在为 Tapeout 生态建设添一份力量。\n每次成功开奖，实收金额的 {burn}% 转入销毁地址，1% 进入容器，其余为中奖奖金。','Every entry contributes to the Tapeout ecosystem.\nEach completed draw burns {burn}% of actual receipts, sends 1% to the container and reserves the remainder for the winner.',{burn:p.burnPercent});
  $('community-allocation').textContent=t('收款固定进入 13061 容器，用于社区运营与维护；按实际售出份数分配。','Revenue goes to container 13061 for community operations; allocation uses the actual tickets sold.');
  $('purchase-rules').textContent=t('每份 {unit} BEM · 00001–10000 · 单笔及单钱包每期最多 5,000 份','{unit} BEM per ticket · 00001–10000 · Maximum 5,000 per transaction and wallet per round',{unit:money(p.ticketPrice)});
  $('rule-funding').textContent=t('售出 9,500 份启动一次性 30 分钟倒计时，满额提前封盘；到期按实售份额开奖，最晚不超过原 24 小时募集期限。','9,500 sold starts a single 30-minute countdown. Sellout closes early. The deadline never exceeds the original 24-hour funding window.');
  $('rule-refunds').textContent=t('未封盘超过 24 小时，或封盘后 24 小时未完成开奖，开放 24 小时退款期。奖金也须在结算后 24 小时内领取，过期余额可通过链上交易销毁。','Unsealed funding after 24 hours, or a draw unfinished for 24 hours after closing, opens a 24-hour refund window. Prizes have a 24-hour claim window after settlement. Expired balances can be burned onchain.');
  $('footer-rules').textContent=t('每期 10,000 份 · 单笔最多 5,000 份','10,000 tickets per round · Up to 5,000 per purchase');
  $('mode-auto').setAttribute('aria-pressed',String(mode==='auto'));$('mode-selected').setAttribute('aria-pressed',String(mode==='selected'));$('auto-fields').hidden=mode!=='auto';$('selected-fields').hidden=mode!=='selected';
  let valid=true;try{const s=selection();$('purchase-total').textContent=money(BigInt(s.count)*p.ticketPrice)+' BEM';$('selection-note').textContent=t('申请 {count} 份，仅按实际分配份数扣款。','Requesting {count} tickets; only allocated tickets are charged.',{count:s.count});}catch{valid=false;$('purchase-total').textContent='— BEM';}
  const now=chainNow(),open=r&&(r.status===0||r.status===1&&now<Math.min(r.fundingDeadline,r.earlyDrawDeadline||Infinity));
  $('buy').disabled=!!account&&(!valid||!open||chain!==56||flow||manager.busy||manager.blocked({method:'buy'}));
  $('buy').textContent=flow?t('等待钱包与链上确认…','Waiting for wallet / confirmation…'):!account?t('连接钱包并购买','Connect wallet to buy'):t('授权并购买','Approve & buy');
  $('purchase-state').textContent=!account?t('点击购买会连接钱包。','Click buy to connect your wallet.'):manager.blocked({method:'buy'})?t('购买记录核对中，可继续领取奖金或退款。钱包加速或取消后将更新结果。','Checking your purchase. Prize and refund claims remain available; wallet replacements will be checked.'):!open?t('读取状态中，或本期购买时间已结束。','Loading state, or sales for this round have ended.'):t('本钱包本期还可购买 {count} 份。','This wallet may buy {count} more tickets this round.',{count:String(5000n-held)});
  $('my-count').textContent=account?String(held):'—';
  $('round-label').textContent=roundName(r);
  $('round-phase').textContent=r?statusText(r.status):t('读取中','Loading');$('funding-amount').textContent=`${money(BigInt(r?.sold||0)*p.ticketPrice)} / ${pool} BEM`;$('funding-tickets').textContent=`${r?.sold||0} / 10,000`;$('funding-progress').firstElementChild.style.width=((r?.sold||0)/100)+'%';
  $('contract-links').replaceChildren(...[[t('场次合约','Pool contract'),p.address],['BEM',F.bem],[t('收款容器','Revenue container'),F.revenue],[t('随机数验证合约','Randomness verifier'),VERIFIER],[t('开奖处理器','Draw processor'),'0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C']].flatMap(([label,address])=>{const dd=el('dd','');dd.append(links('address',address));return[el('dt',label),dd];}));
  $('snapshot-label').textContent=snapshot?t('已核验 · 区块 {block}','Verified · Block {block}',{block:snapshot.blockNumber}):'';
  window.dispatchEvent(new CustomEvent('bem:poolchange',{detail:{pool:{winnerBaseUnits:prize.toString()}}}));
  renderDraw();renderPending();renderSelector();renderRefund();
}
const statusText=n=>[t('首次购买即开盘','Starts with first purchase'),t('购买中','Open'),t('已封盘','Closed'),t('等待随机数','Awaiting randomness'),t('等待计算结算','Awaiting settlement'),t('已开奖','Settled'),t('退款中','Refunding')][n];
const chainNow=()=>snapshot?snapshot.time+Math.floor((Date.now()-snapshot.receivedAt)/1000):Math.floor(Date.now()/1000);
function countdown(node,deadline){node.dataset.deadline=String(deadline);const left=Math.max(0,deadline-chainNow());node.textContent=left?[Math.floor(left/3600),Math.floor(left%3600/60),left%60].map(n=>String(n).padStart(2,'0')).join(':'):(node.dataset.expiredText||t('已到期','Expired'));}
function reelPrizeVisible(r,account,now){return !!account&&r.status===5&&r.winner?.toLowerCase()===account.toLowerCase()&&BigInt(r.prize?.amount||0)>0n&&!r.prize.claimed&&!r.prize.burned&&now<Number(r.prize.claimDeadline);}
function renderDraw(){
  const current=snapshot?.rounds[0],prior=snapshot?.rounds[1],draw=prior&&[3,4,5].includes(prior.status)?prior:current;$('countdown-panel').hidden=false;
  const deadline=draw&&[3,4].includes(draw.status)?draw.beaconAvailableAt:current?.earlyDrawDeadline||current?.fundingDeadline;
  $('countdown-value').dataset.expiredText=draw&&[3,4].includes(draw.status)||current?.sold>=9500?t('正在开奖','Drawing…'):t('募集已结束','Funding ended');
  $('countdown-label').textContent=draw&&[3,4].includes(draw.status)?t('随机数可提交倒计时','Randomness available in'):t('本期募集倒计时','Funding countdown');
  if(deadline)countdown($('countdown-value'),deadline);else{$('countdown-value').textContent=draw?.status===5?t('已开奖','Draw completed'):'—';delete $('countdown-value').dataset.deadline;}
  const worker=snapshot?.keeper?.worker,automatic=worker?.online&&worker.enabled&&BigInt(worker.balanceWei||0)>0n;
  $('countdown-note').textContent=draw&&[3,4].includes(draw.status)?automatic?t('后台自动处理随机数证明与开奖结算，完成后公布中奖号码。','The backend handles the randomness proof and settlement, then publishes the winning number.'):t('等待开奖服务就绪，结果确认后公布。','Waiting for the draw service; the confirmed result will be published.'):t('首次购买开始计时，开奖操作由后台处理。','Timing starts with the first purchase; the backend handles the draw.');
  const win=draw?.status===5?draw:null;activeResult=win;
  revealReels(win);
  $('reel-caption').textContent=draw?`${roundName(draw)} · ${statusText(draw.status)}`:'';
  $('reel-message').replaceChildren(win?links('address',win.winner,t('中奖钱包：','Winner: ')+win.winner):el('span',t('尚未产生中奖号码。','No winning number yet.')));$('replay').disabled=!win;
  const actions=$('draw-actions');actions.replaceChildren();
  for(const r of snapshot?.rounds||[]){
    if(reelPrizeVisible(r,account,chainNow()))actions.append(claimButton({...r,prize:{...r.prize,winner:r.winner}},pool));
  }

}
// Animation only presents the confirmed result. Polling never restarts a reveal.
let reelKey=null,reelRevealed=false,reelGeneration=0,reelAnimations=[];
function revealReels(win, replay=false){
  const key=win?`${pool}:${win.roundId}:${win.winningTicket}`:null;
  const digits=win?String(win.winningTicket+1).padStart(5,'0'):'—————';
  const changed=key!==reelKey;
  if(changed||replay){
    reelGeneration++;for(const animation of reelAnimations)animation.cancel();reelAnimations=[];
    reelKey=key;reelRevealed=false;
  }
  const reels=[...document.querySelectorAll('#reels .reel')];
  if(changed||replay||!win)for(const [i,reel] of reels.entries()){
    reel.querySelector('.placeholder').textContent=digits[i];reel.querySelector('.placeholder').hidden=false;
    reel.querySelector('.reel-strip').replaceChildren();reel.classList.remove('rolling');reel.classList.remove('is-revealed');
  }
  $('reels').setAttribute('aria-label',win?t('中奖号码 {number}','Winning number {number}',{number:digits}):t('尚未开奖','Awaiting draw'));
  if(!win||reelRevealed||!$('reels').getClientRects().length||document.hidden)return;
  reelRevealed=true;
  if(!replay&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  $('replay').textContent=t('卷轴滚动中…','Reels spinning…');
  const generation=reelGeneration;
  for(const [i,reel] of reels.entries()){
    const strip=reel.querySelector('.reel-strip'),placeholder=reel.querySelector('.placeholder');
    const steps=30*(i+1)+Number(digits[i]);
    strip.replaceChildren(...Array.from({length:steps+1},(_,n)=>el('span',String(n%10))));
    strip.setAttribute('aria-hidden','true');placeholder.hidden=true;reel.classList.add('rolling');
    const animation=strip.animate([{transform:'translateY(0)'},{transform:`translateY(-${steps*100}%)`}],
      {duration:5000*(i+1),easing:'linear',fill:'forwards'});
    reelAnimations.push(animation);
    animation.finished.then(()=>{
      if(generation!==reelGeneration)return;
      placeholder.textContent=digits[i];placeholder.hidden=false;reel.classList.remove('rolling');reel.classList.add('is-revealed');
      animation.cancel();strip.replaceChildren();if(i===reels.length-1)$('replay').textContent=t('回放卷轴','Replay reels');
    }).catch(()=>{});
  }
}
function renderSelector(){const list=$('pool-selection');list.className='pool-selection';list.replaceChildren(Object.assign(el('h3',t('请选择场次（每个场次份额均为10,000份）','Please choose a pool (10,000 tickets per pool)')),{className:'pool-selection-heading'}));const group=el('div','');group.className='pool-selection-options';for(const id of POOL_IDS){const b=button('',()=>{if(pool===id)return;pool=id;revision++;snapshot=null;held=0n;historyPage=1;url.searchParams.set('pool',id);history.replaceState(null,'',url);render();refresh();refreshRecords();});b.className='pool-choice';b.append(el('strong',`${id} BEM${id==='0.1'?t(' · 测试',' · Test'):''}`),el('span',t('每份 {price} BEM','{price} BEM per ticket',{price:money(profile(id).ticketPrice)})));b.setAttribute('aria-checked',String(id===pool));b.setAttribute('role','radio');group.append(b);}list.append(group);}
async function refresh(){if(loading)return;loading=true;const id=pool,rev=revision;
  try{const s=await api('/api/sparkdraw/state?pool='+id);if(s.version!==5||s.address.toLowerCase()!==profile(id).address.toLowerCase())throw Error('Contract mismatch');if(id!==pool||rev!==revision)return;snapshot={...s,receivedAt:Date.now()};
    if(account&&chain===56){const a=account,p=profile(id);const[b,al,native,tickets]=await Promise.all([call(TOKEN,F.bem,'balanceOf',[a]),call(TOKEN,F.bem,'allowance',[a,p.address]),rpc('eth_getBalance',[a,'latest']),call(GAME,p.address,'ticketsOf',[s.currentRoundId,a])]);if(id!==pool||rev!==revision)return;balance={bem:b[0],bnb:BigInt(native)};allowance=al[0];held=tickets[0];}
    render();
  }catch(e){if(id===pool&&rev===revision){snapshot=null;render();failure(e);}}finally{loading=false;}
}
function renderPending(){
  const rows=manager.pendings,history=manager.history.slice(-5).reverse(),key=JSON.stringify([account,rows,history,getLanguage()]);
  if(renderPending.key===key)return;renderPending.key=key;
  $('transactions').hidden=!rows.length&&!history.length;$('transaction-list').replaceChildren();$('unknown-test-transaction').hidden=true;
  const names={buy:t('购买','Purchase'),approve:t('授权','Approval'),claimPrizes:t('领取奖金','Prize claim'),refundMany:t('领取退款','Refund claim')};
  for(const p of rows){const card=el('article','');card.append(el('p',`${p.poolId} BEM · ${names[p.kind]||p.kind}`),el('p',p.recoveryNeeded?t('nonce 已被使用，原单结果待核实。请填写钱包中的最新交易哈希。','The nonce was used, but the original outcome is unverified. Enter the latest hash from your wallet.'):p.hash?t('等待确认；自动核对加速、取消和替换交易。','Pending; checking for speedups, cancellations and replacements.'):t('钱包未返回哈希，请查看钱包活动恢复。','No hash returned. Restore from your wallet activity.')));
    if(p.hash)card.append(links('tx',p.hash));if(p.candidateHash)card.append(el('br',''),links('tx',p.candidateHash,t('钱包最新交易','Latest wallet transaction')));
    const details=el('details',''),summary=el('summary',t('恢复交易 / 移出等待','Recover / stop waiting')),input=el('input','');input.placeholder='0x…';input.maxLength=66;input.setAttribute('aria-label',t('钱包最新交易哈希','Latest wallet transaction hash'));
    details.append(summary,input,button(t('核验最新哈希','Verify latest hash'),async()=>{const r=await manager.attach(input.value.trim(),p.id);if(r)showTransactionResult(r);refresh();refreshRecords();}),el('p',t('移出等待只移除本页阻塞，不会撤销链上交易。结果未明时，请勿重复购买。','Stopping the wait does not cancel an onchain transaction. Avoid buying again while the outcome is unknown.')),button(t('已核对钱包，移出等待','Wallet checked: stop waiting'),async()=>{await manager.stopTracking(p.id);render();}));card.append(details);$('transaction-list').append(card);
  }
  for(const r of history){const row=el('p',`${names[r.kind]||r.kind} · ${transactionStatus(r.status)}`);if(r.hash)row.append(' ',links('tx',r.hash));$('transaction-list').append(row);}
}
function transactionStatus(status){return({confirmed:t('已确认','Confirmed'),reverted:t('链上执行失败','Reverted'),cancelled:t('已被钱包取消','Cancelled in wallet'),replaced:t('已被其他交易替换','Replaced by another transaction'),unverified:t('已移出等待，链上结果未核实','No longer blocking; outcome unverified')})[status]||status;}
function showTransactionResult(r){note(transactionStatus(r.status));partial(r);}
function partial(result){if(!result?.result||result.result.filled>=result.result.requested)return;const r=result.result,dialog=el('dialog','');dialog.className='partial-fill-result';dialog.append(el('h2',t('部分购买成功','Partial purchase completed')),el('p',t('申请 {a} 份，成交 {b} 份；实际扣款 {c} BEM，其余 {d} BEM 未扣除。','Requested {a}, filled {b}; paid {c} BEM. The remaining {d} BEM was not charged.',{a:r.requested,b:r.filled,c:money(r.paid),d:money(r.unspent)})),button(t('知道了','OK'),()=>dialog.close()));document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();}
async function poll(force=false){try{const r=await manager.check({force});if(r){showTransactionResult(r);refresh();refreshRecords();return r;}}catch(e){failure(e);}return null;}
async function waitReceipt(hash,key){for(let i=0;i<30;i++){if(context().key!==key)throw Object.assign(Error('CONTEXT_CHANGED'),{code:'CONTEXT_CHANGED'});await poll();const r=manager.result(hash);if(r){if(r.status!=='confirmed')throw Error(transactionStatus(r.status));return;}await new Promise(resolve=>setTimeout(resolve,2000));}throw Object.assign(Error('TRANSACTION_PENDING'),{code:'TRANSACTION_PENDING'});}
async function buy(){if(!account)return picker.open();if(flow)return;flow=true;const key=context().key,id=pool;try{
    const s=selection(),p=profile(id),current=(await call(GAME,p.address,'currentRoundId',[]))[0],r=await call(GAME,p.address,'rounds',[current]),tickets=(await call(GAME,p.address,'ticketsOf',[current,account]))[0];
    const filled=Math.min(s.count,10000-Number(r[1]),5000-Number(tickets));if(filled<=0)throw Object.assign(Error('ADDRESS_LIMIT'),{code:'ADDRESS_LIMIT'});
    const [b,al]=await Promise.all([call(TOKEN,F.bem,'balanceOf',[account]),call(TOKEN,F.bem,'allowance',[account,p.address])]);if(b[0]<BigInt(filled)*p.ticketPrice)throw Object.assign(Error('INSUFFICIENT_BEM'),{code:'INSUFFICIENT_BEM'});
    if(context().key!==key)throw Object.assign(Error('CONTEXT_CHANGED'),{code:'CONTEXT_CHANGED'});
    render();if(al[0]<BigInt(filled)*p.ticketPrice){const hash=await manager.execute({poolId:id,method:'approve',args:[p.address,BigInt(s.count)*p.ticketPrice],kind:'approve'});await waitReceipt(hash,key);}
    if(context().key!==key)throw Object.assign(Error('CONTEXT_CHANGED'),{code:'CONTEXT_CHANGED'});
    await manager.execute({poolId:id,method:s.tickets?'buySelected':'buy',args:[current,s.tickets||s.count],kind:'buy',roundId:current,count:s.count});note(t('购买已提交，正在等待确认。','Purchase submitted; awaiting confirmation.'));
  }catch(e){failure(e);}finally{flow=false;render();}}
async function action(id,method,args){if(!['claimPrizes','refundMany','burnUnclaimedPrize','burnUnclaimed'].includes(method))throw Error('BACKEND_DRAW_ONLY');if(!account)return picker.open();await manager.execute({poolId:id,method,args,kind:method,roundId:Array.isArray(args[0])?0:args[0]});render();}
function claimButton(r,id){const prize=r.prize,winner=prize?.winner||r.winner;let label=t('领取奖金','Claim prize');if(prize?.claimed)label=t('已领取','Claimed');else if(prize?.burned)label=t('已销毁','Burned');else if(chainNow()>=prize?.claimDeadline)label=t('领取期已结束','Claim window expired');
  const b=button(label,()=>{if(!account)return picker.open();if(account.toLowerCase()!==winner.toLowerCase())return note(t('请连接中奖钱包领取。','Connect the winning wallet to claim.'));return action(id,'claimPrizes',[[r.roundId],account]);});b.disabled=!!prize?.claimed||!!prize?.burned||chainNow()>=prize?.claimDeadline||!!account&&account.toLowerCase()!==winner?.toLowerCase();return b;}
function renderRefund(){
  const group=refundData?.account===account?refundData.groups.find(g=>g.poolId===pool):null,b=$('refund');
  $('refund-amount').textContent=group?money(group.refundablePrincipal)+' BEM':'— BEM';
  b.disabled=false;
  if(!account){b.textContent=t('连接钱包查询退款','Connect wallet to find refunds');$('refund-state').textContent=t('连接后自动查询，无需输入期号。','Refunds are found automatically after connecting.');return;}
  if(chain!==56){b.textContent=t('切换 BNB 主网','Switch to BNB Chain');$('refund-state').textContent=t('请切换到 BNB 主网领取本金。','Switch to BNB Chain to claim.');return;}
  if(!group){b.disabled=!refundError;b.textContent=refundError?t('重新查询退款','Retry refund lookup'):t('正在查询退款…','Finding refunds…');$('refund-state').textContent=refundError?t('暂时未能读取，正在自动重试。','Lookup unavailable; retrying automatically.'):t('正在查询本钱包在当前场次的全部可退本金。','Finding all refundable rounds for this wallet in this pool.');return;}
  const pending=group.refunds.length&&manager.blocked({poolId:pool,method:'refundMany',args:[group.refunds,account]});
  b.disabled=refundFlow||manager.busy||!!pending||!group.refunds.length;
  b.textContent=refundFlow?t('等待钱包确认…','Waiting for wallet…'):pending?t('领取已提交，等待确认','Claim submitted; awaiting confirmation'):group.refundCount>F.refundBatchLimit?t('领取本批本金（{n}期）','Claim this batch ({n} rounds)',{n:group.refunds.length}):group.refunds.length?t('领取全部本金','Claim all principal'):t('暂无可领取本金','No principal to claim');
  $('refund-state').textContent=group.refunds.length?t('当前场次共 {n} 期可退，本金退回当前钱包。','{n} refundable rounds in this pool. Principal returns to your wallet.',{n:group.refundCount}):t('当前场次暂无已确认的可退本金，连接后会自动更新。','No confirmed refundable principal in this pool. Updates automatically.');
  if(group.refundCount>F.refundBatchLimit)$('refund-state').textContent+=t(' 本次合并 {n} 期，金额 {amount} BEM；余下可继续领取。',' This batch claims {n} rounds ({amount} BEM); claim the remainder afterward.',{n:group.refunds.length,amount:money(group.refundBatchAmount)});
}
async function claimRefunds(){
  if(refundFlow)return;if(!account)return picker.open();
  if(chain!==56)return wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});
  const target=account,id=pool,version=revision;refundFlow=true;renderRefund();
  try{
    const data=await queryRecords('wallet',{pool:id,address:target});
    if(version!==revision||target!==account||id!==pool)throw Object.assign(Error('CONTEXT_CHANGED'),{code:'CONTEXT_CHANGED'});
    const group=data.claims?.find(g=>g.poolId===id);refundData={account:target,groups:data.claims||[]};refundError=false;
    if(!group?.refunds.length)return;
    await action(id,'refundMany',[group.refunds,target]);await refreshRecords();
  }catch(e){refundError=true;throw e;}finally{refundFlow=false;renderRefund();}
}
async function queryRecords(kind,filter={}){return api('/api/sparkdraw/records?'+new URLSearchParams({kind,...filter}));}
function roundCard(r,personal=false){const card=el('article','');card.className='scope-note';card.append(el('h3',`${r.poolId} BEM · `+roundName(r)));
  if(r.status===5){card.append(el('p',t('中奖号码：','Winning number: ')+String(r.winningTicket+1).padStart(5,'0')),links('address',r.winner));if(r.prize){card.append(el('p',t('奖金：','Prize: ')+money(r.prize.amount)+' BEM'),claimButton(r,r.poolId));if(!r.prize.claimed&&!r.prize.burned){const timer=el('p','');countdown(timer,r.prize.claimDeadline);card.append(timer);}}}
  if(personal){card.append(el('p',t('购买 {n} 份 · {times} 次 · 实付 {amount} BEM','{n} tickets · {times} purchases · Paid {amount} BEM',{n:r.tickets,times:r.purchases.length,amount:money(r.paid)})));
    card.append(el('p',t('待退本金：{refund} BEM · 已销毁本金：{burn} BEM · 已销毁奖金：{prize} BEM','Refund available: {refund} BEM · Burned principal: {burn} BEM · Burned prize: {prize} BEM',{refund:money(r.refundablePrincipal),burn:burnMoney(r.burnedPrincipal),prize:burnMoney(r.burnedPrize)})));
    if(BigInt(r.refundablePrincipal)>0n&&account?.toLowerCase()===r.account.toLowerCase()){const timer=el('p','');countdown(timer,r.refundClaimDeadline);card.append(timer,button(t('领取本期本金','Claim this round’s refund'),()=>action(r.poolId,'refundMany',[[r.roundId],account])));}
    for(const purchase of r.purchases){card.append(links('tx',purchase.transactionHash,`${formatSiteTime(purchase.timeUtc,getLanguage())} · ${purchase.tickets} `+t('份','tickets')));card.append(el('br',''));}
    for(const burn of r.burns||[])card.append(links('tx',burn.transactionHash,t('查看已销毁交易','View burn transaction')));
  }
  if(r.settlementTransactionHash)card.append(links('tx',r.settlementTransactionHash,t('开奖交易','Settlement transaction')));return card;
}
function walletCards(container,rows,claims=[],owner=account){container.replaceChildren();
  for(const group of claims)for(const kind of ['refunds','prizes']){const ids=group[kind];if(!ids.length)continue;
    const b=button(t('{pool} BEM · 合并领取 {n} 期{type}','{pool} BEM · Claim {type} for {n} rounds',{pool:group.poolId,n:ids.length,type:kind==='refunds'?t('本金','refunds'):t('奖金','prizes')}),()=>action(group.poolId,kind==='refunds'?'refundMany':'claimPrizes',[ids,account]));
    b.disabled=!account||owner.toLowerCase()!==account.toLowerCase();container.append(b);
  }
  container.append(...rows.map(r=>roundCard(r,true)));if(!rows.length)container.append(el('p',t('此钱包暂无已确认记录。','No confirmed records for this wallet.')));
}
async function refreshRecords(){const version=++recordsVersion,id=pool,queriedAccount=account;const jobs=[];
  jobs.push(queryRecords('winners',{pool:id,page:historyPage}).then(d=>{if(version!==recordsVersion)return;$('history-list').replaceChildren(...d.rows.map(r=>roundCard(r)));$('history-summary').textContent=t('已确认 {n} 条中奖记录','{n} confirmed wins',{n:d.total});$('history-page').textContent=`${d.page} / ${d.totalPages}`;$('history-prev').disabled=d.page<=1;$('history-next').disabled=d.page>=d.totalPages;}));
  jobs.push(queryRecords('winners',{pool:'all'}).then(d=>{if(version!==recordsVersion)return;$('winner-ticker').replaceChildren(el('span',d.rows.length?d.rows.slice(0,5).map(r=>`${r.poolId} BEM · ${roundName(r)} · ${String(r.winningTicket+1).padStart(5,'0')} · ${r.winner}`).join('   |   '):t('等待首位中奖者 · 开奖后自动播报','Waiting for the first winner · Updates after settlement')));}));
  if(account){jobs.push(queryRecords('wallet',{pool:'all',address:account,page:burnWalletPage}).then(d=>{if(version!==recordsVersion)return;refundData={account:queriedAccount,groups:d.claims||[]};refundError=false;renderRefund();$('burn-wallet-status').textContent=account;walletCards($('burn-wallet-records'),d.rows,d.claims);const pager=el('p',`${d.page} / ${d.totalPages}`);if(d.page>1)pager.append(button(t('上一页','Previous'),()=>{burnWalletPage--;refreshRecords();}));if(d.page<d.totalPages)pager.append(button(t('下一页','Next'),()=>{burnWalletPage++;refreshRecords();}));$('burn-wallet-records').append(pager);}).catch(e=>{if(version===recordsVersion){refundError=true;renderRefund();}throw e;}));}else{$('burn-wallet-status').textContent=t('连接钱包自动查询待领取和已销毁记录。','Connect your wallet to view claims and burned balances.');$('burn-wallet-records').replaceChildren();}
  const a=$('personal-wallet').value.trim();if(/^0x[a-fA-F0-9]{40}$/.test(a))jobs.push(queryRecords('wallet',{pool:$('personal-pool').value,address:a,page:personalPage,...($('personal-round').value.trim()?{round:$('personal-round').value.trim()}:{})}).then(d=>{if(version!==recordsVersion)return;walletCards($('personal-list'),d.rows,d.claims,a);$('personal-status').textContent=t('已确认 {n} 期记录','{n} confirmed rounds',{n:d.total});$('personal-page').textContent=`${d.page} / ${d.totalPages}`;$('personal-prev').disabled=d.page<=1;$('personal-next').disabled=d.page>=d.totalPages;}));
  jobs.push(queryRecords('burns',{pool:$('burn-pool').value,page:burnPage}).then(d=>{if(version!==recordsVersion)return;$('burn-records').replaceChildren(...d.rows.map(r=>{const card=el('p',`${r.poolId} BEM · ${roundName(r)} · ${burnMoney(r.amountBaseUnits)} BEM · ${formatSiteTime(r.timeUtc,getLanguage())} `);card.append(links('tx',r.transactionHash));return card;}));$('burn-status').textContent=t('已确认 {n} 笔销毁','{n} confirmed burns',{n:d.total});$('burn-page').textContent=`${d.page} / ${d.totalPages}`;$('burn-prev').disabled=d.page<=1;$('burn-next').disabled=d.page>=d.totalPages;}));
  for(const kind of ['prizes','refunds'])jobs.push(queryRecords(kind,{pool:'all'}).then(d=>{if(version!==recordsVersion)return;const box=$(kind==='prizes'?'pending-prizes':'pending-refunds');box.replaceChildren(...d.rows.map(r=>{const card=el('article',`${r.poolId} BEM · ${roundName(r)} · ${money(r.amountBaseUnits)} BEM`);card.className='scope-note';card.append(el('p',r.account||r.winner));const timer=el('p','');countdown(timer,r.claimDeadline);card.append(timer);if(kind==='prizes')card.append(claimButton({...r,prize:{amount:r.amountBaseUnits,claimDeadline:r.claimDeadline,winner:r.winner}},r.poolId));else card.append(el('p',`${r.tickets} `+t('份','tickets')));if(chainNow()>=r.claimDeadline)card.append(button(t('销毁已过期余额','Burn expired balance'),()=>action(r.poolId,kind==='prizes'?'burnUnclaimedPrize':'burnUnclaimed',[r.roundId])));return card;}));if(!d.rows.length)box.append(el('p',t('暂无待公示记录。','No pending notices.')));}));
  for(const r of await Promise.allSettled(jobs))if(r.status==='rejected'){$('personal-status').textContent=t('记录同步中，请稍后刷新。','Records are syncing. Refresh shortly.');}
}
async function burnSummary(){try{const d=await api('/api/burns/summary');$('burn-total').textContent=burnMoney(d.totalBaseUnits);$('burn-summary-status').textContent=t('更新于 ','Updated ')+formatSiteTime(d.updatedAt,getLanguage());}catch{$('burn-summary-status').textContent=t('统计读取失败，稍后重试。','Summary unavailable; retrying.');}}
function switchTab(next){tab=['draw','proof','burns','mine'].includes(next)?next:'draw';for(const id of ['draw','proof','burns','mine']){$('panel-'+id).hidden=id!==tab;$('tab-'+id).setAttribute('aria-selected',String(id===tab));}document.body.dataset.activeTab=tab;if(tab==='draw')renderDraw();url.hash=tab;history.replaceState(null,'',url);refreshRecords();}
for(const id of ['draw','proof','burns','mine'])$('tab-'+id).onclick=e=>{e.preventDefault();switchTab(id);};
for(const id of ['auto','selected'])$('mode-'+id).onclick=()=>{mode=id;revision++;render();};
for(const id of ['ticket-count','selected-tickets'])$(id).oninput=()=>{revision++;render();};
for(const b of document.querySelectorAll('[data-count]'))b.onclick=()=>{$('ticket-count').value=b.dataset.count;revision++;render();};
$('buy').onclick=buy;$('check-transactions').onclick=()=>poll(true);$('attach-test-hash').onclick=async()=>{try{await manager.attach($('unknown-test-hash').value.trim());refresh();refreshRecords();}catch(e){failure(e);}};
$('refresh-history').onclick=refreshRecords;$('burn-refresh').onclick=()=>{refreshRecords();burnSummary();};$('burn-pool').onchange=()=>{burnPage=1;refreshRecords();};
$('personal-search').onclick=()=>{personalPage=1;refreshRecords();};$('personal-pool').onchange=()=>{personalPage=1;refreshRecords();};
for(const type of ['history','burn','personal'])for(const dir of ['prev','next'])$(type+'-'+dir).onclick=()=>{const step=dir==='prev'?-1:1;if(type==='history')historyPage+=step;else if(type==='burn')burnPage+=step;else personalPage+=step;refreshRecords();};
$('refund').onclick=()=>claimRefunds().catch(failure);
$('replay').onclick=()=>{if(activeResult)revealReels(activeResult,true);};
window.addEventListener('bem:languagechange',()=>{note(translateKnown($('notice').textContent));render();refreshRecords();burnSummary();});
initLanguage();render();switchTab(tab);refresh();burnSummary();
setInterval(()=>{$('site-time').textContent=formatSiteTime(chainNow(),getLanguage());document.querySelectorAll('[data-deadline]').forEach(n=>countdown(n,Number(n.dataset.deadline)));},1000);
setInterval(()=>{if(!document.hidden){refresh();if(!flow)poll();}},2000);setInterval(()=>{if(!document.hidden)refreshRecords();},10000);setInterval(burnSummary,300000);
