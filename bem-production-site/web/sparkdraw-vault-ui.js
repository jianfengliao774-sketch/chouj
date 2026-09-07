import {Interface,Wallet,getAddress,parseEther,formatEther,toQuantity} from 'ethers';
import {createWalletPicker} from './wallet-picker.js';
import {AUTOMATION_WALLET} from './automation-wallet.js';
import {SPARKDRAW as F} from './sparkdraw-config.js';
const $=id=>document.getElementById(id),container=new Interface(['function owner() view returns(address)','function EXEC_FEE() view returns(uint256)','function execute(address,uint256,bytes,uint8) payable returns(bytes)']);
let status=null,provider=null,account=null,busy=false;
const states={paused:'已暂停',running:'自动运行中',awaiting_gas:'等待补充 BNB Gas',preparing:'正在准备开奖交易',transaction_pending:'交易已提交，等待上链',confirming:'正在确认交易',attention:'需要检查执行状态',transaction_reverted:'上一笔未成功，正在重新检查'};
async function api(url,body){const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000),...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(r.status===401){$('vault-code').value='';$('vault-setup-secret').textContent='';$('vault-setup-detail').hidden=true;$('admin-content').hidden=true;$('login-panel').hidden=false;}if(!r.ok)throw Error(d.error||'读取失败');return d;}
async function refreshVault(){if($('admin-content').hidden)return;try{status=await api('/api/admin/vault');const w=status.worker;
  $('keeper-address').textContent=w?.address||AUTOMATION_WALLET;$('vault-enrollment').hidden=status.enrolled||!status.configured;
  $('vault-key-save').disabled=!status.keyImportAvailable||!status.enrolled;
  $('vault-key-state').textContent=!status.keyImportAvailable?'私钥导入功能正在配置':status.savedKey?(w?.keyId===status.savedKey.id?'私钥已加密保存，当前执行钱包已切换。':'私钥已加密保存，正在切换执行钱包。'):'尚未导入你的私钥；当前使用服务器生成的钱包。';
  $('vault-enable').disabled=!status.configured;$('vault-disable').disabled=!status.enrolled;
  $('vault-status').textContent=!status.configured?'保险箱配置中':!status.enrolled?'请先绑定谷歌验证器':!w?.online?'自动开奖服务正在连接':states[w.state]||w.state;
  $('keeper-balance').textContent=w?'Gas 余额：'+formatEther(w.balanceWei)+' BNB':'Gas 余额读取中';
  $('keeper-limits').textContent=w?`本日已用 ${formatEther(w.spentTodayWei)} BNB · 每日预算上限 ${formatEther(w.dailyLimitWei)} BNB · 单笔网络费上限 ${formatEther(w.maxTransactionFeeWei)} BNB`:'';
  $('keeper-transactions').replaceChildren(...(w?.history||[]).slice(0,8).map(row=>{const p=document.createElement('p'),a=document.createElement('a');a.textContent=`${row.pool} BEM 第 ${row.round} 期 · ${row.method} · ${row.success?'成功':'未成功'}`;a.href='https://bscscan.com/tx/'+row.hash;a.target='_blank';a.rel='noopener noreferrer';p.append(a);return p;}));
}catch(e){$('vault-message').textContent=e.message;}}
$('vault-setup').onclick=async()=>{try{const setup=await api('/api/admin/vault/setup',{});$('vault-setup-secret').textContent=setup.secret;$('vault-setup-detail').hidden=false;}catch(e){$('vault-message').textContent=e.message;}};
async function control(enabled){if(busy)return;busy=true;try{const d=await api('/api/admin/vault/control',{code:$('vault-code').value.trim(),enabled,enroll:!status?.enrolled});status=d;$('vault-code').value='';$('vault-setup-secret').textContent='';$('vault-setup-detail').hidden=true;$('vault-message').textContent=enabled?'已开启；Gas 到账后后台自动执行。':'已暂停新的开奖交易。';await refreshVault();}catch(e){$('vault-message').textContent=e.message;}finally{busy=false;}}
$('vault-enable').onclick=()=>control(true);$('vault-disable').onclick=()=>control(false);
const clearPrivateKey=()=>{$('vault-private-key').value='';$('vault-key-preview').textContent='输入私钥后显示地址';};
function previewKey(){try{const key=$('vault-private-key').value.trim();if(!/^(0x)?[a-fA-F0-9]{64}$/.test(key))throw Error();const address=new Wallet(key.startsWith('0x')?key:'0x'+key).address;$('vault-key-preview').textContent=address;return address;}catch{$('vault-key-preview').textContent='请输入有效的私钥';return null;}}
$('vault-private-key').addEventListener('input',previewKey);
$('vault-key-save').onclick=async()=>{if(busy)return;const expectedAddress=previewKey();if(!expectedAddress)return;busy=true;$('vault-key-save').disabled=true;
  try{const request={privateKey:$('vault-private-key').value.trim(),expectedAddress,code:$('vault-code').value.trim()};clearPrivateKey();$('vault-code').value='';
    try{status=await api('/api/admin/vault/key',request);}finally{request.privateKey='';request.code='';}
    $('vault-key-message').textContent='私钥已加密保存。后台切换后会自动开奖；请确保新钱包有 BNB 支付 Gas。';await refreshVault();
  }catch(e){$('vault-key-message').textContent=e.message;}finally{busy=false;$('vault-key-save').disabled=!status?.keyImportAvailable||!status?.enrolled;}};
