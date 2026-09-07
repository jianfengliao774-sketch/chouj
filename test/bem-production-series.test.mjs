import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ganache from "ganache";
import solc from "solc";
import { BrowserProvider, Contract, ContractFactory, MaxUint256, ZeroAddress, ZeroHash, getAddress, toBeHex } from "ethers";

// All dependencies, NFT ownership and VRF are local mocks. No network requests,
// real wallet authorization, mainnet deployment or mainnet state are tested here.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BASE = "contracts/production/BemSelectableRaffle.sol", BSC = "contracts/production/BemSelectableRaffleBSC.sol";
const SERIES = "contracts/production/BemContainerSeriesBSC.sol", OLD = "contracts/BemCircuitRaffle.sol";
const LEAF = "contracts/production/Bem2075RaffleBSC.sol";
const MOCKS = "contracts/mocks/MockRaffleDependencies.sol", ACCOUNT_MOCKS = "contracts/mocks/MockRaffleRoundOpener.sol";
const GATEWAY = "test/ProductionSeriesGateway.sol";
const sources = Object.fromEntries([BASE, BSC, SERIES, LEAF, OLD, MOCKS, ACCOUNT_MOCKS].map(name => [name, { content: readFileSync(`${ROOT}${name}`, "utf8") }]));
sources[GATEWAY] = { content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract ProductionSeriesGateway {
    mapping(bytes32 => address) private accounts;
    mapping(bytes32 => bool) private opened;
    bool public rejectReads;
    function configure(address nft, uint256 id, address account, bool isOpen) external {
        bytes32 key = keccak256(abi.encode(nft,id)); accounts[key] = account; opened[key] = isOpen;
    }
    function setRejectReads(bool value) external { rejectReads = value; }
    function accountOf(address nft,uint256 id) external view returns(address) {
        require(!rejectReads,"mock gateway unavailable"); return accounts[keccak256(abi.encode(nft,id))];
    }
    function isOpened(address nft,uint256 id) external view returns(bool) {
        require(!rejectReads,"mock gateway unavailable"); return opened[keccak256(abi.encode(nft,id))];
    }
}` };
const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } })));
const errors = (output.errors ?? []).filter(item => item.severity === "error");
assert.deepEqual(errors, [], errors.map(item => item.formattedMessage).join("\n"));
const artifact = (file, name) => output.contracts[file][name];
const RAW = `0x${sources[BASE].content.match(/CIRCUIT_RAW = hex"([a-fA-F0-9]+)"/)[1]}`;
const A = {
  token: getAddress("0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a"),
  circuit: getAddress("0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C"),
  coordinator: getAddress("0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9"),
  opener: getAddress("0x021745DE2f42A7839d96f2d3634d0294487D81F1"),
  dead: getAddress("0x000000000000000000000000000000000000dEaD")
};
const bindings = [
  { name: "Behemoth 2075", nft: A.circuit, id: 2075n, account: getAddress("0x358BE84b95224d228f3A61964Fa3c9fB61D7B646"), gas: 150_000 },
  { name: "TapeOut 13043", nft: getAddress("0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C"), id: 13043n, account: getAddress("0x167897fe1d2fE713E1D6C3661D1B08d5353B9D34"), gas: 200_000 }
];
const UNIT = 100_000_000n, PRICE = 1_000_000n, POOL = 100n * UNIT;
const BSC_TX_GAS_CAP = 16_777_216n, PURCHASE_CAP = 500;
const GAS = { gasLimit: BSC_TX_GAS_CAP }, EXEC_FEE = 200_000_000_000_000n;
const checks = [];
function check(name, body) { test(name, async t => { const row = { name, passed: false }; checks.push(row);
  try { await body(t, row); row.passed = true; } catch (error) { row.error = error.message; throw error; } }); }
test.after(() => {
  const dir = `${ROOT}outputs/bem-raffle-2075/production`; mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/verification-series.json`, JSON.stringify({ status: checks.every(t => t.passed) ? "passed" : "failed",
    checkedAt: new Date().toISOString(), scope: "local_mocks", compilerVersion: solc.version(),
    sourceSha256s: Object.fromEntries([BASE, BSC, SERIES, LEAF].map(name => [name, createHash("sha256").update(sources[name].content).digest("hex")])),
    note: "BEHEMOTH 2075 scenarios deploy the fixed Bem2075RaffleBSC release leaf. The generic series also validates the internal 13043 binding. Official addresses contain injected local mocks; no mainnet VRF proof or wallet signature is verified.",
    releaseContract: "Bem2075RaffleBSC", transactionGasLimit: String(BSC_TX_GAS_CAP),
    tests: checks, mainnetTransactionsSent: 0 }, null, 2) + "\n");
});
const sent = async promise => (await promise).wait();
async function fails(promise) { await assert.rejects(async () => sent(promise), error => {
  assert.equal(error.receipt?.status, 0); assert.deepEqual(error.receipt.logs, []); return true;
}); }
function events(contract, receipt, name) {
  return receipt.logs.filter(log => log.address.toLowerCase() === String(contract.target).toLowerCase()).flatMap(log => {
    try { const parsed = contract.interface.parseLog(log); return parsed?.name === name ? [parsed.args] : []; } catch { return []; }
  });
}
async function setup(t, binding = bindings[0], fixedLeaf = binding.id === 2075n) {
  const rpc = ganache.provider({ chain: { chainId: 56, hardfork: "shanghai" }, miner: { timestampIncrement: 0, blockGasLimit: Number(BSC_TX_GAS_CAP) },
    logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 100 } });
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await rpc.disconnect(); });
  const [admin, alice, bob, keeper, nextHolder] = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i)));
  const addresses = await Promise.all([admin, alice, bob, keeper, nextHolder].map(s => s.getAddress()));
  for (const [address, file, name] of [[A.token, MOCKS, "MockRaffleToken"], [A.circuit, MOCKS, "MockRaffleCircuitSource"],
    [A.coordinator, ACCOUNT_MOCKS, "MockRaffleBudgetCoordinator"], [binding.account, ACCOUNT_MOCKS, "MockRaffleRoundOpener"],
    [A.opener, GATEWAY, "ProductionSeriesGateway"]]) {
    await rpc.request({ method: "evm_setAccountCode", params: [address, `0x${artifact(file, name).evm.deployedBytecode.object}`] });
  }
  await rpc.request({ method: "evm_setAccountStorageAt", params: [A.token, ZeroHash, toBeHex(8, 32)] });
  const token = new Contract(A.token, artifact(MOCKS, "MockRaffleToken").abi, admin);
  const circuit = new Contract(A.circuit, artifact(MOCKS, "MockRaffleCircuitSource").abi, admin);
  const coordinator = new Contract(A.coordinator, artifact(ACCOUNT_MOCKS, "MockRaffleBudgetCoordinator").abi, admin);
  const account = new Contract(binding.account, artifact(ACCOUNT_MOCKS, "MockRaffleRoundOpener").abi, admin);
  const opener = new Contract(A.opener, artifact(GATEWAY, "ProductionSeriesGateway").abi, admin);
  await sent(circuit.setNetlist(RAW)); await sent(coordinator.setNextRequestId(1));
  await sent(account.configure(addresses[0], 56, binding.nft, binding.id));
  await sent(opener.configure(binding.nft, binding.id, binding.account, true));
  const c = fixedLeaf ? artifact(LEAF, "Bem2075RaffleBSC") : artifact(SERIES, "BemContainerSeriesBSC");
  const factory = new ContractFactory(c.abi, `0x${c.evm.bytecode.object}`, admin);
  const args = fixedLeaf ? [123n, 3, binding.gas] : [binding.nft, binding.id, binding.account, 123n, 3, binding.gas];
  const game = await factory.deploy(...args); await game.waitForDeployment();
  for (const signer of [alice, bob]) {
    await sent(token.mint(await signer.getAddress(), 1_000n * UNIT));
    await sent(token.connect(signer).approve(game.target, MaxUint256));
  }
  return { rpc, provider, admin, alice, bob, keeper, nextHolder, addresses, token, circuit, coordinator, account, opener, game, binding, factory, args, fixedLeaf };
}
async function buyBatches(s, signer, count) {
  const receipts = [];
  while (count > 0) {
    const n = Math.min(count, PURCHASE_CAP); receipts.push(await sent(s.game.connect(signer).buy(1, n, GAS))); count -= n;
  }
  for (const receipt of receipts) assert.ok(receipt.gasUsed < BSC_TX_GAS_CAP);
  return receipts;
}
const authorize = s => s.account.execute(s.game.target, 0, s.game.interface.encodeFunctionData("authorizeSeries"), 0, { ...GAS, value: EXEC_FEE });
async function at(s, time) {
  await s.rpc.request({ method: "evm_setTime", params: [Number(time) * 1000] });
  await s.rpc.request({ method: "evm_mine", params: [] });
  assert.equal(BigInt((await s.provider.getBlock("latest")).timestamp), BigInt(time));
}

