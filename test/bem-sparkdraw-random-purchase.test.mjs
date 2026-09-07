import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import solc from 'solc';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, MaxUint256 } from 'ethers';
import { compileDrandCandidate } from '../scripts/lib/compile_drand_candidate.mjs';

const built = compileDrandCandidate();
const artifacts = built.contracts;
const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/drand/evmnet.json', import.meta.url)));
const target = sample.info.genesis_time + (sample.beacon.round - 1) * sample.info.period;
const signature = '0x' + sample.beacon.signature;
const code = built.sources['BemDrandRaffleCandidate.sol'].content;
const raw = '0x' + code.match(/CIRCUIT_RAW = hex"([a-fA-F0-9]+)"/)[1];
let mocks = fs.readFileSync(new URL('../contracts/mocks/MockRaffleDependencies.sol', import.meta.url), 'utf8');
mocks = mocks.slice(0, mocks.indexOf('contract MockRaffleCoordinator')).replace('import "../BemCircuitRaffle.sol";', '');
const compiledMocks = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Mocks.sol': { content: mocks } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi','evm.bytecode.object','evm.deployedBytecode.object'] } } } })));
assert.deepEqual(compiledMocks.errors?.filter(x => x.severity === 'error') ?? [], []);
const mock = compiledMocks.contracts['Mocks.sol'];
const gas = { gasLimit: 16777216 };
const wait = async promise => (await promise).wait();

