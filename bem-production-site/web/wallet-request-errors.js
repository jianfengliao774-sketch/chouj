// Providers may wrap EIP-1193 errors. Only an explicit rejection code proves
// this request was rejected; timeouts and transport failures remain pending.
export function walletRequestRejected(error) {
  const queue=[error],seen=new Set();
  for(let n=0;queue.length&&n<12;n++){
    const value=queue.shift();if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);
    if(value.code===4001||value.code==='4001'||value.code==='ACTION_REJECTED')return true;
    for(const key of ['error','cause','data','originalError','info'])if(value[key]&&typeof value[key]==='object')queue.push(value[key]);
  }
  return false;
}
