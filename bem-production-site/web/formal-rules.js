export const FORMAL_POOL_IDS = Object.freeze(['5', '10', '50', '100']);
export const BURN_PERCENT = Object.freeze({ '5': 3, '10': 4, '50': 5, '100': 6 });
export function formalRules(id) {
  if (!FORMAL_POOL_IDS.includes(String(id))) throw new Error('Unknown formal pool');
  const pool = BigInt(id) * 100000000n, burn = BigInt(BURN_PERCENT[id]);
  return Object.freeze({ poolBaseUnits: String(pool), ticketPriceBaseUnits: String(pool / 10000n),
    blackholeBaseUnits: String(pool * burn / 100n), organizerBaseUnits: String(pool / 100n),
    winnerBaseUnits: String(pool * (99n - burn) / 100n), maxTicketsPerPurchase: 5000,
    burnPercent: Number(burn), earlyDrawThreshold: 9500, earlyDrawDelaySeconds: 1800 });
}
