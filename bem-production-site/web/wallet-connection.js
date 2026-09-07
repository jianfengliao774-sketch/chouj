// Restore only accounts already authorized by the wallet. Never request permissions here.
const KEY = 'sparkdraw:preferred-wallet';

export function createWalletSession({ storage, onRestore, version,
  probeTimeoutMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let generation = 0;
  function preference() { try { return JSON.parse(storage.getItem(KEY) || 'null'); } catch { return null; } }
  function remember(entry) {
    try { storage.setItem(KEY, JSON.stringify({ rdns: entry.rdns || '', name: entry.rdns ? '' : entry.name || '' })); } catch {}
  }
  const cancel = () => { generation++; };

  function probe(entry) {
    // Native bridges sometimes never settle after an app resumes. The deadline
    // covers both reads together; a late reply cannot restore or start another read.
    return new Promise(resolve => {
      let active = true;
      const finish = result => {
        if (!active) return;
        active = false; clearTimer(timer); resolve(result);
      };
      const timer = setTimer(() => finish({ unavailable: true }), probeTimeoutMs);
      void (async () => {
        try {
          const accounts = await entry.provider.request({ method: 'eth_accounts' });
          if (!active) return;
          if (!Array.isArray(accounts)) return finish({ unavailable: true });
          if (!accounts.length) return finish({ authorized: null });
          if (!/^0x[0-9a-fA-F]{40}$/.test(accounts[0] || '')) return finish({ unavailable: true });
          const chainId = await entry.provider.request({ method: 'eth_chainId' });
          finish({ authorized: { entry, account: accounts[0], chainId } });
        } catch { finish({ unavailable: true }); }
      })();
    });
  }

  async function restore(entries) {
    const run = ++generation, revision = version(), saved = preference();
    const candidates = [...entries.values()].filter(entry => !saved ||
      (saved.rdns ? entry.rdns === saved.rdns : entry.name === saved.name));
    const results = await Promise.all(candidates.map(probe));
    const authorized = results.flatMap(result => result.authorized ? [result.authorized] : []);
    // An unanswered provider could also be authorized. Never guess between it
    // and another wallet. A saved choice excludes unrelated providers before probing.
    if (run !== generation || revision !== version() || results.some(result => result.unavailable) || authorized.length !== 1) return false;
    await onRestore(authorized[0]); remember(authorized[0].entry); return true;
  }
  return { restore, remember, cancel };
}
