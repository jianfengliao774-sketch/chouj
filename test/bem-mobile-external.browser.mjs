// Run after building. Isolated Chromium with mobile browser identities and
// mocked native wallet bridges; this is not a physical iOS/WebKit certification.
// Every request is intercepted. App links are inspected and prevented from
// navigating, and no real account, permission, signature or transaction is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GAME, TOKEN } from '../bem-production-site/web/sparkdraw-transactions.js';
import { profile } from '../bem-production-site/web/sparkdraw-profiles.js';
import { SPARKDRAW as F } from '../bem-production-site/web/sparkdraw-config.js';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine=process.env.BROWSER_ENGINE||'chromium',browserType=playwright[engine];
assert.ok(['chromium','webkit'].includes(engine));
const origin = 'https://127.0.0.1:18797', dist = path.resolve('bem-production-site/dist');
const account = '0x1111111111111111111111111111111111111111';
const nextAccount = '0x2222222222222222222222222222222222222222';
const identities = {
  android: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' },
  iphoneChrome: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1', platform: 'iPhone' },
  iphoneSafari: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', platform: 'iPhone' },
  ipadDesktop: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', platform: 'MacIntel' },
};
const scenarios = [
  { name: 'Android Chrome without provider offers app links and copy choices', identity: 'android' },
  { name: 'iPhone Chrome without provider preserves pool and count', identity: 'iphoneChrome' },
  { name: 'iPhone Safari without provider preserves pool and count', identity: 'iphoneSafari' },
  { name: 'iPad desktop browser identity remains a mobile wallet flow', identity: 'ipadDesktop' },
  { name: 'external browser retains manual ticket selection in public URL', identity: 'android', manual: true },
  { name: 'late native injection replaces app link with exact provider connection', identity: 'iphoneChrome', lateProvider: true },
  { name: 'blocked localStorage getter keeps page and wallet choices usable', identity: 'iphoneSafari', storage: 'denied' },
  { name: 'full localStorage keeps page and mock connection usable', identity: 'android', storage: 'quota', lateProvider: true },
  { name: 'clipboard refusal leaves a selectable public wallet URL', identity: 'iphoneSafari', clipboard: 'denied' },
  { name: 'older WebView without native dialog opens and closes with Escape', identity: 'android', legacyDialog: true },
  { name: 'resume reconciles silent account change without connecting again', identity: 'iphoneChrome', lateProvider: true, resume: true },
  { name: 'native wallet disconnect clears stale connected state', identity: 'android', lateProvider: true, disconnect: true },
].filter(scenario => !process.env.SCENARIO_FILTER || scenario.name.includes(process.env.SCENARIO_FILTER));

