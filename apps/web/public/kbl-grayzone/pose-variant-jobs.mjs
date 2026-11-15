// A pose fit can take longer than an HTTP gateway timeout. Submit once, then
// poll a case- and scene-scoped durable job instead of holding a request open.
export async function createPoseVariant(api,path,captureId,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onProgress=()=>{}}={}){
 let {job}=await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureId})});
 if(!job||!/^[a-f0-9]{24}$/.test(job.jobId||'')||job.captureId!==captureId)throw Error('자세 보정 작업 정보를 확인하세요.');
 let failures=0;
 while(job.state==='queued'||job.state==='running'){
  onProgress(job.stage||'자세를 보정하고 있습니다.');
  await sleep(3000);
  try{
   const response=await api(`${path}/${job.jobId}`);
   if(!response.job||response.job.jobId!==job.jobId||response.job.captureId!==captureId)throw Error('자세 보정 작업 정보가 변경됐습니다.');
   job=response.job;failures=0;
  }catch(error){
   if(++failures>=5)throw Error('자세 보정 상태에 연결할 수 없습니다. 다시 시도하면 기존 작업부터 확인합니다.');
  }
 }
 if(job.state!=='complete')throw Error(job.error||'자세 보정을 마치지 못했습니다. 다시 시도하면 기존 결과부터 확인합니다.');
 if(!job.result?.variantId||!job.result?.pose?.meshUrl)throw Error('완료된 자세 보정 결과를 확인하세요.');
 return job.result;
}
