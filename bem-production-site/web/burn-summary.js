import { formatUnits } from 'ethers';
import { t, getLocale } from './player-i18n.js';
export const BURN_SUMMARY_REFRESH_MS = 300_000;
export function validateBurnSummary(value) {
  if (value?.schemaVersion !== 1 || value.chainId !== 56 || value.scope !== 'all_registered_pools'
    || value.decimals !== 8 || !/^(0|[1-9][0-9]*)$/.test(value.amountBaseUnits)
    || !Number.isSafeInteger(value.burnCount) || value.burnCount < 0
    || !Number.isFinite(Date.parse(value.updatedAt)) || !Number.isFinite(Date.parse(value.nextUpdateAt))
    || value.refreshIntervalMs !== BURN_SUMMARY_REFRESH_MS || !['ready', 'syncing'].includes(value.index?.state)) throw Error('Invalid burn summary');
  return value;
}
let started = false, snapshot = null, reading = false, failed = false, lastAttempt = 0;
function render() {
  const amount = document.getElementById('burn-total'), status = document.getElementById('burn-summary-status');
  if (!amount || !status) return;
  amount.textContent = snapshot ? formatUnits(snapshot.amountBaseUnits, 8).replace(/\.0$/, '') : '—';
  const time = snapshot ? new Date(snapshot.updatedAt).toLocaleString(getLocale()) : '';
  status.textContent = failed ? t('更新暂不可用，保留上次确认统计。','Update unavailable; retaining the last confirmed total.')
    : snapshot ? t('已确认 {count} 笔 · 更新于 {time}','{count} confirmed burns · Updated {time}', {count:snapshot.burnCount,time})
      + (snapshot.index.state === 'ready' ? '' : t(' · 索引同步中，累计暂不完整',' · Index syncing; total is incomplete'))
    : t('正在读取累计销毁…','Loading total burned…');
}
async function load() {
  if (reading) return;
  reading = true;lastAttempt = Date.now();
  try {
    const response = await fetch('/api/burns/summary', {cache:'no-store',signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw Error('Unavailable');
    snapshot = validateBurnSummary(await response.json());failed = false;
  } catch { failed = true; }
  finally { reading = false;render(); }
}
export function showBurnSummary() {
  if (!started) {
    started = true;
    setInterval(() => { if (!document.hidden) load(); }, BURN_SUMMARY_REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastAttempt >= BURN_SUMMARY_REFRESH_MS) load(); });
    window.addEventListener('bem:languagechange', render);
  }
  if (!snapshot || Date.now() - lastAttempt >= BURN_SUMMARY_REFRESH_MS) load();
  else render();
}
