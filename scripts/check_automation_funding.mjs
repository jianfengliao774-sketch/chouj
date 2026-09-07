// Read-only simulation: this never signs or broadcasts a transaction.
import {Interface,formatEther,toQuantity} from 'ethers';
import {SPARKDRAW as F} from '../bem-production-site/web/sparkdraw-config.js';
import {AUTOMATION_WALLET} from '../bem-production-site/web/automation-wallet.js';
const abi=new Interface(['function owner() view returns(address)','function EXEC_FEE() view returns(uint256)','function execute(address,uint256,bytes,uint8) payable returns(bytes)']);
const rpc=async(method,params)=>{const response=await fetch('https://bsc-dataseed.bnbchain.org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});const d=await response.json();if(d.error)throw Error(d.error.message);return d.result;};
const owner=abi.decodeFunctionResult('owner',await rpc('eth_call',[{to:F.revenue,data:abi.encodeFunctionData('owner')},'latest']))[0];
const fee=abi.decodeFunctionResult('EXEC_FEE',await rpc('eth_call',[{to:F.revenue,data:abi.encodeFunctionData('EXEC_FEE')},'latest']))[0];
const tx={from:owner,to:F.revenue,value:toQuantity(fee),data:abi.encodeFunctionData('execute',[AUTOMATION_WALLET,3000000000000000n,'0x',0])};
const gas=BigInt(await rpc('eth_estimateGas',[tx]));
console.log(JSON.stringify({owner,container:F.revenue,recipient:AUTOMATION_WALLET,simulatedAmountBNB:'0.003',containerExecutionFeeBNB:formatEther(fee),estimatedGas:String(gas),executorBalance:formatEther(await rpc('eth_getBalance',[AUTOMATION_WALLET,'latest'])),broadcast:false}));
