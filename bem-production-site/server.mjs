// Mainnet website: chain reads only. Wallets sign and broadcast directly in the browser.
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Interface, keccak256 } from 'ethers';
import { SITE, ROOT, GAME, CODE_HASH, PROCESSOR, COORDINATOR, CONTAINER, loadManifest } from './config.mjs';
import { createReadRpc, validateReadRequest } from './rpc.mjs';
import { createAdminAuth } from './auth.mjs';
import { createChainHistory } from './chain-history.mjs';

const format = value => JSON.stringify(value, (_, x) => typeof x === 'bigint' ? x.toString() : x);
const ABI = new Interface(['function ownerOf(uint256) view returns(address)',
  'function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export async function createProductionServer({ port = 8788, rpc = createReadRpc(), manifest, history, staticRoot = path.join(SITE, 'dist') } = {}) {
  manifest ??= await loadManifest();
  if (manifest.mode !== 'production' || manifest.chainId !== 56 || manifest.gameAddress !== GAME || manifest.salesEnabled !== false) throw new Error('Unapproved production configuration');
  const iface = new Interface(manifest.gameAbi);
  const owners = async () => ABI.decodeFunctionResult('ownerOf', await rpc('eth_call', [{ to: PROCESSOR, data: ABI.encodeFunctionData('ownerOf', [2075]) }, 'latest']))[0];
  const auth = createAdminAuth({ readOwner: owners });
  let cached = null, reading = null;
  async function readStatus() {
    if (cached && Date.now() - cached.readAt < 8000) return cached.value;
    if (reading) return reading;
    reading = (async () => {
      const block = await rpc('eth_getBlockByNumber', ['latest', false]);
      const call = async (fn, args = []) => iface.decodeFunctionResult(fn, await rpc('eth_call', [{ to: GAME, data: iface.encodeFunctionData(fn, args) }, block.number]));
      const [chain, code, authorized, currentRoundId, nextRound, balance, sub] = await Promise.all([
        rpc('eth_chainId', []), rpc('eth_getCode', [GAME, block.number]), call('seriesAuthorized'), call('currentRoundId'), call('nextRoundOpensAt'),
        rpc('eth_getBalance', [CONTAINER, block.number]), rpc('eth_call', [{ to: COORDINATOR, data: ABI.encodeFunctionData('getSubscription', [manifest.subscriptionId]) }, block.number])
      ]);
      if (BigInt(chain) !== 56n || keccak256(code) !== CODE_HASH) throw new Error('Chain identity mismatch');
      const round = await call('rounds', [currentRoundId[0]]);
      const subscription = ABI.decodeFunctionResult('getSubscription', sub);
      const sameBlock = await rpc('eth_getBlockByNumber', [block.number, false]);
      if (sameBlock.hash !== block.hash) throw new Error('Read snapshot changed');
      const value = { schemaVersion: 1, mode: 'production', chainId: 56, gameAddress: GAME, runtimeVerified: true,
        snapshot: { blockNumber: Number(BigInt(block.number)), blockHash: block.hash, timeUtc: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() },
        salesEnabled: false, seriesAuthorized: authorized[0], currentRoundId: currentRoundId[0].toString(),
        nextRoundOpensAt: nextRound[0].toString(), currentRound: round.toObject(), containerNativeBalanceWei: balance,
        vrf: { subscriptionId: manifest.subscriptionId, nativeBalanceWei: subscription.nativeBalance.toString(), requestCount: subscription.reqCount.toString(),
          owner: subscription.owner, consumers: [...subscription.consumers], consumerAuthorized: subscription.consumers.some(a => a.toLowerCase() === GAME.toLowerCase()) },
        keeper: { configured: false, serviceRunning: false }, history: history.getStatus() };
      cached = { readAt: Date.now(), value }; return value;
    })().finally(() => { reading = null; });
    return reading;
  }
  const limits = new Map();
  function json(res, status, value, extra = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(format(value)); }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new Error('需要 JSON 请求');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 262144) throw new Error('请求过大'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'");
    try {
      const host = req.headers.host;
      if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return json(res, 403, { error: 'Unexpected host' });
      const origin = `http://${host}`, url = new URL(req.url, origin);
      if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Cross-origin request blocked' });
      if (req.method === 'OPTIONS') return json(res, 405, { error: 'Cross-origin access is not enabled' });
      const ip = req.socket.remoteAddress || 'local', now = Date.now();
      if (limits.size > 2000) for (const [key, entry] of limits) if (now - entry.at > 60000) limits.delete(key);
      let count = limits.get(ip); if (!count || now - count.at > 60000) { count = { at: now, requests: 0 }; limits.set(ip, count); }
      if (++count.requests > 600) return json(res, 429, { error: '访问较频繁，请稍后重试。' }, { 'retry-after': '10' });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { mode: 'production', chainId: 56, gameAddress: GAME, salesEnabled: false });
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, manifest);
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await readStatus());
      if (req.method === 'POST' && url.pathname === '/rpc') {
        const input = await body(req), batch = Array.isArray(input);
        if (batch && (input.length < 1 || input.length > 25)) return json(res, 400, { error: '批量请求最多 25 项' });
        const results = await Promise.all((batch ? input : [input]).map(async item => {
          try { const safe = validateReadRequest(item); return { jsonrpc: '2.0', id: safe.id, result: await rpc(safe.method, safe.params) }; }
          catch (e) { return { jsonrpc: '2.0', id: ['number', 'string'].includes(typeof item?.id) ? item.id : null,
            error: { code: Number.isInteger(e.code) ? e.code : -32000, message: [-32601, -32602].includes(e.code) ? e.message : '链上读取暂时不可用，请稍后重试。' } }; }
        }));
        return json(res, 200, batch ? results : results[0]);
      }
      if (req.method === 'GET' && url.pathname === '/api/history') {
        const page = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 10);
        if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) return json(res, 400, { error: '无效分页' });
        return json(res, 200, { schemaVersion: 1, chainId: 56, gameAddress: GAME, index: history.getStatus(), ...history.listRounds({ page, pageSize }) });
      }
      const detail = /^\/api\/history\/round\/([1-9][0-9]{0,20})$/.exec(url.pathname);
      if (req.method === 'GET' && detail) {
        const round = history.getRound(detail[1]);
        if (!round) return json(res, history.getStatus().state === 'ready' ? 404 : 503, { error: '该期记录尚不可用', index: history.getStatus() });
        return json(res, 200, { ...round, index: history.getStatus() });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (req.method === 'POST' && req.headers.origin !== origin) return json(res, 403, { error: '请从本站管理页发起登录。' });
        if (req.method === 'POST' && url.pathname === '/api/admin/challenge') { const data = await body(req); return json(res, 200, await auth.challenge({ address: data.address, origin })); }
        if (req.method === 'POST' && url.pathname === '/api/admin/login') {
          const data = await body(req), login = await auth.login({ id: data.id, signature: data.signature, origin });
          return json(res, 200, { address: login.address, expiresAt: login.expiresAt }, { 'set-cookie': `bem2075_admin=${login.token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=900` });
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/logout') { auth.logout(req.headers.cookie); return json(res, 200, { signedOut: true }, { 'set-cookie': 'bem2075_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0' }); }
        const session = await auth.session(req.headers.cookie);
        if (!session) return json(res, 401, { error: '请使用 2075 持有人钱包登录。' });
        if (req.method === 'GET' && url.pathname === '/api/admin/status') return json(res, 200, { session, ...(await readStatus()) });
        return json(res, 404, { error: '管理操作不存在' });
      }
      if (url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method)) return json(res, 404, { error: '接口不存在' });
      const decoded = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      if (decoded.includes('\0') || decoded.includes('\\')) return json(res, 400, { error: 'Invalid path' });
      const absolute = path.resolve(staticRoot, '.' + decoded), rootReal = await fs.realpath(staticRoot);
      let real; try { real = await fs.realpath(absolute); } catch { return json(res, 404, { error: '页面不存在' }); }
      if (!real.startsWith(rootReal + path.sep)) return json(res, 403, { error: 'Invalid path' });
      const type = MIME[path.extname(real).toLowerCase()];
      if (!type || !(await fs.stat(real)).isFile()) return json(res, 404, { error: '页面不存在' });
      const data = await fs.readFile(real);
      res.writeHead(200, { 'content-type': type, 'content-length': data.length,
        'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) {
      // Never include raw RPC errors, session tokens, signing data, or server paths.
      json(res, 503, { error: req.url?.startsWith('/api/admin/') ? '登录或状态读取未完成，请核对钱包并重试。' : '服务正在同步主网数据，请稍后重试。' });
    }
  });
  server.requestTimeout = 25000; server.headersTimeout = 10000;
  return { server, manifest, readStatus };
}

