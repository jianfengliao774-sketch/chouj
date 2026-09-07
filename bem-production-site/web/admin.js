import { formatEther, getAddress } from 'ethers';
import { createAdminActivity } from './admin-activity.js';
const $ = id => document.getElementById(id);
let config, busy = false;
const text = (tag, value) => { const el = document.createElement(tag); el.textContent = String(value); return el; };
const notice = (message, error = false) => { $('admin-notice').textContent = message; $('admin-notice').className = error ? 'error' : ''; };
async function api(path, payload) { const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(payload ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}) }); const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || '读取未完成'), { status: response.status }); return data; }
function controls() { for (const id of ['login', 'refresh', 'logout', 'admin-username', 'admin-password']) $(id).disabled = busy; }
function signedOut() { activity.clear(); $('login-panel').hidden = false; $('admin-content').hidden = true; $('legacy-status').hidden = true; }
function showSession(session) { $('login-panel').hidden = true; $('admin-content').hidden = false; $('admin-account').textContent = `当前管理员：${session.username}`; }
const activity = createAdminActivity({ api, onError: error => { if (error.status === 401) signedOut(); notice(error.status === 401 ? '登录已过期，请重新登录。' : error.message, true); } });
function row(label, value, address = false) { const wrap = document.createElement('div'), dd = document.createElement('dd'); if (address) { const a = text('a', value); a.href = `https://bscscan.com/address/${getAddress(value)}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; dd.append(a); } else dd.textContent = String(value); wrap.append(text('dt', label), dd); return wrap; }
function render(data) {
  showSession(data.session); $('legacy-status').hidden = false;
  $('launch-state').textContent = data.seriesAuthorized ? '原合约：已授权' : '原合约：已部署 · 待启动';
  const cards = [['VRF 订阅余额', `${formatEther(data.vrf.nativeBalanceWei)} BNB`], ['订阅消费者', `${data.vrf.consumers.length} 个`], ['容器 BNB', formatEther(data.containerNativeBalanceWei)], ['当前期号', data.currentRoundId]];
  $('metrics').replaceChildren(...cards.map(([label, value]) => { const card = document.createElement('article'); card.append(text('small', label), text('strong', value)); return card; }));
  $('readiness').replaceChildren(row('部署与代码核验', data.runtimeVerified ? '已通过' : '待核实'), row('VRF 消费者', data.vrf.consumerAuthorized ? '已添加正式游戏' : '待添加'),
    row('真实 VRF 请求', `${data.vrf.requestCount} 次（订阅累计）`), row('自动执行程序', data.keeper.serviceRunning ? '运行状态已确认' : '尚未启用'), row('容器启动授权', data.seriesAuthorized ? '已授权' : '尚未授权'),
    row('前端售票开关', data.salesEnabled ? '已开放' : '尚未开放'), row('历史索引', `${data.history.state === 'ready' ? '已同步' : data.history.state === 'stale' ? '同步暂时中断' : '同步中'} · 区块 ${data.history.indexedThrough ?? '—'} / ${data.history.targetBlock ?? '—'}`));
  $('identities').replaceChildren(row('游戏合约', config.gameAddress, true), row('2075 处理器', config.processorAddress, true), row('2075 容器', config.containerAddress, true), row('BEM 合约', config.bemAddress, true), row('VRF 订阅 ID', config.subscriptionId), row('代码哈希', config.runtimeCodeHash), row('数据区块', data.snapshot.blockNumber));
  notice(`主网数据更新时间：${new Date(data.snapshot.timeUtc).toLocaleString('zh-CN')}。`);
}
async function refresh({ initial = false } = {}) {
  const [statusResult, overviewResult] = await Promise.allSettled([api('/api/admin/status'), api('/api/admin/overview')]);
  if ([statusResult, overviewResult].some(result => result.status === 'rejected' && result.reason.status === 401)) {
    signedOut(); notice(initial ? '请输入管理员账号和密码。' : '登录已过期，请重新登录。', !initial); return;
  }
  if (statusResult.status === 'fulfilled') render(statusResult.value);
  else $('legacy-status').hidden = true;
  if (overviewResult.status === 'fulfilled') {
    showSession(overviewResult.value.session); activity.render(overviewResult.value);
    notice('运营统计已更新。展开各场次和期号，可查看钱包汇总及逐笔购买。');
  } else { activity.clear(); notice('运营统计读取暂未完成，请刷新重试。', true); }
  if (statusResult.status === 'rejected' && overviewResult.status === 'fulfilled') notice('参与统计已更新；原合约运行状态暂时无法读取。');
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const username = $('admin-username').value.trim(), password = $('admin-password').value;
  busy = true; controls();
  try {
    await api('/api/admin/login', { username, password });
    $('admin-password').value = '';
    await refresh();
  } catch (error) { notice(error.message || '登录未完成。', true); }
  finally { busy = false; controls(); }
});
$('refresh').addEventListener('click', async () => { if (busy) return; busy = true; controls(); try { await refresh(); } finally { busy = false; controls(); } });
$('logout').addEventListener('click', async () => {
  if (busy) return; busy = true; controls();
  try { await api('/api/admin/logout', {}); signedOut(); $('admin-password').value = ''; notice('已退出管理后台。'); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; controls(); }
});
try { config = await api('/api/config'); if (config.mode !== 'production' || config.chainId !== 56) throw new Error('正式配置无效。'); await refresh({ initial: true }); } catch (error) { notice(error.message, true); }
controls();
