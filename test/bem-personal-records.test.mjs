import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { formatUnits } from 'ethers';

const source = (await readFile(new URL('../bem-production-site/web/personal-records.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export function', 'function');
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
function harness() {
  const nodes = new Map(), requests = [];
  const node = () => ({ value: '', textContent: '', children: [], addEventListener() {},
    replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); } });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  get('personal-pool').value = 'all';
  let account = null;
  const context = vm.createContext({ formatUnits, URLSearchParams, AbortSignal,
    t: (zh, en, args = {}) => zh.replace(/\{(\w+)\}/g, (_, key) => args[key] ?? ''), getLocale: () => 'zh-CN',
    document: { getElementById: get, createElement: node }, window: { addEventListener() {} },
    getAccount: () => account,
    fetch: url => new Promise(resolve => requests.push({ url, resolve })) });
  const controller = vm.runInContext(source + '\ninitPersonalRecords({getAccount})', context);
  const finish = async (index, tickets) => {
    requests[index].resolve({ ok: true, json: async () => ({ schemaVersion: 1, chainId: 56,
      total: 0, totalPages: 1, rows: [], sources: [], totals: { tickets, purchases: 1, paidBaseUnits: '1' } }) });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { get, requests, finish, sync: value => { account = value; return controller.syncAccount(); } };
}

test('wallet connection automatically queries once; switching ignores a late previous-wallet response', async () => {
  const h = harness();
  assert.equal(h.requests.length, 0);
  h.sync(A);
  assert.equal(h.get('personal-wallet').value, A);
  assert.equal(new URLSearchParams(h.requests[0].url.split('?')[1]).get('wallet'), A);
  h.sync(A); h.sync(A.toUpperCase());
  assert.equal(h.requests.length, 1);
  h.sync(B);
  assert.equal(h.requests.length, 2);
  await h.finish(1, 22);
  const current = h.get('personal-status').textContent;
  assert.match(current, /22 份/);
  await h.finish(0, 99);
  assert.equal(h.get('personal-status').textContent, current);
  assert.equal(h.get('personal-wallet').value, B);
});

test('disconnect clears the account and invalidates an in-flight response', async () => {
  const h = harness();
  h.sync(A); h.sync(null);
  await h.finish(0, 99);
  assert.equal(h.get('personal-wallet').value, '');
  assert.match(h.get('personal-status').textContent, /连接钱包/);
  assert.equal(h.get('personal-list').children.length, 0);
});
