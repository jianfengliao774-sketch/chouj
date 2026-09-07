import { Interface, formatUnits, getAddress, toQuantity } from 'ethers';
import { t, getLocale, initLanguage, translateKnown } from './player-i18n.js';
import { createWalletPicker } from './wallet-picker.js';
import { createPoolSelection, poolMetadata } from './pool-selection.js';
import { createPendingPlayerState } from './player-v2-state.js';
import { createTestPlayerTransactions } from './test-player-transactions.js';
import { createFormalPlayerTransactions } from './formal-player-transactions.js';
import { createPartialFillResult } from './partial-fill-result.js';
import { createReadRpcBatcher } from './read-rpc-batcher.js';
import { createPendingReadPoller, hasFastPendingRead } from './pending-read-poller.js';

const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a';
const PROCESSOR = '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C';
const $ = id => document.getElementById(id);
const put = (id, value) => { const element = $(id); if (element) element.textContent = value; };
const hidden = (id, value) => { const element = $(id); if (element) element.hidden = value; };
const disabled = (id, value) => { const element = $(id); if (element) element.disabled = value; };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const money = (amount, decimals = 8) => formatUnits(amount, decimals).replace(/\.0+$/, '');
const selectedQuery = new URLSearchParams(location.search).get('pool');
const initialPool = ['1', '10', '50', '100'].includes(selectedQuery) ? selectedQuery : '100';
const model = createPendingPlayerState({ poolId: initialPool });
const tokenInterface = new Interface(['function balanceOf(address) view returns(uint256)']);
const state = { wallet: null, wallets: new Map(), connecting: false, connectVersion: 0, connectAttempt: null, balanceGeneration: 0,
  balanceAbort: null, refreshing: false, noticeError: false, tab: 'draw', poolStatus: null, poolStatusError: false, poolGeneration: 0,
  testView: null, refundView: null, settlementView: null, testGeneration: 0, testRefreshing: false, testReadError: false };
let pools = null;
let testTransactions = null;
let pendingPoller = null;
const formalTransactions = new Map();
const partialFillResult = createPartialFillResult({ getLanguage: () => getLocale().startsWith('en') ? 'en' : 'zh' });
const batchedRead = createReadRpcBatcher();
function currentTransactions() {
  const poolId = model.getState().poolId;
  if (poolId === '1') return testTransactions;
  const manager = formalTransactions.get(poolId);
  return manager?.getState().registered ? manager : null;
}

