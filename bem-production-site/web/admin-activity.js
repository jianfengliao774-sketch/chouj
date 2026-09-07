import { formatUnits, getAddress } from 'ethers';

const POOLS = new Set(['1', '10', '50', '100', 'legacy100']);
const node = (tag, value, className) => {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = String(value);
  if (className) result.className = className;
  return result;
};
const bem = value => `${formatUnits(value ?? '0', 8)} BEM`;
const date = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hourCycle: 'h23' }) : '记录缺失';
const title = id => id === 'legacy100' ? '原 100 BEM 合约' : `${id} BEM 场${id === '1' ? ' · 测试场' : ''}`;
const status = value => ({ 0: '等待记录', 1: '购买中', 2: '已售满', 3: '等待随机数', 4: '等待结算', 5: '已完成', 6: '退款期' })[value] ?? '未知状态';
const indexText = index => index?.state === 'ready' ? '已同步确认记录' : index?.state === 'stale' ? '同步中断 · 以下为已确认部分记录' : '同步中 · 以下统计尚未完整';
export function fillDuration(round) {
  if (round.fillSeconds === null || round.fillSeconds === undefined) return round.sold < 10000 ? '尚未售满' : '时间记录缺失';
  const seconds = Number(round.fillSeconds);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return '时间记录缺失';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
  return [hours ? `${hours}小时` : '', minutes ? `${minutes}分` : '', remainder || !hours && !minutes ? `${remainder}秒` : ''].filter(Boolean).join(' ');
}
function link(value, type = 'address') {
  const valid = type === 'tx' ? /^0x[0-9a-f]{64}$/i.test(value) : /^0x[0-9a-f]{40}$/i.test(value);
  if (!valid) return node('span', '记录缺失');
  const result = node('a', value, 'mono'); result.href = `https://bscscan.com/${type}/${value}`;
  result.target = '_blank'; result.rel = 'noopener noreferrer'; return result;
}
function metric(label, value) { const result = node('div'); result.append(node('span', label), node('strong', value)); return result; }
function table(headers, rows, empty) {
  if (!rows.length) return node('p', empty, 'activity-empty');
  const wrap = node('div', undefined, 'activity-table-wrap'), result = node('table', undefined, 'activity-table'), head = node('thead'), tr = node('tr');
  headers.forEach(label => tr.append(node('th', label))); head.append(tr); result.append(head);
  const body = node('tbody');
  for (const cells of rows) { const row = node('tr'); cells.forEach((value, index) => { const td = node('td'); td.dataset.label = headers[index]; td.append(typeof value === 'string' ? node('span', value) : value); row.append(td); }); body.append(row); }
  result.append(body); wrap.append(result); return wrap;
}
function pager(data, load) {
  const result = node('nav', undefined, 'activity-pager'); result.setAttribute('aria-label', '明细分页');
  const previous = node('button', '上一页'), next = node('button', '下一页'); previous.type = next.type = 'button';
  previous.disabled = data.page <= 1; next.disabled = data.page >= data.totalPages;
  previous.addEventListener('click', () => load(data.page - 1)); next.addEventListener('click', () => load(data.page + 1));
  result.append(previous, node('span', `${data.page} / ${Math.max(1, data.totalPages)} · 共 ${data.total} 条`), next); return result;
}

