import { Interface, getAddress, keccak256 } from 'ethers';
import { DEPLOY_FIXED } from './deploy-container-guards.js';

export const START_FIXED = Object.freeze({ ...DEPLOY_FIXED,
  game: '0xE7D8dF903050d875f09cE1BBcE20E837fB55bC0c',
  runtimeHash: '0xef681f526023ed624835dd100d6178dfa4876c34763d7ed566727e791390f7bc',
  execFeeWei: '200000000000000',
});
export const START_ACTIONS = Object.freeze({ consumer: '添加 VRF 消费者', authorize: '授权并启动 1 BEM 测试场' });
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const need = (condition, message) => { if (!condition) throw Error(message); };
export const isHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
export const uint = value => { need(typeof value === 'bigint' || typeof value === 'string' && /^(0x[0-9a-f]+|0|[1-9][0-9]*)$/i.test(value), '链上数值格式异常。'); const n = BigInt(value); need(n >= 0n && n < 2n ** 256n, '链上数值越界。'); return n; };
export const START_ABI = new Interface([
  'function addConsumer(uint256 subId,address consumer)',
  'function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)',
  'function execute(address to,uint256 value,bytes data,uint8 operation) payable returns(bytes)',
  'function authorizeSeries()', 'function owner() view returns(address)', 'function EXEC_FEE() view returns(uint256)',
  'function ownerOf(uint256) view returns(address)', 'function token() view returns(uint256,address,uint256)',
  'function accountOf(address,uint256) view returns(address)', 'function isOpened(address,uint256) view returns(bool)',
  'function seriesAuthorized() view returns(bool)', 'function currentRoundId() view returns(uint256)',
  'function subscriptionId() view returns(uint256)',
  'function rounds(uint256) view returns(uint8 status,uint32 sold,uint64 fundingDeadline,uint64 drawDeadline,uint256 requestId,uint256 ticketWord,uint256 circuitWord,uint32 drawCursor,uint32 winningTicket,address winner)',
  'event SubscriptionConsumerAdded(uint256 indexed subId,address consumer)',
  'event ContainerSeriesAuthorized(address indexed container)', 'event RoundStarted(uint256 indexed roundId,uint64 fundingDeadline)',
]);

export function actionTransaction(action, execFeeWei = '0') {
  need(Object.hasOwn(START_ACTIONS, action), '请选择明确的配置步骤。');
  if (action === 'authorize') need(uint(execFeeWei).toString() === START_FIXED.execFeeWei, '容器执行协议费与已核实的 0.0002 BNB 不一致，已停止提交。');
  return action === 'consumer'
    ? { to: START_FIXED.coordinator, value: '0', data: START_ABI.encodeFunctionData('addConsumer', [START_FIXED.subscriptionId, START_FIXED.game]) }
    : { to: START_FIXED.authorizationContainer, value: uint(execFeeWei).toString(), data: START_ABI.encodeFunctionData('execute', [START_FIXED.game, 0n, START_ABI.encodeFunctionData('authorizeSeries'), 0]) };
}

export function assertSnapshot(snapshot) {
  const f = START_FIXED;
  need(snapshot && uint(snapshot.chainId) === 56n && isHash(snapshot.blockHash) && uint(snapshot.block) > 0n, '链或区块快照异常。');
  need(typeof snapshot.code === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(snapshot.code) && keccak256(snapshot.code) === f.runtimeHash, '测试合约运行代码不匹配，已停止配置。');
  need(String(snapshot.subscriptionId) === f.subscriptionId, '测试合约的 VRF 订阅不匹配。');
  need(snapshot.dependencyCodes?.length === 4 && snapshot.dependencyCodes.every(code => /^0x(?:[0-9a-f]{2})+$/i.test(code)), '链上依赖缺少合约代码。');
  need(snapshot.containerOpened === true && same(snapshot.containerAccount, f.authorizationContainer) &&
    String(snapshot.containerToken?.[0]) === '56' && same(snapshot.containerToken?.[1], f.processor) && String(snapshot.containerToken?.[2]) === '2075', '2075 容器归属核对失败。');
  need(getAddress(snapshot.containerOwner) && same(snapshot.containerOwner, snapshot.nftOwner), '容器持有人与电路持有人不一致。');
  need(getAddress(snapshot.subscriptionOwner) && Array.isArray(snapshot.consumers) && snapshot.consumers.every(address => getAddress(address)), 'VRF 订阅资料异常。');
  need(typeof snapshot.seriesAuthorized === 'boolean', '启动状态异常。');
  for (const name of ['execFeeWei', 'subscriptionNativeWei', 'containerNativeWei', 'currentRound']) uint(snapshot[name]);
  need(String(snapshot.execFeeWei) === f.execFeeWei, '容器执行协议费与已核实金额不一致，已停止配置。');
  return snapshot;
}

