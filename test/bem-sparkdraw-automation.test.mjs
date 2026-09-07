import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Wallet} from 'ethers';
import {ACTIONS,chooseAutomationAction,validateAutomationTransaction} from '../bem-production-site/sparkdraw-automation-core.mjs';
import {profile} from '../bem-production-site/web/sparkdraw-profiles.js';
import {createSparkDrawVault,totpCode,matchTotp} from '../bem-production-site/sparkdraw-vault.mjs';
test('automation respects sealed beacon time, timeout precedence and claim deadlines',()=>{
  assert.equal(chooseAutomationAction({status:3,trigger:1000,available:500},499).wait,500);
  assert.equal(chooseAutomationAction({status:3,trigger:1000,available:500},500).method,'fulfillRandomness');
  assert.equal(chooseAutomationAction({status:4,trigger:1000},999).method,'settle');
  assert.equal(chooseAutomationAction({status:4,trigger:1000},1000).method,'openRefunds');
  assert.equal(chooseAutomationAction({status:1,sold:9500,early:900,trigger:1000},900).method,'closeRound');
  assert.equal(chooseAutomationAction({status:5,prizeAmount:10n,prizeDeadline:1000},999).wait,1000);
  assert.equal(chooseAutomationAction({status:5,prizeAmount:10n,prizeDeadline:1000},1000).method,'burnUnclaimedPrize');
  assert.ok(chooseAutomationAction({status:5,prizeClaimed:true},1000).done);
  assert.ok(chooseAutomationAction({status:6,unclaimed:0n},1000).done);
  assert.equal(chooseAutomationAction({status:6,unclaimed:1n,trigger:100},86500).method,'burnUnclaimed');
});
test('signer permits only fixed-pool maintenance, never a transfer or approval',async()=>{
  const wallet=Wallet.createRandom(),tx={chainId:56n,type:0,to:profile('0.1').address,value:0n,nonce:0,gasLimit:100000n,gasPrice:50000000n,data:ACTIONS.encodeFunctionData('settle',[1])};
  assert.equal(validateAutomationTransaction(await wallet.signTransaction(tx),wallet.address).method,'settle');
  for(const change of [{value:1n},{to:wallet.address},{chainId:1n},{gasPrice:1000000000n},{data:'0x095ea7b3'}]){const raw=await wallet.signTransaction({...tx,...change});assert.throws(()=>validateAutomationTransaction(raw,wallet.address));}
});
test('Google TOTP vectors, enrollment, replay protection and rate limiting',async t=>{
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';assert.equal(totpCode(secret,1),'287082');assert.equal(matchTotp(secret,'287082',59000),1);assert.equal(matchTotp(secret,'287082',59000,1),null);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sparkdraw-vault-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));let time=59000;
  const vault=await createSparkDrawVault({directory,secret,statusFile:path.join(directory,'missing'),now:()=>time});
  assert.equal((await vault.status()).enrolled,false);assert.ok((await vault.setup('admin')).uri.startsWith('otpauth://totp/'));
  await vault.update({code:'287082',enabled:true,enroll:true,username:'admin'});assert.equal(JSON.parse(await fs.readFile(path.join(directory,'automation-control.json'))).enabled,true);
  await assert.rejects(()=>vault.setup('admin'));await assert.rejects(()=>vault.update({code:'287082',enabled:false,username:'admin'}));
  time=90000;await vault.update({code:totpCode(secret,3),enabled:false,username:'admin'});assert.equal(JSON.parse(await fs.readFile(path.join(directory,'automation-control.json'))).enabled,false);
  assert.ok(!JSON.stringify(await vault.status()).includes(secret));
  for(let n=0;n<5;n++)await assert.rejects(()=>vault.update({code:'xxxxxx',enabled:true,username:'admin'}));
  await assert.rejects(()=>vault.update({code:totpCode(secret,4),enabled:true,username:'admin'}),e=>e.authStatus===429);
});
