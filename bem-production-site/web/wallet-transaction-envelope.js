import { Interface } from 'ethers';

// MetaMask's deployed DelegationManager, observed in the user's BNB Chain receipt.
// A wallet may wrap the requested call in redeemDelegations before broadcasting.
const DELEGATION_MANAGER = '0xdb9b1e94b5b69df7e401ddbede43491141047db3';
const DELEGATION = new Interface(['function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const need = (ok, code = 'TRANSACTION_MISMATCH') => { if (!ok) { const error = new Error(code); error.code = code; throw error; } };
const integer = value => {
  need(typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value) ||
    typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value));
  const result = BigInt(value); need(result >= 0n && result < 2n ** 256n); return result;
};

export function verifyWalletTransactionEnvelope(transaction, intent, { allowWrappedNonce = true } = {}) {
  const tx = transaction, data = tx?.input ?? tx?.data;
  need(tx && same(tx.hash, intent.hash) && same(tx.from, intent.account) && integer(tx.chainId) === 56n && integer(tx.value) === 0n &&
    (tx.input == null || tx.data == null || same(tx.input, tx.data)));
  const nonce = integer(tx.nonce), expectedNonce = integer(intent.nonce);
  if (same(tx.to, intent.to) && same(data, intent.data)) {
    need(nonce === expectedNonce, 'NONCE_MISMATCH');
    return { wrapped: false, outerTo: tx.to, actualNonce: nonce.toString() };
  }
  need(same(tx.to, DELEGATION_MANAGER) && typeof data === 'string' && /^0x[0-9a-f]+$/i.test(data) && data.length <= 262146);
  let decoded;
  try { decoded = DELEGATION.decodeFunctionData('redeemDelegations', data); } catch { need(false); }
  // Only one atomic, single-call execution is accepted. No batch, try-mode,
  // delegatecall, unrelated calldata occurrence or extra execution is sufficient.
  need(decoded.permissionContexts.length === 1 && decoded.modes.length === 1 && decoded.executionCallDatas.length === 1 &&
    /^0x0{64}$/i.test(decoded.modes[0]) && same(DELEGATION.encodeFunctionData('redeemDelegations', decoded), data));
  const execution = decoded.executionCallDatas[0];
  need(execution.length >= 106 && same(execution.slice(0, 42), intent.to) && integer('0x' + execution.slice(42, 106)) === 0n &&
    same('0x' + execution.slice(106), intent.data));
  need(allowWrappedNonce ? nonce >= expectedNonce && nonce >= integer(intent.nonceFloor) : nonce === expectedNonce, 'NONCE_MISMATCH');
  return { wrapped: true, outerTo: tx.to, actualNonce: nonce.toString() };
}
