import {verifiedDraftOwner} from './draft-owner.mjs';
// Legacy shared data remains intact. Each verified account has a separate DB.
const DATABASE='fpc-futsal-reports-v1';
function open(database){return new Promise((resolve,reject)=>{const r=indexedDB.open(database,1);r.onupgradeneeded=()=>{r.result.createObjectStore('reports',{keyPath:'id'});r.result.createObjectStore('summaries',{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('리포트 저장소를 열 수 없습니다. JSON 파일로 저장하세요.'));});}
async function transaction(database,tables,mode,action){
 const db=await open(database);return new Promise((resolve,reject)=>{
  let tx,request;
  const fail=()=>{db.close();reject(Error('리포트를 저장하거나 읽지 못했습니다. JSON 파일을 이용하세요.'));};
  try{
   tx=db.transaction(tables,mode);
   tx.oncomplete=()=>{db.close();resolve(request.result);};tx.onabort=tx.onerror=fail;
   request=action(tx);
  }catch{try{tx?.abort();}catch{}fail();}
 });
}
const database=user=>DATABASE+'.user.'+encodeURIComponent(user.id);
export async function saveReport(record,expectedOwner){
 const user=await verifiedDraftOwner(expectedOwner);
 return transaction(database(user),['reports','summaries'],'readwrite',tx=>{
  tx.objectStore('summaries').put({id:record.id,title:record.title,updatedAt:record.updatedAt});
  return tx.objectStore('reports').put({...record,ownerId:user.id});
 });
}
export async function loadReport(id,expectedOwner){const user=await verifiedDraftOwner(expectedOwner);return transaction(database(user),['reports'],'readonly',tx=>tx.objectStore('reports').get(id));}
export async function listReports(expectedOwner){const user=await verifiedDraftOwner(expectedOwner);const rows=await transaction(database(user),['summaries'],'readonly',tx=>tx.objectStore('summaries').getAll());return rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
export async function listLegacyReports(){
 const user=await verifiedDraftOwner();if(user.role!=='SUPERADMIN')throw Error('소유자가 없는 이전 초안의 복구는 관리자가 확인해야 합니다.');
 return transaction(DATABASE,['summaries'],'readonly',tx=>tx.objectStore('summaries').getAll());
}
export async function copyLegacyReport(id){
 const user=await verifiedDraftOwner();if(user.role!=='SUPERADMIN')throw Error('이전 공용 초안 복구는 관리자만 가능합니다.');
 const old=await transaction(DATABASE,['reports'],'readonly',tx=>tx.objectStore('reports').get(id));if(!old)throw Error('이전 초안을 찾지 못했습니다.');
 const copy={...old,id:crypto.randomUUID(),updatedAt:new Date().toISOString(),migratedFrom:{id,by:user.id,at:new Date().toISOString()}};
 await saveReport(copy,user.id);return copy.id;
}
