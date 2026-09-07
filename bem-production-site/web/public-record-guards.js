const address=value=>typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value);
const hash=value=>typeof value==='string'&&/^0x[0-9a-f]{64}$/i.test(value);
export function validateRecords(data,kind){
  if(data?.schemaVersion!==2||data.chainId!==56||!Array.isArray(data.rows)||data.rows.length>50||!Number.isSafeInteger(data.page)||data.page<1||!Number.isSafeInteger(data.totalPages)||data.totalPages<0)throw Error('Invalid records');
  const rows=data.rows.filter(row=>address(row.gameAddress)&&hash(row.transactionHash)&&/^[1-9][0-9]*$/.test(row.roundId)&&/^[1-9][0-9]*$/.test(row.amountBaseUnits)&&Number.isFinite(Date.parse(row.timeUtc))&&['legacy100','1','10','50','100'].includes(row.poolId)&&(kind==='burn'?['settlement','unclaimed'].includes(row.kind)&&row.destination?.toLowerCase()==='0x000000000000000000000000000000000000dead':address(row.winner)));
  return {...data,rows};
}
export const transactionUrl=hashValue=>hash(hashValue)?`https://bscscan.com/tx/${hashValue}`:null;