const browser = await browserType.launch({headless:true,...(engine==='chromium'?{args:['--disable-gpu'],...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})}:{})});
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/drand/deployed-five-runtime.json', import.meta.url)));
try {
  for (const scenario of scenarios) {
    const identity = identities[scenario.identity], errors = [], networkErrors = [], externalAttempts = [];
    const context = await browser.newContext({ userAgent: identity.userAgent, viewport: { width: 390, height: 844 },
      isMobile: scenario.identity !== 'ipadDesktop', hasTouch: true, serviceWorkers: 'block' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(7000);
    await page.addInitScript(({ account, nextAccount, identity, scenario }) => {
      Object.defineProperty(navigator, 'platform', { get: () => identity.platform });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
      // iPad's desktop identity must work without userAgentData.mobile helping it.
      Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
      if (scenario.storage === 'denied') Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('Fixture blocks storage access', 'SecurityError'); },
      });
      if (scenario.storage === 'quota') Storage.prototype.setItem = function() { throw new DOMException('Fixture storage quota full', 'QuotaExceededError'); };
      if (scenario.legacyDialog) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: undefined, configurable: true });
        Object.defineProperty(HTMLDialogElement.prototype, 'close', { value: undefined, configurable: true });
      }
      window.__copied = []; window.__appClicks = []; window.__walletRequests = [];
      Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) {
        if (scenario.clipboard === 'denied') throw new DOMException('Fixture clipboard denied', 'NotAllowedError');
        window.__copied.push(value);
      } }, configurable: true });
      document.addEventListener('click', event => {
        const anchor = event.target.closest?.('#wallet-options a[href]');
        if (!anchor) return;
        // The card's own handler runs first. Keep its final native href while
        // preventing the OS, a popup, or any remote page from actually opening.
        event.preventDefault(); window.__appClicks.push({ href: anchor.href, trusted: event.isTrusted });
      });
      let authorized = false, currentAccount = account; const listeners = {};
      const provider = { isMetaMask: true, on(name, callback) { (listeners[name] ??= []).push(callback); },
        async request({ method, params }) {
          window.__walletRequests.push({ method, params });
          if (method === 'eth_requestAccounts') { authorized = true; return [currentAccount]; }
          if (method === 'eth_accounts') return authorized ? [currentAccount] : [];
          if (method === 'eth_chainId') return '0x38';
          if (method === 'eth_getTransactionCount') return '0x1';
          throw Error('External browser fixture must not request a transaction or signature: ' + method);
        },
      };
      window.__installWallet = () => { window.ethereum = provider; window.dispatchEvent(new Event('ethereum#initialized')); };
      window.__resumeWithChangedAccount = () => { currentAccount = nextAccount; window.dispatchEvent(new Event('focus')); };
      window.__disconnectWallet = () => { authorized = false; for (const listener of listeners.disconnect || []) listener({ code: 4900, message: 'Fixture native bridge disconnected' }); };
    }, { account, nextAccount, identity, scenario });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { externalAttempts.push(request.url()); return route.abort('blockedbyclient'); }
      const reply = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      try {
        if (url.pathname === '/rpc') {
          const input = request.postDataJSON(), rows = Array.isArray(input) ? input : [input];
          const result = rows.map(row => {
            let value;
            if (row.method === 'eth_call') {
              const tx = row.params[0], iface = tx.to.toLowerCase() === F.bem.toLowerCase() ? TOKEN : GAME;
              const call = iface.parseTransaction(tx), values = { currentRoundId: [1], rounds: [0, 0, 0, 0, 0, 0, 0, 0, 0, '0x' + '0'.repeat(40)],
                ticketsOf: [0], ticketWords: [Array(556).fill(0)], balanceOf: [10000000000n], allowance: [10000000000n] };
              assert.ok(values[call.name], 'Unexpected mock call: ' + call.name); value = iface.encodeFunctionResult(call.fragment, values[call.name]);
            } else if (row.method === 'eth_getCode') value = fixture.code;
            else if (row.method === 'eth_estimateGas') value = '0xb71b00';
            else if (row.method === 'eth_gasPrice') value = '0x2faf080';
            else if (row.method === 'eth_blockNumber') value = '0x100';
            else if (row.method === 'eth_getBalance') value = '0xde0b6b3a7640000';
            else throw Error('Unexpected RPC method: ' + row.method);
            return { jsonrpc: '2.0', id: row.id, result: value };
          });
          return reply(Array.isArray(input) ? result : result[0]);
        }
        if (url.pathname === '/api/sparkdraw/state') return reply({ version: 5, address: profile(url.searchParams.get('pool') || '5').address,
          currentRoundId: '1', time: Math.floor(Date.now() / 1000), rounds: [{ roundId: '1', status: 0, sold: 0 }], keeper: {} });
        if (url.pathname === '/api/sparkdraw/records') return reply({ rows: [], claims: [], total: 0, page: 1, totalPages: 1 });
        if (url.pathname === '/api/burns/summary') return reply({ totalBaseUnits: '0', updatedAt: new Date().toISOString() });
        if (url.pathname === '/api/market') return reply({});
        const file = path.resolve(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        assert.ok(file.startsWith(dist + path.sep));
        try { return await route.fulfill({ status: 200, path: file, contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] }); }
        catch { return route.fulfill({ status: 404, body: '' }); }
      } catch (error) { networkErrors.push(error.message); return route.fulfill({ status: 500, body: 'Fixture rejected unexpected request' }); }
    });
    try {
      await page.goto(origin + '/?pool=10&count=3000&untrusted=discard-me#draw');
      await page.waitForFunction(() => document.getElementById('purchase-limit').textContent.includes('5,000'));
      assert.equal(await page.locator('#ticket-count').inputValue(), '3000', 'Opening a wallet URL preserves the selected count');
      if (scenario.manual) { await page.locator('#mode-selected').click(); await page.locator('#selected-tickets').fill('1-1000,2000'); }
      await page.locator('#connect-wallet').click();
      await page.waitForFunction(() => document.getElementById('wallet-picker').open);
      const cards = page.locator('#wallet-options .wallet-option'); assert.equal(await cards.count(), 7);
      const choices = await cards.evaluateAll(nodes => nodes.map(node => ({ name: node.querySelector('strong').textContent,
        status: node.querySelector('small').textContent, tag: node.tagName, disabled: !!node.disabled, href: node.getAttribute('href') })));
      assert.ok(choices.every(choice => !choice.disabled), 'External mobile wallet choices must be actionable');
      assert.ok(choices.every(choice => /在 App 中打开|复制网址到钱包/.test(choice.status)));
      const publicUrl = new URL(await page.locator('#wallet-page-url').inputValue());
      assert.equal(publicUrl.origin, origin); assert.equal(publicUrl.searchParams.get('pool'), '10');
      assert.equal(publicUrl.searchParams.has('untrusted'), false); assert.equal(publicUrl.hash, '');
      if (scenario.manual) { assert.equal(publicUrl.searchParams.get('mode'), 'selected'); assert.equal(publicUrl.searchParams.get('tickets'), '1-1000,2000'); }
      else assert.equal(publicUrl.searchParams.get('count'), '3000');
      const meta = choices.find(choice => choice.name === 'MetaMask');
      assert.equal(meta.tag, 'A'); assert.match(meta.href, /^https:\/\/(?:link\.metamask\.io|metamask\.app\.link)\/dapp\//);
      for (const choice of choices.filter(choice => choice.tag === 'A')) {
        assert.ok(!/^(?:javascript|data):/i.test(choice.href), 'App navigation uses a native URL');
        await cards.filter({ has: page.locator('strong', { hasText: new RegExp('^' + choice.name + '$') }) }).click();
      }
      const clicks = await page.evaluate(() => window.__appClicks);
      assert.equal(clicks.length, choices.filter(choice => choice.tag === 'A').length);
      assert.ok(clicks.every(click => click.trusted)); assert.equal(page.url(), origin + '/?pool=10&count=3000&untrusted=discard-me#draw');
      const copyChoice = choices.find(choice => choice.tag === 'BUTTON');
      if (copyChoice) { await cards.filter({ has: page.locator('strong', { hasText: new RegExp('^' + copyChoice.name + '$') }) }).click(); assert.match(await page.locator('#wallet-picker-hint').textContent(), /粘贴|复制/); }
      await page.locator('#wallet-copy-url').click();
      if (scenario.clipboard === 'denied') {
        assert.match(await page.locator('#wallet-picker-hint').textContent(), /选中|复制/);
        const selection = await page.locator('#wallet-page-url').evaluate(input => [input.selectionStart, input.selectionEnd, input.value.length]);
        assert.deepEqual(selection, [0, publicUrl.href.length, publicUrl.href.length]);
      } else assert.equal((await page.evaluate(() => window.__copied)).at(-1), publicUrl.href);
      assert.equal(await page.evaluate(() => window.__walletRequests.length), 0, 'External choices do not invoke a wallet provider');
      if (scenario.legacyDialog) {
        assert.equal(await page.locator('#wallet-picker').getAttribute('data-compat-dialog'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#wallet-picker').evaluate(dialog => dialog.open), false);
        assert.equal(await page.locator('.dialog-compat-backdrop').count(), 0);
        assert.equal(await page.locator('body').evaluate(body => body.classList.contains('wallet-picker-open')), false);
        await page.locator('#connect-wallet').click(); await page.locator('#wallet-picker-close').click();
      }
      if (scenario.lateProvider) {
        await page.evaluate(() => window.__installWallet());
        const connect = page.locator('#wallet-options button').filter({ has: page.locator('strong', { hasText: /^MetaMask$/ }) });
        await connect.waitFor({ state: 'visible' }); assert.equal(await connect.isDisabled(), false);
        assert.match(await connect.textContent(), /已检测到.*点击连接/);
        assert.equal(await page.locator('#wallet-options a').count(), 0, 'Injected wallets use the current browser bridge');
        await connect.click();
        await page.waitForFunction(account => document.getElementById('wallet-address').textContent === account, account);
        assert.equal(await page.evaluate(() => window.__walletRequests.filter(row => row.method === 'eth_requestAccounts').length), 1);
        if (scenario.resume) {
          await page.evaluate(() => window.__resumeWithChangedAccount());
          await page.waitForFunction(account => document.getElementById('wallet-address').textContent === account, nextAccount);
          assert.equal(await page.evaluate(() => window.__walletRequests.filter(row => row.method === 'eth_requestAccounts').length), 1);
        }
        if (scenario.disconnect) {
          await page.evaluate(() => window.__disconnectWallet());
          await page.waitForFunction(() => document.getElementById('wallet-address').textContent === '');
          assert.match(await page.locator('#connect-wallet').textContent(), /连接钱包/);
        }
      }
      assert.deepEqual(errors, []); assert.deepEqual(networkErrors, []); assert.deepEqual(externalAttempts, []);
      assert.equal(await page.evaluate(() => window.__walletRequests.some(row => /sign|sendTransaction|requestPermissions/.test(row.method))), false);
      console.log(JSON.stringify({ scenario: scenario.name, engine, identity: scenario.identity,
        appLinksInspected: clicks.length, publicSelectionUrl: publicUrl.href, passed: true }));
    } finally { await context.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); }
  }
} finally { await browser.close(); }