export function createAdminActivity({ api, onError }) {
  const target = document.getElementById('activity-pools'), requests = new WeakMap(); let generation = 0;
  function failure(container, error, epoch) {
    if (epoch !== generation) return;
    container.replaceChildren(node('p', error.status === 401 ? '登录已过期，请重新登录。' : '明细读取暂未完成，请点击“刷新主网数据”重试。', 'error'));
    onError(error);
  }
  async function loadRound(container, poolId, roundId, state, epoch) {
    const request = (requests.get(container) ?? 0) + 1; requests.set(container, request);
    container.replaceChildren(node('p', '正在读取本期已确认购买…'));
    const query = new URLSearchParams({ walletPage: state.walletPage, transactionPage: state.transactionPage, pageSize: 25 });
    if (state.wallet) query.set('wallet', state.wallet);
    try {
      const data = await api(`/api/admin/pools/${poolId}/rounds/${roundId}?${query}`);
      if (epoch !== generation || requests.get(container) !== request) return;
      const reload = () => loadRound(container, poolId, roundId, state, epoch);
      const times = node('dl', undefined, 'activity-times');
      for (const [label, value] of [['开盘时间', date(data.round.startedAt)], ['售满时间', data.round.filledAt ? date(data.round.filledAt) : '尚未售满或记录缺失'], ['完成时间', data.round.settledAt ? date(data.round.settledAt) : '尚未完成']]) {
        const item = node('div'); item.append(node('dt', label), node('dd', value)); times.append(item);
      }
      const wallets = table(['参与钱包地址', '购买次数', '份数', '累计投入', '逐笔记录'], data.wallets.rows.map(wallet => {
        const button = node('button', '查看购买'); button.type = 'button';
        button.addEventListener('click', () => { state.wallet = getAddress(wallet.address); state.transactionPage = 1; reload(); });
        return [link(wallet.address), String(wallet.purchaseCount), String(wallet.tickets), bem(wallet.paidBaseUnits), button];
      }), '本期尚无已确认购买钱包。');
      const heading = node('div', undefined, 'activity-detail-heading'); heading.append(node('h4', state.wallet ? '该钱包逐笔购买' : '本期逐笔购买'));
      if (state.wallet) {
        const clear = node('button', '查看全部钱包'); clear.type = 'button'; clear.addEventListener('click', () => { state.wallet = null; state.transactionPage = 1; reload(); });
        heading.append(link(state.wallet), clear);
      }
      const purchases = table(['购买钱包地址', '份数', '投入', '北京时间', '交易哈希'], data.purchases.rows.map(purchase =>
        [link(purchase.buyer), String(purchase.tickets), bem(purchase.paidBaseUnits), date(purchase.timeUtc), link(purchase.transactionHash, 'tx')]), '暂无符合条件的已确认购买。');
      container.replaceChildren(times, node('p', indexText(data.index), 'activity-index'), node('h4', '本期钱包汇总'), wallets,
        pager(data.wallets, page => { state.walletPage = page; reload(); }), heading, purchases,
        pager(data.purchases, page => { state.transactionPage = page; reload(); }));
      if (data.round.filledTxHash || data.round.settlementTxHash) {
        const proof = node('div', undefined, 'activity-proof');
        if (data.round.filledTxHash) proof.append(node('span', '售满交易：'), link(data.round.filledTxHash, 'tx'));
        if (data.round.settlementTxHash) proof.append(node('span', '完成交易：'), link(data.round.settlementTxHash, 'tx'));
        container.append(proof);
      }
    } catch (error) { if (requests.get(container) === request) failure(container, error, epoch); }
  }
  async function loadRounds(container, poolId, page, epoch) {
    const request = (requests.get(container) ?? 0) + 1; requests.set(container, request);
    container.replaceChildren(node('p', '正在读取本场次各期记录…'));
    try {
      const data = await api(`/api/admin/pools/${poolId}/rounds?page=${page}&pageSize=10`);
      if (epoch !== generation || requests.get(container) !== request) return;
      const rows = data.rows.map(round => {
        const details = node('details', undefined, 'activity-round'), summary = node('summary'), content = node('div', undefined, 'activity-round-content');
        summary.append(node('b', `第 ${round.roundId} 期 · ${status(round.status)}`), node('span', `售满用时 ${fillDuration(round)}`),
          node('span', `${round.sold.toLocaleString('zh-CN')} / 10,000 份 · ${round.walletCount} 个钱包 · ${round.purchaseCount} 次购买`));
        let loaded = false;
        details.addEventListener('toggle', () => {
          if (!details.open || loaded) return; loaded = true;
          loadRound(content, poolId, round.roundId, { walletPage: 1, transactionPage: 1, wallet: null }, epoch);
        });
        details.append(summary, content); return details;
      });
      container.replaceChildren(node('p', indexText(data.index), 'activity-index'), ...(rows.length ? rows : [node('p', '本场次暂无已确认期数。', 'activity-empty')]), pager(data, next => loadRounds(container, poolId, next, epoch)));
    } catch (error) { if (requests.get(container) === request) failure(container, error, epoch); }
  }
  function render(data) {
    const epoch = ++generation, pools = data.pools.filter(pool => POOLS.has(pool.poolId));
    const known = pools.filter(pool => pool.summary), complete = pools.length === 5 && pools.every(pool => pool.summary && pool.index?.state === 'ready');
    document.getElementById('today-completed').textContent = known.length ? String(known.reduce((sum, pool) => sum + pool.summary.todayCompletedCount, 0)) : '—';
    document.getElementById('today-caption').textContent = complete ? '今日已完成开奖' : '今日已确认完成 · 同步尚未完整';
    document.getElementById('activity-day').textContent = `${data.day.date} · 北京时间 00:00—24:00（Asia/Shanghai）`;
    document.getElementById('activity-generated').textContent = `统计更新时间 ${date(data.generatedAt)} · 仅计已确认的成功开奖；购买次数按交易合并。`;
    target.replaceChildren(...pools.map(pool => {
      const section = node('section', undefined, 'pool-activity'); section.dataset.pool = pool.poolId;
      const heading = node('div', undefined, 'pool-activity-heading'); heading.append(node('h3', title(pool.poolId)), node('span', indexText(pool.index)));
      const summary = pool.summary, stats = node('div', undefined, 'pool-activity-metrics');
      stats.append(metric('今日完成', summary?.todayCompletedCount ?? '—'), metric('累计完成', summary?.completedCount ?? '—'),
        metric('今日购买次数', summary?.todayPurchaseCount ?? '—'), metric('累计参与钱包', summary?.walletCount ?? '—'));
      const details = node('details', undefined, 'pool-rounds'), label = node('summary', `查看逐期参与明细${summary ? ` · ${summary.roundCount} 期` : ''}`), content = node('div');
      details.addEventListener('toggle', () => { if (details.open && !content.childNodes.length) loadRounds(content, pool.poolId, 1, epoch); });
      details.append(label, content); section.append(heading, stats, link(pool.gameAddress), details); return section;
    }));
  }
  function clear() { generation++; target.replaceChildren(); document.getElementById('today-completed').textContent = '—'; }
  return { render, clear };
}
