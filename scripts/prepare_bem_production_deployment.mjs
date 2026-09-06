// Prepare an unsigned, expiring wallet-review packet. Never sign or broadcast.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFactory, Interface, formatEther, getAddress, getCreateAddress, keccak256, toQuantity } from 'ethers';
import solc from 'solc';

const root = fileURLToPath(new URL('../', import.meta.url));
const folder = path.join(root, 'outputs/bem-raffle-2075/production');
const publicFile = path.join(root, 'local-bem-demo/web/production-deployment.json');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const CAP = 16_777_216n;
const expectedFiles = ['BemSelectableRaffle.sol', 'BemSelectableRaffleBSC.sol', 'BemContainerSeriesBSC.sol', 'Bem2075RaffleBSC.sol']
  .map(file => `contracts/production/${file}`);

// An unsuccessful preparation cannot leave an older ready packet active.
await fs.writeFile(publicFile, json({ schemaVersion: 1, stage: 'unavailable', reason: 'Deployment checks are running.' }));
try {
  const plan = await readJson(path.join(folder, 'release-plan.json'));
  assert.equal(plan.chainId, 56);
  assert.equal(plan.targetContract, 'Bem2075RaffleBSC');
  assert.equal(plan.token.address.toLowerCase(), '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a');
  assert.equal(plan.evaluator.contract.toLowerCase(), '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c');
  assert.equal(plan.evaluator.circuitId, 2075);
  assert.equal(plan.evaluator.netlistHash, '0xa375924f2a31f5169606ea20e357efa2aeeb2355aff859f28f40a15519714eef');
  assert.equal(plan.vrf.coordinator.toLowerCase(), '0xd691f04bc0c9a24edb78af9e005cf85768f694c9');
  assert.equal(plan.vrf.keyHash, '0x130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4');
  assert.equal(plan.deployment, null, 'A recorded deployment must be inspected, not redeployed');
  assert.equal(plan.container.status, 'confirmed_by_user');
  assert.equal(plan.container.selected.address.toLowerCase(), '0x358be84b95224d228f3a61964fa3c9fb61d7b646');
  assert.equal(plan.container.selected.nft.toLowerCase(), '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c');
  assert.equal(plan.container.selected.tokenId, 2075);
  assert.equal(plan.rules.ticketsPerRound, 10000);
  assert.equal(plan.rules.fundingWindowSeconds, 259200);
  assert.equal(plan.rules.maxTicketsPerPurchase, 500);
  assert.equal(plan.vrf.nativePayment, true);
  assert.equal(typeof plan.vrf.subscriptionId, 'string');
  assert.match(plan.vrf.subscriptionId, /^[1-9][0-9]*$/);
  assert.ok(BigInt(plan.vrf.subscriptionId) < (1n << 256n));
  assert.equal(plan.vrf.requestConfirmations, 3);
  assert.equal(plan.vrf.callbackGasLimit, 250000);

  const artifact = await readJson(path.join(folder, 'Bem2075RaffleBSC.artifact.json'));
  const input = await readJson(path.join(folder, 'Bem2075RaffleBSC.compile-input.json'));
  assert.equal(artifact.contractName, 'Bem2075RaffleBSC');
  assert.deepEqual(Object.keys(artifact.sourceSha256s).sort(), [...expectedFiles].sort());
  for (const file of expectedFiles) {
    const actual = await fs.readFile(path.join(root, file));
    assert.equal(sha256(actual), artifact.sourceSha256s[file], `Stale artifact: ${file}`);
    assert.equal(input.sources[file].content, actual.toString('utf8'), `Stale compile input: ${file}`);
  }
  assert.ok(artifact.runtimeBytecodeBytes <= 24576);
  assert.equal((await fs.readFile(path.join(folder, 'Bem2075RaffleBSC.bytecode.txt'), 'utf8')).trim(), artifact.bytecode);
  assert.equal(solc.version(), artifact.compilerVersion, 'Compiler version changed');
  const rebuilt = JSON.parse(solc.compile(JSON.stringify(input)));
  assert.ok(!(rebuilt.errors || []).some(error => error.severity === 'error'), 'Offline recompile failed');
  const compiled = rebuilt.contracts['contracts/production/Bem2075RaffleBSC.sol'].Bem2075RaffleBSC;
  assert.equal('0x' + compiled.evm.bytecode.object, artifact.bytecode, 'Creation bytecode does not match recompiled source');
  assert.equal('0x' + compiled.evm.deployedBytecode.object, artifact.deployedBytecode, 'Runtime template does not match recompiled source');
  assert.deepEqual(compiled.evm.deployedBytecode.immutableReferences, artifact.immutableReferences);
  assert.deepEqual(compiled.abi, artifact.abi);

  for (const [reportFile, count, files] of [
    ['verification-selectable.json', 12, expectedFiles.slice(0, 2)],
    ['verification-series.json', 7, expectedFiles]
  ]) {
    const report = await readJson(path.join(folder, reportFile));
    assert.equal(report.status, 'passed', `${reportFile} has failures`);
    assert.equal(report.scope, 'local_mocks');
    assert.equal(report.tests.length, count, `${reportFile} is not a complete suite`);
    assert.ok(report.tests.every(test => test.passed === true));
    for (const file of files) assert.equal(report.sourceSha256s[file], artifact.sourceSha256s[file], `Stale test: ${file}`);
  }

  const abi = new Interface([
    'function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)',
    'function isOpened(address,uint256) view returns(bool)',
    'function accountOf(address,uint256) view returns(address)',
    'function owner() view returns(address)',
    'function token() view returns(uint256 chainId,address tokenContract,uint256 tokenId)',
    'function decimals() view returns(uint8)'
  ]);
  const rpcUrl = 'https://bsc-dataseed.bnbchain.org';
  let nextId = 0;
  const methods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode', 'eth_estimateGas', 'eth_gasPrice', 'eth_getBalance', 'eth_getTransactionCount']);
  async function rpc(method, params) {
    assert.ok(methods.has(method), 'Unsigned preparation permits reads and gas simulation only');
    const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }), signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(`${method}: ${result.error.message}`);
    assert.notEqual(result.result, undefined);
    return result.result;
  }
  assert.equal(BigInt(await rpc('eth_chainId', [])), 56n);
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  const call = async (to, fn, args = []) => abi.decodeFunctionResult(fn,
    await rpc('eth_call', [{ to, data: abi.encodeFunctionData(fn, args) }, block.number]));
  const selected = plan.container.selected;
  const opener = '0x021745DE2f42A7839d96f2d3634d0294487D81F1';
  const [sub, opened, account, owner, binding, decimals, code] = await Promise.all([
    call(plan.vrf.coordinator, 'getSubscription', [plan.vrf.subscriptionId]),
    call(opener, 'isOpened', [selected.nft, 2075]), call(opener, 'accountOf', [selected.nft, 2075]),
    call(selected.address, 'owner'), call(selected.address, 'token'), call(plan.token.address, 'decimals'),
    rpc('eth_getCode', [selected.address, block.number])
  ]);
  assert.equal(opened[0], true); assert.notEqual(code, '0x');
  assert.equal(getAddress(account[0]), getAddress(selected.address));
  assert.deepEqual(Array.from(binding), [56n, getAddress(selected.nft), 2075n]);
  assert.equal(decimals[0], 8n);
  assert.equal(getAddress(sub.owner), getAddress(plan.vrf.subscriptionOwner));
  assert.equal(getAddress(owner[0]), getAddress(sub.owner), 'This release expects the confirmed 2075 holder as deployer');
  assert.ok(sub.nativeBalance > 0n, 'VRF subscription has no native BNB');
  const expectedDeployer = getAddress(sub.owner);
  const [minedNonce, pendingNonce] = await Promise.all([
    rpc('eth_getTransactionCount', [expectedDeployer, block.number]), rpc('eth_getTransactionCount', [expectedDeployer, 'pending'])
  ]);
  assert.equal(BigInt(minedNonce), BigInt(pendingNonce), 'Wallet has a pending transaction; wait before preparing deployment');
  const nonce = BigInt(minedNonce);
  const expectedAddress = getCreateAddress({ from: expectedDeployer, nonce });
  assert.equal(await rpc('eth_getCode', [expectedAddress, block.number]), '0x', 'Expected deployment address already contains code');
  let prior = null;
  try { prior = await readJson(path.join(folder, 'deployment-review.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior?.expectedAddress) assert.equal(await rpc('eth_getCode', [prior.expectedAddress, block.number]), '0x',
    'A previously prepared deployment address contains code. Record its deployment receipt before continuing');
  const constructorArgs = [plan.vrf.subscriptionId, plan.vrf.requestConfirmations, plan.vrf.callbackGasLimit];
  const factory = new ContractFactory(artifact.abi, artifact.bytecode);
  const deployment = await factory.getDeployTransaction(...constructorArgs);
  const transaction = { chainId: 56, from: expectedDeployer, nonce: toQuantity(nonce), value: '0x0', data: deployment.data };
  const [estimated, gasPriceHex, balanceHex] = await Promise.all([
    rpc('eth_estimateGas', [{ ...transaction, chainId: '0x38', gas: toQuantity(CAP) }, block.number]),
    rpc('eth_gasPrice', []), rpc('eth_getBalance', [expectedDeployer, block.number])
  ]);
  const gasEstimate = BigInt(estimated), gasLimit = (gasEstimate * 120n + 99n) / 100n, gasPrice = BigInt(gasPriceHex);
  assert.ok(gasLimit <= CAP, 'Deployment with safety margin exceeds the transaction cap');
  assert.ok(BigInt(balanceHex) >= gasLimit * gasPrice, 'Deployer needs additional BNB for deployment gas');
  assert.equal((await rpc('eth_getBlockByNumber', [block.number, false])).hash, block.hash, 'Snapshot reorg');
  const packet = {
    schemaVersion: 1, stage: 'ready_for_wallet_review', chainId: 56, contractName: artifact.contractName,
    preparedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    expectedDeployer, expectedAddress, rpcUrl, constructorArgs,
    subscription: { id: plan.vrf.subscriptionId, coordinator: plan.vrf.coordinator, owner: sub.owner,
      nativeBalanceBnb: formatEther(sub.nativeBalance) },
    container: { address: selected.address, nft: selected.nft, tokenId: 2075, opener }, tokenAddress: plan.token.address,
    sourceSha256s: artifact.sourceSha256s, abi: artifact.abi, bytecode: artifact.bytecode,
    creationCodeHash: keccak256(artifact.bytecode), deploymentDataHash: keccak256(deployment.data),
    transaction,
    estimate: { blockNumber: Number(BigInt(block.number)), timeUtc: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
      gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString(), gasPriceWei: gasPrice.toString(),
      estimatedFeeBnb: formatEther(gasEstimate * gasPrice), gasLimitFeeBnb: formatEther(gasLimit * gasPrice) },
    rules: { poolBem: '100', ticketPriceBem: '0.01', maxTicketsPerPurchase: 500, payout: '4 / 1 / 95', fundingHours: 72 },
    evidence: { localTests: { selectable: 12, series: 7 }, scope: 'local_mocks_not_real_VRF',
      review: 'internal_code_review_not_external_audit', mainnetTransactionsSent: 0 },
    postDeployment: ['Verify the mined contract and source', 'Add the deployed game as this subscription consumer',
      'Configure and fund keeper plus production frontend', 'Activate series through the 2075 container only when ready']
  };
  // Recheck disk inputs after RPC work, so an edit during preparation cancels it.
  assert.deepEqual(await readJson(path.join(folder, 'release-plan.json')), plan, 'Release plan changed during preparation');
  assert.deepEqual(await readJson(path.join(folder, 'Bem2075RaffleBSC.artifact.json')), artifact, 'Artifact changed during preparation');
  for (const file of expectedFiles) assert.equal(sha256(await fs.readFile(path.join(root, file))), artifact.sourceSha256s[file],
    `Source changed during preparation: ${file}`);
  const packetSha256 = sha256(json(packet));
  await fs.writeFile(path.join(folder, `deployment-review-${packetSha256}.json`), json(packet), { flag: 'wx' });
  await fs.writeFile(path.join(folder, 'deployment-review.json'), json(packet));
  await fs.writeFile(publicFile, json(packet));
  console.log(json({ status: packet.stage, contract: packet.contractName, subscriptionId: packet.subscription.id,
    expectedDeployer, estimate: packet.estimate, transactionsSent: 0, publicFile }));
} catch (error) {
  await fs.writeFile(publicFile, json({ schemaVersion: 1, stage: 'unavailable', reason: error.message }));
  console.error(error.message);
  process.exitCode = 1;
}
