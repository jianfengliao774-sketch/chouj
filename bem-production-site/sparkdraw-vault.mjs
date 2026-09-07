import fs from 'node:fs/promises';
import path from 'node:path';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {privateWallet} from './sparkdraw-key-store.mjs';
export function decodeBase32(value){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const c of value.toUpperCase().replace(/=+$/,'')){const n=alphabet.indexOf(c);if(n<0)throw Error('INVALID_TOTP_CONFIGURATION');bits+=n.toString(2).padStart(5,'0');}return Buffer.from(bits.match(/.{8}/g).map(x=>parseInt(x,2)));}
export function totpCode(secret,counter){const input=Buffer.alloc(8);input.writeBigUInt64BE(BigInt(counter));const h=createHmac('sha1',decodeBase32(secret)).update(input).digest(),offset=h[h.length-1]&15;return String((h.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}
export function matchTotp(secret,code,now,last=-1){if(!/^\d{6}$/.test(code))return null;const counter=Math.floor(now/30000);for(const n of [counter,counter-1,counter+1])if(n>last&&timingSafeEqual(Buffer.from(totpCode(secret,n)),Buffer.from(code)))return n;return null;}
export async function createSparkDrawVault({directory,secret,statusFile,keyStore=null,controlFile=path.join(directory,'automation-control.json'),now=()=>Date.now()}){
  const file=path.join(directory,'sparkdraw-vault-state.json');let queue=Promise.resolve(),attempts=[];
  let state;try{state=JSON.parse(await fs.readFile(file,'utf8'));if(state.version!==1||typeof state.enrolled!=='boolean')throw Error('INVALID_VAULT_STATE');}catch(e){if(e.code!=='ENOENT')throw e;state={version:1,enrolled:false,lastCounter:-1};}
  const atomic=async(file,data)=>{await fs.writeFile(file+'.tmp',JSON.stringify(data),{mode:file===controlFile?0o640:0o600});await fs.rename(file+'.tmp',file);};
  async function status(){let worker=null;try{worker=JSON.parse(await fs.readFile(statusFile,'utf8'));}catch{}const fresh=worker&&now()-Date.parse(worker.updatedAt)<45000;
    const savedKey=keyStore?await keyStore.status():null;
    return{configured:!!secret,enrolled:state.enrolled,keyImportAvailable:!!keyStore,savedKey,worker:worker?{...worker,online:!!fresh}:null};}
  async function setup(username){if(!secret||state.enrolled)throw Object.assign(Error('验证器已绑定或保险箱尚未配置。'),{authStatus:409});const issuer='Tapeout SparkDraw';return{secret,uri:`otpauth://totp/${encodeURIComponent(issuer+':'+username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`};}
  async function authorize({code,enroll=false,username}){
    if(!secret)throw Object.assign(Error('保险箱尚未配置。'),{authStatus:409});
    attempts=attempts.filter(at=>now()-at<300000);if(attempts.length>=5)throw Object.assign(Error('验证码尝试过多，请五分钟后再试。'),{authStatus:429});
    if(enroll===state.enrolled)throw Object.assign(Error(state.enrolled?'已绑定，请使用启停操作。':'请先绑定谷歌验证器。'),{authStatus:409});
    const counter=matchTotp(secret,String(code||''),now(),state.lastCounter);
    if(counter===null){attempts.push(now());throw Object.assign(Error('验证码无效、过期或已经使用。'),{authStatus:403});}
    state={version:1,enrolled:true,lastCounter:counter,username};await atomic(file,state);attempts=[];
  }
  function update({code,enabled,enroll=false,username}){const run=queue.then(async()=>{
    if(typeof enabled!=='boolean')throw Object.assign(Error('启停参数无效。'),{authStatus:400});
    const current=await status();if(enabled&&current.savedKey&&current.worker?.keyId!==current.savedKey.id)throw Object.assign(Error('新钱包正在切换，请稍后再试。'),{authStatus:409});
    await authorize({code,enroll,username});await atomic(controlFile,{enabled,updatedAt:new Date(now()).toISOString(),by:username});return status();
  });queue=run.catch(()=>{});return run;}
  function importKey({code,privateKey,expectedAddress,username}){const run=queue.then(async()=>{
    if(!keyStore)throw Object.assign(Error('私钥保险箱尚未配置。'),{authStatus:409});
    const address=privateWallet(privateKey).address;if(address.toLowerCase()!==String(expectedAddress).toLowerCase())throw Object.assign(Error('钱包地址与私钥不一致。'),{authStatus:400});
    const current=await status(),w=current.worker;
    let control;try{control=JSON.parse(await fs.readFile(controlFile,'utf8'));}catch{}
    if(!w?.online||w.enabled||w.state!=='paused'||w.pending||control?.enabled||control?.resumeAfterKeyId)throw Object.assign(Error('请先暂停自动开奖，等待当前交易完成后再替换钱包。'),{authStatus:409});
    await authorize({code,username});
    const saved=await keyStore.save(privateKey,address);
    await atomic(controlFile,{enabled:false,resumeAfterKeyId:saved.id,updatedAt:new Date(now()).toISOString(),by:username});
    return status();
  });queue=run.catch(()=>{});return run;}
  return{status,setup,update,importKey};
}
