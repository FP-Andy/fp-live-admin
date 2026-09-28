import {identityAt,personIdentity} from './core.mjs';

// Add only a proven, previously absent seed at its observed frame. Never replace
// an operator's interval, exclusion, jersey, checkpoint, or later review work.
export function restoreInitialSeeds(review,initial,data) {
  if(review.setup||!initial?.setup||initial.datasetId!==review.datasetId)return review;
  const time=initial.setup.time,step=1/data.detector.sampleFps;
  let result=review;
  for(const match of initial.initialization?.matches||[]) {
    if(!initial.initialization?.repairedPersonIds?.includes(match.personId))continue;
    if(!['reviewed-detection','exact-reviewed-box'].includes(match.method))continue;
    const seed=initial.segments.find(s=>s.personId===match.personId&&s.trackId===match.trackId);
    if(!seed||!data.frames[0].boxes.some(b=>b.id===seed.trackId))continue;
    if(identityAt(result,seed.trackId,time)||result.segments.some(s=>s.personId===seed.personId&&s.from<=time&&time<s.to))continue;
    if(result.rejections.some(r=>r.trackId===seed.trackId&&r.personId===seed.personId&&r.from<=time&&time<r.to))continue;
    if((result.checkpoints||[]).some(c=>c.time<=time&&time<c.to&&c.assignments.some(a=>a.trackId===seed.trackId||a.personId===seed.personId)))continue;
    const next=result.segments.filter(s=>s.trackId===seed.trackId&&s.from>time).reduce((to,s)=>Math.min(to,s.from),Math.min(data.video.clipEnd,time+step));
    result={...result,segments:[...result.segments,{...personIdentity(result,seed.personId),trackId:seed.trackId,from:time,to:next,source:'manual'}]};
  }
  if(!result.setup&&result.segments.some(s=>s.personId&&s.from<=time&&time<s.to))result={...result,setup:{time}};
  if(result.batch){
    const snapshot={...result,...result.batch.applied,batch:undefined};
    const repaired=restoreInitialSeeds(snapshot,initial,data);
    if(repaired!==snapshot)result={...result,batch:{...result.batch,applied:{...result.batch.applied,segments:repaired.segments,setup:repaired.setup}}};
  }
  if(result!==review)result={...result,segments:result.segments.slice().sort((a,b)=>a.trackId-b.trackId||a.from-b.from)};
  return result;
}
