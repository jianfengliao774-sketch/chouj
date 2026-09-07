import { Interface, formatEther, formatUnits, getAddress, getCreateAddress, keccak256, toQuantity } from 'ethers';
import pool100Artifact from '../../outputs/bem-raffle-2075/production-v3/BemOwnContainer13061Pool100BSC.artifact.json';
import pool10Artifact from '../../outputs/bem-raffle-2075/production-v3/BemOwnContainer13061Pool10BSC.artifact.json';
import pool50Artifact from '../../outputs/bem-raffle-2075/production-v3/BemOwnContainer13061Pool50BSC.artifact.json';
import { createWalletPicker } from './wallet-picker.js';
import { DEPLOY_FIXED as F, DEPLOY_MODES, ADDRESS_READBACK, deploymentMode, deploymentData,
  validateDeploymentArtifact, verifyDeploymentRuntime, assertContainerBindings, expectedReadback,
  assertDeploymentReadback, assertDeploymentTransaction, assertCreationTransaction, assertUnsuccessfulDeployment,
  assertDeploymentIntent, assertResolvedReset, assertDeployer, rpcQuantity, rpcBlockTag, normalizeReadResult,
  FORMAL_VERSION, FORMAL_STORAGE_KEY, FORMAL_LOCK_KEY, sameAddress, need } from './deploy-formal-guards.js';

const $ = id => document.getElementById(id);
const ARTIFACTS = Object.freeze({ pool10: pool10Artifact, pool50: pool50Artifact, pool100: pool100Artifact });
const STORAGE_KEY = FORMAL_STORAGE_KEY;
const state = { mode: null, wallet: null, account: null, chainId: null, epoch: 0, busy: false,
  ready: false, estimate: null, records: {}, storageError: false, data: {} };