check("only the two exact official tuples can be fixed; registry mismatch rejects deployment", async t => {
  const s = await setup(t, bindings[0], false);
  for (const [nft, id, account] of [[bindings[0].nft, 13043n, bindings[0].account], [bindings[1].nft, 2075n, bindings[1].account],
    [bindings[0].nft, 2075n, bindings[1].account], [bindings[1].nft, 13043n, s.addresses[0]]]) {
    await assert.rejects(async () => { const g = await s.factory.deploy(nft, id, account, 123, 3, 200_000, GAS); await g.waitForDeployment(); });
  }
  await sent(s.opener.configure(s.binding.nft, s.binding.id, s.addresses[0], true));
  const tx = await s.factory.getDeployTransaction(...s.args);
  await assert.rejects(s.provider.call(tx), error => { assert.equal(s.game.interface.parseError(error.data).name, "InvalidContainer"); return true; });
});

for (const binding of bindings) {
  check(`${binding.name}: activation requires its opened bound container, and recipient equals that container`, async t => {
    const s = await setup(t, binding), g = s.game;
    assert.equal(await g.CONTAINER(), binding.account); assert.equal(await g.organizer(), binding.account);
    assert.equal(await g.AUTHORIZATION_NFT(), binding.nft); assert.equal(await g.AUTHORIZATION_TOKEN_ID(), binding.id);
    assert.equal(await g.CIRCUITS(), A.circuit); assert.equal(await g.CIRCUIT_ID(), 2075n); assert.equal(await g.fundingWindow(), 259_200n);
    assert.equal(await g.MAX_TICKETS_PER_PURCHASE(), BigInt(PURCHASE_CAP));
    if (binding.id === 2075n) {
      assert.equal(s.fixedLeaf, true);
      assert.deepEqual(artifact(LEAF, "Bem2075RaffleBSC").abi.find(x => x.type === "constructor").inputs.map(x => x.type), ["uint256", "uint16", "uint32"]);
      for (const name of ["setOrganizer", "setContainer", "setFundingWindow", "withdraw", "reroll", "upgradeTo"]) assert.equal(g.interface.getFunction(name), null);
    }
    const creation = await g.deploymentTransaction().wait();
    assert.deepEqual(Array.from(events(g, creation, "ContainerBindingFixed")[0]), [binding.account, binding.nft, binding.id]);
    await fails(g.connect(s.alice).buySelected(1, [0], GAS)); await fails(g.openNextRound(GAS));
    await fails(g.authorizeSeries(GAS)); await fails(g.connect(s.keeper).authorizeSeries(GAS));
    await sent(s.opener.configure(binding.nft, binding.id, binding.account, false)); await fails(authorize(s));
    await sent(s.opener.configure(binding.nft, binding.id, binding.account, true));
    await sent(s.account.configure(s.addresses[0], 97, binding.nft, binding.id)); await fails(authorize(s));
    await sent(s.account.configure(s.addresses[0], 56, binding.nft, binding.id + 1n)); await fails(authorize(s));
    await sent(s.account.configure(s.addresses[0], 56, binding.nft, binding.id));
    await sent(s.opener.configure(binding.nft, binding.id, s.addresses[0], true)); await fails(authorize(s));
    await sent(s.opener.configure(binding.nft, binding.id, binding.account, true));
    const activation = await sent(authorize(s)), block = await s.provider.getBlock(activation.blockNumber);
    assert.equal(await g.seriesAuthorized(), true); assert.equal((await g.rounds(1)).status, 1n);
    assert.equal((await g.rounds(1)).fundingDeadline, BigInt(block.timestamp) + 259_200n);
    assert.equal(await g.totalLiability(), 0n); assert.equal(await s.token.balanceOf(g.target), 0n);
    await fails(authorize(s));
  });

  check(`${binding.name}: mixed tickets auto-request VRF, fixed result pays 4/1/95 and opens after exactly 60 seconds`, async (t, row) => {
    const s = await setup(t, binding), g = s.game;
    await sent(authorize(s));
    await sent(g.connect(s.alice).buySelected(1, [0, 5_365, 9_999], GAS));
    const purchases = await buyBatches(s, s.bob, 9_997), lock = purchases.at(-1);
    const round = await g.rounds(1), timing = await g.drawTiming(1), lockedBlock = await s.provider.getBlock(lock.blockNumber);
    assert.equal(round.status, 3n); assert.equal(round.requestId, 1n); assert.equal(await s.coordinator.requestCount(), 1n);
    assert.equal(timing.lockedAt, BigInt(lockedBlock.timestamp)); assert.equal(timing.targetDrawBy, timing.lockedAt + 60n);
    await fails(g.requestDraw(1, GAS)); await fails(g.connect(s.alice).buySelected(2, [1], GAS));
    await fails(g.connect(s.alice).rawFulfillRandomWords(1, [123, 456], GAS));
    if (binding.id === 13043n) {
      await at(s, timing.lockedAt + 3_601n);
      await fails(g.openRefunds(1, GAS)); await fails(g.connect(s.bob).buy(2, 1, GAS));
    }
    const words = [20n | (245n << 12n), 0xabcdefn];
    const callback = await sent(s.coordinator.fulfillWithGas(g.target, 1, words, binding.gas, { gasLimit: 500_000 }));
    row.callbackGasBudget = binding.gas; row.callbackGasUsed = String(events(s.coordinator, callback, "CallbackBudgetUsed")[0].gasUsed);
    const scheduled = await g.drawTiming(1); assert.ok(scheduled.scheduledDrawAt >= timing.lockedAt + 8n && scheduled.scheduledDrawAt <= timing.lockedAt + 30n);
    await sent(s.coordinator.fulfill(g.target, 1, [999, 888], { gasLimit: 500_000 }));
    assert.equal((await g.rounds(1)).ticketWord, words[0]); assert.equal((await g.rounds(1)).circuitWord, words[1]);
    // Mock a subsequent NFT sale and unavailable/frozen container. Settlement
    // must use the stored binding, not a new holder authorization or owner read.
    await sent(s.account.setOwnerForTest(s.addresses[4])); await sent(s.account.setFrozen(true));
    await sent(s.account.setRejectReads(true)); await sent(s.opener.setRejectReads(true));
    if (binding.id === 2075n) {
      await at(s, scheduled.scheduledDrawAt - 1n); await fails(g.settle(1, GAS));
      await at(s, scheduled.scheduledDrawAt);
    }
    const winnerBefore = await s.token.balanceOf(s.addresses[1]), containerBefore = await s.token.balanceOf(binding.account);
    const deadBefore = await s.token.balanceOf(A.dead);
    const receipt = await sent(g.connect(s.keeper).settle(1, GAS));
    const transfers = events(s.token, receipt, "Transfer").filter(e => e.from.toLowerCase() === String(g.target).toLowerCase());
    assert.deepEqual(transfers.map(e => [e.to, e.amount]), [[A.dead, 4n * UNIT], [binding.account, UNIT], [s.addresses[1], 95n * UNIT]]);
    assert.equal((await g.rounds(1)).winner, s.addresses[1]); assert.equal((await g.rounds(1)).winningTicket, 5_365n);
    assert.equal(await s.token.balanceOf(s.addresses[1]), winnerBefore + 95n * UNIT);
    assert.equal(await s.token.balanceOf(binding.account), containerBefore + UNIT); assert.equal(await s.token.balanceOf(A.dead), deadBefore + 4n * UNIT);
    const resolvedAt = BigInt((await s.provider.getBlock(receipt.blockNumber)).timestamp), opensAt = await g.nextRoundOpensAt();
    assert.equal(opensAt, resolvedAt + 60n); assert.equal((await g.drawTiming(1)).settledAt, resolvedAt);
    await at(s, opensAt - 1n); await fails(g.connect(s.bob).openNextRound(GAS)); await fails(g.connect(s.alice).buySelected(2, [5_365], GAS));
    await at(s, opensAt); await sent(g.connect(s.bob).openNextRound(GAS));
    await sent(g.connect(s.bob).buySelected(2, [5_365], GAS));
    assert.equal((await g.rounds(2)).fundingDeadline, opensAt + 259_200n);
    assert.equal(await g.ticketOwner(1, 5_365), s.addresses[1]); assert.equal(await g.ticketOwner(2, 5_365), s.addresses[2]);
    assert.equal(await g.totalLiability(), PRICE); row.winningTicket = "5365"; row.finalPurchaseGas = String(lock.gasUsed);
    row.maxPurchaseGas = String(purchases.reduce((max, r) => r.gasUsed > max ? r.gasUsed : max, 0n));
    row.contractName = s.fixedLeaf ? "Bem2075RaffleBSC" : "BemContainerSeriesBSC";
  });
}

