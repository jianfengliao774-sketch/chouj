import {SPARKDRAW as F} from './sparkdraw-config.js';
export const VERIFIER='0x354957617B115a90AD57482f56DaeEb922AE572D';
export const VERIFIER_HASH='0x82e55440d6d8456fd43c1ff3a324cce31d9306d4bfb276d6797a5d89c3c50d6d';
export const POOL_IDS=Object.freeze(['0.1','5','10','50','100']);
export const POOLS=Object.freeze(Object.fromEntries(Object.entries({
  "5": {
    "address": "0x2d61aE0A679388D3414c0d8cDB605C273b7e548a",
    "runtimeHash": "0x7160664d85980b5fe60391ef9346d6849333ae8b360bb92fa036b54b8b198cda",
    "deploymentBlock": 120475574
  },
  "10": {
    "address": "0x2Fc027fD10CE16C140A499074C688BAeC1c651E6",
    "runtimeHash": "0x71b311e039923242c7f0e43241a95f3b360c780a0b606ea886de3189df34b787",
    "deploymentBlock": 120475601
  },
  "50": {
    "address": "0x44dCA1ed1305A3cBF8b06d4eF660db26Ff6F27EB",
    "runtimeHash": "0xa5e34f2285d4f354b5d9859486733184f7d9b8b6728a33f9676b41a9cfde2a2c",
    "deploymentBlock": 120475633
  },
  "100": {
    "address": "0xa303C5a194Df3B7FfA86E175a2cD65ad5098fB27",
    "runtimeHash": "0xb4faf3413a1269336e60bda76faf270bf5ca86ddce2d8ae18a8b61b692c21a2f",
    "deploymentBlock": 120475661
  },
  "0.1": {
    "address": "0x9036CA1F0d7cBf3EF1E2E79DE869a2e204150aBb",
    "runtimeHash": "0x5554c683821e8a0147f6571989b86257dcce45dc33d44e006f51a4b3b59d5ce7",
    "deploymentBlock": 120475547
  }
}).map(([id,p])=>[id,Object.freeze({...p,id,...F.pools[id],ticketPrice:BigInt(F.pools[id].units)/10000n})])));
export function profile(id){if(!Object.hasOwn(POOLS,id))throw Error('Unknown SparkDraw pool');return POOLS[id];}
