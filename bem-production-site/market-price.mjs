import assert from 'node:assert/strict';
import { getAddress } from 'ethers';

export const MARKET_TOKEN = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a';
export const MARKET_QUOTES = Object.freeze({
  usdt: '0x55d398326f99059fF775485246999027B3197955',
  bnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
});
export const MARKET_ENDPOINT = `https://api.dexscreener.com/token-pairs/v1/bsc/${MARKET_TOKEN}`;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const MAX_LIQUIDITY_USD = 1_000_000_000_000;
const sameAddress = (a, b) => typeof a === 'string' && ADDRESS.test(a) && a.toLowerCase() === b.toLowerCase();

function selectPairs(rows, minLiquidityUsd) {
  assert.ok(Array.isArray(rows) && rows.length <= 1000, 'Invalid market response');
  const best = { usdt: null, bnb: null };
  for (const row of rows) {
    if (!row || row.chainId !== 'bsc' || !sameAddress(row.baseToken?.address, MARKET_TOKEN) ||
      typeof row.pairAddress !== 'string' || !ADDRESS.test(row.pairAddress) || /^0x0{40}$/i.test(row.pairAddress)) continue;
    const quote = Object.keys(MARKET_QUOTES).find(key => sameAddress(row.quoteToken?.address, MARKET_QUOTES[key]));
    if (!quote) continue;
    const liquidity = row.liquidity?.usd;
    const price = typeof row.priceNative === 'string' ? row.priceNative.trim() : '';
    if (typeof liquidity !== 'number' || !Number.isFinite(liquidity) || liquidity <= 0 ||
      liquidity < minLiquidityUsd || liquidity > MAX_LIQUIDITY_USD || price.length > 128 ||
      !DECIMAL.test(price) || !Number.isFinite(Number(price)) || Number(price) <= 0) continue;
    const pairAddress = getAddress(row.pairAddress.toLowerCase());
    const previous = best[quote];
    if (!previous || liquidity > previous.liquidity ||
      (liquidity === previous.liquidity && pairAddress.toLowerCase() < previous.pairAddress.toLowerCase())) {
      // Build a fixed-origin link; upstream token names and arbitrary URLs are not trusted.
      best[quote] = { price, pairAddress, url: `https://dexscreener.com/bsc/${pairAddress.toLowerCase()}`, liquidity };
    }
  }
  return Object.fromEntries(Object.entries(best).map(([key, value]) => [key, value
    ? { price: value.price, pairAddress: value.pairAddress, url: value.url } : null]));
}

/**
 * Indicative market data only; never used to calculate ticket costs or settlements.
 * The exact base/quote addresses determine denomination. priceNative is the quote
 * token per BEM; priceUsd is deliberately not used as a substitute for USDT.
 * updatedAt records our last successful usable fetch, not an exchange trade time.
 * A missing quote is null. An unavailable refresh retains the previous quote and
 * timestamp with stale=true; failures are also cached to avoid request storms.
 */
export function createMarketPriceService({ fetchImpl = globalThis.fetch, now = Date.now,
  cacheMs = 60_000, timeoutMs = 5_000, minLiquidityUsd = 100 } = {}) {
  assert.equal(typeof fetchImpl, 'function');
  assert.equal(typeof now, 'function');
  assert.ok(Number.isSafeInteger(cacheMs) && cacheMs > 0 && cacheMs <= 300_000, 'Invalid market cache duration');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000, 'Invalid market timeout');
  assert.ok(Number.isFinite(minLiquidityUsd) && minLiquidityUsd >= 0 && minLiquidityUsd <= MAX_LIQUIDITY_USD,
    'Invalid minimum liquidity');
  let result = { token: MARKET_TOKEN, chainId: 56, source: 'DEX Screener', updatedAt: null,
    stale: true, usdt: null, bnb: null };
  let lastAttemptAt = null;
  let inFlight = null;
  const readTime = () => {
    const value = now();
    assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000, 'Invalid market clock');
    return value;
  };

  async function refresh() {
    const controller = new AbortController();
    let timer;
    try {
      // The timeout also covers a stalled response body. Promise.race bounds
      // noncompliant fetch implementations that ignore the abort signal.
      const rows = await Promise.race([
        (async () => {
          const response = await fetchImpl(MARKET_ENDPOINT, {
            method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: controller.signal,
          });
          assert.ok(response?.ok === true && typeof response.json === 'function', 'Market request failed');
          return response.json();
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('Market request timed out'));
        }, timeoutMs); }),
      ]);
      const selected = selectPairs(rows, minLiquidityUsd);
      assert.ok(selected.usdt || selected.bnb, 'No usable market quote');
      result = { ...result, ...selected, updatedAt: new Date(readTime()).toISOString(), stale: false };
    } catch {
      // Never stamp an old price with a new time after a failed/empty refresh.
      result = { ...result, stale: true };
    } finally {
      clearTimeout(timer);
      lastAttemptAt = readTime();
    }
    return result;
  }

  async function getQuote() {
    if (!inFlight) {
      const time = readTime();
      if (lastAttemptAt !== null && time >= lastAttemptAt && time - lastAttemptAt < cacheMs) return structuredClone(result);
      inFlight = refresh();
    }
    const request = inFlight;
    try { return structuredClone(await request); }
    finally { if (inFlight === request) inFlight = null; }
  }
  return { getQuote };
}
