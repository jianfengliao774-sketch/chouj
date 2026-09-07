export function formatSiteTime(value,language='zh'){
  const timestamp=typeof value==='number'?value*1000:Date.parse(value);
  if(!Number.isFinite(timestamp))return '—';
  const chinese=language!=='en',date=new Date(timestamp+(chinese?8:0)*3600000);
  return date.toISOString().slice(0,19).replace('T',' ')+(chinese?' 北京时间 (UTC+8)':' UTC+0');
}
