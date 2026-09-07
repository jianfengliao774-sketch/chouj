import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketPriceService, MARKET_ENDPOINT, MARKET_TOKEN, MARKET_QUOTES } from '../bem-production-site/market-price.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const pair = (overrides = {}) => ({ chainId: 'bsc', pairAddress: address(1),
  baseToken: { address: MARKET_TOKEN, symbol: 'BEM' }, quoteToken: { address: MARKET_QUOTES.usdt, symbol: 'USDT' },
  priceNative: '0.0000123400', priceUsd: '99999', liquidity: { usd: 1000 }, ...overrides });
const response = rows => ({ ok: true, json: async () => rows });
const EPOCH = Date.UTC(2026, 8, 7);

test('market quotes independently select highest-liquidity exact BEM/USDT and BEM/WBNB pairs', async () => {
  let call;
  const service = createMarketPriceService({ now: () => EPOCH, fetchImpl: async (url, options) => {
    call = { url, options };
    return response([
      pair({ pairAddress: address(2), priceNative: '0.002', liquidity: { usd: 2000 } }),
      pair({ pairAddress: address(4), quoteToken: { address: MARKET_QUOTES.bnb }, priceNative: '0.00000043210', liquidity: { usd: 5000 } }),
      pair(), pair({ pairAddress: address(3), quoteToken: { address: MARKET_QUOTES.bnb }, priceNative: '0.000000123', liquidity: { usd: 3000 } }),
    ]);
  } });
  const quote = await service.getQuote();
  assert.equal(call.url, MARKET_ENDPOINT); assert.equal(call.options.method, 'GET');
  assert.equal(call.options.redirect, 'error'); assert.ok(call.options.signal instanceof AbortSignal);
  assert.equal(quote.token, MARKET_TOKEN); assert.equal(quote.chainId, 56); assert.equal(quote.source, 'DEX Screener');
  assert.equal(quote.updatedAt, new Date(EPOCH).toISOString()); assert.equal(quote.stale, false);
  assert.deepEqual(quote.usdt, { price: '0.002', pairAddress: address(2), url: `https://dexscreener.com/bsc/${address(2)}` });
  assert.deepEqual(quote.bnb, { price: '0.00000043210', pairAddress: address(4), url: `https://dexscreener.com/bsc/${address(4)}` });
});

test('market validation rejects wrong chains, reversed pairs and spoofed symbols; fixed-origin pair links ignore upstream URLs', async () => {
  const rows = [
    pair({ chainId: 'ethereum' }), pair({ chainId: 56 }), pair({ baseToken: { address: address(900), symbol: 'BEM' } }),
    pair({ baseToken: { address: MARKET_QUOTES.usdt }, quoteToken: { address: MARKET_TOKEN } }),
    pair({ quoteToken: { address: address(901), symbol: 'USDT' } }),
    pair({ pairAddress: 'javascript:alert(1)' }), pair({ pairAddress: address(0) }),
  ].map(row => ({ ...row, liquidity: { usd: 1_000_000 } }));
  rows.push(pair({ pairAddress: address(10), url: 'https://example.invalid/fake',
    baseToken: { address: MARKET_TOKEN.toLowerCase(), symbol: 'not relied upon' }, quoteToken: { address: MARKET_QUOTES.usdt.toLowerCase() } }));
  const service = createMarketPriceService({ fetchImpl: async () => response(rows), now: () => EPOCH });
  const quote = await service.getQuote();
  assert.equal(quote.usdt.pairAddress.toLowerCase(), address(10));
  assert.equal(quote.usdt.url, `https://dexscreener.com/bsc/${address(10)}`);
  assert.equal(quote.bnb, null);
});

test('market validation rejects zero, negative, nonfinite, malformed prices and illiquid pools', async () => {
  const badPrices = [0, 1, null, '', '0', '-1', 'NaN', 'Infinity', '1e309', '1e-9999', '0x10', '1,000'];
  const badLiquidity = [0, -1, NaN, Infinity, null, '1000', 99.99, 1e15];
  const rows = [...badPrices.map(priceNative => pair({ priceNative, liquidity: { usd: 1_000_000 } })),
    ...badLiquidity.map(usd => pair({ liquidity: { usd } }))];
  rows.push(pair({ pairAddress: address(20), priceNative: '1.25e-7', liquidity: { usd: 100 } }));
  const quote = await createMarketPriceService({ now: () => EPOCH, fetchImpl: async () => response(rows) }).getQuote();
  assert.equal(quote.stale, false); assert.equal(quote.usdt.price, '1.25e-7');
  assert.equal(quote.usdt.pairAddress.toLowerCase(), address(20));
});

