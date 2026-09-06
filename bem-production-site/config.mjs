import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SITE = fileURLToPath(new URL('./', import.meta.url));
export const GAME = '0xBee0848D0c77d434A52d1D0236FcBFdCA0834343';
export const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a';
export const CONTAINER = '0x358BE84b95224d228f3A61964Fa3c9fB61D7B646';
export const PROCESSOR = '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C';
export const COORDINATOR = '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9';
export const OPENER = '0x021745DE2f42A7839d96f2d3634d0294487D81F1';
export const CODE_HASH = '0x924ffeae37682ce516aa4cb8eae09a4cea9acd2148c12634efe60704ddab94b8';
export const SUBSCRIPTION = '77582411398321098948652233841078712279496169525251928512909841261362926957679';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const read = async name => JSON.parse(await fs.readFile(path.join(ROOT, 'outputs/bem-raffle-2075/production', name), 'utf8'));

export async function loadManifest() {
  const [plan, record, artifact] = await Promise.all([read('release-plan.json'), read('deployment-verified.json'), read('Bem2075RaffleBSC.artifact.json')]);
  assert.equal(record.status, 'verified_user_signed_deployment');
  assert.equal(plan.chainId, 56); assert.equal(record.chainId, 56);
  assert.ok(same(plan.deployment?.address, GAME) && same(record.address, GAME));
  assert.ok(same(plan.token.address, BEM) && same(plan.container.selected.address, CONTAINER));
  assert.ok(same(plan.evaluator.contract, PROCESSOR) && plan.evaluator.circuitId === 2075);
  assert.ok(same(plan.vrf.coordinator, COORDINATOR)); assert.equal(plan.vrf.subscriptionId, SUBSCRIPTION);
  assert.equal(record.runtimeCodeHash, CODE_HASH); assert.equal(plan.deployment.runtimeCodeHash, CODE_HASH);
  assert.equal(artifact.contractName, 'Bem2075RaffleBSC'); assert.equal(record.deploymentBlock, 120311123);
  const sourceFiles = ['BemSelectableRaffle.sol', 'BemSelectableRaffleBSC.sol', 'BemContainerSeriesBSC.sol', 'Bem2075RaffleBSC.sol'].map(name => `contracts/production/${name}`).sort();
  assert.deepEqual(Object.keys(artifact.sourceSha256s).sort(), sourceFiles);
  assert.deepEqual(Object.keys(record.sourceSha256s).sort(), sourceFiles);
  for (const [file, hash] of Object.entries(artifact.sourceSha256s)) {
    assert.match(file, /^contracts\/production\/[A-Za-z0-9]+\.sol$/);
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(ROOT, file))).digest('hex'), hash);
    assert.equal(record.sourceSha256s[file], hash);
  }
  return {
    schemaVersion: 1, mode: 'production', chainId: 56, chainName: 'BNB Chain', gameAddress: GAME,
    bemAddress: BEM, containerAddress: CONTAINER, processorAddress: PROCESSOR, circuitId: 2075,
    coordinatorAddress: COORDINATOR, openerAddress: OPENER, runtimeCodeHash: CODE_HASH,
    circuitHash: plan.evaluator.netlistHash, subscriptionId: SUBSCRIPTION,
    rpcUrl: '/rpc', explorerBase: 'https://bscscan.com', deploymentBlock: record.deploymentBlock,
    deploymentTransactionHash: record.transactionHash, gameAbi: artifact.abi,
    bemAbi: ['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
      'function approve(address,uint256) returns(bool)', 'function decimals() view returns(uint8)'],
    bemDecimals: 8, ticketPriceBaseUnits: '1000000', poolBaseUnits: '10000000000', maxTickets: 10000,
    maxTicketsPerPurchase: 500, blackholeAddress: '0x000000000000000000000000000000000000dEaD',
    blackholeBaseUnits: '400000000', organizerBaseUnits: '100000000', winnerBaseUnits: '9500000000',
    salesEnabled: false, salesStatus: 'configuration_pending', confirmations: 12, pollIntervalMs: 10000
  };
}
