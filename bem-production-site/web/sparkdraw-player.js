import {formatUnits,formatEther,getAddress} from 'ethers';
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
const context=()=>({account,key:JSON.stringify([revision,account,pool,chain,mode,$('ticket-count').value,$('selected-tickets').value])});
const note=x=>{$('notice').textContent=x;};
async function api(path,body){const r=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(15000),...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});let d;try{d=await r.json();}catch{throw Error(t('服务暂时无法响应，正在自动重试。','Service temporarily unavailable; retrying.'));}if(!r.ok)throw Error(d.error||'Network unavailable');return d;}
const rpc=async(method,params)=>{const d=await api('/rpc',{jsonrpc:'2.0',id:++serial,method,params});if(d.error)throw Error(d.error.message);return d.result;};
const call=async(iface,to,name,args)=>iface.decodeFunctionResult(name,await rpc('eth_call',[{to,data:iface.encodeFunctionData(name,args)},'latest']));
const manager=createSparkDrawTransactions({rpc,wallet:()=>wallet,context,onChange:()=>renderPending()});
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
function selection(){return parseTickets(mode,$('ticket-count').value,$('selected-tickets').value);}
function render(){
  const p=profile(pool),r=snapshot?.rounds.find(x=>x.roundId===snapshot.currentRoundId),gross=BigInt(p.units),prize=gross*(99n-BigInt(p.burnPercent))/100n;
  $('connect-wallet').textContent=account?t('切换钱包','Switch wallet'):t('连接钱包','Connect wallet');
  $('wallet-label').textContent=account?t('已连接钱包','Wallet connected'):t('连接钱包，查看余额与持票','Connect wallet to view balances and tickets');$('wallet-address').textContent=account||'';
  $('wallet-balances').textContent=balance?`BEM ${money(balance.bem)} · BNB ${formatEther(balance.bnb)}`:'BEM — · BNB —';$('switch-network').hidden=!wallet||chain===56;
  $('launch-status').textContent=t('新五档合约已部署','Five new pools deployed');$('sale-note').textContent=p.test?t('0.1 BEM 测试场，使用 BNB 主网真实 BEM。','0.1 BEM test with real BEM on BNB mainnet.'):t('首次购买开始 24 小时募集。','The first purchase starts the 24-hour funding period.');
  $('prize-bem').textContent=money(prize);$('payout-burn').textContent=money(gross*BigInt(p.burnPercent)/100n)+' BEM';$('payout-container').textContent=money(gross/100n)+' BEM';$('payout-winner').textContent=money(prize)+' BEM';
  $('community-copy').textContent=t('每次成功开奖，实收金额的 {burn}% 转入销毁地址，1% 进入容器，其余为中奖奖金。','Each completed draw burns {burn}% of actual receipts, sends 1% to the container and reserves the remainder for the winner.',{burn:p.burnPercent});
  $('community-allocation').textContent=t('收款固定进入 13061 容器，用于社区运营与维护；按实际售出份数分配。','Revenue goes to container 13061 for community operations; allocation uses the actual tickets sold.');
  $('purchase-rules').textContent=t('每份 {unit} BEM · 00001–10000 · 单笔及单钱包每期最多 5,000 份','{unit} BEM per ticket · 00001–10000 · Maximum 5,000 per transaction and wallet per round',{unit:money(p.ticketPrice)});
  $('rule-funding').textContent=t('售出 9,500 份启动一次性 30 分钟倒计时，满额提前封盘；到期按实售份额开奖，最晚不超过原 24 小时募集期限。','9,500 sold starts a single 30-minute countdown. Sellout closes early. The deadline never exceeds the original 24-hour funding window.');
  $('rule-refunds').textContent=t('未封盘超过 24 小时，或封盘后 24 小时未完成开奖，开放 24 小时退款期。奖金也须在结算后 24 小时内领取，过期余额可通过链上交易销毁。','Unsealed funding after 24 hours, or a draw unfinished for 24 hours after closing, opens a 24-hour refund window. Prizes have a 24-hour claim window after settlement. Expired balances can be burned onchain.');
  $('footer-rules').textContent=t('每期 10,000 份 · 单笔最多 5,000 份','10,000 tickets per round · Up to 5,000 per purchase');
  $('mode-auto').setAttribute('aria-pressed',String(mode==='auto'));$('mode-selected').setAttribute('aria-pressed',String(mode==='selected'));$('auto-fields').hidden=mode!=='auto';$('selected-fields').hidden=mode!=='selected';
  let valid=true;try{const s=selection();$('purchase-total').textContent=money(BigInt(s.count)*p.ticketPrice)+' BEM';$('selection-note').textContent=t('申请 {count} 份，仅按实际分配份数扣款。','Requesting {count} tickets; only allocated tickets are charged.',{count:s.count});}catch{valid=false;$('purchase-total').textContent='— BEM';}
  const now=chainNow(),open=r&&(r.status===0||r.status===1&&now<Math.min(r.fundingDeadline,r.earlyDrawDeadline||Infinity));
  $('buy').disabled=!!account&&(!valid||!open||chain!==56||flow||manager.busy||!!manager.pending);
  $('buy').textContent=flow?t('等待钱包与链上确认…','Waiting for wallet / confirmation…'):!account?t('连接钱包并购买','Connect wallet to buy'):t('授权并购买','Approve & buy');
  $('purchase-state').textContent=!account?t('点击购买会连接钱包。','Click buy to connect your wallet.'):manager.pending?t('交易已提交，正在更新状态。','Transaction submitted; updating status.'):!open?t('读取状态中，或本期购买时间已结束。','Loading state, or sales for this round have ended.'):t('本钱包本期还可购买 {count} 份。','This wallet may buy {count} more tickets this round.',{count:String(5000n-held)});
  $('my-count').textContent=account?String(held):'—';
  $('round-label').textContent=`${pool} BEM · `+t('第 {round} 期','Round {round}',{round:r?.roundId||1});
  $('round-phase').textContent=r?statusText(r.status):t('读取中','Loading');$('funding-amount').textContent=`${money(BigInt(r?.sold||0)*p.ticketPrice)} / ${pool} BEM`;$('funding-tickets').textContent=`${r?.sold||0} / 10,000`;$('funding-progress').firstElementChild.style.width=((r?.sold||0)/100)+'%';
  $('contract-links').replaceChildren(...[[t('场次合约','Pool contract'),p.address],['BEM',F.bem],[t('收款容器','Revenue container'),F.revenue],[t('随机数验证合约','Randomness verifier'),VERIFIER],[t('开奖处理器','Draw processor'),'0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C']].flatMap(([label,address])=>{const dd=el('dd','');dd.append(links('address',address));return[el('dt',label),dd];}));
  $('snapshot-label').textContent=snapshot?t('已核验 · 区块 {block}','Verified · Block {block}',{block:snapshot.blockNumber}):'';
  window.dispatchEvent(new CustomEvent('bem:poolchange',{detail:{pool:{winnerBaseUnits:prize.toString()}}}));
  renderDraw();renderPending();renderSelector();
}
const statusText=n=>[t('首次购买即开盘','Starts with first purchase'),t('购买中','Open'),t('已封盘','Closed'),t('等待随机数','Awaiting randomness'),t('等待计算结算','Awaiting settlement'),t('已开奖','Settled'),t('退款中','Refunding')][n];
const chainNow=()=>snapshot?snapshot.time+Math.floor((Date.now()-snapshot.receivedAt)/1000):Math.floor(Date.now()/1000);
function countdown(node,deadline){node.dataset.deadline=String(deadline);const left=Math.max(0,deadline-chainNow());node.textContent=left?[Math.floor(left/3600),Math.floor(left%3600/60),left%60].map(n=>String(n).padStart(2,'0')).join(':'):t('已到期','Expired');}
function renderDraw(){
  const current=snapshot?.rounds[0],prior=snapshot?.rounds[1],draw=prior&&[3,4,5].includes(prior.status)?prior:current;$('countdown-panel').hidden=false;
  const deadline=draw&&[3,4].includes(draw.status)?draw.beaconAvailableAt:current?.earlyDrawDeadline||current?.fundingDeadline;
  $('countdown-label').textContent=draw&&[3,4].includes(draw.status)?t('随机数可提交倒计时','Randomness available in'):t('本期募集倒计时','Funding countdown');
  if(deadline)countdown($('countdown-value'),deadline);else{$('countdown-value').textContent='—';delete $('countdown-value').dataset.deadline;}
  $('countdown-note').textContent=draw&&[3,4].includes(draw.status)?t('随机数到时后可提交证明，再执行结算；链上确认时间会影响实际开奖时间。','Submit the beacon proof when available, then settle. Chain confirmation affects completion time.'):t('首次购买开始计时；到期操作仍需提交链上交易。','Timing starts with the first purchase. Deadline actions require an onchain transaction.');
  const win=draw?.status===5?draw:null;activeResult=win;
  revealReels(win);
  $('reel-caption').textContent=draw?t('第 {round} 期 · {status}','Round {round} · {status}',{round:draw.roundId,status:statusText(draw.status)}):'';
  $('reel-message').replaceChildren(win?links('address',win.winner,t('中奖钱包：','Winner: ')+win.winner):el('span',t('尚未产生中奖号码。','No winning number yet.')));$('replay').disabled=!win;
  const actions=$('draw-actions');actions.replaceChildren();const now=chainNow();
  for(const r of snapshot?.rounds||[]){const trigger=r.drawDeadline||r.fundingDeadline;
    if([1,2,3,4].includes(r.status)&&trigger&&now>=trigger){actions.append(button(t('开放第 {r} 期退款','Open refunds for round {r}',{r:r.roundId}),()=>action(pool,'openRefunds',[r.roundId])));continue;}
    if(r.status===1&&r.sold>=9500&&r.earlyDrawDeadline&&now>=r.earlyDrawDeadline)actions.append(button(t('封盘并准备开奖','Close sales for draw'),()=>action(pool,'closeRound',[r.roundId])));
    if(r.status===3&&now>=r.beaconAvailableAt)actions.append(button(t('提交随机数证明','Submit randomness proof'),async()=>{if(!account)return picker.open();const proof=await api(`/api/sparkdraw/beacon?pool=${pool}&round=${r.roundId}`);await action(pool,'fulfillRandomness',[r.roundId,proof.signature]);}));
    if(r.status===4)actions.append(button(t('执行开奖结算','Settle draw'),()=>action(pool,'settle',[r.roundId])));
    if(r.status===5&&r.prize.amount!=='0'&&!r.prize.claimed&&!r.prize.burned)actions.append(claimButton({...r,prize:{...r.prize,winner:r.winner}},pool));
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
    reel.querySelector('.reel-strip').replaceChildren();reel.classList.remove('rolling');
  }
  $('reels').setAttribute('aria-label',win?t('中奖号码 {number}','Winning number {number}',{number:digits}):t('尚未开奖','Awaiting draw'));
  if(!win||reelRevealed||!$('reels').getClientRects().length||document.hidden)return;
  reelRevealed=true;
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const generation=reelGeneration;
  for(const [i,reel] of reels.entries()){
    const strip=reel.querySelector('.reel-strip'),placeholder=reel.querySelector('.placeholder');
    const steps=30+i*10+Number(digits[i]);
    strip.replaceChildren(...Array.from({length:steps+1},(_,n)=>el('span',String(n%10))));
    strip.setAttribute('aria-hidden','true');placeholder.hidden=true;reel.classList.add('rolling');
    const animation=strip.animate([{transform:'translateY(0)'},{transform:`translateY(-${steps*100}%)`}],
      {duration:2200+i*380,easing:'cubic-bezier(.12,.64,.18,1)',fill:'forwards'});
    reelAnimations.push(animation);
    animation.finished.then(()=>{
      if(generation!==reelGeneration)return;
      placeholder.textContent=digits[i];placeholder.hidden=false;reel.classList.remove('rolling');
      animation.cancel();strip.replaceChildren();
    }).catch(()=>{});
  }
}
function renderSelector(){const list=$('pool-selection');list.className='pool-selection';list.replaceChildren(el('h3',t('选择场次','Choose pool')));const group=el('div','');group.className='pool-selection-options';for(const id of POOL_IDS){const b=button(`${id} BEM${id==='0.1'?t(' · 测试',' · Test'):''}`,()=>{if(pool===id)return;pool=id;revision++;snapshot=null;held=0n;historyPage=1;url.searchParams.set('pool',id);history.replaceState(null,'',url);render();refresh();refreshRecords();});b.className='pool-choice';b.setAttribute('aria-checked',String(id===pool));b.setAttribute('role','radio');group.append(b);}list.append(group);}
async function refresh(){if(loading)return;loading=true;const id=pool,rev=revision;
  try{const s=await api('/api/sparkdraw/state?pool='+id);if(s.version!==5||s.address.toLowerCase()!==profile(id).address.toLowerCase())throw Error('Contract mismatch');if(id!==pool||rev!==revision)return;snapshot={...s,receivedAt:Date.now()};
    if(account&&chain===56){const a=account,p=profile(id);const[b,al,native,tickets]=await Promise.all([call(TOKEN,F.bem,'balanceOf',[a]),call(TOKEN,F.bem,'allowance',[a,p.address]),rpc('eth_getBalance',[a,'latest']),call(GAME,p.address,'ticketsOf',[s.currentRoundId,a])]);if(id!==pool||rev!==revision)return;balance={bem:b[0],bnb:BigInt(native)};allowance=al[0];held=tickets[0];}
    render();
  }catch(e){if(id===pool&&rev===revision){snapshot=null;render();failure(e);}}finally{loading=false;}
}
function renderPending(){const p=manager.pending;$('transactions').hidden=!p;$('transaction-list').replaceChildren();if(p){$('transaction-list').append(el('p',p.hash?t('已提交，每 2 秒查询确认结果。','Submitted; checking every 2 seconds.'):t('钱包尚未返回交易哈希，请查看钱包活动并填写哈希恢复。','No transaction hash returned. Check wallet activity and restore the hash.')));if(p.hash)$('transaction-list').append(links('tx',p.hash));}$('unknown-test-transaction').hidden=!p||!!p.hash;}
function partial(result){if(!result?.result||result.result.filled>=result.result.requested)return;const r=result.result,dialog=el('dialog','');dialog.className='partial-fill-result';dialog.append(el('h2',t('部分购买成功','Partial purchase completed')),el('p',t('申请 {a} 份，成交 {b} 份；实际扣款 {c} BEM，其余 {d} BEM 未扣除。','Requested {a}, filled {b}; paid {c} BEM. The remaining {d} BEM was not charged.',{a:r.requested,b:r.filled,c:money(r.paid),d:money(r.unspent)})),button(t('知道了','OK'),()=>dialog.close()));document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();}
async function poll(){try{const r=await manager.check();if(r){note(r.status==='confirmed'?t('交易已确认。','Transaction confirmed.'):t('交易未成功，请查看链上回执。','Transaction reverted. See the receipt.'));partial(r);refresh();refreshRecords();return r;}}catch(e){failure(e);}return null;}
async function waitReceipt(hash,key){for(let i=0;i<30;i++){if(context().key!==key)throw Object.assign(Error('CONTEXT_CHANGED'),{code:'CONTEXT_CHANGED'});const r=await poll();if(r?.hash===hash){if(r.status!=='confirmed')throw Error('Transaction reverted');return;}if(!manager.pending){return;}await new Promise(resolve=>setTimeout(resolve,2000));}throw Object.assign(Error('TRANSACTION_PENDING'),{code:'TRANSACTION_PENDING'});}
async function buy(){if(!account)return picker.open();if(flow)return;flow=true;const key=context().key,id=pool;try{
    const s=selection(),p=profile(id),current=(await call(GAME,p.address,'currentRoundId',[]))[0],r=await call(GAME,p.address,'rounds',[current]),tickets=(await call(GAME,p.address,'ticketsOf',[current,account]))[0];
    const filled=Math.min(s.count,10000-Number(r[1]),5000-Number(tickets));if(filled<=0)throw Object.assign(Error('ADDRESS_LIMIT'),{code:'ADDRESS_LIMIT'});
    const [b,al]=await Promise.all([call(TOKEN,F.bem,'balanceOf',[account]),call(TOKEN,F.bem,'allowance',[account,p.address])]);if(b[0]<BigInt(filled)*p.ticketPrice)throw Object.assign(Error('INSUFFICIENT_BEM'),{code:'INSUFFICIENT_BEM'});
    if(context().key!==key)throw Object.assign(Error('CONTEXT_CHANGED'),{code:'CONTEXT_CHANGED'});
    render();if(al[0]<BigInt(filled)*p.ticketPrice){const hash=await manager.execute({poolId:id,method:'approve',args:[p.address,BigInt(s.count)*p.ticketPrice],kind:'approve'});await waitReceipt(hash,key);}
    if(context().key!==key)throw Object.assign(Error('CONTEXT_CHANGED'),{code:'CONTEXT_CHANGED'});
    await manager.execute({poolId:id,method:s.tickets?'buySelected':'buy',args:[current,s.tickets||s.count],kind:'buy',roundId:current,count:s.count});note(t('购买已提交，正在等待确认。','Purchase submitted; awaiting confirmation.'));
  }catch(e){failure(e);}finally{flow=false;render();}}
