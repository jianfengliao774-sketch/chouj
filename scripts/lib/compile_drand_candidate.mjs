import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export function compileDrandCandidate() {
  const root = fileURLToPath(new URL('../../contracts/drand-candidate/', import.meta.url));
  const sources = {};
  for (const name of ['DrandEvmnetVerifier.sol', 'TapeoutDrandRandomness.sol', 'BemDrandRaffleCandidate.sol',
    'vendor/BLS.sol', 'vendor/ModExp.sol', 'vendor/Precompiles.sol']) {
    sources[name] = { content: fs.readFileSync(path.join(root, name), 'utf8') };
  }
  const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } };
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings })));
  const errors = result.errors?.filter(error => error.severity === 'error') ?? [];
  if (errors.length) throw Error(errors.map(error => error.formattedMessage).join('\n'));
  return { compiler: solc.version(), settings, sources, contracts: result.contracts };
}
