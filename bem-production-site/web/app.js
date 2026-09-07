import { Contract, JsonRpcProvider, formatUnits, getAddress, keccak256, toQuantity } from 'ethers';
import { t, getLocale, translateKnown, initLanguage } from './player-i18n.js';
import { createWalletPicker } from './wallet-picker.js';
import { enforcePurchaseGasBudget } from './purchase-gas-policy.js';
import { parseRefundRound, refundEligibility, createRefundIntent, assertRefundSnapshot } from './refund-guards.js';
import { createTransactionTracker, createTransactionRecord, restoreTransactionRecords, isTransactionBlocking } from './transaction-tracker.js';
import { PINNED, GuardError, same, validateManifest, createIntent, parseSelection, assertFixedSnapshot, assertPurchaseSnapshot, explorerLink } from './guards.js';

const $ = id => document.getElementById(id);
const state = {config:null, rpc:null, game:null, token:null, snapshot:null, fixed:false, account:null, wallet:null, walletChain:null, epoch:0, busy:false, refreshing:false, mode:'auto', wallets:new Map(), transactions:[], history:null, historyError:false, page:1, reveal:null, animating:false, receivedAt:0, refund:null, refundLoading:false, refundVersion:0, refundReceivedAt:0, tracker:null, polling:false};
const TX_KEY = 'bem2075-mainnet-public-transactions-v1';
const reviewedTransactions=new Set();
const transactionNeedsReview=record=>['unknown','unverified'].includes(record.status)||(['pending','confirming'].includes(record.status)&&!isTransactionBlocking(record,record.account));
const amounts = value => Number(formatUnits(value ?? 0n,8)).toLocaleString(getLocale(),{maximumFractionDigits:8});
const short = address => `${address.slice(0,8)}…${address.slice(-6)}`;
const displayTicket = value => String(Number(value)+1).padStart(5,'0');
const json = value => JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v,2);
const fixedFields = ['bem','organizer','CONTAINER','CIRCUITS','coordinator','AUTHORIZATION_NFT','AUTHORIZATION_TOKEN_ID','CIRCUIT_ID','TICKET_PRICE','TICKETS_PER_ROUND','MAX_TICKETS_PER_PURCHASE','ROUND_POOL','WINNER_AMOUNT','ORGANIZER_AMOUNT','BLACKHOLE_AMOUNT','BLACKHOLE','fundingWindow','NEXT_ROUND_DELAY','subscriptionId'];
const statuses = () => [t('待启动','Awaiting launch'),t('募集中','Open'),t('已封盘','Sales closed'),t('等待 VRF','Awaiting VRF'),t('等待结算','Awaiting settlement'),t('已结算','Settled'),t('可退款','Refunds available')];
function notice(message,error=false,passive=false) { if(passive&&state.noticePriority>=2)return;state.noticePriority=error?3:passive?1:2;$('notice').textContent=message; $('notice').classList.toggle('error-copy',error); }
function explanation(error) {
  const copy = {
    GAS_FEE_CAP_EXCEEDED:['本笔网络费用上限超过 0.001 BNB，未提交。请减少份数或等待网络费用下降。','The maximum network fee exceeds 0.001 BNB. Nothing was submitted. Reduce the quantity or wait for lower network fees.'],
    MANIFEST:['正式配置核验失败，交易已禁用。','Production configuration could not be verified. Transactions are disabled.'],
    IDENTITY:['链上合约或固定规则不匹配，交易已禁用。','The onchain contract or fixed rules do not match. Transactions are disabled.'],
    NOT_LAUNCHED:['正式合约已部署，待正式启动，暂不接受授权与购买。','The contract is deployed and awaiting launch. Approvals and purchases are currently unavailable.'],
    NETWORK:['请先切换到 BNB 主网（56）。','Switch to BNB Chain mainnet (56) first.'],
    WALLET:['请先连接您的浏览器钱包。','Connect your browser wallet first.'],
    WALLET_CHANGED:['钱包、网络或选号已改变，本次操作已取消，请重新检查。','The wallet, network, or selection changed. Review the details and try again.'],
    ROUND_CHANGED:['本期期号已改变，没有自动改投下一期，请重新选择。','The round changed. Your purchase was not moved to another round. Review your selection.'],
    ROUND_CLOSED:['本期未开售、已封盘或已到期，无法购买。','This round is not open, has filled, or has expired.'],
    TICKET_SOLD:['所选号码或剩余份数已变化，本次操作未提交，请重新选号。','Selected tickets or available capacity changed. Nothing was submitted; choose again.'],
    TICKET_LOOKUP:['号码归属暂时无法核实，请刷新后重试。','Ticket ownership could not be verified. Refresh and try again.'],
    TICKET_LIMIT:['单笔请选择 1–500 份。','Choose between 1 and 500 tickets per purchase.'],
    TICKET_RANGE:['票号范围为 1–10000，号段起点不能大于终点。','Tickets range from 1 to 10000. A range must start with its smaller number.'],
    TICKET_FORMAT:['请用逗号分隔号码，连续号段如 100-110。','Use comma-separated numbers or ranges such as 100-110.'],
    NO_TICKETS:['请输入您要选择的票号。','Enter the ticket numbers you want.'],
    BALANCE:['BEM 余额不足。','Your BEM balance is insufficient.'],
    ALLOWANCE:['授权额度必须与本次金额一致，请先单独授权本次金额。','The allowance must exactly match this purchase. Approve this amount first.'],
    ALREADY_APPROVED:['本次金额已授权，您可以单独点击确认购买。','This amount is already approved. Click Confirm purchase separately to proceed.'],
    STALE:['链上状态尚未核实或已过期，请等待刷新。','Onchain state is unavailable or stale. Wait for a refresh.'],
    REFUND_ROUND:['请输入有效期号，可查询本期及往期退款。','Enter a valid round number to check current or past refunds.'],
    NOTHING_TO_REFUND:['本期没有待退本金：未持票或已经退款。','No principal remains to refund in this round: no tickets held, or already refunded.'],
    REFUND_TOO_EARLY:['本期尚未达到合约退款期限。','This round has not reached its contract refund deadline.'],
    REFUND_UNAVAILABLE:['本期不符合退款条件。请求随机数后须等待开奖结算。','This round is not refundable. Once randomness is requested, it must await settlement.'],
    REFUND_CHANGED:['待退金额已变化，请重新查询后确认。','The refundable amount changed. Check again before confirming.'],
  };
  if(copy[error.code]) return t(...copy[error.code]);
  if(error.code===4001 || error.code==='ACTION_REJECTED') return t('您已取消钱包确认，没有提交本次交易。','You cancelled wallet confirmation. This transaction was not submitted.');
  if(error.code===-32002) return t('钱包已有待处理请求，请打开钱包完成或取消。','A wallet request is already pending. Open your wallet to confirm or cancel it.');
  return t('操作未完成：{message}','Could not complete the operation: {message}',{message:String(error.shortMessage||error.message||error).slice(0,200)});
}
async function fetchJson(path) {
  const response=await fetch(path,{cache:'no-store',headers:{Accept:'application/json'}});
  if(!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(t('服务数据暂时不可用','Service data is currently unavailable'));
  return response.json();
}
async function allNamed(entries) {
  const result=await Promise.allSettled(entries.map(([,promise])=>promise));
  const failed=result.find(item=>item.status==='rejected');
  if(failed) throw failed.reason;
  return Object.fromEntries(entries.map(([key],index)=>[key,result[index].value]));
}
async function readFixed(blockTag) {
  const values=await allNamed([
    ...fixedFields.map(name=>[name,state.game[name]({blockTag})]),
    ['decimals',state.token.decimals({blockTag})],['code',state.rpc.getCode(PINNED.gameAddress,blockTag)],['chainId',state.rpc.send('eth_chainId',[])]
  ]);
  const fixed={...values,chainId:Number(values.chainId),runtimeCodeHash:keccak256(values.code)};
  assertFixedSnapshot(fixed);
  return fixed;
}
async function readSnapshot(account=state.account,withWords=false) {
  const block=await state.rpc.getBlock('latest');
  if(!block) throw new GuardError('STALE');
  const blockTag=block.number;
  const base=await allNamed([
    ['roundId',state.game.currentRoundId({blockTag})],['seriesAuthorized',state.game.seriesAuthorized({blockTag})],['nextRoundOpensAt',state.game.nextRoundOpensAt({blockTag})],
    ...(account?[['balance',state.token.balanceOf(account,{blockTag})],['nativeBalance',state.rpc.getBalance(account,blockTag)],['allowance',state.token.allowance(account,PINNED.gameAddress,{blockTag})]]:[])
  ]);
  const round=await state.game.rounds(base.roundId,{blockTag});
  const extra=await allNamed([
    ['timing',state.game.drawTiming(base.roundId,{blockTag})],
    ...(account?[['myCount',state.game.ticketsOf(base.roundId,account,{blockTag})],['buyerId',state.game.ticketBuyerId(base.roundId,account,{blockTag})]]:[]),
    ...(withWords?[['words',state.game.ticketWords(base.roundId,0,625,{blockTag})]]:[])
  ]);
  return {...base,...extra,account,roundId:String(base.roundId),block:blockTag,blockHash:block.hash,timestamp:block.timestamp,status:Number(round.status),sold:Number(round.sold),fundingDeadline:Number(round.fundingDeadline),drawDeadline:Number(round.drawDeadline),winningTicket:Number(round.winningTicket),winner:round.winner,requestId:String(round.requestId),balance:base.balance??0n,allowance:base.allowance??0n};
}
function myNumbers(snapshot) {
  if(!snapshot.words || !snapshot.buyerId || snapshot.buyerId===0n) return [];
  const result=[];
  for(let ticket=0;ticket<10000;ticket++) if((BigInt(snapshot.words[Math.floor(ticket/16)])>>BigInt(ticket%16*16)&65535n)===snapshot.buyerId) result.push(ticket);
  return result;
}
async function refresh() {
  if(!state.rpc || state.refreshing) return;
  state.refreshing=true;
  const account=state.account;
  try {
    const config=validateManifest(await fetchJson('/api/config'));
    const snapshot=await readSnapshot(account,Boolean(account));
    if(!state.fixed) await readFixed(snapshot.block);
    if(!same(account??'',state.account??'')) return;
    state.config=config;state.snapshot=snapshot;state.fixed=true;state.readError=false;state.receivedAt=performance.now();
    $('connection-status').textContent=t('BNB 主网 · 区块 {block}','BNB Chain · Block {block}',{block:snapshot.block});
    render();
    if(account && !state.refundLoading) await loadRefund();
    if(snapshot.status===5 && state.reveal?.roundId!==snapshot.roundId) reveal({roundId:snapshot.roundId,ticket:snapshot.winningTicket},true);
  } catch(error) {state.fixed=false;state.readError=true;notice(explanation(error),true);controls();$('connection-status').textContent=t('链上读取暂不可用','Onchain read unavailable');}
  finally {state.refreshing=false;}
}
function selectedQuantity() {
  try {return state.mode==='selected'?parseSelection($('selected-tickets').value).length:Number($('ticket-count').value);} catch {return 0;}
}
function intentNow() {return createIntent({mode:state.mode,count:$('ticket-count').value,text:$('selected-tickets').value,roundId:state.snapshot?.roundId,account:state.account,epoch:state.epoch});}
function controls() {
  const snapshot=state.snapshot;
  let valid=false,reason=t('正在读取合约状态','Reading contract state');
  try {
    if(!state.fixed || !snapshot || performance.now()-state.receivedAt>45000) throw new GuardError('STALE');
    const intent=intentNow();
    assertPurchaseSnapshot({config:state.config,snapshot,intent,walletAccount:state.account,walletChain:state.walletChain,epoch:state.epoch,action:'preview'});
    valid=true;
    reason=BigInt(snapshot.allowance)===intent.amount?t('授权已就绪，请单独确认购买。','Exact allowance is ready. Confirm the purchase separately.'):t('请先授权本次金额，再单独确认购买。','Approve this exact amount, then confirm the purchase separately.');
  } catch(error) {reason=explanation(error);}
  if(state.config?.salesEnabled===false || snapshot?.seriesAuthorized===false) reason=explanation(new GuardError('NOT_LAUNCHED'));
  const pending=state.transactions.some(tx=>isTransactionBlocking(tx,state.account));
  const review=state.transactions.some(tx=>same(tx.account,state.account)&&transactionNeedsReview(tx)&&!reviewedTransactions.has(tx.hash));
  if(pending) reason=t('上一笔交易正在确认，请等待链上回执。','Your previous transaction is pending. Wait for its onchain receipt.');
  else if(review) reason=t('有交易结果尚未核实，请在下方交易记录核对钱包活动，再确认继续操作。','A transaction result is unverified. Review wallet activity in the records below, then confirm before continuing.');
  const amount=BigInt(Math.max(0,Number.isInteger(selectedQuantity())?selectedQuantity():0))*PINNED.ticketPrice;
  $('approve').disabled=!valid||state.busy||pending||review||snapshot?.allowance===amount;
  $('buy').disabled=!valid||state.busy||pending||review||snapshot?.allowance!==amount;
  $('purchase-state').textContent=state.busy?t('请查看钱包请求…','Check your wallet request…'):reason;
  $('connect-wallet').disabled=state.busy;
  $('copy-browser-url').hidden=state.wallets.size>0;
  $('browser-help').hidden=state.wallets.size>0;
  $('switch-network').hidden=!state.account||state.walletChain===56;
  $('switch-network').disabled=state.busy;
  for(const id of ['ticket-count','selected-tickets','mode-auto','mode-selected']) $(id).disabled=state.busy;
  $('replay').disabled=!state.reveal||state.animating;
  const refundable=refundEligibility(state.refund);
  $('refund').disabled=!state.fixed||!state.account||state.walletChain!==56||state.busy||pending||review||state.refundLoading||performance.now()-state.refundReceivedAt>45000||!same(state.refund?.account,state.account)||!refundable.eligible;
  $('refund-round').disabled=state.busy;
  $('check-refund').disabled=state.busy||state.refundLoading||!state.account||!state.rpc;
}
function render() {
  const s=state.snapshot;
  $('connection-status').textContent=state.fixed&&s?t('BNB 主网 · 区块 {block}','BNB Chain · Block {block}',{block:s.block}):state.readError?t('链上读取暂不可用','Onchain read unavailable'):t('核对链上状态…','Verifying onchain state…');
  const launched=state.config?.salesEnabled===true&&s?.seriesAuthorized===true;
  $('launch-status').textContent=launched?t('已部署 · 已启动','Deployed · Live'):t('已部署，待启动','Deployed · Awaiting launch');
  $('sale-note').textContent=launched?t('BNB 主网正式版，参与前请核对期号与金额。','Live on BNB Chain. Review the round and amount before participating.'):t('正式合约已部署，当前待启动，暂不接受购买。','The contract is deployed and awaiting launch. Purchases are not yet open.');
  $('wallet-label').textContent=state.account?t('钱包已连接','Wallet connected'):state.wallets.size?t('连接钱包，查看余额与持票','Connect to view your balance and tickets'):t('未检测到浏览器钱包','No browser wallet detected');
  $('wallet-address').textContent=state.account??'';
  $('connect-wallet').textContent=state.account?t('切换钱包','Switch wallet'):t('连接钱包','Connect wallet');
  $('wallet-balances').textContent=state.account&&same(s?.account,state.account)?`${amounts(s.balance)} BEM · ${Number(formatUnits(s.nativeBalance,18)).toLocaleString(getLocale(),{maximumFractionDigits:6})} BNB`:'BEM — · BNB —';
  $('rank-scope').textContent=t('任务 260 最优槽位 · 快照','Task 260 best slot · Snapshot');
  $('round-label').textContent=!s||s.roundId==='0'?t('等待首期开盘','Awaiting the first round'):t('第 {round} 期','Round {round}',{round:s.roundId});
  $('round-phase').textContent=statuses()[s?.status??0]??'—';
  $('funding-amount').textContent=s?`${amounts(BigInt(s.sold)*PINNED.ticketPrice)} / 100 BEM`:'— / 100 BEM';
  $('funding-tickets').textContent=s?t('{sold} / 10,000 份','{sold} / 10,000 tickets',{sold:s.sold.toLocaleString(getLocale())}):'— / 10,000';
  $('funding-progress').firstElementChild.style.width=`${(s?.sold??0)/100}%`;
  $('my-count').textContent=state.account&&s?String(s.myCount??0):'—';
  const mine=s&&same(s.account,state.account)?myNumbers(s):[];
  $('my-numbers').textContent=mine.length?mine.map(displayTicket).join(' · '):state.account?t('本期暂未持有号码','No tickets held in this round'):t('连接后查看您的号码','Connect to view your numbers');
  const quantity=selectedQuantity();
  $('purchase-total').textContent=quantity>=1&&quantity<=500&&Number.isInteger(quantity)?`${amounts(BigInt(quantity)*PINNED.ticketPrice)} BEM`:'— BEM';
  $('selection-note').textContent=quantity?t('已选 {count} 份 · 每份中奖概率相同','{count} tickets · Equal chance per ticket',{count:quantity}):t('请选择 1–500 份','Choose 1–500 tickets');
  $('snapshot-label').textContent=s?t('只读快照 · 区块 {block}','Read-only snapshot · Block {block}',{block:s.block}):'';
  const stepStatuses=[2,3,4,5];['lock','random','circuit','settle'].forEach((step,index)=>$('step-'+step).classList.toggle('active',(s?.status??0)>=stepStatuses[index]&&(s?.status??0)<=5));
  renderContracts();renderCountdown();renderReelCopy();renderRefund();controls();renderTransactions();
}
function renderContracts() {
  const target=$('contract-links');target.replaceChildren();
  const fields=[[t('抽奖合约','Raffle contract'),PINNED.gameAddress,'address'],['BEM',PINNED.bemAddress,'address'],[t('2075 容器','2075 container'),PINNED.containerAddress,'address'],[t('链上处理器','Onchain processor'),PINNED.processorAddress,'address'],['VRF Coordinator',PINNED.coordinator,'address'],[t('VRF 订阅 ID','VRF subscription ID'),PINNED.subscriptionId,null],[t('合约运行代码哈希','Runtime code hash'),PINNED.runtimeCodeHash,null]];
  for(const [label,value,kind] of fields){const term=document.createElement('dt');term.textContent=label;const detail=document.createElement('dd');detail.append(kind?link(kind,value):document.createTextNode(value));target.append(term,detail);}
}
function renderCountdown() {
  const s=state.snapshot,panel=$('countdown-panel');
  if(!s||s.status===0){panel.hidden=true;return;}
  panel.hidden=false;
  const now=s.timestamp+Math.max(0,Math.floor((performance.now()-state.receivedAt)/1000));
  let target=0,label='',note='';
  if(s.status===1){target=s.fundingDeadline;label=t('本期筹集剩余时间','Funding time remaining');note=t('72 小时未凑满，按合约规则开放退款。','Incomplete funding after 72 hours makes refunds available under the contract rules.');}
  else if(s.status>=2&&s.status<=4){target=Number(s.timing?.scheduledDrawAt||s.timing?.targetDrawBy||0);label=t('封盘后开奖倒计时','Draw countdown after closing');note=t('目标时间以链上记录为准，VRF 或网络延迟时继续等待，不会换用可预测随机数。','The target follows onchain timing. Delays wait for VRF or confirmations; no predictable random fallback is used.');}
  else if(s.status===5){target=Number(s.nextRoundOpensAt);label=t('下一期开放倒计时','Next-round countdown');note=t('冷却结束后由链上交易开盘。','A transaction opens the next round after the cooldown.');}
  else {label=t('本期已开放退款','This round is refundable');note=t('在「退回本金」中查询本期，确认后本金直接退回您的钱包。','Check this round under Return principal. Confirmation returns the principal directly to your wallet.');}
  const left=Math.max(0,target-now);
  $('countdown-label').textContent=label;
  $('countdown-value').textContent=target?(left?`${String(Math.floor(left/3600)).padStart(2,'0')}:${String(Math.floor(left%3600/60)).padStart(2,'0')}:${String(left%60).padStart(2,'0')}`:t('等待链上执行','Awaiting execution')):'—';
  $('countdown-note').textContent=note;
}

function walletChanged() {
  state.epoch++;state.account=null;state.walletChain=null;state.refund=null;state.refundVersion++;state.refundLoading=false;
  notice(t('钱包或网络已改变。已提交交易仍保留，请重新连接后继续。','Your wallet or network changed. Submitted transactions are preserved. Reconnect to continue.'));
  render();refresh();
}
function detachWallet() {
  state.wallet?.removeListener?.('accountsChanged',walletChanged);state.wallet?.removeListener?.('chainChanged',walletChanged);state.wallet?.removeListener?.('disconnect',walletChanged);
}
async function connect(entry) {
  if(state.busy) return;
  if(!entry?.provider) return;
  state.busy=true;controls();
  try {
    detachWallet();state.wallet=entry.provider;state.epoch++;state.account=null;state.walletChain=null;state.refund=null;state.refundVersion++;state.refundLoading=false;
    const epoch=state.epoch;
    const accounts=await state.wallet.request({method:'eth_requestAccounts'});
    const chain=Number(await state.wallet.request({method:'eth_chainId'}));
    if(epoch!==state.epoch) throw new GuardError('WALLET_CHANGED');
    if(!accounts?.length) throw new GuardError('WALLET');
    state.account=getAddress(accounts[0]);state.walletChain=chain;
    state.wallet.on?.('accountsChanged',walletChanged);state.wallet.on?.('chainChanged',walletChanged);state.wallet.on?.('disconnect',walletChanged);
    notice(chain===56?t('钱包已连接 BNB 主网。连接不会购买或转账。','Wallet connected to BNB Chain. No purchase or transfer was made.'):explanation(new GuardError('NETWORK')));
    await refresh();
  } catch(error) {notice(explanation(error),true);}
  finally {state.busy=false;render();}
}
async function switchNetwork() {
  if(!state.wallet||state.busy)return;
  state.busy=true;controls();
  try {await state.wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});notice(t('请重新连接钱包以确认当前账户与 BNB 主网。','Reconnect to verify the current account on BNB Chain.'));}
  catch(error){notice(explanation(error),true);}finally{state.busy=false;controls();}
}
async function walletIdentity(wallet) {
  const [accounts,chainId]=await Promise.all([wallet.request({method:'eth_accounts'}),wallet.request({method:'eth_chainId'})]);
  return {walletAccount:accounts?.[0],walletChain:Number(chainId)};
}
async function readRefundSnapshot(roundId,account) {
  const block=await state.rpc.getBlock('latest');
  if(!block) throw new GuardError('STALE');
  const [round,myCount]=await Promise.all([state.game.rounds(roundId,{blockTag:block.number}),state.game.ticketsOf(roundId,account,{blockTag:block.number})]);
  return {account,roundId,block:block.number,timestamp:block.timestamp,status:Number(round.status),fundingDeadline:Number(round.fundingDeadline),drawDeadline:Number(round.drawDeadline),myCount};
}
async function loadRefund(roundId) {
  if(!state.rpc||!state.account) return;
  if(roundId!==undefined) $('refund-round').value=String(roundId);
  if(!$('refund-round').value && state.snapshot?.roundId!=='0') $('refund-round').value=state.snapshot?.roundId??'1';
  const version=++state.refundVersion,account=state.account;
  state.refundLoading=true;state.refundError=null;controls();renderRefund();
  try {
    const id=parseRefundRound($('refund-round').value);
    const snapshot=await readRefundSnapshot(id,account);
    if(version!==state.refundVersion||!same(account,state.account)) return;
    state.refund=snapshot;state.refundReceivedAt=performance.now();
  } catch(error) {if(version===state.refundVersion){state.refund=null;state.refundError=explanation(error);}}
  finally {if(version===state.refundVersion){state.refundLoading=false;renderRefund();controls();}}
}
function renderRefund() {
  const snapshot=state.refund,eligibility=refundEligibility(snapshot);
  $('refund-amount').textContent=state.account&&same(snapshot?.account,state.account)?`${amounts(eligibility.eligible?eligibility.amount:0n)} BEM`:'— BEM';
  $('refund-state').textContent=!state.account?t('连接钱包后，输入期号查询待退本金。','Connect a wallet, then enter a round to check refundable principal.'):state.refundLoading?t('正在核对链上退款条件…','Checking onchain refund conditions…'):state.refundError??(!snapshot?t('可查询本期或任意往期期号。','Look up the current round or any past round.'):eligibility.eligible?t('第 {round} 期可退 {amount} BEM，将直接退回当前钱包。','Round {round}: {amount} BEM will be returned directly to this wallet.',{round:snapshot.roundId,amount:amounts(eligibility.amount)}):explanation(new GuardError(eligibility.reason)));
}
async function submitRefund() {
  if(state.busy||!state.wallet||$('refund').disabled) return;
  let intent;
  try {intent=createRefundIntent({roundId:$('refund-round').value,account:state.account,epoch:state.epoch,snapshot:state.refund});}
  catch(error){notice(explanation(error),true);return;}
  const wallet=state.wallet;
  state.busy=true;controls();
  try {
    const check=async()=>{
      const config=validateManifest(await fetchJson('/api/config'));
      const snapshot=await readRefundSnapshot(intent.roundId,intent.account);
      await readFixed(snapshot.block);
      const identity=await walletIdentity(wallet);
      assertRefundSnapshot({config,snapshot,intent,...identity,epoch:state.epoch});
      return snapshot;
    };
    await check();
    const data=state.game.interface.encodeFunctionData('refund',[intent.roundId,intent.account]);
    const tx={from:intent.account,to:PINNED.gameAddress,data,value:'0x0',chainId:'0x38'};
    await state.rpc.send('eth_call',[tx,'latest']);
    const gas=(BigInt(await state.rpc.send('eth_estimateGas',[tx]))*120n+99n)/100n;
    if(gas>16777216n) throw new GuardError('STALE');
    const snapshot=await check();
    tx.gas=toQuantity(gas);
    if(state.epoch!==intent.epoch||state.wallet!==wallet||!same(state.account,intent.account)||state.walletChain!==56) throw new GuardError('WALLET_CHANGED');
    const hash=await wallet.request({method:'eth_sendTransaction',params:[tx]});
    if(!explorerLink('tx',hash)) throw new Error(t('钱包未返回有效交易哈希，请查看钱包活动后再操作。','The wallet returned no valid transaction hash. Check wallet activity before proceeding.'));
    state.transactions.unshift(createTransactionRecord({hash,account:intent.account,action:'refund',roundId:intent.roundId,to:tx.to,data,fromBlock:snapshot.block}));
    state.transactions=state.transactions.slice(0,25);saveTransactions();
    notice(t('退款已提交，等待链上确认。','Refund submitted. Awaiting onchain confirmation.'));
    void pollTransactions();
  } catch(error){notice(explanation(error),true);}
  finally {state.busy=false;await loadRefund(intent.roundId);controls();renderTransactions();}
}
async function submit(action) {
  if(state.busy || !state.wallet || $(action).disabled) return;
  let intent;
  try {intent=intentNow();}catch(error){notice(explanation(error),true);return;}
  const wallet=state.wallet;
  state.busy=true;controls();
  try {
    const config=validateManifest(await fetchJson('/api/config'));
    const snapshot=await readSnapshot(intent.account,true);
    await readFixed(snapshot.block);
    const identity=await walletIdentity(wallet);
    assertPurchaseSnapshot({config,snapshot,intent,...identity,epoch:state.epoch,action});
    const to=action==='approve'?PINNED.bemAddress:PINNED.gameAddress;
    const data=action==='approve'?state.token.interface.encodeFunctionData('approve',[PINNED.gameAddress,intent.amount]):intent.selected?state.game.interface.encodeFunctionData('buySelected',[BigInt(intent.roundId),intent.selected]):state.game.interface.encodeFunctionData('buy',[BigInt(intent.roundId),intent.count]);
    const tx={from:intent.account,to,data,value:'0x0',chainId:'0x38'};
    // Both calls are read-only simulations. No transaction is sent through /rpc.
    await state.rpc.send('eth_call',[tx,'latest']);
    const gas=BigInt(await state.rpc.send('eth_estimateGas',[tx]));
    const gasLimit=(gas*120n+99n)/100n;
    if(gasLimit>16777216n) throw new Error(t('预估网络执行量超出限制，未提交交易。','Estimated execution exceeds the limit. No transaction was submitted.'));
    const gasPrice=BigInt(await state.rpc.send('eth_gasPrice',[]));
    enforcePurchaseGasBudget(action,gasLimit,gasPrice);
    tx.gasPrice=toQuantity(gasPrice);
    const finalConfig=validateManifest(await fetchJson('/api/config'));
    const finalSnapshot=await readSnapshot(intent.account,true);
    const finalIdentity=await walletIdentity(wallet);
    assertPurchaseSnapshot({config:finalConfig,snapshot:finalSnapshot,intent,...finalIdentity,epoch:state.epoch,action});
    tx.gas=toQuantity(gasLimit);
    // This is the only signing entry point, reached solely from an explicit button click.
    const hash=await wallet.request({method:'eth_sendTransaction',params:[tx]});
    if(!explorerLink('tx',hash)) throw new Error(t('钱包未返回有效交易哈希，请先检查钱包活动，勿重复提交。','No valid transaction hash was returned. Check wallet activity before trying again.'));
    state.transactions.unshift(createTransactionRecord({hash,account:intent.account,action,roundId:intent.roundId,to,data,fromBlock:finalSnapshot.block}));
    state.transactions=state.transactions.slice(0,25);saveTransactions();
    notice(t('交易已提交，等待链上确认：{hash}','Transaction submitted; awaiting confirmation: {hash}',{hash}));
    void pollTransactions();
  } catch(error) {notice(explanation(error),true);}
  finally {state.busy=false;controls();renderTransactions();}
}
function saveTransactions(){try{localStorage.setItem(TX_KEY,JSON.stringify(state.transactions));}catch{/* Public transaction records remain visible in this tab. */}}
function restoreTransactions(merge=false){try{const incoming=restoreTransactionRecords(localStorage.getItem(TX_KEY)||'[]');if(!merge){state.transactions=incoming;return;}const known=new Map(state.transactions.map(row=>[row.hash,row]));for(const row of incoming)if(!known.has(row.hash))known.set(row.hash,row);const terminal=row=>['confirmed','reverted','cancelled','replaced'].includes(row.status);state.transactions=[...known.values()].sort((a,b)=>Number(terminal(a))-Number(terminal(b))||(Date.parse(b.submittedAt)||0)-(Date.parse(a.submittedAt)||0)).slice(0,25);}catch{/* Another tab cannot erase this tab's unresolved transaction records. */}}
async function pollTransactions(){
  if(!state.tracker||state.polling)return;
  state.polling=true;$('check-transactions').disabled=true;
  let changed=false;
  try {
    const candidates=state.transactions.filter(row=>!['confirmed','reverted','cancelled','replaced'].includes(row.status)).sort((a,b)=>(Date.parse(a.checkedAt)||0)-(Date.parse(b.checkedAt)||0)).slice(0,4);
    await Promise.all(candidates.map(async record=>{
      try{
        const next=await state.tracker.poll(record);
        const index=state.transactions.indexOf(record);
        if(index<0)return;
        if(JSON.stringify(record)!==JSON.stringify(next)){state.transactions[index]=next;changed=true;}
      }catch{/* A failed read cannot prove that a transaction failed. */}
    }));
    if(changed){saveTransactions();await refresh();}
  } finally {state.polling=false;$('check-transactions').disabled=false;renderTransactions();controls();}
}
function renderTransactions(){
  $('transactions').hidden=!state.transactions.length;$('transaction-list').replaceChildren();
  const statusCopy={pending:t('等待链上确认','Awaiting confirmation'),confirming:t('已上链 · 等待确认数','Mined · Awaiting confirmations'),confirmed:t('已确认','Confirmed'),reverted:t('执行失败 · 已回滚','Reverted'),cancelled:t('已被取消交易替换','Replaced by a cancellation'),replaced:t('已被其他交易替换','Replaced by a different transaction'),unknown:t('结果待核实','Result unknown'),unverified:t('交易详情尚未核实','Transaction details unverified')};
  for(const record of state.transactions){
    const row=document.createElement('div');row.className='tx-entry';const title=document.createElement('b');
    const action=record.action==='approve'?t('授权','Approval'):record.action==='refund'?t('退款','Refund'):t('购买','Purchase');
    title.textContent=`${action} · ${statusCopy[record.status]??statusCopy.unknown}`;
    const account=document.createElement('span');account.textContent=t('钱包 {account} · 第 {round} 期','Wallet {account} · Round {round}',{account:record.account,round:record.roundId});
    row.append(title,account,link('tx',record.hash));
    if(record.replacementHash){const replacement=document.createElement('small');replacement.append(t('替换交易：','Replacement: '),link('tx',record.replacementHash));row.append(replacement);}
    if(transactionNeedsReview(record)){
      const note=document.createElement('small');note.textContent=t('尚不能确认此笔结果；它仍可能执行。请检查钱包活动及链上记录后再操作，避免重复购买。','The result is not yet verified; this transaction may still execute. Check wallet activity and onchain records before proceeding to avoid duplicate purchases.');row.append(note);
      const form=document.createElement('form');form.className='tx-reconcile';const input=document.createElement('input');input.type='text';input.placeholder=t('粘贴加速或取消后的交易哈希','Paste the accelerated or cancellation transaction hash');input.setAttribute('aria-label',input.placeholder);input.maxLength=66;const button=document.createElement('button');button.type='submit';button.textContent=t('核对新交易','Check new transaction');form.append(input,button);
      form.addEventListener('submit',async event=>{event.preventDefault();if(!state.tracker||!explorerLink('tx',input.value.trim())){notice(t('请输入完整的 0x 交易哈希。','Enter the complete 0x transaction hash.'),true);return;}button.disabled=true;try{const next=await state.tracker.reconcile(record,input.value.trim());const index=state.transactions.indexOf(record);if(index>=0){state.transactions[index]=next;saveTransactions();}await refresh();renderTransactions();}catch(error){notice(explanation(error),true);}finally{button.disabled=false;controls();}});row.append(form);
      if(same(record.account,state.account)&&!reviewedTransactions.has(record.hash)){const checked=document.createElement('button');checked.type='button';checked.textContent=t('我已核对钱包，继续操作','I checked my wallet · Continue');checked.addEventListener('click',()=>{reviewedTransactions.add(record.hash);notice(t('您已确认核对钱包活动。原交易仍会继续查询，未标记为失败，也不会自动重发。','You confirmed reviewing wallet activity. The original transaction will still be checked; it has not been marked as failed or resent.'));renderTransactions();controls();});row.append(checked);}
    }
    $('transaction-list').append(row);
  }
}

