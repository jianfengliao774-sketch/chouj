const WORD_COUNT = 40;
const UINT256_MAX = (1n << 256n) - 1n;
const LAST_WORD_MAX = (1n << 16n) - 1n;

function bitmapWord(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
  } else if (typeof value === 'string') {
    if (!/^(?:[0-9]+|0[xX][0-9a-fA-F]+)$/.test(value)) return null;
  } else if (typeof value !== 'bigint') {
    return null;
  }
  try {
    const word = BigInt(value);
    return word >= 0n && word <= UINT256_MAX ? word : null;
  } catch {
    return null;
  }
}

// Event ticket indices are zero-based; the numbers shown to players start at 1.
// Reject incomplete or inconsistent evidence instead of displaying a partial list.
export function purchasedTicketNumbers(purchase) {
  if (!purchase || !Number.isSafeInteger(purchase.tickets)
      || purchase.tickets < 0 || purchase.tickets > 10000
      || !Array.isArray(purchase.bitmap) || purchase.bitmap.length !== WORD_COUNT) return null;

  const numbers = [];
  for (let index = 0; index < WORD_COUNT; index++) {
    let word = bitmapWord(purchase.bitmap[index]);
    if (word === null || (index === WORD_COUNT - 1 && word > LAST_WORD_MAX)) return null;
    for (let bit = 0; word > 0n; bit++, word >>= 1n) {
      if (word & 1n) numbers.push(index * 256 + bit + 1);
    }
  }
  return numbers.length === purchase.tickets ? numbers : null;
}
