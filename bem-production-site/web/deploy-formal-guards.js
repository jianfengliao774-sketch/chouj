import { ContractFactory, Interface, getAddress, getCreateAddress, keccak256, toQuantity } from 'ethers';

export const DEPLOY_FIXED = Object.freeze({
  chainId: 56, processor: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C', processorId: '2075',
  deployer: '0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',
  subscriptionOwner: '0x304F06903324B8056cB1ED627144EfB2C34df3a8',
  authorizationOwner: '0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',
  authorizationContainer: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  authorizationNft: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', authorizationTokenId: '13061',
  revenueContainer: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  revenueNft: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', revenueTokenId: '13061',
  bem: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  opener: '0x021745DE2f42A7839d96f2d3634d0294487D81F1',
  coordinator: '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9',
  subscriptionId: '77582411398321098948652233841078712279496169525251928512909841261362926957679',
  requestConfirmations: 3, callbackGasLimit: 250000,
  circuitHash: '0xa375924f2a31f5169606ea20e357efa2aeeb2355aff859f28f40a15519714eef',
  keyHash: '0x130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4',
});
export const DEPLOY_MODES = Object.freeze({
  pool10: Object.freeze({ name: '正式合约 · 每期 10 BEM', contractName: 'BemOwnContainer13061Pool10BSC', pool: '1000000000', ticketPrice: '100000', tickets: '10000', maxPerPurchase: '1000', blackhole: '40000000', organizer: '10000000', winner: '950000000' }),
  pool50: Object.freeze({ name: '正式合约 · 每期 50 BEM', contractName: 'BemOwnContainer13061Pool50BSC', pool: '5000000000', ticketPrice: '500000', tickets: '10000', maxPerPurchase: '1000', blackhole: '200000000', organizer: '50000000', winner: '4750000000' }),
  pool100: Object.freeze({ name: '正式合约 · 每期 100 BEM', contractName: 'BemOwnContainer13061Pool100BSC', pool: '10000000000', ticketPrice: '1000000', tickets: '10000', maxPerPurchase: '1000', blackhole: '400000000', organizer: '100000000', winner: '9500000000' }),
});
export const FORMAL_VERSION = 'container13061-authorized-2075-computation';
// A different deployer uses separate durable intents; never clear or import the old wallet's records.
export const FORMAL_STORAGE_KEY = `bem13061-formal-deployment-records-v3:${DEPLOY_FIXED.deployer.toLowerCase()}`;
export const FORMAL_LOCK_KEY = `bem13061-formal-deployment-v3:${DEPLOY_FIXED.deployer.toLowerCase()}`;
export const CONSTRUCTOR = ['constructor(uint256 vrfSubscriptionId,uint16 confirmations,uint32 vrfCallbackGasLimit)'];
export const CONSTRUCTOR_ARGS = Object.freeze([DEPLOY_FIXED.subscriptionId, DEPLOY_FIXED.requestConfirmations, DEPLOY_FIXED.callbackGasLimit]);
const HEX = /^0x(?:[0-9a-f]{2})+$/i;
export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const need = (condition, message) => { if (!condition) throw new Error(message); };
export function uint(value) {
  need(typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value) ||
    typeof value === 'string' && /^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i.test(value), '链上数值格式异常，已停止操作。');
  const result = BigInt(value); need(result >= 0n && result < 2n ** 256n, '链上数值越界，已停止操作。'); return result;
}
export const rpcQuantity = value => toQuantity(uint(value));
export const rpcBlockTag = value => ['latest', 'pending', 'safe', 'finalized', 'earliest'].includes(value) ? value : rpcQuantity(value);
export function normalizeReadResult(method, value) {
  if (['eth_chainId', 'eth_blockNumber', 'eth_estimateGas', 'eth_gasPrice', 'eth_getBalance', 'eth_getTransactionCount'].includes(method)) return rpcQuantity(value);
  const keys = method === 'eth_getBlockByNumber' ? ['number', 'timestamp'] : method === 'eth_getTransactionReceipt'
    ? ['blockNumber', 'status'] : method === 'eth_getTransactionByHash' ? ['nonce', 'chainId', 'value', 'blockNumber'] : [];
  if (value == null || !keys.length) return value;
  const copy = { ...value };
  for (const key of keys) if (copy[key] != null) copy[key] = rpcQuantity(copy[key]);
  return copy;
}
export function deploymentMode(mode) { need(Object.hasOwn(DEPLOY_MODES, mode), '请选择 10、50 或 100 BEM 新正式合约。'); return DEPLOY_MODES[mode]; }
export function assertDeployer(account) { need(sameAddress(account, DEPLOY_FIXED.deployer), '请连接指定部署钱包 0x7674…Ea53。该钱包持有 13061 容器，并通过容器完成后续授权启动。'); }

