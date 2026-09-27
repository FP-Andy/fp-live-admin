import {personIdentity,checkpointSegments} from './core.mjs';
import {courtProjection} from './heatmaps.mjs';
import {classifyUniform} from './colors.mjs';
import {overlap,uniformAt,appearanceSimilarity,compactAppearance,effectiveSegments} from './integrity.mjs';

const length=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const indexSegments=segments=>{const m=new Map();for(const s of segments){const a=m.get(s.trackId)||[];a.push(s);m.set(s.trackId,a);}return m;};
const at=(index,id,t)=>index.get(id)?.find(s=>s.from<=t&&t<s.to);

/** Offline tracklet paths rooted ONLY in human labels. A raw ID is cut at
 * gaps, collisions, sustained group changes and implausible motion. Reciprocal
 * match margins prohibit branching; disagreeing anchors leave the middle open.
 * This is a conservative path solver, not learned Re-ID or interpolated motion.
 */
export function recoverCheckpoints(data,review,timeline,onProgress=()=>{}) {
  const step=1/data.detector.sampleFps,aspect=data.video.width/data.video.height;
  let projection;try{projection=courtProjection(data.detector.roi);}catch{/* Legacy results can lack calibration. */}
  const position=box=>{
    const p=[(box[0]+box[2])/2,box[3]],xy=projection?.(p);
    return xy?.every(Number.isFinite)?[xy[0]*2,xy[1]]:[p[0]*aspect,p[1]];
  };
  const nodes=[],latest=new Map(),byTrack=new Map();
  for(const [fi,frame] of data.frames.entries()) {
    if(fi%128===0)onProgress({phase:'확인 장면 · 연속 관측 구간 분리',completed:fi,total:data.frames.length});
    if(frame.t+step/2<(review.setup?.time??data.video.clipStart))continue;
    for(const box of frame.boxes){
      const point=position(box.box),group=uniformAt(timeline,box.id,frame.t)?.group;
      const collision=frame.boxes.some(b=>b.id!==box.id&&overlap(box.box,b.box)>.55);
      let node=latest.get(box.id);
      const previous=node?.obs.at(-1),gap=previous?frame.t-previous.time:Infinity;
      const cut=!node||gap>step*1.6||collision!==node.collision||(group&&node.group&&group!==node.group)||length(previous.point,point)>.06+.5*gap;
      if(cut){node={id:nodes.length,trackId:box.id,from:frame.t,to:frame.t+step,group,collision,obs:[],anchors:[],incoming:[],outgoing:[]};nodes.push(node);latest.set(box.id,node);const list=byTrack.get(box.id)||[];list.push(node);byTrack.set(box.id,list);}
      node.to=Math.min(data.video.clipEnd,frame.t+step,data.frames[fi+1]?.t??Infinity);
      node.obs.push({time:frame.t,point,box,fi});if(group)node.group=group;
    }
  }
  // An old initial track range supplies its first observation, not an assertion
  // that a tracker ID can never change people. Explicit locked ranges stay
  // authoritative and are also honoured by the final per-frame occupancy pass.
  const initialPoints=[];
  for(const s of review.segments.filter(s=>s.personId&&s.source!=='auto')){
    const matches=(byTrack.get(s.trackId)||[]).filter(n=>n.from<s.to&&s.from<n.to);
    for(const n of (s.locked?matches:matches.slice(0,1))){
      const obs=n.obs.find(o=>s.from<=o.time&&o.time<s.to);if(obs){n.anchors.push({personId:s.personId,time:obs.time,kind:'manual'});if(!s.locked)initialPoints.push({...s,from:obs.time,to:Math.min(s.to,obs.time+step)});}
    }
  }
  for(const s of checkpointSegments(review)){
    const n=byTrack.get(s.trackId)?.find(n=>n.from<=s.from+1e-7&&s.from<n.to);if(n)n.anchors.push({personId:s.personId,time:s.from,kind:'checkpoint'});
  }
  for(const n of nodes){
    const ids=new Set(n.anchors.map(a=>a.personId));n.seed=ids.size===1?[...ids][0]:null;n.conflict=ids.size>1;
    n.ignored=review.segments.some(s=>s.trackId===n.trackId&&s.team==='ignore'&&s.from<n.to&&n.from<s.to);
    const clean=n.obs.filter(o=>o.box.confidence>=.3),sample=clean.filter((_,i)=>i%Math.max(1,Math.floor(clean.length/8))===0).slice(0,8);
    n.appearance=compactAppearance(sample.flatMap(o=>(o.box.appearance||[]).map(p=>({...p,weight:p.weight/(sample.length||1)}))),8);
    const color=classifyUniform(n.appearance,review.uniforms);n.color=color;
    if(n.seed)n.group=personIdentity(review,n.seed).group;
    else if(!n.group)n.group=color.group;
    n.first=n.obs[0];n.last=n.obs.at(-1);
  }
  // Only a short physical gap is bridged by an edge. Long absences need a new
  // human anchor instead of snapping to a stale nearest position.
  const ends=nodes.slice().sort((a,b)=>a.to-b.to),starts=nodes.slice().sort((a,b)=>a.from-b.from);
  let lo=0,hi=0;
  for(const [i,b] of starts.entries()){
    if(i%128===0)onProgress({phase:'확인 장면 · 앞뒤 경로 비교',completed:i,total:starts.length});
    while(lo<ends.length&&ends[lo].to<b.from-2)lo++;
    while(hi<ends.length&&ends[hi].to<=b.from+1e-6)hi++;
    if(b.collision||b.conflict||b.ignored||b.obs.length<2)continue;
    for(let j=lo;j<hi;j++){
      const a=ends[j];if(a===b||a.collision||a.conflict||a.ignored||a.obs.length<2)continue;
      if(a.group&&b.group&&a.group!==b.group)continue;
      if(a.seed&&b.seed&&a.seed!==b.seed)continue;
      const elapsed=b.first.time-a.last.time;if(elapsed<=0||elapsed>2+step)continue;
      const before=a.obs[Math.max(0,a.obs.length-4)],dt=a.last.time-before.time;
      let velocity=dt>0?a.last.point.map((v,k)=>(v-before.point[k])/dt):[0,0];
      const speed=Math.hypot(...velocity);if(speed>.5)velocity=velocity.map(v=>v*.5/speed);
      const predicted=a.last.point.map((v,k)=>v+velocity[k]*Math.min(elapsed,.5));
      const dist=Math.min(length(a.last.point,b.first.point),length(predicted,b.first.point));
      const gate=Math.min(.65,.05+.35*elapsed);if(dist>gate)continue;
      const appearance=appearanceSimilarity(a.appearance,b.appearance);
      if(appearance!==null&&appearance<.4)continue;
      const motion=Math.max(0,1-dist/gate),same=a.trackId===b.trackId;
      const score=.62*motion+.29*(appearance??.5)+.04*(same?1:0)+.05*(a.group&&a.group===b.group?1:.5)-.025*Math.max(0,elapsed-step);
      if(score<.74)continue;
      const edge={a,b,score};a.outgoing.push(edge);b.incoming.push(edge);
    }
  }
  for(const n of nodes){n.incoming.sort((a,b)=>b.score-a.score);n.outgoing.sort((a,b)=>b.score-a.score);}
  let links=0;
  for(const a of nodes){
    const e=a.outgoing[0];if(!e||e.b.incoming[0]!==e)continue;
    if(e.score-(a.outgoing[1]?.score??0)<.10||e.score-(e.b.incoming[1]?.score??0)<.10)continue;
    a.next=e.b;e.b.previous=a;a.edge=e.score;links++;
  }
  const conflicts=[];
  for(const head of nodes.filter(n=>!n.previous)){
    const chain=[];let n=head;while(n){chain.push(n);n=n.next;}
    const rejected=(node,id)=>review.rejections.some(s=>s.trackId===node.trackId&&s.personId===id&&s.from<node.to&&node.from<s.to);
    let seed=null,score=1,checkpoint=false;
    for(const current of chain){if(current.seed){seed=current.seed;score=1;checkpoint=current.anchors.some(a=>a.kind==='checkpoint');}else if(current.previous)score=Math.min(score,current.previous.edge);if(seed&&rejected(current,seed))seed=null;current.forward=seed?{personId:seed,score,checkpoint}:null;}
    seed=null;score=1;checkpoint=false;
    for(const current of chain.toReversed()){if(current.seed){seed=current.seed;score=1;checkpoint=current.anchors.some(a=>a.kind==='checkpoint');}else if(current.next)score=Math.min(score,current.edge);if(seed&&rejected(current,seed))seed=null;current.backward=seed?{personId:seed,score,checkpoint}:null;}
    for(const current of chain){
      const a=current.forward,b=current.backward;
      if(current.conflict||(a&&b&&a.personId!==b.personId)){
        conflicts.push({trackId:current.trackId,from:current.from,to:current.to,reason:'앞뒤 확인 번호 불일치'});continue;
      }
      if(current.collision)continue;
      const both=a&&b,choice=both?{personId:a.personId,score:Math.min(a.score,b.score)}:a||b;
      if(!choice||(!both&&choice.score<.84))continue;
      // One-sided paths across a fragment boundary still need a readable kit.
      // With weak/mixed colour, require confirming evidence on both sides.
      if(!both&&!current.seed&&!current.color.group)continue;
      current.identity={...personIdentity(review,choice.personId),score:choice.score,checkpointSupport:!!(a?.checkpoint||b?.checkpoint),mode:current.seed?'checkpoint-tracklet':both?'checkpoint-agreement':'checkpoint-path'};
    }
  }
  const manualIndex=indexSegments([...review.segments.filter(s=>s.locked||s.team==='ignore'),...initialPoints]);
  const pointIndex=indexSegments(checkpointSegments(review));
  const nodeFrames=Array.from({length:data.frames.length},()=>[]);
  for(const n of nodes)if(n.identity)for(const o of n.obs)nodeFrames[o.fi].push({node:n,observation:o});
  const segments=[],open=new Map(),rejected=indexSegments(review.rejections||[]);
  for(const [fi,items] of nodeFrames.entries()){
    const frame=data.frames[fi],occupied=new Set();
    for(const box of frame.boxes){const s=at(pointIndex,box.id,frame.t)||at(manualIndex,box.id,frame.t);if(s?.personId)occupied.add(s.personId);}
    const counts=new Map();
    for(const {node:n} of items){if(at(pointIndex,n.trackId,frame.t)||at(manualIndex,n.trackId,frame.t))continue;const id=n.identity.personId;counts.set(id,(counts.get(id)||0)+1);}
    for(const {node:n} of items){
      const identity=n.identity;
      if(counts.get(identity.personId)>1)conflicts.push({trackId:n.trackId,from:frame.t,to:Math.min(data.video.clipEnd,frame.t+step),reason:'같은 선수의 경로가 동시에 관측됨'});
      if(occupied.has(identity.personId)||counts.get(identity.personId)!==1||at(pointIndex,n.trackId,frame.t)||at(manualIndex,n.trackId,frame.t))continue;
      if((rejected.get(n.trackId)||[]).some(s=>s.personId===identity.personId&&s.from<=frame.t&&frame.t<s.to))continue;
      const to=Math.min(data.video.clipEnd,frame.t+step,data.frames[fi+1]?.t??Infinity),key=`${n.id}:${identity.personId}`,previous=open.get(key);
      if(previous&&Math.abs(previous.to-frame.t)<1e-6)previous.to=to;
      else {const s={...identity,trackId:n.trackId,from:frame.t,to,source:'auto',time:frame.t,previousTrack:n.previous?.trackId??n.trackId,gap:n.previous?Math.max(0,n.from-n.previous.to):0,uniform:identity.group};open.set(key,s);segments.push(s);}
    }
  }
  const masks=review.segments.filter(s=>s.personId&&!s.locked).flatMap(s=>{
    const first=initialPoints.find(p=>p.trackId===s.trackId&&p.personId===s.personId&&s.from<=p.from&&p.to<=s.to);
    return first?[...(s.from<first.from?[{...s,to:first.from}]:[]),...(first.to<s.to?[{...s,from:first.to}]:[])]:[s];
  }).map(s=>({...s,reason:'확인 장면 기반 경로로 재평가'}));
  const warnings=conflicts.map(c=>({...c,time:c.from}));
  const suggestions=nodes.filter(n=>!n.identity&&!n.collision&&n.obs.length>=3).map(n=>({trackId:n.trackId,time:n.from,from:n.from,to:n.to,options:[],reason:n.conflict?'같은 관측 구간의 확인 번호가 다릅니다.':'확인 장면과 안전하게 이어지는 경로가 없습니다.'}));
  return {segments,masks,warnings,suggestions,blockedIntervals:conflicts,checkpointDiagnostics:{solver:'human-tracklet-paths/v1',coordinateSystem:projection?'court-normalized':'image-aspect',nodes:nodes.length,links,conflictingIntervals:conflicts.length,confirmedScenes:review.checkpoints.length}};
}

