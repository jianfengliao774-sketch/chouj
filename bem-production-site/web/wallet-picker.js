import { t } from './player-i18n.js';

// EIP-6963 metadata takes priority only for the same provider object.
// Discovery never asks for accounts; only an explicit wallet choice connects.
export function createWalletRegistry(target, onChange) {
  const announced = new Map();
  let legacy = new Map();
  const providerIds = new WeakMap();
  let nextId = 0;
  const isProvider = provider => provider !== null && ['object', 'function'].includes(typeof provider)
    && typeof provider.request === 'function';
  const providerId = provider => {
    if (!providerIds.has(provider)) providerIds.set(provider, `provider:${++nextId}`);
    return providerIds.get(provider);
  };
  const entries = () => new Map([...announced.values(), ...[...legacy.values()]
    .filter(entry => !announced.has(entry.provider))].map(entry => [entry.id, entry]));
  let published;
  const publish = () => {
    const next = entries(), signature = JSON.stringify([...next.values()].map(({id,name,rdns,icon}) => [id,name,rdns,icon]));
    if (signature !== published) { published = signature; onChange(next); }
  };
  target.addEventListener('eip6963:announceProvider', event => {
    const { info, provider } = event.detail ?? {};
    if (!isProvider(provider) || typeof info?.uuid !== 'string' || !info.uuid
      || info.uuid.length > 100 || typeof info.name !== 'string' || !info.name.trim()) return;
    // Names, rdns and announcement UUIDs are metadata, not provider identity.
    if (announced.has(provider) || announced.size >= 32) return;
    const id = providerId(provider);
    announced.set(provider, { id, provider, name: info.name.trim().slice(0, 60),
      rdns: typeof info.rdns === 'string' ? info.rdns.slice(0, 100) : '',
      icon: typeof info.icon === 'string' && info.icon.length <= 32768 && /^data:image\/(png|jpeg|webp|svg\+xml)[;,]/i.test(info.icon) ? info.icon : null });
    publish();
  });
  function discover() {
    const shared = target.ethereum;
    // Binance exposes a dedicated provider; its mobile browser can instead use
    // window.ethereum.isBinance. Metadata labels cards, never provider identity.
    const providers = [target.binancew3w?.ethereum,
      ...(Array.isArray(shared?.providers) ? shared.providers.slice(0, 32) : []), shared];
    legacy = new Map();
    for (const provider of providers) {
      if (!isProvider(provider) || legacy.has(provider) || legacy.size >= 32) continue;
      const id = providerId(provider);
      const binance = provider === target.binancew3w?.ethereum || provider.isBinance === true;
      legacy.set(provider, { id, provider, name: binance ? 'Binance Wallet' : t('浏览器钱包', 'Browser wallet') + ` ${legacy.size + 1}`,
        rdns: binance ? 'com.binance.wallet' : '', icon: null });
    }
    target.dispatchEvent(new Event('eip6963:requestProvider'));
    publish();
  }
  target.addEventListener('ethereum#initialized', discover);
  target.addEventListener('focus', discover);
  return { discover, entries };
}

const COMMON_WALLETS = [
  { name: 'MetaMask', rdns: ['io.metamask'], icon: '/wallet-icons/metamask.svg', monogram: 'M' },
  { name: 'OKX Wallet', rdns: ['com.okex.wallet', 'com.okx.wallet'], icon: '/wallet-icons/okx.png', monogram: 'OK' },
  { name: 'Binance Wallet', rdns: ['com.binance.wallet', 'com.binance'], icon: '/wallet-icons/binance.svg', monogram: 'B' },
  { name: 'Trust Wallet', rdns: ['com.trustwallet.app', 'com.trustwallet'], icon: '/wallet-icons/trust.svg', monogram: 'T' },
  { name: 'Rabby Wallet', rdns: ['io.rabby'], icon: '/wallet-icons/rabby.png', monogram: 'R' },
  { name: 'Coinbase Wallet', rdns: ['com.coinbase.wallet'], icon: '/wallet-icons/coinbase.svg', monogram: 'C' },
];
const matches = (entry, wallet) => {
  const rdns = entry.rdns.trim().toLowerCase();
  if (rdns) return wallet.rdns.includes(rdns);
  // A partial name such as "MetaMask Compatible" must not adopt a brand's card.
  return entry.name.trim().toLowerCase().replace(/\s+/g, ' ') === wallet.name.toLowerCase();
};

export function createWalletPicker({ dialog, onSelect, onChange, target = window }) {
  const list = dialog.querySelector('#wallet-options');
  let wallets = new Map();
  let discoveryTimers = [];
  const stopDiscovery = () => { discoveryTimers.forEach(clearTimeout); discoveryTimers = []; };
  function render() {
    const focused = document.activeElement?.dataset.walletId;
    const cards = [...wallets.values()].map(entry => ({ entry, wallet: COMMON_WALLETS.find(wallet => matches(entry, wallet)) }));
    for (const wallet of COMMON_WALLETS) if (!cards.some(card => card.wallet === wallet)) cards.push({ wallet });
    list.replaceChildren(...cards.map(({ entry, wallet }) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'wallet-option'; button.disabled = !entry;
      if (entry) {
        button.dataset.walletId = entry.id;
        button.addEventListener('click', () => { dialog.close(); onSelect(entry); });
      }
      const icon = document.createElement('span'); icon.className = 'wallet-option-icon'; icon.setAttribute('aria-hidden', 'true');
      const iconUrl = wallet?.icon ?? entry?.icon;
      if (iconUrl) {
        const image = document.createElement('img'); image.src = iconUrl; image.alt = '';
        image.addEventListener('error', () => { icon.textContent = wallet?.monogram ?? entry.name.slice(0, 1); }, { once: true });
        icon.append(image);
      } else icon.textContent = wallet?.monogram ?? entry.name.slice(0, 1);
      const copy = document.createElement('span'); copy.className = 'wallet-option-copy';
      const name = document.createElement('strong'); name.textContent = entry?.name ?? wallet.name;
      const status = document.createElement('small'); status.textContent = entry ? t('已检测到 · 点击连接', 'Detected · Connect') : t('未检测到', 'Not detected');
      copy.append(name, status); button.append(icon, copy);
      return button;
    }));
    dialog.querySelector('#wallet-picker-hint').textContent = wallets.size
      ? t('选择您要使用的钱包，再在该钱包中确认连接。', 'Choose your wallet, then confirm the connection in that wallet.')
      : t('未检测到钱包扩展。请在已安装钱包的浏览器中打开本页，或从手机钱包的浏览器访问。', 'No wallet detected. Open this page in a browser with a wallet extension, or in your mobile wallet’s browser.');
    if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.walletId === focused)?.focus();
  }
  const registry = createWalletRegistry(target, entries => { wallets = entries; render(); onChange(entries); });
  dialog.querySelector('#wallet-picker-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#wallet-picker-refresh').addEventListener('click', registry.discover);
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => { stopDiscovery(); document.body.classList.remove('wallet-picker-open'); });
  target.addEventListener('bem:languagechange', render);
  registry.discover();
  return { open() {
    registry.discover();
    if (!dialog.open) { dialog.showModal(); document.body.classList.add('wallet-picker-open'); }
    // Some mobile bridges inject after page load without announcing EIP-6963.
    stopDiscovery();
    discoveryTimers = [250, 750, 1500, 3000].map(ms => setTimeout(() => { if (dialog.open) registry.discover(); }, ms));
  } };
}
