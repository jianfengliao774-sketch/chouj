/** Wallet text only. Never use this rounded string for fees, approvals or purchases. */
export function formatWalletBalance3(baseUnits, decimals) {
  if (!Number.isInteger(decimals) || decimals < 3 || decimals > 36) {
    throw new RangeError('Unsupported token display precision');
  }
  const units = BigInt(baseUnits);
  if (units < 0n) throw new RangeError('Wallet balances must be non-negative');
  const scale = 10n ** BigInt(decimals - 3);
  const thousandths = (units + scale / 2n) / scale;
  return `${thousandths / 1000n}.${String(thousandths % 1000n).padStart(3, '0')}`;
}
