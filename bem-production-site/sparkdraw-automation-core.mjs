import {Interface,Transaction,getAddress} from 'ethers';
import {POOL_IDS,profile} from './web/sparkdraw-profiles.js';
import {SPARKDRAW as F} from './web/sparkdraw-config.js';
export const AUTOMATION_LIMITS=Object.freeze({chainId:56n,gasLimit:16777216n,gasPrice:100000000n,fee:1000000000000000n,daily:3000000000000000n});
export const ACTIONS=new Interface(['function closeRound(uint256)','function fulfillRandomness(uint256,bytes)','function settle(uint256)','function openRefunds(uint256)','function burnUnclaimed(uint256)','function burnUnclaimedPrize(uint256)']);
export const FUNDING=new Interface(['function owner() view returns(address)','function EXEC_FEE() view returns(uint256)','function execute(address,uint256,bytes,uint8) payable returns(bytes)']);
export const FUNDING_LIMITS=Object.freeze({threshold:1000000000000000n,amount:3000000000000000n,executionFee:200000000000000n,gas:500000n});
export function chooseAutomationAction(r,now){
  if(r.status===0)return{wait:now+3};
  if([1,2,3,4].includes(r.status)&&r.trigger&&now>=r.trigger)return{method:'openRefunds'};
  if(r.status===1)return r.sold>=9500&&r.early&&now>=r.early?{method:'closeRound'}:{wait:Math.min(r.early||Infinity,r.trigger,now+3)};
  if(r.status===3)return now>=r.available?{method:'fulfillRandomness'}:{wait:r.available};
  if(r.status===4)return{method:'settle'};
  if(r.status===5)return r.prizeClaimed||r.prizeBurned||!r.prizeAmount?{done:true}:now>=r.prizeDeadline?{method:'burnUnclaimedPrize'}:{wait:r.prizeDeadline};
  if(r.status===6)return r.principalBurned||r.unclaimed===0n?{done:true}:now>=r.trigger+86400?{method:'burnUnclaimed'}:{wait:r.trigger+86400};
  throw Error('UNEXPECTED_ROUND_STATE');
}
export function validateAutomationTransaction(raw,address){
  const tx=Transaction.from(raw),p=POOL_IDS.map(profile).find(p=>p.address.toLowerCase()===tx.to?.toLowerCase());
  if(getAddress(tx.from)!==getAddress(address)||tx.chainId!==56n||tx.type!==0||tx.gasLimit<=0n||tx.gasLimit>AUTOMATION_LIMITS.gasLimit||!tx.gasPrice||tx.gasPrice>AUTOMATION_LIMITS.gasPrice||tx.gasPrice*tx.gasLimit+tx.value>AUTOMATION_LIMITS.fee)throw Error('INVALID_AUTOMATION_TRANSACTION');
  if(tx.to?.toLowerCase()===F.revenue.toLowerCase()){
    const c=FUNDING.parseTransaction({data:tx.data});
    if(!c||c.name!=='execute'||c.args[0]!==getAddress(address)||c.args[1]!==FUNDING_LIMITS.amount||c.args[2]!=='0x'||c.args[3]!==0n||tx.value>FUNDING_LIMITS.executionFee||tx.gasLimit>FUNDING_LIMITS.gas||FUNDING.encodeFunctionData(c.fragment,c.args)!==tx.data)throw Error('INVALID_CONTAINER_FUNDING');
    return{tx,poolId:'13061',method:'fundGas',roundId:'0'};
  }
  if(!p||tx.value!==0n)throw Error('INVALID_AUTOMATION_TRANSACTION');
  const call=ACTIONS.parseTransaction({data:tx.data});if(!call||call.args[0]<=0n)throw Error('INVALID_AUTOMATION_ACTION');
  if(call.name==='fulfillRandomness'&&!/^0x[0-9a-f]{128}$/i.test(call.args[1]))throw Error('INVALID_BEACON_SIGNATURE');
  return{tx,poolId:p.id,method:call.name,roundId:String(call.args[0])};
}
