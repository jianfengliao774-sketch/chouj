import { formatEther, getAddress, hexlify, toUtf8Bytes } from 'ethers';
const $ = id => document.getElementById(id);
const wallets = new Map(), observed = new WeakSet(); let selected = null, config, busy = false, revision = 0;
const text = (tag, value) => { const el = document.createElement(tag); el.textContent = String(value); return el; };
const notice = (message, error = false) => { $('admin-notice').textContent = message; $('admin-notice').className = error ? 'error' : ''; };
async function api(path, payload) { const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(payload ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}) }); const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || '读取未完成'), { status: response.status }); return data; }
function controls() { $('login').disabled = busy || wallets.size === 0; $('refresh').disabled = busy; $('admin-wallet').disabled = busy; }
function addWallet(id, name, provider) { if (!provider?.request || wallets.has(id)) return; wallets.set(id, provider); const option = text('option', name); option.value = id; $('admin-wallet').append(option); controls(); }
window.addEventListener('eip6963:announceProvider', event => { if (event.detail?.info?.uuid && event.detail?.info?.name) addWallet(event.detail.info.uuid, String(event.detail.info.name).slice(0, 80), event.detail.provider); });
window.dispatchEvent(new Event('eip6963:requestProvider'));
if (window.ethereum?.request && wallets.size === 0) addWallet('injected', window.ethereum.isMetaMask ? 'MetaMask' : '浏览器钱包', window.ethereum);
function row(label, value, address = false) { const wrap = document.createElement('div'), dd = document.createElement('dd'); if (address) { const a = text('a', value); a.href = `https://bscscan.com/address/${getAddress(value)}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; dd.append(a); } else dd.textContent = String(value); wrap.append(text('dt', label), dd); return wrap; }
function render(data) {
  $('login-panel').hidden = true; $('admin-content').hidden = false; $('admin-account').textContent = `当前管理员：${data.session.address}`;
  $('launch-state').textContent = data.seriesAuthorized ? '已授权 · 发布配置待完成' : '已部署 · 待启动';
  const cards = [['VRF 订阅余额', `${formatEther(data.vrf.nativeBalanceWei)} BNB`], ['订阅消费者', `${data.vrf.consumers.length} 个`], ['容器 BNB', formatEther(data.containerNativeBalanceWei)], ['当前期号', data.currentRoundId]];
  $('metrics').replaceChildren(...cards.map(([label, value]) => { const card = document.createElement('article'); card.append(text('small', label), text('strong', value)); return card; }));
  $('readiness').replaceChildren(row('部署与代码核验', data.runtimeVerified ? '已通过' : '待核实'), row('VRF 消费者', data.vrf.consumerAuthorized ? '已添加正式游戏' : '待添加'),
    row('真实 VRF 请求', `${data.vrf.requestCount} 次（订阅累计）`), row('自动执行程序', data.keeper.serviceRunning ? '运行状态已确认' : '尚未启用'), row('容器启动授权', data.seriesAuthorized ? '已授权' : '尚未授权'),
    row('前端售票开关', data.salesEnabled ? '已开放' : '尚未开放'), row('历史索引', `${data.history.state === 'ready' ? '已同步' : data.history.state === 'stale' ? '同步暂时中断' : '同步中'} · 区块 ${data.history.indexedThrough ?? '—'} / ${data.history.targetBlock ?? '—'}`));
  $('identities').replaceChildren(row('游戏合约', config.gameAddress, true), row('2075 处理器', config.processorAddress, true), row('2075 容器', config.containerAddress, true), row('BEM 合约', config.bemAddress, true), row('VRF 订阅 ID', config.subscriptionId), row('代码哈希', config.runtimeCodeHash), row('数据区块', data.snapshot.blockNumber));
  notice(`主网数据更新时间：${new Date(data.snapshot.timeUtc).toLocaleString('zh-CN')}。`);
}
async function refresh() { try { render(await api('/api/admin/status')); } catch (error) { if (error.status === 401) { $('login-panel').hidden = false; $('admin-content').hidden = true; } notice(error.message, true); } }
$('login').addEventListener('click', async () => {
  if (busy) return; busy = true; controls();
  try {
    selected = wallets.get($('admin-wallet').value); if (!selected) throw new Error('请在安装钱包扩展的浏览器中打开后台。');
    const provider = selected;
    if (!observed.has(provider)) { observed.add(provider); for (const event of ['accountsChanged', 'chainChanged']) provider.on?.(event, () => { if (selected !== provider) return; revision++; $('admin-content').hidden = true; $('login-panel').hidden = false; notice('钱包已变化，请重新登录。'); api('/api/admin/logout', {}).catch(() => {}); }); }
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (BigInt(await provider.request({ method: 'eth_chainId' })) !== 56n) throw new Error('请在钱包中切换 BNB Chain 主网后重新登录。');
    const current = ++revision, address = getAddress(accounts[0]), challenge = await api('/api/admin/challenge', { address });
    if (current !== revision) throw new Error('钱包已变化，请重新登录。');
    const signature = await provider.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(challenge.message)), address] });
    const latestAccounts = await provider.request({ method: 'eth_accounts' });
    if (current !== revision || getAddress(latestAccounts[0]) !== address || BigInt(await provider.request({ method: 'eth_chainId' })) !== 56n) throw new Error('签名期间钱包已变化，请重试。');
    await api('/api/admin/login', { id: challenge.id, signature }); await refresh();
  } catch (error) { notice(error.code === 4001 ? '已取消登录签名。' : error.message || '登录未完成。', true); }
  finally { busy = false; controls(); }
});
$('refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => { await api('/api/admin/logout', {}); $('admin-content').hidden = true; $('login-panel').hidden = false; notice('已退出管理后台。'); });
try { config = await api('/api/config'); if (config.mode !== 'production' || config.chainId !== 56) throw new Error('正式配置无效。'); await refresh(); if (!wallets.size) notice('请在安装 MetaMask 等钱包扩展的 Chrome 或 Edge 中打开管理后台。'); } catch (error) { notice(error.message, true); }
controls();
