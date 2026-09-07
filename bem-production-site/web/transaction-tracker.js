import { Interface, getAddress } from 'ethers';
import { PINNED, same } from './guards.js';

const HASH = /^0x[0-9a-f]{64}$/i, HEX = /^0x(?:[0-9a-f]{2})*$/i;
const CALLS = new Interface(['function approve(address,uint256)', 'function buy(uint256,uint32)',
  'function buySelected(uint256,uint16[])', 'function refund(uint256,address)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event TicketsPurchased(uint256 indexed roundId,address indexed buyer,uint32 firstTicket,uint32 endExclusive,uint256 paid)',
  'event Refunded(uint256 indexed roundId,address indexed buyer,uint256 amount)']);
const GRACE_MS = 90000;
class TrackingError extends Error { constructor(code) { super(code); this.code = code; } }
const need = (condition, code = 'INVALID_EVIDENCE') => { if (!condition) throw new TrackingError(code); };
const quantity = value => {
  need((typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || (typeof value === 'bigint' && value >= 0n));
  const n = BigInt(value); need(n >= 0n && n < 2n ** 256n); return n;
};
const blockNumber = value => { const n = quantity(value); need(n <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(n); };
const hexNumber = value => '0x' + BigInt(value).toString(16);
const normalizedHash = value => { need(typeof value === 'string' && HASH.test(value)); return value.toLowerCase(); };
const keyOf = row => [row.hash, row.account.toLowerCase(), row.to.toLowerCase(), row.data, row.action, row.roundId].join(':');

function expectation(row) {
  need(row && ['approve', 'buy', 'refund'].includes(row.action), 'INVALID_RECORD');
  const account = getAddress(row.account), to = getAddress(row.to), hash = normalizedHash(row.hash);
  need(same(to, row.action === 'approve' ? PINNED.bemAddress : PINNED.gameAddress), 'INVALID_RECORD');
  need(typeof row.data === 'string' && HEX.test(row.data) && row.data.length <= 131074, 'INVALID_RECORD');
  const data = row.data.toLowerCase(), call = CALLS.parseTransaction({ data });
  need(call && CALLS.encodeFunctionData(call.fragment, call.args).toLowerCase() === data, 'INVALID_RECORD');
  const roundId = quantity(row.roundId).toString(); need(BigInt(roundId) > 0n, 'INVALID_RECORD');
  let count = null, selected = null, amount = null;
  if (row.action === 'approve') {
    need(call.name === 'approve' && same(call.args[0], PINNED.gameAddress), 'INVALID_RECORD');
    amount = call.args[1]; need(amount > 0n && amount <= 500n * PINNED.ticketPrice && amount % PINNED.ticketPrice === 0n, 'INVALID_RECORD');
  } else {
    need(call.args[0].toString() === roundId, 'INVALID_RECORD');
    if (row.action === 'refund') need(call.name === 'refund' && same(call.args[1], account), 'INVALID_RECORD');
    else {
      need(['buy', 'buySelected'].includes(call.name), 'INVALID_RECORD');
      selected = call.name === 'buySelected' ? [...call.args[1]].map(Number) : null;
      count = selected ? selected.length : Number(call.args[1]);
      need(Number.isInteger(count) && count > 0 && count <= 500, 'INVALID_RECORD');
      if (selected) need(selected.every((n, i) => n >= 0 && n < 10000 && (!i || n > selected[i - 1])), 'INVALID_RECORD');
      amount = BigInt(count) * PINNED.ticketPrice;
    }
  }
  return { hash, account, to, data, action: row.action, roundId, count, selected, amount };
}

/** Public metadata only. Never pass a wallet/provider that can sign as `rpc`. */
export function createTransactionRecord({ hash, account, action, roundId, to, data, submittedAt = new Date().toISOString(), fromBlock = null }) {
  const e = expectation({ hash, account, action, roundId, to, data });
  const time = Date.parse(submittedAt); need(Number.isFinite(time) && time >= 0, 'INVALID_RECORD');
  return { trackerVersion: 2, hash: e.hash, account: e.account, action, roundId: e.roundId, to: e.to, data: e.data,
    submittedAt: new Date(time).toISOString(), fromBlock: fromBlock == null ? null : blockNumber(fromBlock),
    status: 'pending', reason: 'AWAITING_RECEIPT', blockingUntil: time + GRACE_MS, effectiveHash: null };
}

/** localStorage is not evidence: discard stored success, nonce, receipt and replacement claims. */
export function restoreTransactionRecords(raw) {
  try {
    const rows = typeof raw === 'string' ? JSON.parse(raw) : raw; if (!Array.isArray(rows)) return [];
    const seen = new Set(), result = [];
    for (const row of rows.slice(0, 100)) {
      try {
        need(row?.trackerVersion == null || row.trackerVersion === 2, 'INVALID_RECORD');
        const record = createTransactionRecord(row); if (seen.has(record.hash)) continue;
        seen.add(record.hash); result.push({ ...record, status: 'unknown', reason: 'RESTORED_RECHECK_REQUIRED', blockingUntil: 0 });
        if (result.length === 25) break;
      } catch { /* Malformed or unrelated historical entries are not accepted. */ }
    }
    return result;
  } catch { return []; }
}

export function isTransactionBlocking(record, account, now = Date.now()) {
  return same(record?.account, account) && ['pending', 'confirming'].includes(record?.status) &&
    Number.isFinite(record.blockingUntil) && record.blockingUntil > now && record.blockingUntil <= now + GRACE_MS;
}

function readTransaction(tx, hash) {
  need(tx && same(tx.hash, hash), 'TRANSACTION_MISMATCH');
  need(quantity(tx.chainId) === 56n, 'CHAIN_MISMATCH');
  const from = getAddress(tx.from), to = tx.to == null ? null : getAddress(tx.to);
  const data = tx.input ?? tx.data; need(typeof data === 'string' && HEX.test(data), 'TRANSACTION_MISMATCH');
  if (tx.input != null && tx.data != null) need(tx.input.toLowerCase() === tx.data.toLowerCase(), 'TRANSACTION_MISMATCH');
  return { hash: normalizedHash(tx.hash), from, to, data: data.toLowerCase(), value: quantity(tx.value), nonce: quantity(tx.nonce),
    block: tx.blockNumber == null ? null : blockNumber(tx.blockNumber), blockHash: tx.blockHash == null ? null : normalizedHash(tx.blockHash) };
}
const sameAction = (tx, e) => same(tx.from, e.account) && same(tx.to, e.to) && tx.data === e.data && tx.value === 0n;

function verifyEvents(receipt, tx, e) {
  need(Array.isArray(receipt.logs) && receipt.logs.length <= 2000, 'EVENT_MISMATCH');
  const matches = [];
  for (const log of receipt.logs) {
    need(!log.removed && same(log.transactionHash, tx.hash) && same(log.blockHash, tx.blockHash) &&
      blockNumber(log.blockNumber) === tx.block && Array.isArray(log.topics) && log.topics.length <= 4 &&
      log.topics.every(topic => typeof topic === 'string' && HASH.test(topic)) && typeof log.data === 'string' && HEX.test(log.data), 'EVENT_MISMATCH');
    getAddress(log.address);
    if (!same(log.address, e.to)) continue;
    let parsed; try { parsed = CALLS.parseLog(log); } catch { throw new TrackingError('EVENT_MISMATCH'); }
    if (parsed?.name === ({ approve: 'Approval', buy: 'TicketsPurchased', refund: 'Refunded' })[e.action]) matches.push(parsed.args);
  }
  if (e.action === 'approve') {
    need(matches.length === 1 && same(matches[0].owner, e.account) && same(matches[0].spender, PINNED.gameAddress) && matches[0].value === e.amount, 'EVENT_MISMATCH');
    return { event: 'Approval', amount: e.amount.toString() };
  }
  if (e.action === 'refund') {
    need(matches.length === 1 && matches[0].roundId.toString() === e.roundId && same(matches[0].buyer, e.account) &&
      matches[0].amount > 0n && matches[0].amount <= 10000n * PINNED.ticketPrice, 'EVENT_MISMATCH');
    return { event: 'Refunded', amount: matches[0].amount.toString() };
  }
  const tickets = [], seen = new Set(); let paid = 0n;
  for (const a of matches) {
    const first = Number(a.firstTicket), end = Number(a.endExclusive);
    need(a.roundId.toString() === e.roundId && same(a.buyer, e.account) && first >= 0 && end <= 10000 && end > first &&
      end - first <= 500 && a.paid === BigInt(end - first) * PINNED.ticketPrice, 'EVENT_MISMATCH');
    for (let ticket = first; ticket < end; ticket++) { need(!seen.has(ticket) && tickets.length < 500, 'EVENT_MISMATCH'); seen.add(ticket); tickets.push(ticket); }
    paid += a.paid;
  }
  tickets.sort((a, b) => a - b);
  need(tickets.length === e.count && paid === e.amount && (!e.selected || e.selected.every((n, i) => tickets[i] === n)), 'EVENT_MISMATCH');
  return { event: 'TicketsPurchased', amount: paid.toString(), tickets };
}

/** Each poll is bounded. No timers keep polling, no wallet calls, and no transactions are resent.
 * `unknown` unlocks the short waiting state, but is NOT permission to duplicate a purchase.
 * The UI should ask users to inspect their wallet/original transaction before submitting again.
 */
export function createTransactionTracker({ rpc, now = Date.now, confirmations = 12, pendingGraceMs = GRACE_MS,
  requestTimeoutMs = 6000, pollTimeoutMs = 15000, maxReadsPerPoll = 40, maxBlockTransactions = 4096 } = {}) {
  need(typeof rpc === 'function' && typeof now === 'function', 'TRACKER_OPTIONS');
  need(Number.isInteger(confirmations) && confirmations >= 12 && confirmations <= 200, 'TRACKER_OPTIONS');
  for (const value of [pendingGraceMs, requestTimeoutMs, pollTimeoutMs, maxReadsPerPoll, maxBlockTransactions]) need(Number.isSafeInteger(value) && value > 0, 'TRACKER_OPTIONS');
  need(pendingGraceMs <= GRACE_MS && maxReadsPerPoll >= 10 && maxReadsPerPoll <= 100, 'TRACKER_OPTIONS');
  const memory = new Map(), flights = new Map(), hints = new Map();
  function context(e, record) {
    const key = keyOf(e); let value = memory.get(key);
    if (!value) {
      value = { proof: null, search: null, deadline: record.reason === 'RESTORED_RECHECK_REQUIRED' ? 0 :
        Math.min(Date.parse(record.submittedAt) + pendingGraceMs, now() + pendingGraceMs) };
      memory.set(key, value);
      if (memory.size > 100) memory.delete(memory.keys().next().value);
    }
    return value;
  }
  async function inspect(record) {
    const e = expectation(record), base = createTransactionRecord(record), key = keyOf(e), memo = context(e, record);
    let reads = 0; const endAt = Date.now() + pollTimeoutMs;
    const result = (status, reason, extra = {}) => ({ ...base, status, reason, blockingUntil: ['pending', 'confirming'].includes(status) ? memo.deadline : 0,
      checkedAt: new Date(now()).toISOString(), requiresReview: ['unknown', 'unverified'].includes(status), ...extra });
    const waiting = (reason, extra = {}) => result(now() < memo.deadline ? 'pending' : 'unknown', reason, extra);
    const read = async (method, params) => {
      if (++reads > maxReadsPerPoll || Date.now() >= endAt) throw new TrackingError('CHECK_LIMIT');
      let timer;
      try { return await Promise.race([Promise.resolve().then(() => rpc(method, params)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TrackingError('RPC_TIMEOUT')), Math.min(requestTimeoutMs, Math.max(1, endAt - Date.now())));
      })]); } finally { clearTimeout(timer); }
    };
    const header = async tag => {
      const b = await read('eth_getBlockByNumber', [tag, false]); need(b, 'BLOCK_UNAVAILABLE');
      const n = blockNumber(b.number); normalizedHash(b.hash);
      if (tag !== 'latest') need(n === blockNumber(tag), 'BLOCK_MISMATCH');
      return b;
    };
    try {
      need(quantity(await read('eth_chainId', [])) === 56n, 'CHAIN_MISMATCH');
      const latest = await header('latest'), tip = blockNumber(latest.number);
      const rawOriginal = await read('eth_getTransactionByHash', [e.hash]);
      const originalReceipt = await read('eth_getTransactionReceipt', [e.hash]);
      if (rawOriginal) {
        const original = readTransaction(rawOriginal, e.hash);
        need(sameAction(original, e), 'TRANSACTION_MISMATCH');
        if (memo.proof) need(memo.proof.nonce === original.nonce, 'NONCE_MISMATCH');
        memo.proof = original;
      }
      const verify = async (tx, receipt) => {
        need(receipt && same(receipt.transactionHash, tx.hash) && same(receipt.from, tx.from) &&
          (tx.to === null ? receipt.to === null : same(receipt.to, tx.to)), 'RECEIPT_MISMATCH');
        need(tx.block !== null && tx.blockHash && blockNumber(receipt.blockNumber) === tx.block && same(receipt.blockHash, tx.blockHash), 'RECEIPT_MISMATCH');
        const status = quantity(receipt.status); need(status === 0n || status === 1n, 'RECEIPT_MISMATCH');
        need(tx.block <= tip, 'BLOCK_MISMATCH');
        const b = await header(hexNumber(tx.block));
        need(same(b.hash, tx.blockHash), 'REORG');
        need(Array.isArray(b.transactions) && b.transactions.some(hash => same(hash, tx.hash)), 'RECEIPT_MISMATCH');
        const replacement = tx.hash !== e.hash, equivalent = sameAction(tx, e);
        const cancelShape = replacement && same(tx.to, tx.from) && tx.value === 0n && tx.data === '0x' && status === 1n;
        // A delegated smart account's self-call can execute code; do not call that a cancellation.
        const cancel = cancelShape && Array.isArray(receipt.logs) && receipt.logs.length === 0 &&
          await read('eth_getCode', [tx.from, hexNumber(tx.block)]) === '0x';
        const evidence = status === 1n && equivalent ? verifyEvents(receipt, tx, e) : null;
        const count = tip - tx.block + 1;
        need(same((await header(hexNumber(tip))).hash, latest.hash), 'REORG');
        const extra = { effectiveHash: tx.hash, replacementHash: replacement ? tx.hash : null,
          replacementKind: replacement ? (equivalent ? 'repriced' : cancel ? 'cancelled' : 'different_action') : null,
          block: tx.block, blockHash: tx.blockHash, nonce: tx.nonce.toString(), receiptStatus: Number(status), confirmations: count, evidence };
        if (count < confirmations) return result(now() < memo.deadline ? 'confirming' : 'unknown', 'AWAITING_CONFIRMATIONS', extra);
        if (!equivalent) return result(cancel ? 'cancelled' : 'replaced', cancel ? 'NONCE_CANCELLED' : 'DIFFERENT_ACTION_MINED', extra);
        return result(status === 1n ? 'confirmed' : 'reverted', replacement ? 'REPLACEMENT_CONFIRMED' : 'RECEIPT_CONFIRMED', extra);
      };
      if (originalReceipt) {
        need(rawOriginal, 'TRANSACTION_UNAVAILABLE');
        return await verify(memo.proof, originalReceipt);
      }
      if (!memo.proof) return waiting('ORIGINAL_NONCE_UNKNOWN');
      const nonce = memo.proof.nonce;
      const hint = hints.get(key);
      if (hint) {
        hints.delete(key);
        const raw = await read('eth_getTransactionByHash', [hint]);
        if (!raw) return waiting('CANDIDATE_NOT_SEEN');
        const tx = readTransaction(raw, hint);
        need(same(tx.from, e.account) && tx.nonce === nonce, 'CANDIDATE_NOT_REPLACEMENT');
        const receipt = await read('eth_getTransactionReceipt', [hint]);
        if (receipt) return await verify(tx, receipt);
        return waiting('REPLACEMENT_PENDING', { replacementHash: hint });
      }
      const used = quantity(await read('eth_getTransactionCount', [e.account, latest.number]));
      if (used <= nonce) { memo.search = null; return waiting('AWAITING_RECEIPT'); }
      // The original nonce comes exclusively from an RPC-verified original transaction.
      // A localStorage nonce, fromBlock, elapsed time or pending nonce is never sufficient.
      let s = memo.search;
      if (s && !same((await header(hexNumber(s.tip))).hash, s.tipHash)) { memo.search = null; throw new TrackingError('REORG'); }
      if (!s) {
        let low = 0, high = tip;
        if (base.fromBlock != null && base.fromBlock > 0 && base.fromBlock < tip) {
          const n = quantity(await read('eth_getTransactionCount', [e.account, hexNumber(base.fromBlock)]));
          if (n <= nonce) low = base.fromBlock; else high = base.fromBlock;
        }
        s = memo.search = { low, high, tip, tipHash: latest.hash, hashes: null, index: 0 };
      }
      while (s.high - s.low > 1) {
        const mid = Math.floor((s.high + s.low) / 2);
        const n = quantity(await read('eth_getTransactionCount', [e.account, hexNumber(mid)]));
        if (n > nonce) s.high = mid; else s.low = mid;
      }
      if (!s.hashes) {
        const b = await header(hexNumber(s.high));
        need(Array.isArray(b.transactions) && b.transactions.length <= maxBlockTransactions && b.transactions.every(hash => typeof hash === 'string' && HASH.test(hash)), 'BLOCK_SCAN_LIMIT');
        s.hashes = b.transactions; s.blockHash = b.hash;
      }
      while (s.index < s.hashes.length) {
        const hash = s.hashes[s.index], raw = await read('eth_getTransactionByHash', [hash]);
        need(raw, 'TRANSACTION_UNAVAILABLE');
        need(same(raw.hash, hash) && blockNumber(raw.blockNumber) === s.high && same(raw.blockHash, s.blockHash), 'REORG');
        // Other block transactions can use legacy unprotected signatures. Their chainId
        // is not evidence about this wallet's transaction and must not block the scan.
        if (!same(getAddress(raw.from), e.account)) { s.index++; continue; }
        const tx = readTransaction(raw, hash);
        need(tx.block === s.high && same(tx.blockHash, s.blockHash), 'REORG');
        if (same(tx.from, e.account) && tx.nonce === nonce) {
          const receipt = await read('eth_getTransactionReceipt', [hash]);
          if (!receipt) return waiting('REPLACEMENT_RECEIPT_PENDING', { replacementHash: hash });
          return await verify(tx, receipt);
        }
        s.index++;
      }
      return result('unknown', 'NONCE_USED_TRANSACTION_UNAVAILABLE');
    } catch (error) {
      const code = error instanceof TrackingError ? error.code : 'RPC_UNAVAILABLE';
      if (['REORG', 'BLOCK_UNAVAILABLE', 'TRANSACTION_UNAVAILABLE'].includes(code)) memo.search = null;
      if (['TRANSACTION_MISMATCH', 'RECEIPT_MISMATCH', 'EVENT_MISMATCH', 'CHAIN_MISMATCH', 'NONCE_MISMATCH', 'CANDIDATE_NOT_REPLACEMENT', 'INVALID_EVIDENCE', 'BLOCK_MISMATCH'].includes(code)) return result('unverified', code);
      return waiting(code);
    }
  }
  function poll(record) {
    let e; try { e = expectation(record); } catch (error) { return Promise.reject(error); }
    const key = keyOf(e); if (flights.has(key)) return flights.get(key);
    const promise = inspect(record).finally(() => flights.delete(key)); flights.set(key, promise); return promise;
  }
  return {
    poll,
    async reconcile(record, candidateHash) {
      const key = keyOf(expectation(record)); hints.set(key, normalizedHash(candidateHash));
      if (flights.has(key)) await flights.get(key);
      return poll(record);
    }
  };
}
