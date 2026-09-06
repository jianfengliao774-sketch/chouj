import { getAddress, Interface } from 'ethers';

export const PINNED = Object.freeze({
  chainId: 56,
  gameAddress: '0xBee0848D0c77d434A52d1D0236FcBFdCA0834343',
  bemAddress: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  containerAddress: '0x358BE84b95224d228f3A61964Fa3c9fB61D7B646',
  processorAddress: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
  coordinator: '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9',
  runtimeCodeHash: '0x924ffeae37682ce516aa4cb8eae09a4cea9acd2148c12634efe60704ddab94b8',
  subscriptionId: '77582411398321098948652233841078712279496169525251928512909841261362926957679',
  ticketPrice: 1000000n,
  circuitId: 2075,
});
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export class GuardError extends Error { constructor(code) { super(code); this.code = code; } }
function requireThat(value, code) { if (!value) throw new GuardError(code); }

export function validateManifest(config) {
  requireThat(config?.schemaVersion === 1 && config.mode === 'production' && config.chainId === 56, 'MANIFEST');
  for (const field of ['gameAddress', 'bemAddress', 'containerAddress', 'processorAddress', 'runtimeCodeHash']) requireThat(same(config[field], PINNED[field]), 'MANIFEST');
  requireThat(config.subscriptionId === PINNED.subscriptionId && config.circuitId === 2075, 'MANIFEST');
  requireThat(config.rpcUrl === '/rpc' && config.explorerBase === 'https://bscscan.com', 'MANIFEST');
  requireThat(config.maxTickets === 10000 && config.maxTicketsPerPurchase === 500 && String(config.ticketPriceBaseUnits) === '1000000', 'MANIFEST');
  requireThat(typeof config.salesEnabled === 'boolean', 'MANIFEST');
  const gameInterface = new Interface(config.gameAbi);
  requireThat(gameInterface.getFunction('buy').format('sighash') === 'buy(uint256,uint32)' && gameInterface.getFunction('buySelected').format('sighash') === 'buySelected(uint256,uint16[])', 'MANIFEST');
  const tokenInterface = new Interface(config.bemAbi);
  requireThat(tokenInterface.getFunction('approve').format('sighash') === 'approve(address,uint256)', 'MANIFEST');
  return config;
}

export function parseSelection(text) {
  const tokens = String(text).trim().replace(/[，、；;]/g, ',').split(/[\s,]+/).filter(Boolean);
  requireThat(tokens.length > 0, 'NO_TICKETS');
  const tickets = new Set();
  for (const token of tokens) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(token);
    requireThat(match, 'TICKET_FORMAT');
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : start;
    requireThat(start >= 1 && end <= 10000 && end >= start, 'TICKET_RANGE');
    requireThat(end - start < 500, 'TICKET_LIMIT');
    for (let value = start; value <= end; value++) tickets.add(value - 1);
    requireThat(tickets.size <= 500, 'TICKET_LIMIT');
  }
  return [...tickets].sort((a, b) => a - b);
}

export function createIntent({mode, count, text, roundId, account, epoch}) {
  const selected = mode === 'selected' ? parseSelection(text) : null;
  const quantity = selected ? selected.length : Number(count);
  requireThat(Number.isInteger(quantity) && quantity >= 1 && quantity <= 500, 'TICKET_LIMIT');
  requireThat(roundId != null && BigInt(roundId) > 0n, 'ROUND_CLOSED');
  requireThat(typeof account === 'string', 'WALLET');
  return Object.freeze({mode, count:quantity, selected:selected && Object.freeze(selected), roundId:String(roundId), account:getAddress(account), epoch, amount:BigInt(quantity) * PINNED.ticketPrice});
}

export function assertFixedSnapshot(fixed) {
  requireThat(Number(fixed.chainId) === 56 && same(fixed.runtimeCodeHash, PINNED.runtimeCodeHash), 'IDENTITY');
  for (const [field, expected] of Object.entries({bem:PINNED.bemAddress,organizer:PINNED.containerAddress,CONTAINER:PINNED.containerAddress,CIRCUITS:PINNED.processorAddress,coordinator:PINNED.coordinator,AUTHORIZATION_NFT:PINNED.processorAddress})) requireThat(same(fixed[field], expected), 'IDENTITY');
  const numeric = {CIRCUIT_ID:2075,AUTHORIZATION_TOKEN_ID:2075,TICKET_PRICE:1000000,TICKETS_PER_ROUND:10000,MAX_TICKETS_PER_PURCHASE:500,ROUND_POOL:10000000000,WINNER_AMOUNT:9500000000,ORGANIZER_AMOUNT:100000000,BLACKHOLE_AMOUNT:400000000,fundingWindow:259200,NEXT_ROUND_DELAY:60,decimals:8};
  for (const [field,value] of Object.entries(numeric)) requireThat(String(fixed[field]) === String(value), 'IDENTITY');
  requireThat(String(fixed.subscriptionId) === PINNED.subscriptionId && same(fixed.BLACKHOLE, '0x000000000000000000000000000000000000dEaD'), 'IDENTITY');
}

export function assertPurchaseSnapshot({config, snapshot, intent, walletAccount, walletChain, epoch, action}) {
  validateManifest(config);
  requireThat(config.salesEnabled === true, 'NOT_LAUNCHED');
  requireThat(Number(walletChain) === 56, 'NETWORK');
  requireThat(epoch === intent.epoch && same(walletAccount,intent.account), 'WALLET_CHANGED');
  requireThat(same(snapshot.account,intent.account), 'WALLET_CHANGED');
  requireThat(snapshot.seriesAuthorized === true, 'NOT_LAUNCHED');
  requireThat(String(snapshot.roundId) === intent.roundId, 'ROUND_CHANGED');
  requireThat(snapshot.status === 1 && snapshot.sold < 10000 && snapshot.timestamp < snapshot.fundingDeadline, 'ROUND_CLOSED');
  requireThat(snapshot.sold + intent.count <= 10000, 'TICKET_SOLD');
  requireThat(BigInt(snapshot.balance) >= intent.amount, 'BALANCE');
  if (intent.selected) {
    requireThat(Array.isArray(snapshot.words) && snapshot.words.length === 625, 'TICKET_LOOKUP');
    for (const ticket of intent.selected) requireThat((BigInt(snapshot.words[Math.floor(ticket/16)]) >> BigInt((ticket%16)*16) & 65535n) === 0n, 'TICKET_SOLD');
  }
  if (action === 'buy') requireThat(BigInt(snapshot.allowance) === intent.amount, 'ALLOWANCE');
  if (action === 'approve') requireThat(BigInt(snapshot.allowance) !== intent.amount, 'ALREADY_APPROVED');
}

export function explorerLink(kind, value) {
  if (kind === 'address' && /^0x[0-9a-fA-F]{40}$/.test(String(value))) return `https://bscscan.com/address/${value}`;
  if (kind === 'tx' && /^0x[0-9a-fA-F]{64}$/.test(String(value))) return `https://bscscan.com/tx/${value}`;
  if (kind === 'block' && /^\d+$/.test(String(value))) return `https://bscscan.com/block/${value}`;
  return null;
}