// The artifacts are compiled into this page's build, never fetched from a user-provided URL.
export function validateDeploymentArtifact(artifact, mode) {
  const selected = deploymentMode(mode);
  need(artifact?.contractName === selected.contractName, '部署文件与所选合约类型不一致。');
  need(artifact.testOnly === false && artifact.contractVersion === 3 && artifact.architecture === FORMAL_VERSION, '部署文件不是 13061 授权的新正式版本。');
  need(HEX.test(artifact.bytecode) && HEX.test(artifact.deployedBytecode), '部署代码格式不正确。');
  need((artifact.bytecode.length - 2) / 2 === artifact.creationBytecodeBytes &&
    (artifact.deployedBytecode.length - 2) / 2 === artifact.runtimeBytecodeBytes, '部署代码长度不匹配。');
  const binding = artifact.fixedBindings;
  need(binding && sameAddress(binding.processor, DEPLOY_FIXED.processor) && String(binding.processorId) === DEPLOY_FIXED.processorId &&
    sameAddress(binding.authorizationContainer, DEPLOY_FIXED.authorizationContainer) &&
    sameAddress(binding.authorizationNft, DEPLOY_FIXED.authorizationNft) && String(binding.authorizationTokenId) === DEPLOY_FIXED.authorizationTokenId &&
    sameAddress(binding.revenueContainer, DEPLOY_FIXED.revenueContainer) && sameAddress(binding.revenueNft, DEPLOY_FIXED.revenueNft) &&
    String(binding.revenueTokenId) === DEPLOY_FIXED.revenueTokenId, '部署文件的处理器或容器绑定不匹配。');
  const rules = artifact.fixedRules;
  need(rules && rules.partialFill === true && String(rules.poolBaseUnits) === selected.pool && String(rules.ticketPriceBaseUnits) === selected.ticketPrice &&
    String(rules.ticketsPerRound) === selected.tickets && String(rules.maxTicketsPerPurchase) === selected.maxPerPurchase &&
    String(rules.blackholeBaseUnits) === selected.blackhole && String(rules.organizerBaseUnits) === selected.organizer &&
    String(rules.winnerBaseUnits) === selected.winner && String(rules.fundingWindowSeconds) === '86400' &&
    String(rules.refundClaimWindowSeconds) === '86400' && String(rules.maxTicketsPerAddress) === '5000', '部署文件的金额、退款期限或票数规则不匹配。');
  const constructor = new Interface(artifact.abi).deploy;
  need(constructor.inputs.map(input => input.type).join(',') === 'uint256,uint16,uint32', '合约构造参数不匹配。');
  immutableRanges(artifact);
  return selected;
}
export async function deploymentData(artifact, mode) {
  validateDeploymentArtifact(artifact, mode);
  const transaction = await new ContractFactory(CONSTRUCTOR, artifact.bytecode).getDeployTransaction(...CONSTRUCTOR_ARGS);
  need(transaction.to == null && transaction.value == null && HEX.test(transaction.data), '创建交易格式异常。');
  return transaction.data;
}
function immutableRanges(artifact) {
  need(artifact.immutableReferences && typeof artifact.immutableReferences === 'object', '缺少编译器不可变参数位置。');
  const ranges = Object.values(artifact.immutableReferences).flat().sort((a, b) => a.start - b.start);
  const length = (artifact.deployedBytecode.length - 2) / 2;
  need(ranges.length > 0 && ranges.length < 1000, '不可变参数位置异常。');
  ranges.forEach((range, index) => {
    need(Number.isSafeInteger(range.start) && range.start >= 0 && range.length === 32 && range.start + 32 <= length &&
      (!index || ranges[index - 1].start + 32 <= range.start), '不可变参数位置异常。');
    need(/^0{64}$/.test(artifact.deployedBytecode.slice(2 + range.start * 2, 2 + (range.start + 32) * 2)), '不可变参数模板异常。');
  });
  return ranges;
}
export function verifyDeploymentRuntime(code, artifact, mode) {
  validateDeploymentArtifact(artifact, mode);
  need(typeof code === 'string' && HEX.test(code) && code.length === artifact.deployedBytecode.length, '链上运行代码长度不匹配。');
  let normalized = code.toLowerCase();
  for (const { start, length } of immutableRanges(artifact)) normalized = normalized.slice(0, 2 + start * 2) + '0'.repeat(length * 2) + normalized.slice(2 + (start + length) * 2);
  need(keccak256(normalized) === keccak256(artifact.deployedBytecode), '链上运行代码与部署版本不匹配。');
  return keccak256(code);
}
export function assertContainerBindings(binding) {
  const f = DEPLOY_FIXED;
  need(Number(binding.chainId) === 56, '请切换到 BNB 主网（56）。');
  for (const [name, nft, tokenId, account] of [
    ['authorization', f.authorizationNft, f.authorizationTokenId, f.authorizationContainer],
    ['revenue', f.revenueNft, f.revenueTokenId, f.revenueContainer],
  ]) {
    const row = binding[name];
    need(row && row.opened === true && sameAddress(row.account, account) && Number(row.token[0]) === 56 &&
      sameAddress(row.token[1], nft) && String(row.token[2]) === tokenId, '容器链上归属或创建状态不匹配，已停止部署。');
  }
  need(sameAddress(binding.authorizationOwner, binding.authorizationNftOwner) && sameAddress(binding.authorizationOwner, f.authorizationOwner),
    '13061 容器持有人与已核对的启动钱包不一致，已停止部署。');
  need(Number(binding.decimals) === 8 && binding.netlistHash === f.circuitHash, 'BEM 精度或 2075 电路代码不匹配。');
  need(binding.circuitInfo.map(String).join(',') === '12,9,0,71', '2075 电路参数不匹配。');
  need(Array.isArray(binding.dependencyCodes) && binding.dependencyCodes.length === 7 && binding.dependencyCodes.every(code => typeof code === 'string' && HEX.test(code)), '链上依赖缺少合约代码。');
}
export const ADDRESS_READBACK = Object.freeze({ bem: DEPLOY_FIXED.bem, organizer: DEPLOY_FIXED.revenueContainer,
  CONTAINER: DEPLOY_FIXED.authorizationContainer, AUTHORIZATION_NFT: DEPLOY_FIXED.authorizationNft, CIRCUITS: DEPLOY_FIXED.processor,
  REVENUE_CONTAINER: DEPLOY_FIXED.revenueContainer, REVENUE_NFT: DEPLOY_FIXED.revenueNft, coordinator: DEPLOY_FIXED.coordinator,
  OPENER: DEPLOY_FIXED.opener, BLACKHOLE: '0x000000000000000000000000000000000000dEaD' });
