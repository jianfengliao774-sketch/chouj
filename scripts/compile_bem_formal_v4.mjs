import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

// Offline V4 compilation only. No RPC, wallet, transaction or V1/V2/V3 writes.
const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = join(root, 'outputs/bem-raffle-2075/production-v4');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const preserved = JSON.parse(readFileSync(join(outputDir, 'preserved-v1-v3.sha256.json'), 'utf8'));
assert.equal(sha256(JSON.stringify(preserved.files)), '9854913afa59dd07a48ac059ea95a985ac522eb2fbadfe10f040513628e7f1cd', 'Frozen V1/V2/V3 manifest changed');
assert.equal(preserved.treeSha256, sha256(JSON.stringify(preserved.files)));
function guardPreserved() {
  for (const [name, expected] of Object.entries(preserved.files)) {
    assert.equal(sha256(readFileSync(join(root, name))), expected, `Deployed V1/V2/V3 file changed: ${name}`);
  }
}
guardPreserved();
const dependencies = [
  'contracts/production-v4/BemSelectableRaffleV4.sol',
  'contracts/production-v4/BemSelectableRaffle13061V4BSC.sol',
  'contracts/production-v4/BemOwnContainer13061SeriesBSC.sol',
];
const targets = [5, 10, 50, 100].map(pool => {
  const contractName = `BemOwnContainer13061Pool${pool}BSC`;
  const poolBaseUnits = BigInt(pool) * 100000000n;
  return { contractName, sourceName: `contracts/production-v4/${contractName}.sol`, fixedRules: {
    poolBaseUnits: String(poolBaseUnits), ticketPriceBaseUnits: String(poolBaseUnits / 10000n),
    ticketsPerRound: 10000, maxTicketsPerPurchase: 5000, maxTicketsPerAddress: 5000,
    blackholeBaseUnits: String(poolBaseUnits * BigInt({5:3,10:4,50:5,100:6}[pool]) / 100n), organizerBaseUnits: String(poolBaseUnits / 100n),
    winnerBaseUnits: String(poolBaseUnits * BigInt({5:96,10:95,50:94,100:93}[pool]) / 100n), fundingWindowSeconds: 86400, refundClaimWindowSeconds: 86400,
    partialFill: true,
  } };
});
const names = [...dependencies, ...targets.map(target => target.sourceName)];
const bytes = Object.fromEntries(names.map(name => [name, readFileSync(join(root, name))]));
const sourceSha256s = Object.fromEntries(names.map(name => [name, sha256(bytes[name])]));
const input = { language: 'Solidity', sources: Object.fromEntries(names.map(name => [name, { content: bytes[name].toString('utf8') }])),
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': [
    'abi', 'metadata', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object',
    'evm.deployedBytecode.immutableReferences', 'evm.deployedBytecode.linkReferences',
  ] } } } };
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter(item => item.severity === 'error');
assert.deepEqual(errors, [], errors.map(item => item.formattedMessage).join('\n'));
for (const warning of output.errors ?? []) console.warn(warning.formattedMessage);
guardPreserved();
const fixedBindings = {
  processor: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C', processorId: 2075,
  authorizationContainer: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  authorizationNft: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', authorizationTokenId: 13061,
  revenueContainer: '0x001f110422F04a90bF7D6eC96714f75046BD7126',
  revenueNft: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', revenueTokenId: 13061,
};
const architecture = 'container13061-tiered-5000-v4';
const partialFill = {
  resultEvent: 'PurchaseResult(uint256,address,uint32,uint32,uint256,uint256)',
  filled: 'min(requested, roundStock, addressQuota)',
  paid: 'filled * TICKET_PRICE', unspent: '(requested - filled) * TICKET_PRICE; never transferred from the buyer',
  zeroFill: 'Previously full expected round or exhausted current-round address quota. No token call, ticket allocation or VRF request.',
  selection: 'Validate the entire ascending unique selection, then allocate its filled-length prefix with deterministic sold-ticket replacement.',
};
mkdirSync(outputDir, { recursive: true });
for (const { sourceName, contractName, fixedRules } of targets) {
  const c = output.contracts[sourceName][contractName];
  assert.ok(c.evm.bytecode.object && c.evm.deployedBytecode.object, 'Missing candidate bytecode');
  assert.ok(c.evm.deployedBytecode.object.length / 2 <= 24576, 'Candidate exceeds EIP-170');
  assert.deepEqual(c.abi.find(item => item.type === 'constructor').inputs.map(item => item.type), ['uint256', 'uint16', 'uint32']);
  const artifact = {
    schemaVersion: 1, contractVersion: 4, architecture, status: 'production-candidate-not-deployed',
    contractName, sourceName, compilerVersion: solc.version(), sourceSha256: sourceSha256s[sourceName], sourceSha256s,
    preservedDeployedFileSha256s: preserved.files, preservedDeployedTreeSha256: preserved.treeSha256,
    optimizer: input.settings.optimizer, evmVersion: input.settings.evmVersion, fixedBindings, testOnly: false, fixedRules, partialFill,
    abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
    creationBytecodeBytes: c.evm.bytecode.object.length / 2, runtimeBytecodeBytes: c.evm.deployedBytecode.object.length / 2,
    linkReferences: c.evm.bytecode.linkReferences, deployedLinkReferences: c.evm.deployedBytecode.linkReferences,
    immutableReferences: c.evm.deployedBytecode.immutableReferences, metadata: JSON.parse(c.metadata),
  };
  const buildInfo = {
    status: artifact.status, contractVersion: 4, architecture, contractName, sourceName, compilerVersion: artifact.compilerVersion,
    sourceSha256s, preservedDeployedTreeSha256: preserved.treeSha256, preservedDeployedFileCount: Object.keys(preserved.files).length,
    optimizer: artifact.optimizer, evmVersion: artifact.evmVersion, fixedBindings, testOnly: false, fixedRules, partialFill,
    standardJsonSha256: sha256(JSON.stringify(input)), creationBytecodeBytes: artifact.creationBytecodeBytes,
    runtimeBytecodeBytes: artifact.runtimeBytecodeBytes, runtimeBytecodeIsTemplate: true,
    runtimeNote: 'Constructor immutables require comparison with the exact constructor and live getters. The template hash is not a deployed runtime hash.',
    unchangedTest1: true, staticSourceCompilation: true, mainnetTransactionsSent: 0,
    standardJsonInput: `${contractName}.compile-input.json`, artifact: `${contractName}.artifact.json`,
  };
  for (const [suffix, value] of [['artifact', artifact], ['abi', artifact.abi], ['compile-input', input], ['build-info', buildInfo]]) {
    writeFileSync(join(outputDir, `${contractName}.${suffix}.json`), JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
  guardPreserved();
  console.log(JSON.stringify({ contractName, contractVersion: 4, runtimeBytecodeBytes: artifact.runtimeBytecodeBytes,
    fixedBindings, fixedRules, oldFilesUnchanged: Object.keys(preserved.files).length, mainnetTransactionsSent: 0 }));
}
