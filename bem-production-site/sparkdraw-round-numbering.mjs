import {numberedRound} from './web/round-display.js';
export function globalRoundLabels(pools,through=Infinity){
  const starts=pools.flatMap(({poolId,events})=>events.filter(e=>e.name==='RoundStarted'&&e.blockNumber<=through).map(e=>({...e,poolId})))
    .sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex);
  const labels=new Map();let sequence=0;
  for(const e of starts){const key=e.poolId+':'+e.args.roundId;if(labels.has(key))continue;
    sequence++;labels.set(key,{globalSequence:String(sequence),displayRoundId:numberedRound(Date.parse(e.timeUtc)/1000,sequence)});
  }
  return labels;
}
