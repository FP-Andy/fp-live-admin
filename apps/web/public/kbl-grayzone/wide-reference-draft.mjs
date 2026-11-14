// Only a user-selected draft; no observation is saved automatically.
export function createWideReferenceDraft(storage, identity){
 const key='courtside:wide-draft:v1:'+JSON.stringify(identity);
 return {
  read(){try{const d=JSON.parse(storage.getItem(key)||'null');return d?.schema===1&&d.value&&typeof d.value==='object'?d.value:null;}catch{return null;}},
  write(value){try{storage.setItem(key,JSON.stringify({schema:1,value}));return true;}catch{return false;}},
  clear(){try{storage.removeItem(key);}catch{}},
 };
}
