import test from 'node:test';
import assert from 'node:assert/strict';
import { purchasedTicketNumbers } from '../bem-production-site/web/purchased-ticket-numbers.js';

const emptyBitmap = () => Array(40).fill('0');

test('decodes the first and last possible numbers and preserves display numbering', () => {
  const bitmap = emptyBitmap();
  bitmap[0] = '1';
  bitmap[39] = '32768';
  const numbers = purchasedTicketNumbers({ tickets: 2, bitmap });
  assert.deepEqual(numbers, [1, 10000]);
  assert.deepEqual(numbers.map(number => String(number).padStart(5, '0')), ['00001', '10000']);
});

test('decodes both sides of a uint256 word boundary without shifting a number', () => {
  const bitmap = emptyBitmap();
  bitmap[0] = '0xc000000000000000000000000000000000000000000000000000000000000000';
  bitmap[1] = '0x3';
  assert.deepEqual(purchasedTicketNumbers({ tickets: 4, bitmap }), [255, 256, 257, 258]);
});

test('returns sparse numbers in ascending order and accepts all supported word encodings', () => {
  const bitmap = emptyBitmap();
  bitmap[0] = 5;
  bitmap[1] = 3n;
  bitmap[10] = '0X10';
  bitmap[39] = '0x8001';
  assert.deepEqual(purchasedTicketNumbers({ tickets: 7, bitmap }), [1, 3, 257, 258, 2565, 9985, 10000]);
  assert.equal(bitmap[0], 5, 'decoding does not mutate the indexed purchase');
});

test('handles a full 5000-number purchase across whole and partial words', () => {
  const bitmap = emptyBitmap();
  bitmap.fill((2n ** 256n - 1n).toString(), 0, 19);
  bitmap[19] = (2n ** 136n - 1n).toString();
  assert.deepEqual(purchasedTicketNumbers({ tickets: 5000, bitmap }),
    Array.from({ length: 5000 }, (_, index) => index + 1));
});

test('supports every valid number including the final 16-bit word', () => {
  const bitmap = Array(40).fill(2n ** 256n - 1n);
  bitmap[39] = 65535n;
  assert.deepEqual(purchasedTicketNumbers({ tickets: 10000, bitmap }),
    Array.from({ length: 10000 }, (_, index) => index + 1));
});

test('uses the actual allocation count when fewer tickets than requested were purchased', () => {
  const bitmap = emptyBitmap();
  bitmap[0] = '11';
  assert.deepEqual(purchasedTicketNumbers({ tickets: 3, requested: 5000, requestedCount: 5000, bitmap }), [1, 2, 4]);
  assert.equal(purchasedTicketNumbers({ tickets: 5000, requested: 5000, bitmap }), null);
});

test('accepts an empty allocation only with a valid empty bitmap', () => {
  assert.deepEqual(purchasedTicketNumbers({ tickets: 0, bitmap: emptyBitmap() }), []);
  const bitmap = emptyBitmap();
  bitmap[0] = '1';
  assert.equal(purchasedTicketNumbers({ tickets: 0, bitmap }), null);
  assert.equal(purchasedTicketNumbers({ tickets: 1, bitmap: emptyBitmap() }), null);
});

test('rejects any bit beyond number 10000 even if the advertised count matches', () => {
  for (const word of ['65536', '65537', 1n << 255n]) {
    const bitmap = emptyBitmap();
    bitmap[39] = word;
    assert.equal(purchasedTicketNumbers({ tickets: word === '65537' ? 2 : 1, bitmap }), null);
  }
});

test('rejects malformed, negative, overflowing, and imprecise bitmap words', () => {
  const invalidWords = [undefined, null, true, {}, [], '', ' ', ' 1', '1 ', '+1', '-1',
    '1.0', '1e2', '0x', '0xgg', '0b1', '0o1', -1, -1n, 0.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, 1n << 256n, (1n << 256n).toString(), `0x1${'0'.repeat(64)}`];
  for (const word of invalidWords) {
    const bitmap = emptyBitmap();
    bitmap[0] = '1';
    bitmap[20] = word;
    assert.equal(purchasedTicketNumbers({ tickets: 1, bitmap }), null,
      `invalid word ${String(word)} must not expose even the valid first number`);
  }
});

test('accepts a safely represented numeric word without coercing unsafe numbers', () => {
  const bitmap = emptyBitmap();
  bitmap[0] = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(purchasedTicketNumbers({ tickets: 53, bitmap }),
    Array.from({ length: 53 }, (_, index) => index + 1));
});

test('requires all 40 words and a valid integer allocation count', () => {
  for (const purchase of [undefined, null, {}, { tickets: 0 },
    { tickets: 0, bitmap: [] }, { tickets: 0, bitmap: Array(39).fill('0') },
    { tickets: 0, bitmap: Array(41).fill('0') }, { tickets: 0, bitmap: Array(40) },
    { tickets: 0, bitmap: '0'.repeat(40) }]) {
    assert.equal(purchasedTicketNumbers(purchase), null);
  }
  for (const tickets of [undefined, null, '0', 0n, true, -1, 1.5, 10001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(purchasedTicketNumbers({ tickets, bitmap: emptyBitmap() }), null);
  }
});

test('rejects both undercounted and overcounted evidence', () => {
  const bitmap = emptyBitmap();
  bitmap[0] = '3';
  assert.equal(purchasedTicketNumbers({ tickets: 1, bitmap }), null);
  assert.equal(purchasedTicketNumbers({ tickets: 3, bitmap }), null);
});
