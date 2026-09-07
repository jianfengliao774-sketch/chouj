const unfinished = record => !['confirmed', 'reverted'].includes(record.status);
export const hasFastPendingRead = state => Boolean(state?.records?.some(record =>
  ['approve', 'buy'].includes(record.kind) && /^0x[0-9a-f]{64}$/i.test(record.hash ?? '') && unfinished(record)));

/** Poll receipts only. This module has no wallet or transaction-submission API. */
export function createPendingReadPoller({ getManager, onResolved = () => {}, onError = () => {},
  document = globalThis.document, intervalMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, running = null, destroyed = false;
  const visible = () => !destroyed && document?.visibilityState === 'visible';
  const cancel = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const eligible = () => visible() && hasFastPendingRead(getManager()?.getState());
  function update() {
    if (!eligible()) { cancel(); return; }
    if (running || timer !== null) return;
    timer = setTimer(() => { timer = null; run(false); }, intervalMs);
  }
  function run(force) {
    cancel();
    if (running) return running;
    if (!visible()) return Promise.resolve(null);
    const manager = getManager(), before = manager?.getState();
    if (!manager || before.busy || !force && !hasFastPendingRead(before)) { update(); return Promise.resolve(before ?? null); }
    running = Promise.resolve().then(async () => {
      try {
        await manager.checkPending();
        const after = manager.getState();
        const newlyResolved = after.records?.filter(record => !unfinished(record) && before.records?.some(previous =>
          unfinished(previous) && previous.id === record.id && previous.hash === record.hash)) ?? [];
        if (!destroyed && manager === getManager() && before.blocking && !after.blocking) await onResolved(manager, after, newlyResolved);
        return after;
      } catch (error) {
        if (!destroyed) onError(error);
        return manager.getState();
      }
    }).finally(() => { running = null; update(); });
    return running;
  }
  const visibilityChanged = () => {
    cancel();
    if (eligible()) run(false);
  };
  document?.addEventListener('visibilitychange', visibilityChanged);
  return {
    update,
    checkNow: () => run(true),
    destroy() { destroyed = true; cancel(); document?.removeEventListener('visibilitychange', visibilityChanged); },
  };
}
