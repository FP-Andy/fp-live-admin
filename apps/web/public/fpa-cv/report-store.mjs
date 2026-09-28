// Same-origin browser drafts. Small metadata stays separate from coordinate data.
const DATABASE='fpc-futsal-reports-v1';
function open(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DATABASE,1);r.onupgradeneeded=()=>{r.result.createObjectStore('reports',{keyPath:'id'});r.result.createObjectStore('summaries',{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('리포트 저장소를 열 수 없습니다. JSON 파일로 저장하세요.'));});}
async function transaction(tables,mode,action){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(tables,mode),request=action(tx);tx.oncomplete=()=>{db.close();resolve(request.result);};tx.onabort=tx.onerror=()=>{db.close();reject(Error('리포트를 저장하거나 읽지 못했습니다. JSON 파일을 이용하세요.'));};});}
export const saveReport=record=>transaction(['reports','summaries'],'readwrite',tx=>{tx.objectStore('summaries').put({id:record.id,title:record.title,updatedAt:record.updatedAt});return tx.objectStore('reports').put(record);});
export const loadReport=id=>transaction(['reports'],'readonly',tx=>tx.objectStore('reports').get(id));
export const listReports=async()=>{const rows=await transaction(['summaries'],'readonly',tx=>tx.objectStore('summaries').getAll());return rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));};
