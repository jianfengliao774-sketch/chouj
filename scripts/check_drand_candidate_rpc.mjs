// Read-only BNB RPC simulation. No signer, account permission, or broadcast API.
import fs from 'node:fs';
import { Interface, formatUnits } from 'ethers';
import { compileDrandCandidate } from './lib/compile_drand_candidate.mjs';

const endpoint = process.argv[2] ?? 'https://bsc-rpc.publicnode.com';
const url = new URL(endpoint);
if (url.protocol !== 'https:' || url.username || url.password) throw Error('Use a public HTTPS RPC without credentials');
const artifact = compileDrandCandidate().contracts['DrandEvmnetVerifier.sol'].DrandEvmnetVerifier;
const abi = new Interface(artifact.abi);
const sample = JSON.parse(fs.readFileSync(new URL('../test/fixtures/drand/evmnet.json', import.meta.url)));
const simulatedAddress = '0x000000000000000000000000000000000000da7a';
let id = 0;
async function rpc(method, params) {
  if (!['eth_chainId','eth_blockNumber','eth_gasPrice','eth_call','eth_estimateGas'].includes(method)) throw Error('Not a permitted read');
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  if (!response.ok || body.error || !body.result) throw Error(JSON.stringify(body.error ?? { status: response.status }));
  return body.result;
}
if (await rpc('eth_chainId', []) !== '0x38') throw Error('Expected BNB mainnet chain ID 56');
const block = await rpc('eth_blockNumber', []);
const overrides = { [simulatedAddress]: { code: '0x' + artifact.evm.deployedBytecode.object } };
const call = { to: simulatedAddress, gas: '0x1e8480',
  data: abi.encodeFunctionData('verifyBeacon', [sample.beacon.round, '0x' + sample.beacon.signature]) };
const result = abi.decodeFunctionResult('verifyBeacon', await rpc('eth_call', [call, block, overrides]))[0];
if (result !== '0x' + sample.beacon.randomness) throw Error('Randomness differs from the public beacon');
let wrongRoundRejected = false;
try {
  await rpc('eth_call', [{ ...call, data: abi.encodeFunctionData('verifyBeacon',
    [sample.beacon.round + 1, '0x' + sample.beacon.signature]) }, block, overrides]);
} catch (error) {
  if (!/revert/i.test(error.message)) throw error;
  wrongRoundRejected = true;
}
if (!wrongRoundRejected) throw Error('Wrong round accepted');
const gasPrice = BigInt(await rpc('eth_gasPrice', []));
let verificationGas = null, gasEstimateError = null;
try { verificationGas = BigInt(await rpc('eth_estimateGas', [call, block, overrides])); }
catch (error) { gasEstimateError = error.message; }
const evidence = { checkedAt: new Date().toISOString(), mode: 'read-only eth_call with temporary code override; no deployed contract or transaction',
  endpoint, chainId: 56, blockNumber: String(BigInt(block)), beaconChainHash: sample.info.hash,
  beaconRound: sample.beacon.round, expectedRandomness: result, validSignatureAccepted: true, wrongRoundRejected,
  verificationOnlyEstimatedGas: verificationGas?.toString() ?? null,
  currentRpcGasPriceGwei: formatUnits(gasPrice, 'gwei'),
  verificationOnlyEstimatedBnb: verificationGas === null ? null : formatUnits(verificationGas * gasPrice, 18),
  gasEstimateError, compiler: compileDrandCandidate().compiler };
console.log(JSON.stringify(evidence, null, 2));
