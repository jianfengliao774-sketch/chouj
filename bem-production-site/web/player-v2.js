import { Interface, formatUnits, getAddress, toQuantity } from 'ethers';
import { t, getLocale, initLanguage, translateKnown } from './player-i18n.js';
import { createWalletPicker } from './wallet-picker.js';
import { createPoolSelection, poolMetadata } from './pool-selection.js';
import { createPendingPlayerState } from './player-v2-state.js';

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
const state = { wallet: null, wallets: new Map(), connecting: false, connectVersion: 0, balanceGeneration: 0,
  balanceAbort: null, refreshing: false, noticeError: false, rpcId: 0, tab: 'draw' };
let pools = null;

function notice(message, error = false) { put('notice', message); $('notice')?.classList.toggle('error-copy', error); state.noticeError = error; }
function errorCopy(error) {
  const copies = {
    TICKET_LIMIT: ['单笔请选择 1–1,000 份，每地址每期最多 5,000 份。', 'Choose 1–1,000 tickets per purchase; at most 5,000 per address per round.'],
    TICKET_RANGE: ['票号范围为 1–10000，起点不能大于终点。', 'Tickets range from 1 to 10000. A range must start with its smaller number.'],
    TICKET_FORMAT: ['请用逗号分隔号码，连续号段如 100-110。', 'Use comma-separated ticket numbers or ranges such as 100-110.'],
    NO_TICKETS: ['请输入您要选择的票号。', 'Enter the ticket numbers you want.'],
    POOL_NOT_LAUNCHED: ['该场次暂未开放，暂不接受授权、购买或退款交易。', 'This pool is not open yet. Approvals, purchases and refund transactions are unavailable.'],
  };
  if (copies[error.code]) return t(...copies[error.code]);
  if (error.code === 4001 || error.code === 'ACTION_REJECTED') return t('您取消了钱包请求。', 'You cancelled the wallet request.');
  if (error.code === -32002) return t('钱包中已有待处理请求，请先在钱包中处理。', 'A wallet request is already pending. Open your wallet to resolve it.');
  return t('操作未完成：{message}', 'Could not complete the operation: {message}', { message: String(error.shortMessage ?? error.message ?? error).slice(0, 180) });
}
function poolSnapshot() {
  const current = model.getState();
  return { ...current.rules, id: current.poolId, deployment: null, salesEnabled: false, available: false, epoch: current.epoch };
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
  put('refund-round', ''); if ($('refund-round')) $('refund-round').value = '';
  hidden('proof-detail', true); render();
  notice(t('已切换至 {amount} BEM 场次。该场次暂未开放，选号已重置。',
    'Selected the {amount} BEM pool. It is not open yet; ticket selection has been reset.', { amount: selection.id }));
  dispatchPool(); refreshBalance();
}
function renderContractLinks() {
  const target = $('contract-links'); if (!target) return;
  const rules = model.getState().rules;
  const rows = [[t('场次合约', 'Pool contract'), t('待部署并核验', 'Awaiting deployment and verification'), false],
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
  const meta = poolMetadata({ rules, message: t('该场次暂未开放', 'This pool is not open yet') });
  put('launch-status', t('新场次待开放', 'New pools awaiting launch'));
  put('sale-note', rules.testOnly ? t('1 BEM 内部测试场次，使用 BNB 主网真实 BEM，待部署核验后开放。',
    'Internal 1 BEM test pool using real BEM on BNB Chain. It will open after deployment verification.')
    : t('{amount} BEM 场次待部署与链上核验，当前暂不接受购买。', 'The {amount} BEM pool awaits deployment and onchain verification. Purchases are not open yet.', { amount: rules.id }));
  put('prize-bem', meta.winnerAmount);
  put('purchase-rules', t('每份 {price} BEM · 00001–10000 · 单笔最多 1,000 份',
    '{price} BEM each · 00001–10000 · Up to 1,000 per purchase', { price: meta.unitPrice }));
  put('selected-help', t('已售号码自动顺延补足，成交后以链上实际分配号码为准。剩余份数不足则无法购买。',
    'Sold numbers are skipped and filled with the next available numbers. Final assignments are recorded onchain. Purchases fail if too few tickets remain.'));
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
  put('round-phase', t('待开放', 'Not open yet'));
  put('funding-amount', `— / ${meta.poolTotal} BEM`); put('funding-tickets', t('— / 10,000 份', '— / 10,000 tickets'));
  const progress = $('funding-progress')?.firstElementChild; if (progress) progress.style.width = '0%';
  hidden('countdown-panel', true); put('reel-caption', t('等待本场次开放', 'Awaiting this pool’s launch'));
  put('reel-message', t('本场次尚未部署，暂无链上中奖号码。', 'This pool is not deployed yet. There is no onchain winning number.'));
  for (const step of ['lock', 'random', 'circuit', 'settle']) $('step-' + step)?.classList.remove('active');
  for (const id of ['approve', 'buy', 'refund', 'check-refund', 'replay', 'check-transactions']) disabled(id, true);
  put('purchase-state', t('该场次暂未开放，选号仅用于预览。', 'This pool is not open yet. Ticket selection is a preview.'));
  put('my-count', '—'); put('my-numbers', t('场次开放后可查询本期持票。', 'Your tickets will be available to query after this pool opens.'));
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
  put('snapshot-label', t('新场次配置 · 待部署核验', 'New pool configuration · Awaiting deployment verification'));
  try {
    const selection = model.preview();
    put('purchase-total', `${money(selection.amountBaseUnits)} BEM`);
    put('selection-note', t('预选 {count} 份 · 成交号码以链上实际分配为准', '{count} tickets previewed · Final assigned numbers are recorded onchain', { count: selection.quantity.toLocaleString(getLocale()) }));
  } catch (error) { put('purchase-total', '— BEM'); put('selection-note', errorCopy(error)); }
  renderContractLinks();
}
async function rpc(method, params, signal) {
  if (!['eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_call'].includes(method)) throw new Error('Read-only method required');
  const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++state.rpcId, method, params }), signal });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(t('主网余额读取暂时不可用。', 'Mainnet balances are temporarily unavailable.'));
  const result = await response.json(); if (result.error || result.result == null) throw new Error(t('主网余额读取暂时不可用。', 'Mainnet balances are temporarily unavailable.'));
  return result.result;
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
function walletChanged() {
  model.setWallet(null, null); state.balanceAbort?.abort(); render();
  notice(t('钱包或网络已变化，请重新连接。选号预览不会提交交易。', 'The wallet or network changed. Reconnect to continue. Ticket previews never submit transactions.'));
}
function detachWallet() { for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) state.wallet?.removeListener?.(event, walletChanged); }
async function connect(entry) {
  if (state.connecting) return; state.connecting = true; const version = ++state.connectVersion;
  detachWallet(); state.wallet = entry.provider; model.setWallet(null, null); state.balanceAbort?.abort();
  const wallet = state.wallet;
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) wallet.on?.(event, walletChanged);
  render();
  try {
    const requested = await wallet.request({ method: 'eth_requestAccounts' });
    const chain = await wallet.request({ method: 'eth_chainId' });
    const accounts = await wallet.request({ method: 'eth_accounts' });
    const finalChain = await wallet.request({ method: 'eth_chainId' });
    if (version !== state.connectVersion || wallet !== state.wallet || !requested?.length || !accounts?.length ||
      !same(requested[0], accounts[0]) || BigInt(chain) !== BigInt(finalChain)) throw new Error(t('钱包发生变化，请重新连接。', 'The wallet changed. Please reconnect.'));
    model.setWallet(getAddress(accounts[0]), Number(BigInt(finalChain)));
    notice(t('钱包已连接。您可以查看余额与场次规则；该场次暂未开放。', 'Wallet connected. View balances and pool rules; this pool is not open yet.'));
    refreshBalance();
  } catch (error) { notice(errorCopy(error), true); }
  finally { if (version === state.connectVersion) state.connecting = false; render(); }
}
function selectTab(tab) {
  state.tab = tab;
  for (const name of ['draw', 'proof']) { hidden('panel-' + name, name !== tab); $('tab-' + name)?.setAttribute('aria-selected', String(name === tab)); }
  if (tab === 'proof') refreshHistory();
}

initLanguage();
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
for (const id of ['approve', 'buy', 'refund', 'check-refund']) $(id)?.addEventListener('click', event => {
  event.preventDefault(); try { model.requireWriteAllowed(); } catch (error) { notice(errorCopy(error), true); }
});
for (const tab of ['draw', 'proof']) $('tab-' + tab)?.addEventListener('click', () => selectTab(tab));
window.addEventListener('bem:languagechange', () => { render(); if (!state.noticeError) notice(t('该场次暂未开放，可先查看场次规则并连接钱包查看余额。', 'This pool is not open yet. Review its rules and connect to view balances.')); else put('notice', translateKnown($('notice')?.textContent ?? '')); });
put('history-summary', t('新场次尚未部署，暂无往期开奖记录。', 'New pools are not deployed yet. No past draw records are available.'));
notice(t('该场次暂未开放，可先查看场次规则并连接钱包查看余额。', 'This pool is not open yet. Review its rules and connect to view balances.'));
applySelectionFields(); render(); dispatchPool(); pools.load();
setInterval(() => { if (document.visibilityState === 'visible') refreshBalance(); }, 15000);
window.addEventListener('beforeunload', () => { state.balanceAbort?.abort(); pools.destroy(); detachWallet(); });
