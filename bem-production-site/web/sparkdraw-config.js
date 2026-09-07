export const SPARKDRAW = Object.freeze({
  chainId: 56,
  version: 'sparkdraw-drand-v1',
  deployer: '0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',
  bem: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  revenue: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  dead: '0x000000000000000000000000000000000000dEaD',
  beaconHash: '04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3',
  genesis: 1727521075, beaconPeriod: 3, beaconDelay: 60,
  fundingSeconds: 86400, drawSeconds: 86400, claimSeconds: 86400,
  maxPurchase: 5000, maxPerWallet: 5000, refundBatchLimit: 64,
  pools: { '0.1': { units:'10000000',burnPercent:4,test:true }, '5':{units:'500000000',burnPercent:3},
    '10':{units:'1000000000',burnPercent:4}, '50':{units:'5000000000',burnPercent:5}, '100':{units:'10000000000',burnPercent:6} }
});
