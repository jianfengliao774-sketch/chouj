import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Wallet} from 'ethers';
const source=fs.readFileSync(new URL('../bem-production-site/web/sparkdraw-vault-ui.js',import.meta.url),'utf8');
function fixture(send=async()=>({keyImportAvailable:true,enrolled:true})){
  const nodes=new Map(),wallet=Wallet.createRandom(),requests=[];
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:false,open:false,listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},showModal(){this.open=true;},close(){this.open=false;this.listeners.close?.();},focus(){this.focused=true;}});return nodes.get(id);};
  const context=vm.createContext({$,Wallet,api:async(url,body)=>{requests.push({...body});return send();},refreshVault:async()=>{}});
  vm.runInContext('let busy=false,status={keyImportAvailable:true,enrolled:true};'+source.slice(source.indexOf('const clearPrivateKey='),source.indexOf("window.addEventListener('pagehide'")),context);
  $('vault-private-key').value=wallet.privateKey;
  return {$,requests,wallet};
}
test('save opens a dedicated code dialog; cancel clears its code without submitting a key',()=>{
  const {$,requests,wallet}=fixture();$('vault-code').value='999999';$('vault-key-save').onclick();
  assert.equal($('vault-key-dialog').open,true);assert.equal($('vault-key-dialog-address').textContent,wallet.address);
  assert.equal($('vault-key-code').value,'');assert.equal($('vault-key-code').focused,true);
  $('vault-key-code').value='123456';$('vault-key-cancel').onclick();
  assert.equal($('vault-key-dialog').open,false);assert.equal($('vault-key-code').value,'');assert.equal(requests.length,0);
});
test('confirmation uses only the dialog code, rejects invalid codes and blocks duplicate requests',async()=>{
  let finish;const {$,requests}=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  $('vault-code').value='999999';$('vault-key-save').onclick();$('vault-key-code').value='123';
  await $('vault-key-confirm').onclick();assert.equal(requests.length,0);
  $('vault-key-code').value='123456';const pending=$('vault-key-confirm').onclick();
  await $('vault-key-confirm').onclick();assert.equal(requests.length,1);assert.equal(requests[0].code,'123456');
  assert.equal($('vault-private-key').value,'');assert.equal($('vault-key-code').value,'');
  let prevented=false;$('vault-key-dialog').listeners.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);
  finish({keyImportAvailable:true,enrolled:true});await pending;
  assert.equal($('vault-key-dialog').open,false);assert.equal($('vault-key-confirm').disabled,false);
});
test('a key changed after the dialog opened cannot be submitted under the old address',async()=>{
  const {$,requests}=fixture();$('vault-key-save').onclick();$('vault-private-key').value=Wallet.createRandom().privateKey;
  $('vault-key-code').value='123456';await $('vault-key-confirm').onclick();assert.equal(requests.length,0);
  assert.match($('vault-key-error').textContent,/私钥已变化/);
});