function link(kind,value,label=value){const href=explorerLink(kind,value);if(!href)return document.createTextNode('—');const anchor=document.createElement('a');anchor.href=href;anchor.textContent=label;anchor.target='_blank';anchor.rel='noopener noreferrer';return anchor;}
async function loadHistory(page=state.page){
  $('refresh-history').disabled=true;
  try{
    const data=await fetchJson(`/api/history?page=${page}&pageSize=10`);
    if(data.schemaVersion!==1||data.chainId!==56||!same(data.gameAddress,PINNED.gameAddress)||!Array.isArray(data.rounds)||!['ready','syncing','stale'].includes(data.index?.state))throw new Error('Invalid history identity');
    state.history=data;state.page=data.page;state.historyError=false;
  }catch{state.historyError=true;}finally{$('refresh-history').disabled=false;renderHistory();}
}
function renderHistory(){
  const data=state.history,list=$('history-list');list.replaceChildren();
  if(state.historyError){$('history-summary').textContent=t('历史服务暂不可用，不能据此判断没有开奖记录。请刷新或查看合约事件。','History is unavailable. This does not mean no draws exist. Refresh or inspect contract events.');}
  else if(data){const scope=t('已索引至区块 {block} · {confirmations} 次确认','Indexed through block {block} · {confirmations} confirmations',{block:data.index.indexedThrough??'—',confirmations:data.index.confirmations});$('history-summary').textContent=(data.index.state==='ready'?t('记录已同步','Records synchronized'):data.index.state==='syncing'?t('历史同步中，当前记录可能不完整','History is syncing; records may be incomplete'):t('历史索引已滞后，当前记录可能不完整','History index is stale; records may be incomplete'))+` · ${scope}`;}
  else $('history-summary').textContent=t('正在读取已确认历史…','Loading confirmed history…');
  if(!data?.rounds.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent=data?.index.state==='ready'&&!state.historyError?t('已确认的区块范围内，尚无往期记录。','No past rounds were found in the confirmed block range.'):t('等待历史索引，暂时无法确认往期记录。','Waiting for the history index; past records cannot yet be confirmed.');list.append(empty);}
  for(const record of data?.rounds??[]){
    const row=document.createElement('article');row.className='history-entry';const heading=document.createElement('div');const round=document.createElement('small');round.textContent=t('第 {round} 期','Round {round}',{round:record.roundId});const number=document.createElement('strong');number.textContent=record.status===5&&Number.isInteger(record.winningTicket)?`#${displayTicket(record.winningTicket)}`:statuses()[record.status]??'—';heading.append(round,number);const wallet=document.createElement('div');wallet.className='mono';const label=document.createElement('small');label.textContent=record.status===5?t('中奖钱包 · 奖金 95 BEM','Winning wallet · 95 BEM prize'):t('本期状态','Round status');wallet.append(label,record.winner?link('address',record.winner):document.createTextNode('—'));if(record.settlementTxHash){const tx=document.createElement('div');tx.append(link('tx',record.settlementTxHash,t('开奖交易 ↗','Settlement transaction ↗')));wallet.append(tx);}const actions=document.createElement('div');const button=document.createElement('button');button.type='button';button.textContent=t('验算详情','Verification');button.addEventListener('click',()=>loadDetail(record.roundId));actions.append(button);if([1,2,6].includes(record.status)){const refund=document.createElement('button');refund.type='button';refund.textContent=t('查询退款','Check refund');refund.addEventListener('click',()=>{if(state.busy)return;selectTab('draw');state.epoch++;state.refund=null;$('refund-round').value=String(record.roundId);loadRefund();$('refund-card').scrollIntoView({behavior:'smooth',block:'start'});});actions.append(refund);}row.append(heading,wallet,actions);list.append(row);
  }
  $('history-page').textContent=data?`${data.page} / ${Math.max(1,data.totalPages||1)}`:'—';$('history-prev').disabled=!data||data.page<=1;$('history-next').disabled=!data||data.page>=data.totalPages;
}
async function loadDetail(id){
  if(!/^\d+$/.test(String(id)))return;
  state.detailId=String(id);state.detail=null;state.detailError=false;
  const target=$('proof-detail');target.hidden=false;target.textContent=t('正在读取本期链上事件…','Loading this round’s onchain events…');
  try{
    const detail=await fetchJson(`/api/history/round/${id}`);
    if(String(detail.roundId)!==String(id)||!Array.isArray(detail.events))throw new Error('Invalid round detail');
    if(state.detailId!==String(id))return;
    state.detail=detail;renderDetail();target.scrollIntoView({behavior:'smooth',block:'start'});
  }catch{if(state.detailId===String(id)){state.detailError=true;renderDetail();}}
}
function renderDetail(){
    const target=$('proof-detail'),detail=state.detail;
    if(state.detailError){target.textContent=t('本期详情暂不可用，请稍后刷新或直接查看合约事件。','Round details are unavailable. Try again later or inspect contract events.');return;}
    if(!detail){target.textContent=t('正在读取本期链上事件…','Loading this round’s onchain events…');return;}
    target.replaceChildren();const heading=document.createElement('h2');heading.textContent=t('第 {round} 期 · 公开验算','Round {round} · Public verification',{round:detail.roundId});target.append(heading);
    const warning=document.createElement('p');warning.className='muted';warning.textContent=detail.index?.state==='ready'?t('事件来自已确认的主网索引，可逐笔打开交易核对。','Events come from the confirmed mainnet index. Open each transaction to verify.'):t('索引尚未完全同步，下列记录可能不完整。','The index is not fully synchronized; these records may be incomplete.');target.append(warning);
    const fields=document.createElement('dl');fields.className='proof-fields';
    for(const [label,value,kind] of [[t('合约地址','Contract address'),PINNED.gameAddress,'address'],[t('合约运行代码哈希','Runtime code hash'),PINNED.runtimeCodeHash,null],[t('中奖钱包','Winning wallet'),detail.winner,'address'],[t('封盘交易','Lock transaction'),detail.proof?.lockTxHash,'tx'],[t('VRF 请求交易','VRF request'),detail.proof?.requestTxHash,'tx'],[t('VRF 回传交易','VRF fulfillment'),detail.proof?.randomnessTxHash,'tx'],[t('开奖与结算交易','Draw and settlement'),detail.settlementTxHash??detail.proof?.settlementTxHash,'tx']]){const term=document.createElement('dt');term.textContent=label;const valueNode=document.createElement('dd');valueNode.className='mono';valueNode.append(kind?link(kind,value):document.createTextNode(value??'—'));fields.append(term,valueNode);}target.append(fields);
    for(const event of detail.events){const block=document.createElement('details');block.className='proof-event';const summary=document.createElement('summary');summary.textContent=`${event.name} · #${event.blockNumber}`;const pre=document.createElement('pre');pre.textContent=json(event.args);block.append(summary,pre,link('tx',event.transactionHash));target.append(block);}
}
function renderReelCopy(){
  const result=state.reveal;
  if(!result){$('reels').setAttribute('aria-label',t('尚未开奖','No draw result yet'));$('reel-caption').textContent=t('等待本期开奖','Awaiting this round’s draw');$('reel-message').textContent=t('等待链上确认中奖号码。','Waiting for the winning number to be confirmed onchain.');return;}
  $('reels').setAttribute('aria-label',t('第 {round} 期中奖票 {ticket}','Round {round}, winning ticket {ticket}',{round:result.roundId,ticket:displayTicket(result.ticket)}));
  $('reel-caption').textContent=state.animating?t('卷轴揭晓中','Revealing'):t('第 {round} 期 · 链上已结算','Round {round} · Settled onchain',{round:result.roundId});
  $('reel-message').textContent=state.animating?t('正在展示已公开的链上结果…','Revealing the already public onchain result…'):t('中奖号码 {ticket} · 结果与中奖钱包公开可验','Winning number {ticket} · Result and winner are publicly verifiable',{ticket:displayTicket(result.ticket)});
}
function reveal(result,animate=false){
  if(state.animating)return;state.reveal=result;
  const digits=displayTicket(result.ticket).split('').map(Number);
  const items=[...document.querySelectorAll('.reel')].map((reel,index)=>{const strip=reel.querySelector('.reel-strip');const target=animate?60+index*10+digits[index]:digits[index];strip.replaceChildren(...Array.from({length:target+12},(_,number)=>{const digit=document.createElement('span');digit.textContent=String(number%10);return digit;}));reel.querySelector('.placeholder').hidden=true;const height=strip.firstElementChild.getBoundingClientRect().height||reel.clientHeight;return{reel,strip,target,height};});
  const position=(item,value)=>{item.strip.style.transform=`translate3d(0,${(item.reel.clientHeight-item.height)/2-value*item.height}px,0)`;};
  const copy=renderReelCopy;
  if(!animate){items.forEach(item=>{position(item,item.target);item.reel.classList.add('locked');});copy();controls();return;}
  state.animating=true;document.body.classList.add('animating');$('reel-caption').textContent=t('卷轴揭晓中','Revealing');$('reel-message').textContent=t('正在展示已公开的链上结果…','Revealing the already public onchain result…');controls();let elapsed=0,previous=null;
  function frame(time){if(previous!=null&&!document.hidden)elapsed+=Math.min(time-previous,80);previous=time;items.forEach((item,index)=>{const progress=Math.min(1,elapsed/(4200+650*index));position(item,item.target*(1-Math.pow(1-progress,3)));item.reel.classList.toggle('locked',progress===1);});if(elapsed<6800){requestAnimationFrame(frame);return;}state.animating=false;document.body.classList.remove('animating');copy();controls();}
  requestAnimationFrame(frame);
}
function selectTab(name){for(const tab of ['draw','proof']){$('panel-'+tab).hidden=tab!==name;$('tab-'+tab).setAttribute('aria-selected',String(tab===name));}if(name==='proof')loadHistory();}

