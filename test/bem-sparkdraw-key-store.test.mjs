import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Wallet} from 'ethers';
import {sealKey,openKey,createKeyStore,rotateJournal,privateWallet} from '../bem-production-site/sparkdraw-key-store.mjs';
import {createSparkDrawVault,totpCode} from '../bem-production-site/sparkdraw-vault.mjs';

test('key encryption authenticates ciphertext and address and never persists plaintext',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sparkdraw-key-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const master=randomBytes(32),wallet=Wallet.createRandom(),r=sealKey(wallet.privateKey,master);
  assert.equal(openKey(r,master).address,wallet.address);
  for(const change of [{address:Wallet.createRandom().address},{id:'other'},{ciphertext:randomBytes(32).toString('base64')}])assert.throws(()=>openKey({...r,...change},master),/VAULT_KEY_INVALID/);
  assert.throws(()=>openKey(r,randomBytes(32)),/VAULT_KEY_INVALID/);
  assert.throws(()=>privateWallet('0x'+'0'.repeat(64)),e=>!e.message.includes('00000000'));
  const store=createKeyStore({directory,master});await store.save(wallet.privateKey,wallet.address);await store.save(wallet.privateKey,wallet.address);
  assert.equal((await fs.readdir(directory)).filter(x=>x.endsWith('.json')).length,3);
  for(const name of await fs.readdir(directory)){const text=await fs.readFile(path.join(directory,name),'utf8');assert.ok(!text.includes(wallet.privateKey.slice(2)));}
  const status=await store.status();assert.deepEqual(Object.keys(status).sort(),['address','id','savedAt']);
});

test('import requires fresh paused worker and one-use TOTP, then requests only this key to auto-start',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sparkdraw-import-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let now=60000;const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',statusFile=path.join(directory,'worker.json');
  const store=createKeyStore({directory,master:randomBytes(32)}),vault=await createSparkDrawVault({directory,secret,statusFile,keyStore:store,now:()=>now});
  await vault.update({code:totpCode(secret,2),enabled:false,enroll:true,username:'admin'});now=90000;
  const wallet=Wallet.createRandom(),input={code:totpCode(secret,3),privateKey:wallet.privateKey,expectedAddress:wallet.address,username:'admin'};
  const write=patch=>fs.writeFile(statusFile,JSON.stringify({updatedAt:new Date(now).toISOString(),enabled:false,state:'paused',pending:null,...patch}));
  await write({pending:{hash:'pending'}});await assert.rejects(()=>vault.importKey(input),e=>e.authStatus===409);
  await write({enabled:true});await assert.rejects(()=>vault.importKey(input));
  await write({updatedAt:new Date(0).toISOString()});await assert.rejects(()=>vault.importKey(input));
  await write({});await assert.rejects(()=>vault.importKey({...input,code:'000000'}),e=>e.authStatus===403);
  const saved=await vault.importKey(input);assert.equal(saved.savedKey.address,wallet.address);assert.ok(!JSON.stringify(saved).includes(wallet.privateKey.slice(2)));
  const control=JSON.parse(await fs.readFile(path.join(directory,'automation-control.json')));assert.equal(control.enabled,false);assert.equal(control.resumeAfterKeyId,saved.savedKey.id);
  await assert.rejects(()=>vault.update({code:input.code,enabled:true,username:'admin'}),e=>e.authStatus===409);
  await write({keyId:saved.savedKey.id,address:wallet.address});await assert.rejects(()=>vault.update({code:input.code,enabled:false,username:'admin'}),e=>e.authStatus===403);
  now=120000;await vault.update({code:totpCode(secret,4),enabled:false,username:'admin'});assert.equal(JSON.parse(await fs.readFile(path.join(directory,'automation-control.json'))).resumeAfterKeyId,undefined);
});

test('wallet rotation cannot abandon pending transactions or reset the daily budget',()=>{
  const journal={version:1,address:Wallet.createRandom().address,keyId:'old',pending:null,spending:{'2026-09-07':'2000000000000'},pools:{'0.1':{discovered:3}},history:[{hash:'old'}]};
  const record={id:'new',address:Wallet.createRandom().address},args={enabled:false,latestNonce:'0x7',pendingNonce:'0x7'};
  for(const change of [{enabled:true},{pendingNonce:'0x8'}])assert.throws(()=>rotateJournal(journal,record,{...args,...change}));
  assert.throws(()=>rotateJournal({...journal,pending:{hash:'old'}},record,args));
  const next=rotateJournal(journal,record,args);assert.equal(next.address,record.address);assert.equal(next.keyId,'new');assert.deepEqual(next.spending,journal.spending);assert.deepEqual(next.history,journal.history);assert.deepEqual(next.pools,journal.pools);assert.equal(journal.keyId,'old');
});
