const changed = () => Object.assign(new Error('CONTEXT_CHANGED'), { code: 'CONTEXT_CHANGED' });
export function purchaseContextKey(context) {
  return JSON.stringify([context.epoch, context.poolId, context.account?.toLowerCase(), context.chainId, context.selection]);
}
// This continuation exists only for the user's current click. It is not persisted
// and cannot resume a purchase after reloading or changing account/selection.
export function createApprovalPurchaseFlow({ getKey, send, waitForApproval }) {
  let running = false, revision = 0;
  return {
    get busy() { return running; },
    cancel() { revision++; },
    async run({ needsApproval, input }) {
      if (running) throw Object.assign(new Error('TRANSACTION_IN_FLIGHT'), { code: 'TRANSACTION_IN_FLIGHT' });
      const key = getKey(), version = revision, order = structuredClone(input); running = true;
      const unchanged = () => { if (version !== revision || getKey() !== key) throw changed(); };
      try {
        unchanged();
        if (needsApproval) {
          const approval = await send('approve', order); unchanged();
          const result = await waitForApproval(approval, unchanged); unchanged();
          if (result?.id !== approval.id || result?.hash !== approval.hash || result?.status !== 'confirmed')
            throw Object.assign(new Error('Approval not confirmed'), { code: 'APPROVAL_REQUIRED' });
        }
        unchanged(); return await send('buy', order);
      } finally { running = false; }
    }
  };
}
