// Website purchase availability. Historical contracts remain readable/claimable.
export const SALES_POOL_IDS=Object.freeze(['5','10','50']);
export const DEFAULT_POOL_ID='5';
export const poolSalesEnabled=id=>SALES_POOL_IDS.includes(id);
export function requirePoolSales(id,method){
  if(['approve','buy','buySelected'].includes(method)&&!poolSalesEnabled(id)){
    throw Object.assign(new Error('POOL_SALES_CLOSED'),{code:'POOL_SALES_CLOSED'});
  }
}
