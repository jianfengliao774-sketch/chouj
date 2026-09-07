import { formatUnits, getAddress } from 'ethers';
import { t } from './player-i18n.js';

const OLD_GAME = '0xBee0848D0c77d434A52d1D0236FcBFdCA0834343';
const FIXED = Object.freeze({ maxTickets: 10000, maxTicketsPerPurchase: 1000, maxTicketsPerAddress: 5000,
  fundingWindow: 86400, refundClaimWindow: 86400, revenueContainer: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  authorizationContainer: '0x358BE84b95224d228f3A61964Fa3c9fB61D7B646', processorId: 2075, chainId: 56 });
export const POOL_IDS = Object.freeze(['10', '50', '100']);
export const POOL_RULES = Object.freeze(Object.fromEntries(['1', ...POOL_IDS].map(id => {
  const total = BigInt(id) * 100000000n;
  return [id, Object.freeze({ ...FIXED, id, poolBaseUnits: total.toString(), ticketPriceBaseUnits: (total / 10000n).toString(),
    winnerBaseUnits: (total * 95n / 100n).toString(), organizerBaseUnits: (total / 100n).toString(),
    blackholeBaseUnits: (total * 4n / 100n).toString(), testOnly: id === '1' })];
})));
const need = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const money = value => formatUnits(value, 8).replace(/\.0+$/, '');
export function getPoolRules(id) {
  need(typeof id === 'string' && Object.hasOwn(POOL_RULES, id), '场次参数不正确。');
  return POOL_RULES[id];
}
export function validatePoolManifest(manifest) {
  need(manifest?.schemaVersion === 2 && Array.isArray(manifest.pools) && manifest.pools.length >= 3 && manifest.pools.length <= 4, '场次配置暂时无法核验。');
  need(manifest.chainId === 56 && manifest.bemDecimals === 8 && same(manifest.bemAddress, '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a') &&
    same(manifest.containerAddress, FIXED.revenueContainer) && same(manifest.authorizationContainer, FIXED.authorizationContainer) &&
    same(manifest.processorAddress, '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C') && manifest.circuitId === 2075 &&
    same(manifest.coordinatorAddress, '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9') &&
    manifest.subscriptionId === '77582411398321098948652233841078712279496169525251928512909841261362926957679', '场次网络、代币或容器配置不匹配。');
  const pools = new Map();
  for (const row of manifest.pools) {
    const id = String(row.id), rules = getPoolRules(id);
    need(!pools.has(id), '场次配置含有重复编号。');
    for (const key of ['poolBaseUnits', 'ticketPriceBaseUnits', 'winnerBaseUnits', 'organizerBaseUnits', 'blackholeBaseUnits']) {
      need(typeof row[key] === 'string' && row[key] === rules[key], '场次金额与固定规则不一致。');
    }
    for (const [apiKey, ruleKey] of [['ticketsPerRound', 'maxTickets'], ['maxTicketsPerPurchase', 'maxTicketsPerPurchase'],
      ['maxTicketsPerAddress', 'maxTicketsPerAddress'], ['fundingWindowSeconds', 'fundingWindow'], ['refundClaimWindowSeconds', 'refundClaimWindow']]) {
      need(row[apiKey] === rules[ruleKey], '场次份数或期限与固定规则不一致。');
    }
    need(row.testOnly === rules.testOnly && typeof row.salesEnabled === 'boolean', '场次测试标记或开售状态不正确。');
    let deployment = null;
    if (row.deployment != null) {
      const d = row.deployment;
      need(d && typeof d === 'object' && d.chainId === 56 && d.verified === true &&
        typeof d.address === 'string' && /^0x[0-9a-f]{64}$/i.test(d.runtimeCodeHash), '场次合约部署记录尚未核验。');
      const address = getAddress(d.address);
      need(!same(address, OLD_GAME) && address !== '0x0000000000000000000000000000000000000000', '旧合约不能作为新的场次合约。');
      deployment = Object.freeze({ address, chainId: 56, runtimeCodeHash: d.runtimeCodeHash.toLowerCase(), verified: true });
    }
    pools.set(id, Object.freeze({ ...rules, deployment, salesEnabled: row.salesEnabled,
      available: Boolean(deployment && row.salesEnabled) }));
  }
  need(POOL_IDS.every(id => pools.has(id)), '正式场次配置不完整。');
  const addresses = [...pools.values()].filter(row => row.deployment).map(row => row.deployment.address.toLowerCase());
  need(new Set(addresses).size === addresses.length, '不同场次不能共用同一个合约地址。');
  return pools;
}

