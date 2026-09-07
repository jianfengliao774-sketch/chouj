// Older embedded browsers can render a dialog element but have no showModal.
// Preserve an actual modal interaction instead of failing on the connect click.
export function compatibleDialog(dialog){
  if(typeof dialog.showModal==='function'&&typeof dialog.close==='function')return dialog;
  if(dialog.dataset.compatDialog)return dialog;
  dialog.dataset.compatDialog='true';let backdrop,lastFocus;
  const focusable=()=>[...dialog.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')];
  const onKey=event=>{
    if(event.key==='Escape'){event.preventDefault();dialog.close();}
    if(event.key==='Tab'){
      const rows=focusable(),index=rows.indexOf(document.activeElement);
      if(!rows.length){event.preventDefault();return;}
      if(event.shiftKey&&index<=0){event.preventDefault();rows[rows.length-1].focus();}
      else if(!event.shiftKey&&(index<0||index===rows.length-1)){event.preventDefault();rows[0].focus();}
    }
  };
  dialog.showModal=()=>{
    if(dialog.open)return;lastFocus=document.activeElement;
    backdrop=document.createElement('div');backdrop.className='dialog-compat-backdrop';backdrop.addEventListener('click',()=>dialog.close());
    document.body.append(backdrop);dialog.classList.add('dialog-compat-open');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('open','');dialog.open=true;
    document.addEventListener('keydown',onKey);(dialog.querySelector('[autofocus]')||focusable()[0])?.focus();
  };
  dialog.close=()=>{
    if(!dialog.open)return;dialog.open=false;dialog.removeAttribute('open');dialog.removeAttribute('aria-modal');dialog.classList.remove('dialog-compat-open');backdrop?.remove();document.removeEventListener('keydown',onKey);lastFocus?.focus();dialog.dispatchEvent(new Event('close'));
  };
  return dialog;
}
