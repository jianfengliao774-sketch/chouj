// Read-only presentation of already-confirmed winner records. No draw generation.
export const WINNER_ROTATION_MS = 10000;

export function latestWinnerForPool(rows, poolId) {
  let latest = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row.poolId) !== String(poolId) || Number(row.status) !== 5 ||
        !/^[1-9][0-9]*$/.test(String(row.roundId)) ||
        !Number.isInteger(row.winningTicket) || row.winningTicket < 0 || row.winningTicket >= 10000 ||
        !/^0x[0-9a-f]{40}$/i.test(row.winner || '') || /^0x0{40}$/i.test(row.winner)) continue;
    if (!latest || BigInt(row.roundId) > BigInt(latest.roundId)) latest = row;
  }
  return latest;
}

export function createWinnerRotation({ onDisplay, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let rows = [], index = 0, timer = null, paused = false, hidden = false, disposed = false;
  const current = () => rows[index] || null;
  const key = row => row ? `${row.poolId}:${row.roundId}:${row.winningTicket}:${row.winner}` : '';
  const stop = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const render = () => { if (!disposed) onDisplay(current(), { paused, count: rows.length }); };
  function schedule() {
    stop();
    if (disposed || paused || hidden || rows.length < 2) return;
    timer = setTimer(() => { timer = null; index = (index + 1) % rows.length; render(); schedule(); }, WINNER_ROTATION_MS);
  }
  return {
    update(next) {
      if (disposed) return;
      const previous = key(current()), selectedPool = current()?.poolId;
      rows = [...next];
      index = Math.max(0, rows.findIndex(row => row.poolId === selectedPool));
      render();
      if (rows.length < 2) stop();
      else if (previous !== key(current()) || timer === null) schedule();
    },
    render,
    togglePause() { paused = !paused; render(); schedule(); },
    setHidden(value) { if (hidden === Boolean(value)) return; hidden = Boolean(value); schedule(); },
    dispose() { disposed = true; stop(); rows = []; },
  };
}