/** Preserve unaffected baseline associations. Human-supported paths may replace
 * an old automatic guess; contradictory anchor intervals cannot fall back to it.
 * Resolve occupancy again after merging, so a corrected player cannot remain on
 * their previous BB at the same instant. */
export function mergeCheckpointRecovery(data,review,baseline,graph){
  const masks=[...baseline.masks,...graph.masks],fixed=indexSegments(effectiveSegments(review,{masks,segments:[]}));
  const old=indexSegments(effectiveSegments(review,baseline)),paths=indexSegments(graph.segments),blocked=indexSegments(graph.blockedIntervals);
  const segments=[],spans=new Map(),step=1/data.detector.sampleFps;
  for(const [fi,frame] of data.frames.entries()){
    const occupied=new Set(),candidates=[];
    for(const b of frame.boxes){const s=at(fixed,b.id,frame.t);if(s?.personId)occupied.add(s.personId);}
    for(const b of frame.boxes){
      if(at(fixed,b.id,frame.t)||at(blocked,b.id,frame.t))continue;
      const previous=at(old,b.id,frame.t),path=at(paths,b.id,frame.t);
      const readablePath=path?.mode!=='checkpoint-path'||classifyUniform(b.appearance,review.uniforms).group===path.group;
      // Weak/mixed kits cannot add a new one-sided identity at an individual
      // observation merely because its tracklet's average colour looked clear.
      const choice=path?.checkpointSupport&&readablePath?path:previous?.personId?previous:readablePath?path:null;
      if(!choice?.personId||choice.team==='ignore')continue;
      candidates.push({box:b,identity:choice,priority:choice.checkpointSupport?2:1});
    }
    const ranked=candidates.sort((a,b)=>b.priority-a.priority);
    for(const {box,identity,priority} of ranked){
      if(occupied.has(identity.personId)||ranked.some(other=>other.box.id!==box.id&&other.identity.personId===identity.personId&&other.priority===priority))continue;
      occupied.add(identity.personId);
      const mode=identity.mode||'checkpoint-retained',key=`${box.id}:${identity.personId}:${mode}`;
      const to=Math.min(data.video.clipEnd,frame.t+step,data.frames[fi+1]?.t??Infinity),previous=spans.get(key);
      if(previous&&Math.abs(previous.to-frame.t)<1e-6)previous.to=to;
      else{const s={...identity,source:'auto',locked:false,trackId:box.id,from:frame.t,to,mode,score:identity.score??1,gap:identity.gap??0,previousTrack:identity.previousTrack??box.id,time:frame.t,uniform:identity.group};segments.push(s);spans.set(key,s);}
    }
  }
  const complete=indexSegments(effectiveSegments(review,{segments,masks})),unknown=new Map();
  for(const f of data.frames)for(const b of f.boxes)if(!at(complete,b.id,f.t)&&!unknown.has(b.id))unknown.set(b.id,f.t);
  const pending=new Map();
  for(const s of [...baseline.suggestions,...graph.suggestions])if(unknown.has(s.trackId)&&!pending.has(s.trackId))pending.set(s.trackId,{...s,time:unknown.get(s.trackId)});
  return {...baseline,segments,masks,suggestions:[...pending.values()],warnings:[...baseline.warnings,...graph.warnings],checkpointDiagnostics:{...graph.checkpointDiagnostics,solver:'human-paths-baseline-fusion/v1'}};
}
