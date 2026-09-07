import { Interface, getAddress, keccak256, toQuantity } from 'ethers';
import { previewPoolSelection } from './player-v2-state.js';

// This isolated entry never uses a registry-provided destination or a V1 profile.
export const TEST_PLAYER = Object.freeze({
  chainId: 56n, address: '0xE7D8dF903050d875f09cE1BBcE20E837fB55bC0c',
  runtimeHash: '0xef681f526023ed624835dd100d6178dfa4876c34763d7ed566727e791390f7bc',
  bem: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  coordinator: '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9',
  subscriptionId: 77582411398321098948652233841078712279496169525251928512909841261362926957679n,
  container: '0x358BE84b95224d228f3A61964Fa3c9fB61D7B646',
  processor: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
  recipient: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  ticketPrice: 10000n, pool: 100000000n, gasCap: 16777216n,
});
export const TEST_PLAYER_STORAGE_KEY = 'bem:test1:transaction-intent:v1';
export const TEST_PLAYER_ABI = Object.freeze([
  'function buy(uint256 expectedRoundId,uint32 count) returns(uint256 roundId)',
  'function buySelected(uint256 expectedRoundId,uint16[] selectedTickets) returns(uint256 roundId)',
  'function refund(uint256 roundId,address participant)', 'function settle(uint256 roundId)',
  'function rounds(uint256) view returns(uint8 status,uint32 sold,uint64 fundingDeadline,uint64 drawDeadline,uint256 requestId,uint256 ticketWord,uint256 circuitWord,uint32 drawCursor,uint32 winningTicket,address winner)',
  'function drawTiming(uint256) view returns(uint64 lockedAt,uint64 targetDrawBy,uint64 scheduledDrawAt,uint64 settledAt)',
  'function ticketsOf(uint256,address) view returns(uint32)', 'function refundClaimDeadline(uint256) view returns(uint64)',
  'function unclaimedPrincipalBurned(uint256) view returns(bool)', 'function seriesAuthorized() view returns(bool)',
  'function currentRoundId() view returns(uint256)', 'function subscriptionId() view returns(uint256)',
  'function bem() view returns(address)', 'function coordinator() view returns(address)',
  'function CIRCUITS() view returns(address)', 'function CIRCUIT_ID() view returns(uint256)',
  'function CONTAINER() view returns(address)', 'function organizer() view returns(address)',
  'function TEST_ONLY() view returns(bool)', 'function TICKET_PRICE() view returns(uint256)',
  'function ROUND_POOL() view returns(uint256)', 'function TICKETS_PER_ROUND() view returns(uint32)',
  'function MAX_TICKETS_PER_PURCHASE() view returns(uint32)', 'function MAX_TICKETS_PER_ADDRESS() view returns(uint32)',
  'function fundingWindow() view returns(uint32)', 'function REFUND_CLAIM_WINDOW() view returns(uint64)',
  'event TicketsPurchased(uint256 indexed roundId,address indexed buyer,uint32 firstTicket,uint32 endExclusive,uint256 paid)',
  'event Refunded(uint256 indexed roundId,address indexed buyer,uint256 amount)',
  'event Settled(uint256 indexed roundId,address indexed winner,uint32 ticket)',
  'event DrawProgress(uint256 indexed roundId,uint32 nextCursor)',
  'event AttemptEvaluated(uint256 indexed roundId,uint32 indexed cursor,uint16 input0,uint16 input1,uint16 output0,uint16 output1,uint16 candidate,bool accepted)',
]);
const GAME = new Interface(TEST_PLAYER_ABI);
const TOKEN = new Interface(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function approve(address spender,uint256 amount) returns(bool)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)']);
const VRF = new Interface(['function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)']);
const READS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_call',
  'eth_estimateGas', 'eth_gasPrice', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
