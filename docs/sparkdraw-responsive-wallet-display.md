# Responsive player and three-decimal wallet balances

Baseline: `a12f131` (the approved design already merged into main).

## Frontend-only changes

- Both wallet balances display exactly three decimals, rounded half up using
  integer arithmetic. Example: `BEM 35.869 · BNB 0.233`.
- The original full-precision values remain in the wallet balance title tooltip.
  The formatter is used only by this display node. No amount, approval, purchase,
  fee, allowance or balance-check calculation uses the rounded string.
- Keep the approved ivory/red/gold branding and large typography. Match the
  wallet picker, populated prize/refund/participation cards and countdowns.
- Prioritize personal participation before secondary contract details.
- Reflow query fields and five quick-pick buttons on small screens. Wrap long
  wallet addresses, including the connected-wallet label on the burn tab.

## Validation

- `pnpm run build` passed; `pnpm test`: 22 passed.
- Browser checks on the actual built app using a synthetic, authorized mock
  wallet and isolated API fixtures: 40 language/tab/viewport combinations passed
  (Chinese/English, draw/claims/burns/mine, 320/390/768/1024/1440 pixels).
- Populated records, countdowns, all five pools, 5,000-ticket auto/selected inputs,
  exact tooltip values and both rounded wallet labels were checked.
- No page exceptions, missing images or horizontal overflow. No real wallet
  credentials were used and no signing/transaction methods were requested.
- All non-SVG application IDs and the rest of the player runtime were compared
  with the baseline and preserved. Core modules and backend files are untouched.

## Publication boundary

The live site was still serving the pre-design build when this work began.
The project maintainer must publish the newly built frontend using the existing
deployment workflow. This change does not replace server credentials, restart
the backend, configure the keeper/vault, or deploy contracts. Source changes in
GitHub alone do not update the running website.