async function main() {
  const args = process.argv.slice(2); let port = 8788;
  if (args.length) { if (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1])) throw new Error('Usage: node bem-production-site/server.mjs [--port 8788]'); port = Number(args[1]); }
  if (port < 1024 || port > 65535) throw new Error('Invalid port');
  const manifest = await loadManifest(), rpc = createReadRpc();
  if (BigInt(await rpc('eth_chainId', [])) !== 56n || keccak256(await rpc('eth_getCode', [GAME, 'latest'])) !== CODE_HASH) throw new Error('Mainnet runtime could not be verified');
  const dataDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local/share'), 'Bem2075', 'website');
  await fs.mkdir(dataDir, { recursive: true });
  const history = await createChainHistory({ rpc, gameAddress: GAME, abi: manifest.gameAbi, deploymentBlock: manifest.deploymentBlock,
    storagePath: path.join(dataDir, 'chain-history.json'), confirmations: 12, chunkSize: 100, maxBlocksPerSync: 400 });
  const { server } = await createProductionServer({ port, rpc, manifest, history });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  let syncing = false;
  async function sync() { if (syncing) return; syncing = true; try { await history.sync(); } catch { /* Index retains stale/error state; never substitute invented history. */ } finally { syncing = false; } }
  const timer = setInterval(sync, 15000); sync();
  const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log(format({ mode: 'production', url: `http://127.0.0.1:${port}/`, chainId: 56, gameAddress: GAME, salesEnabled: false, walletSigning: 'browser_only', serverCanSendTransactions: false }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Production website did not start. Check deployment evidence, build output and read-only RPC.'); process.exitCode = 1; });