export function assertActionReady(action, snapshot, account) {
  assertSnapshot(snapshot);
  need(Object.hasOwn(START_ACTIONS, action), '配置步骤不正确。');
  const consumer = snapshot.consumers.some(address => same(address, START_FIXED.game));
  if (action === 'consumer') {
    need(!consumer, '此测试合约已经是 VRF 消费者，无需重复添加。');
    need(same(account, snapshot.subscriptionOwner), '请连接当前 VRF 订阅所有者钱包。');
  } else {
    need(consumer, '请先添加 VRF 消费者并确认上链。');
    need(uint(snapshot.subscriptionNativeWei) > 0n, 'VRF 订阅的 BNB 余额为 0，请先在 Chainlink 订阅页充值并重新核对。');
    need(!snapshot.seriesAuthorized, '测试场已授权启动，无需重复操作。');
    need(same(account, snapshot.containerOwner), '请连接当前 2075 电路容器的持有人钱包。');
    need(uint(snapshot.currentRound) === 1n && String(snapshot.round?.[0]) === '0', '测试场已不是待启动的第一期，已停止重复授权。');
  }
  return actionTransaction(action, snapshot.execFeeWei);
}

export function assertIntent(context, state, now = Date.now()) {
  const e = state.estimate;
  need(e && context.epoch === state.epoch && context.wallet === state.wallet && same(context.account, state.account) &&
    context.action === e.action && e.epoch === context.epoch && e.wallet === context.wallet && same(e.account, context.account) &&
    now >= e.createdAt && now < e.expiresAt && e.expiresAt - e.createdAt === 90000,
  '钱包、网络或核对结果已变化，请重新核对费用。');
  need(!state.records[context.action] && !state.storageError, '本步骤已有待核实交易或记录无法保存，请先核对交易。');
}

export function restoreRecord(row, action) {
  need(row?.schemaVersion === 1 && row.action === action && row.chainId === 56 && same(row.game, START_FIXED.game), '配置记录与当前测试场不符。');
  getAddress(row.account); uint(row.nonce); uint(row.value);
  const expected = actionTransaction(action, row.value);
  need(same(row.to, expected.to) && same(row.data, expected.data) && row.value === expected.value &&
    (row.hash == null || isHash(row.hash)) && Number.isFinite(Date.parse(row.createdAt)), '已有配置记录损坏，请保留记录并核实钱包交易。');
  return { schemaVersion: 1, action, chainId: 56, game: START_FIXED.game, account: row.account, nonce: uint(row.nonce).toString(),
    to: expected.to, data: expected.data, value: expected.value, hash: row.hash ?? null, createdAt: row.createdAt, status: 'unknown' };
}

export function assertTransaction(tx, record) {
  need(tx && isHash(tx.hash) && same(tx.from, record.account) && same(tx.to, record.to) && same(tx.input ?? tx.data, record.data) &&
    uint(tx.value) === uint(record.value) && uint(tx.nonce) === uint(record.nonce) && uint(tx.chainId) === 56n, '链上交易与本步骤的目标、金额、数据或钱包不一致。');
  if (record.hash) need(same(tx.hash, record.hash), '交易哈希不一致。');
  return tx;
}

export function assertReceipt(tx, receipt, block, tip) {
  need(receipt && same(receipt.transactionHash, tx.hash) && same(receipt.from, tx.from) && same(receipt.to, tx.to) &&
    same(receipt.blockHash, tx.blockHash) && same(receipt.blockHash, block?.hash) && uint(receipt.blockNumber) === uint(tx.blockNumber) &&
    uint(block.number) === uint(receipt.blockNumber) && block.transactions?.some(hash => same(hash, tx.hash)), '交易回执尚未通过主链核验。');
  need(uint(tip) >= uint(receipt.blockNumber) + 11n, '交易尚未达到 12 个区块确认，请稍后重新核对。');
  need(['0', '1'].includes(uint(receipt.status).toString()), '回执状态异常。');
  return uint(receipt.status) === 1n;
}

export function assertReceiptEvents(action, receipt) {
  need(Array.isArray(receipt.logs) && receipt.logs.length <= 1000, '回执事件格式异常。');
  const expectedAddress = action === 'consumer' ? START_FIXED.coordinator : START_FIXED.game;
  const parsed = [];
  for (const log of receipt.logs.filter(item => same(item.address, expectedAddress))) {
    need(!log.removed && same(log.transactionHash, receipt.transactionHash) && same(log.blockHash, receipt.blockHash) &&
      uint(log.blockNumber) === uint(receipt.blockNumber), '回执事件不属于已确认交易。');
    const event = START_ABI.parseLog(log); if (event) parsed.push(event);
  }
  if (action === 'consumer') need(parsed.filter(event => event.name === 'SubscriptionConsumerAdded' &&
    event.args.subId.toString() === START_FIXED.subscriptionId && same(event.args.consumer, START_FIXED.game)).length === 1, '缺少对应测试合约的消费者添加事件。');
  else need(action === 'authorize' && parsed.filter(event => event.name === 'ContainerSeriesAuthorized' && same(event.args.container, START_FIXED.authorizationContainer)).length === 1 &&
    parsed.filter(event => event.name === 'RoundStarted' && event.args.roundId === 1n && event.args.fundingDeadline > 0n).length === 1, '缺少对应容器授权与第一期启动事件。');
}