async function action(id,method,args){if(!account)return picker.open();await manager.execute({poolId:id,method,args,kind:method,roundId:Array.isArray(args[0])?0:args[0]});render();}
function claimButton(r,id){const prize=r.prize,winner=prize?.winner||r.winner;let label=t('领取奖金','Claim prize');if(prize?.claimed)label=t('已领取','Claimed');else if(prize?.burned)label=t('已销毁','Burned');else if(chainNow()>=prize?.claimDeadline)label=t('领取期已结束','Claim window expired');
  const b=button(label,()=>{if(!account)return picker.open();if(account.toLowerCase()!==winner.toLowerCase())return note(t('请连接中奖钱包领取。','Connect the winning wallet to claim.'));return action(id,'claimPrizes',[[r.roundId],account]);});b.disabled=!!prize?.claimed||!!prize?.burned||chainNow()>=prize?.claimDeadline||!!account&&account.toLowerCase()!==winner?.toLowerCase();return b;}
async function queryRecords(kind,filter={}){return api('/api/sparkdraw/records?'+new URLSearchParams({kind,...filter}));}
function roundCard(r,personal=false){const card=el('article','');card.className='scope-note';card.append(el('h3',`${r.poolId} BEM · `+t('第 {r} 期','Round {r}',{r:r.roundId})));
  if(r.status===5){card.append(el('p',t('中奖号码：','Winning number: ')+String(r.winningTicket+1).padStart(5,'0')),links('address',r.winner));if(r.prize){card.append(el('p',t('奖金：','Prize: ')+money(r.prize.amount)+' BEM'),claimButton(r,r.poolId));if(!r.prize.claimed&&!r.prize.burned){const timer=el('p','');countdown(timer,r.prize.claimDeadline);card.append(timer);}}}
  if(personal){card.append(el('p',t('购买 {n} 份 · {times} 次 · 实付 {amount} BEM','{n} tickets · {times} purchases · Paid {amount} BEM',{n:r.tickets,times:r.purchases.length,amount:money(r.paid)})));
    card.append(el('p',t('待退本金：{refund} BEM · 已销毁本金：{burn} BEM · 已销毁奖金：{prize} BEM','Refund available: {refund} BEM · Burned principal: {burn} BEM · Burned prize: {prize} BEM',{refund:money(r.refundablePrincipal),burn:burnMoney(r.burnedPrincipal),prize:burnMoney(r.burnedPrize)})));
    if(BigInt(r.refundablePrincipal)>0n&&account?.toLowerCase()===r.account.toLowerCase()){const timer=el('p','');countdown(timer,r.refundClaimDeadline);card.append(timer,button(t('领取本期本金','Claim this round’s refund'),()=>action(r.poolId,'refundMany',[[r.roundId],account])));}
    for(const purchase of r.purchases){card.append(links('tx',purchase.transactionHash,`${purchase.timeUtc} · ${purchase.tickets} `+t('份','tickets')));card.append(el('br',''));}
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
async function refreshRecords(){const version=++recordsVersion,id=pool;const jobs=[];
  jobs.push(queryRecords('winners',{pool:id,page:historyPage}).then(d=>{if(version!==recordsVersion)return;$('history-list').replaceChildren(...d.rows.map(r=>roundCard(r)));$('history-summary').textContent=t('已确认 {n} 条中奖记录','{n} confirmed wins',{n:d.total});$('history-page').textContent=`${d.page} / ${d.totalPages}`;$('history-prev').disabled=d.page<=1;$('history-next').disabled=d.page>=d.totalPages;}));
  jobs.push(queryRecords('winners',{pool:'all'}).then(d=>{if(version!==recordsVersion)return;$('winner-ticker').replaceChildren(el('span',d.rows.length?d.rows.slice(0,5).map(r=>`${r.poolId} BEM #${r.roundId} · ${String(r.winningTicket+1).padStart(5,'0')} · ${r.winner}`).join('   |   '):t('等待首位中奖者 · 开奖后自动播报','Waiting for the first winner · Updates after settlement')));}));
  if(account){jobs.push(queryRecords('wallet',{pool:'all',address:account,page:burnWalletPage}).then(d=>{if(version!==recordsVersion)return;$('burn-wallet-status').textContent=account;walletCards($('burn-wallet-records'),d.rows,d.claims);const pager=el('p',`${d.page} / ${d.totalPages}`);if(d.page>1)pager.append(button(t('上一页','Previous'),()=>{burnWalletPage--;refreshRecords();}));if(d.page<d.totalPages)pager.append(button(t('下一页','Next'),()=>{burnWalletPage++;refreshRecords();}));$('burn-wallet-records').append(pager);}));}else{$('burn-wallet-status').textContent=t('连接钱包自动查询待领取和已销毁记录。','Connect your wallet to view claims and burned balances.');$('burn-wallet-records').replaceChildren();}
  const a=$('personal-wallet').value.trim();if(/^0x[a-fA-F0-9]{40}$/.test(a))jobs.push(queryRecords('wallet',{pool:$('personal-pool').value,address:a,page:personalPage,...($('personal-round').value.trim()?{round:$('personal-round').value.trim()}:{})}).then(d=>{if(version!==recordsVersion)return;walletCards($('personal-list'),d.rows,d.claims,a);$('personal-status').textContent=t('已确认 {n} 期记录','{n} confirmed rounds',{n:d.total});$('personal-page').textContent=`${d.page} / ${d.totalPages}`;$('personal-prev').disabled=d.page<=1;$('personal-next').disabled=d.page>=d.totalPages;}));
  jobs.push(queryRecords('burns',{pool:$('burn-pool').value,page:burnPage}).then(d=>{if(version!==recordsVersion)return;$('burn-records').replaceChildren(...d.rows.map(r=>{const card=el('p',`${r.poolId} BEM #${r.roundId} · ${burnMoney(r.amountBaseUnits)} BEM · ${r.timeUtc} `);card.append(links('tx',r.transactionHash));return card;}));$('burn-status').textContent=t('已确认 {n} 笔销毁','{n} confirmed burns',{n:d.total});$('burn-page').textContent=`${d.page} / ${d.totalPages}`;$('burn-prev').disabled=d.page<=1;$('burn-next').disabled=d.page>=d.totalPages;}));
  for(const kind of ['prizes','refunds'])jobs.push(queryRecords(kind,{pool:'all'}).then(d=>{if(version!==recordsVersion)return;const box=$(kind==='prizes'?'pending-prizes':'pending-refunds');box.replaceChildren(...d.rows.map(r=>{const card=el('article',`${r.poolId} BEM #${r.roundId} · ${money(r.amountBaseUnits)} BEM`);card.className='scope-note';card.append(el('p',r.account||r.winner));const timer=el('p','');countdown(timer,r.claimDeadline);card.append(timer);if(kind==='prizes')card.append(claimButton({...r,prize:{amount:r.amountBaseUnits,claimDeadline:r.claimDeadline,winner:r.winner}},r.poolId));else card.append(el('p',`${r.tickets} `+t('份','tickets')));if(chainNow()>=r.claimDeadline)card.append(button(t('销毁已过期余额','Burn expired balance'),()=>action(r.poolId,kind==='prizes'?'burnUnclaimedPrize':'burnUnclaimed',[r.roundId])));return card;}));if(!d.rows.length)box.append(el('p',t('暂无待公示记录。','No pending notices.')));}));
  for(const r of await Promise.allSettled(jobs))if(r.status==='rejected'){$('personal-status').textContent=t('记录同步中，请稍后刷新。','Records are syncing. Refresh shortly.');}
}
async function burnSummary(){try{const d=await api('/api/burns/summary');$('burn-total').textContent=burnMoney(d.totalBaseUnits);$('burn-summary-status').textContent=t('更新于 ','Updated ')+new Date(d.updatedAt).toLocaleString();}catch{$('burn-summary-status').textContent=t('统计读取失败，稍后重试。','Summary unavailable; retrying.');}}
function switchTab(next){tab=['draw','proof','burns','mine'].includes(next)?next:'draw';for(const id of ['draw','proof','burns','mine']){$('panel-'+id).hidden=id!==tab;$('tab-'+id).setAttribute('aria-selected',String(id===tab));}document.body.dataset.activeTab=tab;if(tab==='draw')renderDraw();url.hash=tab;history.replaceState(null,'',url);refreshRecords();}
for(const id of ['draw','proof','burns','mine'])$('tab-'+id).onclick=e=>{e.preventDefault();switchTab(id);};
for(const id of ['auto','selected'])$('mode-'+id).onclick=()=>{mode=id;revision++;render();};
for(const id of ['ticket-count','selected-tickets'])$(id).oninput=()=>{revision++;render();};
for(const b of document.querySelectorAll('[data-count]'))b.onclick=()=>{$('ticket-count').value=b.dataset.count;revision++;render();};
$('buy').onclick=buy;$('check-transactions').onclick=poll;$('attach-test-hash').onclick=async()=>{try{await manager.attach($('unknown-test-hash').value.trim());refresh();refreshRecords();}catch(e){failure(e);}};
$('refresh-history').onclick=refreshRecords;$('burn-refresh').onclick=()=>{refreshRecords();burnSummary();};$('burn-pool').onchange=()=>{burnPage=1;refreshRecords();};
$('personal-search').onclick=()=>{personalPage=1;refreshRecords();};$('personal-pool').onchange=()=>{personalPage=1;refreshRecords();};
for(const type of ['history','burn','personal'])for(const dir of ['prev','next'])$(type+'-'+dir).onclick=()=>{const step=dir==='prev'?-1:1;if(type==='history')historyPage+=step;else if(type==='burn')burnPage+=step;else personalPage+=step;refreshRecords();};
$('check-refund').disabled=false;$('check-refund').onclick=async()=>{if(!account)return picker.open();try{const rid=$('refund-round').value.trim();if(!/^[1-9][0-9]*$/.test(rid))throw Error('Invalid round');const amount=(await call(GAME,profile(pool).address,'refundablePrincipal',[rid,account]))[0];$('refund-amount').textContent=money(amount)+' BEM';$('refund').disabled=amount===0n;$('refund-state').textContent=t('领取金额以链上执行时为准。','The claim amount is determined onchain.');}catch(e){failure(e);}};
$('refund').onclick=()=>action(pool,'refundMany',[[$('refund-round').value.trim()],account]);
$('replay').onclick=()=>{if(activeResult)revealReels(activeResult,true);};
window.addEventListener('bem:languagechange',()=>{note(translateKnown($('notice').textContent));render();refreshRecords();burnSummary();});
initLanguage();render();switchTab(tab);refresh();burnSummary();
setInterval(()=>{document.querySelectorAll('[data-deadline]').forEach(n=>countdown(n,Number(n.dataset.deadline)));},1000);
setInterval(()=>{if(!document.hidden){refresh();if(!flow)poll();}},2000);setInterval(()=>{if(!document.hidden)refreshRecords();},10000);setInterval(burnSummary,300000);