function notice(message, error = false) { put('notice', message); $('notice')?.classList.toggle('error-copy', error); state.noticeError = error; }
function errorCopy(error) {
  const copies = {
    TICKET_LIMIT: ['单笔请选择 1–1,000 份，每地址每期最多 5,000 份。', 'Choose 1–1,000 tickets per purchase; at most 5,000 per address per round.'],
    TICKET_RANGE: ['票号范围为 1–10000，起点不能大于终点。', 'Tickets range from 1 to 10000. A range must start with its smaller number.'],
    TICKET_FORMAT: ['请用逗号分隔号码，连续号段如 100-110。', 'Use comma-separated ticket numbers or ranges such as 100-110.'],
    NO_TICKETS: ['请输入您要选择的票号。', 'Enter the ticket numbers you want.'],
    POOL_NOT_LAUNCHED: ['该场次暂未开放，暂不接受授权、购买或退款交易。', 'This pool is not open yet. Approvals, purchases and refund transactions are unavailable.'],
    TEST_POOL_ONLY: ['交易入口仅供 1 BEM 测试场次。', 'Transactions are limited to the 1 BEM test pool.'],
    FORMAL_NOT_REGISTERED: ['新正式合约尚未完成部署核验，暂不接受购买。', 'The new production contract has not completed deployment verification. Purchases are unavailable.'],
    FORMAL_POOL_ONLY: ['场次合约不匹配，请重新选择场次。', 'The pool contract does not match. Select the pool again.'],
    CONTEXT_CHANGED: ['钱包、场次或选号已变化，请核对后重新操作。', 'The wallet, pool or selection changed. Review and try again.'],
    WALLET_CHANGED: ['钱包已变化，请重新连接。', 'The wallet changed. Reconnect.'],
    WALLET_NETWORK: ['请连接钱包并切换到 BNB 主网。', 'Connect your wallet on BNB Chain.'],
    PURCHASE_UNAVAILABLE: ['当前不可购买，请核对启动状态、剩余份数和期限。', 'Purchases are unavailable. Check activation, remaining tickets and deadline.'],
    APPROVAL_REQUIRED: ['请先授权本次购买金额，确认后再购买。', 'Approve this purchase amount first, then buy after confirmation.'],
    ALLOWANCE_SUFFICIENT: ['当前额度已足够，可直接确认购买。', 'The allowance is sufficient. You can confirm the purchase.'],
    INSUFFICIENT_BEM: ['钱包 BEM 余额不足。', 'Insufficient BEM balance.'],
    INSUFFICIENT_BNB: ['钱包 BNB 不足以支付本次网络费用。', 'Insufficient BNB for this transaction’s network fee.'],
    INSUFFICIENT_TICKETS: ['剩余份数不足，请减少数量。', 'Too few tickets remain. Reduce the quantity.'],
    ADDRESS_TICKET_LIMIT: ['每个地址每期最多购买 5,000 份。', 'Each address can buy at most 5,000 tickets per round.'],
    ROUND_CHANGED: ['期号已变化，请刷新后重新选择。', 'The round changed. Refresh and select again.'],
    REFUND_UNAVAILABLE: ['该期目前不可领取本金，请核对期号和领取期限。', 'A refund is unavailable for this round. Check the round and claim deadline.'],
    SETTLEMENT_NOT_DUE: ['尚未到结算时间，或该期已结算。', 'Settlement is not due or the round is already settled.'],
    GAS_LIMIT_EXCEEDED: ['该组合所需 Gas 过高，请减少份数或选择更连续的号码。', 'This selection requires too much gas. Reduce the quantity or choose more consecutive numbers.'],
    TRANSACTION_UNRESOLVED: ['上一笔交易结果尚未确认，请先核查交易记录。', 'The previous transaction is unresolved. Check its record first.'],
    RPC_UNAVAILABLE: ['链上状态读取暂时失败，请点击刷新余额与状态重试。', 'Chain state could not be read. Refresh balances and state to retry.'],
    TRANSACTION_IN_FLIGHT: ['正在处理交易，请先完成钱包中的请求。', 'A transaction is being processed. Resolve the wallet request first.'],
    TRANSACTION_LOCK_UNAVAILABLE: ['请在支持安全连接的新版 Chrome 或 Edge 中打开本页。', 'Open this HTTPS page in a current Chrome or Edge browser.'],
    PENDING_STORAGE_UNAVAILABLE: ['浏览器无法保存交易记录，请允许本站存储后重试。', 'Transaction storage is unavailable. Allow storage for this site.'],
  };
  if (copies[error.code]) return t(...copies[error.code]);
  if (error.code === 4001 || error.code === 'ACTION_REJECTED') return t('您取消了钱包请求。', 'You cancelled the wallet request.');
  if (error.code === -32002) return t('钱包中已有待处理请求，请先在钱包中处理。', 'A wallet request is already pending. Open your wallet to resolve it.');
  return t('操作未完成：{message}', 'Could not complete the operation: {message}', { message: String(error.shortMessage ?? error.message ?? error).slice(0, 180) });
}
function poolSnapshot() {
  const current = model.getState();
  return { ...current.rules, id: current.poolId, deployment: pools?.getState().deployment ?? null, salesEnabled: false, available: false, epoch: current.epoch };
}
function dispatchPool() { window.dispatchEvent(new CustomEvent('bem:poolchange', { detail: { pool: poolSnapshot() } })); }
function refreshHistory() { window.dispatchEvent(new CustomEvent('bem:historyrefresh', { detail: { pool: poolSnapshot() } })); }
function applySelectionFields() {
  const selection = model.getState().selection;
  if ($('ticket-count')) $('ticket-count').value = selection.count;
  if ($('selected-tickets')) $('selected-tickets').value = selection.text;
  $('mode-auto')?.setAttribute('aria-pressed', String(selection.mode === 'auto'));
  $('mode-selected')?.setAttribute('aria-pressed', String(selection.mode === 'selected'));
  hidden('auto-fields', selection.mode !== 'auto'); hidden('selected-fields', selection.mode !== 'selected');
}
function onPoolChange(selection) {
  const before = model.getState();
  model.selectPool(selection.id);
  if (before.poolId === selection.id) model.invalidate();
  model.setSelection({ mode: 'auto', count: '1', text: '' });
  state.balanceAbort?.abort(); applySelectionFields();
  state.poolStatus = null; state.poolStatusError = false; state.poolGeneration++;
  clearTestViews();
  put('refund-round', ''); if ($('refund-round')) $('refund-round').value = '';
  hidden('proof-detail', true); render();
  notice(t('已切换至 {amount} BEM 场次，正在读取状态，选号已重置。',
    'Selected the {amount} BEM pool. Checking its state; ticket selection has been reset.', { amount: selection.id }));
  dispatchPool(); refreshBalance(); refreshPoolStatus(); refreshTestState();
}
function renderContractLinks() {
  const target = $('contract-links'); if (!target) return;
  const rules = model.getState().rules;
  const deployment = pools?.getState().deployment;
  const rows = [[t('场次合约', 'Pool contract'), deployment?.address ?? t('正在读取部署记录', 'Loading deployment record'), Boolean(deployment)],
    ['BEM', BEM, true], [t('收款容器', 'Receiving container'), rules.revenueContainer, true],
    [t('开奖处理器', 'Draw processor'), PROCESSOR, true]];
  target.replaceChildren(...rows.flatMap(([label, value, linked]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label;
    if (linked) { const a = document.createElement('a'); a.href = `https://bscscan.com/address/${value}`; a.textContent = value; a.target = '_blank'; a.rel = 'noopener noreferrer'; dd.append(a); }
    else dd.textContent = value;
    return [dt, dd];
  }));
}
function render() {
  const current = model.getState(), rules = current.rules;
  const deployment = pools?.getState().deployment;
  const launch = state.poolStatus?.poolId === current.poolId ? state.poolStatus : null;
  const configured = launch?.seriesAuthorized && launch?.vrf?.consumerAuthorized;
  const meta = poolMetadata({ rules, message: t('该场次暂未开放', 'This pool is not open yet') });
  put('launch-status', deployment ? t('合约已部署', 'Contract deployed') : t('读取部署记录', 'Loading deployment records'));
  put('sale-note', rules.testOnly ? t('1 BEM 内部测试场次，使用 BNB 主网真实 BEM。', 'Internal 1 BEM test pool using real BEM on BNB Chain.')
    : t('{amount} BEM 正式场次合约已部署，暂未开放购买。', 'The {amount} BEM production contract is deployed. Purchases are not open yet.', { amount: rules.id }));
  put('prize-bem', meta.winnerAmount);
  put('purchase-rules', t('每份 {price} BEM · 00001–10000 · 单笔最多 1,000 份',
    '{price} BEM each · 00001–10000 · Up to 1,000 per purchase', { price: meta.unitPrice }));
  put('selected-help', rules.testOnly ? t('已售号码自动顺延补足，成交后以链上实际分配号码为准。剩余份数不足则无法购买。',
    'Sold numbers are skipped and filled with the next available numbers. Final assignments are recorded onchain. Purchases fail if too few tickets remain.')
    : t('已售号码自动顺延。新正式场按链上顺序分配剩余份数，只扣除实际成交金额，未成交金额保留在钱包。',
      'Sold numbers are skipped. New production pools allocate remaining tickets in onchain order and charge only filled tickets. Unspent BEM remains in your wallet.'));
  put('rule-funding', t('凑满 {amount} BEM 封盘，目标在一分钟内开奖；VRF 与网络确认可能延迟。',
    'Sales close at {amount} BEM. The draw targets one minute after closing; VRF and network confirmations can take longer.', { amount: meta.poolTotal }));
  put('rule-refunds', t('24 小时未凑满可退款，须在随后 24 小时内自行领取；截止后未领本金可销毁。每地址每期最多 5,000 份。',
    'Unfilled rounds become refundable after 24 hours. Claim within the next 24 hours; unclaimed principal can then be burned. At most 5,000 tickets per address per round.'));
  put('community-copy', t('您的每一份参与，都在为 Tapeout 生态建设添一份力量。每轮成功开奖，{burn} BEM 转入黑洞销毁，{container} BEM 转入容器，支持社区运营与维护。',
    'Every entry supports the Tapeout ecosystem. Each settled round sends {burn} BEM to the dead address and {container} BEM to the container for community operations.',
    { burn: meta.blackholeAmount, container: meta.organizerAmount }));
  put('community-allocation', t('社区运营是项目用途承诺。本场次每轮成功开奖，{amount} BEM 转入容器，后续支出由该容器所属电路的当前持有人控制。开奖计算使用 2075，抽奖合约不托管 2075。',
    'Community operations are a project commitment. Each settled round in this pool sends {amount} BEM to the container; its circuit’s current holder controls later spending. Draws use 2075 for computation, and the raffle does not hold 2075.', { amount: meta.organizerAmount }));
  put('footer-rules', t('{price} BEM / 份 · 每期 10,000 份', '{price} BEM per ticket · 10,000 per round', { price: meta.unitPrice }));
  put('payout-burn', `${meta.blackholeAmount} BEM`); put('payout-container', `${meta.organizerAmount} BEM`); put('payout-winner', `${meta.winnerAmount} BEM`);
  put('round-label', t('{amount} BEM 场次', '{amount} BEM pool', { amount: rules.id }));
  put('round-phase', rules.testOnly && !launch ? state.poolStatusError ? t('状态读取暂不可用', 'State temporarily unavailable') : t('读取中', 'Loading')
    : configured ? t('已启动', 'Started') : deployment ? t('已部署 · 待启动', 'Deployed · Awaiting start') : t('读取中', 'Loading'));
  const sold = launch ? Number(launch.currentRound.sold) : null;
  put('funding-amount', `${sold == null ? '—' : money(BigInt(sold) * BigInt(rules.ticketPriceBaseUnits))} / ${meta.poolTotal} BEM`);
  put('funding-tickets', t('{count} / 10,000 份', '{count} / 10,000 tickets', { count: sold == null ? '—' : sold.toLocaleString(getLocale()) }));
  const progress = $('funding-progress')?.firstElementChild; if (progress) progress.style.width = `${sold == null ? 0 : sold / 100}%`;
  hidden('countdown-panel', true); put('reel-caption', t('等待本场次开放', 'Awaiting this pool’s launch'));
  put('reel-message', t('等待本场次产生已确认的中奖号码。', 'Awaiting a confirmed winning number for this pool.'));
  for (const step of ['lock', 'random', 'circuit', 'settle']) $('step-' + step)?.classList.remove('active');
  for (const id of ['approve', 'buy', 'refund', 'check-refund', 'replay', 'check-transactions']) disabled(id, true);
  put('purchase-state', rules.testOnly && (state.testReadError || (!launch && state.poolStatusError)) ? t('链上状态读取暂时失败，请刷新余额与状态重试。', 'Chain state is temporarily unavailable. Refresh balances and state to retry.')
    : rules.testOnly && !launch ? t('正在读取测试场链上状态…', 'Reading the test pool’s onchain state…')
    : launch && !launch.vrf.consumerAuthorized ? t('合约已部署，需先添加 VRF 消费者并完成容器启动。', 'Contract deployed. Add the VRF consumer and activate it through the container.')
    : launch && !launch.seriesAuthorized ? t('合约已部署，等待容器授权启动。', 'Contract deployed. Awaiting container activation.')
    : rules.testOnly && configured ? !current.account ? t('测试场已开放，请先连接钱包。', 'The test pool is open. Connect your wallet to continue.')
      : current.chainId !== 56 ? t('测试场已开放，请切换 BNB 主网。', 'The test pool is open. Switch to BNB Chain.')
      : t('测试场已开放，正在核对本钱包的余额与购买权限。', 'The test pool is open. Checking this wallet’s balance and purchase eligibility.')
    : t('该场次暂未开放，选号仅用于预览。', 'This pool is not open yet. Ticket selection is a preview.'));
  hidden('test-start-link', !rules.testOnly);
  put('my-count', '—'); put('my-numbers', configured ? t('连接钱包后查询本期持票。', 'Connect your wallet to see your tickets.')
    : t('场次开放后可查询本期持票。', 'Your tickets will be available to query after this pool opens.'));
  put('refund-amount', '— BEM'); put('refund-state', t('该场次暂未开放，尚无可查询的退款期号。', 'This pool is not open yet. There are no refundable rounds to query.'));
  hidden('transactions', true);
  put('wallet-label', current.account ? t('钱包已连接', 'Wallet connected') : state.wallets.size
    ? t('连接钱包，查看主网余额', 'Connect to view mainnet balances') : t('未检测到浏览器钱包', 'No browser wallet detected'));
  put('wallet-address', current.account ?? '');
  put('connect-wallet', state.connecting ? t('等待钱包…', 'Waiting for wallet…') : current.account ? t('切换钱包', 'Switch wallet') : t('连接钱包', 'Connect wallet'));
  disabled('connect-wallet', state.connecting); disabled('switch-network', state.connecting);
  hidden('switch-network', !current.account || current.chainId === 56);
  hidden('copy-browser-url', state.wallets.size > 0); hidden('browser-help', state.wallets.size > 0);
  if ($('browser-url')) $('browser-url').value = location.href;
  put('wallet-balances', current.balance ? `${money(current.balance.bem)} BEM · ${money(current.balance.bnb, 18)} BNB` : 'BEM — · BNB —');
  put('connection-status', current.account && current.chainId !== 56 ? t('请切换 BNB 主网', 'Switch to BNB Chain') :
    current.balance ? t('BNB 主网 · 区块 {block}', 'BNB Chain · Block {block}', { block: current.balance.block.toLocaleString(getLocale()) }) : t('BNB 主网 · 场次待开放', 'BNB Chain · Pools awaiting launch'));
  put('snapshot-label', launch ? t('已部署核验 · 区块 {block}', 'Deployment verified · Block {block}', { block: launch.snapshot.blockNumber.toLocaleString(getLocale()) })
    : deployment ? t('部署已核验 · 正在读取启动状态', 'Deployment verified · Checking activation') : t('正在读取部署记录', 'Loading deployment record'));
  try {
    const selection = model.preview();
    put('purchase-total', `${money(selection.amountBaseUnits)} BEM`);
    put('selection-note', t('预选 {count} 份 · 成交号码以链上实际分配为准', '{count} tickets previewed · Final assigned numbers are recorded onchain', { count: selection.quantity.toLocaleString(getLocale()) }));
  } catch (error) { put('purchase-total', '— BEM'); put('selection-note', errorCopy(error)); }
  renderContractLinks(); renderTestControls();
  if (!current.account) { disabled('approve', state.connecting); disabled('buy', state.connecting); }
  pendingPoller?.update();
}
async function rpc(method, params, signal) {
  return batchedRead(method, params, signal);
}
async function refreshPoolStatus() {
  const generation = ++state.poolGeneration, poolId = model.getState().poolId;
  try {
    const response = await fetch(`/api/pools/${poolId}/status`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Pool status unavailable');
    const result = await response.json();
    if (generation !== state.poolGeneration || poolId !== model.getState().poolId) return;
    const deployment = pools?.getState().deployment;
    if (result.schemaVersion !== 2 || result.chainId !== 56 || result.poolId !== poolId || !result.runtimeVerified ||
      !same(result.gameAddress, deployment?.address) || !Number.isSafeInteger(result.snapshot?.blockNumber)) throw new Error('Invalid pool state');
    state.poolStatus = result; state.poolStatusError = false; render();
  } catch {
    if (generation === state.poolGeneration) { state.poolStatus = null; state.poolStatusError = true; render(); }
  }
}
async function refreshBalance() {
  const version = ++state.balanceGeneration; state.balanceAbort?.abort();
  const snapshot = model.getState();
  if (!snapshot.account || snapshot.chainId !== 56) return;
  const controller = new AbortController(); state.balanceAbort = controller; state.refreshing = true;
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const [chainId, block] = await Promise.all([rpc('eth_chainId', [], controller.signal), rpc('eth_blockNumber', [], controller.signal)]);
    if (BigInt(chainId) !== 56n) throw new Error(t('主网节点网络不匹配。', 'The RPC network does not match BNB Chain.'));
    const [bemRaw, bnb] = await Promise.all([
      rpc('eth_call', [{ to: BEM, data: tokenInterface.encodeFunctionData('balanceOf', [snapshot.account]) }, toQuantity(BigInt(block))], controller.signal),
      rpc('eth_getBalance', [snapshot.account, toQuantity(BigInt(block))], controller.signal),
    ]);
    if (version !== state.balanceGeneration) return;
    model.acceptBalance(snapshot, { bem: tokenInterface.decodeFunctionResult('balanceOf', bemRaw)[0], bnb, block: Number(BigInt(block)) }); render();
  } catch (error) {
    if (version !== state.balanceGeneration || !model.isCurrent(snapshot)) return;
    if (error.name !== 'AbortError') notice(errorCopy(error), true);
  } finally { clearTimeout(timeout); if (version === state.balanceGeneration) state.refreshing = false; }
}
function walletChanged(accounts) {
  const attempt = state.connectAttempt;
  if (Array.isArray(accounts) && attempt && state.connecting && attempt.wallet === state.wallet && attempt.version === state.connectVersion) {
    // Initial permission commonly emits accountsChanged before requestAccounts resolves.
    // Record that identity, then require it to agree with the request and final reads.
    if (attempt.waitingForApproval) { attempt.observedAccounts = [...accounts]; return; }
    if (accounts.length && same(accounts[0], attempt.account)) return;
  }
  state.connectAttempt = null;
  state.connectVersion++; state.connecting = false;
  model.setWallet(null, null); clearTestViews(); state.balanceAbort?.abort(); render();
  notice(t('钱包或网络已变化，请重新连接。选号预览不会提交交易。', 'The wallet or network changed. Reconnect to continue. Ticket previews never submit transactions.'));
}
function detachWallet() { for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) state.wallet?.removeListener?.(event, walletChanged); }
function clearTestViews() {
  state.testGeneration++; state.testRefreshing = false; state.testReadError = false;
  state.testView = null; state.refundView = null; state.settlementView = null;
}
const testViewCurrent = view => view && model.isCurrent(view.context);
async function refreshTestState() {
  const context = model.getState(), transactions = currentTransactions();
  if (!transactions || !context.account || context.chainId !== 56 || state.testRefreshing) return;
  const generation = ++state.testGeneration; state.testRefreshing = true; state.testReadError = false;
  try {
    const result = await transactions.readState(context.account);
    if (generation !== state.testGeneration || !model.isCurrent(context)) return;
    state.testView = { ...result, context }; state.settlementView = null;
    if (result.currentRoundId > 1n && result.round.status === 0) {
      const previous = await transactions.readState(context.account, { roundId: result.currentRoundId - 1n });
      if (generation !== state.testGeneration || !model.isCurrent(context)) return;
      state.settlementView = { ...previous, context };
    }
    if (result.canSettle) state.settlementView = { ...result, context };
    render();
  } catch (error) {
    if (generation === state.testGeneration && model.isCurrent(context)) { state.testView = null; state.settlementView = null; state.testReadError = true; render(); notice(errorCopy(error), true); }
  } finally { if (generation === state.testGeneration) state.testRefreshing = false; }
}
function renderTestControls() {
  const context = model.getState(), internal = context.poolId === '1';
  const transactions = currentTransactions();
  hidden('settle-test', true);
  if (!transactions) return;
  const txState = transactions.getState(), view = testViewCurrent(state.testView) ? state.testView : null;
  if (!internal) partialFillResult.accept(txState.records);
  const refund = testViewCurrent(state.refundView) ? state.refundView : null;
  const settlement = testViewCurrent(state.settlementView) ? state.settlementView : null;
  const connected = Boolean(context.account && context.chainId === 56);
  disabled('check-refund', !connected || txState.busy);
  disabled('refund', !refund?.canRefund || txState.blocking);
  if (refund) {
    put('refund-amount', `${money(refund.refundAmount)} BEM`);
    put('refund-state', refund.canRefund ? t('请在 {time} 前领取到当前钱包。', 'Claim to your connected wallet before {time}.', { time: new Date(Number(refund.refundDeadline)*1000).toLocaleString(getLocale()) }) : t('该期目前没有可领取本金。', 'No principal is claimable for this round right now.'));
  }
  if (view) {
    // The verified wallet snapshot is also the current round snapshot. Do not
    // leave progress blank merely because the separate public status API failed.
    put('funding-amount', `${money(view.round.sold * BigInt(context.rules.ticketPriceBaseUnits))} / ${context.poolId} BEM`);
    put('funding-tickets', t('{count} / 10,000 份', '{count} / 10,000 tickets', { count: view.round.sold.toLocaleString(getLocale()) }));
    const progress = $('funding-progress')?.firstElementChild;
    if (progress) progress.style.width = `${Number(view.round.sold) / 100}%`;
    put('snapshot-label', t('链上已核验 · 区块 {block}', 'Onchain state verified · Block {block}', { block: view.blockNumber.toLocaleString(getLocale()) }));
    put('my-count', view.myCount.toLocaleString(getLocale()));
    put('my-numbers', t('第 {round} 期 · 已持有 {count} 份。具体号码可查看已确认购买交易。', 'Round {round} · You hold {count} tickets. Check confirmed purchase transactions for their numbers.', { round: view.roundId.toString(), count: view.myCount.toString() }));
    put('round-label', internal ? t('1 BEM 测试 · 第 {round} 期', '1 BEM test · Round {round}', { round: view.roundId.toString() })
      : t('{amount} BEM · 第 {round} 期', '{amount} BEM · Round {round}', { amount: context.poolId, round: view.roundId.toString() }));
    if (view.seriesAuthorized && view.consumerAuthorized && view.round.status === 1 && view.timestamp < view.round.fundingDeadline) {
      put('launch-status', internal ? t('1 BEM 测试已开放', '1 BEM test open') : t('{amount} BEM 场次已开放', '{amount} BEM pool open', { amount: context.poolId }));
      put('round-phase', t('购买中', 'Funding'));
      put('purchase-state', internal ? t('单笔最多 1,000 份（0.1 BEM），本地址本期还可购买 {count} 份。', 'Up to 1,000 tickets (0.1 BEM) per transaction. This address can buy {count} more this round.', { count: (5000n-view.myCount).toLocaleString(getLocale()) })
        : t('单笔最多 1,000 份，本地址本期还可购买 {count} 份。份数不足时按实际成交扣款。',
          'Up to 1,000 tickets per purchase. This address can buy {count} more this round. Only filled tickets are charged.', { count: (5000n-view.myCount).toLocaleString(getLocale()) }));
      try {
        const selection = model.preview(), amount = BigInt(selection.amountBaseUnits), qty = BigInt(selection.quantity);
        const fill = internal ? qty : [qty, 10000n - view.round.sold, 5000n - view.myCount].reduce((a, b) => a < b ? a : b);
        const payable = fill * BigInt(context.rules.ticketPriceBaseUnits);
        const allowed = view.canBuy && !txState.blocking && view.bemBalance >= payable &&
          (!internal || qty + view.myCount <= 5000n && qty + view.round.sold <= 10000n);
        disabled('approve', !allowed || (internal && view.bemBalance < amount) || view.allowance >= payable); disabled('buy', !allowed || view.allowance < payable);
        if (txState.blocking) {
          const pending = txState.records.find(record => !['confirmed', 'reverted'].includes(record.status));
          put('purchase-state', txState.storageError ? errorCopy({ code: 'PENDING_STORAGE_UNAVAILABLE' })
            : pending ? transactionStatusCopy(pending)
            : t('正在准备交易，请在钱包中确认。', 'Preparing the transaction. Confirm it in your wallet.'));
        }
        else if (view.bemBalance < payable) put('purchase-state', t('场次已开放。钱包现有 {balance} BEM，本次需 {amount} BEM，余额不足。',
          'The pool is open. Your wallet has {balance} BEM; this purchase needs {amount} BEM. The balance is insufficient.', { balance: money(view.bemBalance), amount: money(payable) }));
        else if (view.myCount >= 5000n || internal && qty + view.myCount > 5000n) put('purchase-state', t('本地址本期还可购买 {count} 份，请调整购买数量。',
          'This address can buy {count} more tickets this round. Adjust the quantity.', { count: (5000n - view.myCount).toLocaleString(getLocale()) }));
        else if (view.round.sold >= 10000n || internal && qty + view.round.sold > 10000n) put('purchase-state', t('本期仅剩 {count} 份，请调整购买数量。',
          'Only {count} tickets remain in this round. Adjust the quantity.', { count: (10000n - view.round.sold).toLocaleString(getLocale()) }));
        else if (!view.canBuy && view.subscriptionNativeBalance === 0n) put('purchase-state', t('场次已启动，VRF 订阅余额不足，暂时无法购买。',
          'The pool has started, but its VRF subscription balance is insufficient for purchases.'));
      } catch (error) { disabled('approve', true); disabled('buy', true); put('purchase-state', errorCopy(error)); }
    }
    if (view.round.status === 1) {
      hidden('countdown-panel', false); put('countdown-label', t('本期购买截止', 'Funding closes'));
      put('countdown-value', new Date(Number(view.round.fundingDeadline)*1000).toLocaleString(getLocale()));
      put('countdown-note', t('未售满时，截止后的 24 小时内可自行领取本金。', 'If unfilled, claim your principal within 24 hours after this deadline.'));
    }
  }
  if (settlement && [3,4,5].includes(settlement.round.status)) {
    put('round-phase', settlement.round.status === 5 ? t('已结算', 'Settled') : settlement.round.status === 4 ? t('等待结算', 'Awaiting settlement') : t('等待 VRF', 'Awaiting VRF'));
    put('reel-message', settlement.round.status === 5 ? t('本期已结算，确认后的中奖记录将显示在播报和历史中。', 'Settled. Confirmed winnings will appear in announcements and history.') : t('本期已封盘，等待随机数确认及结算。', 'Sales are closed. Awaiting randomness and settlement.'));
    hidden('settle-test', settlement.round.status !== 4); disabled('settle-test', !settlement.canSettle || txState.blocking);
    put('settle-test', internal ? t('结算第 {round} 期测试', 'Settle test round {round}', { round: settlement.roundId.toString() })
      : t('结算第 {round} 期', 'Settle round {round}', { round: settlement.roundId.toString() }));
  }
  hidden('transactions', txState.records.length === 0 && !txState.storageError);
  disabled('check-transactions', txState.busy);
  hidden('unknown-test-transaction', !txState.records.some(r => !r.hash));
  const target = $('transaction-list'); if (!target) return;
  target.replaceChildren();
  if (txState.storageError) { const p = document.createElement('p'); p.textContent = t('无法读取本地交易记录，已暂停交易，请检查浏览器存储权限。', 'Local transaction records are unavailable. Transactions are paused; check browser storage permissions.'); target.append(p); }
  for (const record of txState.records) {
    const row = document.createElement('article'); row.className = 'tx-entry';
    const labels = { approve: t('授权', 'Approval'), buy: t('购买', 'Purchase'), refund: t('领取本金', 'Refund'), settle: t('结算', 'Settlement') };
    const label = document.createElement('strong'); label.textContent = `${labels[record.kind] ?? ''} · ${transactionStatusCopy(record)}`;
    row.append(label);
    const who = document.createElement('p'); who.textContent = t('钱包 {account} · 第 {round} 期', 'Wallet {account} · Round {round}', { account: record.account ?? '—', round: record.input?.roundId ?? '—' }); row.append(who);
    if (record.hash) { const a = document.createElement('a'); a.href = `https://bscscan.com/tx/${record.hash}`; a.textContent = record.hash; a.target = '_blank'; a.rel = 'noopener noreferrer'; row.append(a); }
    if (record.evidence?.tickets?.length) { const p=document.createElement('p'); p.textContent=t('实际分配号码：{numbers}', 'Assigned numbers: {numbers}', { numbers:record.evidence.tickets.join(', ') }); row.append(p); }
    if (record.evidence?.progress) { const p=document.createElement('p');p.textContent=t('已推进计算，还需继续点击结算。', 'Computation progressed. Click settlement again to continue.');row.append(p); }
    target.append(row);
  }
}
function transactionStatusCopy(record) {
  if (record.status === 'confirmed') return t('已上链确认', 'Confirmed onchain');
  if (record.status === 'reverted') return t('交易失败', 'Transaction reverted');
  if (record.status === 'confirming') return t('已上链 · {count}/{required} 个确认', 'Included onchain · {count}/{required} confirmations',
    { count: record.confirmations ?? 0, required: record.requiredConfirmations ?? (['approve', 'buy'].includes(record.kind) ? 1 : 12) });
  if (record.status === 'awaiting_wallet') return t('等待钱包确认', 'Awaiting wallet confirmation');
  if (record.status === 'pending') return ['approve', 'buy'].includes(record.kind)
    ? t('已提交，等待上链；每 2 秒自动更新状态。', 'Submitted; awaiting inclusion. Status refreshes every 2 seconds.')
    : t('已提交，等待上链。', 'Submitted; awaiting inclusion.');
  return record.hash ? t('已提交，节点暂未返回明确结果，正在自动刷新。', 'Submitted; the node has not returned a definite result. Refreshing automatically.')
    : t('钱包未返回交易哈希，请查看钱包或填写哈希核实。', 'No transaction hash was returned. Check your wallet or enter its hash.');
}
async function queryTestRefund() {
  const context = model.getState(), transactions = currentTransactions(); state.refundView = null; render();
  if (!transactions || !context.account || context.chainId !== 56) return;
  const text = $('refund-round')?.value.trim();
  if (!/^[1-9][0-9]{0,76}$/.test(text ?? '')) { notice(t('请输入正确的期号。', 'Enter a valid round number.'), true); return; }
  try {
    const result = await transactions.readState(context.account, { roundId: text });
    if (!model.isCurrent(context) || text !== $('refund-round')?.value.trim()) return;
    state.refundView = { ...result, context }; render();
  } catch (error) { if (model.isCurrent(context)) notice(errorCopy(error), true); }
}
async function executeTestAction(kind) {
  if (['approve', 'buy'].includes(kind) && !model.getState().account) {
    if (!state.connecting) picker.open();
    return;
  }
  const transactions = currentTransactions();
  if (!transactions) { notice(errorCopy({ code: 'POOL_NOT_LAUNCHED' }), true); return; }
  try {
    const view = kind === 'refund' ? state.refundView : kind === 'settle' ? state.settlementView : state.testView;
    if (!testViewCurrent(view)) throw Object.assign(new Error(), { code: 'CONTEXT_CHANGED' });
    const selection = ['approve','buy'].includes(kind) ? model.preview() : null;
    notice(t('正在核对本次交易，随后请在钱包中确认。', 'Checking the transaction. Then confirm it in your wallet.'));
    await transactions.execute(kind, { roundId: view.roundId, ...(selection ? { quantity: selection.quantity, tickets: selection.tickets } : {}) });
    notice(t('交易已提交，正在自动查询上链结果。', 'Transaction submitted. Checking its onchain result automatically.'));
    await checkPlayerTransactions();
    if (kind === 'refund') await queryTestRefund();
  } catch (error) { notice(errorCopy(error), true); }
  finally { render(); }
}
async function checkPlayerTransactions() {
  const wasBlocking = currentTransactions()?.getState().blocking;
  await pendingPoller.checkNow();
  // The completion callback already refreshes a newly unlocked wallet.
  if (!wasBlocking) await refreshTestState();
}
async function connect(entry) {
  if (state.connecting) return; state.connecting = true; const version = ++state.connectVersion;
  detachWallet(); state.wallet = entry.provider; model.setWallet(null, null); state.balanceAbort?.abort();
  clearTestViews();
  const wallet = state.wallet;
  const attempt = { version, wallet, waitingForApproval: true, observedAccounts: null, account: null };
  state.connectAttempt = attempt;
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) wallet.on?.(event, walletChanged);
  render();
  try {
    const requested = await wallet.request({ method: 'eth_requestAccounts' });
    attempt.waitingForApproval = false; attempt.account = requested?.[0] ?? null;
    if (version !== state.connectVersion || wallet !== state.wallet || !requested?.length ||
      (attempt.observedAccounts !== null && !same(attempt.observedAccounts[0], requested[0]))) {
      throw new Error(t('钱包发生变化，请重新连接。', 'The wallet changed. Please reconnect.'));
    }
    const chain = await wallet.request({ method: 'eth_chainId' });
    const accounts = await wallet.request({ method: 'eth_accounts' });
    const finalChain = await wallet.request({ method: 'eth_chainId' });
    if (version !== state.connectVersion || wallet !== state.wallet || !requested?.length || !accounts?.length ||
      !same(requested[0], accounts[0]) || BigInt(chain) !== BigInt(finalChain)) throw new Error(t('钱包发生变化，请重新连接。', 'The wallet changed. Please reconnect.'));
    model.setWallet(getAddress(accounts[0]), Number(BigInt(finalChain)));
    notice(t('钱包已连接，正在读取余额和场次状态。', 'Wallet connected. Reading balances and pool status.'));
    refreshBalance();
    refreshTestState();
  } catch (error) { if (version === state.connectVersion) notice(errorCopy(error), true); }
  finally {
    if (state.connectAttempt === attempt) state.connectAttempt = null;
    if (version === state.connectVersion) state.connecting = false; render();
  }
}
function selectTab(tab) {
  state.tab = tab;
  for (const name of ['draw', 'proof']) { hidden('panel-' + name, name !== tab); $('tab-' + name)?.setAttribute('aria-selected', String(name === tab)); }
  if (tab === 'proof') refreshHistory();
}

