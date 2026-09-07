import { formatUnits } from 'ethers';
import { t, getLocale } from './player-i18n.js';

export function initPersonalRecords({ getAccount }) {
  const $ = id => document.getElementById(id);
  if (!$('personal-list')) return;
  let data = null, page = 1, generation = 0, loading = false, failed = false, lastAccount = null;
  const money = amount => formatUnits(amount, 8).replace(/\.0+$/, '');
  function render() {
    const status = $('personal-status');
    status.textContent = loading ? t('正在查询服务器记录…', 'Reading server records…') : failed ? t('查询失败，请核对钱包地址后重试。', 'Could not load records. Check the wallet address and retry.')
      : !data ? t('连接钱包或输入钱包地址查询。', 'Connect or enter a wallet address to search.')
      : t('共参与 {rounds} 期 · 购买 {times} 次 · {tickets} 份 · 合计 {amount} BEM', '{rounds} rounds · {times} purchases · {tickets} tickets · Total {amount} BEM',
        { rounds: data.total, times: data.totals.purchases, tickets: data.totals.tickets, amount: money(data.totals.paidBaseUnits) })
        + (data.sources.some(s => s.index.state !== 'ready') ? t(' · 索引同步中，仅展示已确认记录。', ' · Index syncing; showing confirmed records.') : '');
    $('personal-list').replaceChildren();
    for (const row of data?.rows ?? []) {
      const article = document.createElement('article'); article.className = 'personal-round';
      const title = document.createElement('h3'); title.textContent = t('{pool} BEM · 第 {round} 期', '{pool} BEM · Round {round}', { pool: row.poolId === 'legacy100' ? t('原 100', 'Original 100') : row.poolId, round: row.roundId });
      const summary = document.createElement('p'); summary.textContent = t('购买 {count} 次 · {tickets} 份 · {amount} BEM', '{count} purchases · {tickets} tickets · {amount} BEM', { count: row.purchaseCount, tickets: row.tickets, amount: money(row.paidBaseUnits) });
      article.append(title, summary);
      for (const purchase of row.purchases) {
        const details = document.createElement('details'), header = document.createElement('summary');
        header.textContent = `${new Date(purchase.timeUtc).toLocaleString(getLocale())} · ${purchase.tickets} ${t('份', 'tickets')} · ${money(purchase.paidBaseUnits)} BEM`;
        const numbers = document.createElement('p'); numbers.textContent = t('购买号码：{numbers}', 'Purchased numbers: {numbers}', { numbers: purchase.ticketRanges.map(range => range.endExclusive === range.firstTicket + 1 ? String(range.endExclusive).padStart(5, '0') : `${String(range.firstTicket+1).padStart(5,'0')}–${String(range.endExclusive).padStart(5,'0')}`).join(', ') });
        const a = document.createElement('a'); a.href = `https://bscscan.com/tx/${purchase.transactionHash}`; a.textContent = purchase.transactionHash; a.target = '_blank'; a.rel = 'noopener noreferrer';
        details.append(header, numbers, a); article.append(details);
      }
      $('personal-list').append(article);
    }
    if (data && !data.rows.length) { const p = document.createElement('p'); p.textContent = t('暂无匹配的已确认购买记录。', 'No matching confirmed purchases.'); $('personal-list').append(p); }
    $('personal-page').textContent = `${page} / ${Math.max(1, data?.totalPages ?? 1)}`;
    $('personal-prev').disabled = loading || page <= 1; $('personal-next').disabled = loading || !data || page >= data.totalPages;
  }
  async function search(next = 1) {
    const version = ++generation; page = next; loading = true; failed = false; data = null; render();
    const params = new URLSearchParams({ wallet: $('personal-wallet').value.trim(), pool: $('personal-pool').value, round: $('personal-round').value.trim(), page });
    try {
      const response = await fetch(`/api/participation?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error();
      const result = await response.json(); if (version !== generation) return;
      if (result.schemaVersion !== 1 || result.chainId !== 56 || !Array.isArray(result.rows)) throw Error();
      data = result;
    } catch { if (version === generation) failed = true; }
    finally { if (version === generation) { loading = false; render(); } }
  }
  function syncAccount() {
    const account = getAccount() || null;
    if (account?.toLowerCase() === lastAccount?.toLowerCase()) return false;
    lastAccount = account;
    // Invalidate the previous wallet's pending response before starting another.
    generation++; page = 1; data = null; loading = false; failed = false;
    $('personal-wallet').value = account ?? '';
    if (account) search(); else render();
    return true;
  }
  $('personal-search').addEventListener('click', () => search());
  $('personal-prev').addEventListener('click', () => search(Math.max(1, page-1)));
  $('personal-next').addEventListener('click', () => search(page+1));
  for (const id of ['personal-wallet','personal-round']) $(id).addEventListener('keydown', event => { if (event.key === 'Enter') search(); });
  window.addEventListener('bem:personalshow', () => {
    if (syncAccount()) return;
    if (!$('personal-wallet').value) $('personal-wallet').value = getAccount() ?? new URLSearchParams(location.search).get('wallet') ?? '';
    if ($('personal-wallet').value) search(); else render();
  });
  window.addEventListener('bem:languagechange', render);
  render();
  syncAccount();
  return { syncAccount };
}
