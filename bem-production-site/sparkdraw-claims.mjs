import {SPARKDRAW} from './web/sparkdraw-config.js';
export function walletClaimGroups(rows,poolIds){
  return poolIds.map(poolId=>{
    const eligible=rows.filter(r=>r.poolId===poolId&&BigInt(r.refundablePrincipal)>0n).sort((a,b)=>a.refundClaimDeadline-b.refundClaimDeadline||Number(a.roundId)-Number(b.roundId));
    const batch=eligible.slice(0,SPARKDRAW.refundBatchLimit);
    return{poolId,refunds:batch.map(r=>r.roundId).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),refundCount:eligible.length,
      refundablePrincipal:eligible.reduce((sum,r)=>sum+BigInt(r.refundablePrincipal),0n).toString(),
      refundBatchAmount:batch.reduce((sum,r)=>sum+BigInt(r.refundablePrincipal),0n).toString(),
      refundDeadline:eligible[0]?.refundClaimDeadline||0,
      prizes:rows.filter(r=>r.poolId===poolId&&BigInt(r.claimablePrize)>0n).map(r=>r.roundId).sort((a,b)=>Number(a)-Number(b)).slice(0,64)};
  });
}
