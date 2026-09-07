// Operations reporting over the history index's verified, confirmed events only.
// No RPC client, credentials, signing key or transaction sender belongs here.
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';

export const ADMIN_TIME_ZONE = 'Asia/Shanghai';
const DAY_MS = 86400000, SHANGHAI_OFFSET_MS = 8 * 3600000;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const order = (a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;
const roundOrder = (a, b) => BigInt(a.roundId) > BigInt(b.roundId) ? -1 : BigInt(a.roundId) < BigInt(b.roundId) ? 1 : 0;

export function adminDayWindow(now = Date.now()) {
  const value = Number(now instanceof Date ? now.getTime() : now);
  assert.ok(Number.isFinite(value), 'Invalid reporting time');
  // Current Asia/Shanghai civil days are UTC+08:00, independent of server TZ.
  const start = Math.floor((value + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
  return { timeZone: ADMIN_TIME_ZONE, date: new Date(start + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10),
    startUtc: new Date(start).toISOString(), endUtc: new Date(start + DAY_MS).toISOString() };
}

export function buildAdminRounds(events) {
  const rounds = new Map(), seen = new Set();
  for (const event of [...events].sort(order)) {
    const id = event.args?.roundId;
    if (!/^[1-9][0-9]*$/.test(String(id ?? ''))) continue;
    const key = `${String(event.blockHash).toLowerCase()}:${String(event.transactionHash).toLowerCase()}:${event.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let row = rounds.get(String(id));
    if (!row) {
      row = { roundId: String(id), status: 0, startedAt: null, filledAt: null, fillSeconds: null, filledTxHash: null,
        settledAt: null, settlementTxHash: null, winner: null, sold: 0, paidBaseUnits: '0', purchases: new Map() };
      rounds.set(row.roundId, row);
    }
    const args = event.args, at = timestamp(event.timeUtc);
    if (event.name === 'RoundStarted') { row.startedAt ??= at; row.status = 1; }
    if (event.name === 'TicketsPurchased') {
      const first = Number(args.firstTicket), end = Number(args.endExclusive), paid = BigInt(args.paid);
      assert.ok(Number.isSafeInteger(first) && Number.isSafeInteger(end) && first >= 0 && end > first && end <= 10000 && paid >= 0n, 'Invalid indexed ticket range');
      const buyer = getAddress(args.buyer), txKey = `${buyer.toLowerCase()}:${event.transactionHash.toLowerCase()}`;
      let purchase = row.purchases.get(txKey);
      if (!purchase) {
        purchase = { roundId: row.roundId, buyer, transactionHash: event.transactionHash, blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex, timeUtc: at, tickets: 0, paidBaseUnits: '0', ticketRanges: [] };
        row.purchases.set(txKey, purchase);
      }
      purchase.tickets += end - first;
      purchase.paidBaseUnits = (BigInt(purchase.paidBaseUnits) + paid).toString();
      purchase.ticketRanges.push({ firstTicket: first, endExclusive: end });
      row.sold += end - first;
      row.paidBaseUnits = (BigInt(row.paidBaseUnits) + paid).toString();
      if (row.sold === 10000 && row.filledAt === null) { row.filledAt = at; row.filledTxHash = event.transactionHash; }
    }
    if (event.name === 'RoundLocked') row.status = 2;
    if (event.name === 'DrawRequested') row.status = 3;
    if (event.name === 'RandomnessReceived') row.status = 4;
    if (event.name === 'RefundsOpened') row.status = 6;
    if (event.name === 'Settled') {
      row.status = 5; row.settledAt = at; row.settlementTxHash = event.transactionHash; row.winner = getAddress(args.winner);
    }
  }
  return [...rounds.values()].sort(roundOrder).map(row => {
    const wallets = new Map();
    const purchases = [...row.purchases.values()].sort((a, b) => b.blockNumber - a.blockNumber || b.transactionIndex - a.transactionIndex || a.transactionHash.localeCompare(b.transactionHash));
    for (const purchase of purchases) {
      const key = purchase.buyer.toLowerCase(); let wallet = wallets.get(key);
      if (!wallet) {
        wallet = { address: purchase.buyer, purchaseCount: 0, tickets: 0, paidBaseUnits: '0', firstPurchaseAt: null, lastPurchaseAt: null };
        wallets.set(key, wallet);
      }
      wallet.purchaseCount++; wallet.tickets += purchase.tickets;
      wallet.paidBaseUnits = (BigInt(wallet.paidBaseUnits) + BigInt(purchase.paidBaseUnits)).toString();
      if (purchase.timeUtc) {
        if (!wallet.firstPurchaseAt || Date.parse(purchase.timeUtc) < Date.parse(wallet.firstPurchaseAt)) wallet.firstPurchaseAt = purchase.timeUtc;
        if (!wallet.lastPurchaseAt || Date.parse(purchase.timeUtc) > Date.parse(wallet.lastPurchaseAt)) wallet.lastPurchaseAt = purchase.timeUtc;
      }
    }
    if (row.startedAt && row.filledAt) {
      const duration = (Date.parse(row.filledAt) - Date.parse(row.startedAt)) / 1000;
      if (duration >= 0 && Number.isSafeInteger(duration)) row.fillSeconds = duration;
    }
    return { ...row, purchaseCount: new Set(purchases.map(purchase => purchase.transactionHash.toLowerCase())).size, walletCount: wallets.size, purchases,
      wallets: [...wallets.values()].sort((a, b) => b.tickets - a.tickets || a.address.localeCompare(b.address)) };
  });
}

export function adminRoundSummary({ wallets, purchases, ...row }) { return row; }

export function summarizeAdminRounds(rounds, now = Date.now()) {
  const day = adminDayWindow(now), start = Date.parse(day.startUtc), end = Date.parse(day.endUtc);
  const today = value => value !== null && Date.parse(value) >= start && Date.parse(value) < end;
  const completed = rounds.filter(row => row.status === 5 && row.settlementTxHash && row.settledAt);
  const allWallets = new Set(rounds.flatMap(row => row.wallets.map(wallet => wallet.address.toLowerCase())));
  return { day, roundCount: rounds.length, completedCount: completed.length,
    todayCompletedCount: completed.filter(row => today(row.settledAt)).length,
    todayFilledCount: rounds.filter(row => today(row.filledAt)).length, walletCount: allWallets.size,
    purchaseCount: rounds.reduce((sum, row) => sum + row.purchaseCount, 0),
    todayPurchaseCount: new Set(rounds.flatMap(row => row.purchases.filter(purchase => today(purchase.timeUtc)).map(purchase => purchase.transactionHash.toLowerCase()))).size };
}
