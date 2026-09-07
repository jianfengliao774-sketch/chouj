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

test('candidate returns accumulated actual principal after 24 hours, then burns only expired unclaimed rounds', { timeout: 120000 }, async t => {
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
    assert.equal(await game.REFUND_PUBLIC_NOTICE_DELAY(),43200n);
    assert.equal(await game.refundPublicNoticeAt(1),0n,'unstarted round has no public notice');
    for (const signer of [alice,bob]) {
      await wait(token.mint(await signer.getAddress(), 10000000000n));
      await wait(token.connect(signer).approve(game.target, MaxUint256));
    }
    await wait(game.connect(alice).buy(1, 3000, gas));
    assert.equal(await game.refundPublicNoticeAt(1),(await game.refundTriggerAt(1))+43200n);
    await wait(game.connect(alice).buy(1, 2000, gas));
    await wait(game.connect(bob).buy(1, 5000, gas));
    assert.equal(await game.beaconRound(1), BigInt(sample.beacon.round));
    const deadline = Number((await game.rounds(1)).drawDeadline);
    assert.equal(deadline, target - 60 + 86400);
    await wait(game.connect(alice).buy(2, 100, gas));
    await wait(game.connect(alice).buy(2, 200, gas));
    await wait(game.connect(bob).buy(2, 400, gas));
    await at(target);
    await wait(game.connect(relayer).fulfillRandomness(1, signature, gas));
    assert.equal(await game.randomnessProof(1), signature);
    assert.equal(await game.beaconRandomness(1), '0x' + sample.beacon.randomness);

    const ready = await engine.request({ method: 'evm_snapshot', params: [] });
    await t.test('settlement before deadline uses the verified result and cannot later refund or burn again', async () => {
      for (let i = 0; i < 10 && (await game.rounds(1)).status === 4n; i++) await wait(game.connect(relayer).settle(1, gas));
      assert.equal((await game.rounds(1)).status, 5n);
      const winner = (await game.rounds(1)).winner;
      assert.notEqual(winner, '0x' + '0'.repeat(40));
      const prize = await game.prizes(1);
      assert.equal(prize.amount, 480000000n, '5 BEM prize after 1% fee and 3% burn');
      assert.equal(prize.claimDeadline - prize.settledAt, 86400n);
      assert.equal(await game.claimablePrize(1,winner), prize.amount);
      const unclaimed = await engine.request({ method: 'evm_snapshot', params: [] });
      const beforePrize = await token.balanceOf(winner);
      await wait(game.connect(relayer).claimPrizes([1], winner));
      assert.equal(await token.balanceOf(winner) - beforePrize, prize.amount);
      assert.equal((await game.prizes(1)).claimed, true);
      assert.equal(await game.claimablePrize(1,winner), 0n);
      await assert.rejects(game.claimPrize.staticCall(1));
      await at(deadline + 86400);
      assert.equal(await game.refundablePrincipal(1, a), 0n);
      await assert.rejects(game.burnUnclaimed.staticCall(1));
      await assert.rejects(game.burnUnclaimedPrize.staticCall(1));
      await engine.request({ method: 'evm_revert', params: [unclaimed] });
      await at(Number(prize.claimDeadline) - 1);
      await assert.rejects(game.burnUnclaimedPrize.staticCall(1));
      await at(Number(prize.claimDeadline));
      assert.equal(await game.claimablePrize(1,winner), 0n);
      await assert.rejects(game.claimPrize.staticCall(1));
      const dead = await game.BLACKHOLE(), beforeBurn = await token.balanceOf(dead);
      await wait(game.connect(relayer).burnUnclaimedPrize(1));
      assert.equal(await token.balanceOf(dead) - beforeBurn, prize.amount);
      assert.equal((await game.prizes(1)).burned, true);
      assert.equal(await game.totalLiability(), 35000000n, 'round 2 principal unaffected by prize destruction');
      await assert.rejects(game.burnUnclaimedPrize.staticCall(1));
    });
    await engine.request({ method: 'evm_revert', params: [ready] });

    await wait(circuit.setEvalMode(1));
    await assert.rejects(game.settle.staticCall(1));
    await at(deadline - 1);
    await assert.rejects(game.openRefunds.staticCall(1));
    await assert.rejects(game.openRefunds.staticCall(2));
    await at(deadline);
    assert.equal(await game.refundablePrincipal(1, a), 250000000n);
    assert.equal(await game.refundablePrincipal(2, a), 15000000n);
    await assert.rejects(game.settle.staticCall(1));
    await assert.rejects(game.fulfillRandomness.staticCall(1, signature));
    await assert.rejects(game.refundMany.staticCall([1,1], a));
    await assert.rejects(game.refundMany.staticCall([2,1], a));

    await t.test('failed token transfer rolls back every round credit in a batch', async () => {
      await wait(token.setFailure(a, 1));
      await assert.rejects(wait(game.connect(relayer).refundMany([1,2], a, { gasLimit: 1000000 })));
      assert.equal(await game.refundedPrincipal(1), 0n);
      assert.equal(await game.ticketsOf(2,a), 300n);
      await wait(token.setFailure(a, 0));
    });

    const before = await token.balanceOf(a), callerBefore = await token.balanceOf(await relayer.getAddress());
    const receipt = await wait(game.connect(relayer).refundMany([1,2], a));
    assert.equal(await token.balanceOf(a) - before, 265000000n);
    assert.equal(await token.balanceOf(await relayer.getAddress()), callerBefore);
    const transfers = receipt.logs.filter(log => log.address.toLowerCase() === String(token.target).toLowerCase());
    assert.equal(transfers.length, 1, 'one token transfer for all purchases in both rounds');
    assert.equal(await game.refundedPrincipal(1), 250000000n);
    assert.equal(await game.refundedPrincipal(2), 15000000n);
    await assert.rejects(game.refundMany.staticCall([1,2],a));

    await at(deadline + 1);
    await wait(game.connect(alice).buy(3, 100, gas));
    assert.equal(await game.totalLiability(), 275000000n);
    await at(deadline + 86400 - 1);
    assert.equal(await game.refundablePrincipal(1, b), 250000000n);
    await assert.rejects(game.burnUnclaimed.staticCall(1));
    await at(deadline + 86400);
    assert.equal(await game.refundablePrincipal(1, b), 0n);
    await assert.rejects(game.refundMany.staticCall([1,2],b));
    const dead = await game.BLACKHOLE(), deadBefore = await token.balanceOf(dead);
    await wait(game.connect(relayer).burnUnclaimed(1));
    await wait(game.connect(relayer).burnUnclaimed(2));
    assert.equal(await token.balanceOf(dead) - deadBefore, 270000000n);
    assert.equal(await token.balanceOf(game.target), 5000000n, 'other active round funds preserved');
    assert.equal(await game.totalLiability(), 5000000n);
    await assert.rejects(game.burnUnclaimed.staticCall(1));
    await t.test('0.1 BEM test denomination and 5000 scattered chosen tickets fit a single BNB transaction', async () => {
      const testGame = await deploy(gameArtifact, [10000000n, token.target, verifier.target, adminAddress]);
      assert.equal(await testGame.TICKET_PRICE(), 1000n);
      assert.equal(await testGame.WINNER_AMOUNT(), 9500000n);
      for (const signer of [alice,bob]) await wait(token.connect(signer).approve(testGame.target, MaxUint256));
      const selected = Array.from({length:5000}, (_, i) => 2*i);
      const first = await wait(testGame.connect(alice).buySelected(1, selected, {gasLimit:29000000}));
      t.diagnostic('5000 scattered selected tickets gas: '+first.gasUsed);
      assert.ok(first.gasUsed <= 16777216n, '5000-ticket selection must fit the BNB per-transaction budget');
      const second = await wait(testGame.connect(bob).buySelected(1, selected, {gasLimit:29000000}));
      t.diagnostic('5000 occupied choices with fallback gas: '+second.gasUsed);
      assert.ok(second.gasUsed <= 16777216n);
      assert.equal((await testGame.rounds(1)).sold,10000n);
      assert.equal(await testGame.ticketOwner(1,0),a);
      assert.equal(await testGame.ticketOwner(1,9999),b);
    });
    await t.test('95% closes after thirty minutes with a sold-only prize, while an unsealed 24-hour boundary refunds',async()=>{
      await wait(circuit.setEvalMode(0));
      const small=await deploy(gameArtifact,[10000000n,token.target,verifier.target,adminAddress]);
      for(const signer of [alice,bob])await wait(token.connect(signer).approve(small.target,MaxUint256));
      await at(target-1860);
      await wait(small.connect(alice).buy(1,5000,gas));await wait(small.connect(bob).buy(1,4500,gas));
      const closes=Number(await small.earlyDrawDeadline(1));assert.equal(closes,target-60);
      await at(closes-1);await assert.rejects(small.closeRound.staticCall(1));
      await at(closes);await wait(small.closeRound(1,gas));
      assert.equal(await small.beaconRound(1),BigInt(sample.beacon.round));
      await at(target);await wait(small.fulfillRandomness(1,signature,gas));
      for(let i=0;i<20&&(await small.rounds(1)).status===4n;i++)await wait(small.settle(1,gas));
      const settled=await small.rounds(1);assert.equal(settled.status,5n);assert.ok(settled.winningTicket<9500n);
      assert.equal((await small.prizes(1)).amount,9025000n,'prize uses 9500 actual sold shares');
      await wait(small.connect(alice).buy(2,5000,gas));
      const end=Number((await small.rounds(2)).fundingDeadline);
      await at(end-900);await wait(small.connect(bob).buy(2,4500,gas));
      assert.equal(await small.earlyDrawDeadline(2),BigInt(end));
      await at(end);await assert.rejects(small.closeRound.staticCall(2));
      assert.equal(await small.refundablePrincipal(2,a),5000000n);
      assert.equal(await small.refundPublicNoticeAt(2),BigInt(end+43200));
    });
    t.diagnostic(JSON.stringify({ gameRuntimeBytes: gameArtifact.evm.deployedBytecode.object.length / 2,
      twoRoundAggregateRefundGas: String(receipt.gasUsed), refundablePrincipalPaid: '265000000', unclaimedBurned: '270000000' }));
  } finally { await provider.destroy(); await engine.disconnect(); }
});
