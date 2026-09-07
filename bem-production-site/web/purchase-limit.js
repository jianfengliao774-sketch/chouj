// Display/selection guidance only; purchasing still rechecks fresh onchain data.
export function availablePurchaseLimit(sold, held = 0) {
  if (!Number.isInteger(sold) || sold < 0 || sold > 10000 ||
      !Number.isInteger(held) || held < 0 || held > 5000) return null;
  return Math.min(5000, 10000 - sold, 5000 - held);
}

export function clampPurchaseCount(value, limit) {
  if (limit === null || !/^\d+$/.test(value)) return value;
  return String(limit === 0 ? 0 : Math.max(1, Math.min(Number(value), limit)));
}
