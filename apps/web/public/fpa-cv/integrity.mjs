import { GROUPS, checkpointSegments } from './core.mjs';
import { classifyUniform, colorDistance } from './colors.mjs';

const team=g=>GROUPS[g]?.team||g;
const opposing=(a,b)=>['home','away'].includes(team(a))&&['home','away'].includes(team(b))&&team(a)!==team(b);

// Establish colours quickly, but require sustained, unoccluded evidence to
// change an established group. Durations are seconds, independent of sample FPS.
export function uniformTimeline(data,uniforms,onProgress=()=>{}) {
  const timelines=new Map(),states=new Map();
  for(const [index,frame] of data.frames.entries()) {
    if(index%32===0)onProgress(index,data.frames.length);
    for(const box of frame.boxes) {
    const color=classifyUniform(box.appearance,uniforms),old=states.get(box.id);
    const runs=timelines.get(box.id)||[],previous=runs.at(-1);
    // Weak evidence may sustain a recently established team, but can never
    // establish a new team or override strong evidence for the other team.
    const winner=Object.entries(color.scores).sort((a,b)=>b[1]-a[1])[0]?.[0];
    if(previous&&box.confidence>=.3&&winner===previous.group&&color.strength>=.045&&color.margin>=.4&&frame.t<=previous.to+.00001)previous.to=Math.min(data.video.clipEnd,frame.t+.8);
    const collision=frame.boxes.some(b=>b.id!==box.id&&overlap(b.box,box.box)>.25);
    const group=box.confidence>=.3&&color.margin>=.4?color.group:null;
    const same=group&&old?.group===group&&frame.t-old.last<=Math.max(.2,1.5/data.detector.sampleFps);
    const state={group,count:same?old.count+1:group?1:0,from:same?old.from:frame.t,last:frame.t};states.set(box.id,state);
    const changing=previous&&previous.group!==group;
    if(state.count<3||frame.t-state.from<(changing?(collision?.95:.55):.10)-1e-6)continue;
    if(previous?.group===group&&state.from<=previous.to){previous.to=Math.min(data.video.clipEnd,frame.t+.8);continue;}
    if(previous)previous.to=Math.min(previous.to,state.from);
    runs.push({from:state.from,to:Math.min(data.video.clipEnd,frame.t+.8),group});timelines.set(box.id,runs);
    }
  }
  onProgress(data.frames.length,data.frames.length);
  return timelines;
}
export function uniformAt(timeline,id,time) {return timeline.get(id)?.find(r=>r.from<=time&&time<r.to);}
export function teamConflict(identity,run) {return !!(identity&&run&&opposing(identity.group||identity.team,run.group));}

export function identityMasks(review,timeline) {
  const masks=[];
  for(const s of review.segments) {
    if(s.team==='ignore'||s.locked)continue;
    const person=review.roster.find(p=>p.id===s.personId);
    const expected=person?.group||s.group||s.team,runs=timeline.get(s.trackId)||[];
    for(let i=0;i<runs.length;i++) {
      const run=runs[i];if(run.to<=s.from||run.from>=s.to||!opposing(expected,run.group))continue;
      // An ID that moved to the other team is no longer a trustworthy manual
      // anchor for this interval. A later return must pass missing-player
      // association again; colour alone cannot steal an identity back.
      const from=Math.max(s.from,run.from),to=s.to;
      if(from<to&&!masks.some(m=>m.trackId===s.trackId&&m.personId===s.personId&&m.from<=from&&m.to>=to))masks.push({trackId:s.trackId,personId:s.personId,from,to,group:run.group,reason:'지정 팀과 유니폼 불일치 · 일치 관측 전까지 보류'});
    }
  }
  return masks;
}
export function effectiveSegments(review,recovery) {
  let segments=review.segments;
  for(const m of recovery.masks||[])segments=segments.flatMap(s=>s.trackId!==m.trackId||s.personId!==m.personId||s.to<=m.from||s.from>=m.to?[s]:[
    ...(s.from<m.from?[{...s,to:m.from}]:[]),...(s.to>m.to?[{...s,from:m.to}]:[]),
  ]);
  segments=[...segments,...recovery.segments];
  // A point confirmation wins on its observed frame on both its BB and roster
  // slot. It cannot silently confirm a raw ID before/after an identity switch.
  for(const anchor of checkpointSegments(review)){
    segments=segments.flatMap(s=>(s.trackId!==anchor.trackId&&s.personId!==anchor.personId)||s.to<=anchor.from||s.from>=anchor.to?[s]:[
      ...(s.from<anchor.from?[{...s,to:anchor.from}]:[]),...(s.to>anchor.to?[{...s,from:anchor.to}]:[])]);
    segments.push(anchor);
  }
  return segments;
}
export function appearanceSimilarity(a,b) {
  if(!a?.length||!b?.length)return null;
  const directed=(x,y)=>{
    const mass=x.reduce((s,p)=>s+p.weight,0);
    return mass?x.reduce((s,p)=>s+p.weight*Math.max(...y.map(q=>Math.max(0,1-colorDistance(p.rgb,q.rgb)/45)**2)),0)/mass:0;
  };
  return (directed(a,b)+directed(b,a))/2;
}
// Bounded appearance memory: pool colour bins instead of multiplying every
// pixel-cluster from every remembered frame in each association edge.
export function compactAppearance(samples,limit=16) {
  const bins=new Map();
  for(const p of samples){const key=p.rgb.map(v=>Math.min(7,Math.floor(v/32))).join(',');const bin=bins.get(key)||{rgb:[0,0,0],weight:0};bin.weight+=p.weight;p.rgb.forEach((v,i)=>bin.rgb[i]+=v*p.weight);bins.set(key,bin);}
  return [...bins.values()].sort((a,b)=>b.weight-a.weight).slice(0,limit).map(p=>({rgb:p.rgb.map(v=>v/p.weight),weight:p.weight}));
}
export function overlap(a,b) {
  const area=b=>(b[2]-b[0])*(b[3]-b[1]);
  const intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
  return intersection/Math.min(area(a),area(b));
}
