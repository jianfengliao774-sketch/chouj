import {purchasedTicketNumbers} from './purchased-ticket-numbers.js';
import {t} from './player-i18n.js';

export function ticketViewStates(container) {
  return new Map([...container.querySelectorAll('details[data-purchase-key]')].map(details=>[
    details.dataset.purchaseKey,{open:details.open,scrollTop:details.querySelector('textarea')?.scrollTop||0}
  ]));
}

export function purchasedTicketDetails(purchase,key,state={}) {
  const details=document.createElement('details');
  details.className='purchased-ticket-details';details.dataset.purchaseKey=key;
  const summary=document.createElement('summary');
  summary.textContent=t('查看号码（{n} 个）','View numbers ({n})',{n:purchase.tickets});
  details.append(summary);
  let built=false;
  function showNumbers() {
    if(built||!details.open)return;
    built=true;
    const numbers=purchasedTicketNumbers(purchase),body=document.createElement('div');
    body.className='purchased-ticket-body';details.append(body);
    if(numbers===null){
      const message=document.createElement('p');
      message.textContent=t('号码记录暂不可用，请稍后刷新或查看上方交易。','Numbers are temporarily unavailable. Refresh later or view the transaction above.');
      body.append(message);return;
    }
    if(!numbers.length){body.textContent=t('本次未分配号码。','No numbers were allocated.');return;}
    const field=document.createElement('textarea');
    field.className='purchased-ticket-list';field.readOnly=true;field.rows=6;
    field.setAttribute('aria-label',t('本次已购买的号码','Numbers purchased in this transaction'));
    field.value=numbers.map(n=>String(n).padStart(5,'0')).join(' ');
    const copy=document.createElement('button'),feedback=document.createElement('p');
    copy.type='button';copy.textContent=t('复制全部号码','Copy all numbers');
    feedback.className='purchased-ticket-feedback';feedback.setAttribute('role','status');
    copy.onclick=async()=>{
      try{await navigator.clipboard.writeText(field.value);feedback.textContent=t('已复制全部 {n} 个号码。','Copied all {n} numbers.',{n:numbers.length});}
      catch{field.focus();field.select();feedback.textContent=t('号码已选中，请长按或使用复制快捷键。','Numbers selected. Long-press or use your copy shortcut.');}
    };
    body.append(field,copy,feedback);
    if(state.scrollTop)requestAnimationFrame(()=>{field.scrollTop=state.scrollTop;});
  }
  details.addEventListener('toggle',showNumbers);
  if(state.open){details.open=true;showNumbers();}
  return details;
}
