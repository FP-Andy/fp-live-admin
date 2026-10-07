import {deriveSubstitutionReport} from './substitution-report.mjs';
const cache=new Map();
async function get(url){if(cache.has(url))return cache.get(url);const response=await fetch(url);if(!response.ok)throw Error('분석 원본을 불러오지 못했습니다. 다시 시도하세요.');const value=await response.json();cache.set(url,value);return value;}
self.onmessage=async({data:{ticket,snapshotId,jobId,saved}})=>{try{
 const snapshot=await get('/api/futsal/analysis-snapshots/'+encodeURIComponent(snapshotId));
 const tracks=saved.log?.substitutions?.length?await get('/api/tracking/jobs/'+encodeURIComponent(jobId)+'/tracks.json'):{datasetId:snapshot.heatmap.datasetId};
 const result=deriveSubstitutionReport(snapshot,tracks,saved,progress=>self.postMessage({ticket,progress}));self.postMessage({ticket,result});
}catch(e){self.postMessage({ticket,error:e.message||String(e)});}};
