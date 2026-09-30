const endpoint='/api/futsal/analysis-snapshots';
async function request(path,options){
  const response=await fetch(endpoint+path,options);
  if(!response.ok){let detail;try{detail=(await response.json()).detail;}catch{}throw Error(typeof detail==='string'?detail:'분석 스냅샷을 저장하거나 불러오지 못했습니다.');}
  return response.json();
}
export const listAnalysisSnapshots=async jobId=>(await request(jobId?`?job_id=${encodeURIComponent(jobId)}`:'')).snapshots;
export const loadAnalysisSnapshot=id=>request('/'+encodeURIComponent(id));
export const saveAnalysisSnapshot=async value=>{
  const saved=await request('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  // Other report tabs refresh their source without replacing edited prose.
  try{localStorage.setItem('fpc-analysis-snapshot-updated',JSON.stringify({id:saved.id,at:Date.now()}));}catch{}
  if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel('fpc-analysis-snapshots');channel.postMessage({id:saved.id});channel.close();}
  return saved;
};
