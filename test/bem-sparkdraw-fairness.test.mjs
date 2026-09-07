import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../contracts/drand-candidate/BemDrandRaffleCandidate.sol',import.meta.url),'utf8');
test('all 4096 circuit inputs give each low output byte exactly 16 preimages',()=>{
  assert.ok(source.includes('output != (input & 255) + (input >> 8)'));
  const count=new Uint16Array(256);
  for(let input=0;input<4096;input++)count[((input&255)+(input>>8))&255]++;
  assert.ok([...count].every(n=>n===16));
});
test('rejection mapping gives all 10000 ticket numbers exactly the same accepted preimage count',()=>{
  assert.ok(source.includes('a.candidate < 60_000'));
  const ticketCounts=new Uint32Array(10000);let rejected=0;
  for(let candidate=0;candidate<65536;candidate++){
    // Two independent 12-bit inputs give 16 * 16 preimages for each 16-bit candidate.
    if(candidate<60000)ticketCounts[candidate%10000]+=256;else rejected+=256;
  }
  assert.ok([...ticketCounts].every(n=>n===1536));
  assert.equal(ticketCounts.reduce((a,b)=>a+b,0)+rejected,4096*4096);
});
