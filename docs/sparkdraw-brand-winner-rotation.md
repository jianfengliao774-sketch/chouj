# Branding and latest-winner carousel

Baseline: `4f69de0`, synchronized with `a122dd7` while the owner launched the
three formal pools. The launch policy, historical claim support and all core
transaction behavior are retained.

## Presentation changes

- Use the two user-supplied PNGs without pixel edits: banner/chip artwork in the
  masthead, BEM emblem in the hero. Chinese masthead: Tapeout·芯火夺宝; English:
  Tapeout · SparkDraw. Larger and heavier branding and English caption.
- Dark slate body/secondary text, contrasting red values, cream text in the red
  draw panel. Larger draw copy, centered payout cards, aligned desktop card bottoms.
- USDT and BNB estimates are two separate inline rows; remove the unit-rate row
  from display and stop creating the external exchange-pair links.
- Purchase card displays the selected pool's current round label. Three separate
  numbered reminder paragraphs preserve the user's requested wording. No limit
  or early-draw computation is changed.
- Refund heading/copy simplified. The existing selected-pool automatic refund
  lookup, batch and claim recipient are unchanged.
- Remove reveal-cadence prose; confirmed digits settle at 3/6/9/12/15 seconds.

## Winner announcements

Each visible formal pool is queried independently through the existing read-only
winner endpoint, so a busy pool's recent records cannot crowd out another pool.
Choose only its newest valid settled record, then rotate one record every 10
seconds. The format includes pool, canonical round ID, one-based five-digit
winning number and the full wallet address. No-winner pools are skipped; failed
reads retain the last confirmed record. Identical polling responses do not reset
the timer. Pause/resume and page visibility preserve user control.

The current upstream sales policy exposes 5/10/50 BEM. This UI follows that
policy instead of restoring test entries or enabling closed purchases. The user's
0.1 BEM announcement was treated as a formatting example, not hardcoded live data.

## Verification and deployment

- Default tests: 82 passed, one existing Unix-permission test skipped on Windows,
  zero failures. Includes timer, latest-per-pool filtering, copy, price, original
  transaction, recovery, refund and launch-policy tests.
- Actual built frontend with isolated fixtures: 40 bilingual/tab/viewport
  combinations, loaded images, aligned desktop cards, three-formal-pool prices,
  5000-ticket input, ticker rotation and 3-second reel timings checked.
- Source comparison excludes only the specified display code and read-only ticker
  refresh; financial handlers and core modules remain unchanged.
- Publish repository changes first. Before live replacement, back up the active
  static frontend and affected source, verify source/core hashes, add new hashed
  assets and replace entry HTML last. Retain old assets; do not restart website,
  Nginx, keeper or bot services, and do not touch credentials or stored state.
