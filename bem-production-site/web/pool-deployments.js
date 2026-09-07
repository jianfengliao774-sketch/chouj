// Recovered from canonical BNB Chain creation transactions; never a launch flag.
// See outputs/bem-raffle-2075/production-v2/recovered-deployments-verified.json.
export const POOL_DEPLOYMENTS = Object.freeze(Object.fromEntries(Object.entries({
  "1": {
    "address": "0xE7D8dF903050d875f09cE1BBcE20E837fB55bC0c",
    "chainId": 56,
    "verified": true,
    "runtimeCodeHash": "0xef681f526023ed624835dd100d6178dfa4876c34763d7ed566727e791390f7bc",
    "transactionHash": "0x95f633f0d786425c59715a998df1cf28de04daea2fff5677420fcceb69e1f5da",
    "deploymentBlock": 120416308
  },
  "10": {
    "address": "0x3335ec04A7509aDE8E6C4Bc851fE409EE063a2bc",
    "chainId": 56,
    "verified": true,
    "runtimeCodeHash": "0x57bcf0f5d353139f0a2740bce7eca56b07295376708e5b802f646f8842600a48",
    "transactionHash": "0xa97bdb4425aaf234252191bdc53024476415e4e89835601261e8333d0687af8d",
    "deploymentBlock": 120416332
  },
  "50": {
    "address": "0x498ef8D499ca9940D3b3B1BBd31b2684AB35962B",
    "chainId": 56,
    "verified": true,
    "runtimeCodeHash": "0xfba76c308b208ad9f01088633cf39e6c014bbe14064ff82900c9abf0c68dccd0",
    "transactionHash": "0xbc69c6d437a2531df8c078c8ffcc0369f42ef2c7f512b43a83f1380df0dbd311",
    "deploymentBlock": 120416356
  },
  "100": {
    "address": "0x2009FDe00618C06Fa2e88bE6a2FA590941437f9D",
    "chainId": 56,
    "verified": true,
    "runtimeCodeHash": "0x35c99e0e5d8f3906e8a8e264fb017b8cfd4338e9a839f48ef7c0054f115121df",
    "transactionHash": "0x5667233b2e615395e1840c7e92b6c43742cc5ad240400709fc9c6c6f03ec403f",
    "deploymentBlock": 120416272
  }
}).map(([id, record]) => [id, Object.freeze(record)])));
