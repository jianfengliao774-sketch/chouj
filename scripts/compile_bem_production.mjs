import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

// Offline static-source compilation only. No generator, RPC, signer or deployment.
const root = fileURLToPath(new URL("../", import.meta.url));
const base = "contracts/production/BemSelectableRaffle.sol";
const bsc = "contracts/production/BemSelectableRaffleBSC.sol";
const series = "contracts/production/BemContainerSeriesBSC.sol";
const leaf = "contracts/production/Bem2075RaffleBSC.sol";
const targets = [
  { name: "BemSelectableRaffle", source: base, dependencies: [base] },
  { name: "BemSelectableRaffleBSC", source: bsc, dependencies: [base, bsc] },
  { name: "BemContainerSeriesBSC", source: series, dependencies: [base, bsc, series] },
  { name: "Bem2075RaffleBSC", source: leaf, dependencies: [base, bsc, series, leaf] }
];
const loaded = Object.fromEntries([base, bsc, series, leaf].map(name => [name, readFileSync(join(root, name), "utf8")]));
const sha256 = value => createHash("sha256").update(value).digest("hex");
const builds = targets.map(target => {
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(target.dependencies.map(name => [name, { content: loaded[name] }])),
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "metadata", "evm.bytecode.object", "evm.bytecode.linkReferences",
        "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "evm.deployedBytecode.linkReferences"] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter(item => item.severity === "error");
  if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join("\n"));
  for (const warning of output.errors ?? []) console.warn(warning.formattedMessage);
  const c = output.contracts[target.source][target.name];
  if (!c.evm.bytecode.object || !c.evm.deployedBytecode.object) throw new Error(`Missing bytecode for ${target.name}`);
  const sourceSha256s = Object.fromEntries(target.dependencies.map(name => [name, sha256(loaded[name])]));
  const artifact = {
    status: "production-candidate-not-deployed",
    contractName: target.name, sourceName: target.source, compilerVersion: solc.version(),
    sourceSha256: sourceSha256s[target.source], sourceSha256s,
    optimizer: input.settings.optimizer, evmVersion: input.settings.evmVersion,
    abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
    creationBytecodeBytes: c.evm.bytecode.object.length / 2,
    runtimeBytecodeBytes: c.evm.deployedBytecode.object.length / 2,
    linkReferences: c.evm.bytecode.linkReferences, deployedLinkReferences: c.evm.deployedBytecode.linkReferences,
    immutableReferences: c.evm.deployedBytecode.immutableReferences, metadata: JSON.parse(c.metadata)
  };
  const buildInfo = {
    status: artifact.status, contractName: target.name, sourceName: target.source,
    compilerVersion: solc.version(), optimizer: input.settings.optimizer, evmVersion: input.settings.evmVersion,
    sourceSha256s, standardJsonSha256: sha256(JSON.stringify(input)),
    creationBytecodeBytes: c.evm.bytecode.object.length / 2,
    runtimeBytecodeBytes: c.evm.deployedBytecode.object.length / 2,
    runtimeBytecodeIsTemplate: true,
    runtimeNote: "Constructor immutables are populated during deployment; this template hash is not an on-chain runtime hash.",
    staticSourceCompilation: true, containerChoice: target.source === leaf
      ? "User-selected BEHEMOTH #2075 container; deployment and series authorization have not been performed by this compilation"
      : "Reusable internal layer; Bem2075RaffleBSC is the fixed release target",
    standardJsonInput: `${target.name}.compile-input.json`, artifact: `${target.name}.artifact.json`
  };
  if (buildInfo.runtimeBytecodeBytes > 24_576) throw new Error(`${target.name} exceeds the EIP-170 code-size limit`);
  return { target, input, artifact, buildInfo };
});

const out = join(root, "outputs/bem-raffle-2075/production");
mkdirSync(out, { recursive: true });
const saveJson = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n", "utf8");
for (const { target, input, artifact, buildInfo } of builds) {
  saveJson(`${target.name}.artifact.json`, artifact);
  saveJson(`${target.name}.abi.json`, artifact.abi);
  saveJson(`${target.name}.compile-input.json`, input);
  saveJson(`${target.name}.metadata.json`, artifact.metadata);
  saveJson(`${target.name}.build-info.json`, buildInfo);
  writeFileSync(join(out, `${target.name}.bytecode.txt`), artifact.bytecode + "\n", "utf8");
  writeFileSync(join(out, `${target.name}.deployed-bytecode.txt`), artifact.deployedBytecode + "\n", "utf8");
  console.log(JSON.stringify({ contract: target.name, compiler: artifact.compilerVersion, sourceSha256s: artifact.sourceSha256s,
    creationBytes: buildInfo.creationBytecodeBytes, runtimeTemplateBytes: buildInfo.runtimeBytecodeBytes }));
}
console.log(`Candidate artifacts only: ${out}`);
