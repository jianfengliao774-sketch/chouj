# SparkDraw deployment and purchase fee budget

Verified on BNB mainnet on 2026-09-07. The receipt, creation input, creator, runtime code and fixed pool/verifier/revenue getters were checked by `scripts/verify_sparkdraw_deployments.mjs`. Public evidence: `bem-production-site/web/public/sparkdraw/deployed-contracts.json`.

| Contract | Address |
| --- | --- |
| Shared drand verifier | `0x354957617B115a90AD57482f56DaeEb922AE572D` |
| 0.1 BEM test | `0x9036CA1F0d7cBf3EF1E2E79DE869a2e204150aBb` |
| 5 BEM | `0x2d61aE0A679388D3414c0d8cDB605C273b7e548a` |
| 10 BEM | `0x2Fc027fD10CE16C140A499074C688BAeC1c651E6` |
| 50 BEM | `0x44dCA1ed1305A3cBF8b06d4eF660db26Ff6F27EB` |
| 100 BEM | `0xa303C5a194Df3B7FfA86E175a2cD65ad5098fB27` |

All five pools were round 1, unstarted, zero sold at verification. First purchase starts funding. The V5 website adapter and persisted event index now use only these five pools. Legacy game URLs redirect to the 0.1 BEM pool, and the active RPC gateway rejects legacy game targets. Historical onchain contracts and server archives remain intact. A background transaction signer is **not configured**: closing, proof submission, settlement and expiry processing are available as public wallet-signed actions. Do not describe background execution as enabled.

## Website fee budget

The user requested an appropriate ceiling after initially suggesting 0.00005 BNB. The selected ceiling is **0.001 BNB per purchase transaction**. Each approval also has that ceiling independently; approval and purchase are two transactions when allowance is insufficient.

`purchase-gas-policy.js` checks the full requested gas allowance multiplied by the current RPC gas price before creating a pending intent or requesting a wallet transaction. It rejects excessive fees without lowering the estimated gas requirement, splitting the order or resubmitting. The existing 20% execution buffer and network gas ceiling remain. Refund and settlement transactions are outside this purchase budget.

Evidence: `node --test test/bem-drand-refunds.test.mjs` measured 15,534,560 gas for 5,000 scattered choices, and 8,151,794 gas for 5,000 occupied choices with fallback. These are local simulations using mock token/circuit dependencies, not a mainnet fee guarantee. At the independently queried 50,000,000 wei gas price (0.05 Gwei), they imply 0.000776728 and 0.0004075897 BNB respectively. The 16,777,216 network gas ceiling at that price implies at most 0.0008388608 BNB before wallet changes. This supports a 0.001 BNB budget with current prices; higher network prices may trigger a rejection.

The active V5 transaction adapter calls this policy after estimation and before wallet submission. This is a website transaction budget, not an onchain rule. Wallet edits, smart-account wrapping and transactions created by other clients can change the actual envelope and fee. Display the final wallet fee for confirmation.

V5 checks: `npm test` covers the active service, transaction adapter, refund notices and fee budget. `npm run test:sparkdraw` covers the contract lifecycle and deployment. The built player was also checked in an isolated browser with a synthetic wallet, including automatic wallet queries, prize claims to the winner, English text and mobile layout. No mainnet purchase or claim was sent by these tests.

The winning-records page provides prize claims, and the burn page automatically loads connected-wallet claims and confirmed burned balances. Public copy describes drand verification and sold-ticket-only selection. The event index saves confirmed logs under `BEM_DATA_DIR`, in separate V5 files; the burn total refreshes every five minutes.

Repository check also found collaborator branch `codex/sparkdraw-design` at `146d61e`. Its page redesign was not merged into this mechanism change.
