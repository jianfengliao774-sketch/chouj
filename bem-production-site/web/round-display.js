import {SPARKDRAW} from './sparkdraw-config.js';
export const utcDay=seconds=>new Date(seconds*1000).toISOString().slice(0,10).replaceAll('-','');
export const numberedRound=(seconds,sequence)=>utcDay(seconds)+String(sequence).padStart(4,'0');
export function roundDisplay(round,{now=Math.floor(Date.now()/1000)}={}){
  if(!round)return '—';
  if(round.displayRoundId)return round.displayRoundId;
  const opened=Number(round.fundingDeadline)>0?Number(round.fundingDeadline)-SPARKDRAW.fundingSeconds:now;
  return round.dailySequence?numberedRound(opened,round.dailySequence):'—';
}
