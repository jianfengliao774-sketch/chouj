export const BURN_SUMMARY_INTERVAL_MS = 300_000;
const DEAD = '0x000000000000000000000000000000000000dead';

// Sources are the server's receipt-confirmed indexes, never browser supplied rows.
// Reading a summary does not make RPC requests or re-scan the chain per visitor.
export function createBurnSummary({ sources, now = Date.now }) {
  let cached = null, computedAt = 0;
  return function read() {
    const at = now();
    if (cached && at >= computedAt && at - computedAt < BURN_SUMMARY_INTERVAL_MS) return structuredClone(cached);
    const seen = new Map(), states = [];
    let amount = 0n;
    for (const source of sources()) {
      const state = source?.getStatus() ?? { state: 'awaiting_index' };
      states.push({ state: state.state, indexedThrough: state.indexedThrough ?? null, updatedAt: state.updatedAt ?? null });
      for (const row of source?.listBurns({ all: true }).rows ?? []) {
        if (!['settlement', 'unclaimed', 'unclaimed_principal', 'unclaimed_prize'].includes(row.kind)
          || row.destination?.toLowerCase() !== DEAD
          || !/^[1-9][0-9]*$/.test(row.amountBaseUnits)
          || !/^0x[0-9a-f]{40}$/i.test(row.gameAddress)
          || !/^0x[0-9a-f]{64}$/i.test(row.transactionHash)
          || !Number.isSafeInteger(row.logIndex) || row.logIndex < 0) throw Error('Invalid confirmed burn');
        const key = `${row.gameAddress.toLowerCase()}:${row.transactionHash.toLowerCase()}:${row.logIndex}`;
        if (seen.has(key)) {
          if (seen.get(key) !== row.amountBaseUnits) throw Error('Conflicting confirmed burn');
          continue;
        }
        seen.set(key, row.amountBaseUnits);
        amount += BigInt(row.amountBaseUnits);
      }
    }
    computedAt = at;
    cached = { schemaVersion: 1, chainId: 56, scope: 'all_registered_pools', decimals: 8,
      amountBaseUnits: amount.toString(), burnCount: seen.size,
      updatedAt: new Date(at).toISOString(), nextUpdateAt: new Date(at + BURN_SUMMARY_INTERVAL_MS).toISOString(),
      refreshIntervalMs: BURN_SUMMARY_INTERVAL_MS,
      index: { state: states.length && states.every(s => s.state === 'ready') ? 'ready' : 'syncing', sources: states } };
    return structuredClone(cached);
  };
}
