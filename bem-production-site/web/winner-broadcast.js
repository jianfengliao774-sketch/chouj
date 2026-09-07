import { t, getLocale } from './player-i18n.js';
import { validateRecords, transactionUrl } from './public-record-guards.js';
import { formatUnits } from 'ethers';

// Shared read-only announcements. The original-contract page keeps its own history and wallet logic.
const target = document.getElementById('winner-ticker');
const pause = document.getElementById('ticker-pause');
let feed = null, paused = false;
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
    target.textContent = feed?.index?.state === 'ready'
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
    a.append(document.createTextNode(`${shortened(row.winner)} · ${new Date(row.timeUtc).toLocaleString(getLocale())} `));
    const b = document.createElement('strong');
    b.textContent = t('中了 {amount} BEM', 'won {amount} BEM', { amount: amount(row.amountBaseUnits) });
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
  try {
    const response = await fetch('/api/announcements?pageSize=20', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw Error('Announcements unavailable');
    feed = validateRecords(await response.json(), 'winner');
  } catch { feed = null; }
  renderTicker();
}

if (target && pause) {
  pause.addEventListener('click', () => { paused = !paused; renderTicker(); });
  window.addEventListener('bem:languagechange', renderTicker);
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  refresh();
}
