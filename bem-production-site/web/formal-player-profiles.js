import { getAddress } from 'ethers';

// Only independently verified V3 deployments may be registered in this build.
// Never populate this table from API responses, URLs, wallet storage or old V2 pools.
export const FORMAL_PLAYER_PROFILES = Object.freeze({});
const OLD_ADDRESSES = new Set([
  '0x3335ec04a7509ade8e6c4bc851fe409ee063a2bc',
  '0x498ef8d499ca9940d3b3b1bbd31b2684ab35962b',
  '0x2009fde00618c06fa2e88be6a2fa590941437f9d',
  '0xe7d8df903050d875f09ce1bbce20e837fb55bc0c',
  '0xbee0848d0c77d434a52d1d0236fcbfdca0834343',
]);
const FIXED = Object.freeze({
  chainId: 56n, contractVersion: 3, partialFill: true,
  bem: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  coordinator: '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9',
  subscriptionId: 77582411398321098948652233841078712279496169525251928512909841261362926957679n,
  container: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  authorizationNft: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
  authorizationTokenId: 13061n,
  processor: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
  recipient: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  gasCap: 16777216n,
});
export function getFormalPlayerProfile(poolId) {
  if (!['10', '50', '100'].includes(poolId)) return null;
  const deployment = FORMAL_PLAYER_PROFILES[poolId];
  if (!deployment) return null;
  const invalid = () => { const error = new Error('FORMAL_PROFILE_INVALID'); error.code = error.message; throw error; };
  if (deployment.contractVersion !== 3 || deployment.partialFill !== true ||
      !/^0x[0-9a-f]{64}$/i.test(deployment.runtimeHash) || !/^0x[0-9a-f]{64}$/i.test(deployment.deploymentHash) ||
      !Number.isSafeInteger(deployment.deploymentBlock) || deployment.deploymentBlock <= 0) invalid();
  let address; try { address = getAddress(deployment.address); } catch { invalid(); }
  if (OLD_ADDRESSES.has(address.toLowerCase()) || /^0x0{40}$/i.test(address)) invalid();
  return Object.freeze({ ...deployment, ...FIXED, poolId, address,
    pool: BigInt(poolId) * 100000000n, ticketPrice: BigInt(poolId) * 10000n });
}
