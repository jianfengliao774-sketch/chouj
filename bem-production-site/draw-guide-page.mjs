import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { SPARKDRAW as F } from './web/sparkdraw-config.js';
import { profile, VERIFIER, VERIFIER_HASH } from './web/sparkdraw-profiles.js';
import { SALES_POOL_IDS } from './web/sparkdraw-sales-policy.js';

const read = name => fs.readFileSync(new URL(name, import.meta.url));
const escape = value => String(value).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const text = (zh, en) => '<span data-en="'+escape(en)+'">'+escape(zh)+'</span>';
const explorer = (type,value) => '<a class="hash" href="https://bscscan.com/'+type+'/'+escape(value)+'" target="_blank" rel="noopener noreferrer">'+escape(value)+'</a>';
const row = (zh,en,value) => '<div><dt>'+text(zh,en)+'</dt><dd>'+value+'</dd></div>';
export function currentDeploymentEvidence(){
  const registry=JSON.parse(read('./web/public/sparkdraw/deployed-contracts.json'));
  return JSON.stringify({...registry,deployments:registry.deployments.filter(d=>d.kind==='verifier'||SALES_POOL_IDS.includes(d.kind))},null,2)+'\n';
}

// Use exactly the same pinned identities as the player, with full unabridged hashes.
export function drawGuideHtml(html) {
  const file=currentDeploymentEvidence(), registry=JSON.parse(file);
  const standardInput=read('./web/public/sparkdraw/standard-input.json');
  const settings=JSON.parse(standardInput).settings, compiler=JSON.parse(read('./web/sparkdraw-artifacts.json')).compiler;
  const source=JSON.parse(standardInput).sources['BemDrandRaffleCandidate.sol'].content;
  const circuitAddress=source.match(/address public constant CIRCUITS = (0x[0-9a-fA-F]{40})/)[1];
  const circuitHash=source.match(/bytes32 public constant CIRCUIT_HASH = (0x[0-9a-fA-F]{64})/)[1];
  const entries=['verifier',...SALES_POOL_IDS].map(id=>{
    const d=registry.deployments.find(x=>x.kind===id), expected=id==='verifier'?{address:VERIFIER,runtimeHash:VERIFIER_HASH}:profile(id);
    if(!d||d.address!==expected.address||d.runtimeHash!==expected.runtimeHash)throw Error('Guide deployment identity mismatch: '+id);
    const title=id==='verifier'?text('共用随机数验证合约','Shared randomness verifier'):id+' BEM '+text('场次','pool');
    return '<article class="contract-card"><h3>'+title+'</h3><dl>'+
      row('合约地址','Contract address',explorer('address',d.address))+
      row('部署交易哈希','Deployment transaction hash',explorer('tx',d.transactionHash))+
      row('部署区块 / 区块哈希','Deployment block / block hash','<a href="https://bscscan.com/block/'+d.blockNumber+'" target="_blank" rel="noopener noreferrer">'+d.blockNumber+'</a><code>'+d.blockHash+'</code>')+
      row('运行代码哈希 · Keccak-256','Runtime code hash · Keccak-256','<code>'+d.runtimeHash+'</code>')+'</dl></article>';
  }).join('');
  const dependencies=[
    row('巨兽 2075 电路所在合约','BEHEMOTH Circuit #2075 contract',explorer('address',circuitAddress)),
    row('电路编号','Circuit ID','2075'),
    row('电路网表哈希 · Keccak-256','Circuit netlist hash · Keccak-256','<code>'+circuitHash+'</code>'),
    row('BEM 代币 · 8 位小数','BEM token · 8 decimals',explorer('address',F.bem)),
    row('13061 收款容器','Revenue container #13061',explorer('address',F.revenue)),
    row('销毁地址','Burn address',explorer('address',F.dead)),
    row('drand evmnet 网络哈希','drand evmnet chain hash','<code>'+F.beaconHash+'</code>'),
    row('drand 网络参数与公钥','drand network parameters and public key','<a href="https://api.drand.sh/'+F.beaconHash+'/info" target="_blank" rel="noopener noreferrer">'+text('查看原始 JSON','View raw JSON')+'</a>'),
    row('Solidity 编译器与参数','Solidity compiler and settings','<code>'+escape(compiler)+'</code><code>optimizer: '+escape(settings.optimizer.enabled)+' / runs: '+escape(settings.optimizer.runs)+' / viaIR: '+escape(settings.viaIR)+' / EVM: '+escape(settings.evmVersion)+'</code>'),
    row('完整 Solidity 编译输入 · SHA-256','Full Solidity compiler input · SHA-256','<code>'+createHash('sha256').update(standardInput).digest('hex')+'</code><a href="/sparkdraw/standard-input.json" download>'+text('下载源码与编译参数','Download sources and compiler settings')+'</a>'),
    row('部署证据文件 · SHA-256','Deployment evidence file · SHA-256','<code>'+createHash('sha256').update(file).digest('hex')+'</code><a href="/sparkdraw/current-contracts.json" download>'+text('下载正式场部署资料','Download live-pool deployment records')+'</a>')
  ].join('');
  const fees=SALES_POOL_IDS.map(id=>'<tr><td>'+id+' BEM</td><td>1%</td><td>'+profile(id).burnPercent+'%</td><td>'+(99-profile(id).burnPercent)+'%</td></tr>').join('');
  return html.replace('<!-- guide-contracts -->',entries).replace('<!-- guide-dependencies -->',dependencies).replace('<!-- guide-fees -->',fees);
}