const rpcInterface = new Interface([
  'function accountOf(address,uint256) view returns(address)', 'function isOpened(address,uint256) view returns(bool)',
  'function token() view returns(uint256,address,uint256)', 'function decimals() view returns(uint8)',
  'function owner() view returns(address)', 'function ownerOf(uint256) view returns(address)',
  'function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)',
  'function netlist(uint256) view returns(bytes)', 'function circuitInfo(uint256) view returns(uint32,uint32,uint32,uint32)',
]);
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function shortError(error) {
  if (error.code === 4001 || error.code === 'ACTION_REJECTED') return '您取消了钱包确认，本次操作未提交。';
  if (error.code === -32002) return '钱包中已有待处理请求，请先在钱包中处理。';
  return String(error.shortMessage ?? error.message ?? error).slice(0, 220);
}
function explorer(kind, value) {
  const a = document.createElement('a'); a.href = `https://bscscan.com/${kind}/${value}`;
  a.textContent = value; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'mono'; return a;
}
function fields(id, rows) {
  $(id).replaceChildren(...rows.flatMap(([label, value, kind]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label;
    if (kind && value) dd.append(explorer(kind, value)); else dd.textContent = value ?? '—';
    if (String(value ?? '').length > 28) dd.classList.add('mono'); return [dt, dd];
  }));
}
function currentRecord() { return state.mode ? state.records[state.mode] : null; }
function saveRecord(mode, record) {
  const next = { ...state.records };
  if (record) next[mode] = record; else delete next[mode];
  // Persist the reservation BEFORE opening a signature request. Failure disables deployment.
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
  catch { state.records = next; state.storageError = true; throw new Error('浏览器无法保存部署记录，已停止新增部署。请允许本网站使用本地存储。'); }
  state.records = next;
}
function controls() {
  const record = currentRecord(), canRead = state.ready && state.mode && state.wallet && sameAddress(state.account, F.deployer) && state.chainId === 56;
  $('connect-wallet').disabled = state.busy;
  $('switch-network').hidden = !state.account || state.chainId === 56;
  $('switch-network').disabled = state.busy;
  for (const mode of Object.keys(DEPLOY_MODES)) $(`mode-${mode}`).disabled = state.busy;
  const importing = !record && Boolean($('recovery-hash').value.trim());
  $('estimate').disabled = !canRead || state.busy || Boolean(record) || state.storageError || importing;
  const reviewed = state.estimate && state.estimate.expiresAt > Date.now() && canRead && !record && !state.storageError && !importing;
  $('confirm-review').disabled = !reviewed || state.busy;
  $('deploy').disabled = !reviewed || !$('confirm-review').checked || state.busy;
  $('verify-receipt').disabled = !canRead || state.busy;
  $('download-record').disabled = !record;
  $('reset-resolved').hidden = !record?.status?.startsWith('resolved_');
  $('reset-resolved').disabled = state.busy;
  $('recovery-hash').disabled = state.busy;
  if (state.estimate) $('estimate-expiry').textContent = state.estimate.expiresAt > Date.now()
    ? `剩余 ${Math.ceil((state.estimate.expiresAt - Date.now()) / 1000)} 秒` : '已过期，请重新核对';
}
function clearEstimate() {
  state.estimate = null; $('confirm-review').checked = false;
  $('binding-state').textContent = '尚未核对'; $('review-account').textContent = '—';
  $('estimated-fee').textContent = $('maximum-fee').textContent = $('wallet-balance').textContent = '— BNB';
  $('estimate-expiry').textContent = '—';
}
function render() {
  const selected = state.mode ? deploymentMode(state.mode) : null;
  $('selected-mode').textContent = selected?.name ?? '请先选择类型';
  $('wallet-address').textContent = state.account ?? `指定部署钱包：${F.deployer}`;
  $('network-state').textContent = state.account ? state.chainId === 56 ? 'BNB 主网 · 56' : `网络 ${state.chainId ?? '未知'}` : '尚未连接';
  $('connect-wallet').textContent = state.account ? '切换钱包' : '连接钱包';
  for (const mode of Object.keys(DEPLOY_MODES)) {
    $(`mode-${mode}`).setAttribute('aria-pressed', String(state.mode === mode));
    const row = state.records[mode];
    $(`mode-${mode}-record`).textContent = row?.address ? `已登记：${row.address}` : row ? '已有部署记录 · 请选择后核对' : `独立${'正式'}合约`;
  }
  fields('fixed-fields', [
    ['本次类型', selected?.name ?? '待选择'], ['网络', 'BNB Chain 主网（56）'],
    ['部署与容器启动钱包', F.deployer, 'address'], ['VRF 订阅管理钱包', F.subscriptionOwner, 'address'],
    ['收款容器', F.revenueContainer, 'address'], ['容器所属电路', 'TapeOut #13061'],
    ['开奖计算', 'BEHEMOTH #2075'], ['开奖处理器', F.processor, 'address'],
    ['启动授权容器', F.authorizationContainer, 'address'], ['授权电路身份', 'TapeOut #13061'], ['BEM 合约', F.bem, 'address'],
    ['每期份数', selected ? `${Number(selected.tickets).toLocaleString('zh-CN')} 份 · 每份 ${formatUnits(selected.ticketPrice, 8)} BEM` : '待选择'],
    ['筹集期限', '24 小时，未凑满则开放退款'], ['退款领取期', '筹集截止后 24 小时，用户自行领取；截止后未领本金可销毁'],
    ['单地址每期上限', '5,000 份（50%）· 单笔最多 1,000 份'], ['下一期冷却', '60 秒'],
  ]);
  for (const kind of ['blackhole', 'organizer', 'winner']) $(`${kind}-amount`).textContent = selected ? formatUnits(selected[kind], 8) : '—';
  $('pool-note').textContent = selected
    ? `${'正式场次'}：凑满 ${formatUnits(selected.pool, 8)} BEM 开奖，共 10,000 份，每份 ${formatUnits(selected.ticketPrice, 8)} BEM。单笔最多 1,000 份。`
    : '请选择档位查看期总额、每份价格及分配金额。所有档位按 4% / 1% / 95% 分配。';
  fields('technical-fields', [
    ['合约名称', selected?.contractName], ['创建代码哈希', selected && state.data[state.mode] ? keccak256(ARTIFACTS[state.mode].bytecode) : null],
    ['含构造参数的交易数据哈希', selected && state.data[state.mode] ? keccak256(state.data[state.mode]) : null],
    ['VRF 订阅 ID', F.subscriptionId], ['VRF 协调器', F.coordinator, 'address'], ['VRF 确认数', '3'],
    ['VRF 回调 Gas', '250,000'], ['容器注册合约', F.opener, 'address'],
  ]);
  renderRecord(); controls();
}
function renderRecord() {
  const record = currentRecord(); $('record-panel').hidden = !state.mode;
  if (!record) {
    $('record-state').textContent = '尚无本地记录'; fields('record-fields', []);
    $('record-note').textContent = '如您已在其他浏览器部署过本档位，可粘贴原交易哈希，连接原部署钱包后核对并恢复记录。'; return;
  }
  const labels = { awaiting_wallet: '等待钱包结果', submitted: '已提交 · 待核验', verified: '已部署 · 核验通过', restored: '已恢复 · 待核验', unknown: '结果待核实', resolved_failed: '部署失败已确认', resolved_cancelled: '取消部署已确认' };
  $('record-state').textContent = labels[record.status] ?? '待核验';
  fields('record-fields', [['合约类型', DEPLOY_MODES[state.mode].name], ['部署钱包', record.account, 'address'],
    ['新合约地址', record.address ?? '待回执核验', record.address ? 'address' : null],
    ['部署交易', record.hash ?? '尚未取得哈希，请查看钱包', record.hash ? 'tx' : null],
    ['运行代码哈希', record.runtimeCodeHash], ['创建时间', record.createdAt ? new Date(record.createdAt).toLocaleString('zh-CN') : '—']]);
  $('record-note').textContent = record.status === 'verified'
    ? '已核对创建交易、运行代码及固定参数。由 0x304F…f3a8 管理的 VRF 订阅添加新合约为消费者，再使用本页部署钱包 0x7674…Ea53 通过其 13061 容器授权启动。'
    : record.status?.startsWith('resolved_') ? '已从主链证明本次部署失败或取消。您可下载记录后，单独点击重置并重新核对部署费用。'
      : '已有本类型的部署记录，新增部署已锁定。加速后可粘贴新交易哈希重新核对；未拿到哈希时请先查看钱包，页面不会自动重发。';
  if (document.activeElement !== $('recovery-hash')) $('recovery-hash').value = record.hash ?? '';
}
function identityChanged() {
  state.epoch++; state.account = null; state.chainId = null; clearEstimate(); render();
  notice('钱包或网络已变化，请重新连接并核对。已提交的部署记录已保留。');
}
function detach() {
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) state.wallet?.removeListener?.(event, identityChanged);
}
async function connect(entry) {
  if (state.busy) return; state.busy = true; state.epoch++; clearEstimate(); detach();
  state.wallet = entry.provider; state.account = null; state.chainId = null;
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) state.wallet.on?.(event, identityChanged);
  const wallet = state.wallet, mode = state.mode;
  controls();
  try {
    const accounts = await wallet.request({ method: 'eth_requestAccounts' });
    const permissionEpoch = state.epoch;
    const chainId = rpcQuantity(await wallet.request({ method: 'eth_chainId' }));
    const current = await wallet.request({ method: 'eth_accounts' });
    // An initial accountsChanged during wallet permission can be legitimate;
    // a later network/account change must never restore a stale connection.
    const finalChain = rpcQuantity(await wallet.request({ method: 'eth_chainId' }));
    need(wallet === state.wallet && mode === state.mode && state.epoch === permissionEpoch && accounts?.length && current?.length && sameAddress(accounts[0], current[0]) &&
      BigInt(finalChain) === BigInt(chainId), '钱包已变化，请重新连接。');
    state.account = getAddress(current[0]); state.chainId = Number(BigInt(chainId)); state.epoch++;
    assertDeployer(state.account);
    notice(state.chainId === 56 ? '钱包已连接。选择部署类型后，点击核对绑定并估算费用。' : '钱包已连接，请切换到 BNB 主网。');
  } catch (error) { notice(shortError(error), true); }
  finally { state.busy = false; render(); }
}
function capture() {
  deploymentMode(state.mode);
  need(state.wallet && state.account && state.chainId === 56, '请连接 BNB 主网钱包。');
  assertDeployer(state.account);
  return { mode: state.mode, account: state.account, epoch: state.epoch, wallet: state.wallet };
}
function assertContext(context) {
  need(context.mode === state.mode && context.wallet === state.wallet && context.epoch === state.epoch && sameAddress(context.account, state.account),
    '钱包、网络或合约类型已变化，请重新核对。');
}
async function read(context, method, params = []) {
  assertContext(context); let timer;
  const requestParams = [...params];
  if (method === 'eth_getBlockByNumber') requestParams[0] = rpcBlockTag(requestParams[0]);
  if (['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount'].includes(method)) requestParams[1] = rpcBlockTag(requestParams[1]);
  try {
    const result = await Promise.race([context.wallet.request({ method, params: requestParams }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('钱包节点读取超时，请稍后重试。')), 18000);
    })]); assertContext(context); return normalizeReadResult(method, result);
  } finally { clearTimeout(timer); }
}
async function checkIdentity(context) {
  const chainId = await read(context, 'eth_chainId'), accounts = await read(context, 'eth_accounts');
  need(BigInt(chainId) === 56n && accounts?.length && sameAddress(accounts[0], context.account), '钱包或网络已变化，请重新连接。');
}
async function call(context, to, name, args, blockTag) {
  const data = rpcInterface.encodeFunctionData(name, args);
  return rpcInterface.decodeFunctionResult(name, await read(context, 'eth_call', [{ to, data }, blockTag]));
}
async function checkBindings(context) {
  await checkIdentity(context);
  const block = await read(context, 'eth_getBlockByNumber', ['latest', false]);
  need(block && /^0x[0-9a-f]{64}$/i.test(block.hash), '区块快照不可用。');
  const blockTag = block.number;
  const [authorizationAccount, authorizationOpened, authorizationToken, revenueAccount, revenueOpened, revenueToken, decimals, netlist, circuitInfo, dependencyCodes, owner, nftOwner, subscription] = await Promise.all([
    call(context, F.opener, 'accountOf', [F.authorizationNft, F.authorizationTokenId], blockTag),
    call(context, F.opener, 'isOpened', [F.authorizationNft, F.authorizationTokenId], blockTag),
    call(context, F.authorizationContainer, 'token', [], blockTag),
    call(context, F.opener, 'accountOf', [F.revenueNft, F.revenueTokenId], blockTag),
    call(context, F.opener, 'isOpened', [F.revenueNft, F.revenueTokenId], blockTag),
    call(context, F.revenueContainer, 'token', [], blockTag), call(context, F.bem, 'decimals', [], blockTag),
    call(context, F.processor, 'netlist', [F.processorId], blockTag), call(context, F.processor, 'circuitInfo', [F.processorId], blockTag),
    Promise.all([F.opener, F.processor, F.authorizationContainer, F.revenueNft, F.revenueContainer, F.bem, F.coordinator]
      .map(address => read(context, 'eth_getCode', [address, blockTag]))),
    call(context, F.authorizationContainer, 'owner', [], blockTag),
    call(context, F.authorizationNft, 'ownerOf', [F.authorizationTokenId], blockTag),
    call(context, F.coordinator, 'getSubscription', [F.subscriptionId], blockTag),
  ]);
  assertContainerBindings({ chainId: 56, authorization: { account: authorizationAccount[0], opened: authorizationOpened[0], token: authorizationToken },
    revenue: { account: revenueAccount[0], opened: revenueOpened[0], token: revenueToken }, authorizationOwner: owner[0], authorizationNftOwner: nftOwner[0],
    decimals: decimals[0], netlistHash: keccak256(netlist[0]), circuitInfo, dependencyCodes });
  need(sameAddress(subscription.owner, F.subscriptionOwner), 'VRF 订阅持有人已变化，请重新核对订阅与后续消费者配置权限。');
  const canonical = await read(context, 'eth_getBlockByNumber', [blockTag, false]);
  need(canonical && sameAddress(canonical.hash, block.hash), '区块快照变化，请重新核对绑定。');
  await checkIdentity(context); return blockTag;
}
async function estimate() {
  if (state.busy) return;
  state.busy = true; clearEstimate(); controls();
  try {
    need(state.ready && !currentRecord() && !state.storageError, '当前已有部署记录或部署文件未就绪。');
    const context = capture(), block = await checkBindings(context), data = state.data[context.mode];
    const transaction = { from: context.account, data, value: '0x0' };
    const [gasRaw, priceRaw, balanceRaw, nonceRaw] = await Promise.all([
      read(context, 'eth_estimateGas', [transaction]), read(context, 'eth_gasPrice'),
      read(context, 'eth_getBalance', [context.account, 'pending']), read(context, 'eth_getTransactionCount', [context.account, 'pending']),
    ]);
    await checkIdentity(context);
    const gas = BigInt(gasRaw), gasPrice = BigInt(priceRaw), gasLimit = gas * 120n / 100n + 10000n, balance = BigInt(balanceRaw);
    need(gas > 0n && gasLimit <= 16777216n && gasPrice > 0n && balance >= gasLimit * gasPrice, '钱包 BNB 余额不足或部署 Gas 超过上限，请检查钱包后重新估算。');
    const createdAt = Date.now();
    state.estimate = { ...context, gas: gas.toString(), gasPrice: gasPrice.toString(), gasLimit: gasLimit.toString(),
      nonce: BigInt(nonceRaw).toString(), block, createdAt, expiresAt: createdAt + 90000 };
    $('binding-state').textContent = `13061 容器及持有人、BEM 与 2075 电路均通过 · 区块 ${BigInt(block)}`;
    $('review-account').textContent = context.account;
    $('estimated-fee').textContent = `${formatEther(gas * gasPrice)} BNB`;
    $('maximum-fee').textContent = `${formatEther(gasLimit * gasPrice)} BNB`;
    $('wallet-balance').textContent = `${formatEther(balance)} BNB`;
    notice(`${DEPLOY_MODES[context.mode].name}核对通过。勾选确认后，单独点击部署并在钱包中签名。`);
  } catch (error) { clearEstimate(); notice(shortError(error), true); }
  finally { state.busy = false; controls(); }
}
async function deploy() {
  if (state.busy) return;
  state.busy = true; controls();
  let reservation = null;
  try {
    need(state.ready && !currentRecord() && !state.storageError && $('confirm-review').checked, '请先完成本类型部署核对。');
    const context = capture(), estimate = state.estimate;
    assertDeploymentIntent({ ...context, estimate }, state);
    await checkBindings(context);
    const [nonceRaw, gasRaw, balanceRaw] = await Promise.all([
      read(context, 'eth_getTransactionCount', [context.account, 'pending']),
      read(context, 'eth_estimateGas', [{ from: context.account, data: state.data[context.mode], value: '0x0' }]),
      read(context, 'eth_getBalance', [context.account, 'pending']),
    ]);
    assertDeploymentIntent({ ...context, estimate }, state);
    need(BigInt(nonceRaw).toString() === estimate.nonce && BigInt(gasRaw) <= BigInt(estimate.gasLimit) &&
      BigInt(balanceRaw) >= BigInt(estimate.gasLimit) * BigInt(estimate.gasPrice), '钱包交易序号、Gas 或余额已变化，请重新核对费用。');
    await checkIdentity(context); assertDeploymentIntent({ ...context, estimate }, state);
    reservation = { schemaVersion: 3, architecture: FORMAL_VERSION, mode: context.mode, chainId: 56, account: context.account, nonce: estimate.nonce,
      createdAt: new Date().toISOString(), dataHash: keccak256(state.data[context.mode]), status: 'awaiting_wallet', hash: null };
    saveRecord(context.mode, reservation); renderRecord(); controls();
    notice('请在钱包中确认创建合约。当前部署记录已锁定，页面不会重复发送。');
    // Only this explicit click reaches a signing method. Never use the site's read-only RPC.
    const hash = await context.wallet.request({ method: 'eth_sendTransaction', params: [{ from: context.account,
      data: state.data[context.mode], value: '0x0', chainId: '0x38', nonce: toQuantity(estimate.nonce),
      gas: toQuantity(estimate.gasLimit), gasPrice: toQuantity(estimate.gasPrice) }] });
    need(typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash), '钱包未返回有效交易哈希，请先查看钱包，切勿重复部署。');
    // Preserve a submitted hash even if wallet events invalidated the display context while signing.
    saveRecord(context.mode, { ...reservation, status: 'submitted', hash });
    clearEstimate(); notice('部署交易已提交。确认上链后，点击“重新核对交易”读取新地址和固定参数。');
  } catch (error) {
    if (reservation && (error.code === 4001 || error.code === 'ACTION_REJECTED')) {
      try { saveRecord(reservation.mode, null); } catch { /* Keep the existing reservation if persistence failed. */ }
    } else if (reservation) {
      try { saveRecord(reservation.mode, { ...state.records[reservation.mode], status: 'unknown' }); } catch { /* The original reservation remains durable. */ }
    }
    notice(reservation && error.code !== 4001 && error.code !== 'ACTION_REJECTED'
      ? `${shortError(error)} 已保留部署锁，请在钱包中核实交易或粘贴哈希恢复记录。` : shortError(error), true);
  } finally { state.busy = false; render(); }
}
async function verifyReceipt() {
  if (state.busy) return; state.busy = true; controls();
  try {
    const context = capture(), hash = $('recovery-hash').value.trim();
    let record = currentRecord();
    need(!record || sameAddress(record.account, context.account), '请连接记录中的部署钱包后重新核对。');
    need(/^0x[0-9a-f]{64}$/i.test(hash), '请输入完整的部署交易哈希。');
    await checkIdentity(context);
    const [transaction, receipt, latestBlock] = await Promise.all([
      read(context, 'eth_getTransactionByHash', [hash]), read(context, 'eth_getTransactionReceipt', [hash]), read(context, 'eth_blockNumber'),
    ]);
    if (!record) {
      assertCreationTransaction(transaction, context.account, state.data[context.mode]);
      record = { schemaVersion: 3, architecture: FORMAL_VERSION, mode: context.mode, chainId: 56, account: context.account,
        nonce: BigInt(transaction.nonce).toString(), createdAt: new Date().toISOString(),
        dataHash: keccak256(state.data[context.mode]), status: 'submitted', hash };
      // An RPC-verified creation transaction locks the mode even before its receipt arrives.
      saveRecord(context.mode, record); clearEstimate();
    }
    need(receipt, '尚未查到上链回执。若已在钱包加速，请粘贴加速后的交易哈希重新核对。');
    const block = await read(context, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (BigInt(receipt.status) === 0n || transaction?.to != null) {
      const originalHash = record.originalHash ?? record.hash;
      const originalTransaction = transaction?.to != null && originalHash
        ? await read(context, 'eth_getTransactionByHash', [originalHash]) : null;
      const senderCode = transaction?.to != null ? await read(context, 'eth_getCode', [record.account, receipt.blockNumber]) : null;
      const deployedCode = BigInt(receipt.status) === 0n
        ? await read(context, 'eth_getCode', [getCreateAddress({ from: record.account, nonce: record.nonce }), receipt.blockNumber]) : null;
      const status = assertUnsuccessfulDeployment({ transaction, receipt, block, latestBlock, account: record.account,
        data: state.data[context.mode], nonce: record.nonce, originalTransaction, senderCode, deployedCode });
      const canonical = await read(context, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
      need(canonical && sameAddress(canonical.hash, receipt.blockHash), '区块发生变化，请重新核对。');
      await checkIdentity(context);
      saveRecord(context.mode, { ...record, status, hash, originalHash, verifiedAt: new Date().toISOString() });
      notice(status === 'resolved_failed' ? '已确认本次部署失败，未创建合约。可下载记录，再单独重置并重新估算。'
        : '已确认原部署被钱包取消。可下载记录，再单独重置并重新估算。');
      return { mode: context.mode, status, hash, account: record.account, nonce: record.nonce };
    }
    const address = assertDeploymentTransaction({ transaction, receipt, block, latestBlock, account: record.account,
      data: state.data[context.mode], nonce: record.nonce });
    const code = await read(context, 'eth_getCode', [address, receipt.blockNumber]);
    const runtimeCodeHash = verifyDeploymentRuntime(code, ARTIFACTS[context.mode], context.mode);
    const expected = expectedReadback(context.mode, BigInt(receipt.blockNumber));
    const getters = new Interface(Object.keys(expected).map(name => `function ${name}() view returns(${Object.hasOwn(ADDRESS_READBACK, name)
      ? 'address' : typeof expected[name] === 'boolean' ? 'bool' : ['keyHash', 'CIRCUIT_HASH'].includes(name) ? 'bytes32' : 'uint256'})`));
    const values = Object.fromEntries(await Promise.all(Object.keys(expected).map(async name => {
      const result = await read(context, 'eth_call', [{ to: address, data: getters.encodeFunctionData(name, []) }, receipt.blockNumber]);
      return [name, getters.decodeFunctionResult(name, result)[0]];
    })));
    assertDeploymentReadback(values, context.mode, BigInt(receipt.blockNumber));
    const canonical = await read(context, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    need(canonical && sameAddress(canonical.hash, receipt.blockHash), '区块发生变化，请重新核对。');
    await checkIdentity(context);
    saveRecord(context.mode, { ...record, status: 'verified', hash, address, runtimeCodeHash,
      deploymentBlock: Number(BigInt(receipt.blockNumber)), blockHash: receipt.blockHash,
      verifiedAt: new Date().toISOString(), fixedRules: ARTIFACTS[context.mode].fixedRules,
      fixedBindings: ARTIFACTS[context.mode].fixedBindings, constructorArgs: [F.subscriptionId, 3, 250000] });
    notice(`${DEPLOY_MODES[context.mode].name}已部署，链上运行代码与固定参数核验通过。`);
  } catch (error) { notice(shortError(error), true); }
  finally { state.busy = false; render(); }
}
function downloadRecord() {
  const record = currentRecord(); if (!record) return;
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url;
  a.download = `bem13061-formal-v3-${state.mode}-deployment.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exclusive(action) {
  if (state.busy) return;
  try {
    need(navigator.locks?.request, '本浏览器不支持部署记录锁，请在最新版 Chrome 或 Edge 中打开本页。');
    await navigator.locks.request(FORMAL_LOCK_KEY, { mode: 'exclusive', ifAvailable: true }, async lock => {
      need(lock, '另一个页面正在核对或提交部署，请先完成该页面的操作。');
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      for (const mode of Object.keys(DEPLOY_MODES)) {
        const a = state.records[mode], b = stored[mode];
        need(Boolean(a) === Boolean(b) && (!a || ['account', 'nonce', 'dataHash', 'hash'].every(field =>
          String(a[field] ?? '').toLowerCase() === String(b[field] ?? '').toLowerCase())), '部署记录已在其他页面变化，请刷新后核对。');
      }
      await action();
    });
  } catch (error) { notice(shortError(error), true); }
}
async function initialize() {
  try {
    for (const mode of Object.keys(DEPLOY_MODES)) { validateDeploymentArtifact(ARTIFACTS[mode], mode); state.data[mode] = await deploymentData(ARTIFACTS[mode], mode); }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw); need(stored && typeof stored === 'object' && !Array.isArray(stored) &&
        Object.keys(stored).every(mode => Object.hasOwn(DEPLOY_MODES, mode)), '部署记录无法读取或混入其他版本。');
      for (const mode of Object.keys(DEPLOY_MODES)) if (stored[mode]) {
        const row = stored[mode];
        need(row.schemaVersion === 3 && row.architecture === FORMAL_VERSION && row.mode === mode && row.chainId === 56 && row.dataHash === keccak256(state.data[mode]) &&
          sameAddress(row.account, F.deployer) && getAddress(row.account) && /^(0|[1-9][0-9]*)$/.test(row.nonce) && Number.isFinite(Date.parse(row.createdAt)) &&
          (row.hash == null || /^0x[0-9a-f]{64}$/i.test(row.hash)), '已有部署记录与当前版本不符，请先核实原交易。');
        // Stored "verified" is only a past report. Fresh reads are required after every page load.
        state.records[mode] = { ...row, status: 'restored' };
      }
    }
    state.ready = true; notice('请选择 10、50 或 100 BEM 新正式合约，再连接指定部署钱包核对费用。');
  } catch (error) { state.storageError = true; notice(shortError(error), true); }
  render();
}
const picker = createWalletPicker({ dialog: $('wallet-picker'), onSelect: connect, onChange: entries => {
  $('wallet-picker-hint').textContent = entries.size
    ? '选择指定部署钱包，再在钱包中确认连接。'
    : '未检测到钱包，请使用安装钱包扩展的浏览器或手机钱包内置浏览器。';
  for (const button of $('wallet-options').querySelectorAll('button')) {
    const status = button.querySelector('small');
    if (status) status.textContent = button.disabled ? '未检测到' : '已检测到 · 点击连接';
  }
} });
$('connect-wallet').addEventListener('click', () => { if (!state.busy) picker.open(); });
for (const mode of Object.keys(DEPLOY_MODES)) $(`mode-${mode}`).addEventListener('click', () => {
  if (state.busy || state.mode === mode) return; state.mode = mode; state.epoch++; $('recovery-hash').value = ''; clearEstimate(); render();
  notice(state.records[mode] ? '本类型已有部署记录，请连接原部署钱包并重新核对交易。' : `已选择${DEPLOY_MODES[mode].name}，请核对参数与费用。`);
});
$('switch-network').addEventListener('click', async () => {
  if (!state.wallet || state.busy) return; const wallet = state.wallet; state.busy = true; state.epoch++; clearEstimate(); controls();
  try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
    notice('网络切换请求已完成，请重新连接钱包并核对。');
  } catch (error) { notice(shortError(error), true); }
  finally { state.account = null; state.chainId = null; state.busy = false; render(); }
});
$('copy-url').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); notice('本页网址已复制，请在安装钱包的浏览器中打开。'); }
  catch { notice(`请复制浏览器地址栏中的网址：${location.href}`); }
});
$('estimate').addEventListener('click', estimate); $('deploy').addEventListener('click', () => exclusive(deploy));
$('confirm-review').addEventListener('change', controls); $('verify-receipt').addEventListener('click', () => exclusive(verifyReceipt));
$('recovery-hash').addEventListener('input', controls);
$('download-record').addEventListener('click', downloadRecord);
$('reset-resolved').addEventListener('click', () => exclusive(async () => {
  const record = currentRecord(), mode = state.mode; need(record?.status?.startsWith('resolved_'), '尚未证明部署失败或取消，不能重置。');
  $('recovery-hash').value = record.hash;
  const resolution = await verifyReceipt();
  need(state.mode === mode && sameAddress(state.account, record.account), '钱包或档位已变化，部署锁已保留。');
  assertResolvedReset(resolution, currentRecord(), mode);
  saveRecord(mode, null); state.epoch++; $('recovery-hash').value = ''; clearEstimate(); render();
  notice('已重置这条已结束的记录。请重新核对费用后，再单独确认部署。');
}));
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY) return;
  // A second tab may have started deploying. Do not race it or overwrite its reservation.
  state.storageError = true; state.epoch++; clearEstimate(); controls();
  notice('另一个页面更新了部署记录。请刷新本页后核对现有记录，已禁用新的部署。', true);
});
setInterval(controls, 1000);
initialize();
