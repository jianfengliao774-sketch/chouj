// A pool becomes live only after its user-signed deployment has been independently
// verified and a reviewed release registers it. The V1 address is never a V2 pool.
import { BEM, PROCESSOR, CONTAINER, COORDINATOR, SUBSCRIPTION } from './config.mjs';

export const REVENUE_CONTAINER = '0x001f110422F04a90bF7D6eC96714f75046BD7126';
export function poolRegistry() {
  return { schemaVersion: 2, chainId: 56, bemAddress: BEM, bemDecimals: 8,
    processorAddress: PROCESSOR, circuitId: 2075, containerAddress: REVENUE_CONTAINER,
    authorizationContainer: CONTAINER, coordinatorAddress: COORDINATOR, subscriptionId: SUBSCRIPTION,
    pools: [1, 10, 50, 100].map(value => {
      const pool = BigInt(value) * 100000000n;
      return { id: String(value), poolBaseUnits: String(pool), ticketPriceBaseUnits: String(pool / 10000n),
        ticketsPerRound: 10000, maxTicketsPerPurchase: 1000, maxTicketsPerAddress: 5000,
        blackholeBaseUnits: String(pool * 4n / 100n), organizerBaseUnits: String(pool / 100n),
        winnerBaseUnits: String(pool * 95n / 100n), fundingWindowSeconds: 86400,
        refundClaimWindowSeconds: 86400, testOnly: value === 1, deployment: null, salesEnabled: false };
    }) };
}
