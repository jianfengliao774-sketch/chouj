import { getAddress } from 'ethers';

// Reads the persisted, receipt-verified history index; never accepts client records.
export function participationQuery(params, sources) {
  const wallet = getAddress(params.get('wallet') ?? '');
  const pool = params.get('pool') || 'all', roundId = params.get('round') || null;
  const page = Number(params.get('page') || 1), pageSize = 20;
  if (pool !== 'all' && !Object.hasOwn(sources, pool) || roundId && !/^[1-9][0-9]{0,20}$/.test(roundId)
    || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw Error('Invalid participation query');
  const selected = Object.entries(sources).filter(([id]) => pool === 'all' || id === pool);
  const rounds = selected.flatMap(([poolId, index]) => (index?.walletParticipation(wallet, roundId) ?? []).map(row => ({ ...row, poolId })));
  rounds.sort((a, b) => Date.parse(b.lastPurchaseAt) - Date.parse(a.lastPurchaseAt) || a.poolId.localeCompare(b.poolId));
  return { schemaVersion: 1, chainId: 56, wallet, pool, roundId, page, pageSize, total: rounds.length,
    totalPages: Math.ceil(rounds.length / pageSize), sources: selected.map(([poolId, index]) => ({ poolId, index: index?.getStatus() ?? { state: 'awaiting_index' } })),
    totals: { tickets: rounds.reduce((sum, row) => sum + row.tickets, 0), purchases: rounds.reduce((sum, row) => sum + row.purchaseCount, 0),
      paidBaseUnits: rounds.reduce((sum, row) => sum + BigInt(row.paidBaseUnits), 0n).toString() },
    rows: rounds.slice((page - 1) * pageSize, page * pageSize) };
}
