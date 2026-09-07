// Website transaction budget, in wei. It does not change contract execution or
// govern transactions assembled independently by a wallet or another client.
export const PURCHASE_GAS_FEE_CAP = 1_000_000_000_000_000n; // 0.001 BNB
export function enforcePurchaseGasBudget(kind, gasLimit, gasPrice) {
  if (kind !== 'buy' && kind !== 'approve') return;
  if (typeof gasLimit !== 'bigint' || gasLimit <= 0n || typeof gasPrice !== 'bigint' || gasPrice <= 0n)
    throw Object.assign(new Error('GAS_PRICE_UNAVAILABLE'), { code: 'GAS_PRICE_UNAVAILABLE' });
  const maximumFee = gasLimit * gasPrice;
  if (maximumFee > PURCHASE_GAS_FEE_CAP)
    throw Object.assign(new Error('GAS_FEE_CAP_EXCEEDED'), {
      code: 'GAS_FEE_CAP_EXCEEDED', maximumFee, feeCap: PURCHASE_GAS_FEE_CAP,
    });
  return maximumFee;
}
