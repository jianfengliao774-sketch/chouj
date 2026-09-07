import {formatEther,toQuantity,getAddress} from 'ethers';
import artifacts from './sparkdraw-artifacts.json';
import {SPARKDRAW as F} from './sparkdraw-config.js';
import {deploymentData,same} from './sparkdraw-deployment-checks.js';
import {createWalletPicker} from './wallet-picker.js';
const $=id=>document.getElementById(id),key='sparkdraw-deployment-v5:'+F.deployer.toLowerCase();
const names={verifier:'共用随机数验证合约','0.1':'0.1 BEM 测试场','5':'5 BEM 正式场','10':'10 BEM 正式场','50':'50 BEM 正式场','100':'100 BEM 正式场'};
const order=['verifier','0.1','5','10','50','100'];
let wallet=null,account=null,epoch=0,selected='verifier',estimate=null,busy=false,registry={verifier:null,pools:{}},records={};
try{records=JSON.parse(localStorage.getItem(key)||'{}');}catch{$('notice').textContent='无法读取本地部署记录。请先恢复交易记录再继续。';}
const save=()=>localStorage.setItem(key,JSON.stringify(records));
const completed=kind=>kind==='verifier'?registry.verifier:registry.pools?.[kind];
const note=value=>{$('notice').textContent=value;};
const shortError=e=>e.code===4001||e.code==='ACTION_REJECTED'?'已取消钱包确认。':String(e.shortMessage??e.message??e).slice(0,180);
function render(){
  $('wallet-address').textContent=account??F.deployer;
  $('deploy-list').replaceChildren(...order.map(kind=>{
    const row=document.createElement('div');row.className='scope-note';
    const button=document.createElement('button');button.className=kind===selected?'':'secondary';button.textContent=(kind===selected?'已选择 · ':'')+names[kind];
    button.setAttribute('aria-pressed',String(kind===selected));
    button.disabled=busy||(kind!=='verifier'&&!registry.verifier);button.onclick=()=>{
      if(selected!==kind)estimate=null;
      selected=kind;render();
      note('已选择'+names[kind]+'。请在这里核对费用，再确认本笔部署。');
      $('deployment-actions').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
      $('deployment-actions').focus({preventScroll:true});
    };
    const text=document.createElement('p');const entry=completed(kind);
    if(entry){const a=document.createElement('a');a.href='https://bscscan.com/address/'+entry.address;a.textContent=entry.address;a.className='mono';a.target='_blank';a.rel='noopener noreferrer';text.append('已部署 · ',a);}
    else text.textContent=records[kind]?.hash?'已提交，等待核对':kind==='verifier'?'部署一次，五个场次共用':`容器 1% + 销毁 ${F.pools[kind].burnPercent}%`;
    row.append(button,text);return row;
  }));
  const active=records[selected],done=completed(selected),can=wallet&&same(account,F.deployer)&&!busy;
  $('selected-title').textContent=names[selected];
  $('estimate').disabled=!can||!!done||!!active;
  $('deploy').disabled=!can||!estimate||!!done||!!active;
  $('connect-wallet').disabled=busy;$('recover').disabled=busy;
  $('pending-status').textContent=active?.hash??(active?'钱包请求尚未核对，请在钱包里确认结果。':'');
  $('reset-rejected').hidden=!active||!!active.hash||busy;
  $('deployment-fee').textContent=estimate?`预计 ${formatEther(estimate.gas*estimate.gasPrice)} BNB；Gas 上限对应 ${formatEther(estimate.gasLimit*estimate.gasPrice)} BNB。`:done?'本合约已部署并登记。':'请选择“核对费用”，查看这笔部署交易。';
}
async function loadRegistry(){const r=await fetch('/api/sparkdraw/deployments',{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('服务器部署记录读取失败');const data=await r.json();if(data.version!==5||data.chainId!==56||!data.pools)throw Error('部署记录版本不一致');registry=data;render();}
async function identity(provider=wallet){
  if(!provider)throw Error('请先连接钱包');
  const [accounts,chain]=await Promise.all([provider.request({method:'eth_accounts'}),provider.request({method:'eth_chainId'})]);
  if(BigInt(chain)!==56n)throw Error('请将钱包切换到 BNB 主网');
  if(!same(accounts[0],F.deployer))throw Error('请使用指定的 0x7674…Ea53 钱包');
  return getAddress(accounts[0]);
}
async function run(fn){if(busy)return;busy=true;render();try{await fn();}catch(e){note(shortError(e));}finally{busy=false;render();}}
const picker=createWalletPicker({dialog:$('wallet-picker'),onChange(){},onSelect:({provider})=>run(async()=>{
  const selection=++epoch;await provider.request({method:'eth_requestAccounts'});
  if(BigInt(await provider.request({method:'eth_chainId'}))!==56n)await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});
  const address=await identity(provider);if(selection!==epoch)return;
  wallet=provider;account=address;estimate=null;
  const changed=()=>{if(wallet!==provider)return;++epoch;account=null;estimate=null;render();};
  provider.on?.('accountsChanged',changed);provider.on?.('chainChanged',changed);
  await loadRegistry();note('钱包已连接，请选择合约并核对本笔费用。');
})});
$('connect-wallet').onclick=()=>picker.open();
$('estimate').onclick=()=>run(async()=>{
  await loadRegistry();const kind=selected,provider=wallet,version=epoch;
  const from=await identity(provider);if(completed(kind)||records[kind])throw Error('已有部署记录，请核对结果');
  const data=deploymentData(artifacts,kind,registry.verifier?.address);
  const [rawGas,rawPrice]=await Promise.all([provider.request({method:'eth_estimateGas',params:[{from,data,value:'0x0'}]}),provider.request({method:'eth_gasPrice'})]);
  const gas=BigInt(rawGas),gasPrice=BigInt(rawPrice),gasLimit=(gas*115n+99n)/100n;
  if(gasLimit>16777216n)throw Error('部署 Gas 超过网络单笔上限');
  if(version!==epoch||selected!==kind||wallet!==provider)throw Error('钱包或所选合约已变化');
  estimate={kind,provider,version,from,data,gas,gasLimit,gasPrice,at:Date.now()};note('费用已核对，点击确认本笔部署，由钱包显示最终费用。');
});
const sendDeployment=()=>run(async()=>{
  const intent=estimate;if(!intent||Date.now()-intent.at>120000)throw Error('请重新核对费用');
  const from=await identity(intent.provider);
  if(epoch!==intent.version||selected!==intent.kind||wallet!==intent.provider)throw Error('钱包或所选合约已变化');
  await loadRegistry();records=JSON.parse(localStorage.getItem(key)||'{}');if(completed(intent.kind)||records[intent.kind])throw Error('已有部署记录，不重复发送');
  records[intent.kind]={requestedAt:Date.now(),from};save();render();
  try{
    const hash=await intent.provider.request({method:'eth_sendTransaction',params:[{from,data:intent.data,value:'0x0',chainId:'0x38',gas:toQuantity(intent.gasLimit)}]});
    if(!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('钱包未返回交易哈希，请先在钱包确认结果');
    records[intent.kind]={...records[intent.kind],hash};save();estimate=null;note('已提交部署，正在等待链上确认并保存到服务器。');
  }catch(e){if(e.code===4001||e.code==='ACTION_REJECTED'){delete records[intent.kind];save();}throw e;}
});
$('deploy').onclick=()=>navigator.locks?navigator.locks.request(key,{ifAvailable:true},lock=>lock?sendDeployment():note('另一个页面正在部署，请在该页面完成钱包确认。')):sendDeployment();
async function register(kind,hash){
  const r=await fetch('/api/sparkdraw/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,transactionHash:hash}),signal:AbortSignal.timeout(20000)});
  const result=await r.json();if(!r.ok)throw Error(result.error??'部署核对尚未完成');
  await loadRegistry();delete records[kind];save();estimate=null;note(names[kind]+'已部署并保存。');
}
$('recover').onclick=()=>run(async()=>{await register(selected,$('recovery-hash').value.trim());});
$('reset-rejected').onclick=()=>run(async()=>{
  // An unknown wallet response is not proof of cancellation. Recover its hash first.
  note('请查看钱包活动：已提交则填写交易哈希恢复；若钱包没有提交，请重新连接钱包后联系核对。未知结果不会自动重发。');
});
let polling=false;
setInterval(async()=>{if(polling||busy)return;polling=true;try{for(const kind of order){const entry=records[kind];if(entry?.hash&&!completed(kind)){try{await register(kind,entry.hash);}catch(e){note(shortError(e));}break;}}}finally{polling=false;}},4000);
$('compiler-version').textContent='编译器：'+artifacts.compiler;
loadRegistry().then(()=>note('先部署共用验证合约，然后依次部署五个场次。')).catch(e=>note(shortError(e)));render();