check("VRF request failure rolls back the final chosen ticket, full payment and round advancement", async t => {
  const s = await setup(t), g = s.game; await sent(authorize(s));
  await buyBatches(s, s.alice, 9_999); await sent(s.coordinator.setNextRequestId(0));
  const before = await s.token.balanceOf(s.addresses[2]), allowance = await s.token.allowance(s.addresses[2], g.target);
  await fails(g.connect(s.bob).buySelected(1, [9_999], GAS));
  assert.equal(await g.currentRoundId(), 1n); assert.equal((await g.rounds(1)).status, 1n); assert.equal((await g.rounds(1)).sold, 9_999n);
  assert.equal(await g.ticketOwner(1, 9_999), ZeroAddress); assert.equal(await g.ticketBuyerId(1, s.addresses[2]), 0n);
  assert.equal(await g.totalLiability(), 9_999n * PRICE); assert.equal(await s.token.balanceOf(s.addresses[2]), before);
  assert.equal(await s.token.allowance(s.addresses[2], g.target), allowance);
  assert.equal((await g.drawTiming(1)).lockedAt, 0n); assert.equal(await s.coordinator.requestCount(), 0n);
  await sent(s.coordinator.setNextRequestId(1)); await sent(g.connect(s.bob).buySelected(1, [9_999], GAS));
  assert.equal((await g.rounds(1)).status, 3n); assert.equal(await g.ticketOwner(1, 9_999), s.addresses[2]);
});

