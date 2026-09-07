import {formatUnits} from 'ethers';
const $=id=>document.getElementById(id),node=(tag,text)=>Object.assign(document.createElement(tag),{textContent:text});
const money=x=>formatUnits(BigInt(x||0),8);let busy=false;
async function api(url,body){const r=await fetch(url,{cache:'no-store',...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Object.assign(Error(d.error),{status:r.status});return d;}
const link=hash=>{const a=node('a',hash);a.href='https://bscscan.com/tx/'+hash;a.target='_blank';a.rel='noopener noreferrer';return a;};
async function refresh(){try{
  const d=await api('/api/admin/overview');$('login-panel').hidden=true;$('admin-content').hidden=false;$('admin-account').textContent=d.session.username;
  $('today-completed').textContent=d.pools.reduce((n,p)=>n+p.todayCompleted,0);$('activity-day').textContent=d.day+' · 北京时间';$('activity-generated').textContent='已确认链上记录';
  $('activity-pools').replaceChildren(...d.pools.map(p=>{const box=node('section','');box.className='panel';box.append(node('h2',`${p.poolId} BEM · 今日完成 ${p.todayCompleted} 期`),node('p',p.address),node('p',`索引 ${p.index.state} · ${p.index.indexedThrough} / ${p.index.targetBlock}`));
    for(const r of p.rounds){const detail=node('details',''),summary=node('summary',`第 ${r.roundId} 期 · ${r.sold} 份 · 状态 ${r.status}`);detail.append(summary);
      if(r.startedAt&&r.lockedAt)detail.append(node('p',`${r.sold===10000?'售满':'封盘'}用时：${Math.round((Date.parse(r.lockedAt)-Date.parse(r.startedAt))/1000)} 秒`));
      let loaded=false;detail.ontoggle=async()=>{if(!detail.open||loaded)return;try{const data=await api(`/api/admin/round?pool=${p.poolId}&round=${r.roundId}`),wallets=new Map();
        for(const e of data.events.filter(e=>e.name==='TicketsAllocated')){const w=wallets.get(e.args.buyer)||{count:0,paid:0n,tx:new Map()};w.count+=Number(e.args.count);w.paid+=BigInt(e.args.paid);w.tx.set(e.transactionHash,e);wallets.set(e.args.buyer,w);}
        for(const[a,w]of wallets){const section=node('div','');section.className='scope-note';section.append(node('h3',a),node('p',`购买 ${w.tx.size} 次 · ${w.count} 份 · ${money(w.paid)} BEM`));
          for(const e of w.tx.values()){const row=node('p',`${e.timeUtc} · ${e.args.count} 份 · ${money(e.args.paid)} BEM `);row.append(link(e.transactionHash));section.append(row);}detail.append(section);}loaded=true;
      }catch(e){$('admin-notice').textContent=e.message;}};box.append(detail);
    }return box;}));$('admin-notice').textContent='仅显示新部署的五档合约。';
  }catch(e){if(e.status===401){$('login-panel').hidden=false;$('admin-content').hidden=true;}else $('admin-notice').textContent=e.message;}}
$('login-form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;try{await api('/api/admin/login',{username:$('admin-username').value.trim(),password:$('admin-password').value});$('admin-password').value='';await refresh();}catch(e){$('admin-notice').textContent=e.message;}finally{busy=false;}};
$('logout').onclick=async()=>{await api('/api/admin/logout',{});$('login-panel').hidden=false;$('admin-content').hidden=true;};$('refresh').onclick=refresh;refresh();
