# Rules layout and readable draw guide

Frontend-only update based on `15c506c`.

- Refund card directly follows the purchase card in the side column.
- Round rules move to a full-width row below the draw and side column, using an
  ordered three-item list. Existing rule content, language updates and element
  IDs for funding/refund text remain intact.
- Remove duplicate public-contract details from the four player tabs. Remove
  only their three DOM rendering statements; all verification and transaction
  logic is retained. The complete contract register remains in the draw guide.
- Draw guide now uses the supplied BEM banner and Tapeout·芯火夺宝 wordmark, dark
  slate text, 18px body copy, 16px metadata/hashes, larger headings, cards and form
  controls, and responsive mobile layout. Guide lookup code/data are unchanged.

Checks: build passed; default tests 84 passed / 0 failed / 1 upstream Unix-only
test skipped on Windows. Browser checks covered 50 Chinese/English tab/page and
viewport combinations, including the guide, with no horizontal overflow,
undersized functional text or page errors. Full-width rule geometry and refund
placement were checked. No real wallet or transaction was used for verification.

Publish to the repository first, then back up and replace only frontend sources,
index/burns/draw-guide HTML and additive hashed assets. Preserve old assets and
do not restart or reconfigure the site, keeper, Nginx, bot, credentials or storage.
