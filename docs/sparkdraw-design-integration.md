# SparkDraw design integration

## Scope

Integrates the approved `codex/sparkdraw-design` work (`146d61e`) into the
current mainline application, initially `6105df4` and synchronized again with
`aca389f` (backend automation and replay fixes). The user explicitly requested that
the completed integration be merged into `main`.

- Preserve the ivory/vermilion/gold theme, chip/fire artwork and larger typography.
- Preserve the requested Chinese masthead, English branding, common 10,000-ticket
  pool heading, per-ticket price labels, round heading and multiline community copy.
- Adapt those display changes to the active `sparkdraw-player.js` and all five
  current pools. Do not reconnect the old `player-v2.js` entry point.
- Keep current drand verification, actual-receipt burn percentages, 5,000-ticket
  limits, prize claims, refunds, wallet restoration and transaction handlers.
- Move branding SVGs into Vite-managed `web/assets/`. The existing production
  server accepts the resulting hashed assets or inlined data URLs; no server
  route or security-policy change is required.
- Original legacy-player/selector/display changes were not carried into inactive
  modules. Their mainline versions remain unchanged.

All non-SVG application element IDs are preserved. The change does not touch
contracts, ABI, addresses, profiles, fee calculations, transaction modules,
backend APIs, deployment configuration, or credentials. Local preview tools,
screenshots and Telegram avatars are not included. No production deployment
or mainnet transaction was performed.

## Verification

- `pnpm run build`: passed.
- `pnpm test`: 19 tests passed, including all 15 current production tests and
  4 design regressions now included in the default test command.
- `node --test test/bem-sparkdraw-design.test.mjs`: 4 design regression tests passed.
- Browser verification on the actual production build with isolated synthetic API
  fixtures: five pools, both languages, four tabs and five widths (320, 390, 768,
  1024, 1440): 40 layout combinations passed, no horizontal overflow, no page
  exceptions or failed asset requests. Functional visible text was at least 16px.
- Checked `?pool=0.1#mine`, direct `/burns.html`, language switching, 5,000-ticket
  auto/selected inputs, wallet chooser, actual pool prices and percentage-driven
  copy. The browser sent no transactions or RPC calls.
- Compared the active player to the baseline: runtime code outside community
  text, round label and selector markup is byte-for-byte unchanged after newline
  normalization. The selector's original click handler is also unchanged.
- The latest upstream automation, vault, wallet and replay implementations were
  retained without modification. The net diff against `aca389f` remains only
  presentation files, design tests, their test-command registration and this note.

## Existing legacy-suite failures

`pnpm run test:player-update` reports **84 passed / 16 failed** on both the
unmodified `6105df4` baseline and this integration, with the same failing tests:

- Legacy admin tests import the removed `createProductionServer` export.
- Legacy V2 UI tests expect `public-records.js` plus `player-v2.js`, while current
  main uses `sparkdraw-player.js`.

These are pre-existing mainline/test migration issues, not new integration
failures. The suite was not weakened, skipped or rewritten to hide them.
