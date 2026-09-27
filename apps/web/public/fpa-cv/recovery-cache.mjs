// Cache is optional: private browsing, a full disk, or deletion must never
// prevent opening a video. Store compact completed results, not the video/BBs.
export async function recoveryCache() {
  let db;
  try {
    db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('fpa-cv-recovery',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('results',{keyPath:'key'});
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      r.onblocked=()=>reject(Error('Cache unavailable'));
    });
  } catch { return {get:async()=>null,put:async()=>false}; }
  db.onversionchange=()=>db.close();
  function transaction(mode, action) {
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('results',mode),store=tx.objectStore('results');
      let value;
      tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(tx.error);
      action(store, result=>{value=result;});
    });
  }
  return {
    async get(key) {
      try {return await transaction('readwrite',(s,done)=>{
        const r=s.get(key);r.onsuccess=()=>{
          if(r.result){s.put({...r.result,usedAt:Date.now()});done(r.result.value);}
        };
      })||null;} catch {return null;}
    },
    async put(key,value) {
      try {
        await transaction('readwrite',s=>{
          s.put({key,value,usedAt:Date.now()});
          const r=s.getAll();r.onsuccess=()=>{
            const entries=r.result.sort((a,b)=>b.usedAt-a.usedAt);
            for(const old of entries.slice(5))s.delete(old.key);
          };
        });return true;
      } catch {return false;}
    },
  };
}
