const sameWallet=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

export function prizeResult(round,account,now){
  if(!account)return null;
  const prize=round.prize,winner=prize?.winner||round.winner;
  if(!sameWallet(account,winner)){
    const participated=sameWallet(account,round.account)&&Number(round.tickets)>0
      ||sameWallet(account,round.viewerAccount)&&Number(round.viewerTickets)>0;
    return round.status===5&&participated?'lost':null;
  }
  if(!prize||BigInt(prize.amount||0)<=0n)return null;
  if(prize.claimed)return 'claimed';
  if(prize.burned)return 'burned';
  if(!Number.isFinite(Number(prize.claimDeadline))||Number(prize.claimDeadline)<=0)return null;
  return now>=Number(prize.claimDeadline)?'expired':'claimable';
}
