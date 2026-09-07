import { t, getLocale } from './player-i18n.js';
import { validateRecords, transactionUrl } from './public-record-guards.js';
import { formatUnits } from 'ethers';

// Shared read-only announcements. The original-contract page keeps its own history and wallet logic.
const target = document.getElementById('winner-ticker');
const pause = document.getElementById('ticker-pause');
let feed = null, paused = false, loadState = 'loading', requestVersion = 0;
const amount = value => Number(formatUnits(value, 8)).toLocaleString(getLocale(), { maximumFractionDigits: 8 });
const shortened = value => `${value.slice(0, 8)}…${value.slice(-6)}`;
const tier = row => row.poolId === 'legacy100' ? t('原 100 BEM 场', 'Original 100 BEM pool') : `${row.poolId} BEM`;

function renderTicker() {
  if (!target || !pause) return;
  target.replaceChildren();
  const rows = feed?.index?.state === 'ready' ? feed.rows : [];
  pause.hidden = rows.length < 2;
  pause.setAttribute('aria-pressed', String(paused));
  pause.textContent = paused ? t('继续', 'Resume') : t('暂停', 'Pause');
  target.classList.toggle('paused', paused);
  if (!rows.length) {
    target.textContent = loadState === 'error'
      ? t('中奖记录暂时无法加载 · 稍后自动重试', 'Winner records are temporarily unavailable · Retrying shortly')
      : loadState === 'loading'
        ? t('正在读取已确认开奖…', 'Reading confirmed draws…')
        : feed?.index?.state === 'ready'
          ? t('等待首位中奖者 · 开奖后自动播报', 'Awaiting the first winner · Confirmed draws appear here')
          : t('链上记录同步中…', 'Syncing onchain records…');
    return;
  }
  const track = document.createElement('div');
  track.className = 'ticker-track' + (rows.length > 1 ? ' is-moving' : '');
  const group = document.createElement('div');
  group.className = 'ticker-group';
  for (const row of rows) {
    const a = document.createElement('a');
    a.href = transactionUrl(row.transactionHash);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const timestamp = new Date(row.timeUtc).toLocaleString(getLocale());
    const winnings = amount(row.amountBaseUnits);
    a.setAttribute('aria-label', t(
      '{tier} · 第 {round} 期 · 中奖地址 {address} · 中奖时间 {time} · 中奖 {amount} BEM · 查看链上凭证',
      '{tier} · Round {round} · Winner address {address} · Winning time {time} · Prize {amount} BEM · View onchain receipt',
      { tier: tier(row), round: row.roundId, address: row.winner, time: timestamp, amount: winnings }));
    a.title = t('查看已确认开奖的链上凭证', 'View the confirmed draw’s onchain receipt');
    const time = document.createElement('time');
    time.dateTime = row.timeUtc;
    time.textContent = timestamp;
    a.append(document.createTextNode(`${shortened(row.winner)} · `), time, document.createTextNode(' '));
    const b = document.createElement('strong');
    b.textContent = t('中了 {amount} BEM', 'won {amount} BEM', { amount: winnings });
    a.append(b, document.createTextNode(` · ${tier(row)}`));
    group.append(a);
  }
  track.append(group);
  if (rows.length > 1) {
    const duplicate = group.cloneNode(true);
    duplicate.setAttribute('aria-hidden', 'true');
    for (const a of duplicate.querySelectorAll('a')) a.tabIndex = -1;
    track.append(duplicate);
  }
  target.append(track);
}

async function refresh() {
  const version = ++requestVersion;
  try {
    const response = await fetch('/api/announcements?pageSize=20', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw Error('Announcements unavailable');
    const next = validateRecords(await response.json(), 'winner');
    if (version !== requestVersion) return;
    feed = next;
    loadState = 'loaded';
  } catch {
    if (version !== requestVersion) return;
    feed = null;
    loadState = 'error';
  }
  renderTicker();
}

if (target && pause) {
  pause.addEventListener('click', () => { paused = !paused; renderTicker(); });
  window.addEventListener('bem:languagechange', renderTicker);
  window.addEventListener('bem:historyrefresh', refresh);
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  renderTicker();
  refresh();
}
