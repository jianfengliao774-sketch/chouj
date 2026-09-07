import test from 'node:test';
import assert from 'node:assert/strict';
import {walletRequestRejected} from '../bem-production-site/web/wallet-request-errors.js';
test('explicit wallet rejection codes work at provider wrapper boundaries',()=>{
  for(const error of [{code:4001},{code:'4001'},{code:'ACTION_REJECTED'},{code:-32603,data:{originalError:{code:4001}}},{info:{error:{code:4001}}}])assert.equal(walletRequestRejected(error),true);
});
test('a timeout, generic wallet failure, or circular object cannot be mistaken for rejection',()=>{
  const circular={code:-32603};circular.cause=circular;
  for(const error of [circular,{code:-32000},{message:'timeout'},{message:'user rejected'},null])assert.equal(walletRequestRejected(error),false);
});