const HASH = /^0x[0-9a-f]{64}$/i, HEX = /^0x(?:[0-9a-f]{2})*$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export class TestPlayerError extends Error { constructor(code) { super(code); this.code = code; } }
const need = (ok, code) => { if (!ok) throw new TestPlayerError(code); };
const integer = (value, code = 'INVALID_INTEGER') => {
  need(typeof value === 'bigint' || typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) ||
    typeof value === 'number' && Number.isSafeInteger(value), code);
  const n = BigInt(value); need(n >= 0n && n < 2n ** 256n, code); return n;
};
const hash = value => { need(typeof value === 'string' && HASH.test(value), 'INVALID_HASH'); return value.toLowerCase(); };
const stringify = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const clone = value => JSON.parse(stringify(value));
function contextKey(value) {
  need(value?.poolId === '1', 'TEST_POOL_ONLY');
  need(integer(value.chainId, 'WALLET_NETWORK') === TEST_PLAYER.chainId && value.account, 'WALLET_NETWORK');
  need(Number.isSafeInteger(value.epoch) && value.epoch >= 0 && value.selection && typeof value.selection === 'object', 'CONTEXT_REQUIRED');
  if (value.address != null) need(same(value.address, TEST_PLAYER.address), 'TEST_POOL_ONLY');
  return stringify({ poolId: value.poolId, epoch: value.epoch, account: getAddress(value.account), chainId: '56',
    selection: { mode: value.selection.mode, count: String(value.selection.count ?? ''), text: String(value.selection.text ?? '') } });
}
function selectionInput(kind, payload) {
  const roundId = integer(payload.roundId, 'ROUND_REQUIRED'); need(roundId > 0n, 'ROUND_REQUIRED');
  if (kind === 'refund' || kind === 'settle') return { roundId, quantity: 0n, tickets: null, amount: 0n };
  need(kind === 'approve' || kind === 'buy', 'ACTION_NOT_SUPPORTED');
  const quantity = integer(payload.quantity, 'TICKET_LIMIT'); need(quantity >= 1n && quantity <= 1000n, 'TICKET_LIMIT');
  let tickets = null;
  if (payload.tickets != null) {
    need(Array.isArray(payload.tickets) && payload.tickets.length === Number(quantity), 'TICKET_RANGE');
    tickets = payload.tickets.map(n => Number(integer(n, 'TICKET_RANGE')));
    need(tickets.every((n, i) => n >= 1 && n <= 10000 && (!i || n > tickets[i - 1])), 'TICKET_RANGE');
  }
  return { roundId, quantity, tickets, amount: quantity * TEST_PLAYER.ticketPrice };
}
function actionData(kind, input, account) {
  if (kind === 'approve') return { to: TEST_PLAYER.bem, data: TOKEN.encodeFunctionData('approve', [TEST_PLAYER.address, input.amount]) };
  const data = kind === 'buy' ? input.tickets ? GAME.encodeFunctionData('buySelected', [input.roundId, input.tickets.map(n => n - 1)])
    : GAME.encodeFunctionData('buy', [input.roundId, input.quantity]) : GAME.encodeFunctionData(kind, kind === 'refund' ? [input.roundId, account] : [input.roundId]);
  return { to: TEST_PLAYER.address, data };
}
function validRecord(value) {
  need(value?.version === 1 && typeof value.id === 'string' && value.id.length < 120, 'PENDING_STORAGE_INVALID');
  const account = getAddress(value.account), input = selectionInput(value.kind, value.input), expected = actionData(value.kind, input, account);
  need(same(value.to, expected.to) && same(value.data, expected.data), 'PENDING_STORAGE_INVALID');
  need(integer(value.fromBlock) > 0n && integer(value.nonceFloor) >= 0n, 'PENDING_STORAGE_INVALID');
  need(integer(value.nonce) >= integer(value.nonceFloor), 'PENDING_STORAGE_INVALID');
  need(value.hash == null || HASH.test(value.hash), 'PENDING_STORAGE_INVALID');
  return { ...clone(value), account, to: expected.to, data: expected.data, status: 'unknown', reason: 'RECHECK_REQUIRED' };
}

/** Only execute() can send, and the caller must invoke it from an explicit user action.
 * readState/checkPending/attachHash never sign or send. Unknown outcomes stay blocked,
 * including after reload. A wallet rejection (4001) is the only error that clears a
 * submitted intent without onchain evidence. No automatic approve/buy chain, retry,
 * cancellation, nonce replacement, split purchase, timer or keeper action exists here.
 * The single request pins its pending nonce so an unrelated later transaction cannot
 * clear an unknown result while an earlier wallet confirmation may still be open.
 * getContext supplies {poolId,epoch,account,chainId,selection}; tickets are ONE-BASED.
 */
