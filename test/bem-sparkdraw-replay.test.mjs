import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../bem-production-site/web/sparkdraw-player.js',import.meta.url),'utf8');
test('reel claim button is visible only to the winner with an unclaimed unexpired prize',()=>{
  const c=vm.createContext({});vm.runInContext(source.slice(source.indexOf('function reelPrizeVisible('),source.indexOf('function renderDraw()')),c);
  const winner='0x'+'a'.repeat(40),r={status:5,winner,prize:{amount:'9500000',claimed:false,burned:false,claimDeadline:200}};
  assert.equal(c.reelPrizeVisible(r,null,100),false);assert.equal(c.reelPrizeVisible(r,'0x'+'b'.repeat(40),100),false);assert.equal(c.reelPrizeVisible(r,winner,100),true);
  for(const patch of [{claimed:true},{burned:true},{amount:'0'},{claimDeadline:100}])assert.equal(c.reelPrizeVisible({...r,prize:{...r.prize,...patch}},winner,100),false);
});
test('draw countdown says drawing at zero while claim deadlines still say expired',()=>{
  const c=vm.createContext({chainNow:()=>100,t:zh=>zh});vm.runInContext(source.slice(source.indexOf('function countdown('),source.indexOf('function renderDraw()')),c);
  const draw={dataset:{expiredText:'正在开奖'}};c.countdown(draw,101);assert.equal(draw.textContent,'00:00:01');c.countdown(draw,100);assert.equal(draw.textContent,'正在开奖');
  const claim={dataset:{}};c.countdown(claim,100);assert.equal(claim.textContent,'已到期');
});
test('public player cannot open a wallet to trigger a draw, while claims still connect',async()=>{
  let connections=0;const context=vm.createContext({account:null,picker:{open(){connections++;}},manager:{execute(){throw Error('unexpected send');}},render(){}});
  vm.runInContext(source.match(/async function action\(id,method,args\)\{[^\n]+/)[0],context);
  for(const method of ['closeRound','fulfillRandomness','settle'])await assert.rejects(()=>context.action('0.1',method,[1]),/BACKEND_DRAW_ONLY/);
  assert.equal(connections,0);await context.action('0.1','claimPrizes',[[1],null]);assert.equal(connections,1);
});
function fixture(reduced=false){
  const animations=[];
  const reels=Array.from({length:5},()=>{
    const placeholder={hidden:false,textContent:''},classes=new Set();
    const strip={children:[],replaceChildren(...children){this.children=children;},setAttribute(){},animate(frames,options){
      let finish,reject;const a={frames,options,finished:new Promise((yes,no)=>{finish=yes;reject=no;}),finish:()=>finish(),cancel(){reject();}};animations.push(a);return a;
    }};
    return{placeholder,strip,classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},querySelector:s=>s==='.placeholder'?placeholder:strip};
  });
  const nodes={reels:{getClientRects:()=>[{}],setAttribute(){}},replay:{textContent:'回放卷轴'}};
  const context=vm.createContext({pool:'0.1',document:{hidden:false,querySelectorAll:()=>reels},window:{matchMedia:()=>({matches:reduced})},$:id=>nodes[id],el:(tag,text)=>({textContent:text}),t:zh=>zh});
  vm.runInContext(source.slice(source.indexOf('let reelKey='),source.indexOf('function renderSelector()')),context);
  return{animations,reels,nodes,reveal:(win,replay=false)=>context.revealReels(win,replay)};
}
test('manual replay overrides reduced motion, rolls all five digits and restores the confirmed number',async()=>{
  const f=fixture(true),result={roundId:'1',winningTicket:8380};f.reveal(result);assert.equal(f.animations.length,0);
  f.reveal(result,true);assert.equal(f.animations.length,5);assert.equal(f.nodes.replay.textContent,'卷轴滚动中…');assert.ok(f.reels.every(r=>r.placeholder.hidden));
  assert.equal(f.animations[0].frames[1].transform,'translateY(-3000%)');
  f.reveal(result);assert.equal(f.animations.length,5,'polling must not restart the animation');
  for(const a of f.animations)a.finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.reels.map(r=>r.placeholder.textContent).join(''),'08381');assert.ok(f.reels.every(r=>!r.placeholder.hidden));assert.equal(f.nodes.replay.textContent,'回放卷轴');
  f.reveal(result,true);assert.equal(f.animations.length,10,'repeated click must replay');
});
test('a stale animation cannot overwrite the next round',async()=>{
  const f=fixture();f.reveal({roundId:'1',winningTicket:8380});const old=[...f.animations];
  f.reveal({roundId:'2',winningTicket:9999});for(const a of old)a.finish();await new Promise(resolve=>setImmediate(resolve));
  for(const a of f.animations.slice(5))a.finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.reels.map(r=>r.placeholder.textContent).join(''),'10000');
});

test('confirmed digits reveal at 3, 6, 9, 12 and 15 seconds without gating claims',async()=>{
  const f=fixture(),win={roundId:'8',winningTicket:8380};f.reveal(win);
  assert.deepEqual(f.animations.map(a=>a.options.duration),[3000,6000,9000,12000,15000]);
  assert.ok(f.reels.every(r=>r.placeholder.hidden));
  for(let i=0;i<5;i++){
    f.animations[i].finish();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.reels.filter(r=>!r.placeholder.hidden).length,i+1);
    assert.equal(f.reels[i].placeholder.textContent,'08381'[i]);
    f.reveal(win);assert.equal(f.animations.length,5,'polling does not restart a reveal');
  }
  assert.equal(f.nodes.replay.textContent,'回放卷轴');
});
