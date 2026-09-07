// Confirmed event history for the deployed BEM2075 raffle. All RPC access is
// read-only; wallet signing and live/unconfirmed UI state belong elsewhere.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';

export const HISTORY_GAME = '0xBee0848D0c77d434A52d1D0236FcBFdCA0834343';
export const HISTORY_DEPLOYMENT_BLOCK = 120311123;
const EVENT_ABI = [
  'event RoundStarted(uint256 indexed roundId,uint64 fundingDeadline)',
  'event TicketsPurchased(uint256 indexed roundId,address indexed buyer,uint32 firstTicket,uint32 endExclusive,uint256 paid)',
  'event RoundLocked(uint256 indexed roundId,uint64 drawDeadline)',
  'event DrawRequested(uint256 indexed roundId,uint256 indexed requestId)',
  'event RandomnessReceived(uint256 indexed roundId,uint256 indexed requestId,uint256 ticketWord,uint256 circuitWord)',
  'event RandomnessIgnored(uint256 indexed requestId)', 'event RefundsOpened(uint256 indexed roundId)',
  'event Refunded(uint256 indexed roundId,address indexed buyer,uint256 amount)',
  'event AttemptEvaluated(uint256 indexed roundId,uint32 indexed cursor,uint16 input0,uint16 input1,uint16 output0,uint16 output1,uint16 candidate,bool accepted)',
  'event DrawProgress(uint256 indexed roundId,uint32 nextCursor)',
  'event Settled(uint256 indexed roundId,address indexed winner,uint32 winningTicket)',
  'event BlackholeTransfer(uint256 indexed roundId,uint256 amount)',
  'event ContainerBindingFixed(address indexed container,address indexed nft,uint256 tokenId)',
  'event ContainerSeriesAuthorized(address indexed container)',
  'event DrawWindowOpened(uint256 indexed roundId,uint64 lockedAt,uint64 targetDrawBy)',
  'event DrawScheduled(uint256 indexed roundId,uint64 scheduledDrawAt,uint64 targetDrawBy)',
  'event NextRoundScheduled(uint256 indexed resolvedRoundId,uint256 indexed nextRoundId,uint64 opensAt)'
];
const EXPECTED_EVENT_LAYOUT = new Interface(EVENT_ABI).fragments.map(f => f.format('full')).sort();
const READ_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getTransactionReceipt']);
const hex = value => `0x${value.toString(16)}`;
const clone = value => structuredClone(value);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const validHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const number = value => {
  const n = Number(BigInt(value)); assert.ok(Number.isSafeInteger(n) && n >= 0, 'Invalid chain integer'); return n;
};
const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const eventOrder = (a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;
const paginate = (rows, { page = 1, pageSize = 20 } = {}) => {
  page = Number(page); pageSize = Number(pageSize);
  assert.ok(Number.isInteger(page) && page >= 1, 'Invalid page');
  assert.ok(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100, 'Invalid page size');
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize,
    total: rows.length, totalPages: Math.ceil(rows.length / pageSize) };
};

/**
 * rpc(method, params) returns the RPC result or throws. It must never convert an
 * upstream error into []. Official dataseed endpoints disable eth_getLogs;
 * callers should supply a logs-capable endpoint (e.g. PublicNode).
 * The caller owns process-level exclusivity for storagePath. sync() itself is
 * single-flight, so repeated HTTP requests cannot start parallel catch-up loops.
 */
