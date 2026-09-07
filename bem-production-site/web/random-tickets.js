// Purchase selection only. Draw randomness is still verified by the contract.
export function randomBelow(limit){
  if(!Number.isInteger(limit)||limit<1||limit>10000)throw Error('TICKET_RANGE');
  const ceiling=2**32-(2**32%limit),buffer=new Uint32Array(1);
  do{globalThis.crypto.getRandomValues(buffer);}while(buffer[0]>=ceiling);
  return buffer[0]%limit;
}
export function randomUnsoldTickets(words,count,next=randomBelow){
  if(!Array.isArray(words)||words.length!==556)throw Error('TICKET_WORDS_UNAVAILABLE');
  if(!Number.isInteger(count)||count<1||count>5000)throw Error('TICKET_LIMIT');
  const free=[];
  for(let w=0;w<556;w++){
    const packed=BigInt(words[w]);if(packed<0n||packed>=1n<<256n)throw Error('TICKET_WORDS_UNAVAILABLE');
    for(let slot=0;slot<18&&w*18+slot<10000;slot++)if(((packed>>BigInt(slot*14))&16383n)===0n)free.push(w*18+slot);
  }
  const filled=Math.min(count,free.length);
  for(let i=0;i<filled;i++){
    const offset=next(free.length-i);if(!Number.isInteger(offset)||offset<0||offset>=free.length-i)throw Error('RANDOM_SELECTION_FAILED');
    const j=i+offset;[free[i],free[j]]=[free[j],free[i]];
  }
  // The existing buySelected ABI requires ascending, zero-based, unique numbers.
  return free.slice(0,filled).sort((a,b)=>a-b);
}