import {randomUnsoldTickets} from '../bem-production-site/web/random-tickets.js';
test('current V5 contracts accept later purchases while fragmented stock remains', {timeout:300000}, async t=>{
  const engine = ganache.provider({ logging: { quiet: true }, chain: { chainId: 56, hardfork: 'shanghai',
    time: new Date((target - 60) * 1000) }, miner: { timestampIncrement: 0, blockGasLimit: 30000000 } });
  const provider = new BrowserProvider(engine, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  const [admin, alice, bob, relayer] = await Promise.all([0,1,2,3].map(i => provider.getSigner(i)));
  const [adminAddress, a, b] = await Promise.all([admin,alice,bob].map(s => s.getAddress()));
  async function deploy(artifact, args = []) {
    const c = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, admin).deploy(...args, gas);
    await c.waitForDeployment(); return c;
  }
  const at = async timestamp => {
    await engine.request({ method: 'evm_setTime', params: [timestamp * 1000] });
    await engine.request({ method: 'evm_mine', params: [] });
  };
  try {
    const token = await deploy(mock.MockRaffleToken, [8]);
    const sourceAddress = '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C';
    await engine.request({ method: 'evm_setAccountCode', params: [sourceAddress, '0x' + mock.MockRaffleCircuitSource.evm.deployedBytecode.object] });
    const circuit = new Contract(sourceAddress, mock.MockRaffleCircuitSource.abi, admin);
    await wait(circuit.setNetlist(raw));
    const verifier = await deploy(artifacts['DrandEvmnetVerifier.sol'].DrandEvmnetVerifier);
    const gameArtifact = artifacts['BemDrandRaffleCandidate.sol'].BemDrandRaffleCandidate;
    assert.ok(gameArtifact.evm.deployedBytecode.object.length / 2 <= 24576, 'deployable runtime size');
    const game = await deploy(gameArtifact, [500000000n, token.target, verifier.target, adminAddress]);

    for(const signer of [alice,bob,relayer]){
      await wait(token.mint(await signer.getAddress(),10000000000n));
      await wait(token.connect(signer).approve(game.target,MaxUint256));
    }
    let baseline=await engine.request({method:'evm_snapshot',params:[]});
    async function clean(){await engine.request({method:'evm_revert',params:[baseline]});baseline=await engine.request({method:'evm_snapshot',params:[]});}
    const words=()=>game.ticketWords(1,0,556);
    async function freeCount(){const rows=await words();let count=0;for(let i=0;i<10000;i++)if(((rows[Math.floor(i/18)]>>BigInt(i%18*14))&16383n)===0n)count++;return count;}
    function result(receipt){return receipt.logs.map(l=>{try{return game.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='PurchaseResult').args;}
    function rng(seed){return limit=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%limit;};}
    await t.test('two random 5000-share buyers fill the whole round under the transaction gas limit',async()=>{
      for(const [signer,seed] of [[alice,7],[bob,31]]){
        const chosen=randomUnsoldTickets(await words(),5000,rng(seed));assert.equal(chosen.length,5000);
        const receipt=await wait(game.connect(signer).buySelected(1,chosen,gas));
        assert.equal(result(receipt).filled,5000n);assert.ok(receipt.gasUsed<=16777216n);
        // Live queried price was 0.05 Gwei; enforce the same 20% estimation buffer.
        const buffered=(receipt.gasUsed*120n+99n)/100n;
        assert.ok(buffered*50000000n<=1000000000000000n);
        t.diagnostic('random 5000 purchase: '+receipt.gasUsed+' gas');
      }
      assert.equal(await freeCount(),0);assert.equal((await game.rounds(1)).sold,10000n);
      assert.equal(await game.ticketsOf(1,a),5000n);assert.equal(await game.ticketsOf(1,b),5000n);
    });
    await clean();
    await t.test('fragmented stock and stale occupied selections still allow later buyers to finish the round',async()=>{
      const even=Array.from({length:5000},(_,i)=>2*i);
      await wait(game.connect(alice).buySelected(1,even,gas));
      // Every unsold number is an isolated hole, including the final number 10000.
      assert.equal(await freeCount(),5000);
      const random=randomUnsoldTickets(await words(),2500,rng(91));
      await wait(game.connect(bob).buySelected(1,random,gas));assert.equal(await freeCount(),2500);
      const address=await relayer.getAddress(),before=await token.balanceOf(address);
      // A stale request for 5000 already-sold numbers must fill only 2500, not revert or strand holes.
      const receipt=await wait(game.connect(relayer).buySelected(1,even,gas)),r=result(receipt);
      assert.equal(r.requested,5000n);assert.equal(r.filled,2500n);assert.equal(r.paid,2500n*await game.TICKET_PRICE());
      assert.equal(before-await token.balanceOf(address),r.paid);assert.equal(r.unspent,r.paid);
      assert.ok(receipt.gasUsed<=16777216n);assert.equal(await freeCount(),0);assert.equal((await game.rounds(1)).sold,10000n);
      t.diagnostic('2500 fragmented holes filled from 5000 conflicting requests: '+receipt.gasUsed+' gas');
    });

    await clean();
    await t.test('one remaining ticket at the front, middle or end can always be bought',async()=>{
      for(const last of [0,5000,9999]){
        const sold=Array.from({length:10000},(_,i)=>i).filter(i=>i!==last);
        await wait(game.connect(alice).buySelected(1,sold.slice(0,5000),gas));
        await wait(game.connect(bob).buySelected(1,sold.slice(5000),gas));
        assert.equal(await freeCount(),1);
        const chosen=randomUnsoldTickets(await words(),5000,rng(7));assert.deepEqual(chosen,[last]);
        const before=await token.balanceOf(await relayer.getAddress());
        const receipt=await wait(game.connect(relayer).buySelected(1,chosen,gas));
        assert.equal(result(receipt).filled,1n);assert.equal(before-await token.balanceOf(await relayer.getAddress()),await game.TICKET_PRICE());
        assert.equal(await freeCount(),0);await clean();
      }
    });
    await t.test('wallet quota is per wallet; another wallet can buy the remaining stock',async()=>{
      await wait(game.connect(alice).buy(1,4999,gas));
      const receipt=await wait(game.connect(alice).buySelected(1,[0,1,2],gas));assert.equal(result(receipt).filled,1n);
      assert.equal(await game.ticketsOf(1,a),5000n);assert.equal(await freeCount(),5000);
      const noFill=await wait(game.connect(alice).buy(1,1,gas));assert.equal(result(noFill).filled,0n);
      assert.equal(result(await wait(game.connect(bob).buy(1,1,gas))).filled,1n);
    });
    await clean();
    await t.test('missing allowance, missing balance and a taxed token revert without reserving tickets or charging BEM',async()=>{
      const original=await token.balanceOf(a);
      await wait(token.connect(alice).approve(game.target,0));
      await assert.rejects(wait(game.connect(alice).buySelected(1,[0,17,18,9999],gas)));
      assert.equal(await freeCount(),10000);assert.equal(await token.balanceOf(a),original);
      await wait(token.connect(alice).approve(game.target,MaxUint256));
      await wait(token.connect(alice).transfer(adminAddress,original));
      await assert.rejects(wait(game.connect(alice).buySelected(1,[0,17,18,9999],gas)));assert.equal(await freeCount(),10000);
      await wait(token.mint(a,original));await wait(token.setTaxDeposits(true));
      await assert.rejects(wait(game.connect(alice).buySelected(1,[0,17,18,9999],gas)));
      assert.equal(await token.balanceOf(a),original);assert.equal(await freeCount(),10000);assert.equal((await game.rounds(1)).sold,0n);
    });
    await clean();
    await t.test('malformed numbers, wrong round and exhausted transaction gas leave holes available',async()=>{
      for(const tickets of [[],[1,1],[18,17],[10000],Array.from({length:5001},(_,i)=>i)])await assert.rejects(game.connect(alice).buySelected.staticCall(1,tickets));
      await assert.rejects(game.connect(alice).buySelected.staticCall(2,[0]));
      await assert.rejects(wait(game.connect(alice).buySelected(1,[0,5000,9999],{gasLimit:60000})));
      assert.equal(await freeCount(),10000);
      assert.equal(result(await wait(game.connect(bob).buySelected(1,[0,5000,9999],gas))).filled,3n);
    });
    await clean();
    await t.test('95-percent deadline permits remaining purchases before closing but rejects them at the exact boundary',async()=>{
      await wait(game.connect(alice).buy(1,5000,gas));await wait(game.connect(bob).buy(1,4500,gas));
      const deadline=Number(await game.fundingClosesAt(1));await at(deadline-1);
      assert.equal(result(await wait(game.connect(relayer).buySelected(1,[0],gas))).filled,1n);
      assert.equal(await freeCount(),499);await at(deadline);
      await assert.rejects(game.connect(relayer).buySelected.staticCall(1,[9501]));assert.equal(await freeCount(),499);
    });
    await clean();
    await t.test('an unsold 24-hour funding deadline rejects new purchases while making principal refundable',async()=>{
      await wait(game.connect(alice).buySelected(1,[0,9999],gas));const deadline=Number(await game.fundingClosesAt(1));
      await at(deadline);await assert.rejects(game.connect(bob).buySelected.staticCall(1,[1]));
      assert.equal(await game.refundablePrincipal(1,a),2n*await game.TICKET_PRICE());assert.equal(await freeCount(),9998);
    });
  }finally{await engine.disconnect();}
});
