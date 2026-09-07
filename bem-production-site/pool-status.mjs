import { Interface, keccak256 } from 'ethers';
import { POOL_DEPLOYMENTS } from './web/pool-deployments.js';
import { CONTAINER, COORDINATOR, SUBSCRIPTION } from './config.mjs';

const gameAbi = new Interface([
  'function seriesAuthorized() view returns(bool)',
  'function currentRoundId() view returns(uint256)',
  'function nextRoundOpensAt() view returns(uint64)',
  'function totalLiability() view returns(uint256)',
  'function rounds(uint256) view returns(uint8 status,uint32 sold,uint64 fundingDeadline,uint64 drawDeadline,uint256 requestId,uint256 ticketWord,uint256 circuitWord,uint32 drawCursor,uint32 winningTicket,address winner)'
]);
const externalAbi = new Interface([
  'function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)',
  'function owner() view returns(address)', 'function EXEC_FEE() view returns(uint256)'
]);

/** A fresh read of deployment and launch state. Registration never enables payments. */
export function createPoolStatusReader({ rpc }) {
  const cache = new Map(), pending = new Map();
  return async function readPoolStatus(id) {
    if (!Object.hasOwn(POOL_DEPLOYMENTS, id)) throw new Error('Unknown pool');
    const previous = cache.get(id);
    if (previous && Date.now() - previous.at < 5000) return previous.value;
    if (pending.has(id)) return pending.get(id);
    const job = (async () => {
      const deployment = POOL_DEPLOYMENTS[id];
      const block = await rpc('eth_getBlockByNumber', ['latest', false]);
      const call = async (to, abi, fn, args = []) => abi.decodeFunctionResult(fn,
        await rpc('eth_call', [{ to, data: abi.encodeFunctionData(fn, args) }, block.number]));
      const [chain, code, authorized, roundId, next, liability, sub, owner, fee, native] = await Promise.all([
        rpc('eth_chainId', []), rpc('eth_getCode', [deployment.address, block.number]),
        call(deployment.address, gameAbi, 'seriesAuthorized'), call(deployment.address, gameAbi, 'currentRoundId'),
        call(deployment.address, gameAbi, 'nextRoundOpensAt'), call(deployment.address, gameAbi, 'totalLiability'),
        call(COORDINATOR, externalAbi, 'getSubscription', [SUBSCRIPTION]),
        call(CONTAINER, externalAbi, 'owner'), call(CONTAINER, externalAbi, 'EXEC_FEE'),
        rpc('eth_getBalance', [CONTAINER, block.number])
      ]);
      if (BigInt(chain) !== 56n || keccak256(code) !== deployment.runtimeCodeHash) throw new Error('Pool code or chain mismatch');
      const currentRound = await call(deployment.address, gameAbi, 'rounds', [roundId[0]]);
      const previousRound = roundId[0] > 1n ? await call(deployment.address, gameAbi, 'rounds', [roundId[0] - 1n]) : null;
      const canonical = await rpc('eth_getBlockByNumber', [block.number, false]);
      if (canonical.hash !== block.hash) throw new Error('Pool snapshot changed');
      const consumerAuthorized = sub.consumers.some(a => a.toLowerCase() === deployment.address.toLowerCase());
      const value = { schemaVersion: 2, poolId: id, chainId: 56, gameAddress: deployment.address,
        deployment, runtimeVerified: true, salesEnabled: id === '1' && authorized[0] && consumerAuthorized && sub.nativeBalance > 0n, testRequested: id === '1',
        snapshot: { blockNumber: Number(BigInt(block.number)), blockHash: block.hash,
          timeUtc: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() },
        seriesAuthorized: authorized[0], currentRoundId: roundId[0].toString(), nextRoundOpensAt: next[0].toString(),
        totalLiability: liability[0].toString(), currentRound: currentRound.toObject(), previousRound: previousRound?.toObject() ?? null,
        vrf: { subscriptionId: SUBSCRIPTION, owner: sub.owner, consumerAuthorized,
          consumers: [...sub.consumers], nativeBalanceWei: sub.nativeBalance.toString(), requestCount: sub.reqCount.toString() },
        container: { address: CONTAINER, owner: owner[0], execFeeWei: fee[0].toString(), nativeBalanceWei: BigInt(native).toString() },
        launchState: !consumerAuthorized ? 'needs_vrf_consumer' : !authorized[0] ? 'needs_container_authorization' : 'configured',
        keeper: { configured: false, serviceRunning: false }
      };
      cache.set(id, { at: Date.now(), value }); return value;
    })().finally(() => pending.delete(id));
    pending.set(id, job); return job;
  };
}
