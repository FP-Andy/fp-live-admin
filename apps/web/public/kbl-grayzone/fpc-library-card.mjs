const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PART=/^take-[0-9]{5,}-part-[0-9]{6,}\.mp4$/;

// Select the earliest recording and its earliest durable segment for this match.
export function firstRecordingPart(recordings) {
 const eligible=(Array.isArray(recordings)?recordings:[]).map((r,index)=>({r,index,at:Date.parse(r.created_at),parts:(Array.isArray(r.parts)?r.parts:[]).filter(p=>Number.isSafeInteger(p.number)&&p.number>0&&PART.test(p.sourcePartName||''))}))
  .filter(x=>UUID.test(x.r.id||'')&&x.parts.length);
 eligible.sort((a,b)=>(Number.isFinite(a.at)?a.at:Infinity)-(Number.isFinite(b.at)?b.at:Infinity)||a.index-b.index);
 if(!eligible.length)return null;
 const {r,parts}=eligible[0],part=parts.reduce((a,b)=>a.number<b.number?a:b);
 return {sessionId:r.id,partNumber:part.number};
}

// An older recording sidecar can serve the operator-scoped manifest without
// being restarted during a live recording. Permission errors must not fall
// through to another endpoint.
export async function fetchFirstRecording(mid,fetchFirst,fetchFallback) {
 const response=await fetchFirst(mid);
 if(response.ok){const data=await response.json();return UUID.test(data.recordingId||'')&&Number.isSafeInteger(data.partNumber)&&data.partNumber>0?{sessionId:data.recordingId,partNumber:data.partNumber}:null;}
 if(response.status===404){const data=await fetchFallback(mid);return firstRecordingPart(data.recordings);}
 throw Error('광각 녹화 정보를 확인할 수 없습니다.');
}

// A published version is the explicit delivery decision, not PDF generation.
export function reportCompletion(cases,results) {
 if(!cases.length)return 'not-started';
 if(results.some(r=>r.status==='fulfilled'&&r.value?.publishedVersion))return 'complete';
 return results.some(r=>r.status==='rejected')?'unknown':'in-progress';
}
