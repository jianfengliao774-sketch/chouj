import test from 'node:test';
import assert from 'node:assert/strict';
import { enforcePurchaseGasBudget, PURCHASE_GAS_FEE_CAP } from '../bem-production-site/web/purchase-gas-policy.js';

test('purchase budget uses the full gas allowance and current price, including one-wei boundary',()=>{
  assert.equal(PURCHASE_GAS_FEE_CAP,10n**15n);
  assert.equal(enforcePurchaseGasBudget('buy',1_000_000n,1_000_000_000n),PURCHASE_GAS_FEE_CAP);
  assert.throws(()=>enforcePurchaseGasBudget('buy',1n,PURCHASE_GAS_FEE_CAP+1n),{code:'GAS_FEE_CAP_EXCEEDED'});
  assert.equal(enforcePurchaseGasBudget('buy',16_777_216n,50_000_000n),838_860_800_000_000n);
  assert.throws(()=>enforcePurchaseGasBudget('buy',16_777_216n,100_000_000n),{code:'GAS_FEE_CAP_EXCEEDED'});
});
test('approvals have the same per-transaction ceiling; recovery and settlement are not purchase actions',()=>{
  assert.throws(()=>enforcePurchaseGasBudget('approve',2_000_000n,1_000_000_000n),{code:'GAS_FEE_CAP_EXCEEDED'});
  assert.equal(enforcePurchaseGasBudget('refund',2_000_000n,1_000_000_000n),undefined);
  assert.equal(enforcePurchaseGasBudget('settle',2_000_000n,1_000_000_000n),undefined);
  for(const price of [0n,-1n])assert.throws(()=>enforcePurchaseGasBudget('buy',1n,price),{code:'GAS_PRICE_UNAVAILABLE'});
});
