import {Wallet,formatEther} from 'ethers';
import {AUTOMATION_WALLET} from './automation-wallet.js';
const $=id=>document.getElementById(id);
let status=null,busy=false;
const states={paused:'已暂停',authorization_expired:'3 天授权已到期，请重新验证开启',running:'自动运行中',awaiting_gas:'等待补充 BNB Gas',preparing:'正在准备开奖交易',transaction_pending:'交易已提交，等待上链',confirming:'正在确认交易',attention:'需要检查执行状态',transaction_reverted:'上一笔未成功，正在重新检查'};
const workerErrors={CONTAINER_OWNER_MISMATCH:'保险箱钱包不是当前 13061 容器持有人，无法补充 Gas。',CONTAINER_FEE_CHANGED:'容器调用费超过上限，未发送拨款。',CONTAINER_GAS_BALANCE_LOW:'13061 容器 BNB 不足，暂时无法补充 Gas。',FUNDING_BOOTSTRAP_GAS_REQUIRED:'执行钱包需先保留少量 BNB 支付容器调用费和网络费。',VAULT_KEY_UNAVAILABLE:'后台暂时无法读取已保存的加密私钥，请检查服务器文件权限。',VAULT_KEY_INVALID:'加密私钥校验未通过，请检查服务器加密凭据。',IMPORTED_WALLET_HAS_PENDING_TRANSACTION:'新钱包还有待确认交易，确认后会自动继续切换。',KEY_ROTATION_REQUIRES_PAUSE:'等待当前交易完成并暂停后切换钱包。',GAS_BALANCE_LOW:'执行钱包 BNB 不足，请补充 Gas。',RPC_OR_IO_UNAVAILABLE:'链上节点或服务器读写暂时不可用，正在重试。'};
async function api(url,body){const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000),...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(r.status===401){$('vault-code').value='';$('vault-setup-secret').textContent='';$('vault-setup-detail').hidden=true;$('admin-content').hidden=true;$('login-panel').hidden=false;}if(!r.ok)throw Error(d.error||'读取失败');return d;}
async function refreshVault(){if($('admin-content').hidden)return;try{status=await api('/api/admin/vault');const w=status.worker;
  $('keeper-address').textContent=w?.address||AUTOMATION_WALLET;$('vault-enrollment').hidden=status.enrolled||!status.configured;
  $('vault-key-save').disabled=!status.keyImportAvailable||!status.enrolled;
  $('vault-key-state').textContent=!status.keyImportAvailable?'私钥导入功能正在配置':status.savedKey?(w?.keyId===status.savedKey.id?'私钥已加密保存，当前执行钱包已切换。':'私钥已加密保存，正在切换执行钱包。'):'尚未导入你的私钥；当前使用服务器生成的钱包。';
  $('vault-enable').disabled=!status.configured;$('vault-disable').disabled=!status.enrolled;
  $('vault-auth-fields').hidden=!!status.authorizationActive;$('vault-enable').hidden=!!status.authorizationActive;
  if(status.authorizationActive)$('vault-code').value='';
  $('vault-authorization-status').textContent=status.authorizationActive?'已授权 3 天，有效至 '+new Date(status.authorizationExpiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）。':status.authorizationExpiresAt?'授权已到期，请验证后继续。':'开启时验证一次，授权有效 72 小时。';
  $('vault-status').textContent=!status.configured?'保险箱配置中':!status.enrolled?'请先绑定谷歌验证器':!w?.online?'自动开奖服务正在连接':w.error?(workerErrors[w.error]||'后台执行暂未完成：'+w.error):states[w.state]||w.state;
  $('keeper-balance').textContent=w?'Gas 余额：'+formatEther(w.balanceWei)+' BNB':'Gas 余额读取中';
  $('keeper-limits').textContent=w?`本日费用（含容器调用费）${formatEther(w.spentTodayWei)} BNB · 每日预算上限 ${formatEther(w.dailyLimitWei)} BNB · 单笔网络费上限 ${formatEther(w.maxTransactionFeeWei)} BNB`:'';
  $('keeper-transactions').replaceChildren(...(w?.history||[]).slice(0,8).map(row=>{const p=document.createElement('p'),a=document.createElement('a');a.textContent=row.method==='fundGas'?`容器自动补充 Gas · ${row.success?'成功':'未成功'}`:`${row.pool} BEM 第 ${row.round} 期 · ${row.method} · ${row.success?'成功':'未成功'}`;a.href='https://bscscan.com/tx/'+row.hash;a.target='_blank';a.rel='noopener noreferrer';p.append(a);return p;}));
}catch(e){$('vault-message').textContent=e.message;}}
$('vault-setup').onclick=async()=>{try{const setup=await api('/api/admin/vault/setup',{});$('vault-setup-secret').textContent=setup.secret;$('vault-setup-detail').hidden=false;}catch(e){$('vault-message').textContent=e.message;}};
async function control(enabled){if(busy)return;busy=true;try{const d=await api('/api/admin/vault/control',{code:$(enabled?'vault-code':'vault-stop-code').value.trim(),enabled,enroll:!status?.enrolled});status=d;$('vault-code').value='';$('vault-stop-code').value='';$('vault-setup-secret').textContent='';$('vault-setup-detail').hidden=true;$('vault-message').textContent=enabled?'已授权 3 天；后台自动开奖，无需逐笔验证。':'已关闭自动开奖。';if(!enabled)$('vault-stop-dialog').close();await refreshVault();}catch(e){$(enabled?'vault-message':'vault-stop-error').textContent=e.message;}finally{busy=false;}}
$('vault-enable').onclick=()=>control(true);$('vault-disable').onclick=()=>{$('vault-stop-code').value='';$('vault-stop-error').textContent='';$('vault-stop-dialog').showModal();$('vault-stop-code').focus();};
$('vault-stop-confirm').onclick=()=>control(false);$('vault-stop-cancel').onclick=()=>{$('vault-stop-code').value='';$('vault-stop-dialog').close();};
$('vault-stop-dialog').addEventListener('close',()=>{$('vault-stop-code').value='';});
const clearPrivateKey=()=>{$('vault-private-key').value='';$('vault-key-preview').textContent='输入私钥后显示地址';};
function previewKey(){try{const key=$('vault-private-key').value.trim();if(!/^(0x)?[a-fA-F0-9]{64}$/.test(key))throw Error();const address=new Wallet(key.startsWith('0x')?key:'0x'+key).address;$('vault-key-preview').textContent=address;return address;}catch{$('vault-key-preview').textContent='请输入有效的私钥';return null;}}
$('vault-private-key').addEventListener('input',previewKey);
$('vault-key-save').onclick=async()=>{if(busy)return;const expectedAddress=previewKey();if(!expectedAddress)return;busy=true;$('vault-key-save').disabled=true;
  try{const request={privateKey:$('vault-private-key').value.trim(),expectedAddress,code:$('vault-code').value.trim()};clearPrivateKey();$('vault-code').value='';
    try{status=await api('/api/admin/vault/key',request);}finally{request.privateKey='';request.code='';}
    $('vault-key-message').textContent='私钥已加密保存。后台切换后会自动开奖；请确保新钱包有 BNB 支付 Gas。';await refreshVault();
  }catch(e){$('vault-key-message').textContent=e.message;}finally{busy=false;$('vault-key-save').disabled=!status?.keyImportAvailable||!status?.enrolled;}};
window.addEventListener('pagehide',clearPrivateKey);
new MutationObserver(()=>{if($('admin-content').hidden){clearPrivateKey();$('vault-code').value='';$('vault-stop-code').value='';$('vault-stop-dialog').close();$('vault-setup-secret').textContent='';$('vault-setup-detail').hidden=true;}else refreshVault();}).observe($('admin-content'),{attributes:true,attributeFilter:['hidden']});
setInterval(refreshVault,5000);refreshVault();
