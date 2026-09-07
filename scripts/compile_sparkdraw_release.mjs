import fs from 'node:fs';
import {keccak256} from 'ethers';
import {compileDrandCandidate} from './lib/compile_drand_candidate.mjs';
const compiled=compileDrandCandidate();
const contracts={};
for(const name of ['DrandEvmnetVerifier','TapeoutSparkDrawBSC']) {
  const value=compiled.contracts[name+'.sol'][name];
  const bytecode='0x'+value.evm.bytecode.object,runtime='0x'+value.evm.deployedBytecode.object;
  if((bytecode.length-2)/2>49152||(runtime.length-2)/2>24576)throw Error('Contract exceeds deployment size limit');
  contracts[name]={name,abi:value.abi,bytecode,runtime,creationHash:keccak256(bytecode),
    runtimeHash:keccak256(runtime),immutableReferences:value.evm.deployedBytecode.immutableReferences};
}
const publicDir=new URL('../bem-production-site/web/public/sparkdraw/',import.meta.url);
fs.mkdirSync(publicDir,{recursive:true});
fs.writeFileSync(new URL('standard-input.json',publicDir),JSON.stringify({language:'Solidity',sources:compiled.sources,settings:compiled.settings}));
fs.writeFileSync(new URL('../bem-production-site/web/sparkdraw-artifacts.json',import.meta.url),JSON.stringify({version:5,compiler:compiled.compiler,contracts}));
console.log(JSON.stringify({compiler:compiled.compiler,contracts:Object.fromEntries(Object.entries(contracts).map(([name,c])=>[name,{creationBytes:(c.bytecode.length-2)/2,runtimeBytes:(c.runtime.length-2)/2,creationHash:c.creationHash}]))}));
