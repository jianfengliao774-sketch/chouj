# Draw-page presentation refresh

Baseline: `a05a54c`, verified against the active 111-P frontend source before editing.

## Requested presentation changes

- Hide the deployment/network banner and browser-URL copy button; keep internal
  element hooks intact. Move the existing live clock to the masthead.
- Remove the wallet eyebrow, enlarge connection status and wallet address,
  add an explicit address-copy action and localize the holdings label.
- Use the requested common pool heading. Preserve all five pools and exact prices.
- Enlarge the chip artwork beside the title, put the Tapeout community link below
  that pair, and widen the prize card. The link opens https://tapeout.net/# safely.
- Enlarge reel digits, draw copy and the progress bar. Adapt the layout down to
  320px rather than hiding content or reducing all body text.
- Reveal only the existing confirmed result: each reel finishes after 5, 10, 15,
  20 and 25 seconds. Polls do not restart it; stale animations cannot replace a
  newer round. Reduced-motion preferences still skip automatic motion. Claims
  and onchain results remain available independently of the decorative reveal.
- Chinese timestamps use Beijing/UTC+8; English uses UTC+0. Keep canonical UTC
  round identifiers unchanged. Market timestamps are converted from milliseconds
  to ISO input before passing to the existing seconds/ISO formatting helper.

## Checks

- Build passes. Default suite: 61 tests pass, including sequential reveal timing,
  wallet-copy success/failure, hidden controls, market-time formatting and the
  existing recovery, claim, automation and contract-parameter tests.
- Actual built UI checked with a synthetic wallet and isolated read-only API
  fixtures in America/Los_Angeles: 40 language/tab/viewport combinations, no
  overflow, missing resources or page errors. All five prices and 5,000-ticket
  inputs preserved. Clipboard only writes on the explicit copy-button click.
- Real browser animation durations checked at 5-second increments; first-to-last
  completion and availability of the claim button verified independently.
- Core player code outside the display label, copy handler, selector wording and
  reel animation was compared with the baseline. No transaction, backend,
  contract, ABI, address, fee, storage or refund-flow code was modified.

## Publication boundary

111-P backup: `/srv/crowdfund/backups/frontend-111-P-20260907T125357Z/` contains
the previous complete dist and the affected frontend source files with checksums.
Publish only index/burns entry pages, their new hashed assets and the four edited
frontend source files. Keep old hashed assets for open browser sessions; do not
replace admin/deployment pages, switch the application release symlink, restart
services, or touch bot, executor/vault or database state.
