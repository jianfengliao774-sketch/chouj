# SparkDraw drand V5 — deployment prepared

The release contract is `TapeoutSparkDrawBSC`, built on `BemDrandRaffleCandidate`, with the shared `DrandEvmnetVerifier`. The live 1 BEM game and its pending Chainlink request are unchanged. No mainnet deployment, purchase, prize claim, refund or burn was sent while preparing this release; the designated wallet must sign deployment transactions.

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

Local Ganache fixtures, not mainnet transactions: 5,000 scattered selected tickets consumed 15,534,560 gas; 5,000 occupied choices with fallback consumed 8,151,794 gas. Two-round aggregate refund used 135,173 gas. Core runtime was 17,393 bytes; the bound release runtime is 17,708 bytes. These measurements are scenario-specific, not a guarantee for all transaction states.

`node scripts/check_drand_candidate_rpc.mjs` performed a read-only BNB mainnet code-override simulation using the real proof. It accepted the valid proof and rejected the wrong beacon round. Verification alone estimated 248,832 gas on that node; recording and settlement cost additional gas.

## Deployment and integration

- `/deploy-sparkdraw.html` prepares six wallet-signed creation transactions, keeps pending hashes locally and saves verified deployments to `BEM_DATA_DIR/sparkdraw-deployments-v5.json`. The server verifies the creator, exact creation bytecode and arguments, runtime and 12 confirmations. It never signs or sends transactions. Existing registrations cannot be silently overwritten.
- The bound release constructor requires chain 56 and deployer `0x7674fa446D42b1f7f150DC5e678cc525d275Ea53`; it pins official BEM, revenue container #13061, current NFT ownership, opener bindings, and exact verifier runtime. Deployment enables purchases, with the funding clock starting at each round's first purchase. No extra container activation transaction is required.
- The standard Solidity compiler input is published at `/sparkdraw/standard-input.json`. Source and exact artifacts are in this repository. Explorer source verification and deployed addresses require the actual deployment receipts.
- `node scripts/check_sparkdraw_deployment_rpc.mjs` simulated all six creations on BNB mainnet at block 120472684 using a temporary verifier override, without transactions. Estimated gas was 4,287,353 for the verifier and 4,398,830–4,399,028 per game. Total estimated cost at 0.05 gwei was about 0.0013141 BNB. Actual wallet fees may differ.
- After signed deployments, connect the new player ABI and ticket bitmaps to the permanent server event index. `sparkdraw-records.mjs` is an integration draft, not yet a live registered event source. Existing 1 BEM player transactions must not be relabelled as this new version.
- Refund countdowns are personal-only for the first 12 hours after the refund trigger. From trigger + 12 hours, publish unclaimed wallet addresses and ticket quantities, grouped by pool and round, with the remaining claim time. A confirmed claim removes that wallet from pending notices. At trigger + 24 hours the claim expires; show awaiting burn until a confirmed burn replaces the notice with a permanent public record. Public prize countdowns start immediately upon settlement. The live burn summary counts only registered, confirmed events and is refreshed every five minutes.
- A funded transaction sender or user transaction is needed to seal due rounds, relay the fixed beacon, settle, and burn expired claims. Solidity does not execute itself. No automatic drand keeper has been funded or enabled.
- Cross-contract aggregate claims are not implemented. `refundMany` aggregates rounds within one contract.

The vendored pairing library is pinned to the MIT-licensed upstream commit recorded in `vendor/provenance.json`. Its upstream repository describes it as experimental/unaudited and is archived. Passing these tests is not an independent security audit. Chain outages, withholding of the beacon, token-transfer failure and transaction inclusion delays cannot be eliminated by this design; deadlines prevent indefinite settlement entitlement but claiming still needs a successful chain transaction.
