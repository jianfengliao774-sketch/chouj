import fs from 'node:fs/promises';
import path from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {Wallet,getAddress} from 'ethers';

const aad=r=>Buffer.from(JSON.stringify([1,r.id,r.address,r.createdAt]));
export function privateWallet(value){
  try{if(typeof value!=='string'||! /^(0x)?[a-fA-F0-9]{64}$/.test(value.trim()))throw Error();return new Wallet(value.trim().replace(/^(?!0x)/,'0x'));}
  catch{throw Object.assign(Error('私钥格式无效，请核对后重新输入。'),{authStatus:400});}
}
export function sealKey(privateKey,master,createdAt=new Date().toISOString()){
  if(!Buffer.isBuffer(master)||master.length!==32)throw Error('INVALID_VAULT_MASTER');
  const wallet=privateWallet(privateKey),record={version:1,id:randomUUID(),address:wallet.address,createdAt};
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(aad(record));
  const clear=Buffer.from(wallet.privateKey.slice(2),'hex');
  try{record.ciphertext=Buffer.concat([cipher.update(clear),cipher.final()]).toString('base64');record.iv=iv.toString('base64');record.tag=cipher.getAuthTag().toString('base64');return record;}finally{clear.fill(0);}
}
export function openKey(record,master){
  try{
    if(record.version!==1||getAddress(record.address)!==record.address)throw Error();
    const cipher=createDecipheriv('aes-256-gcm',master,Buffer.from(record.iv,'base64'));cipher.setAAD(aad(record));cipher.setAuthTag(Buffer.from(record.tag,'base64'));
    const clear=Buffer.concat([cipher.update(Buffer.from(record.ciphertext,'base64')),cipher.final()]);
    try{const wallet=new Wallet('0x'+clear.toString('hex'));if(wallet.address!==record.address)throw Error();return wallet;}finally{clear.fill(0);}
  }catch{throw Error('VAULT_KEY_INVALID');}
}
export async function readActiveKey(directory){try{return JSON.parse(await fs.readFile(path.join(directory,'active.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error('VAULT_KEY_UNAVAILABLE');}}
export function createKeyStore({directory,master}){
  if(!directory||!Buffer.isBuffer(master)||master.length!==32)return null;
  return{
    async status(){const r=await readActiveKey(directory);return r?{id:r.id,address:r.address,savedAt:r.createdAt}:null;},
    async save(privateKey,expectedAddress){
      const record=sealKey(privateKey,master);if(record.address.toLowerCase()!==String(expectedAddress).toLowerCase())throw Object.assign(Error('钱包地址与私钥不一致。'),{authStatus:400});
      const encoded=JSON.stringify(record);
      // Keep every encrypted import, including the previous executor key. No plaintext files.
      const archive=path.join(directory,record.id+'.json');
      await fs.writeFile(archive,encoded,{mode:0o640,flag:'wx'});await fs.chmod(archive,0o640);
      const temp=path.join(directory,'active-'+record.id+'.tmp');
      await fs.writeFile(temp,encoded,{mode:0o640,flag:'wx'});await fs.chmod(temp,0o640);await fs.rename(temp,path.join(directory,'active.json'));
      return{id:record.id,address:record.address,savedAt:record.createdAt};
    }
  };
}

export function rotateJournal(journal,record,{enabled,latestNonce,pendingNonce}){
  if(enabled||journal.pending)throw Error('KEY_ROTATION_REQUIRES_PAUSE');
  if(BigInt(latestNonce)!==BigInt(pendingNonce))throw Error('IMPORTED_WALLET_HAS_PENDING_TRANSACTION');
  // Retain the global spending budget, all history and outstanding round work across wallet changes.
  return{...journal,address:record.address,keyId:record.id,pending:null};
}
