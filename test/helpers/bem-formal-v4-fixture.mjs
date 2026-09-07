import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import solc from 'solc';
import { BrowserProvider, Contract, ContractFactory, MaxUint256, ZeroHash, getAddress, toBeHex } from 'ethers';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = 'contracts/production-v4/BemSelectableRaffleV4.sol';
const MOCKS = 'contracts/mocks/MockRaffleDependencies.sol';
const ACCOUNT = 'contracts/mocks/MockRaffleRoundOpener.sol';
const GATEWAY = 'test/Container13061Gateway.sol';
// Compile only the existing hostile dependency mocks. The small ABI stubs replace
// the imported old game so this fixture never compiles or deploys V1/V2 games.
const abiStubs = `library RaffleVRFClient {
    struct RandomWordsRequest { bytes32 keyHash; uint256 subId; uint16 requestConfirmations; uint32 callbackGasLimit; uint32 numWords; bytes extraArgs; }
}
interface BemCircuitRaffle { function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external; }`;
const sources = {
  [MOCKS]: { content: readFileSync(ROOT + MOCKS, 'utf8').replace('import "../BemCircuitRaffle.sol";', abiStubs) },
  [ACCOUNT]: { content: readFileSync(ROOT + ACCOUNT, 'utf8') },
};
sources[GATEWAY] = { content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract Container13061Gateway {
    mapping(bytes32 => address) private accounts;
    mapping(bytes32 => bool) private opened;
    bool public rejectReads;
    function configure(address nft,uint256 id,address account,bool isOpen) external {
        bytes32 key=keccak256(abi.encode(nft,id)); accounts[key]=account; opened[key]=isOpen;
    }
    function setRejectReads(bool value) external { rejectReads=value; }
    function accountOf(address nft,uint256 id) external view returns(address) {
        require(!rejectReads,"mock gateway unavailable"); return accounts[keccak256(abi.encode(nft,id))];
    }
    function isOpened(address nft,uint256 id) external view returns(bool) {
        require(!rejectReads,"mock gateway unavailable"); return opened[keccak256(abi.encode(nft,id))];
    }
}` };
const input = { language: "Solidity", sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris",
  outputSelection: { "*": { "*": ["abi", "evm.deployedBytecode.object"] } } } };
const output = JSON.parse(solc.compile(JSON.stringify(input)));
assert.deepEqual((output.errors ?? []).filter(e => e.severity === "error"), []);
const artifact = (file, name) => output.contracts[file][name];
const RAW = `0x${readFileSync(ROOT + BASE, "utf8").match(/CIRCUIT_RAW = hex"([a-fA-F0-9]+)"/)[1]}`;
const A = Object.fromEntries(Object.entries({
  token: "0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a", circuit: "0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C",
  coordinator: "0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9", opener: "0x021745DE2f42A7839d96f2d3634d0294487D81F1",
  activation: "0x358BE84b95224d228f3A61964Fa3c9fB61D7B646", revenue: "0x001f110422F04a90bF7D6eC96714f75046BD7126",
  revenueNft: "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C", dead: "0x000000000000000000000000000000000000dEaD"
}).map(([name, address]) => [name, getAddress(address)]));
const UNIT = 100_000_000n, PRICE = 1_000_000n, POOL = 100n * UNIT;
const GAS_CAP = 16_777_216n, GAS = { gasLimit: GAS_CAP }, EXEC_FEE = 200_000_000_000_000n;
const sent = async promise => (await promise).wait();
async function fails(promise) { await assert.rejects(async () => sent(promise), error => {
  assert.equal(error.receipt?.status, 0); assert.deepEqual(error.receipt.logs, []); return true;
}); }
function events(contract, receipt, name) {
  return receipt.logs.filter(log => log.address.toLowerCase() === String(contract.target).toLowerCase()).flatMap(log => {
    try { const event = contract.interface.parseLog(log); return event?.name === name ? [event.args] : []; } catch { return []; }
  });
}
async function setup(t, denomination = 100, options = {}) {
  const rpc = ganache.provider({ chain: { chainId: 56, hardfork: "shanghai" },
    miner: { timestampIncrement: 0, blockGasLimit: options.blockGasLimit ?? Number(GAS_CAP) }, logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 100 } });
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await rpc.disconnect(); globalThis.gc?.(); });
  const [admin, alice, bob, keeper, nextHolder] = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i)));
  const addresses = await Promise.all([admin, alice, bob, keeper, nextHolder].map(s => s.getAddress()));
  for (const [address, file, name] of [[A.token, MOCKS, "MockRaffleToken"], [A.circuit, MOCKS, "MockRaffleCircuitSource"],
    [A.coordinator, ACCOUNT, "MockRaffleBudgetCoordinator"], [A.activation, ACCOUNT, "MockRaffleRoundOpener"],
    [A.revenue, ACCOUNT, "MockRaffleRoundOpener"], [A.opener, GATEWAY, "Container13061Gateway"]]) {
    await rpc.request({ method: "evm_setAccountCode", params: [address, `0x${artifact(file, name).evm.deployedBytecode.object}`] });
  }
  await rpc.request({ method: "evm_setAccountStorageAt", params: [A.token, ZeroHash, toBeHex(8, 32)] });
  const token = new Contract(A.token, artifact(MOCKS, "MockRaffleToken").abi, admin);
  const circuit = new Contract(A.circuit, artifact(MOCKS, "MockRaffleCircuitSource").abi, admin);
  const coordinator = new Contract(A.coordinator, artifact(ACCOUNT, "MockRaffleBudgetCoordinator").abi, admin);
  const activation = new Contract(A.activation, artifact(ACCOUNT, "MockRaffleRoundOpener").abi, admin);
  const revenue = new Contract(A.revenue, artifact(ACCOUNT, "MockRaffleRoundOpener").abi, admin);
  const opener = new Contract(A.opener, artifact(GATEWAY, "Container13061Gateway").abi, admin);
  await sent(circuit.setNetlist(RAW)); await sent(coordinator.setNextRequestId(1));
  await sent(activation.configure(addresses[0], 56, A.circuit, 2075));
  await sent(revenue.configure(addresses[0], 56, A.revenueNft, 13061));
  await sent(opener.configure(A.circuit, 2075, A.activation, true));
  await sent(opener.configure(A.revenueNft, 13061, A.revenue, true));
  const artifactName = `BemOwnContainer13061Pool${denomination}BSC.artifact.json`;
  const c = JSON.parse(readFileSync(ROOT + 'outputs/bem-raffle-2075/production-v4/' + artifactName, 'utf8'));
  const factory = new ContractFactory(c.abi, c.bytecode, admin);
  const args = [123n, 3, 150_000], game = await factory.deploy(...args, GAS); await game.waitForDeployment();
  for (const signer of [alice, bob]) {
    await sent(token.mint(await signer.getAddress(), 1000n * UNIT));
    await sent(token.connect(signer).approve(game.target, MaxUint256));
  }
  return { rpc, provider, admin, alice, bob, keeper, nextHolder, addresses, token, circuit, coordinator, activation, revenue, opener, game, factory, args, pool: BigInt(denomination)*UNIT, price: BigInt(denomination)*10000n };
}
async function at(s, timestamp) {
  await s.rpc.request({ method: "evm_setTime", params: [Number(timestamp) * 1000] });
  await s.rpc.request({ method: "evm_mine", params: [] });
  assert.equal(BigInt((await s.provider.getBlock("latest")).timestamp), BigInt(timestamp));
}

export { setup, sent, fails, at, events, A, UNIT, GAS, ROOT };
