import type {SavedWork} from './manual-draft';
const pending=new Map<string,SavedWork>();
const journal=(key:string)=>'fpc.manual-recovery.v1.'+key;
export function rememberManualWork(key:string,work:SavedWork,saved:boolean){
 if(saved){pending.delete(key);try{sessionStorage.removeItem(journal(key));}catch{}return;}
 pending.set(key,work);try{sessionStorage.setItem(journal(key),JSON.stringify(work));}catch{}
}
export function recoverManualWork(key:string):SavedWork|null{
 if(pending.has(key))return pending.get(key)!;
 try{return JSON.parse(sessionStorage.getItem(journal(key))||'null');}catch{return null;}
}
export function manualOwnerKey(ownerId:string,legacyKey:string){return legacyKey&&ownerId?`fhl.manual.tags.user.${encodeURIComponent(ownerId)}:${legacyKey}`:'';}
