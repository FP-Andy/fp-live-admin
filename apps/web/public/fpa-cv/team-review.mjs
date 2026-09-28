import {checkpointFrame,saveCheckpoint,GROUPS} from './core.mjs';
import {uniformAt} from './integrity.mjs';

// Report only sustained, observed opposing-team evidence, not the timeline's
// grace period or a single mixed shirt sample. Explicit human ranges remain
// untouched until the operator releases the reported part.
export function lockedTeamConflicts(data,review,timeline,classify){
  const byTrack=new Map(),spans=[],open=new Map(),step=1/data.detector.sampleFps;
  for(const s of review.segments.filter(s=>s.locked&&s.personId)){
    const list=byTrack.get(s.trackId)||[];list.push(s);byTrack.set(s.trackId,list);
  }
  for(const [i,f] of data.frames.entries())for(const b of f.boxes){
    const s=byTrack.get(b.id)?.find(s=>s.from<=f.t&&f.t<s.to);if(!s)continue;
    const run=uniformAt(timeline,b.id,f.t),group=run?.group;
    const expected=GROUPS[review.roster.find(p=>p.id===s.personId)?.group]?.team;
    const detected=GROUPS[group]?.team;
    if(!['home','away'].includes(expected)||!['home','away'].includes(detected)||expected===detected)continue;
    const raw=classify(b,f.t);
    if(b.confidence<.3||raw.group!==group||raw.margin<.4)continue;
    const to=Math.min(s.to,data.video.clipEnd,f.t+step,data.frames[i+1]?.t??Infinity);
    const key=`${b.id}:${s.personId}:${group}`,last=open.get(key);
    if(last&&Math.abs(last.to-f.t)<step*.1){last.to=to;last.samples++;}
    else{const c={trackId:b.id,personId:s.personId,from:f.t,to,group,samples:1};open.set(key,c);spans.push(c);}
  }
  return spans.filter(s=>s.samples>=3&&s.to-s.from>=.55-1e-6);
}

export function releaseTeamConflicts(review,conflicts){
  let segments=review.segments;const released=[];
  for(const c of conflicts)segments=segments.flatMap(s=>{
    if(!s.locked||s.trackId!==c.trackId||s.personId!==c.personId||s.from>=c.to||s.to<=c.from)return [s];
    const from=Math.max(s.from,c.from),to=Math.min(s.to,c.to);
    released.push({trackId:s.trackId,personId:s.personId,from,to});
    return [...(s.from<from?[{...s,to:from}]:[]),...(to<s.to?[{...s,from:to}]:[])];
  });
  return {...review,segments,rejections:[...review.rejections,...released]};
}

export function sceneFrame(data,time,trackId){
  let scene=checkpointFrame(data,time);
  if(!scene.frame.boxes.some(b=>b.id===trackId)){
    const nearby=[data.frames[scene.index-1],data.frames[scene.index+1]].filter(f=>f&&Math.abs(f.t-time)<=1/data.detector.sampleFps&&f.boxes.some(b=>b.id===trackId)).sort((a,b)=>Math.abs(a.t-time)-Math.abs(b.t-time))[0];
    if(!nearby)throw Error('선택한 BB가 관측된 장면으로 이동하세요.');
    scene=checkpointFrame(data,nearby.t);
  }
  return scene;
}

export function confirmScene(review,data,trackId,time,personId){
  const {frame}=sceneFrame(data,time,trackId),previous=review.checkpoints?.find(c=>Math.abs(c.time-frame.t)<1e-6);
  const assignments=(previous?.assignments||[]).filter(a=>a.trackId!==trackId&&a.personId!==personId);
  return saveCheckpoint(review,data,frame.t,[...assignments,{trackId,personId}]);
}

export function clearScenes(review,trackId,from,to){
  return {...review,checkpoints:(review.checkpoints||[]).map(c=>c.time>=from&&c.time<to?{...c,assignments:c.assignments.filter(a=>a.trackId!==trackId)}:c).filter(c=>c.assignments.length)};
}
