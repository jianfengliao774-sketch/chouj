import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync,writeFileSync,mkdirSync } from "node:fs";
import { ZeroAddress,getAddress } from "ethers";
import { setup,sent,fails,at,activate,events,fillRound,A,UNIT,PRICE,GAS,GAS_CAP,artifact,sources,ROOT,BASE,BSC,SERIES,LEAF,denominations,solc } from "./helpers/bem-container-v2-fixture.mjs";
const POOL=100n*UNIT;
const preservedProductionSourceSha256s={
"contracts/production/BemSelectableRaffle.sol":"b6b7812a0eaf54d3e7b2f307bd4a552fd343952378f4615f590b1faa06fabb44",
"contracts/production/BemSelectableRaffleBSC.sol":"a338742191c63affd11f779c2f724299e87c9950dcf75614651612e004938be2",
"contracts/production/BemContainerSeriesBSC.sol":"ef1bc76983c30480bdb3afabec59622cca8d6d1c76a725ed63e0bde542743b40",
"contracts/production/Bem2075RaffleBSC.sol":"75f24090ae026a7edb44df44c1a008ffe30dc974e2a4393d523fe907599040d8"};
const sha256=v=>createHash("sha256").update(v).digest("hex");
function guardOldSources(){for(const[file,hash]of Object.entries(preservedProductionSourceSha256s))assert.equal(sha256(readFileSync(ROOT+file)),hash);}
guardOldSources();
const checks=[];
function check(name,body){test(name,async t=>{const row={name,passed:false};checks.push(row);try{await body(t,row);row.passed=true;}catch(e){row.error=e.message;throw e;}});}
test.after(()=>{guardOldSources();const dir=ROOT+"outputs/bem-raffle-2075/production-v2";mkdirSync(dir,{recursive:true});
writeFileSync(dir+"/verification-container13061.json",JSON.stringify({status:checks.every(r=>r.passed)?"passed":"failed",checkedAt:new Date().toISOString(),scope:"local_mocks",compilerVersion:solc.version(),sourceSha256s:Object.fromEntries([BASE,BSC,SERIES,LEAF,...denominations.map(s=>s.leaf)].map(n=>[n,sha256(sources[n].content)])),preservedProductionSourceSha256s,tests:checks,mainnetTransactionsSent:0,mainnetDeployed:false},null,2)+"\n");});
check("13061 only receives revenue; the original 2075 container alone activates the unchanged processor and rules", async t => {
  const s = await setup(t), g = s.game;
  assert.equal(await g.organizer(), A.revenue); assert.equal(await g.REVENUE_CONTAINER(), A.revenue);
  assert.equal(await g.REVENUE_NFT(), A.revenueNft); assert.equal(await g.REVENUE_TOKEN_ID(), 13061n);
  assert.equal(await g.CONTAINER(), A.activation); assert.equal(await g.AUTHORIZATION_NFT(), A.circuit);
  assert.equal(await g.AUTHORIZATION_TOKEN_ID(), 2075n); assert.equal(await g.CIRCUITS(), A.circuit); assert.equal(await g.CIRCUIT_ID(), 2075n);
  assert.equal(await g.ROUND_POOL(), POOL); assert.equal(await g.TICKET_PRICE(), PRICE); assert.equal(await g.fundingWindow(), 86400n);
  assert.equal(await g.MAX_TICKETS_PER_PURCHASE(), 1000n);
  assert.deepEqual(artifact(LEAF, "Bem2075Raffle13061BSC").abi.find(item => item.type === "constructor").inputs.map(item => item.type), ["uint256", "uint16", "uint32"]);
  for (const name of ["setOrganizer", "setContainer", "setFundingWindow", "withdraw", "reroll", "upgradeTo"]) assert.equal(g.interface.getFunction(name), null);
  const creation = await g.deploymentTransaction().wait();
  assert.deepEqual(Array.from(events(g, creation, "ContainerBindingFixed")[0]), [A.activation, A.circuit, 2075n]);
  assert.deepEqual(Array.from(events(g, creation, "RevenueBindingFixed")[0]), [A.revenue, A.revenueNft, 13061n]);
  await fails(g.connect(s.alice).buySelected(1, [0], GAS)); await fails(g.authorizeSeries(GAS));
  await fails(activate(s, s.revenue)); assert.equal(await g.seriesAuthorized(), false);
  await sent(s.opener.configure(A.circuit, 2075, A.activation, false)); await fails(activate(s));
  await sent(s.opener.configure(A.circuit, 2075, A.activation, true));
  await sent(s.activation.configure(s.addresses[0], 56, A.revenueNft, 13061)); await fails(activate(s));
  await sent(s.activation.configure(s.addresses[0], 56, A.circuit, 2075));
  const receipt = await sent(activate(s));
  assert.equal(await g.seriesAuthorized(), true); assert.equal((await g.rounds(1)).status, 1n);
  assert.equal((await g.rounds(1)).fundingDeadline, BigInt((await s.provider.getBlock(receipt.blockNumber)).timestamp) + 86400n);
  await fails(activate(s));
});