test('a missing quote stays null and is not synthesized from priceUsd or the other pair', async () => {
  let time = EPOCH, rows = [pair()];
  const service = createMarketPriceService({ now: () => time, fetchImpl: async () => response(rows) });
  assert.equal((await service.getQuote()).bnb, null);
  time += 60_000;
  rows = [pair({ quoteToken: { address: MARKET_QUOTES.bnb }, priceNative: '0.00004' })];
  const quote = await service.getQuote();
  assert.equal(quote.stale, false); assert.equal(quote.usdt, null); assert.equal(quote.bnb.price, '0.00004');
  assert.equal(quote.updatedAt, new Date(time).toISOString());
});

test('a single flight serves concurrent requests; cache expires at 60 seconds and callers cannot mutate it', async () => {
  let resolveFetch, time = EPOCH, requests = 0;
  const service = createMarketPriceService({ now: () => time, fetchImpl: async () => {
    requests++; return new Promise(resolve => { resolveFetch = resolve; });
  } });
  const pending = Array.from({ length: 12 }, () => service.getQuote());
  assert.equal(requests, 1); resolveFetch(response([pair()]));
  const quotes = await Promise.all(pending); assert.ok(quotes.every(quote => quote.stale === false));
  quotes[0].usdt.price = '999'; quotes[0].source = 'bad';
  time += 59_999;
  assert.equal((await service.getQuote()).usdt.price, '0.0000123400'); assert.equal(requests, 1);
  time++;
  const refresh = service.getQuote(); assert.equal(requests, 2);
  resolveFetch(response([pair({ priceNative: '0.00002' })]));
  const refreshed = await refresh;
  assert.equal(refreshed.usdt.price, '0.00002'); assert.equal(refreshed.updatedAt, new Date(time).toISOString());
});

test('failed, malformed and empty refreshes retain stale values with the original timestamp and are cached', async () => {
  let time = EPOCH, requests = 0, mode = 'good';
  const service = createMarketPriceService({ now: () => time, fetchImpl: async () => {
    requests++;
    if (mode === 'http') return { ok: false, json: async () => [pair()] };
    if (mode === 'throw') throw new Error('upstream failed');
    if (mode === 'malformed') return response({ pairs: [pair()] });
    if (mode === 'empty') return response([]);
    return response([pair()]);
  } });
  const fresh = await service.getQuote();
  for (mode of ['http', 'throw', 'malformed', 'empty']) {
    time += 60_000;
    const stale = await service.getQuote(), count = requests;
    assert.equal(stale.stale, true); assert.equal(stale.updatedAt, fresh.updatedAt);
    assert.deepEqual(stale.usdt, fresh.usdt);
    time += 59_999;
    assert.equal((await service.getQuote()).updatedAt, fresh.updatedAt); assert.equal(requests, count);
  }
});

test('an initial failed quote has no invented price or success timestamp', async () => {
  const quote = await createMarketPriceService({ now: () => EPOCH, fetchImpl: async () => { throw new Error('offline'); } }).getQuote();
  assert.equal(quote.stale, true); assert.equal(quote.updatedAt, null); assert.equal(quote.usdt, null); assert.equal(quote.bnb, null);
});

test('timeout bounds an ignored abort, preserves stale data, and a late response cannot refresh the timestamp', async () => {
  let time = EPOCH, mode = 'good', resolveLate, capturedSignal;
  const service = createMarketPriceService({ timeoutMs: 15, now: () => time, fetchImpl: async (_url, options) => {
    capturedSignal = options.signal;
    if (mode === 'good') return response([pair()]);
    return new Promise(resolve => { resolveLate = resolve; });
  } });
  const fresh = await service.getQuote(); time += 60_000; mode = 'hanging';
  const started = Date.now(), stale = await service.getQuote();
  assert.ok(Date.now() - started < 1000); assert.equal(capturedSignal.aborted, true);
  assert.equal(stale.stale, true); assert.equal(stale.updatedAt, fresh.updatedAt);
  resolveLate(response([pair({ priceNative: '1000' })]));
  await new Promise(resolve => setImmediate(resolve));
  const stillStale = await service.getQuote();
  assert.equal(stillStale.updatedAt, fresh.updatedAt); assert.equal(stillStale.usdt.price, fresh.usdt.price);
});

test('timeout also covers a response body that never resolves', async () => {
  let signal;
  const service = createMarketPriceService({ timeoutMs: 10, now: () => EPOCH, fetchImpl: async (_url, options) => {
    signal = options.signal; return { ok: true, json: () => new Promise(() => {}) };
  } });
  const result = await service.getQuote();
  assert.equal(signal.aborted, true); assert.equal(result.stale, true); assert.equal(result.updatedAt, null);
});
