import {isMobileBrowser,walletPageUrl,walletDappLink} from './wallet-mobile-links.js';
import {compatibleDialog} from './dialog-compat.js';
import { t } from './player-i18n.js';

function legacyBrand(provider, {okx, binance, tp}) {
  if (provider === okx || provider === okx?.ethereum) return ['OKX Wallet', 'com.okx.wallet'];
  if (provider === tp || provider === tp?.ethereum) return ['TokenPocket', 'pro.tokenpocket'];
  if (provider === binance) return ['Binance Wallet', 'com.binance.wallet'];
  // Several wallets also set isMetaMask for protocol compatibility. Resolve
  // their own flags first; labels never replace the provider selected by users.
  if (provider.isOkxWallet === true || provider.isOKExWallet === true) return ['OKX Wallet', 'com.okx.wallet'];
  if (provider.isBinance === true) return ['Binance Wallet', 'com.binance.wallet'];
  if (provider.isTokenPocket === true || provider.isTp === true) return ['TokenPocket', 'pro.tokenpocket'];
  if (provider.isTrust === true || provider.isTrustWallet === true) return ['Trust Wallet', 'com.trustwallet.app'];
  if (provider.isRabby === true) return ['Rabby Wallet', 'io.rabby'];
  if (provider.isCoinbaseWallet === true) return ['Coinbase Wallet', 'com.coinbase.wallet'];
  if (provider.isMetaMask === true) return ['MetaMask', 'io.metamask'];
  return null;
}

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
    // Mobile wallets may expose a dedicated EVM bridge without window.ethereum
    // or an EIP-6963 announcement. Preserve the exact selected provider object.
    const okx = target.okxwallet, binance = target.binancew3w?.ethereum, tp = target.tokenpocket;
    const providers = [okx, okx?.ethereum, binance, tp?.ethereum, tp,
      ...(Array.isArray(shared?.providers) ? shared.providers.slice(0, 32) : []), shared];
    legacy = new Map();
    for (const provider of providers) {
      if (!isProvider(provider) || legacy.has(provider) || legacy.size >= 32) continue;
      const id = providerId(provider);
      const brand = legacyBrand(provider, {okx, binance, tp});
      legacy.set(provider, { id, provider, name: brand?.[0] ?? t('浏览器钱包', 'Browser wallet') + ` ${legacy.size + 1}`,
        rdns: brand?.[1] ?? '', icon: null });
    }
    target.dispatchEvent(new Event('eip6963:requestProvider'));
    publish();
  }
  target.addEventListener('ethereum#initialized', discover);
  target.addEventListener('focus', discover);
  target.addEventListener('pageshow', discover);
  target.document?.addEventListener('visibilitychange', () => { if (!target.document.hidden) discover(); });
  return { discover, entries };
}

const COMMON_WALLETS = [
  { name: 'MetaMask', rdns: ['io.metamask'], icon: '/wallet-icons/metamask.svg', monogram: 'M' },
  { name: 'OKX Wallet', rdns: ['com.okex.wallet', 'com.okx.wallet'], icon: '/wallet-icons/okx.png', monogram: 'OK' },
  { name: 'TokenPocket', rdns: ['pro.tokenpocket', 'com.tokenpocket'], icon: new URL('./assets/tokenpocket.png', import.meta.url).href, monogram: 'TP' },
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

export function createWalletPicker({ dialog, onSelect, onChange, target = window, getPageUrl = () => target.location ? walletPageUrl(target.location) : null }) {
  compatibleDialog(dialog);
  const list = dialog.querySelector('#wallet-options');
  const mobile=isMobileBrowser(target.navigator);
  const copyUrl=dialog.querySelector('#wallet-page-url'),copyButton=dialog.querySelector('#wallet-copy-url');
  async function copyPageUrl(){
    if(!copyUrl)return;copyUrl.value=getPageUrl()||'';copyUrl.focus();copyUrl.select();
    try{await target.navigator.clipboard.writeText(copyUrl.value);dialog.querySelector('#wallet-picker-hint').textContent=t('网址已复制，请在钱包 App 的浏览器中粘贴打开。','URL copied. Paste it in your wallet app’s browser.');}
    catch{dialog.querySelector('#wallet-picker-hint').textContent=t('请长按或选中下方网址复制，再粘贴到钱包 App 的浏览器中。','Select and copy the URL below, then paste it in your wallet app’s browser.');}
  }
  copyButton?.addEventListener('click',copyPageUrl);
  let wallets = new Map();
  let discoveryTimer;
  const stopDiscovery = () => clearTimeout(discoveryTimer);
  function scanWhileOpen() {
    if (!dialog.open) return;
    registry.discover();
    discoveryTimer = setTimeout(scanWhileOpen, 1000);
  }
  function render() {
    const focused = document.activeElement?.dataset.walletId;
    const cards = [...wallets.values()].map(entry => ({ entry, wallet: COMMON_WALLETS.find(wallet => matches(entry, wallet)) }));
    for (const wallet of COMMON_WALLETS) if (!cards.some(card => card.wallet === wallet)) cards.push({ wallet });
    list.replaceChildren(...cards.map(({ entry, wallet }) => {
      const external=mobile&&!wallets.size&&!entry,link=external?walletDappLink(wallet.name,getPageUrl()):null;
      const button = document.createElement(link?'a':'button');
      if(link){button.href=link;button.dataset.walletId='open:'+wallet.name;button.addEventListener('click',()=>{button.href=walletDappLink(wallet.name,getPageUrl());});}
      else{button.type='button';button.disabled=!entry&&!external;}
      button.className = 'wallet-option';
      if(external&&!link)button.addEventListener('click',()=>{
        dialog.querySelector('#wallet-picker-hint').textContent=t('请打开 {wallet}，进入它的浏览器，粘贴下方网址。','Open {wallet}, go to its browser and paste the URL below.',{wallet:wallet.name});
        if(copyUrl){copyUrl.value=getPageUrl()||'';copyUrl.focus();copyUrl.select();}
      });
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
      const status = document.createElement('small'); status.textContent = entry ? t('已检测到 · 点击连接', 'Detected · Connect') : link?t('在 App 中打开','Open in app'):external?t('复制网址到钱包','Copy URL to wallet'):t('未检测到', 'Not detected');
      copy.append(name, status); button.append(icon, copy);
      return button;
    }));
    dialog.querySelector('#wallet-picker-hint').textContent = wallets.size
      ? t('选择您要使用的钱包，再在该钱包中确认连接。', 'Choose your wallet, then confirm the connection in that wallet.')
      : mobile?t('选择钱包，在 App 内打开本场次后连接购买。没有跳转时，可复制下方网址到钱包内置浏览器。','Choose a wallet to open this pool in the app, then connect and buy. If it does not open, copy the URL into the wallet’s browser.')
      : t('未检测到钱包扩展。请在已安装钱包的浏览器中打开本页，或从手机钱包的浏览器访问。', 'No wallet detected. Open this page in a browser with a wallet extension, or in your mobile wallet’s browser.');
    if(copyUrl)copyUrl.value=getPageUrl()||'';
    if (focused) [...list.querySelectorAll('button'),...list.querySelectorAll('a')].find(button => button.dataset.walletId === focused)?.focus();
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
    registry.discover();render();
    if (!dialog.open) { dialog.showModal(); document.body.classList.add('wallet-picker-open'); }
    // Some mobile bridges inject after page load without announcing EIP-6963.
    stopDiscovery();
    discoveryTimer = setTimeout(scanWhileOpen, 250);
  } };
}