initLanguage();restoreTransactions();
$('browser-url').value=new URL('/',location.href).href;
const walletPicker=createWalletPicker({dialog:$('wallet-picker'),onSelect:connect,onChange:wallets=>{state.wallets=wallets;render();}});
$('connect-wallet').addEventListener('click',()=>{if(!state.busy)walletPicker.open();});$('switch-network').addEventListener('click',switchNetwork);
$('copy-browser-url').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('browser-url').value);notice(t('网址已复制，请粘贴到已安装 MetaMask 的 Chrome / Edge 地址栏。','URL copied. Paste it into Chrome or Edge with MetaMask installed.'));}catch{$('browser-url').focus();$('browser-url').select();notice(t('请复制已选中的网址，粘贴到已安装 MetaMask 的 Chrome / Edge。','Copy the selected URL and paste it into Chrome or Edge with MetaMask installed.'));}});
$('approve').addEventListener('click',()=>submit('approve'));$('buy').addEventListener('click',()=>submit('buy'));
$('refund').addEventListener('click',submitRefund);$('check-refund').addEventListener('click',()=>loadRefund());
$('refund-round').addEventListener('input',()=>{state.epoch++;state.refundVersion++;state.refund=null;state.refundLoading=false;state.refundError=null;renderRefund();controls();});
$('check-transactions').addEventListener('click',pollTransactions);
for(const id of ['ticket-count','selected-tickets'])$(id).addEventListener('input',()=>{state.epoch++;render();});
for(const mode of ['auto','selected'])$('mode-'+mode).addEventListener('click',()=>{if(state.busy)return;state.mode=mode;state.epoch++;$('auto-fields').hidden=mode!=='auto';$('selected-fields').hidden=mode!=='selected';for(const value of ['auto','selected'])$('mode-'+value).setAttribute('aria-pressed',String(mode===value));render();});
document.querySelectorAll('[data-count]').forEach(button=>button.addEventListener('click',()=>{if(state.busy)return;$('ticket-count').value=button.dataset.count;state.epoch++;render();}));
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>selectTab(button.dataset.tab)));
$('replay').addEventListener('click',()=>{if(state.reveal)reveal(state.reveal,true);});
$('refresh-history').addEventListener('click',()=>loadHistory());$('history-prev').addEventListener('click',()=>loadHistory(state.page-1));$('history-next').addEventListener('click',()=>loadHistory(state.page+1));
window.addEventListener('bem:languagechange',()=>{$('notice').textContent=translateKnown($('notice').textContent);render();renderHistory();if(state.detailId&&!$('proof-detail').hidden)renderDetail();});
window.addEventListener('storage',event=>{if(event.key===TX_KEY){restoreTransactions(true);renderTransactions();controls();}});
window.addEventListener('resize',()=>{if(state.reveal&&!state.animating)reveal(state.reveal,false);});
setInterval(()=>{renderCountdown();controls();},1000);
setInterval(()=>{refresh();pollTransactions();},15000);
async function boot(){
  try{state.config=validateManifest(await fetchJson('/api/config'));state.rpc=new JsonRpcProvider(new URL('/rpc',location.origin).href,56,{staticNetwork:true,batchMaxCount:25});state.tracker=createTransactionTracker({rpc:(method,params)=>state.rpc.send(method,params)});state.game=new Contract(PINNED.gameAddress,state.config.gameAbi,state.rpc);state.token=new Contract(PINNED.bemAddress,state.config.bemAbi,state.rpc);await refresh();if(state.fixed)notice(t('正式合约已核对。当前待启动，可连接真实钱包查看主网余额。','Production contract verified. Awaiting launch; connect your wallet to view mainnet balances.'),false,true);await pollTransactions();loadHistory();}
  catch(error){state.readError=true;notice(explanation(error),true);}
  finally{if(!state.wallets.size&&state.fixed)notice(t('主网数据已连接，可查看公开记录。连接钱包后可查看持票。','Mainnet data is connected. Browse public records, or connect a wallet to view your tickets.'),false,true);render();}
}
boot();
