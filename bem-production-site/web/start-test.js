import { getAddress, formatEther, toQuantity } from 'ethers';
import { createWalletPicker } from './wallet-picker.js';
import { START_FIXED as F, START_ACTIONS, START_ABI as ABI, same, need, uint, isHash,
  actionTransaction, assertSnapshot, assertActionReady, assertIntent, restoreRecord, assertTransaction, assertReceipt, assertReceiptEvents } from './start-test-guards.js';

const $ = id => document.getElementById(id);
const STORAGE = 'bem2075-test1-start-configuration-v1';
const state = { wallet: null, account: null, chainId: null, epoch: 0, busy: false, locking: false, connectAttempt: null,
  action: null, estimate: null, snapshot: null, records: {}, storageError: false };
const actions = Object.keys(START_ACTIONS);
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function errorText(error) {
  if (error.code === 4001 || error.code === 'ACTION_REJECTED') return '您取消了钱包确认，本步骤未提交。';
  if (error.code === -32002) return '钱包中已有待处理请求，请先在钱包中处理。';
  return String(error.shortMessage ?? error.message ?? error).slice(0, 240);
}
function fields(id, rows) {
  $(id).replaceChildren(...rows.flatMap(([label, value, kind]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label;
    if (kind && value) {
      const a = document.createElement('a'); a.href = `https://bscscan.com/${kind}/${value}`;
      a.textContent = value; a.target = '_blank'; a.rel = 'noopener noreferrer'; dd.append(a);
    } else dd.textContent = value ?? '—';
    if (String(value ?? '').length > 30) dd.classList.add('mono'); return [dt, dd];
  }));
}
function clearEstimate() { state.estimate = null; $('confirm-review').checked = false; $('review-panel').hidden = true; }
function controls() {
  const busy = state.busy || state.locking, connected = state.wallet && state.account && state.chainId === 56;
  $('connect-wallet').disabled = busy; $('refresh-status').disabled = busy; $('switch-network').disabled = busy;
  $('switch-network').hidden = !state.wallet || state.chainId === 56;
  for (const action of actions) {
    let eligible = false;
    try { if (connected && state.snapshot) { assertActionReady(action, state.snapshot, state.account); eligible = true; } } catch { /* Status copy explains readiness. */ }
    $(`review-${action}`).disabled = busy || !eligible || Boolean(state.records[action]) || state.storageError || Boolean($(`${action}-hash`).value.trim());
    $(`verify-${action}`).disabled = busy || !connected;
    $(`${action}-hash`).disabled = busy;
    $(`reset-${action}`).hidden = state.records[action]?.status !== 'failed';
    $(`reset-${action}`).disabled = busy || !connected;
  }
  const current = state.estimate && connected && state.estimate.expiresAt > Date.now() && !state.records[state.action] && !state.storageError;
  $('confirm-review').disabled = busy || !current;
  $('send-action').disabled = busy || !current || !$('confirm-review').checked;
  if (state.estimate) $('estimate-expiry').textContent = state.estimate.expiresAt > Date.now() ? `核对有效期：${Math.ceil((state.estimate.expiresAt - Date.now()) / 1000)} 秒` : '已过期，请重新核对';
}
function renderSnapshot(snapshot = state.snapshot, publicOnly = false) {
  const s = snapshot;
  fields('status-fields', [
    ['测试合约', F.game, 'address'], ['运行代码哈希', F.runtimeHash], ['每期金额', '1 BEM · 10,000 份 · 每份 0.0001 BEM'],
    ['收款容器', F.revenueContainer, 'address'], ['启动授权容器', F.authorizationContainer, 'address'],
    ['VRF 订阅 ID', F.subscriptionId], ['VRF 订阅所有者', s?.subscriptionOwner, s ? 'address' : null],
    ['容器当前持有人', s?.containerOwner, s ? 'address' : null], ['VRF 订阅 BNB', s ? `${formatEther(s.subscriptionNativeWei)} BNB` : '—'],
    ['容器 BNB', s ? `${formatEther(s.containerNativeWei)} BNB` : '—'], ['容器执行协议费', s ? `${formatEther(s.execFeeWei)} BNB` : '—'],
  ]);
  $('snapshot-label').textContent = s ? `${publicOnly ? '网站只读快照' : '钱包节点已核对'} · 区块 ${uint(s.block)}` : '等待链上核对';
  const consumer = Boolean(s?.consumers?.some(address => same(address, F.game)));
  $('consumer-state').textContent = !s ? '等待核对' : consumer ? '已添加，可继续核对第二步。' : `尚未添加 · 请使用订阅所有者钱包。`;
  $('authorize-state').textContent = !s ? '等待核对' : s.seriesAuthorized ? '已授权启动，请进入 1 BEM 测试场查看本期状态。' :
    !consumer ? '等待第一步添加消费者并上链。' : uint(s.subscriptionNativeWei) === 0n ? '请先为 VRF 订阅充值 BNB。' : '尚未启动 · 授权成功后立即开始 24 小时倒计时。';
}
function renderRecords() {
  const labels = { awaiting_wallet: '等待钱包结果', submitted: '已提交，等待核验', unknown: '结果待核实', verified: '已上链并核验通过', failed: '交易失败已确认' };
  for (const action of actions) {
    const r = state.records[action]; $(`record-${action}-state`).textContent = r ? labels[r.status] ?? '结果待核实' : '暂无本地记录';
    fields(`record-${action}-fields`, r ? [['操作钱包', r.account, 'address'], ['目标', r.to, 'address'], ['转入金额', `${formatEther(r.value)} BNB`],
      ['交易哈希', r.hash ?? '尚未取得哈希，请先查看钱包', r.hash ? 'tx' : null], ['创建时间', new Date(r.createdAt).toLocaleString('zh-CN')]] : []);
    if (r?.hash && document.activeElement !== $(`${action}-hash`)) $(`${action}-hash`).value = r.hash;
  }
}
function render() {
  $('wallet-address').textContent = state.account ?? '使用浏览器钱包连接，核对当前权限。';
  $('network-state').textContent = state.account ? state.chainId === 56 ? 'BNB 主网 · 56' : `网络 ${state.chainId ?? '未知'}` : '尚未连接';
  $('connect-wallet').textContent = state.account ? '切换钱包' : '连接钱包';
  renderSnapshot(); renderRecords(); controls();
}
function saveRecord(action, record) {
  const next = { ...state.records }; if (record) next[action] = record; else delete next[action];
  try { localStorage.setItem(STORAGE, JSON.stringify(next)); }
  catch { state.records = next; state.storageError = true; throw Error('无法保存配置交易记录，已停止提交。请保留当前页面并允许网站使用本地存储。'); }
  state.records = next;
}
function recordsFingerprint(records) {
  return JSON.stringify(actions.map(action => { const r = records[action]; return r ? [r.account.toLowerCase(), r.to.toLowerCase(), r.data.toLowerCase(), r.value, r.nonce, r.hash?.toLowerCase() ?? null, r.createdAt] : null; }));
}
async function exclusive(operation) {
  if (state.busy || state.locking) return; state.locking = true; controls();
  try {
    need(navigator.locks?.request, '请在支持网页锁的 Chrome / Edge 中打开本页，再提交配置交易。');
    await navigator.locks.request(STORAGE, { mode: 'exclusive' }, async () => {
      const stored = JSON.parse(localStorage.getItem(STORAGE) ?? '{}');
      need(recordsFingerprint(stored) === recordsFingerprint(state.records) && !state.storageError, '另一个页面已更新配置记录，请刷新后核对，避免重复提交。');
      await operation();
    });
  } catch (error) { notice(errorText(error), true); }
  finally { state.locking = false; controls(); }
}
function changed(accounts) {
  const attempt = state.connectAttempt;
  if (Array.isArray(accounts) && attempt && attempt.wallet === state.wallet && attempt.epoch === state.epoch) {
    if (attempt.waitingForApproval) { attempt.observedAccounts = [...accounts]; return; }
    if (accounts.length && same(accounts[0], attempt.account)) return;
  }
  state.connectAttempt = null;
  state.epoch++; state.account = null; state.chainId = null; state.snapshot = null; clearEstimate(); render();
  notice('钱包或网络已变化，请重新连接并核对。已提交交易记录已保留。');
}
async function connect(entry) {
  if (state.busy || state.locking) return; state.busy = true; clearEstimate(); state.snapshot = null;
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) state.wallet?.removeListener?.(event, changed);
  state.wallet = entry.provider; state.account = null; state.chainId = null; const epoch = ++state.epoch, wallet = state.wallet;
  const attempt = { epoch, wallet, waitingForApproval: true, observedAccounts: null, account: null };
  state.connectAttempt = attempt;
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) wallet.on?.(event, changed);
  controls();
  try {
    const accounts = await wallet.request({ method: 'eth_requestAccounts' });
    attempt.waitingForApproval = false; attempt.account = accounts?.[0] ?? null;
    need(epoch === state.epoch && wallet === state.wallet && accounts?.length &&
      (attempt.observedAccounts === null || same(attempt.observedAccounts[0], accounts[0])), '连接过程中钱包已变化，请重试。');
    const chain = await wallet.request({ method: 'eth_chainId' });
    const current = await wallet.request({ method: 'eth_accounts' });
    need(epoch === state.epoch && wallet === state.wallet && accounts?.length && current?.length && same(accounts[0], current[0]), '连接过程中钱包已变化，请重试。');
    state.account = getAddress(current[0]); state.chainId = Number(uint(chain));
    if (state.chainId === 56) state.snapshot = await readSnapshot(capture());
    notice(state.chainId === 56 ? '钱包已连接并核对。请选择尚未完成的配置步骤。' : '请切换 BNB 主网，再重新连接核对。');
  } catch (error) { notice(errorText(error), true); }
  finally { if (state.connectAttempt === attempt) state.connectAttempt = null; state.busy = false; render(); }
}
function capture(action = state.action) {
  need(state.wallet && state.account && state.chainId === 56, '请连接 BNB 主网钱包。');
  return { wallet: state.wallet, account: state.account, epoch: state.epoch, action };
}
function assertContext(c) { need(c.wallet === state.wallet && c.epoch === state.epoch && same(c.account, state.account), '钱包或网络已变化，请重新核对。'); }
async function read(c, method, params = []) {
  assertContext(c); let timer;
  try {
    const value = await Promise.race([c.wallet.request({ method, params }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('钱包节点读取超时，请重试。')), 18000); })]);
    assertContext(c); return value;
  } finally { clearTimeout(timer); }
}
async function identity(c) {
  const chain = await read(c, 'eth_chainId'), accounts = await read(c, 'eth_accounts');
  need(uint(chain) === 56n && accounts?.length && same(accounts[0], c.account), '当前钱包或网络与核对资料不一致。');
}
async function call(c, to, name, args = [], block = 'latest') {
  return ABI.decodeFunctionResult(name, await read(c, 'eth_call', [{ to, data: ABI.encodeFunctionData(name, args) }, block]));
}
async function readSnapshot(c, at = 'latest') {
  await identity(c);
  const header = await read(c, 'eth_getBlockByNumber', [at, false]); need(header?.number && isHash(header.hash), '区块资料暂不可用。');
  const block = header.number;
  const [code, sub, owner, nftOwner, fee, token, account, opened, authorized, current, subscription, native, codes] = await Promise.all([
    read(c, 'eth_getCode', [F.game, block]), call(c, F.coordinator, 'getSubscription', [F.subscriptionId], block),
    call(c, F.authorizationContainer, 'owner', [], block), call(c, F.processor, 'ownerOf', ['2075'], block),
    call(c, F.authorizationContainer, 'EXEC_FEE', [], block), call(c, F.authorizationContainer, 'token', [], block),
    call(c, F.opener, 'accountOf', [F.processor, '2075'], block), call(c, F.opener, 'isOpened', [F.processor, '2075'], block),
    call(c, F.game, 'seriesAuthorized', [], block), call(c, F.game, 'currentRoundId', [], block), call(c, F.game, 'subscriptionId', [], block),
    read(c, 'eth_getBalance', [F.authorizationContainer, block]), Promise.all([F.coordinator, F.authorizationContainer, F.processor, F.opener].map(to => read(c, 'eth_getCode', [to, block]))),
  ]);
  const round = await call(c, F.game, 'rounds', [current[0]], block);
  const s = assertSnapshot({ chainId: '56', block, blockHash: header.hash, code, subscriptionId: subscription[0].toString(), dependencyCodes: codes,
    containerOpened: opened[0], containerAccount: account[0], containerToken: [...token].map(String), containerOwner: owner[0], nftOwner: nftOwner[0],
    subscriptionOwner: sub[3], consumers: [...sub[4]], seriesAuthorized: authorized[0], currentRound: current[0].toString(), round: [...round].map(String),
    execFeeWei: fee[0].toString(), subscriptionNativeWei: sub[1].toString(), containerNativeWei: uint(native).toString() });
  need(same((await read(c, 'eth_getBlockByNumber', [block, false]))?.hash, header.hash), '区块发生变化，请重新核对。');
  await identity(c); return s;
}
async function refreshPublic() {
  try {
    const response = await fetch('/api/pools/1/status', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    need(response.ok, '暂时无法读取网站状态，请连接钱包核对。'); const result = await response.json();
    need(same(result.gameAddress, F.game) && result.runtimeVerified === true && result.snapshot?.blockNumber, '网站状态仍待核验，请连接钱包直接核对。');
    if (state.account) return;
    renderSnapshot({ block: String(result.snapshot.blockNumber), subscriptionOwner: result.vrf.owner, containerOwner: result.container.owner,
      consumers: result.vrf.consumerAuthorized ? [F.game] : [], seriesAuthorized: result.seriesAuthorized === true,
      execFeeWei: result.container.execFeeWei, subscriptionNativeWei: result.vrf.nativeBalanceWei, containerNativeWei: result.container.nativeBalanceWei }, true);
    notice('网站只读状态已更新。连接钱包后会再次从钱包节点核对身份与合约。');
  } catch (error) { if (!state.account) notice(errorText(error), true); }
}
async function refreshStatus() {
  if (state.busy || state.locking) return;
  if (!state.account || state.chainId !== 56) return refreshPublic();
  state.busy = true; clearEstimate(); controls();
  try { state.snapshot = await readSnapshot(capture()); notice('链上状态已重新核对。'); }
  catch (error) { state.snapshot = null; notice(errorText(error), true); }
  finally { state.busy = false; render(); }
}
async function review(action) {
  if (state.busy || state.locking) return; state.busy = true; state.action = action; state.epoch++; clearEstimate(); controls();
  try {
    need(!state.records[action] && !state.storageError && !$(`${action}-hash`).value.trim(), '请先核对本步骤已有交易记录。');
    const c = capture(action), s = await readSnapshot(c), transaction = assertActionReady(action, s, c.account);
    const draft = { from: c.account, to: transaction.to, data: transaction.data, value: toQuantity(transaction.value) };
    const [gasRaw, priceRaw, balanceRaw, nonceRaw] = await Promise.all([
      read(c, 'eth_estimateGas', [draft]), read(c, 'eth_gasPrice'), read(c, 'eth_getBalance', [c.account, 'pending']), read(c, 'eth_getTransactionCount', [c.account, 'pending']),
    ]);
    await identity(c); assertContext(c);
    const gas = uint(gasRaw), gasPrice = uint(priceRaw), gasLimit = gas * 120n / 100n + 10000n, balance = uint(balanceRaw), value = uint(transaction.value);
    need(gas > 0n && gasLimit < 3000000n && gasPrice > 0n && balance >= value + gasLimit * gasPrice, '钱包 BNB 不足以支付协议费与网络费用，或节点估算异常。');
    const createdAt = Date.now(); state.snapshot = s;
    state.estimate = { ...c, ...transaction, createdAt, expiresAt: createdAt + 90000, gas: gas.toString(), gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), nonce: uint(nonceRaw).toString() };
    $('review-panel').hidden = false; $('review-heading').textContent = START_ACTIONS[action];
    fields('review-fields', [['签名钱包', c.account, 'address'], ['交易目标', transaction.to, 'address'],
      ['方法', action === 'consumer' ? 'addConsumer(固定订阅 ID, 测试合约)' : 'execute(测试合约, 0, authorizeSeries(), CALL)'],
      ['外层转入金额', `${formatEther(value)} BNB${action === 'authorize' ? '（容器执行协议费）' : ''}`],
      ['转入测试合约的 BNB', '0 BNB'], ['预估网络费用', `${formatEther(gas * gasPrice)} BNB`],
      ['网络费用预留上限', `${formatEther(gasLimit * gasPrice)} BNB`], ['本次支出预留合计', `${formatEther(value + gasLimit * gasPrice)} BNB`],
      ['Gas 上限 / Gas 单价', `${gasLimit} / ${gasPrice} wei`], ['钱包 BNB 余额', `${formatEther(balance)} BNB`]]);
    $('review-data').textContent = transaction.data;
    $('confirmation-copy').textContent = action === 'authorize' ? '我确认授权并立即启动第一期 1 BEM 测试场，开始 24 小时筹集倒计时。' : '我确认只把这份固定的 1 BEM 测试合约加入指定 VRF 订阅。';
    $('send-action').textContent = action === 'authorize' ? '确认授权并启动测试场' : '确认添加 VRF 消费者';
    notice('核对通过。请阅读交易目标与费用，勾选确认后再单独提交。');
    renderSnapshot(); $('review-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (error) { clearEstimate(); notice(errorText(error), true); }
  finally { state.busy = false; controls(); }
}
async function send() {
  if (state.busy) return; state.busy = true; controls(); let reservation;
  try {
    const c = capture(), e = state.estimate; need($('confirm-review').checked, '请先阅读并确认本次操作。'); assertIntent(c, state);
    const snapshot = await readSnapshot(c), fresh = assertActionReady(c.action, snapshot, c.account);
    need(same(fresh.to, e.to) && same(fresh.data, e.data) && fresh.value === e.value, '协议执行费已变化，请重新核对。');
    const [gas, gasPrice, balance, nonce] = await Promise.all([
      read(c, 'eth_estimateGas', [{ from: c.account, to: e.to, value: toQuantity(e.value), data: e.data }]),
      read(c, 'eth_gasPrice'), read(c, 'eth_getBalance', [c.account, 'pending']), read(c, 'eth_getTransactionCount', [c.account, 'pending']),
    ]);
    need(uint(gas) <= uint(e.gasLimit) && uint(gasPrice) <= uint(e.gasPrice) && uint(balance) >= uint(e.value) + uint(e.gasLimit) * uint(e.gasPrice) && uint(nonce).toString() === e.nonce,
      '钱包交易序号、余额或网络费用已变化，请重新核对。');
    await identity(c); assertIntent(c, state);
    reservation = { schemaVersion: 1, action: c.action, chainId: 56, game: F.game, account: c.account, nonce: e.nonce,
      to: e.to, value: e.value, data: e.data, createdAt: new Date().toISOString(), hash: null, status: 'awaiting_wallet' };
    saveRecord(c.action, reservation); renderRecords(); controls();
    // This is the only signing call. It is reached only from the explicit confirmation button.
    const hash = await c.wallet.request({ method: 'eth_sendTransaction', params: [{ from: c.account, to: e.to, data: e.data, value: toQuantity(e.value),
      chainId: '0x38', nonce: toQuantity(e.nonce), gas: toQuantity(e.gasLimit), gasPrice: toQuantity(e.gasPrice) }] });
    need(isHash(hash), '钱包没有返回有效交易哈希，请先查看钱包，不要重复提交。');
    saveRecord(c.action, { ...reservation, hash, status: 'submitted' }); clearEstimate();
    notice('交易已提交。等待上链后，点击对应的“核对交易”确认执行结果。');
  } catch (error) {
    if (reservation) {
      try { if (error.code === 4001 || error.code === 'ACTION_REJECTED') saveRecord(reservation.action, null);
        else saveRecord(reservation.action, { ...state.records[reservation.action], status: 'unknown' }); } catch { /* Keep the reservation if storage fails. */ }
    }
    clearEstimate(); notice(errorText(error), true);
  } finally { state.busy = false; renderRecords(); controls(); }
}
async function verify(action) {
  if (state.busy) return; state.busy = true; clearEstimate(); controls();
  try {
    const c = capture(action), hash = $(`${action}-hash`).value.trim() || state.records[action]?.hash;
    need(isHash(hash), '请填写完整交易哈希。'); await identity(c);
    const tx = await read(c, 'eth_getTransactionByHash', [hash]); need(tx, '暂未查到交易，请先查看钱包并稍后核对。');
    const existing = state.records[action], expected = actionTransaction(action, uint(tx.value).toString());
    const record = existing ? { ...existing, hash } : { schemaVersion: 1, action, chainId: 56, game: F.game, account: tx.from,
      nonce: uint(tx.nonce).toString(), to: expected.to, value: expected.value, data: expected.data, createdAt: new Date().toISOString(), hash, status: 'unknown' };
    assertTransaction(tx, record);
    // Import only after proving the hash is exactly this fixed action; never trust stored success.
    saveRecord(action, { ...record, status: 'unknown' });
    const receipt = await read(c, 'eth_getTransactionReceipt', [hash]); need(receipt, '交易尚未确认，记录已保留，不会自动重发。');
    const [block, tip] = await Promise.all([read(c, 'eth_getBlockByNumber', [receipt.blockNumber, false]), read(c, 'eth_blockNumber')]);
    const succeeded = assertReceipt(tx, receipt, block, tip);
    if (succeeded) {
      assertReceiptEvents(action, receipt);
      // Canonical events prove this action; current pinned-code reads avoid relying on pruned historical state.
      const confirmed = await readSnapshot(c);
      need(action === 'consumer' ? confirmed.consumers.some(address => same(address, F.game)) : confirmed.seriesAuthorized && uint(confirmed.currentRound) >= 1n,
        '交易已上链，但配置状态尚未通过回读核验。');
      if (action === 'authorize') { const first = await call(c, F.game, 'rounds', ['1'], confirmed.block); need(uint(first[2]) > 0n && uint(first[0]) > 0n, '第一期尚未通过启动回读核验。'); }
    }
    need(same((await read(c, 'eth_getBlockByNumber', [receipt.blockNumber, false]))?.hash, receipt.blockHash), '主链区块发生变化，请重新核对。');
    await identity(c); saveRecord(action, { ...record, status: succeeded ? 'verified' : 'failed' });
    state.snapshot = await readSnapshot(c);
    notice(succeeded ? `${START_ACTIONS[action]}已按主链回执事件与当前状态核验通过。` : '交易失败已确认，未完成该配置。可清除失败记录后重新核对。');
    return { status: succeeded ? 'verified' : 'failed' };
  } catch (error) { notice(errorText(error), true); }
  finally { state.busy = false; render(); }
}
function download() {
  const blob = new Blob([JSON.stringify({ game: F.game, records: state.records }, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'bem-test1-start-records.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
try {
  const stored = JSON.parse(localStorage.getItem(STORAGE) ?? '{}'); need(stored && typeof stored === 'object' && !Array.isArray(stored), '配置记录格式异常。');
  for (const action of actions) if (stored[action]) state.records[action] = restoreRecord(stored[action], action);
} catch (error) { state.storageError = true; notice(errorText(error), true); }
const picker = createWalletPicker({ dialog: $('wallet-picker'), onSelect: connect, onChange: entries => {
  // This configuration page stays Chinese without changing the player's saved language preference.
  $('wallet-picker-hint').textContent = entries.size ? '选择配置钱包，再在钱包中确认连接。' : '未检测到钱包。请在安装钱包的浏览器或手机钱包浏览器中打开本页。';
  for (const button of $('wallet-options').querySelectorAll('button')) {
    const status = button.querySelector('.wallet-option-copy small');
    if (status) status.textContent = button.disabled ? '未检测到' : '已检测到 · 点击连接';
  }
} });
$('connect-wallet').addEventListener('click', () => { if (!state.busy && !state.locking) picker.open(); });
$('refresh-status').addEventListener('click', refreshStatus);
$('switch-network').addEventListener('click', async () => {
  if (!state.wallet || state.busy || state.locking) return; const wallet = state.wallet; state.busy = true; state.epoch++; clearEstimate(); controls();
  try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] }); notice('已请求切换 BNB 主网，请重新连接钱包。'); }
  catch (error) { notice(errorText(error), true); }
  finally { state.account = null; state.chainId = null; state.snapshot = null; state.busy = false; render(); }
});
for (const action of actions) {
  $(`review-${action}`).addEventListener('click', () => review(action));
  $(`verify-${action}`).addEventListener('click', () => exclusive(() => verify(action)));
  $(`${action}-hash`).addEventListener('input', () => { clearEstimate(); controls(); });
  $(`reset-${action}`).addEventListener('click', () => exclusive(async () => {
    need(state.records[action]?.status === 'failed', '尚未证明该交易失败，不能清除记录。');
    const verified = await verify(action);
    need(verified?.status === 'failed' && state.records[action]?.status === 'failed', '失败状态尚未重新核验，保留原记录。');
    saveRecord(action, null); $(`${action}-hash`).value = ''; state.epoch++; clearEstimate(); render(); notice('已清除确认失败的记录，请重新核对费用。');
  }));
}
$('send-action').addEventListener('click', () => exclusive(send)); $('confirm-review').addEventListener('change', controls);
$('copy-url').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); notice('本页网址已复制。'); } catch { notice(`请复制浏览器地址栏中的网址：${location.href}`); } });
$('download-records').addEventListener('click', download);
window.addEventListener('storage', event => { if (event.key !== STORAGE) return; state.epoch++; state.storageError = true; clearEstimate(); controls(); notice('另一个页面更新了配置记录，请刷新本页后核对已有交易。', true); });
setInterval(controls, 1000); render(); if (!state.storageError) refreshPublic();
