// Recover receipts and verify immutable rules directly from public BNB Chain data.
// This script contains no signing or transaction submission methods.
import fs from 'node:fs';
import {Interface,keccak256,toQuantity,formatUnits} from 'ethers';
import {DEPLOY_FIXED as F,ADDRESS_READBACK,expectedReadback,assertDeploymentReadback,assertDeploymentTransaction,deploymentData,verifyDeploymentRuntime} from '../bem-production-site/web/deploy-container-guards.js';
const endpoint='https://bsc-dataseed.bnbchain.org';
const base=new URL('../outputs/bem-raffle-2075/production-v2/',import.meta.url);
const recovered=JSON.parse(fs.readFileSync(new URL('deployment-discovery-readonly.json',base)));
const names={test:'Bem2075Raffle13061Test1BSC',pool10:'Bem2075Raffle13061Pool10BSC',pool50:'Bem2075Raffle13061Pool50BSC',production:'Bem2075Raffle13061BSC'};
let serial=0;
async function reads(calls){
 if(calls.length>20)throw Error('Bounded batches only');
 if(calls.length>5){const result=[];for(let i=0;i<calls.length;i+=5)result.push(...await reads(calls.slice(i,i+5)));return result;}
 const payload=calls.map(([method,params])=>{if(!['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_getTransactionReceipt','eth_getBalance'].includes(method))throw Error('Read-only method required');return{jsonrpc:'2.0',id:++serial,method,params};});
 const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});if(!res.ok)throw Error(`RPC ${res.status}`);
 const rows=await res.json();if(!Array.isArray(rows))throw Error(`Invalid RPC batch response: ${JSON.stringify(rows)}`);
 return payload.map(p=>{const row=rows.find(r=>r.id===p.id);if(!row||row.error||!Object.hasOwn(row,'result'))throw Error(`RPC failed for ${p.method} ${JSON.stringify(p.params)}: ${JSON.stringify(row?.error ?? row ?? rows.map(r=>({id:r.id,error:r.error})))}`);return row.result;});
}
const [chain,latest]=await reads([['eth_chainId',[]],['eth_getBlockByNumber',['latest',false]]]);if(BigInt(chain)!==56n)throw Error('Wrong chain');
const report={schemaVersion:3,checkedAt:new Date().toISOString(),readOnly:true,rpcUrl:endpoint,snapshot:{blockNumber:Number(BigInt(latest.number)),blockHash:latest.hash,timeUtc:new Date(Number(BigInt(latest.timestamp))*1000).toISOString()},deployments:[]};
const subAbi=new Interface(['function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)']);
const [subscriptionRaw]=await reads([['eth_call',[{to:F.coordinator,data:subAbi.encodeFunctionData('getSubscription',[F.subscriptionId])},latest.number]]]);
const subscription=subAbi.decodeFunctionResult('getSubscription',subscriptionRaw);
report.vrf={subscriptionId:F.subscriptionId,owner:subscription.owner,linkBalanceBaseUnits:subscription.balance.toString(),nativeBalanceWei:subscription.nativeBalance.toString(),nativeBalanceBnb:formatUnits(subscription.nativeBalance,18),requestCount:subscription.reqCount.toString(),consumers:[...subscription.consumers],paymentMode:'native BNB',feeSufficiencyVerified:false};
const ext=new Interface(['function accountOf(address,uint256) view returns(address)','function isOpened(address,uint256) view returns(bool)','function ownerOf(uint256) view returns(address)','function owner() view returns(address)','function token() view returns(uint256 chainId,address tokenContract,uint256 tokenId)','function EXEC_FEE() view returns(uint256)','function decimals() view returns(uint8)']);
async function externalRead(to,name,args=[]){const [raw]=await reads([['eth_call',[{to,data:ext.encodeFunctionData(name,args)},latest.number]]]);return ext.decodeFunctionResult(name,raw);}
async function containerBinding(address,nft,id){
 const [registry,opened,nftOwner,owner,token,execFee]=await Promise.all([externalRead(F.opener,'accountOf',[nft,id]),externalRead(F.opener,'isOpened',[nft,id]),externalRead(nft,'ownerOf',[id]),externalRead(address,'owner'),externalRead(address,'token'),externalRead(address,'EXEC_FEE')]);
 const [code,balance]=await reads([['eth_getCode',[address,latest.number]],['eth_getBalance',[address,latest.number]]]);
 const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
 const verified=code!=='0x'&&opened[0]===true&&same(registry[0],address)&&token.chainId===56n&&same(token.tokenContract,nft)&&token.tokenId===BigInt(id)&&same(owner[0],nftOwner[0]);
 return{address,bindingVerified:verified,token:token.toObject(),owner:owner[0],nftOwner:nftOwner[0],registryAccount:registry[0],registryOpened:opened[0],runtimeCodeHash:keccak256(code),nativeBalanceWei:BigInt(balance).toString(),execFeeWei:execFee[0].toString(),execFeeBnb:formatUnits(execFee[0],18)};
}
report.dependencies={authorizationContainer:await containerBinding(F.authorizationContainer,F.processor,2075),revenueContainer:await containerBinding(F.revenueContainer,F.revenueNft,13061),bemDecimals:Number((await externalRead(F.bem,'decimals'))[0])};
if(!report.dependencies.authorizationContainer.bindingVerified||!report.dependencies.revenueContainer.bindingVerified||report.dependencies.bemDecimals!==8)throw Error('Current container/token dependency mismatch');
for(const mode of Object.keys(names))if(recovered.contracts.filter(row=>row.matches.length===1&&row.matches[0]===mode).length!==1)throw Error(`Expected exactly one recovered ${mode} deployment`);
for(const candidate of recovered.contracts.filter(row=>row.matches.length===1)){
 const mode=candidate.matches[0],artifact=JSON.parse(fs.readFileSync(new URL(names[mode]+'.artifact.json',base))),abi=new Interface(artifact.abi);
 const [deploymentBlockRaw]=await reads([['eth_call',[{to:candidate.address,data:abi.encodeFunctionData('sourceVerifiedAtBlock',[])},latest.number]]]);
 const deploymentBlock=abi.decodeFunctionResult('sourceVerifiedAtBlock',deploymentBlockRaw)[0];
 const [block,code]=await reads([['eth_getBlockByNumber',[toQuantity(deploymentBlock),true]],['eth_getCode',[candidate.address,latest.number]]]);
 const runtimeCodeHash=verifyDeploymentRuntime(code,artifact,mode);
 const transaction=block.transactions.find(tx=>tx.from.toLowerCase()===candidate.owner.toLowerCase()&&BigInt(tx.nonce)===BigInt(candidate.nonce)&&tx.to==null);
 if(!transaction)throw Error('Creation not present in its immutable deployment block');
 const [receipt]=await reads([['eth_getTransactionReceipt',[transaction.hash]]]);
 const header={...block,transactions:block.transactions.map(tx=>tx.hash)};
  const createdAddress=assertDeploymentTransaction({transaction,receipt,block:header,latestBlock:latest.number,account:candidate.owner,data:await deploymentData(artifact,mode),nonce:candidate.nonce});
  if(createdAddress.toLowerCase()!==candidate.address.toLowerCase())throw Error('Recovered address differs from verified creation address');
 const fixed=expectedReadback(mode,deploymentBlock),getters=new Interface(Object.keys(fixed).map(name=>`function ${name}() view returns(${Object.hasOwn(ADDRESS_READBACK,name)?'address':typeof fixed[name]==='boolean'?'bool':['keyHash','CIRCUIT_HASH'].includes(name)?'bytes32':'uint256'})`));
 const keys=Object.keys(fixed),values={};
  const historical={blockNumber:Number(deploymentBlock),verified:false,values:null,reason:null};
  try {
   for(let offset=0;offset<keys.length;offset+=20){const part=keys.slice(offset,offset+20);const raw=await reads(part.map(name=>['eth_call',[{to:candidate.address,data:getters.encodeFunctionData(name,[])},toQuantity(deploymentBlock)]]));part.forEach((name,i)=>values[name]=getters.decodeFunctionResult(name,raw[i])[0]);}
   assertDeploymentReadback(values,mode,deploymentBlock);historical.verified=true;historical.values={...values};
  } catch(error) {
   if(!/missing trie node|historical state|state is not available|state unavailable|pruned/i.test(error.message))throw error;
   historical.reason=error.message;
  }
  const immutableKeys=keys.filter(name=>!['seriesAuthorized','currentRoundId','totalLiability'].includes(name));
  const staticValues={};
  for(let offset=0;offset<immutableKeys.length;offset+=20){const part=immutableKeys.slice(offset,offset+20);const raw=await reads(part.map(name=>['eth_call',[{to:candidate.address,data:abi.encodeFunctionData(name,[])},latest.number]]));part.forEach((name,i)=>staticValues[name]=abi.decodeFunctionResult(name,raw[i])[0]);}
  for(const name of immutableKeys)if(String(staticValues[name]).toLowerCase()!==String(fixed[name]).toLowerCase())throw Error(`Current immutable ${name} mismatch`);
  const [testOnlyRaw]=await reads([['eth_call',[{to:candidate.address,data:abi.encodeFunctionData('TEST_ONLY',[])},latest.number]]]);
  staticValues.TEST_ONLY=abi.decodeFunctionResult('TEST_ONLY',testOnlyRaw)[0];if(staticValues.TEST_ONLY!==(mode==='test'))throw Error('TEST_ONLY mismatch');
 const dynamicNames=['seriesAuthorized','currentRoundId','nextRoundOpensAt','totalLiability'];const rawDynamic=await reads(dynamicNames.map(name=>['eth_call',[{to:candidate.address,data:abi.encodeFunctionData(name,[])},latest.number]]));
 const dynamic=Object.fromEntries(dynamicNames.map((name,i)=>[name,abi.decodeFunctionResult(name,rawDynamic[i])[0]]));
 const roundIds=[dynamic.currentRoundId,...(dynamic.currentRoundId>1n?[dynamic.currentRoundId-1n]:[])];
 const rawRounds=await reads(roundIds.map(id=>['eth_call',[{to:candidate.address,data:abi.encodeFunctionData('rounds',[id])},latest.number]]));
  const rounds=rawRounds.map((raw,i)=>({roundId:roundIds[i].toString(),...abi.decodeFunctionResult('rounds',raw).toObject()}));
  for(const round of rounds){
   round.statusName=['Unstarted','Funding','Locked','Requested','Ready','Settled','Refunding'][Number(round.status)];
   const names=['drawTiming','refundClaimDeadline','refundedPrincipal','unclaimedPrincipalBurned'];
   const raws=await reads(names.map(name=>['eth_call',[{to:candidate.address,data:abi.encodeFunctionData(name,[round.roundId])},latest.number]]));
   round.timing=abi.decodeFunctionResult('drawTiming',raws[0]).toObject();
   for(let i=1;i<names.length;i++)round[names[i]]=abi.decodeFunctionResult(names[i],raws[i])[0];
  }
 const [canonical]=await reads([['eth_getBlockByNumber',[receipt.blockNumber,false]]]);if(canonical.hash!==receipt.blockHash)throw Error('Creation block reorg');
  const tokenAbi=new Interface(['function balanceOf(address) view returns(uint256)']);
  const [balanceRaw,nativeBalance]=await reads([['eth_call',[{to:F.bem,data:tokenAbi.encodeFunctionData('balanceOf',[candidate.address])},latest.number]],['eth_getBalance',[candidate.address,latest.number]]]);
  const bemBalance=tokenAbi.decodeFunctionResult('balanceOf',balanceRaw)[0];
  const vrfConsumer=subscription.consumers.some(a=>a.toLowerCase()===candidate.address.toLowerCase());
  const blockers=[];
  if(!dynamic.seriesAuthorized)blockers.push({code:'SERIES_NOT_AUTHORIZED',detail:'Fixed 2075 authorization container must call authorizeSeries(); deployer and revenue container cannot call it directly.'});
  if(!vrfConsumer)blockers.push({code:'VRF_CONSUMER_MISSING',detail:'Add this exact new contract to the fixed subscription. Authorization of the old game does not cover this deployment.'});
  if(subscription.nativeBalance===0n)blockers.push({code:'VRF_NATIVE_BALANCE_EMPTY',detail:'Requests use native BNB billing; the subscription has no BNB.'});
  if(bemBalance<dynamic.totalLiability)blockers.push({code:'INSOLVENT_ESCROW',detail:'BEM balance is lower than totalLiability.'});
  const now=BigInt(latest.timestamp);
  if(rounds[0].status===0n)blockers.push({code:'ROUND_NOT_OPEN',detail:dynamic.seriesAuthorized?'Open the next round after predecessor resolution and cooldown.':'Authorization opens the first funding round.'});
  if(rounds[0].status===1n&&now>=rounds[0].fundingDeadline)blockers.push({code:'FUNDING_EXPIRED',detail:'Reconcile expired funding and refund period before starting another test.'});
  if(rounds[0].status>1n)blockers.push({code:'ROUND_NOT_FUNDING',detail:'Reconcile current state before accepting fresh test purchases.'});
  if(rounds[1]&&![5n,6n].includes(rounds[1].status))blockers.push({code:'PREVIOUS_ROUND_UNRESOLVED',detail:'Finish the existing draw; requested and ready draws cannot be refunded or rerolled.'});
  if(now<dynamic.nextRoundOpensAt)blockers.push({code:'ROUND_COOLDOWN',detail:'Next round opening timestamp has not arrived.'});
  const record={mode,contractName:artifact.contractName,address:candidate.address,deployer:candidate.owner,nonce:candidate.nonce,chainId:56,transactionHash:transaction.hash,deploymentBlock:Number(deploymentBlock),blockHash:receipt.blockHash,confirmations:Number(BigInt(latest.number)-deploymentBlock+1n),runtimeCodeHash,creationInputHash:keccak256(await deploymentData(artifact,mode)),creationTransactionVerified:true,exactLatestArtifactRuntimeVerified:true,sourceSha256s:artifact.sourceSha256s,fixedRules:artifact.fixedRules,fixedBindings:artifact.fixedBindings,constructorArgs:[F.subscriptionId,3,250000],deploymentVerified:true,staticGettersBlock:report.snapshot.blockNumber,staticGettersVerified:true,staticGetters:staticValues,deploymentBlockGetters:historical,current:{...dynamic,rounds,vrfConsumer,bemBalanceBaseUnits:bemBalance,nativeBalanceWei:BigInt(nativeBalance),escrowSolvent:bemBalance>=dynamic.totalLiability},readiness:{readyForPurchaseAtSnapshot:blockers.length===0,blockers,unverifiedPrerequisites:['At least two funded participants are required to fill 10000 tickets because each address is capped at 5000.','Participant BEM approvals and transaction gas, and availability of a settlement caller, are not verified.','Positive subscription balance does not prove current VRF fee sufficiency or successful fulfillment.']}};
 report.deployments.push(record);console.log(JSON.stringify({mode,address:record.address,transactionHash:record.transactionHash,deploymentBlock:record.deploymentBlock,confirmations:record.confirmations,seriesAuthorized:dynamic.seriesAuthorized,vrfConsumer:record.current.vrfConsumer}));
}
const [canonicalLatest]=await reads([['eth_getBlockByNumber',[latest.number,false]]]);if(canonicalLatest.hash!==latest.hash)throw Error('Snapshot block reorg');
 report.limitations=['Public read-only verification only: no token approval, purchase, VRF callback, settlement, refund or wallet control was tested.'];
 if(report.deployments.some(row=>!row.deploymentBlockGetters.verified))report.limitations.push('The RPC prunes historical state (missing trie node). Deployment-block getters are explicitly unverified; exact successful creation input, current runtime and immutable getters are independently verified.');
 fs.writeFileSync(new URL('recovered-deployments-verified.json',base),JSON.stringify(report,(_,value)=>typeof value==='bigint'?value.toString():value,2)+'\n');
console.log(JSON.stringify({complete:true,verified:report.deployments.length,vrf:report.vrf}));