check("candidate deployment rejects a revenue registry mismatch, unopened account or wrong token binding", async t => {
  const s = await setup(t);
  const rejectsDeploy = async () => assert.rejects(async () => { const g = await s.factory.deploy(...s.args, GAS); await g.waitForDeployment(); });
  await sent(s.opener.configure(A.revenueNft, 13061, A.activation, true)); await rejectsDeploy();
  await sent(s.opener.configure(A.revenueNft, 13061, A.revenue, false)); await rejectsDeploy();
  await sent(s.opener.configure(A.revenueNft, 13061, A.revenue, true));
  await sent(s.revenue.configure(s.addresses[0], 97, A.revenueNft, 13061)); await rejectsDeploy();
  await sent(s.revenue.configure(s.addresses[0], 56, A.revenueNft, 13060)); await rejectsDeploy();
  await sent(s.revenue.configure(s.addresses[0], 56, A.circuit, 13061)); await rejectsDeploy();
});

for (const spec of [...denominations, {pool:100,price:1000000n,testOnly:false,name:"Bem2075Raffle13061BSC",leaf:LEAF}]) {
  spec.price=BigInt(spec.pool)*10000n;
  check(`${spec.pool} BEM ${spec.testOnly ? "test" : "production"}: all 10000 tickets settle 4% / 1% / 95% with no residual BEM`, async (t, row) => {
    const s = await setup(t, spec.pool), g = s.game, pool = BigInt(spec.pool) * UNIT;
    assert.equal(await g.TEST_ONLY(), spec.testOnly); assert.equal(await g.ROUND_POOL(), pool);
    assert.equal(await g.TICKETS_PER_ROUND(), 10000n); assert.equal(await g.MAX_TICKETS_PER_PURCHASE(), 1000n);
    assert.equal(await g.MAX_TICKETS_PER_ADDRESS(),5000n);
    assert.equal(await g.REFUND_CLAIM_WINDOW(),86400n);
    assert.equal(await g.TICKET_PRICE(), spec.price); assert.equal(await g.fundingWindow(), 86400n);
    assert.equal(await g.BLACKHOLE_AMOUNT(), pool * 4n / 100n);
    assert.equal(await g.ORGANIZER_AMOUNT(), pool / 100n); assert.equal(await g.WINNER_AMOUNT(), pool * 95n / 100n);
    assert.equal(await g.CIRCUITS(), A.circuit); assert.equal(await g.CIRCUIT_ID(), 2075n);
    assert.equal(await g.CONTAINER(), A.activation); assert.equal(await g.organizer(), A.revenue);
    assert.equal(await g.AUTHORIZATION_NFT(), A.circuit); assert.equal(await g.AUTHORIZATION_TOKEN_ID(), 2075n);
    await fails(activate(s, s.revenue)); await sent(activate(s));
    await fails(g.connect(s.alice).buy(1, 1001, GAS)); await fails(g.connect(s.alice).buySelected(1, [10000], GAS));
    assert.equal(await g.totalLiability(), 0n);
    // Zero-based 0 and9999 (display1 and10000) remain purchasable in every pool.
    const lock = await fillRound(s);
    assert.equal((await g.rounds(1)).sold, 10000n); assert.equal((await g.rounds(1)).status, 3n);
    assert.equal(await s.token.balanceOf(g.target), pool); assert.equal(await s.coordinator.requestCount(), 1n);
    assert.equal(await g.ticketOwner(1, 0), s.addresses[1]); assert.equal(await g.ticketOwner(1, 9999), s.addresses[1]);
    await assert.rejects(g.ticketOwner(1, 10000)); await assert.rejects(g.ticketWords(1, 625, 1));
    const lastWord = (await g.ticketWords(1, 624, 1))[0]; assert.equal(lastWord >> 240n, 1n);
    await fails(g.connect(s.alice).buySelected(1, [9999], GAS));
    // 60000 remains divisible by every fixed10000-ticket pool; rejection leaves
    // exactly6 accepted 16-bit candidates per ticket, including both endpoints.
    for (const [candidate, accepted, ticket] of [[0, true, 0], [9999, true, 9999], [59999, true, 9999], [60000, false, 0]]) {
      const word = BigInt(candidate >> 8) | (BigInt(candidate & 255) << 12n);
      const attempt = await g.previewAttempt(word, 0, 0);
      assert.equal(attempt.candidate, BigInt(candidate)); assert.equal(attempt.accepted, accepted);
      if (accepted) assert.equal(attempt.ticket, BigInt(ticket));
    }
    const counts = Array(10000).fill(0);
    for (let candidate = 0; candidate < 65536; candidate++) if (candidate < 60000) counts[candidate % 10000]++;
    assert.ok(counts.every(count => count === 6));
    const words = [39n | (15n << 12n), 123n];
    await sent(s.coordinator.fulfillWithGas(g.target, 1, words, 150000, { gasLimit: 500000 }));
    await at(s, (await g.drawTiming(1)).scheduledDrawAt);
    await sent(s.circuit.setEvalMode(1)); await fails(g.settle(1, GAS));
    assert.equal(await g.totalLiability(), pool); await sent(s.circuit.setEvalMode(0));
    const oldBalance = await s.token.balanceOf(A.activation);
    // A rejected middle transfer cannot leave a partial burn or committed winner.
    await sent(s.token.setFailure(A.revenue, 1)); await fails(g.settle(1, GAS));
    assert.equal(await s.token.balanceOf(A.dead), 0n); assert.equal(await g.totalLiability(), pool);
    assert.equal((await g.rounds(1)).winner, ZeroAddress); await sent(s.token.setFailure(A.revenue, 0));
    const receipt = await sent(g.connect(s.keeper).settle(1, GAS));
    assert.deepEqual(events(s.token, receipt, "Transfer").map(e => [e.from, e.to, e.amount]), [
      [getAddress(g.target), A.dead, pool * 4n / 100n], [getAddress(g.target), A.revenue, pool / 100n],
      [getAddress(g.target), s.addresses[1], pool * 95n / 100n]
    ]);
    assert.equal((await g.rounds(1)).winningTicket, 9999n); assert.equal((await g.rounds(1)).winner, s.addresses[1]);
    assert.equal(await s.token.balanceOf(g.target), 0n); assert.equal(await g.totalLiability(), 0n);
    assert.equal(await s.token.balanceOf(A.activation), oldBalance);
    const opensAt = await g.nextRoundOpensAt();
    assert.equal(opensAt, BigInt((await s.provider.getBlock(receipt.blockNumber)).timestamp) + 60n);
    await at(s, opensAt); await sent(g.openNextRound(GAS)); assert.equal((await g.rounds(2)).status, 1n);
    row.poolBem = String(spec.pool); row.ticketsPerRound = 10000; row.priceBaseUnits = String(spec.price);
    row.winningInternalTicket = "9999"; row.winningDisplayTicket = "10000";
    row.finalPurchaseGas = String(lock.gasUsed); row.settlementGas = String(receipt.gasUsed);
  });

  check(`${spec.pool} BEM: participant claims a partial refund themselves after24h and pays transaction gas`, async (t, row) => {
    const s = await setup(t, spec.pool), g = s.game, participant = s.addresses[1]; await sent(activate(s));
    const original = await s.token.balanceOf(participant), purchase = spec.price * 10n;
    await sent(s.token.connect(s.alice).approve(g.target, purchase));
    await sent(g.connect(s.alice).buySelected(1, [0, 9, 15, 16, 31, 63, 64, 95, 96, 9999], GAS));
    assert.equal(await g.totalLiability(), purchase); assert.equal((await g.rounds(1)).sold, 10n);
    const deadline = (await g.rounds(1)).fundingDeadline;
    await at(s, deadline - 1n); await fails(g.connect(s.alice).refund(1, participant, GAS));
    await at(s, deadline);
    const gasBefore = await s.provider.getBalance(participant);
    const tx = await g.connect(s.alice).refund(1, participant, GAS), receipt = await tx.wait();
    assert.equal(tx.from, participant); assert.equal(await s.provider.getBalance(participant), gasBefore - receipt.fee);
    assert.equal(await s.token.balanceOf(participant), original); assert.equal(await s.token.balanceOf(g.target), 0n);
    assert.equal(await g.totalLiability(), 0n); assert.equal(await g.ticketsOf(1, participant), 0n);
    assert.equal(await s.token.balanceOf(A.activation), 0n); assert.equal(await s.token.balanceOf(A.revenue), 0n);
    assert.equal(await s.token.balanceOf(A.dead), 0n); assert.equal(await s.coordinator.requestCount(), 0n);
    assert.equal(await g.currentRoundId(), 2n); await fails(g.connect(s.alice).refund(1, participant, GAS));
    row.poolBem = String(spec.pool); row.refundBaseUnits = String(purchase); row.claimedByParticipant = true;
    row.gasPaidBaseUnits = String(receipt.fee);
  });
}