check("expired partial funding has a 60-second next-round cooldown with old refund funds reserved", async t => {
  const s = await setup(t, bindings[1]), g = s.game; await sent(authorize(s));
  await sent(g.connect(s.alice).buySelected(1, [5, 99], GAS));
  const deadline = (await g.rounds(1)).fundingDeadline;
  await at(s, deadline - 1n); await fails(g.openRefunds(1, GAS));
  await at(s, deadline); await sent(g.connect(s.keeper).openRefunds(1, GAS));
  const opensAt = await g.nextRoundOpensAt(); assert.equal(opensAt, deadline + 60n);
  await at(s, opensAt - 1n); await fails(g.connect(s.bob).buySelected(2, [5], GAS));
  await at(s, opensAt); await fails(g.connect(s.bob).buySelected(1, [5], GAS));
  await sent(g.connect(s.bob).buySelected(2, [5], GAS));
  assert.equal(await g.totalLiability(), 3n * PRICE); assert.equal(await s.token.balanceOf(g.target), 3n * PRICE);
  const before = await s.token.balanceOf(s.addresses[1]); await sent(g.connect(s.keeper).refund(1, s.addresses[1], GAS));
  assert.equal(await s.token.balanceOf(s.addresses[1]), before + 2n * PRICE); assert.equal(await g.totalLiability(), PRICE);
  assert.equal(await g.ticketOwner(1, 5), s.addresses[1]); assert.equal(await g.ticketOwner(2, 5), s.addresses[2]);
  assert.equal(await g.nextRoundOpensAt(), opensAt); await fails(g.refund(1, s.addresses[1], GAS));
});

