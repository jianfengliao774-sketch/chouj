// Presentation only: chain phase and timing stay independent of wallet connection.
export function publicDrawState(snapshot, nowSeconds) {
  if (!snapshot?.runtimeVerified || !snapshot.currentRound) return null;
  const current = snapshot.currentRound, previous = snapshot.previousRound;
  const previousActive = previous && [2, 3, 4].includes(Number(previous.status));
  const usePrevious = previousActive || Number(current.status) === 0 && previous;
  const round = usePrevious ? previous : current;
  const timing = (usePrevious ? snapshot.previousDrawTiming : snapshot.currentDrawTiming) ?? {};
  const roundId = (BigInt(snapshot.currentRoundId) - (usePrevious ? 1n : 0n)).toString();
  const status = Number(round.status);
  const deadline = status === 1 ? Number(round.fundingDeadline)
    : status === 2 || status === 3 ? Number(timing.targetDrawBy)
    : status === 4 ? Number(timing.scheduledDrawAt) : 0;
  const winner = status === 5 && /^0x[0-9a-f]{40}$/i.test(round.winner ?? '') && !/^0x0{40}$/i.test(round.winner)
    && Number.isInteger(Number(round.winningTicket)) && Number(round.winningTicket) >= 0 && Number(round.winningTicket) < 10000
    ? { roundId, winner: round.winner, winningTicket: Number(round.winningTicket) } : null;
  return { roundId, status, sold: Number(round.sold), deadline, remaining: Math.max(0, Math.ceil(deadline - nowSeconds)),
    overdue: deadline > 0 && nowSeconds >= deadline, winner, timing };
}

export function duration(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(n => String(n).padStart(2, '0')).join(':');
}
