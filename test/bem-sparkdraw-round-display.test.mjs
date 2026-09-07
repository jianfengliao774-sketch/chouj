import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Interface} from 'ethers';
import {formatSiteTime} from '../bem-production-site/web/site-time.js';
import {roundDisplay,numberedRound} from '../bem-production-site/web/round-display.js';
import {globalRoundLabels} from '../bem-production-site/sparkdraw-round-numbering.mjs';
import {sparkDrawRecords} from '../bem-production-site/sparkdraw-records.mjs';
import {createSparkDrawService} from '../bem-production-site/sparkdraw-service.mjs';
import {createAdminCredential} from '../bem-production-site/auth.mjs';
const seconds=iso=>Date.parse(iso)/1000;
test('numeric UTC daily identifiers remain the same in both languages; visible time switches timezone',()=>{
  const moment='2026-09-07T23:59:59Z';assert.equal(numberedRound(seconds(moment),1),'202609070001');assert.equal(numberedRound(seconds('2026-09-08T00:00:00Z'),1),'202609080001');
  assert.equal(formatSiteTime(moment,'zh'),'2026-09-08 07:59:59 北京时间 (UTC+8)');assert.equal(formatSiteTime(moment,'en'),'2026-09-07 23:59:59 UTC+0');
  const round={roundId:'25',displayRoundId:'202609070002'};assert.equal(roundDisplay(round,{language:'zh'}),roundDisplay(round,{language:'en'}));
});
test('confirmed events keep one cumulative sequence across UTC dates while preserving contract IDs',()=>{
  const times=['2026-09-06T23:59:59Z','2026-09-07T00:00:00Z','2026-09-07T23:59:59Z','2026-09-08T00:00:00Z'];
  const events=times.map((timeUtc,i)=>({name:'RoundStarted',args:{roundId:String(i+1),fundingDeadline:String(seconds(timeUtc)+86400)},timeUtc,blockNumber:i+1,logIndex:0}));
  const rows=sparkDrawRecords(events,{pool:'5',address:'0x'+'1'.repeat(40),roundLabels:globalRoundLabels([{poolId:'5',events}])}).publicRounds;
  assert.deepEqual(rows.map(r=>r.displayRoundId),['202609080004','202609070003','202609070002','202609060001']);assert.deepEqual(rows.map(r=>r.roundId),['4','3','2','1']);
});
test('unindexed rounds do not invent potentially duplicate global numbers',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sparkdraw-daily-'));const credential=await createAdminCredential('fixture-daily','test-only-password');
  const iface=new Interface(JSON.parse(await fs.readFile(new URL('../bem-production-site/web/sparkdraw-abi.json',import.meta.url),'utf8')));
  const starts=[0,seconds('2026-09-06T23:59:00Z'),seconds('2026-09-07T00:01:00Z'),seconds('2026-09-07T16:00:00Z')];
  const rpc=async(method,params)=>{
    if(method==='eth_blockNumber')return '0x1';
    if(method==='eth_getBlockByNumber')return{number:'0x1',hash:'0x'+'b'.repeat(64),timestamp:'0x'+seconds('2026-09-08T00:01:00Z').toString(16)};
    const c=iface.parseTransaction(params[0]);const values={currentRoundId:[4],rounds:[0,0,starts[Number(c.args.length?c.args[0]:0)]?starts[Number(c.args.length?c.args[0]:0)]+86400:0,0,0,0,0,0,0,'0x'+'0'.repeat(40)],earlyDrawDeadline:[0],sealedAt:[0],beaconRound:[0],prizes:[0,0,0,false,false],unclaimedPrincipalBurned:[false]};return iface.encodeFunctionResult(c.fragment,values[c.name]);
  };
  const service=await createSparkDrawService({directory,credential,rpc,verify:false});t.after(async()=>{service.server.emit('close');await fs.rm(directory,{recursive:true,force:true});});
  const state=await service.state('5');assert.equal(state.rounds[0].displayRoundId,null);assert.equal(state.rounds[1].displayRoundId,null);assert.equal(state.rounds[1].roundId,'3');
});

test('all pools share one sequence in chain order, using only the common confirmed range',()=>{
 const event=(roundId,blockNumber,logIndex)=>({name:'RoundStarted',args:{roundId},blockNumber,logIndex,timeUtc:'2026-09-07T00:00:00Z'});
 const pools=[{poolId:'5',events:[event('1',3,2),event('2',6,0)]},{poolId:'0.1',events:[event('1',2,0),event('2',3,1)]}];
 const a=globalRoundLabels(pools,3);assert.deepEqual([...a.values()].map(r=>r.displayRoundId),['202609070001','202609070002','202609070003']);assert.equal(a.get('5:1').globalSequence,'3');assert.equal(a.has('5:2'),false);
 const b=globalRoundLabels(pools,6);assert.equal(b.get('5:1').displayRoundId,a.get('5:1').displayRoundId);assert.equal(b.get('5:2').displayRoundId,'202609070004');
});