for (const purchase of [
  { bem: "0.1", count: 10, amount: 10_000_000n, method: "buySelected" },
  { bem: "1", count: 100, amount: 100_000_000n, method: "buy" }
]) {
  check(`local fixed 2075: ${purchase.bem} BEM purchase and exact refund preserve the 100 BEM pool rule`, async (t, row) => {
    // This is a partial contribution to the unchanged 100 BEM pool, not a
    // smaller-pool deployment. All transfers and time changes are local mocks.
    const s = await setup(t, bindings[0], true), g = s.game, participant = s.addresses[1];
    await sent(authorize(s));
    assert.equal(await g.ROUND_POOL(), POOL);
    assert.equal(await g.TICKET_PRICE(), PRICE);
    assert.equal(await s.token.decimals(), 8n);
    await sent(s.token.connect(s.alice).approve(g.target, purchase.amount));
    const originalBalance = await s.token.balanceOf(participant);
    const callerBalance = await s.token.balanceOf(s.addresses[3]);
    const containerBalance = await s.token.balanceOf(s.binding.account);
    const deadBalance = await s.token.balanceOf(A.dead);
    const supply = await s.token.totalSupply();
    const selected = Array.from({ length: purchase.count }, (_, i) => Math.floor(i * 9_999 / (purchase.count - 1)));
    const receipt = await sent(purchase.method === "buySelected"
      ? g.connect(s.alice).buySelected(1, selected, GAS)
      : g.connect(s.alice).buy(1, purchase.count, GAS));
    assert.equal(await s.token.balanceOf(participant), originalBalance - purchase.amount);
    assert.equal(await s.token.allowance(participant, g.target), 0n);
    assert.equal(await s.token.balanceOf(g.target), purchase.amount);
    assert.equal(await g.totalLiability(), purchase.amount);
    assert.equal(await g.ticketsOf(1, participant), BigInt(purchase.count));
    assert.equal((await g.rounds(1)).sold, BigInt(purchase.count));
    assert.equal((await g.rounds(1)).status, 1n);
    assert.equal(events(g, receipt, "TicketsPurchased").reduce((sum, e) => sum + e.paid, 0n), purchase.amount);
    const owned = purchase.method === "buySelected" ? selected : Array.from({ length: purchase.count }, (_, i) => i);
    for (const ticket of owned) assert.equal(await g.ticketOwner(1, ticket), participant);

    const deadline = (await g.rounds(1)).fundingDeadline;
    await at(s, deadline - 1n);
    await fails(g.connect(s.keeper).refund(1, participant, GAS));
    assert.equal(await s.token.balanceOf(participant), originalBalance - purchase.amount);
    assert.equal(await s.token.balanceOf(g.target), purchase.amount);
    assert.equal(await g.totalLiability(), purchase.amount);
    assert.equal(await g.ticketsOf(1, participant), BigInt(purchase.count));
    assert.equal((await g.rounds(1)).status, 1n);

    await at(s, deadline);
    // refund() itself opens refunds; the sponsor pays gas but never receives principal.
    const refundReceipt = await sent(g.connect(s.keeper).refund(1, participant, GAS));
    assert.deepEqual(events(s.token, refundReceipt, "Transfer").map(e => [e.from, e.to, e.amount]), [[getAddress(g.target), participant, purchase.amount]]);
    const refundEvent = events(g, refundReceipt, "Refunded")[0];
    assert.deepEqual(Array.from(refundEvent), [1n, participant, purchase.amount]);
    assert.equal(await s.token.balanceOf(participant), originalBalance);
    assert.equal(await s.token.balanceOf(s.addresses[3]), callerBalance);
    assert.equal(await s.token.balanceOf(g.target), 0n);
    assert.equal(await g.totalLiability(), 0n);
    assert.equal(await g.ticketsOf(1, participant), 0n);
    assert.equal((await g.rounds(1)).status, 6n);
    assert.equal(await g.currentRoundId(), 2n);
    assert.equal(await g.nextRoundOpensAt(), deadline + 60n);
    assert.equal(await s.token.balanceOf(s.binding.account), containerBalance);
    assert.equal(await s.token.balanceOf(A.dead), deadBalance);
    assert.equal(await s.token.totalSupply(), supply);
    assert.equal(await s.coordinator.requestCount(), 0n);
    assert.equal((await g.rounds(1)).winner, ZeroAddress);
    await fails(g.connect(s.keeper).refund(1, participant, GAS));
    assert.equal(await s.token.balanceOf(participant), originalBalance);
    assert.equal(await g.totalLiability(), 0n);
    assert.ok(receipt.gasUsed < BSC_TX_GAS_CAP);
    assert.ok(refundReceipt.gasUsed < BSC_TX_GAS_CAP);
    row.poolBem = "100"; row.purchaseBem = purchase.bem; row.purchaseMethod = purchase.method;
    row.paidBaseUnits = String(purchase.amount); row.refundedBaseUnits = String(refundEvent.amount);
    row.purchaseGas = String(receipt.gasUsed); row.refundGas = String(refundReceipt.gasUsed);
    row.contractName = "Bem2075RaffleBSC";
  });
}