initLanguage();
testTransactions = createTestPlayerTransactions({ wallet: () => state.wallet, getContext: () => model.getState(), readRpc: rpc, onUpdate: () => render() });
for (const poolId of ['10', '50', '100']) formalTransactions.set(poolId,
  createFormalPlayerTransactions({ poolId, wallet: () => state.wallet, getContext: () => model.getState(), readRpc: rpc, onUpdate: () => render() }));
pendingPoller = createPendingReadPoller({ getManager: currentTransactions,
  onResolved: async manager => {
    if (manager !== currentTransactions()) return;
    clearTestViews(); render();
    await refreshTestState(); refreshBalance(); refreshHistory();
  },
  onError: error => notice(errorCopy(error), true),
});
pools = createPoolSelection({ mount: $('pool-selection'), search: location.search, autoLoad: false, onChange: onPoolChange });
const picker = createWalletPicker({ dialog: $('wallet-picker'), onSelect: connect, onChange: wallets => { state.wallets = wallets; render(); } });
$('connect-wallet')?.addEventListener('click', () => { if (!state.connecting) picker.open(); });
$('copy-browser-url')?.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); notice(t('已复制网址，请在安装钱包的浏览器中打开。', 'URL copied. Open it in a browser with your wallet installed.')); }
  catch { notice(t('请复制浏览器地址栏中的网址。', 'Copy the URL from your browser’s address bar.')); }
});
$('switch-network')?.addEventListener('click', async () => {
  if (!state.wallet || state.connecting) return; state.connecting = true; const wallet = state.wallet;
  model.invalidate(); state.balanceAbort?.abort(); render();
  try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
    notice(t('已请求切换 BNB 主网，请重新连接钱包。', 'BNB Chain switch requested. Reconnect your wallet.')); }
  catch (error) { notice(errorCopy(error), true); }
  finally { model.setWallet(null, null); state.connecting = false; render(); }
});
for (const mode of ['auto', 'selected']) $('mode-' + mode)?.addEventListener('click', () => {
  model.setSelection({ mode }); applySelectionFields(); render();
});
if ($('ticket-count')) { $('ticket-count').max = '1000'; $('ticket-count').addEventListener('input', () => { model.setSelection({ count: $('ticket-count').value }); render(); }); }
if ($('selected-tickets')) { $('selected-tickets').maxLength = 8000; $('selected-tickets').addEventListener('input', () => { model.setSelection({ text: $('selected-tickets').value }); render(); }); }
for (const button of document.querySelectorAll('[data-count]')) button.addEventListener('click', () => {
  model.setSelection({ count: button.dataset.count, mode: 'auto' }); applySelectionFields(); render();
});
for (const id of ['approve', 'buy', 'refund']) $(id)?.addEventListener('click', event => { event.preventDefault(); executeTestAction(id); });
$('check-refund')?.addEventListener('click', queryTestRefund);
$('refund-round')?.addEventListener('input', () => { state.refundView = null; render(); });
$('settle-test')?.addEventListener('click', () => executeTestAction('settle'));
$('check-transactions')?.addEventListener('click', async () => { try { await checkPlayerTransactions(); } catch(error) { notice(errorCopy(error), true); } });
$('attach-test-hash')?.addEventListener('click', async () => { try { await currentTransactions()?.attachHash($('unknown-test-hash')?.value.trim()); await refreshTestState(); } catch(error) { notice(errorCopy(error), true); } });
for (const tab of ['draw', 'proof']) $('tab-' + tab)?.addEventListener('click', () => selectTab(tab));
window.addEventListener('bem:languagechange', () => { render(); partialFillResult.refreshLanguage(); if (!state.noticeError) notice(t('请核对所选场次与钱包，交易需在钱包中确认。', 'Review the selected pool and wallet. Confirm transactions in your wallet.')); else put('notice', translateKnown($('notice')?.textContent ?? '')); });
put('history-summary', t('本场次暂无已确认的往期开奖。', 'No confirmed past draws are available for this pool.'));
notice(t('正在读取场次信息。连接钱包后可查看余额与参与状态。', 'Reading pool information. Connect your wallet to view balances and participation status.'));
applySelectionFields(); render(); dispatchPool(); pools.load();
setInterval(() => { if (document.visibilityState === 'visible') {
  refreshBalance(); refreshPoolStatus(); refreshTestState();
  const transactions = currentTransactions();
  const transactionState = transactions?.getState();
  if (!hasFastPendingRead(transactionState) && transactionState?.records.some(r => !['confirmed','reverted'].includes(r.status))) pendingPoller.checkNow();
} }, 15000);
window.addEventListener('storage', () => { pendingPoller.checkNow(); });
window.addEventListener('beforeunload', () => { pendingPoller.destroy(); state.balanceAbort?.abort(); pools.destroy(); detachWallet(); });