window.addEventListener('pagehide',clearPrivateKey);
const picker=createWalletPicker({dialog:$('wallet-picker'),onChange(){},onSelect:async e=>{try{const accounts=await e.provider.request({method:'eth_requestAccounts'});provider=e.provider;account=getAddress(accounts[0]);$('keeper-funding-account').textContent=account;}catch(e){$('keeper-funding-status').textContent='连接未完成，请重试。';}}});
$('keeper-connect').onclick=()=>picker.open();
$('keeper-fund').onclick=async()=>{if(busy)return;if(!provider)return picker.open();busy=true;try{
  const vault=await api('/api/admin/vault'),target=getAddress(vault.worker?.address||AUTOMATION_WALLET);
  if(!vault.worker?.online||(vault.savedKey&&vault.savedKey.id!==vault.worker.keyId))throw Error('执行钱包正在切换，请稍后拨款');
  const amount=$('keeper-funding-amount').value;if(!['0.001','0.003','0.005'].includes(amount))throw Error('拨款金额无效');
  const [accounts,chain]=await Promise.all([provider.request({method:'eth_accounts'}),provider.request({method:'eth_chainId'})]);
  account=getAddress(accounts[0]);if(BigInt(chain)!==56n)throw Error('请将钱包切换至 BNB 主网');
  const owner=container.decodeFunctionResult('owner',await provider.request({method:'eth_call',params:[{to:F.revenue,data:container.encodeFunctionData('owner')},'latest']}))[0];
  if(owner!==account)throw Error('请使用当前持有 13061 容器的钱包');
  const available=BigInt(await provider.request({method:'eth_getBalance',params:[F.revenue,'latest']}));if(available<parseEther(amount))throw Error('容器 BNB 余额不足');
  const executionFee=container.decodeFunctionResult('EXEC_FEE',await provider.request({method:'eth_call',params:[{to:F.revenue,data:container.encodeFunctionData('EXEC_FEE')},'latest']}))[0];
  if(executionFee>200000000000000n)throw Error('容器调用费已高于 0.0002 BNB，请重新核对费用');
  const tx={from:account,to:F.revenue,value:toQuantity(executionFee),data:container.encodeFunctionData('execute',[target,parseEther(amount),'0x',0])};
  const [estimate,price]=await Promise.all([provider.request({method:'eth_estimateGas',params:[tx]}),provider.request({method:'eth_gasPrice'})]);
  const gas=(BigInt(estimate)*120n+99n)/100n;if(gas>500000n||gas*BigInt(price)>1000000000000000n)throw Error('本次网络费用偏高，请稍后重试');
  const latest=await provider.request({method:'eth_accounts'});if(getAddress(latest[0])!==account||BigInt(await provider.request({method:'eth_chainId'}))!==56n)throw Error('钱包已变化，请重新核对');
  const checked=await api('/api/admin/vault');if(checked.worker?.address!==target||(checked.savedKey&&checked.savedKey.id!==checked.worker.keyId))throw Error('执行钱包已变化，请重新核对拨款');
  $('keeper-funding-status').textContent=`请在钱包确认：容器拨出 ${amount} BNB 至 ${target}；你的钱包另付 ${formatEther(executionFee)} BNB 容器调用费，以及最高 ${formatEther(gas*BigInt(price))} BNB 网络费。`;
  const hash=await provider.request({method:'eth_sendTransaction',params:[{...tx,gas:toQuantity(gas),gasPrice:price}]});
  $('keeper-funding-status').textContent='拨款已提交，正在等待链上确认：'+hash;
}catch(e){$('keeper-funding-status').textContent=e.code===4001?'已取消拨款。':e.message;}finally{busy=false;}};
new MutationObserver(()=>{if($('admin-content').hidden){clearPrivateKey();$('vault-code').value='';$('vault-setup-secret').textContent='';$('vault-setup-detail').hidden=true;}else refreshVault();}).observe($('admin-content'),{attributes:true,attributeFilter:['hidden']});
setInterval(refreshVault,5000);refreshVault();
