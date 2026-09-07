export const MARKET_BEM='0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a';
const amount=value=>typeof value==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value))&&Number(value)>0&&Number(value)<=1e12;
export function quoteView(quote, prizeBaseUnits, now=Date.now()) {
  const timestamp=Date.parse(quote?.updatedAt);
  const current=quote?.chainId===56&&typeof quote?.token==='string'&&quote.token.toLowerCase()===MARKET_BEM&&quote?.source==='DEX Screener'&&quote?.stale===false&&Number.isFinite(timestamp)&&now-timestamp<=180000&&timestamp<=now+30000;
  const prize=/^[0-9]+$/.test(String(prizeBaseUnits))?Number(BigInt(prizeBaseUnits))/1e8:NaN;
  const side=unit=>{
    const row=quote?.[unit];
    if(!current||!amount(row?.price)||!/^0x[0-9a-f]{40}$/i.test(row?.pairAddress))return null;
    const value=Number(row.price), total=prize*value;
    return {unitPrice:value,prize:Number.isFinite(total)&&total>=0?total:null,url:`https://dexscreener.com/bsc/${row.pairAddress.toLowerCase()}`};
  };
  return {current,updatedAt:Number.isFinite(timestamp)?timestamp:null,usdt:side('usdt'),bnb:side('bnb')};
}
