import test from 'node:test';
import assert from 'node:assert/strict';
import {availablePurchaseLimit,clampPurchaseCount} from '../bem-production-site/web/purchase-limit.js';

test('maximum considers per-purchase cap, pool stock and wallet round quota',()=>{
  assert.equal(availablePurchaseLimit(0,0),5000);
  assert.equal(availablePurchaseLimit(6501,0),3499);
  assert.equal(availablePurchaseLimit(6501,3000),2000);
  assert.equal(availablePurchaseLimit(9999,0),1);
  assert.equal(availablePurchaseLimit(10000,0),0);
  assert.equal(availablePurchaseLimit(6000,5000),0);
});

test('unknown or stale scope data cannot invent an available quota',()=>{
  for(const [sold,held] of [[null,0],[undefined,0],[0,null],[10001,0],[0,5001],[0,-1]]){
    assert.equal(availablePurchaseLimit(sold,held),null);
  }
});

test('5000 shortcut and typed quantities clamp to remaining stock, preserving empty editing',()=>{
  assert.equal(clampPurchaseCount('5000',2000),'2000');
  assert.equal(clampPurchaseCount('5000',3499),'3499');
  assert.equal(clampPurchaseCount('100',2000),'100');
  for(const value of ['1000','3000','5000'])assert.equal(clampPurchaseCount(value,800),'800');
  assert.equal(clampPurchaseCount('500',800),'500');
  assert.equal(clampPurchaseCount('0',2000),'1');
  assert.equal(clampPurchaseCount('5000',0),'0');
  assert.equal(clampPurchaseCount('5000',null),'5000');
  assert.equal(clampPurchaseCount('',2000),'');
});
