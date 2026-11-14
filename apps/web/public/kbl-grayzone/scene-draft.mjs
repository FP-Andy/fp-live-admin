// A session-local recovery copy. It never changes the saved scene by itself.
export function createSceneDraft(storage, identity) {
 const key='courtside:scene-draft:v1:'+JSON.stringify(identity);
 return {
  read(){try{const data=JSON.parse(storage.getItem(key)||'null');return data?.schema===1&&data.state&&Array.isArray(data.state.entities)?data:null;}catch{return null;}},
  write(state){try{storage.setItem(key,JSON.stringify({schema:1,updatedAt:new Date().toISOString(),state}));return true;}catch{return false;}},
  clear(){try{storage.removeItem(key);}catch{}},
 };
}
