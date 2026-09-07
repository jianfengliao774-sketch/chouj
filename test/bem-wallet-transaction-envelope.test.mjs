import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface } from 'ethers';
import { verifyWalletTransactionEnvelope } from '../bem-production-site/web/wallet-transaction-envelope.js';
const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/bem-test-wallet-wrapped-buy.json', import.meta.url)));
const tx = fixture.transaction;
const wallet = new Interface(['function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)']);
const game = new Interface(['function buy(uint256,uint32)']);
const intent = { hash: tx.hash, account: tx.from, to: '0xE7D8dF903050d875f09cE1BBcE20E837fB55bC0c',
  data: game.encodeFunctionData('buy', [1n, 1000]), nonce: String(BigInt(tx.nonce) - 1n), nonceFloor: String(BigInt(tx.nonce) - 1n) };
function encoded(mutator) {
  const values = wallet.decodeFunctionData('redeemDelegations', tx.input).toArray(true);
  mutator(values); return wallet.encodeFunctionData('redeemDelegations', values);
}
test('actual MetaMask envelope preserves target, value, calldata, buyer and returned hash', () => {
  const result = verifyWalletTransactionEnvelope(tx, intent);
  assert.equal(result.wrapped, true); assert.equal(result.outerTo, tx.to); assert.equal(result.actualNonce, '543');
  assert.throws(() => verifyWalletTransactionEnvelope(tx, intent, { allowWrappedNonce: false }), /NONCE_MISMATCH/);
  assert.equal(verifyWalletTransactionEnvelope(tx, { ...intent, nonce: '543' }, { allowWrappedNonce: false }).wrapped, true);
});
test('unrelated hashes, senders, network, manager and native transfers cannot resolve the intent', () => {
  for (const change of [{ hash: '0x' + 'b'.repeat(64) }, { from: '0x' + '1'.repeat(40) }, { chainId: '0x1' },
    { to: '0x' + '2'.repeat(40) }, { value: '0x1' }, { nonce: '0x21d' }, { input: tx.input + '00' }]) {
    assert.throws(() => verifyWalletTransactionEnvelope({ ...tx, ...change }, intent));
  }
});
test('extra calls, try modes, hidden calldata matches and altered execution content are rejected', () => {
  const variants = [
    encoded(values => values[1][0] = '0x01' + '0'.repeat(62)),
    encoded(values => values[0].push(values[0][0])),
    encoded(values => values[1].push(values[1][0])),
    encoded(values => values[2].push(values[2][0])),
    encoded(values => values[2][0] = '0x' + '1'.repeat(40) + values[2][0].slice(42)),
    encoded(values => values[2][0] = values[2][0].slice(0, 42) + '0'.repeat(63) + '1' + values[2][0].slice(106)),
    encoded(values => values[2][0] = values[2][0].slice(0, 106) + game.encodeFunctionData('buy', [1n, 999]).slice(2)),
    encoded(values => { values[0][0] += intent.data.slice(2); values[2][0] = '0x'; }),
  ];
  for (const input of variants) assert.throws(() => verifyWalletTransactionEnvelope({ ...tx, input }, intent));
});
test('unwrapped transactions keep the original exact nonce constraint', () => {
  const direct = { ...tx, to: intent.to, input: intent.data };
  assert.throws(() => verifyWalletTransactionEnvelope(direct, intent), /NONCE_MISMATCH/);
  assert.equal(verifyWalletTransactionEnvelope(direct, { ...intent, nonce: '543' }).wrapped, false);
});
