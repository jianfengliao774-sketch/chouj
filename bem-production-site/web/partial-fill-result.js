import { formatUnits } from 'ethers';
import { isVerifiedFormalResult } from './formal-player-transactions.js';

export function partialFillMessage(record, lang = 'zh') {
  if (!isVerifiedFormalResult(record) || record.status !== 'confirmed' || record.kind !== 'buy') return null;
  const result = record.evidence, requested = BigInt(result.requested), filled = BigInt(result.filled);
  if (filled >= requested) return null;
  const english = lang === 'en', remaining = requested - filled;
  return Object.freeze({
    title: english ? 'Purchase result confirmed' : '购买结果已确认',
    quantity: english ? `Requested ${requested} tickets; purchased ${filled}; ${remaining} not purchased.`
      : `申请购买 ${requested} 份，实际成交 ${filled} 份，${remaining} 份未成交。`,
    payment: english ? `Paid ${formatUnits(result.paid, 8)} BEM. ${formatUnits(result.unspent, 8)} BEM was not charged and remains in your wallet.`
      : `实际扣款 ${formatUnits(result.paid, 8)} BEM；其余 ${formatUnits(result.unspent, 8)} BEM 未扣除，仍在您的钱包中。`,
    note: english ? 'Allocation follows transaction order onchain. Network gas is separate.'
      : '份额按链上交易顺序分配，网络 Gas 费用另计。',
    link: english ? 'View confirmed transaction' : '查看已确认交易',
    close: english ? 'Got it' : '知道了',
    href: `https://bscscan.com/tx/${record.hash}`,
  });
}

export function createPartialFillResult({ document = globalThis.document, getLanguage = () => 'zh' } = {}) {
  let dialog = null, current = null;
  const shown = new Set(), queue = [];
  const fields = {};
  function render() {
    if (!current) return;
    const message = partialFillMessage(current, getLanguage());
    if (!message) return;
    for (const name of ['title', 'quantity', 'payment', 'note', 'link', 'close']) fields[name].textContent = message[name];
    fields.link.href = message.href;
  }
  function showNext() {
    if (current || !queue.length) return;
    current = queue.shift();
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'partial-fill-result';
      dialog.setAttribute('aria-labelledby', 'partial-fill-title');
      for (const [name, tag] of [['title', 'h2'], ['quantity', 'p'], ['payment', 'p'], ['note', 'p'], ['link', 'a'], ['close', 'button']]) {
        fields[name] = document.createElement(tag); fields[name].className = `partial-fill-${name}`; dialog.append(fields[name]);
      }
      fields.title.id = 'partial-fill-title'; fields.link.target = '_blank'; fields.link.rel = 'noopener noreferrer';
      fields.close.type = 'button'; fields.close.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => { current = null; showNext(); });
      document.body.append(dialog);
    }
    render(); dialog.showModal();
  }
  return {
    accept(records = []) {
      for (const record of records) {
        if (!partialFillMessage(record, getLanguage()) || shown.has(record.hash)) continue;
        shown.add(record.hash); queue.push(record);
      }
      showNext();
    },
    refreshLanguage: render,
  };
}