export function createTestPlayerTransactions({ wallet, getContext, readRpc, onUpdate = () => {}, storage,
  confirmations = 12, requestTimeoutMs = 12000, locks = globalThis.navigator?.locks } = {}) {
  need(typeof getContext === 'function' && typeof readRpc === 'function' && (typeof wallet === 'function' || wallet?.request), 'OPTIONS_REQUIRED');
  need(Number.isSafeInteger(confirmations) && confirmations >= 12 && confirmations <= 200, 'OPTIONS_REQUIRED');
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  let busy = false, pending = null, storageError = false, checking = null;
  const history = [];
  const provider = () => typeof wallet === 'function' ? wallet() : wallet;
  const withLock = operation => { need(locks && typeof locks.request === 'function', 'TRANSACTION_LOCK_UNAVAILABLE'); return locks.request(TEST_PLAYER_STORAGE_KEY, operation); };
  const getState = () => ({ busy, blocking: busy || storageError || pending !== null,
    storageError, records: [...(pending ? [clone(pending)] : []), ...history.map(clone)] });
  const update = () => { try { onUpdate(getState()); } catch { /* UI cannot change transaction handling. */ } };
  const load = () => {
    try {
      need(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' && typeof storage.removeItem === 'function', 'PENDING_STORAGE_UNAVAILABLE');
      const raw = storage.getItem(TEST_PLAYER_STORAGE_KEY); pending = raw == null ? null : validRecord(JSON.parse(raw)); storageError = false;
    } catch { storageError = true; }
  };
  const persist = (value, expectedId = undefined) => {
    need(!storageError && storage, 'PENDING_STORAGE_UNAVAILABLE');
    try {
      if (expectedId !== undefined) {
        const current = storage.getItem(TEST_PLAYER_STORAGE_KEY);
        if (current == null || JSON.parse(current).id !== expectedId) { load(); return false; }
      }
      if (value) { const raw = stringify(value); storage.setItem(TEST_PLAYER_STORAGE_KEY, raw); need(storage.getItem(TEST_PLAYER_STORAGE_KEY) === raw, 'PENDING_STORAGE_UNAVAILABLE'); }
      else { storage.removeItem(TEST_PLAYER_STORAGE_KEY); need(storage.getItem(TEST_PLAYER_STORAGE_KEY) == null, 'PENDING_STORAGE_UNAVAILABLE'); }
      pending = value;
      return true;
    } catch { storageError = true; throw new TestPlayerError('PENDING_STORAGE_UNAVAILABLE'); }
  };
  load();
  const rpc = async (method, params) => {
    need(READS.has(method), 'READ_ONLY_RPC');
    let timer;
    try { return await Promise.race([Promise.resolve().then(() => readRpc(method, params)), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TestPlayerError('RPC_TIMEOUT')), requestTimeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  const header = async tag => {
    const b = await rpc('eth_getBlockByNumber', [tag, false]); need(b && HASH.test(b.hash), 'BLOCK_UNAVAILABLE');
    const number = integer(b.number), timestamp = integer(b.timestamp); need(number > 0n && number <= BigInt(Number.MAX_SAFE_INTEGER), 'BLOCK_UNAVAILABLE');
    if (tag !== 'latest') need(number === integer(tag), 'BLOCK_MISMATCH');
    return { ...b, number: toQuantity(number), timestamp: toQuantity(timestamp) };
  };
  async function readState(account = null, { roundId: requestedRound = null } = {}) {
    if (account != null) account = getAddress(account);
    need(integer(await rpc('eth_chainId', [])) === TEST_PLAYER.chainId, 'RPC_NETWORK');
    const block = await header('latest'), tag = block.number;
    const call = async (to, iface, name, args = []) => iface.decodeFunctionResult(name,
      await rpc('eth_call', [{ to, data: iface.encodeFunctionData(name, args) }, tag]));
    const fixed = { bem: TEST_PLAYER.bem, coordinator: TEST_PLAYER.coordinator, CIRCUITS: TEST_PLAYER.processor,
      CIRCUIT_ID: 2075n, CONTAINER: TEST_PLAYER.container, organizer: TEST_PLAYER.recipient,
      TEST_ONLY: true, TICKET_PRICE: TEST_PLAYER.ticketPrice, ROUND_POOL: TEST_PLAYER.pool, TICKETS_PER_ROUND: 10000n,
      MAX_TICKETS_PER_PURCHASE: 1000n, MAX_TICKETS_PER_ADDRESS: 5000n, fundingWindow: 86400n, REFUND_CLAIM_WINDOW: 86400n,
      subscriptionId: TEST_PLAYER.subscriptionId };
    const [code, fixedValues, authorized, current, decimals, subscription] = await Promise.all([
      rpc('eth_getCode', [TEST_PLAYER.address, tag]), Promise.all(Object.keys(fixed).map(k => call(TEST_PLAYER.address, GAME, k))),
      call(TEST_PLAYER.address, GAME, 'seriesAuthorized'), call(TEST_PLAYER.address, GAME, 'currentRoundId'),
      call(TEST_PLAYER.bem, TOKEN, 'decimals'), call(TEST_PLAYER.coordinator, VRF, 'getSubscription', [TEST_PLAYER.subscriptionId]),
    ]);
    need(typeof code === 'string' && HEX.test(code) && keccak256(code) === TEST_PLAYER.runtimeHash, 'RUNTIME_MISMATCH');
    Object.entries(fixed).forEach(([key, expected], i) => need(typeof expected === 'string' ? same(fixedValues[i][0], expected)
      : fixedValues[i][0] === expected, 'FIXED_RULE_MISMATCH'));
    need(decimals[0] === 8n && current[0] > 0n, 'FIXED_RULE_MISMATCH');
    const roundId = requestedRound == null ? current[0] : integer(requestedRound, 'ROUND_REQUIRED'); need(roundId > 0n && roundId <= current[0], 'ROUND_REQUIRED');
    const [round, timing, deadline, burned, mine, balance, allowance, native, nonce] = await Promise.all([
      call(TEST_PLAYER.address, GAME, 'rounds', [roundId]), call(TEST_PLAYER.address, GAME, 'drawTiming', [roundId]),
      call(TEST_PLAYER.address, GAME, 'refundClaimDeadline', [roundId]), call(TEST_PLAYER.address, GAME, 'unclaimedPrincipalBurned', [roundId]),
      account ? call(TEST_PLAYER.address, GAME, 'ticketsOf', [roundId, account]) : [0n],
      account ? call(TEST_PLAYER.bem, TOKEN, 'balanceOf', [account]) : [0n],
      account ? call(TEST_PLAYER.bem, TOKEN, 'allowance', [account, TEST_PLAYER.address]) : [0n],
      account ? rpc('eth_getBalance', [account, tag]) : '0x0', account ? rpc('eth_getTransactionCount', [account, tag]) : '0x0',
    ]);
    need(same((await header(tag)).hash, block.hash), 'REORG');
    const timestamp = integer(block.timestamp), status = Number(round.status), consumerAuthorized = subscription.consumers.some(x => same(x, TEST_PLAYER.address));
    need(status >= 0 && status <= 6 && round.sold <= 10000n && mine[0] <= 5000n &&
      deadline[0] === (round.fundingDeadline === 0n ? 0n : round.fundingDeadline + 86400n), 'STATE_MISMATCH');
    const canRefund = !!account && [1, 6].includes(status) && round.fundingDeadline > 0n && timestamp >= round.fundingDeadline &&
      timestamp < deadline[0] && !burned[0] && mine[0] > 0n;
    return { account, blockNumber: Number(integer(tag)), blockHash: hash(block.hash), timestamp, currentRoundId: current[0], roundId,
      round: { status, sold: round.sold, fundingDeadline: round.fundingDeadline, requestId: round.requestId },
      drawTiming: { scheduledDrawAt: timing.scheduledDrawAt }, seriesAuthorized: authorized[0], consumerAuthorized,
      bemBalance: balance[0], bnbBalance: integer(native), allowance: allowance[0], myCount: mine[0],
      refundAmount: canRefund ? mine[0] * TEST_PLAYER.ticketPrice : 0n, refundDeadline: deadline[0], canRefund,
      canBuy: !!account && authorized[0] && consumerAuthorized && subscription.nativeBalance > 0n && roundId === current[0] && status === 1 && timestamp < round.fundingDeadline && round.sold < 10000n && mine[0] < 5000n,
      canSettle: !!account && status === 4 && timing.scheduledDrawAt > 0n && timestamp >= timing.scheduledDrawAt,
      subscriptionNativeBalance: subscription.nativeBalance, nonceFloor: integer(nonce) };
  }
  const validateAction = (kind, input, s) => {
    need(s.roundId === input.roundId, 'ROUND_CHANGED');
    if (kind === 'refund') { need(s.canRefund, 'REFUND_UNAVAILABLE'); return; }
    if (kind === 'settle') { need(s.canSettle, 'SETTLEMENT_NOT_DUE'); return; }
    need(s.currentRoundId === input.roundId, 'ROUND_CHANGED');
    need(s.bemBalance >= input.amount, 'INSUFFICIENT_BEM');
    if (kind === 'approve') { need(s.allowance < input.amount, 'ALLOWANCE_SUFFICIENT'); return; }
    need(s.canBuy, 'PURCHASE_UNAVAILABLE'); need(s.round.sold + input.quantity <= 10000n, 'INSUFFICIENT_TICKETS');
    need(s.myCount + input.quantity <= 5000n, 'ADDRESS_TICKET_LIMIT'); need(s.allowance >= input.amount, 'APPROVAL_REQUIRED');
  };
  async function walletMatches(p, key, account) {
    need(provider() === p && contextKey(getContext()) === key, 'CONTEXT_CHANGED');
    const [accounts, chain] = await Promise.all([p.request({ method: 'eth_accounts' }), p.request({ method: 'eth_chainId' })]);
    need(Array.isArray(accounts) && same(accounts[0], account) && integer(chain) === 56n, 'WALLET_CHANGED');
    need(provider() === p && contextKey(getContext()) === key, 'CONTEXT_CHANGED');
  }
  async function execute(kind, payload = {}) {
    need(!busy && !checking, 'TRANSACTION_IN_FLIGHT'); busy = true; update();
    const run = async () => {
      load(); need(!storageError, 'PENDING_STORAGE_UNAVAILABLE'); need(!pending, 'TRANSACTION_UNRESOLVED');
      const context = getContext(), key = contextKey(context), p = provider(), account = getAddress(context.account);
      need(p && typeof p.request === 'function', 'WALLET_REQUIRED');
      const input = selectionInput(kind, payload);
      if (kind === 'approve' || kind === 'buy') {
        const selected = previewPoolSelection({ poolId: '1', ...context.selection });
        need(BigInt(selected.quantity) === input.quantity && stringify(selected.tickets) === stringify(input.tickets), 'SELECTION_CHANGED');
      }
      await walletMatches(p, key, account);
      const action = actionData(kind, input, account), tx = { from: account, to: action.to, data: action.data, value: '0x0' };
      const latest = await readState(account, { roundId: input.roundId }); validateAction(kind, input, latest);
      // One fresh, verified snapshot and one simulation/estimate avoid repeating
      // the full preflight. The exact recipient, amount and wallet are still pinned.
      const finalTag = toQuantity(latest.blockNumber);
      await rpc('eth_call', [tx, finalTag]);
      const [estimateRaw, priceRaw] = await Promise.all([rpc('eth_estimateGas', [tx, finalTag]), rpc('eth_gasPrice', [])]);
      const estimate = integer(estimateRaw), gasPrice = integer(priceRaw); need(estimate > 0n && estimate <= TEST_PLAYER.gasCap, 'GAS_LIMIT_EXCEEDED');
      const buffered = (estimate * 120n + 99n) / 100n, gas = buffered > TEST_PLAYER.gasCap ? TEST_PLAYER.gasCap : buffered;
      need(gasPrice > 0n, 'GAS_PRICE_UNAVAILABLE');
      need(latest.bnbBalance >= gas * gasPrice, 'INSUFFICIENT_BNB');
      const nonce = integer(await rpc('eth_getTransactionCount', [account, 'pending']));
      need(nonce >= latest.nonceFloor, 'NONCE_MISMATCH');
      await walletMatches(p, key, account);
      load(); need(!storageError && !pending, 'TRANSACTION_UNRESOLVED');
      const record = { version: 1, id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, kind, account,
        input: clone(input), to: action.to, data: action.data, fromBlock: latest.blockNumber, nonceFloor: latest.nonceFloor.toString(), nonce: nonce.toString(),
        submittedAt: new Date().toISOString(), hash: null, status: 'awaiting_wallet', reason: 'WALLET_REQUEST' };
      // Persist before the wallet call: closing/reloading the page cannot unlock a duplicate.
      persist(record); update();
      try {
        await walletMatches(p, key, account);
      } catch (error) { persist(null); throw error; } // No send request was issued yet.
      let result;
      try {
        result = await p.request({ method: 'eth_sendTransaction', params: [{ ...tx, chainId: '0x38', nonce: toQuantity(nonce), gas: toQuantity(gas), gasPrice: toQuantity(gasPrice) }] });
      } catch (error) {
        if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') persist(null);
        else { persist({ ...record, status: 'unknown', reason: 'WALLET_RESULT_UNKNOWN' }); }
        throw error;
      }
      if (typeof result !== 'string' || !HASH.test(result)) { persist({ ...record, status: 'unknown', reason: 'WALLET_RESULT_UNKNOWN' }); throw new TestPlayerError('WALLET_RESULT_UNKNOWN'); }
      persist({ ...record, hash: result.toLowerCase(), status: 'pending', reason: 'AWAITING_RECEIPT' });
      return clone(pending);
    };
    try {
      // Browser Web Locks serialize all tabs through the durable intent check.
      return await withLock(run);
    } finally { busy = false; update(); }
  }
  function verifyTransaction(tx, record) {
    need(tx && same(tx.hash, record.hash) && same(tx.from, record.account) && same(tx.to, record.to) &&
      integer(tx.chainId) === 56n && integer(tx.value) === 0n && same(tx.input ?? tx.data, record.data) &&
      (tx.input == null || tx.data == null || same(tx.input, tx.data)), 'TRANSACTION_MISMATCH');
    need(integer(tx.nonce) === integer(record.nonce), 'NONCE_MISMATCH');
    if (tx.blockNumber != null) need(integer(tx.blockNumber) >= integer(record.fromBlock), 'OLD_TRANSACTION');
  }
  function evidence(receipt, record) {
    const input = selectionInput(record.kind, record.input), matches = [], progress = [], attempts = [];
    need(Array.isArray(receipt.logs) && receipt.logs.length <= 3000, 'EVENT_MISMATCH');
    const iface = record.kind === 'approve' ? TOKEN : GAME;
    for (const log of receipt.logs) {
      need(!log.removed && same(log.transactionHash, record.hash) && same(log.blockHash, receipt.blockHash) &&
        integer(log.blockNumber) === integer(receipt.blockNumber), 'EVENT_MISMATCH');
      if (!same(log.address, record.to)) continue;
      let event; try { event = iface.parseLog(log); } catch { throw new TestPlayerError('EVENT_MISMATCH'); }
      if (event?.name === ({ approve: 'Approval', buy: 'TicketsPurchased', refund: 'Refunded', settle: 'Settled' })[record.kind]) matches.push(event.args);
      if (record.kind === 'settle' && event?.name === 'DrawProgress') progress.push(event.args);
      if (record.kind === 'settle' && event?.name === 'AttemptEvaluated') attempts.push(event.args);
    }
    if (record.kind === 'approve') {
      need(matches.length === 1 && same(matches[0].owner, record.account) && same(matches[0].spender, TEST_PLAYER.address) && matches[0].value === input.amount, 'EVENT_MISMATCH');
      return { amount: input.amount.toString() };
    }
    if (record.kind === 'refund') {
      need(matches.length === 1 && matches[0].roundId === input.roundId && same(matches[0].buyer, record.account) && matches[0].amount > 0n && matches[0].amount <= 5000n * TEST_PLAYER.ticketPrice, 'EVENT_MISMATCH');
      return { amount: matches[0].amount.toString() };
    }
    if (record.kind === 'settle') {
      if (matches.length === 0) {
        need(progress.length === 1 && progress[0].roundId === input.roundId && attempts.length === 4 &&
          attempts.every((a, i) => a.roundId === input.roundId && !a.accepted && a.candidate >= 60000n &&
            (!i || a.cursor === attempts[i - 1].cursor + 1n)) && progress[0].nextCursor === attempts[3].cursor + 1n, 'EVENT_MISMATCH');
        return { progress: true, nextCursor: progress[0].nextCursor.toString() };
      }
      need(matches.length === 1 && matches[0].roundId === input.roundId && matches[0].ticket < 10000n && !same(matches[0].winner, '0x' + '0'.repeat(40)), 'EVENT_MISMATCH');
      need(progress.length === 0, 'EVENT_MISMATCH');
      return { winner: matches[0].winner, ticket: Number(matches[0].ticket) + 1 };
    }
    const tickets = [], seen = new Set(); let paid = 0n;
    for (const a of matches) {
      need(a.roundId === input.roundId && same(a.buyer, record.account) && a.firstTicket < a.endExclusive && a.endExclusive <= 10000n &&
        a.paid === (a.endExclusive - a.firstTicket) * TEST_PLAYER.ticketPrice, 'EVENT_MISMATCH');
      for (let n = Number(a.firstTicket); n < Number(a.endExclusive); n++) { need(!seen.has(n) && tickets.length < 1000, 'EVENT_MISMATCH'); seen.add(n); tickets.push(n + 1); }
      paid += a.paid;
    }
    need(BigInt(tickets.length) === input.quantity && paid === input.amount, 'EVENT_MISMATCH');
    // Selected sold numbers may have moved; receipt ownership is the actual result.
    return { amount: paid.toString(), tickets: tickets.sort((a, b) => a - b) };
  }
  async function checkPending() {
    if (checking) return checking;
    checking = withLock(async () => {
      if (busy) return getState(); load(); update();
      if (storageError || !pending) return getState();
      const record = clone(pending); if (!record.hash) return getState();
      try {
        need(integer(await rpc('eth_chainId', [])) === 56n, 'RPC_NETWORK');
        const latest = await header('latest');
        const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [record.hash]), rpc('eth_getTransactionReceipt', [record.hash])]);
        if (!tx || !receipt) { if (tx) verifyTransaction(tx, record); persist({ ...record, status: 'pending', reason: 'AWAITING_RECEIPT' }, record.id); return getState(); }
        verifyTransaction(tx, record);
        need(same(receipt.transactionHash, record.hash) && same(receipt.from, record.account) && same(receipt.to, record.to) &&
          same(receipt.blockHash, tx.blockHash) && integer(receipt.blockNumber) === integer(tx.blockNumber), 'RECEIPT_MISMATCH');
        const status = integer(receipt.status); need(status === 0n || status === 1n, 'RECEIPT_MISMATCH');
        const block = await header(toQuantity(integer(receipt.blockNumber)));
        need(same(block.hash, receipt.blockHash) && Array.isArray(block.transactions) && block.transactions.some(h => same(h, record.hash)), 'REORG');
        need(integer(latest.number) >= integer(block.number) && same((await header(latest.number)).hash, latest.hash), 'REORG');
        const count = integer(latest.number) - integer(block.number) + 1n;
        const proof = status === 1n ? evidence(receipt, record) : null;
        // Approvals and purchases unlock after their first verified onchain
        // receipt. Refunds/settlement retain the longer confirmation threshold.
        const requiredConfirmations = ['approve', 'buy'].includes(record.kind) ? 1 : confirmations;
        const checked = { ...record, status: count >= BigInt(requiredConfirmations) ? status === 1n ? 'confirmed' : 'reverted' : 'confirming',
          reason: count >= BigInt(requiredConfirmations) ? 'RECEIPT_CONFIRMED' : 'AWAITING_CONFIRMATIONS', confirmations: Number(count), requiredConfirmations, evidence: proof };
        if (count >= BigInt(requiredConfirmations)) { if (persist(null, record.id)) { history.unshift(checked); if (history.length > 25) history.pop(); } }
        else persist(checked, record.id);
      } catch (error) { persist({ ...record, status: 'unknown', reason: error.code ?? 'RPC_UNAVAILABLE' }, record.id); }
      return getState();
    });
    try { return await checking; } finally { checking = null; update(); }
  }
  async function attachHash(value) {
    need(!busy && !checking, 'TRANSACTION_IN_FLIGHT');
    await withLock(async () => {
      load(); need(!storageError && pending && !pending.hash, 'NO_UNKNOWN_INTENT');
      const record = { ...pending, hash: hash(value) }; need(integer(await rpc('eth_chainId', [])) === 56n, 'RPC_NETWORK');
      const tx = await rpc('eth_getTransactionByHash', [record.hash]); verifyTransaction(tx, record);
      need(persist({ ...record, status: 'pending', reason: 'HASH_ATTACHED_RECHECK_REQUIRED' }, record.id), 'PENDING_CHANGED'); update();
    });
    return checkPending();
  }
  return { readState, execute, getState, checkPending, attachHash };
}
