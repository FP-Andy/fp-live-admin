import {deriveSubstitutionReport} from './substitution-report.mjs';
import {planContinuationRecovery} from './substitution-recovery-plan.mjs';
const cache=new Map();
async function get(url){if(cache.has(url))return cache.get(url);const response=await fetch(url);if(!response.ok)throw Error('분석 원본을 불러오지 못했습니다. 다시 시도하세요.');const value=await response.json();cache.set(url,value);return value;}
self.onmessage=async({data:{ticket,snapshotId,jobId,saved,redetectionId,reviewedReportId}})=>{try{
 if(reviewedReportId){
  // Validate on every application: an immutable file may have stale source inputs.
  const response=await fetch('/api/futsal/analysis-snapshots/'+encodeURIComponent(snapshotId)+'/reviewed-report?review_id='+encodeURIComponent(reviewedReportId),{cache:'no-store'});
  if(!response.ok)throw Error('검수 결과가 변경되었습니다. 새로 불러오세요.');
  const result=await response.json(),p=result.provenance;
  if(p?.reviewedReportId!==reviewedReportId||p.snapshotId!==snapshotId||p.jobId!==jobId||p.logRevision!==saved.revision||(p.redetectionId||null)!==(redetectionId||null))throw Error('검수 원본 버전이 다릅니다. 새로 불러오세요.');
  self.postMessage({ticket,result});return;
 }
 const snapshot=await get('/api/futsal/analysis-snapshots/'+encodeURIComponent(snapshotId));
 const tracks=saved.log?.substitutions?.length?await get('/api/tracking/jobs/'+encodeURIComponent(jobId)+'/tracks.json'):{datasetId:snapshot.heatmap.datasetId};
 const recovery=redetectionId?(await get('/api/futsal/analysis-snapshots/'+encodeURIComponent(snapshotId)+'/redetection?recovery_id='+encodeURIComponent(redetectionId))).recovery:null;
 if(redetectionId&&!recovery)throw Error('교체 시각이 변경되어 재탐지 후보를 다시 확인해야 합니다.');
 const result=deriveSubstitutionReport(snapshot,tracks,saved,progress=>self.postMessage({ticket,progress}),recovery);if(result.continuation)result.recoveryPlan=planContinuationRecovery(snapshot,tracks,saved,result);self.postMessage({ticket,result});
}catch(e){self.postMessage({ticket,error:e.message||String(e)});}};
