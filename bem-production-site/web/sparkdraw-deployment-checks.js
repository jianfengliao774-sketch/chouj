import {Interface,getAddress,getCreateAddress,keccak256} from 'ethers';
import {SPARKDRAW as F} from './sparkdraw-config.js';
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const need=(ok,message)=>{if(!ok)throw Error(message);};
export function artifactFor(artifacts,kind){
  need(kind==='verifier'||Object.hasOwn(F.pools,kind),'未知部署类型');
  return artifacts.contracts[kind==='verifier'?'DrandEvmnetVerifier':'TapeoutSparkDrawBSC'];
}
export function deploymentData(artifacts,kind,verifier){
  const a=artifactFor(artifacts,kind);
  need(keccak256(a.bytecode)===a.creationHash,'部署代码哈希不一致');
  if(kind==='verifier')return a.bytecode;
  return a.bytecode+new Interface(a.abi).encodeDeploy([F.pools[kind].units,getAddress(verifier)]).slice(2);
}
export function verifyRuntime(code,artifact){
  need(/^0x[0-9a-f]+$/i.test(code)&&code.length===artifact.runtime.length,'合约代码长度不一致');
  let masked=code.toLowerCase();
  for(const {start,length} of Object.values(artifact.immutableReferences).flat()){
    need(Number.isSafeInteger(start)&&length===32&&(start+length)*2+2<=code.length,'不可变字段位置无效');
    masked=masked.slice(0,2+start*2)+'0'.repeat(length*2)+masked.slice(2+(start+length)*2);
  }
  need(keccak256(masked)===artifact.runtimeHash,'合约运行代码不一致');
}
export function verifyCreation({tx,receipt,block,latest,code,data,artifact}){
  need(tx&&receipt&&block,'交易尚未确认，请稍后刷新');
  need(BigInt(tx.chainId)===56n&&same(tx.from,F.deployer)&&tx.to==null&&BigInt(tx.value)===0n
    &&same(tx.input??tx.data,data),'部署交易的钱包或参数不一致');
  need(same(tx.hash,receipt.transactionHash)&&same(receipt.from,F.deployer)&&receipt.to==null
    &&BigInt(receipt.status)===1n&&same(tx.blockHash,receipt.blockHash)&&same(block.hash,receipt.blockHash)
    &&BigInt(tx.blockNumber)===BigInt(receipt.blockNumber)&&BigInt(block.number)===BigInt(receipt.blockNumber), '部署回执尚未成功或不在当前主链');
  need(BigInt(latest)-BigInt(receipt.blockNumber)+1n>=12n,'已上链，等待 12 个区块确认');
  const address=getCreateAddress({from:F.deployer,nonce:BigInt(tx.nonce)});
  need(same(receipt.contractAddress,address),'创建地址不一致');
  verifyRuntime(code,artifact);
  return address;
}
