import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, sha256, keccak256, toUtf8Bytes } from 'ethers';
import { compileDrandCandidate } from '../scripts/lib/compile_drand_candidate.mjs';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/drand/evmnet.json', import.meta.url)));
const artifact = compileDrandCandidate().contracts['TapeoutDrandRandomness.sol'].TapeoutDrandRandomness;
const beaconTime = sample.info.genesis_time + (sample.beacon.round - 1) * sample.info.period;
const signature = '0x' + sample.beacon.signature;
const snapshot = keccak256(toUtf8Bytes('fixed sold-ticket snapshot for candidate test'));

test('real evmnet proof verifies on EVM; fixed rounds and proofs remain publicly queryable', async t => {
  const engine = ganache.provider({ logging: { quiet: true }, chain: { chainId: 56, hardfork: 'shanghai',
    time: new Date((beaconTime - 60) * 1000) }, miner: { timestampIncrement: 0 } });
  const provider = new BrowserProvider(engine); provider.pollingInterval = 10;
  try {
    const consumer = await provider.getSigner(0), relayer = await provider.getSigner(1);
    const adapter = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, consumer).deploy(await consumer.getAddress());
    const deployReceipt = await adapter.deploymentTransaction().wait();
    assert.equal(await adapter.BEACON_CHAIN_HASH(), '0x' + sample.info.hash);
    assert.equal(await adapter.verifyBeacon(sample.beacon.round, signature), '0x' + sample.beacon.randomness);
    assert.equal(sha256(signature), '0x' + sample.beacon.randomness);
    // Network public key coordinate ordering must match the pinned drand metadata.
    const key = await adapter.publicKey();
    const encode = n => n.toString(16).padStart(64, '0');
    assert.equal([key.x[1], key.x[0], key.y[1], key.y[0]].map(encode).join(''), sample.info.public_key);

    await t.test('rejects forged signatures, wrong beacon rounds and non-canonical encodings', async () => {
      for (const bad of ['0x', '0x' + '00'.repeat(64), signature + '00', '0x' + 'ff'.repeat(64)]) {
        await assert.rejects(adapter.verifyBeacon(sample.beacon.round, bad, { gasLimit: 2000000 }));
      }
      await assert.rejects(adapter.verifyBeacon(sample.beacon.round + 1, signature));
    });

    await assert.rejects(adapter.connect(relayer).requestRandomness.staticCall(1, 9500, snapshot));
    await assert.rejects(adapter.requestRandomness.staticCall(1, 0, snapshot));
    await assert.rejects(adapter.requestRandomness.staticCall(1, 10001, snapshot));
    const request = await (await adapter.requestRandomness(1, 9500, snapshot)).wait();
    await (await adapter.requestRandomness(2, 10000, snapshot)).wait();
    await (await adapter.requestRandomness(3, 9500, snapshot)).wait();
    const before = await adapter.draws(1);
    assert.equal(before.beaconRound, BigInt(sample.beacon.round));
    assert.equal(before.entriesCommitment, snapshot);
    assert.equal(await adapter.expiresAt(1), BigInt(beaconTime - 60 + 86400));
    assert.equal(await adapter.isTimedOut(1), false);
    await assert.rejects(adapter.connect(relayer).expireRandomness.staticCall(1));
    await assert.rejects(adapter.requestRandomness.staticCall(1, 10000, snapshot));
    await assert.rejects(adapter.connect(relayer).fulfillRandomness.staticCall(1, signature));
    await engine.request({ method: 'evm_increaseTime', params: [60] });
    await engine.request({ method: 'evm_mine', params: [] });
    await assert.rejects(adapter.fulfillRandomness.staticCall(99, signature));
    const fulfillment = await (await adapter.connect(relayer).fulfillRandomness(1, signature)).wait();
    await (await adapter.connect(relayer).fulfillRandomness(2, signature)).wait();
    const after = await adapter.draws(1);
    assert.equal(after.fulfilled, true);
    assert.equal(after.beaconRandomness, '0x' + sample.beacon.randomness);
    assert.equal(await adapter.proof(1), signature);
    assert.notEqual(after.drawSeed, (await adapter.draws(2)).drawSeed);
    await assert.rejects(adapter.fulfillRandomness.staticCall(1, signature));
    const event = fulfillment.logs.map(log => { try { return adapter.interface.parseLog(log); } catch { return null; } })
      .find(event => event?.name === 'RandomnessVerified');
    assert.equal(event.args.signature, signature);
    assert.equal(event.args.submitter, await relayer.getAddress());
    await t.test('timeout is public without a server; late proofs and re-requests cannot change the result', async () => {
      await engine.request({ method: 'evm_increaseTime', params: [86400 - 60] });
      await engine.request({ method: 'evm_mine', params: [] });
      assert.equal(await adapter.isTimedOut(3), false, 'proof still accepted exactly at the deadline');
      await adapter.connect(relayer).fulfillRandomness.staticCall(3, signature);
      await engine.request({ method: 'evm_increaseTime', params: [1] });
      await engine.request({ method: 'evm_mine', params: [] });
      assert.equal(await adapter.isTimedOut(3), true, 'refund condition is readable before any expire transaction');
      await assert.rejects(adapter.fulfillRandomness.staticCall(3, signature));
      await (await adapter.connect(relayer).expireRandomness(3)).wait();
      assert.equal((await adapter.draws(3)).expired, true);
      await assert.rejects(adapter.requestRandomness.staticCall(3, 9500, snapshot));
      assert.equal(await adapter.isTimedOut(1), false, 'verified result never becomes refundable');
      await assert.rejects(adapter.expireRandomness.staticCall(1));
    });
    t.diagnostic(JSON.stringify({ network: 'local EVM simulation (chainId 56, not BNB mainnet)',
      beaconRound: sample.beacon.round, deploymentGas: String(deployReceipt.gasUsed),
      requestGas: String(request.gasUsed), verificationAndStorageGas: String(fulfillment.gasUsed) }));
  } finally { await provider.destroy(); await engine.disconnect(); }
});
