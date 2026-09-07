const base='https://tapeout.cc.cd';
const state=await(await fetch(base+'/api/sparkdraw/state?pool=0.1')).json();
console.log(JSON.stringify({version:state.version,keeper:state.keeper,rounds:state.rounds.map(r=>({round:r.roundId,status:r.status,winningTicket:r.winningTicket}))}));
const html=await(await fetch(base+'/admin.html')).text();
console.log({adminVault:html.includes('自动开奖保险箱'),feeDisclosure:html.includes('0.0002')});
const home=await(await fetch(base+'/')).text();
const assets=[...home.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(x=>x[1]);
let replay=false;
for(const a of assets){const code=await(await fetch(new URL(a,base))).text();replay ||= code.includes('卷轴滚动中');}
console.log({replayBundle:replay,privateVaultApiStatus:(await fetch(base+'/api/admin/vault')).status});
