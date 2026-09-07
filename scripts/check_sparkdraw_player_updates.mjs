// Read-only public checks: no authentication, private keys or wallet transactions.
const base='https://tapeout.cc.cd';
const get=async path=>{const r=await fetch(base+path,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('HTTP '+r.status);return r;};
const [home,admin,state]=await Promise.all([get('/?pool=0.1').then(r=>r.text()),get('/admin.html').then(r=>r.text()),get('/api/sparkdraw/state?pool=0.1').then(r=>r.json())]);
const report={refundRoundInputRemoved:!home.includes('id="refund-round"'),siteClock:home.includes('site-time'),privateKeyInput:admin.includes('vault-private-key'),importReady:state.keeper?.keyImportAvailable,savedKey:state.keeper?.savedKey,worker:state.keeper?.worker&&{address:state.keeper.worker.address,state:state.keeper.worker.state,enabled:state.keeper.worker.enabled,error:state.keeper.worker.error},rounds:state.rounds?.map(r=>({roundId:r.roundId,displayRoundId:r.displayRoundId,status:r.status}))};
if(!report.refundRoundInputRemoved||!report.siteClock||!report.privateKeyInput||!report.importReady||report.rounds.some(r=>r.status!==0&&!/^\d{12,}$/.test(r.displayRoundId)))throw Error('Live update check failed');
console.log(JSON.stringify(report,null,2));
