import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ganache from "ganache";
import solc from "solc";
import { BrowserProvider, Contract, ContractFactory, MaxUint256, ZeroAddress, ZeroHash, getAddress, toBeHex } from "ethers";

// This suite executes only an in-memory Ganache chain with deliberately mocked
// token, circuit and VRF dependencies. It is not evidence of live BSC execution.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BASE = "contracts/production/BemSelectableRaffle.sol";
const BSC = "contracts/production/BemSelectableRaffleBSC.sol";
const OLD = "contracts/BemCircuitRaffle.sol";
const MOCKS = "contracts/mocks/MockRaffleDependencies.sol";
const files = [BASE, BSC, OLD, MOCKS];
const sources = Object.fromEntries(files.map(name => [name, { content: readFileSync(`${ROOT}${name}`, "utf8") }]));
const RAW = `0x${sources[BASE].content.match(/CIRCUIT_RAW = hex"([a-fA-F0-9]+)"/)[1]}`;
const BEM = getAddress("0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a");
const CIRCUITS = getAddress("0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C");
const COORDINATOR = getAddress("0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9");
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");
const LANE = "0x130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4";
const UNIT = 100_000_000n, PRICE = 1_000_000n, POOL = 100n * UNIT;
const BSC_TX_GAS_CAP = 16_777_216n;
const PURCHASE_CAP = 500;
const GAS = { gasLimit: BSC_TX_GAS_CAP };
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } })));
const errors = (compiled.errors ?? []).filter(item => item.severity === "error");
assert.deepEqual(errors, [], errors.map(item => item.formattedMessage).join("\n"));
const artifact = (file, name) => compiled.contracts[file][name];
const wrapper = artifact(BSC, "BemSelectableRaffleBSC");
const checks = [];
function check(name, fn) {
  test(name, async t => {
    const entry = { name, passed: false }; checks.push(entry);
    try { await fn(t, entry); entry.passed = true; }
    catch (error) { entry.error = error.message; throw error; }
  });
}
test.after(() => {
  const output = `${ROOT}outputs/bem-raffle-2075/production`;
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/verification-selectable.json`, JSON.stringify({ status: checks.every(c => c.passed) ? "passed" : "failed",
    checkedAt: new Date().toISOString(), scope: "local_mocks", compilerVersion: solc.version(),
    note: "In-memory Ganache only. Official addresses contain local mocks, not real mainnet code or VRF proofs. Base and BSC layer are not the final container series.",
    sourceSha256s: Object.fromEntries([BASE, BSC].map(name => [name, createHash("sha256").update(sources[name].content).digest("hex")])),
    transactionGasLimit: String(BSC_TX_GAS_CAP), tests: checks, mainnetTransactionsSent: 0 }, null, 2) + "\n");
});
async function sent(promise) { return (await promise).wait(); }
async function rejected(promise) {
  let failure;
  try { await sent(promise); } catch (error) { failure = error; }
  assert.ok(failure, "transaction must revert");
  if (failure.receipt) assert.equal(failure.receipt.status, 0);
}
function events(contract, receipt, name) {
  return receipt.logs.filter(log => log.address.toLowerCase() === String(contract.target).toLowerCase()).flatMap(log => {
    try { const parsed = contract.interface.parseLog(log); return parsed?.name === name ? [parsed] : []; } catch { return []; }
  });
}
async function setup(t, chainId = 56) {
  const rpc = ganache.provider({ chain: { chainId, hardfork: "shanghai" }, miner: { blockGasLimit: Number(BSC_TX_GAS_CAP) },
    logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 100 } });
  t.after(async () => rpc.disconnect());
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(() => provider.destroy());
  const [admin, alice, bob, caller, organizer] = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i)));
  const addresses = await Promise.all([admin, alice, bob, caller, organizer].map(signer => signer.getAddress()));
  for (const [address, name] of [[BEM, "MockRaffleToken"], [CIRCUITS, "MockRaffleCircuitSource"], [COORDINATOR, "MockRaffleCoordinator"]]) {
    await rpc.request({ method: "evm_setAccountCode", params: [address, `0x${artifact(MOCKS, name).evm.deployedBytecode.object}`] });
  }
  // Runtime injection skips mock constructors; set only the local decimals slot.
  await rpc.request({ method: "evm_setAccountStorageAt", params: [BEM, ZeroHash, toBeHex(8, 32)] });
  const token = new Contract(BEM, artifact(MOCKS, "MockRaffleToken").abi, admin);
  const circuit = new Contract(CIRCUITS, artifact(MOCKS, "MockRaffleCircuitSource").abi, admin);
  const coordinator = new Contract(COORDINATOR, artifact(MOCKS, "MockRaffleCoordinator").abi, admin);
  await sent(circuit.setNetlist(RAW)); await sent(coordinator.setNextRequestId(1));
  const factory = new ContractFactory(wrapper.abi, `0x${wrapper.evm.bytecode.object}`, admin);
  const args = [addresses[4], 123n, 3, 200_000];
  const s = { rpc, provider, admin, alice, bob, caller, organizer, addresses, token, circuit, coordinator, factory, args };
  if (chainId !== 56) return s;
  s.game = await factory.deploy(...args); await s.game.waitForDeployment();
  for (const signer of [alice, bob]) {
    await sent(token.mint(await signer.getAddress(), 1_000n * UNIT));
    await sent(token.connect(signer).approve(s.game.target, MaxUint256));
  }
  return s;
}
async function ledger(s, roundId, participant) {
  return { participantBalance: await s.token.balanceOf(participant), gameBalance: await s.token.balanceOf(s.game.target),
    allowance: await s.token.allowance(participant, s.game.target), sold: (await s.game.rounds(roundId)).sold,
    liability: await s.game.totalLiability(), count: await s.game.ticketsOf(roundId, participant), buyerId: await s.game.ticketBuyerId(roundId, participant) };
}
async function unchangedRevert(s, roundId, signer, action) {
  const participant = await signer.getAddress(), before = await ledger(s, roundId, participant);
  await rejected(action()); assert.deepEqual(await ledger(s, roundId, participant), before);
}
async function passTime(s, seconds) {
  await s.rpc.request({ method: "evm_increaseTime", params: [seconds] });
  await s.rpc.request({ method: "evm_mine", params: [] });
}
function pair(high, low) { return BigInt(high) | (BigInt(low) << 12n); }
// Batches exist only in this test harness. The contract and player UI never
// silently split one wallet authorization into multiple purchases.
async function buyBatches(s, signer, count, round = 1) {
  const receipts = [];
  while (count > 0) {
    const n = Math.min(count, PURCHASE_CAP); receipts.push(await sent(s.game.connect(signer).buy(round, n, GAS))); count -= n;
  }
  for (const receipt of receipts) assert.ok(receipt.gasUsed < BSC_TX_GAS_CAP);
  return receipts;
}
async function selectBatches(s, signer, tickets, round = 1) {
  const receipts = [];
  for (let i = 0; i < tickets.length; i += PURCHASE_CAP) receipts.push(await sent(s.game.connect(signer).buySelected(round, tickets.slice(i, i + PURCHASE_CAP), GAS)));
  for (const receipt of receipts) assert.ok(receipt.gasUsed < BSC_TX_GAS_CAP);
  return receipts;
}
const maxGas = receipts => String(receipts.reduce((max, receipt) => receipt.gasUsed > max ? receipt.gasUsed : max, 0n));

check("BSC configuration pins official dependencies, 72 hours and live-call interface", async t => {
  const s = await setup(t), g = s.game;
  assert.equal(wrapper.abi.find(x => x.type === "constructor").inputs.length, 4);
  assert.equal(await g.BSC_CHAIN_ID(), 56n); assert.equal(await g.bem(), BEM);
  assert.equal(await g.coordinator(), COORDINATOR); assert.equal(await g.keyHash(), LANE);
  assert.equal(await g.CIRCUITS(), CIRCUITS); assert.equal(await g.CIRCUIT_ID(), 2075n);
  assert.equal(await g.fundingWindow(), 259_200n); assert.equal(await g.drawWindow(), 3_600n);
  assert.equal(await g.MAX_TICKETS_PER_PURCHASE(), BigInt(PURCHASE_CAP));
  assert.equal(await g.organizer(), s.addresses[4]); assert.equal(await g.subscriptionId(), 123n);
  assert.ok(g.interface.getFunction("buySelected(uint256,uint16[])"));
  assert.ok(g.interface.getFunction("ticketWords(uint256,uint16,uint16)"));
  assert.equal(g.interface.getFunction("entryCount"), null);
  assert.equal(await g.runCircuit2075(4095), 270n);
});

check("BSC candidate rejects another chain before dependency interaction", async t => {
  const s = await setup(t, 97), transaction = await s.factory.getDeployTransaction(...s.args);
  await assert.rejects(s.provider.call(transaction), error => {
    const parsed = s.factory.interface.parseError(error.data); assert.equal(parsed.name, "UnsupportedChain");
    assert.equal(parsed.args.chainId, 97n); return true;
  });
  await assert.rejects(async () => { const g = await s.factory.deploy(...s.args, GAS); await g.waitForDeployment(); });
});

check("explicit boundary tickets and auto allocation agree with packed ownership and paid event ranges", async t => {
  const s = await setup(t), chosen = [0, 1, 15, 16, 9_998, 9_999];
  const r = await sent(s.game.connect(s.alice).buySelected(1, chosen, GAS));
  const buys = events(s.game, r, "TicketsPurchased");
  assert.deepEqual(buys.map(e => [e.args.firstTicket, e.args.endExclusive]), [[0n, 2n], [15n, 17n], [9998n, 10000n]]);
  assert.equal(buys.reduce((sum, e) => sum + e.args.paid, 0n), BigInt(chosen.length) * PRICE);
  await sent(s.game.connect(s.bob).buy(1, 17, GAS));
  const words = await s.game.ticketWords(1, 0, 625);
  for (const ticket of chosen) assert.equal(await s.game.ticketOwner(1, ticket), s.addresses[1]);
  for (const ticket of [2, 14, 17, 20]) assert.equal(await s.game.ticketOwner(1, ticket), s.addresses[2]);
  assert.equal(await s.game.ticketOwner(1, 21), ZeroAddress);
  for (const ticket of [0, 1, 15, 16, 20, 21, 9998, 9999]) {
    const id = (words[Math.floor(ticket / 16)] >> BigInt((ticket % 16) * 16)) & 65535n;
    assert.equal(await s.game.ticketBuyer(1, id), await s.game.ticketOwner(1, ticket));
  }
  assert.equal((await s.game.rounds(1)).sold, 23n);
  assert.equal(await s.game.totalLiability(), 23n * PRICE);
  assert.equal((await s.game.ticketWords(1, 625, 0)).length, 0);
  await assert.rejects(s.game.ticketWords(1, 625, 1)); await assert.rejects(s.game.ticketOwner(1, 10_000));
});

check("empty, duplicate, unsorted and out-of-range selections revert every booking and payment", async t => {
  const s = await setup(t);
  for (const selected of [[], [1, 1], [5, 4], [8, 10_000], [0, 65_535]]) {
    await unchangedRevert(s, 1, s.alice, () => s.game.connect(s.alice).buySelected(1, selected, GAS));
  }
  for (const count of [0, 10_001]) await unchangedRevert(s, 1, s.alice, () => s.game.connect(s.alice).buy(1, count, GAS));
  assert.equal((await s.game.rounds(1)).status, 0n); assert.equal(await s.game.ticketOwner(1, 8), ZeroAddress);
});

check("per-purchase cap rejects 501 automatic or chosen tickets before funding, ownership or payment changes", async t => {
  const s = await setup(t), selected = Array.from({ length: PURCHASE_CAP + 1 }, (_, i) => i);
  for (const method of ["buy", "buySelected"]) {
    const value = method === "buy" ? selected.length : selected;
    await assert.rejects(s.game.connect(s.alice)[method].staticCall(1, value), error => {
      const parsed = s.game.interface.parseError(error.data); assert.equal(parsed.name, "PurchaseLimitExceeded");
      assert.deepEqual(Array.from(parsed.args), [BigInt(PURCHASE_CAP + 1), BigInt(PURCHASE_CAP)]); return true;
    });
    await unchangedRevert(s, 1, s.alice, () => s.game.connect(s.alice)[method](1, value, GAS));
  }
  assert.equal((await s.game.rounds(1)).status, 0n); assert.equal(await s.game.ticketOwner(1, PURCHASE_CAP), ZeroAddress);
  await sent(s.game.connect(s.alice).buySelected(1, selected.slice(0, PURCHASE_CAP), GAS));
  await sent(s.game.connect(s.alice).buySelected(1, [PURCHASE_CAP], GAS));
  assert.equal(await s.game.ticketsOf(1, s.addresses[1]), BigInt(PURCHASE_CAP + 1));
});

check("a sold number atomically rejects another buyer including earlier free numbers in its batch", async t => {
  const s = await setup(t); await sent(s.game.connect(s.alice).buySelected(1, [16], GAS));
  await assert.rejects(s.game.connect(s.bob).buySelected.staticCall(1, [8, 16]), error => {
    const parsed = s.game.interface.parseError(error.data); assert.equal(parsed.name, "TicketAlreadySold");
    assert.equal(parsed.args.ticket, 16n); return true;
  });
  await unchangedRevert(s, 1, s.bob, () => s.game.connect(s.bob).buySelected(1, [8, 16], GAS));
  assert.equal(await s.game.ticketOwner(1, 8), ZeroAddress); assert.equal(await s.game.ticketOwner(1, 16), s.addresses[1]);
  await sent(s.game.connect(s.bob).buySelected(1, [8], GAS));
  assert.equal(await s.game.ticketBuyerId(1, s.addresses[2]), 2n);
});

check("missing approval, insufficient balance and taxed transfer roll back assigned ticket IDs", async t => {
  const s = await setup(t);
  await sent(s.token.connect(s.alice).approve(s.game.target, 0));
  await unchangedRevert(s, 1, s.alice, () => s.game.connect(s.alice).buySelected(1, [0, 9_999], GAS));
  await sent(s.token.connect(s.caller).approve(s.game.target, MaxUint256));
  await unchangedRevert(s, 1, s.caller, () => s.game.connect(s.caller).buySelected(1, [0, 9_999], GAS));
  await sent(s.token.connect(s.alice).approve(s.game.target, MaxUint256));
  await sent(s.token.setTaxDeposits(true));
  const supply = await s.token.totalSupply();
  await unchangedRevert(s, 1, s.alice, () => s.game.connect(s.alice).buySelected(1, [0, 9_999], GAS));
  assert.equal(await s.token.totalSupply(), supply); assert.equal(await s.game.ticketOwner(1, 0), ZeroAddress);
  assert.equal(await s.game.ticketOwner(1, 9_999), ZeroAddress);
});

check("expired funding preserves historical ownership while stale and future round orders cannot spend", async t => {
  const s = await setup(t);
  for (const round of [0, 2]) await unchangedRevert(s, 1, s.alice, () => s.game.connect(s.alice).buySelected(round, [5], GAS));
  await sent(s.game.connect(s.alice).buySelected(1, [5, 9_999], GAS));
  await passTime(s, 259_200); await sent(s.game.connect(s.caller).openRefunds(1));
  assert.equal(await s.game.currentRoundId(), 2n);
  await unchangedRevert(s, 2, s.bob, () => s.game.connect(s.bob).buySelected(1, [5], GAS));
  await sent(s.game.connect(s.bob).buySelected(2, [5], GAS));
  const before = await s.token.balanceOf(s.addresses[1]);
  await sent(s.game.connect(s.caller).refund(1, s.addresses[1], GAS));
  assert.equal(await s.token.balanceOf(s.addresses[1]), before + 2n * PRICE);
  assert.equal(await s.game.ticketOwner(1, 5), s.addresses[1]);
  assert.equal(await s.game.ticketOwner(2, 5), s.addresses[2]);
  assert.equal(await s.game.ticketsOf(1, s.addresses[1]), 0n); assert.equal(await s.game.totalLiability(), PRICE);
  await rejected(s.game.refund(1, s.addresses[1], GAS));
});

check("full mixed pool selects the actual numbered owner and retains mandatory circuit plus atomic 4/1/95", async (t, entry) => {
  const s = await setup(t), g = s.game;
  const selected = [0, 5_365, 9_999];
  await sent(g.connect(s.alice).buySelected(1, selected, GAS));
  const first = await buyBatches(s, s.bob, 9500);
  await unchangedRevert(s, 1, s.bob, () => g.connect(s.bob).buy(1, 498, GAS));
  const full = await sent(g.connect(s.bob).buy(1, 497, GAS)); entry.maxPurchaseGas = maxGas([...first, full]);
  const words = await g.ticketWords(1, 0, 625), a = await g.ticketBuyerId(1, s.addresses[1]), b = await g.ticketBuyerId(1, s.addresses[2]);
  for (let ticket = 0; ticket < 10_000; ticket++) assert.equal((words[Math.floor(ticket / 16)] >> BigInt((ticket % 16) * 16)) & 65535n, selected.includes(ticket) ? a : b);
  assert.equal(await g.totalLiability(), POOL); assert.equal(await s.token.balanceOf(g.target), POOL);
  await unchangedRevert(s, 2, s.alice, () => g.connect(s.alice).buySelected(1, [1], GAS));
  await sent(g.connect(s.caller).requestDraw(1, GAS));
  assert.equal(await s.coordinator.lastSubId(), 123n); assert.equal(await s.coordinator.lastNumWords(), 2n);
  await sent(s.coordinator.fulfill(g.target, 1, [pair(20, 245), 0], GAS));
  await sent(s.circuit.setEvalMode(1)); await rejected(g.connect(s.bob).settle(1, GAS));
  assert.equal((await g.rounds(1)).status, 4n); assert.equal((await g.rounds(1)).drawCursor, 0n);
  await sent(s.circuit.setEvalMode(2)); await rejected(g.connect(s.bob).settle(1, GAS));
  await sent(s.circuit.setEvalMode(0));
  await sent(s.token.setFailure(s.addresses[1], 1));
  const deadBefore = await s.token.balanceOf(DEAD), orgBefore = await s.token.balanceOf(s.addresses[4]);
  await rejected(g.connect(s.bob).settle(1, GAS));
  assert.equal(await s.token.balanceOf(DEAD), deadBefore); assert.equal(await s.token.balanceOf(s.addresses[4]), orgBefore);
  assert.equal(await g.totalLiability(), POOL);
  await sent(s.token.setFailure(ZeroAddress, 0));
  const winnerBefore = await s.token.balanceOf(s.addresses[1]), supply = await s.token.totalSupply();
  const settlement = await sent(g.connect(s.caller).settle(1, GAS));
  assert.equal((await g.rounds(1)).winningTicket, 5_365n); assert.equal((await g.rounds(1)).winner, s.addresses[1]);
  const transfers = events(s.token, settlement, "Transfer").filter(e => e.args.from.toLowerCase() === String(g.target).toLowerCase());
  assert.deepEqual(transfers.map(e => [e.args.to, e.args.amount]), [[DEAD, 4n * UNIT], [s.addresses[4], UNIT], [s.addresses[1], 95n * UNIT]]);
  assert.equal(await s.token.balanceOf(s.addresses[1]), winnerBefore + 95n * UNIT);
  assert.equal(await s.token.totalSupply(), supply); assert.equal(await g.totalLiability(), 0n);
  entry.winningTicket = "5365"; entry.settlementGas = String(settlement.gasUsed);
});

check("alternating selected numbers and automatic gaps fill all tickets without overwritten ownership", async (t, entry) => {
  const s = await setup(t), evens = Array.from({ length: 5_000 }, (_, i) => i * 2);
  const explicit = await selectBatches(s, s.alice, evens);
  const automatic = await buyBatches(s, s.bob, 5_000);
  const a = await s.game.ticketBuyerId(1, s.addresses[1]), b = await s.game.ticketBuyerId(1, s.addresses[2]);
  const words = await s.game.ticketWords(1, 0, 625);
  for (let ticket = 0; ticket < 10_000; ticket++) assert.equal((words[Math.floor(ticket / 16)] >> BigInt((ticket % 16) * 16)) & 65535n, ticket % 2 === 0 ? a : b);
  for (const receipts of [explicit, automatic]) {
    const ranges = receipts.flatMap(receipt => events(s.game, receipt, "TicketsPurchased")); assert.equal(ranges.length, 5_000);
    assert.equal(ranges.reduce((sum, e) => sum + e.args.paid, 0n), 50n * UNIT);
  }
  assert.equal(await s.game.totalLiability(), POOL);
  entry.maxExplicitGas = maxGas(explicit); entry.maxAutomaticGas = maxGas(automatic);
});

check("500 scattered selections touching 500 fresh storage words fit the BSC transaction gas cap", async (t, entry) => {
  const s = await setup(t);
  // Every twentieth ticket gives 500 isolated events and the maximal 500 new words.
  const selected = Array.from({ length: PURCHASE_CAP }, (_, i) => i * 20);
  assert.equal(new Set(selected.map(ticket => Math.floor(ticket / 16))).size, PURCHASE_CAP);
  const receipt = await sent(s.game.connect(s.alice).buySelected(1, selected, GAS));
  assert.ok(receipt.gasUsed < BSC_TX_GAS_CAP);
  assert.equal(events(s.game, receipt, "TicketsPurchased").length, PURCHASE_CAP);
  for (const ticket of [0, 20, 9960, 9980]) assert.equal(await s.game.ticketOwner(1, ticket), s.addresses[1]);
  assert.equal(await s.game.ticketOwner(1, 9999), ZeroAddress);
  entry.selectedCount = PURCHASE_CAP; entry.freshStorageWords = PURCHASE_CAP; entry.isolatedEventRanges = PURCHASE_CAP;
  entry.purchaseGas = String(receipt.gasUsed); entry.gasHeadroom = String(BSC_TX_GAS_CAP - receipt.gasUsed);
});

check("automatic allocation can scan 9999 previously selected tickets to the final free ticket under the gas cap", async (t, entry) => {
  const s = await setup(t);
  const receipts = await selectBatches(s, s.alice, Array.from({ length: 9999 }, (_, i) => i));
  const last = await sent(s.game.connect(s.bob).buy(1, 1, GAS));
  assert.ok(last.gasUsed < BSC_TX_GAS_CAP);
  assert.equal(await s.game.ticketOwner(1, 9998), s.addresses[1]); assert.equal(await s.game.ticketOwner(1, 9999), s.addresses[2]);
  assert.equal((await s.game.rounds(1)).sold, 10000n); assert.equal(await s.game.totalLiability(), POOL);
  entry.maxEarlierPurchaseGas = maxGas(receipts); entry.scanPurchaseGas = String(last.gasUsed);
  entry.gasHeadroom = String(BSC_TX_GAS_CAP - last.gasUsed);
});