/** Selection metadata is not transaction authorization. The caller must still verify the
 * selected contract's actual code/rules before any approval, purchase or refund. */
export function createPoolController({ initialPool = '100', allowInternal = false, onChange = () => {} } = {}) {
  const visibleIds = Object.freeze(allowInternal ? ['1', ...POOL_IDS] : [...POOL_IDS]);
  need(visibleIds.includes(initialPool), '此页面不提供所选场次。');
  let selectedId = initialPool, epoch = 0, rows = new Map(), error = null, loaded = false;
  function snapshot() {
    const rules = getPoolRules(selectedId), row = rows.get(selectedId), available = !error && row?.available === true;
    return Object.freeze({ id: selectedId, poolId: selectedId, epoch, rules, visibleIds,
      deployment: row?.deployment ?? null, available, loaded, error,
      message: available ? (rules.testOnly ? t('内部测试场次已开放', 'Internal test pool is open') : t('该场次已开放', 'This pool is open')) : t('该场次暂未开放', 'This pool is not open yet') });
  }
  const fingerprint = () => {
    const s = snapshot(); return JSON.stringify([s.id, s.available, s.deployment?.address, s.deployment?.runtimeCodeHash, Boolean(s.error)]);
  };
  function changed(before, reason) {
    if (before === fingerprint()) return false;
    epoch++; onChange(Object.freeze({ ...snapshot(), reason })); return true;
  }
  return {
    getState: snapshot, getRules: () => getPoolRules(selectedId),
    getPool: id => rows.get(id) ?? Object.freeze({ ...getPoolRules(id), deployment: null, available: false, salesEnabled: false }),
    select(id) {
      need(visibleIds.includes(id), '此页面不提供所选场次。');
      const before = fingerprint(); selectedId = id; changed(before, 'selection'); return snapshot();
    },
    replaceManifest(manifest) {
      const before = fingerprint();
      try { rows = validatePoolManifest(manifest); error = null; loaded = true; }
      catch (failure) { rows = new Map(); error = String(failure.message ?? failure); loaded = true; }
      changed(before, 'configuration'); return snapshot();
    },
    fail(message = '场次读取暂时不可用，请稍后重试。') {
      const before = fingerprint(); rows = new Map(); error = message; loaded = true; changed(before, 'unavailable'); return snapshot();
    },
    isCurrent(saved) { return saved?.epoch === epoch && saved?.id === selectedId; },
  };
}
export function poolMetadata(selection) {
  const r = selection.rules;
  return Object.freeze({ poolTotal: money(r.poolBaseUnits), unitPrice: money(r.ticketPriceBaseUnits),
    winnerAmount: money(r.winnerBaseUnits), organizerAmount: money(r.organizerBaseUnits), blackholeAmount: money(r.blackholeBaseUnits),
    ticketCount: '10,000', maxPerPurchase: '1,000', maxPerAddress: '5,000', fundingHours: '24', refundHours: '24',
    availability: selection.message, containerLabel: t('容器', 'Container'), containerAddress: r.revenueContainer,
    poolLabel: r.testOnly ? t('1 BEM · 内部测试', '1 BEM · Internal test') : t('{id} BEM 场次', '{id} BEM pool', { id: r.id }), testOnly: r.testOnly });
}

/** Mount only the selector and its own status. Existing transaction controls belong to
 * the calling player page and must be disabled whenever getState().available is false. */