export function createChainHistory({ rpc, gameAddress = HISTORY_GAME, abi,
  deploymentBlock = HISTORY_DEPLOYMENT_BLOCK, storagePath, confirmations = 12,
  chunkSize = 100, maxBlocksPerSync = 400, maxLogsPerChunk = 5000, maxTransactionsPerChunk = 100 } = {}) {
  assert.equal(typeof rpc, 'function'); assert.equal(getAddress(gameAddress), HISTORY_GAME);
  assert.equal(deploymentBlock, HISTORY_DEPLOYMENT_BLOCK);
  assert.equal(typeof storagePath, 'string'); assert.ok(storagePath.length > 0);
  for (const [key, value] of Object.entries({ confirmations, chunkSize, maxBlocksPerSync, maxLogsPerChunk, maxTransactionsPerChunk })) {
    assert.ok(Number.isInteger(value) && value > 0, `Invalid ${key}`);
  }
  assert.ok(confirmations >= 12, 'Confirmed history requires at least 12 blocks');
  assert.ok(chunkSize <= 1000 && maxBlocksPerSync <= 5000, 'Unbounded history scan prohibited');
  const iface = new Interface(abi);
  const eventFragments = iface.fragments.filter(f => f.type === 'event');
  assert.deepEqual(eventFragments.map(f => f.format('full')).sort(), EXPECTED_EVENT_LAYOUT, 'Unexpected production event ABI');
  const abiHash = keccak256(toUtf8Bytes(eventFragments.map(f => f.format('full')).sort().join('\n')));
  const topicSet = new Set(eventFragments.map(f => iface.getEvent(f.name).topicHash));
  const identity = { schemaVersion: 1, chainId: 56, gameAddress: HISTORY_GAME, deploymentBlock, abiHash };
  let db = { ...identity, cursor: deploymentBlock - 1, checkpoints: [], events: [], receipts: {}, updatedAt: null };
  try {
    const stored = JSON.parse(readFileSync(storagePath, 'utf8'));
    for (const [key, value] of Object.entries(identity)) assert.equal(stored[key], value, `History identity mismatch: ${key}`);
    assert.ok(Number.isSafeInteger(stored.cursor) && stored.cursor >= deploymentBlock - 1);
    assert.ok(Array.isArray(stored.events) && Array.isArray(stored.checkpoints) && stored.receipts && typeof stored.receipts === 'object');
    const ids = new Set();
    for (const event of stored.events) {
      assert.ok(event.blockNumber >= deploymentBlock && event.blockNumber <= stored.cursor);
      assert.ok(validHash(event.blockHash) && validHash(event.transactionHash) && topicSet.has(event.topics?.[0]));
      assert.ok(same(event.address, HISTORY_GAME));
      const parsed = iface.parseLog({ topics: event.topics, data: event.data });
      assert.equal(parsed.name, event.name);
      const args = Object.fromEntries(parsed.fragment.inputs.map((input, i) => [input.name,
        typeof parsed.args[i] === 'bigint' ? parsed.args[i].toString() : parsed.args[i]]));
      assert.deepEqual(event.args, args, 'Stored decoded event differs from raw log');
      assert.ok(!ids.has(event.id), 'Duplicate stored event'); ids.add(event.id);
      assert.ok(stored.receipts[event.transactionHash], 'Stored event lacks receipt');
    }
    db = stored;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let state = 'syncing', targetBlock = null, lastError = null, inFlight = null;
  let roundsCache = null;

  async function read(method, params) {
    assert.ok(READ_METHODS.has(method), 'History cannot write to the chain');
    const result = await rpc(method, params);
    assert.notEqual(result, undefined, `${method} returned no result`);
    if (result && typeof result === 'object' && !Array.isArray(result) && result.error) throw new Error(`${method} returned an RPC error`);
    return result;
  }
  async function header(blockNumber) {
    const block = await read('eth_getBlockByNumber', [hex(blockNumber), false]);
    assert.ok(block && validHash(block.hash) && validHash(block.parentHash), 'Missing canonical block header');
    assert.equal(number(block.number), blockNumber);
    return { number: blockNumber, hash: block.hash, parentHash: block.parentHash, timestamp: number(block.timestamp) };
  }
  async function persist() {
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    const temp = `${storagePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${stringify(db)}\n`, { flag: 'wx' });
      await fs.rename(temp, storagePath);
    } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
  }
  function checkpoint(block) {
    db.checkpoints = db.checkpoints.filter(c => c.number !== block.number);
    db.checkpoints.push(block); db.checkpoints.sort((a, b) => a.number - b.number);
    // Keep the initial anchor and recent checkpoints. Deep reorgs can safely
    // rewind to that verified anchor and resume with the same bounded scan.
    if (db.checkpoints.length > 129) db.checkpoints = [db.checkpoints[0], ...db.checkpoints.slice(-128)];
  }
  async function recoverReorg() {
    if (db.cursor < deploymentBlock) return;
    const latestSaved = db.checkpoints.find(c => c.number === db.cursor);
    assert.ok(latestSaved, 'Persisted cursor has no block hash');
    if (same((await header(db.cursor)).hash, latestSaved.hash)) return;
    const previous = db.checkpoints.filter(c => c.number < db.cursor);
    const candidates = [...previous.slice(-16).reverse()];
    if (previous[0] && !candidates.includes(previous[0])) candidates.push(previous[0]);
    let ancestor = null;
    for (const candidate of candidates) {
      if (same((await header(candidate.number)).hash, candidate.hash)) { ancestor = candidate; break; }
    }
    assert.ok(ancestor, 'No canonical history anchor; explicit recovery is required');
    db.cursor = ancestor.number;
    db.events = db.events.filter(e => e.blockNumber <= db.cursor);
    db.receipts = Object.fromEntries(Object.entries(db.receipts).filter(([, r]) => number(r.blockNumber) <= db.cursor));
    db.checkpoints = db.checkpoints.filter(c => c.number <= db.cursor);
    roundsCache = null; await persist();
  }
  async function logsInRange(start, desiredEnd) {
    let end = desiredEnd;
    for (;;) {
      try {
        const logs = await read('eth_getLogs', [{ address: HISTORY_GAME, fromBlock: hex(start), toBlock: hex(end), topics: [[...topicSet]] }]);
        assert.ok(Array.isArray(logs), 'RPC logs response is not an array');
        if (logs.length > maxLogsPerChunk || new Set(logs.map(l => l.transactionHash)).size > maxTransactionsPerChunk) {
          throw new Error('Chunk data limit exceeded');
        }
        return { logs, end };
      } catch (error) {
        // Only range/rate-limit responses are split. Other failures must surface
        // immediately; not even a single-block failure may become an empty range.
        if (end === start || !/limit|too (many|large)|range|response size/i.test(error.message)) throw error;
        end = start + Math.floor((end - start) / 2);
      }
    }
  }
  async function syncOnce() {
    state = 'syncing'; lastError = null;
    try {
      assert.equal(BigInt(await read('eth_chainId', [])), 56n, 'History RPC is not BNB Chain');
      const latest = await read('eth_getBlockByNumber', ['latest', false]);
      assert.ok(latest && validHash(latest.hash), 'Latest block unavailable');
      const latestNumber = number(latest.number);
      targetBlock = latestNumber - confirmations;
      assert.ok(latestNumber >= db.cursor, 'RPC is behind the persisted history');
      assert.ok(db.cursor < deploymentBlock || targetBlock >= db.cursor,
        'RPC head cannot confirm the persisted history yet');
      if (latestNumber < deploymentBlock) throw new Error('RPC is behind deployment');
      if (!db.checkpoints.length) checkpoint(await header(deploymentBlock - 1));
      await recoverReorg();
      const stopAt = Math.min(targetBlock, db.cursor + maxBlocksPerSync);
      while (db.cursor < stopAt) {
        const start = db.cursor + 1;
        const { logs, end } = await logsInRange(start, Math.min(start + chunkSize - 1, stopAt));
        const endHeader = await header(end);
        const blocks = new Map([[end, endHeader]]), newReceipts = {};
        const eventIds = new Set(), decoded = [];
        for (const log of logs) {
          assert.ok(same(log.address, HISTORY_GAME) && !log.removed, 'Noncanonical or foreign game log');
          assert.ok(validHash(log.blockHash) && validHash(log.transactionHash) && topicSet.has(log.topics?.[0]), 'Invalid game log');
          const blockNumber = number(log.blockNumber), transactionIndex = number(log.transactionIndex), logIndex = number(log.logIndex);
          assert.ok(blockNumber >= start && blockNumber <= end, 'Out-of-range log');
          if (!blocks.has(blockNumber)) blocks.set(blockNumber, await header(blockNumber));
          const block = blocks.get(blockNumber); assert.ok(same(block.hash, log.blockHash), 'Log block hash mismatch');
          const eventId = `${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${logIndex}`;
          assert.ok(!eventIds.has(eventId), 'Duplicate RPC log'); eventIds.add(eventId);
          if (!newReceipts[log.transactionHash]) {
            const receipt = await read('eth_getTransactionReceipt', [log.transactionHash]);
            assert.ok(receipt && same(receipt.transactionHash, log.transactionHash) && same(receipt.blockHash, log.blockHash));
            assert.equal(number(receipt.blockNumber), blockNumber); assert.equal(number(receipt.status), 1);
            assert.ok(Array.isArray(receipt.logs), 'Receipt logs unavailable');
            newReceipts[log.transactionHash] = receipt;
          }
          const receipt = newReceipts[log.transactionHash];
          const receiptLog = receipt.logs.find(l => number(l.logIndex) === logIndex && same(l.address, HISTORY_GAME));
          assert.ok(receiptLog && same(receiptLog.data, log.data) && stringify(receiptLog.topics) === stringify(log.topics), 'RPC log missing from its receipt');
          const parsed = iface.parseLog(log);
          const args = Object.fromEntries(parsed.fragment.inputs.map((input, i) => [input.name,
            typeof parsed.args[i] === 'bigint' ? parsed.args[i].toString() : parsed.args[i]]));
          decoded.push({ id: eventId, address: HISTORY_GAME, name: parsed.name, args,
            blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, transactionIndex, logIndex,
            timeUtc: new Date(block.timestamp * 1000).toISOString(), topics: log.topics, data: log.data,
            explorerUrl: `https://bscscan.com/tx/${log.transactionHash}` });
        }
        assert.ok(same((await header(end)).hash, endHeader.hash), 'Chunk reorganized during reads');
        // Commit cursor only after all logs, receipts, and block hashes verify.
        db.events.push(...decoded.sort(eventOrder)); Object.assign(db.receipts, newReceipts);
        db.cursor = end; checkpoint(endHeader); roundsCache = null;
        await persist();
      }
      assert.ok(same((await header(latestNumber)).hash, latest.hash), 'Snapshot reorganized during scan');
      db.updatedAt = new Date().toISOString(); await persist();
      state = db.cursor >= targetBlock ? 'ready' : 'syncing';
      return getStatus();
    } catch (error) {
      state = 'stale'; lastError = String(error.message || 'History sync failed').replace(/https?:\/\/\S+/g, '[RPC]');
      throw error;
    }
  }
  function sync() {
    if (!inFlight) inFlight = syncOnce().finally(() => { inFlight = null; });
    return inFlight;
  }
  function getStatus() {
    return { state, fromBlock: deploymentBlock, indexedThrough: db.cursor, targetBlock,
      confirmations, updatedAt: db.updatedAt, ...(lastError ? { error: lastError } : {}) };
  }
  function rounds() {
    if (roundsCache) return roundsCache;
    const rows = new Map();
    for (const event of db.events) {
      const id = event.args.roundId ?? event.args.resolvedRoundId;
      if (id == null) continue;
      let row = rows.get(id);
      if (!row) {
        row = { roundId: id, status: 0, winner: null, winningTicket: null, settlementTxHash: null, settledAt: null,
          transactions: [], events: [], sold: 0, raisedBaseUnits: '0', refundedBaseUnits: '0',
          proof: { lockTxHash: null, requestTxHash: null, randomnessTxHash: null, settlementTxHash: null, refundTxHashes: [] } };
        rows.set(id, row);
      }
      if (!row.transactions.includes(event.transactionHash)) row.transactions.push(event.transactionHash);
      row.events.push(event);
      const a = event.args;
      switch (event.name) {
        case 'RoundStarted': row.status = 1; row.fundingDeadline = a.fundingDeadline; row.startedAt = event.timeUtc; break;
        case 'TicketsPurchased':
          row.sold += number(a.endExclusive) - number(a.firstTicket);
          row.raisedBaseUnits = (BigInt(row.raisedBaseUnits) + BigInt(a.paid)).toString(); break;
        case 'RoundLocked': row.status = 2; row.drawDeadline = a.drawDeadline; row.proof.lockTxHash = event.transactionHash; break;
        case 'DrawRequested': row.status = 3; row.requestId = a.requestId; row.proof.requestTxHash = event.transactionHash; break;
        case 'RandomnessReceived': row.status = 4; row.ticketWord = a.ticketWord; row.circuitWord = a.circuitWord; row.proof.randomnessTxHash = event.transactionHash; break;
        case 'DrawWindowOpened': row.lockedAt = a.lockedAt; row.targetDrawBy = a.targetDrawBy; break;
        case 'DrawScheduled': row.scheduledDrawAt = a.scheduledDrawAt; break;
        case 'DrawProgress': row.drawCursor = a.nextCursor; break;
        case 'RefundsOpened': row.status = 6; row.refundsOpenedTxHash = event.transactionHash; break;
        case 'Refunded':
          row.refundedBaseUnits = (BigInt(row.refundedBaseUnits) + BigInt(a.amount)).toString();
          if (!row.proof.refundTxHashes.includes(event.transactionHash)) row.proof.refundTxHashes.push(event.transactionHash); break;
        case 'BlackholeTransfer': row.blackholeBaseUnits = a.amount; row.blackholeTxHash = event.transactionHash; break;
        case 'Settled':
          row.status = 5; row.winner = a.winner; row.winningTicket = number(a.winningTicket);
          row.settlementTxHash = event.transactionHash; row.settledAt = event.timeUtc; row.proof.settlementTxHash = event.transactionHash; break;
        case 'NextRoundScheduled': row.nextRoundId = a.nextRoundId; row.nextRoundOpensAt = a.opensAt; break;
      }
    }
    roundsCache = [...rows.values()].sort((a, b) => BigInt(a.roundId) > BigInt(b.roundId) ? -1 : 1);
    return roundsCache;
  }
  function listRounds(options = {}) {
    const page = paginate(rounds(), options);
    return { rounds: clone(page.rows.map(({ events: _events, ...row }) => row)), page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages };
  }
  function listTransactions(options = {}) {
    const events = options.roundId == null ? db.events : (rounds().find(r => r.roundId === String(options.roundId))?.events || []);
    const byHash = new Map();
    for (const event of events) {
      let tx = byHash.get(event.transactionHash);
      if (!tx) {
        const receipt = db.receipts[event.transactionHash];
        tx = { transactionHash: event.transactionHash, blockNumber: event.blockNumber, blockHash: event.blockHash,
          transactionIndex: event.transactionIndex, timeUtc: event.timeUtc, from: receipt.from, to: receipt.to,
          status: number(receipt.status), explorerUrl: event.explorerUrl, events: [], receipt };
        byHash.set(event.transactionHash, tx);
      }
      tx.events.push(event);
    }
    const values = [...byHash.values()].sort((a, b) => b.blockNumber - a.blockNumber || b.transactionIndex - a.transactionIndex);
    const page = paginate(values, options);
    return { transactions: clone(page.rows), page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages };
  }
  function getRound(roundId) {
    assert.match(String(roundId), /^[1-9][0-9]*$/, 'Invalid round ID');
    const row = rounds().find(r => r.roundId === String(roundId));
    if (!row) return null;
    return clone({ ...row, transactionRecords: row.transactions.map(hash => ({ transactionHash: hash,
      explorerUrl: `https://bscscan.com/tx/${hash}`, receipt: db.receipts[hash] })) });
  }
  function listAnnouncements(options = {}) {
    const rows = rounds().filter(row => row.status === 5 && row.settlementTxHash && row.winner)
      .map(row => ({ poolId: 'legacy100', poolBaseUnits: '10000000000', roundId: row.roundId,
        winner: row.winner, amountBaseUnits: '9500000000', timeUtc: row.settledAt,
        transactionHash: row.settlementTxHash, gameAddress: HISTORY_GAME }));
    return paginate(rows, options);
  }
  function listBurns(options = {}) {
    const rows = db.events.filter(event => event.name === 'BlackholeTransfer')
      .sort((a, b) => -eventOrder(a, b)).map(event => ({ poolId: 'legacy100',
        poolBaseUnits: '10000000000', roundId: event.args.roundId, amountBaseUnits: event.args.amount,
        kind: 'settlement', timeUtc: event.timeUtc, transactionHash: event.transactionHash,
        logIndex: event.logIndex, blockNumber: event.blockNumber, gameAddress: HISTORY_GAME,
        destination: '0x000000000000000000000000000000000000dEaD' }));
    return paginate(rows, options);
  }
  return { sync, getStatus, listRounds, getRound, listTransactions, listAnnouncements, listBurns };
}
