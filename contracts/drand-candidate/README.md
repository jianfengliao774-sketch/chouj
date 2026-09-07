# SparkDraw drand candidate — not deployed

This branch is an independent contract candidate. The live 1 BEM game and its pending Chainlink request are unchanged. No mainnet deployment, purchase, prize claim, refund or burn was sent while developing this candidate.

## Implemented in the candidate

- Public drand evmnet BN254 signature verification against its pinned public key and chain hash. A future beacon is fixed when the round seals, at least 60 seconds ahead. Anyone can submit that exact proof; no reseeding or operator-selected result.
- The beacon round, signature, randomness, circuit inputs/outputs, winning ticket and winner are queryable through contract getters and events.
- 0.1 BEM test (1% organizer + 4% burn), and 5 / 10 / 50 / 100 BEM denominations (1% organizer + 3 / 4 / 5 / 6% burn). Amounts use eight BEM decimals.
- 10,000 tickets, up to 5,000 per transaction and wallet per round. A partial fill charges only the actual allocation; excess BEM stays in the wallet. Occupied selected numbers fall back to available numbers.
- 9,500 sold starts one 30-minute closing window, capped by the initial 24-hour funding deadline. Full sale seals immediately. Anyone may close a due 95% round before the original funding deadline; an unsealed round reaching that deadline refunds.
- An unsealed round times out at funding start + 24 hours. A sealed but unsettled round times out at sealing + 24 hours, including a verified random result whose circuit settlement cannot complete.
- Every refund window lasts 24 hours from the fixed timeout, not from the time someone calls `openRefunds`. `refundMany` accumulates a wallet's purchases across up to 64 rounds of the same contract and makes one BEM transfer to that wallet.
- Settlement reserves the winner's prize for a 24-hour claim window. Expired unclaimed principal or prizes can be transferred to the dead address by a permissionless transaction. Other rounds' liabilities are preserved.

## Validation recorded on 2026-09-07

`node --test test/bem-drand-candidate.test.mjs test/bem-drand-refunds.test.mjs`

Real public drand proof used in local EVM tests; forged and wrong-round proofs rejected. Tests cover failed token transfers, delayed settlement, exact refund/prize claim boundaries, duplicate claims, multi-round principal aggregation and preservation of other rounds' balances.

Local Ganache fixtures, not mainnet transactions: 5,000 scattered selected tickets consumed 15,534,516 gas; 5,000 occupied choices with fallback consumed 8,151,750 gas. Two-round aggregate refund used 135,173 gas. Core runtime was 17,263 bytes. These measurements are scenario-specific, not a guarantee for all transaction states.

`node scripts/check_drand_candidate_rpc.mjs` performed a read-only BNB mainnet code-override simulation using the real proof. It accepted the valid proof and rejected the wrong beacon round. Verification alone estimated 248,832 gas on that node; recording and settlement cost additional gas.

## Integration still required before release

- Pin deployment artifacts and verify the actual verifier runtime, official BEM, deployer and revenue-container binding before registering new contracts. The base candidate currently starts funding on the first purchase; its authorization hooks are intentionally not a finished series wrapper.
- Connect the new ABI and ticket bitmaps to the deployment/test page and permanent server index. `sparkdraw-records.mjs` is an integration draft, not a live registered source.
- Personal-only pending refund countdowns; public pending prize countdowns; permanent public records after actual burns. The existing live burn summary counts only registered, confirmed events and is refreshed every five minutes.
- A funded transaction sender or user transaction is needed to seal due rounds, relay the fixed beacon, settle, and burn expired claims. Solidity does not execute itself. No automatic drand keeper has been funded or enabled.
- Cross-contract aggregate claims are not implemented. `refundMany` aggregates rounds within one contract.

The vendored pairing library is pinned to the MIT-licensed upstream commit recorded in `vendor/provenance.json`. Its upstream repository describes it as experimental/unaudited and is archived. Passing these tests is not an independent security audit. Chain outages, withholding of the beacon, token-transfer failure and transaction inclusion delays cannot be eliminated by this design; deadlines prevent indefinite settlement entitlement but claiming still needs a successful chain transaction.
