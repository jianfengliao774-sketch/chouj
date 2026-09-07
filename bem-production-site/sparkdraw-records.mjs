import { getAddress } from 'ethers';
import { SPARKDRAW } from './web/sparkdraw-config.js';
const add = (a, b) => (BigInt(a ?? '0') + BigInt(b ?? '0')).toString();

// Derive public and personal records only from receipt-confirmed, persisted logs.
export function sparkDrawRecords(events, { pool, address }) {
  const rounds = new Map(), burns = [];
  const row = id => {
    if (!rounds.has(id)) rounds.set(id, { roundId:id,poolId:pool,gameAddress:address,status:0,sold:0,
      wallets:{},fundingDeadline:0,drawDeadline:0,prize:null });
    return rounds.get(id);
  };
  for (const event of events) {
    const a = event.args, id = a.roundId;
    if (!id) continue;
    const r = row(id);
    const timeUtc = event.timeUtc;
    const timestamp = Math.floor(Date.parse(timeUtc) / 1000);
    switch (event.name) {
      case 'RoundStarted': r.status=1;r.fundingDeadline=Number(a.fundingDeadline);break;
      case 'TicketsAllocated': {
        const buyer=getAddress(a.buyer), w=r.wallets[buyer]??={tickets:0,paid:'0',refunded:'0',purchases:[]};
        const tickets=Number(a.count);r.sold+=tickets;w.tickets+=tickets;w.paid=add(w.paid,a.paid);
        w.purchases.push({tickets,paidBaseUnits:a.paid,bitmap:a.bitmap,transactionHash:event.transactionHash,timeUtc});break;
      }
      case 'EarlyDrawScheduled':r.earlyDrawDeadline=Number(a.closesAt);break;
      case 'RoundLocked':r.status=3;r.drawDeadline=Number(a.drawDeadline);r.sealedAt=timestamp;break;
      case 'DrawRequested':r.status=3;break;
      case 'BeaconFixed':r.beaconRound=a.beaconRound;r.beaconAvailableAt=Number(a.availableAt);break;
      case 'BeaconVerified':r.beaconRandomness=a.randomness;r.signature=a.signature;r.proofTransactionHash=event.transactionHash;break;
      case 'RandomnessReceived':r.status=4;break;
      case 'Settled':r.status=5;r.winner=getAddress(a.winner);r.winningTicket=Number(a.winningTicket);r.settlementTransactionHash=event.transactionHash;break;
      case 'PrizeAvailable':r.prize={amount:a.amount,winner:getAddress(a.winner),claimDeadline:Number(a.claimDeadline),claimed:false,burned:false};break;
      case 'PrizeClaimed':if(r.prize)r.prize.claimed=true;break;
      case 'RefundsOpened':r.status=6;break;
      case 'Refunded':{const w=r.wallets[getAddress(a.buyer)];if(w)w.refunded=add(w.refunded,a.amount);break;}
    }
    if (['BlackholeTransfer','UnclaimedPrincipalBurned','UnclaimedPrizeBurned'].includes(event.name)) {
      const kind=event.name==='BlackholeTransfer'?'settlement':event.name==='UnclaimedPrizeBurned'?'unclaimed_prize':'unclaimed_principal';
      if(kind==='unclaimed_prize'&&r.prize)r.prize.burned=true;
      if(kind==='unclaimed_principal')r.principalBurned=true;
      burns.push({poolId:pool,roundId:id,gameAddress:address,amountBaseUnits:a.amount,kind,
        destination:'0x000000000000000000000000000000000000dEaD',transactionHash:event.transactionHash,logIndex:event.logIndex,timeUtc});
    }
  }
  const all=[...rounds.values()].reverse();
  return {
    // Wallet details are published only by refundNotices, after the 12-hour gate.
    publicRounds:all.map(({wallets,...r})=>r), burns:burns.reverse(),
    pendingPrizes:all.filter(r=>r.prize&&!r.prize.claimed&&!r.prize.burned).map(r=>({poolId:pool,roundId:r.roundId,
      gameAddress:address,winner:r.prize.winner,amountBaseUnits:r.prize.amount,claimDeadline:r.prize.claimDeadline})),
    refundNotices(now) {
      const notices=[];
      for(const r of all) {
        const trigger=r.drawDeadline||r.fundingDeadline;
        const publicAt=trigger+SPARKDRAW.refundPublicNoticeDelay, deadline=trigger+SPARKDRAW.claimSeconds;
        if(!trigger||r.status===5||r.principalBurned||now<publicAt)continue;
        for(const [account,w] of Object.entries(r.wallets)) {
          const unclaimed=BigInt(w.paid)-BigInt(w.refunded);
          if(unclaimed<=0n)continue;
          const ticketPrice=BigInt(SPARKDRAW.pools[pool].units)/10000n;
          notices.push({poolId:pool,roundId:r.roundId,gameAddress:address,account,
            tickets:Number(unclaimed/ticketPrice),amountBaseUnits:unclaimed.toString(),
            refundTriggerAt:trigger,publicAt,claimDeadline:deadline,
            state:now<deadline?'claimable':'awaiting_burn'});
        }
      }
      return notices;
    },
    wallet(wallet, now) {
      const account=getAddress(wallet);
      return all.filter(r=>r.wallets[account]||r.prize?.winner===account).map(r=>{
        const w=r.wallets[account]??{tickets:0,paid:'0',refunded:'0',purchases:[]};
        const trigger=r.drawDeadline||r.fundingDeadline, deadline=trigger+86400;
        const eligible=r.status!==5&&trigger>0&&now>=trigger&&now<deadline&&!r.principalBurned;
        return {...r,wallets:undefined,account,...w,refundTriggerAt:trigger,refundClaimDeadline:deadline,
          burnedPrincipal:r.principalBurned?(BigInt(w.paid)-BigInt(w.refunded)).toString():'0',
          burnedPrize:r.prize?.winner===account&&r.prize.burned?r.prize.amount:'0',
          burns:burns.filter(b=>b.roundId===r.roundId&&(b.kind==='unclaimed_principal'&&BigInt(w.paid)>BigInt(w.refunded)||b.kind==='unclaimed_prize'&&r.prize?.winner===account)),
          refundPublicNoticeAt:trigger?trigger+SPARKDRAW.refundPublicNoticeDelay:0,
          refundablePrincipal:eligible?(BigInt(w.paid)-BigInt(w.refunded)).toString():'0',
          unclaimedPrincipal:(BigInt(w.paid)-BigInt(w.refunded)).toString(),
          claimablePrize:r.prize?.winner===account&&!r.prize.claimed&&!r.prize.burned&&now<r.prize.claimDeadline?r.prize.amount:'0'};
      });
    }
  };
}