export function createPoolSelection({ mount, onChange = () => {}, metadataTargets = {}, fetchImpl = globalThis.fetch,
  search = globalThis.location?.search ?? '', disableUnavailable = false, autoLoad = true } = {}) {
  need(mount?.ownerDocument, '缺少场次选择区域。');
  const doc = mount.ownerDocument, requested = new URLSearchParams(search).get('pool'), allowInternal = requested === '1';
  const initialPool = [...POOL_IDS, ...(allowInternal ? ['1'] : [])].includes(requested) ? requested : '100';
  let destroyed = false, generation = 0, abort = null;
  const controller = createPoolController({ initialPool, allowInternal, onChange: selection => { render(); onChange(selection); } });
  mount.classList.add('pool-selection');
  const title = doc.createElement('div'); title.className = 'pool-selection-heading'; title.textContent = '选择场次（每个场次均为10,000份）';
  const list = doc.createElement('div'); list.className = 'pool-selection-options'; list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', '选择开奖场次');
  const status = doc.createElement('p'); status.className = 'pool-selection-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const detail = doc.createElement('p'); detail.className = 'pool-selection-detail';
  const buttons = new Map();
  for (const id of controller.getState().visibleIds) {
    const rules = getPoolRules(id), button = doc.createElement('button'); button.type = 'button'; button.className = 'pool-choice';
    button.setAttribute('role', 'radio'); button.dataset.pool = id;
    const amount = doc.createElement('strong'), price = doc.createElement('span'), stateLabel = doc.createElement('small');
    amount.textContent = `${id} BEM${rules.testOnly ? ' · 内部测试' : ''}`; price.textContent = `每份${money(rules.ticketPriceBaseUnits)}BEM`;
    button.append(amount, price, stateLabel);
    button.addEventListener('click', () => { if (!destroyed && !button.disabled) controller.select(id); });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const enabled = [...buttons].filter(([, b]) => !b.disabled), current = enabled.findIndex(([key]) => key === id);
      const step = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
      if (!enabled.length) return; const [nextId, nextButton] = enabled[(current + step + enabled.length) % enabled.length];
      controller.select(nextId); nextButton.focus();
    });
    buttons.set(id, button); list.append(button);
  }
  mount.replaceChildren(title, list, status, detail);
  function render() {
    if (destroyed) return; const selection = controller.getState(), metadata = poolMetadata(selection);
    title.textContent = t('选择场次（每个场次均为10,000份）', 'Choose a pool (10,000 tickets per pool)'); list.setAttribute('aria-label', t('选择开奖场次', 'Choose a draw pool'));
    for (const [id, button] of buttons) {
      const active = id === selection.id, row = controller.getPool(id);
      button.setAttribute('aria-checked', String(active)); button.tabIndex = active ? 0 : -1;
      // Until deployment registration is loaded, every slot is explicitly marked unopened.
      button.children[0].textContent = row.testOnly ? t('1 BEM · 内部测试', '1 BEM · Internal test') : `${id} BEM`;
      button.children[1].textContent = t('每份{price}BEM', '{price} BEM per ticket', { price: money(row.ticketPriceBaseUnits) });
      button.lastElementChild.textContent = row.available ? t('已开放', 'Open') : t('暂未开放', 'Not open yet');
      button.disabled = disableUnavailable && !row.available;
    }
    status.textContent = selection.error ? `${selection.message} · ${selection.error}` : selection.message;
    status.classList.toggle('is-open', selection.available);
    detail.textContent = t('场次24 小时未凑满开奖可退款，领取期 24 小时，截止后未领本金黑洞销毁。',
      'If a pool remains unfilled after 24 hours, refunds become available. Claim within 24 hours; any principal left unclaimed after the deadline is sent to the dead address for burning.');
    for (const [key, target] of Object.entries(metadataTargets)) {
      const node = typeof target === 'string' ? doc.querySelector(target) : target;
      if (node && Object.hasOwn(metadata, key) && typeof metadata[key] !== 'boolean') node.textContent = metadata[key];
    }
  }
  async function load() {
    const version = ++generation; abort?.abort(); abort = new AbortController();
    try {
      need(typeof fetchImpl === 'function', '场次读取暂时不可用。');
      const response = await fetchImpl('/api/pools', { cache: 'no-store', headers: { Accept: 'application/json' }, signal: abort.signal });
      need(response.ok && response.headers.get('content-type')?.includes('application/json'), '场次读取暂时不可用。');
      const manifest = await response.json(); if (destroyed || version !== generation) return controller.getState();
      controller.replaceManifest(manifest); render();
    } catch (error) {
      if (destroyed || version !== generation || error.name === 'AbortError') return controller.getState();
      controller.fail(String(error.message ?? error)); render();
    }
    return controller.getState();
  }
  const languageTarget = doc.defaultView;
  languageTarget?.addEventListener('bem:languagechange', render);
  render(); if (autoLoad) load();
  return { getState: controller.getState, getRules: controller.getRules, isCurrent: controller.isCurrent,
    select: id => { const result = controller.select(id); render(); return result; }, load, render,
    setManifest: manifest => { const result = controller.replaceManifest(manifest); render(); return result; },
    renderMetadata: () => { render(); return poolMetadata(controller.getState()); },
    destroy() { destroyed = true; generation++; abort?.abort(); languageTarget?.removeEventListener('bem:languagechange', render); mount.replaceChildren(); } };
}
