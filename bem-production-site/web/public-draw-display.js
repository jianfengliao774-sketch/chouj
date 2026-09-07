import { publicDrawState, duration } from './public-draw-state.js';
import { t } from './player-i18n.js';

export function createPublicDrawDisplay({ getSnapshot, getPoolId }) {
  const $ = id => document.getElementById(id);
  const put = (id, text) => { if ($(id)) $(id).textContent = text; };
  let latest = null, observedSnapshot = null, observedAt = 0;
  function render() {
    const snapshot = getSnapshot();
    if (snapshot !== observedSnapshot) { observedSnapshot = snapshot; observedAt = Date.now(); }
    const now = snapshot ? Date.parse(snapshot.snapshot.timeUtc) / 1000 + (Date.now() - observedAt) / 1000 : Date.now() / 1000;
    const draw = publicDrawState(snapshot, now);
    const poolId = getPoolId();
    const confirmed = latest?.poolId === poolId ? latest : null;
    const result = draw?.winner ?? confirmed;
    if (draw) {
      const phases = [t('等待下一期', 'Awaiting next round'), t('购买中', 'Funding'), t('已封盘', 'Sales closed'),
        t('等待 VRF', 'Awaiting VRF'), t('等待结算', 'Awaiting settlement'), t('已结算', 'Settled'), t('退款中', 'Refunding')];
      put('round-label', t('{pool} BEM · 第 {round} 期', '{pool} BEM · Round {round}', { pool: poolId, round: draw.roundId }));
      put('round-phase', phases[draw.status]);
      put('funding-tickets', t('{count} / 10,000 份', '{count} / 10,000 tickets', { count: draw.sold.toLocaleString() }));
      put('funding-amount', `${(draw.sold * Number(poolId) / 10000).toFixed(4).replace(/\.?0+$/, '') || '0'} / ${poolId} BEM`);
      const bar = $('funding-progress')?.firstElementChild; if (bar) bar.style.width = `${draw.sold / 100}%`;
      if ($('countdown-panel')) $('countdown-panel').hidden = !draw.deadline;
      if (draw.deadline) {
        put('countdown-label', draw.status === 1 ? t('购买剩余时间', 'Funding time remaining')
          : draw.status === 4 ? t('可结算倒计时', 'Time until settlement is available') : t('开奖目标倒计时', 'Target draw countdown'));
        put('countdown-value', duration(draw.remaining));
        put('countdown-note', draw.status === 1 ? t('满额提前封盘；未满额到期后按规则领取本金。', 'Sales close when full; incomplete rounds follow the refund rules.')
          : draw.status === 4 ? t('随机数已返回，到点后需发送结算交易。', 'Randomness received. A settlement transaction is required when due.')
          : draw.overdue ? t('已超过目标时间，仍在等待 Chainlink VRF；尚未产生中奖号码。', 'The target time has passed. Waiting for Chainlink VRF; no winning number yet.')
          : t('这是开奖目标时间，实际结果取决于 VRF 回调和结算上链。', 'This is a target; the result requires the VRF callback and onchain settlement.'));
      }
      if ([2,3,4].includes(draw.status)) {
        put('reel-caption', t('第 {round} 期 · {phase}', 'Round {round} · {phase}', { round: draw.roundId, phase: phases[draw.status] }));
        put('reel-message', draw.status === 4 ? t('随机数已返回，等待结算交易确认中奖号码及钱包。', 'Randomness received. Awaiting settlement to determine the winning ticket and wallet.')
          : t('本期已售满封盘，等待 VRF 随机数，尚未开奖。', 'This round is sold out and closed. Waiting for VRF randomness; it has not drawn yet.'));
        if (Number(snapshot.currentRound.status) === 0) put('purchase-state', t('第 {round} 期正在开奖，结算后开放下一期。', 'Round {round} is drawing. The next round opens after settlement.', { round: draw.roundId }));
      }
      for (const [step, active] of [['lock', draw.status >= 2 && draw.status <= 5], ['random', [4,5].includes(draw.status)], ['circuit', draw.status === 5], ['settle', draw.status === 5]]) $('step-'+step)?.classList.toggle('active', active);
    }
    const validResult = result && Number.isInteger(Number(result.winningTicket)) && Number(result.winningTicket) >= 0 && Number(result.winningTicket) < 10000;
    const digits = validResult ? String(Number(result.winningTicket) + 1).padStart(5, '0') : null;
    document.querySelectorAll('#reels .reel').forEach((reel, i) => {
      const placeholder = reel.querySelector('.placeholder'); if (placeholder) { placeholder.hidden = false; placeholder.textContent = digits?.[i] ?? '—'; }
      const strip = reel.querySelector('.reel-strip'); if (strip) strip.replaceChildren();
    });
    if ($('replay')) $('replay').disabled = !validResult;
    let winner = $('public-draw-winner');
    if (!winner && $('reel-message')) { winner = document.createElement('p'); winner.id = 'public-draw-winner'; winner.style.overflowWrap = 'anywhere'; $('reel-message').after(winner); }
    if (winner) { winner.replaceChildren(); winner.hidden = !validResult; }
    if (validResult) {
      // A later round may be funding while the last settled result remains visible.
      put('reel-caption', t('第 {round} 期 · 链上已结算', 'Round {round} · Settled onchain', { round: result.roundId }));
      put('reel-message', t('中奖号码 {ticket}', 'Winning number {ticket}', { ticket: digits }));
      $('reels')?.setAttribute('aria-label', t('中奖号码 {ticket}', 'Winning number {ticket}', { ticket: digits }));
      const a = document.createElement('a'); a.href = `https://bscscan.com/address/${result.winner}`; a.textContent = result.winner;
      a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.color = 'inherit';
      winner?.append(document.createTextNode(t('中奖钱包：', 'Winner wallet: ')), a);
      if (confirmed?.transactionHash && String(confirmed.roundId) === String(result.roundId)) {
        const tx = document.createElement('a'); tx.href = `https://bscscan.com/tx/${confirmed.transactionHash}`;
        tx.textContent = t(' 查看结算凭证 ↗', ' Settlement receipt ↗'); tx.target = '_blank'; tx.rel = 'noopener noreferrer'; tx.style.color = 'inherit'; winner?.append(tx);
      }
    } else $('reels')?.setAttribute('aria-label', t('尚未开奖', 'No draw result yet'));
  }
  window.addEventListener('bem:drawrecords', event => {
    if (event.detail?.poolId !== getPoolId()) return;
    latest = event.detail.records[0] ?? null; render();
  });
  window.addEventListener('bem:poolchange', () => { latest = null; render(); });
  $('replay')?.addEventListener('click', () => { $('reels')?.animate([{ opacity: 0, transform: 'translateY(-12px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 550 }); });
  const timer = setInterval(() => { if (!document.hidden) render(); }, 1000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
  return { render };
}