export function expectedReadback(mode, deploymentBlock) {
  const selected = deploymentMode(mode), f = DEPLOY_FIXED;
  return { ...ADDRESS_READBACK, AUTHORIZATION_TOKEN_ID: '13061', CIRCUIT_ID: '2075', REVENUE_TOKEN_ID: '13061',
    TICKET_PRICE: selected.ticketPrice, TICKETS_PER_ROUND: selected.tickets, MAX_TICKETS_PER_PURCHASE: selected.maxPerPurchase, ROUND_POOL: selected.pool,
    ORGANIZER_AMOUNT: selected.organizer, WINNER_AMOUNT: selected.winner, BLACKHOLE_AMOUNT: selected.blackhole,
    subscriptionId: f.subscriptionId, requestConfirmations: '3', callbackGasLimit: '250000', fundingWindow: '86400',
    REFUND_CLAIM_WINDOW: '86400', MAX_TICKETS_PER_ADDRESS: '5000', PARTIAL_FILL: true,
    drawWindow: '3600', NEXT_ROUND_DELAY: '60', keyHash: f.keyHash, CIRCUIT_HASH: f.circuitHash,
    sourceVerifiedAtBlock: String(deploymentBlock), seriesAuthorized: false, currentRoundId: '1', totalLiability: '0' };
}
export function assertDeploymentReadback(values, mode, deploymentBlock) {
  for (const [field, value] of Object.entries(expectedReadback(mode, deploymentBlock))) {
    const actual = values[field];
    need(Object.hasOwn(ADDRESS_READBACK, field) ? sameAddress(actual, value) :
      typeof value === 'boolean' ? actual === value : String(actual).toLowerCase() === String(value).toLowerCase(), `链上参数 ${field} 与所选部署不一致。`);
  }
}
export function assertDeploymentTransaction({ transaction, receipt, block, latestBlock, account, data, nonce }) {
  need(transaction && receipt && block, '交易或区块暂时不可查，请稍后重新核对。');
  assertCreationTransaction(transaction, account, data);
  need(uint(transaction.nonce) === uint(nonce), '交易 nonce 与本次部署记录不同。');
  need(sameAddress(receipt.transactionHash, transaction.hash) && sameAddress(receipt.from, account) && receipt.to == null &&
    sameAddress(receipt.blockHash, transaction.blockHash) && sameAddress(receipt.blockHash, block.hash) &&
    uint(receipt.blockNumber) === uint(transaction.blockNumber) && uint(block.number) === uint(receipt.blockNumber) &&
    Array.isArray(block.transactions) && block.transactions.some(hash => sameAddress(hash, transaction.hash)), '交易回执与主链区块不一致。');
  need(uint(receipt.status) === 1n, '该部署交易已失败，未创建合约。');
  need(sameAddress(receipt.contractAddress, getCreateAddress({ from: account, nonce })), '部署合约地址不符合创建交易。');
  const confirmations = Number(uint(latestBlock) - uint(receipt.blockNumber) + 1n);
  need(confirmations >= 12, `部署已上链，等待足够确认（${Math.max(0, confirmations)} / 12）。`);
  return getAddress(receipt.contractAddress);
}
export function assertCreationTransaction(transaction, account, data) {
  assertDeployer(account);
  need(transaction && /^0x[0-9a-f]{64}$/i.test(transaction.hash) && uint(transaction.chainId) === 56n &&
    sameAddress(transaction.from, account) && transaction.to == null &&
    (transaction.input ?? transaction.data)?.toLowerCase() === data.toLowerCase() && uint(transaction.value) === 0n,
    '交易不是当前钱包所选档位的合约创建交易。');
}
export function assertUnsuccessfulDeployment({ transaction, receipt, block, latestBlock, account, data, nonce, originalTransaction, senderCode, deployedCode }) {
  assertDeployer(account);
  need(transaction && receipt && block, '交易回执尚不可查。');
  need(uint(transaction.chainId) === 56n && sameAddress(transaction.from, account) && uint(transaction.nonce) === uint(nonce), '交易身份或序号不匹配。');
  need(sameAddress(receipt.transactionHash, transaction.hash) && sameAddress(receipt.from, account) &&
    sameAddress(receipt.blockHash, transaction.blockHash) && sameAddress(receipt.blockHash, block.hash) &&
    uint(receipt.blockNumber) === uint(transaction.blockNumber) && uint(block.number) === uint(receipt.blockNumber) &&
    Array.isArray(block.transactions) && block.transactions.some(hash => sameAddress(hash, transaction.hash)) &&
    uint(latestBlock) - uint(receipt.blockNumber) + 1n >= 12n, '交易尚未得到足够主链确认，不能释放部署锁。');
  if (uint(receipt.status) === 0n) {
    assertCreationTransaction(transaction, account, data);
    const predicted = getCreateAddress({ from: account, nonce });
    need(receipt.to == null && (receipt.contractAddress == null || sameAddress(receipt.contractAddress, predicted)) && deployedCode === '0x', '失败创建交易的回执或地址代码不匹配。');
    return 'resolved_failed';
  }
  assertCreationTransaction(originalTransaction, account, data);
  need(uint(originalTransaction.nonce) === uint(transaction.nonce) && !sameAddress(originalTransaction.hash, transaction.hash) &&
    uint(receipt.status) === 1n && sameAddress(transaction.to, account) && sameAddress(receipt.to, account) &&
    uint(transaction.value) === 0n && (transaction.input ?? transaction.data) === '0x' &&
    receipt.contractAddress == null && Array.isArray(receipt.logs) && receipt.logs.length === 0 && senderCode === '0x',
    '尚不能证明原部署已取消，请保留记录并核实钱包。');
  return 'resolved_cancelled';
}
export function assertDeploymentIntent({ mode, account, epoch, estimate }, current, now = Date.now()) {
  deploymentMode(mode);
  assertDeployer(account);
  need(mode === current.mode && sameAddress(account, current.account) && epoch === current.epoch && current.chainId === 56,
    '钱包、网络或合约类型已变化，请重新核对费用。');
  need(estimate && estimate.mode === mode && estimate.epoch === epoch && sameAddress(estimate.account, account) &&
    estimate.wallet === current.wallet && estimate.expiresAt > now && estimate.createdAt <= now && estimate.expiresAt - estimate.createdAt === 90000,
    '费用核对已过期，请重新估算。');
}
export function assertResolvedReset(result, record, mode) {
  deploymentMode(mode);
  need(result && result.mode === mode && ['resolved_failed', 'resolved_cancelled'].includes(result.status) &&
    record && record.mode === mode && result.status === record.status && sameAddress(result.hash, record.hash) &&
    sameAddress(result.account, record.account) && String(result.nonce) === String(record.nonce),
    '本次重新核验未证明交易已结束，部署锁已保留。');
}
