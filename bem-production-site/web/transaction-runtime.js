const error=code=>Object.assign(Error(code),{code});
const empty=()=>({version:6,pending:[],history:[]});

// randomUUID is newer than getRandomValues in several wallet WebViews. Both
// paths use the browser CSPRNG; transaction identifiers never use Math.random.
export function transactionId(random=globalThis.crypto){
  if(typeof random?.randomUUID==='function')return random.randomUUID();
  if(typeof random?.getRandomValues!=='function')throw error('SECURE_RANDOM_UNAVAILABLE');
  const bytes=random.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// Reading the localStorage property itself can throw in a restricted WebView.
// Keep that failure out of construction/rendering, but never replace the journal
// with an in-memory store that could lose an already submitted transaction.
export function createTransactionJournal({key,storage,validate,onChange=()=>{}}){
  let readError=null,writeError=null;
  function source(){
    try{
      const result=storage===undefined?globalThis.localStorage:storage;
      if(!result||typeof result.getItem!=='function')throw error('PENDING_STORAGE_UNAVAILABLE');
      return result;
    }catch{throw error('PENDING_STORAGE_UNAVAILABLE');}
  }
  function load(){
    let raw;
    try{raw=source().getItem(key);}catch{readError='PENDING_STORAGE_UNAVAILABLE';throw error(readError);}
    try{
      const state=raw===null?empty():validate(JSON.parse(raw));
      readError=null;return state;
    }catch{readError='PENDING_STORAGE_INVALID';throw error(readError);}
  }
  function write(target,name,value){
    try{
      if(typeof target.setItem!=='function')throw error('PENDING_STORAGE_WRITE_FAILED');
      target.setItem(name,value);
      if(target.getItem(name)!==value)throw error('PENDING_STORAGE_WRITE_FAILED');
      writeError=null;
    }catch{writeError='PENDING_STORAGE_WRITE_FAILED';throw error(writeError);}
  }
  function requireWritable(){
    load();
    // A separate constant probe cannot overwrite another tab's pending record.
    // Actual intent persistence is checked again under the transaction lock.
    const target=source(),probe=key+':storage-check';write(target,probe,'1');
    try{target.removeItem?.(probe);}catch{}
  }
  function save(state){
    validate(state);
    write(source(),key,JSON.stringify(state));onChange();
  }
  return{load,save,requireWritable,
    read(){try{return load();}catch{return empty();}},
    get error(){try{load();}catch{}return readError||writeError;}
  };
}
