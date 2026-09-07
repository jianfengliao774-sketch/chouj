import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import solc from 'solc';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, MaxUint256, AbiCoder, keccak256 } from 'ethers';
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

test('security review of the currently deployed V5 rules', {timeout:120000}, async t=>{
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

    for(const signer of [alice,bob]){await wait(token.mint(await signer.getAddress(),10000000000n));await wait(token.connect(signer).approve(game.target,MaxUint256));}
    let clean=await engine.request({method:'evm_snapshot',params:[]});
    await t.test('late 95-percent funding has no closing window before the original funding deadline',async()=>{
      await wait(game.connect(alice).buy(1,5000,gas));const end=Number((await game.rounds(1)).fundingDeadline);
      await at(end-600);await wait(game.connect(bob).buy(1,4500,gas));assert.equal(Number(await game.earlyDrawDeadline(1)),end);
      await at(end-1);await assert.rejects(game.closeRound.staticCall(1));
      await at(end);await assert.rejects(game.closeRound.staticCall(1));
      assert.equal(await game.refundablePrincipal(1,a),250000000n);
      await wait(game.openRefunds(1));assert.equal((await game.rounds(1)).status,6n);
    });
    await engine.request({method:'evm_revert',params:[clean]});
    await wait(game.connect(alice).buy(1,5000,gas));await wait(game.connect(bob).buy(1,5000,gas));
    assert.equal(await game.beaconRound(1),BigInt(sample.beacon.round));await at(target);
    const r=await game.rounds(1),coder=AbiCoder.defaultAbiCoder();
    const seed=domain=>BigInt(keccak256(coder.encode(['string','uint256','address','uint256','uint32','bytes32','uint64','bytes32'],[domain,56,game.target,1,r.sold,'0x'+sample.info.hash,sample.beacon.round,'0x'+sample.beacon.randomness])));
    const w0=seed('Tapeout drand tickets v1'),w1=seed('Tapeout drand circuit v1');
    let expected;for(let c=0;c<50;c++){const a=await game.previewAttempt(w0,w1,c);if(a.accepted){expected=a.ticket;break;}}assert.notEqual(expected,undefined);
    clean=await engine.request({method:'evm_snapshot',params:[]});
    await t.test('the beacon determines the winner before relay; arbitrary callers cannot choose a different proof or skip an accepted result',async()=>{
      const tampered='0x'+sample.beacon.signature.slice(0,-2)+(sample.beacon.signature.endsWith('00')?'01':'00');
      await assert.rejects(game.connect(relayer).fulfillRandomness.staticCall(1,tampered,gas));
      assert.equal((await game.rounds(1)).status,3n);
      await wait(game.connect(relayer).fulfillRandomness(1,signature,gas));
      assert.equal((await game.rounds(1)).ticketWord,w0);assert.equal((await game.rounds(1)).circuitWord,w1);
      await assert.rejects(game.fulfillRandomness.staticCall(1,signature));
      for(let i=0;i<20&&(await game.rounds(1)).status===4n;i++)await wait(game.connect(relayer).settle(1,gas));
      assert.equal((await game.rounds(1)).winningTicket,expected);
      await assert.rejects(game.settle.staticCall(1));
      const winner=(await game.rounds(1)).winner,before=await token.balanceOf(winner);
      await wait(game.connect(relayer).claimPrize(1));assert.ok(await token.balanceOf(winner)>before);
      assert.equal((await game.prizes(1)).claimed,true);
    });
    await engine.request({method:'evm_revert',params:[clean]});
    await t.test('withholding all relays until timeout can cancel an already knowable draw into refunds',async()=>{
      const end=Number((await game.rounds(1)).drawDeadline);await at(end);
      await assert.rejects(game.fulfillRandomness.staticCall(1,signature));
      await wait(game.connect(relayer).openRefunds(1));assert.equal((await game.rounds(1)).status,6n);
      assert.equal(await game.refundablePrincipal(1,a),250000000n);
      assert.equal(await game.refundablePrincipal(1,b),250000000n);
      assert.equal((await game.rounds(1)).winner,'0x'+'0'.repeat(40));
    });
  }finally{await engine.disconnect();}
});
