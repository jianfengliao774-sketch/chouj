import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

// Offline candidate compilation only. No RPC, wallet, deployment or production writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const oldSourceSha256s = {
  "contracts/production/BemSelectableRaffle.sol": "b6b7812a0eaf54d3e7b2f307bd4a552fd343952378f4615f590b1faa06fabb44",
  "contracts/production/BemSelectableRaffleBSC.sol": "a338742191c63affd11f779c2f724299e87c9950dcf75614651612e004938be2",
  "contracts/production/BemContainerSeriesBSC.sol": "ef1bc76983c30480bdb3afabec59622cca8d6d1c76a725ed63e0bde542743b40",
  "contracts/production/Bem2075RaffleBSC.sol": "75f24090ae026a7edb44df44c1a008ffe30dc974e2a4393d523fe907599040d8"
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
function guardOldSources() {
  for (const [name, expected] of Object.entries(oldSourceSha256s)) {
    assert.equal(sha256(readFileSync(join(root, name))), expected, `Deployed source changed: ${name}`);
  }
}
guardOldSources();
const targets = [
  { contractName: "Bem2075Raffle13061BSC", sourceName: "contracts/production-v2/Bem2075Raffle13061BSC.sol", testOnly: false,
    dependencies: ["contracts/production-v2/BemSelectableRaffleV2.sol", "contracts/production-v2/BemSelectableRaffle13061BSC.sol", "contracts/production-v2/BemContainer13061SeriesBSC.sol"],
    fixedRules: { poolBaseUnits: "10000000000", ticketPriceBaseUnits: "1000000", ticketsPerRound: 10000, maxTicketsPerPurchase: 1000, maxTicketsPerAddress: 5000,
      blackholeBaseUnits: "400000000", organizerBaseUnits: "100000000", winnerBaseUnits: "9500000000", fundingWindowSeconds: 86400, refundClaimWindowSeconds: 86400 } },
  { contractName: "Bem2075Raffle13061Test1BSC", sourceName: "contracts/production-v2/test1/Bem2075Raffle13061Test1BSC.sol", testOnly: true,
    dependencies: ["contracts/production-v2/BemSelectableRaffleV2.sol", "contracts/production-v2/BemSelectableRaffle13061BSC.sol", "contracts/production-v2/BemContainer13061SeriesBSC.sol"],
    fixedRules: { poolBaseUnits: "100000000", ticketPriceBaseUnits: "10000", ticketsPerRound: 10000, maxTicketsPerPurchase: 1000, maxTicketsPerAddress: 5000,
      blackholeBaseUnits: "4000000", organizerBaseUnits: "1000000", winnerBaseUnits: "95000000", fundingWindowSeconds: 86400, refundClaimWindowSeconds: 86400 } },
  { contractName: "Bem2075Raffle13061Pool10BSC", sourceName: "contracts/production-v2/pool10/Bem2075Raffle13061Pool10BSC.sol", testOnly: false,
    dependencies: ["contracts/production-v2/BemSelectableRaffleV2.sol", "contracts/production-v2/BemSelectableRaffle13061BSC.sol", "contracts/production-v2/BemContainer13061SeriesBSC.sol"],
    fixedRules: { poolBaseUnits: "1000000000", ticketPriceBaseUnits: "100000", ticketsPerRound: 10000, maxTicketsPerPurchase: 1000, maxTicketsPerAddress: 5000,
      blackholeBaseUnits: "40000000", organizerBaseUnits: "10000000", winnerBaseUnits: "950000000", fundingWindowSeconds: 86400, refundClaimWindowSeconds: 86400 } },
  { contractName: "Bem2075Raffle13061Pool50BSC", sourceName: "contracts/production-v2/pool50/Bem2075Raffle13061Pool50BSC.sol", testOnly: false,
    dependencies: ["contracts/production-v2/BemSelectableRaffleV2.sol", "contracts/production-v2/BemSelectableRaffle13061BSC.sol", "contracts/production-v2/BemContainer13061SeriesBSC.sol"],
    fixedRules: { poolBaseUnits: "5000000000", ticketPriceBaseUnits: "500000", ticketsPerRound: 10000, maxTicketsPerPurchase: 1000, maxTicketsPerAddress: 5000,
      blackholeBaseUnits: "200000000", organizerBaseUnits: "50000000", winnerBaseUnits: "4750000000", fundingWindowSeconds: 86400, refundClaimWindowSeconds: 86400 } }
];
const builds = targets.map(({ sourceName, contractName, dependencies, testOnly, fixedRules }) => {
const names = [...dependencies, sourceName];
const sourceBytes = Object.fromEntries(names.map(name => [name, readFileSync(join(root, name))]));
const sourceSha256s = Object.fromEntries(names.map(name => [name, sha256(sourceBytes[name])]));
const input = { language: "Solidity", sources: Object.fromEntries(names.map(name => [name, { content: sourceBytes[name].toString("utf8") }])),
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": [
    "abi", "metadata", "evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object",
    "evm.deployedBytecode.immutableReferences", "evm.deployedBytecode.linkReferences"
  ] } } } };
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter(item => item.severity === "error");
assert.deepEqual(errors, [], errors.map(item => item.formattedMessage).join("\n"));
for (const warning of output.errors ?? []) console.warn(warning.formattedMessage);
const c = output.contracts[sourceName][contractName];
assert.ok(c.evm.bytecode.object && c.evm.deployedBytecode.object, "Missing candidate bytecode");
assert.ok(c.evm.deployedBytecode.object.length / 2 <= 24_576, "Candidate exceeds EIP-170");
assert.deepEqual(c.abi.find(item => item.type === "constructor").inputs.map(item => item.type), ["uint256", "uint16", "uint32"]);
const fixedBindings = {
  processor: "0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C", processorId: 2075,
  authorizationContainer: "0x358BE84b95224d228f3A61964Fa3c9fB61D7B646",
  revenueContainer: "0x001f110422F04a90bF7D6eC96714f75046BD7126",
  revenueNft: "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C", revenueTokenId: 13061
};
const artifact = {
  schemaVersion: 1, status: "production-candidate-not-deployed", contractName, sourceName, compilerVersion: solc.version(),
  sourceSha256: sourceSha256s[sourceName], sourceSha256s, preservedProductionSourceSha256s: oldSourceSha256s,
  optimizer: input.settings.optimizer, evmVersion: input.settings.evmVersion, fixedBindings, testOnly, fixedRules,
  abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
  creationBytecodeBytes: c.evm.bytecode.object.length / 2, runtimeBytecodeBytes: c.evm.deployedBytecode.object.length / 2,
  linkReferences: c.evm.bytecode.linkReferences, deployedLinkReferences: c.evm.deployedBytecode.linkReferences,
  immutableReferences: c.evm.deployedBytecode.immutableReferences, metadata: JSON.parse(c.metadata)
};
const buildInfo = { status: artifact.status, contractName, sourceName, compilerVersion: artifact.compilerVersion,
  sourceSha256s, preservedProductionSourceSha256s: oldSourceSha256s, optimizer: artifact.optimizer, evmVersion: artifact.evmVersion,
  fixedBindings, testOnly, fixedRules, standardJsonSha256: sha256(JSON.stringify(input)), creationBytecodeBytes: artifact.creationBytecodeBytes,
  runtimeBytecodeBytes: artifact.runtimeBytecodeBytes, runtimeBytecodeIsTemplate: true,
  runtimeNote: "Constructor immutables require separate verification against live getters; the template hash is not an on-chain runtime hash.",
  staticSourceCompilation: true, mainnetTransactionsSent: 0,
  standardJsonInput: `${contractName}.compile-input.json`, artifact: `${contractName}.artifact.json` };
return { contractName, artifact, buildInfo, input };
});
guardOldSources();
const out = join(root, "outputs/bem-raffle-2075/production-v2");
mkdirSync(out, { recursive: true });
for (const { contractName, artifact, buildInfo, input } of builds) {
for (const [suffix, value] of [["artifact", artifact], ["abi", artifact.abi], ["compile-input", input], ["build-info", buildInfo]]) {
  writeFileSync(join(out, `${contractName}.${suffix}.json`), JSON.stringify(value, null, 2) + "\n", "utf8");
}
guardOldSources();
console.log(JSON.stringify({ status: artifact.status, contractName, creationBytecodeBytes: artifact.creationBytecodeBytes,
  runtimeBytecodeBytes: artifact.runtimeBytecodeBytes, testOnly: artifact.testOnly, fixedRules: artifact.fixedRules,
  fixedBindings: artifact.fixedBindings, oldProductionSourcesUnchanged: true, mainnetTransactionsSent: 0 }));
}
