import { getAddress } from 'ethers';
import { getPoolRules } from './pool-selection.js';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const need = (condition, code) => { if (!condition) { const error = new Error(code); error.code = code; throw error; } };
export function previewPoolSelection({ poolId, mode = 'auto', count = '1', text = '' }) {
  const rules = getPoolRules(poolId); let tickets = null, quantity = 0;
  if (mode === 'auto') {
    need(/^[1-9][0-9]{0,3}$/.test(String(count)), 'TICKET_LIMIT'); quantity = Number(count);
  } else {
    need(mode === 'selected', 'TICKET_FORMAT');
    need(typeof text === 'string' && text.length <= 8000, 'TICKET_FORMAT');
    const parts = text.trim().replace(/\s*-\s*/g, '-').split(/[，、,;；\s]+/).filter(Boolean), selected = new Set();
    need(parts.length, 'NO_TICKETS');
    for (const part of parts) {
      need(/^\d{1,5}(?:-\d{1,5})?$/.test(part), 'TICKET_FORMAT');
      const [first, last = first] = part.split('-').map(Number);
      need(first >= 1 && last <= 10000 && last >= first, 'TICKET_RANGE');
      need(last - first + 1 <= rules.maxTicketsPerPurchase, 'TICKET_LIMIT');
      for (let n = first; n <= last; n++) { selected.add(n); need(selected.size <= rules.maxTicketsPerPurchase, 'TICKET_LIMIT'); }
    }
    tickets = [...selected].sort((a, b) => a - b); quantity = tickets.length;
  }
  need(Number.isInteger(quantity) && quantity >= 1 && quantity <= rules.maxTicketsPerPurchase, 'TICKET_LIMIT');
  return Object.freeze({ poolId, mode, quantity, tickets, amountBaseUnits: (BigInt(quantity) * BigInt(rules.ticketPriceBaseUnits)).toString(),
    maxTicketsPerAddress: rules.maxTicketsPerAddress, writeEnabled: false });
}

/** Selection and wallet state stay read-only. The isolated test transaction module
 * verifies its own deployment; this model never falls back to the old game. */
export function createPendingPlayerState({ poolId = '100' } = {}) {
  getPoolRules(poolId);
  let epoch = 0, account = null, chainId = null, selection = { mode: 'auto', count: '1', text: '' }, balance = null;
  const snapshot = () => Object.freeze({ epoch, poolId, rules: getPoolRules(poolId), account, chainId,
    selection: Object.freeze({ ...selection }), balance, writeEnabled: false, available: false });
  const current = saved => saved?.epoch === epoch && saved.poolId === poolId && same(saved.account ?? '', account ?? '') && saved.chainId === chainId;
  return {
    getState: snapshot, isCurrent: current,
    selectPool(next) { getPoolRules(next); if (next !== poolId) { poolId = next; epoch++; selection = { mode: 'auto', count: '1', text: '' }; balance = null; } return snapshot(); },
    invalidate() { epoch++; balance = null; return snapshot(); },
    setWallet(nextAccount, nextChain) {
      const normalized = nextAccount == null ? null : getAddress(nextAccount);
      const network = nextChain == null ? null : Number(nextChain);
      need(network == null || Number.isSafeInteger(network) && network >= 0, 'NETWORK');
      epoch++; account = normalized; chainId = network; balance = null; return snapshot();
    },
    setSelection(next) { selection = { ...selection, ...next }; return snapshot(); },
    preview() { return previewPoolSelection({ poolId, ...selection }); },
    acceptBalance(saved, result) {
      if (!current(saved) || !account || chainId !== 56) return false;
      need(result && BigInt(result.bem) >= 0n && BigInt(result.bnb) >= 0n && Number.isSafeInteger(result.block) && result.block >= 0, 'BALANCE');
      balance = Object.freeze({ bem: BigInt(result.bem).toString(), bnb: BigInt(result.bnb).toString(), block: result.block }); return true;
    },
    requireWriteAllowed() { need(false, 'POOL_NOT_LAUNCHED'); },
  };
}
