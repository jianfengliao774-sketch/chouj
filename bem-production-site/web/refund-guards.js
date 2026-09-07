import { getAddress } from 'ethers';
import { PINNED, GuardError, same, validateManifest } from './guards.js';

export function parseRefundRound(value) {
  if (!/^[1-9]\d{0,77}$/.test(String(value)) || BigInt(value) >= 2n ** 256n) throw new GuardError('REFUND_ROUND');
  return String(BigInt(value));
}

export function refundEligibility(snapshot) {
  if (!snapshot) return {eligible:false, reason:'STALE', amount:0n};
  const count = BigInt(snapshot.myCount ?? 0);
  const amount = count * PINNED.ticketPrice;
  if (count <= 0n) return {eligible:false, reason:'NOTHING_TO_REFUND', amount:0n};
  const status = Number(snapshot.status);
  const deadline = status === 1 ? Number(snapshot.fundingDeadline) : status === 2 ? Number(snapshot.drawDeadline) : 0;
  if (status === 6 || ((status === 1 || status === 2) && Number.isSafeInteger(deadline) && deadline > 0 && Number(snapshot.timestamp) >= deadline)) {
    return {eligible:true, reason:null, amount};
  }
  return {eligible:false, reason:status === 1 || status === 2 ? 'REFUND_TOO_EARLY' : 'REFUND_UNAVAILABLE', amount};
}

export function createRefundIntent({roundId, account, epoch, snapshot}) {
  if (!account) throw new GuardError('WALLET');
  const eligibility = refundEligibility(snapshot);
  if (!eligibility.eligible) throw new GuardError(eligibility.reason);
  return Object.freeze({roundId:parseRefundRound(roundId), account:getAddress(account), epoch, amount:eligibility.amount});
}

export function assertRefundSnapshot({config, snapshot, intent, walletAccount, walletChain, epoch}) {
  validateManifest(config);
  // Refunding must remain available while sales and new series are disabled.
  if (Number(walletChain) !== 56) throw new GuardError('NETWORK');
  if (epoch !== intent.epoch || !same(walletAccount,intent.account) || !same(snapshot?.account,intent.account)) throw new GuardError('WALLET_CHANGED');
  if (String(snapshot?.roundId) !== intent.roundId) throw new GuardError('REFUND_ROUND');
  const eligibility = refundEligibility(snapshot);
  if (!eligibility.eligible) throw new GuardError(eligibility.reason);
  if (eligibility.amount !== intent.amount) throw new GuardError('REFUND_CHANGED');
}
