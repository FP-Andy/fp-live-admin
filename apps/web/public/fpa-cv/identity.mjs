import { GROUPS, identityAt, personIdentity, boxesAt, validateDataset,checkpointFrame } from './core.mjs';
import {buildKeeperContext,classifyKit} from './keeper-context.mjs';
import { courtPosition, touchlineEvidence, TOUCHLINE_NEAR } from './boundary.mjs';
import { uniformTimeline, uniformAt, teamConflict, identityMasks, appearanceSimilarity, compactAppearance, overlap, effectiveSegments } from './integrity.mjs';
import { consolidate } from './continuity.mjs';
import {recoverCheckpoints,mergeCheckpointRecovery} from './checkpoint-recovery.mjs';
import {lockedTeamConflicts} from './team-review.mjs';
import {planCheckpoints} from './checkpoint-plan.mjs';

export function setupIssues(review,data,time) {
  const issues=[];
  for(const [g,info] of Object.entries(GROUPS)) {
    if(!review.uniforms[g]?.length)issues.push(`${info.label} 유니폼 색상 필요`);
    if(review.roster.filter(p=>p.group===g&&p.jersey).length!==info.count)issues.push(`${info.label} ${info.count}명 번호 필요`);
  }
  for(const team of ['home','away']) {
    const jerseys=review.roster.filter(p=>GROUPS[p.group].team===team&&p.jersey).map(p=>String(Number(p.jersey)));
    if(new Set(jerseys).size!==jerseys.length)issues.push(`${team==='home'?'홈':'원정'} 등번호 중복`);
  }
  const visible=boxesAt(data,time), assigned=visible.map(b=>identityAt(review,b.id,time)).filter(s=>s?.personId);
  if(new Set(assigned.map(s=>s.personId)).size!==13)issues.push('이 프레임에서 명단 13명 모두 매칭 필요');
  if(assigned.length!==new Set(assigned.map(s=>s.personId)).size)issues.push('한 사람이 여러 BB에 중복 지정됨');
  return issues;
}

// Rectangular Hungarian assignment with one private unmatched column per row.
// Polynomial cost even when all 13 identities are temporarily missing.
export function maximumMatching(rows,columns,edges) {
  const n=rows.length,m=columns.length+n,u=new Float64Array(n+1),v=new Float64Array(m+1),p=new Int32Array(m+1),way=new Int32Array(m+1);
  for(let i=1;i<=n;i++) {
    p[0]=i;let j0=0;const min=new Float64Array(m+1).fill(Infinity),used=new Uint8Array(m+1);
    do {
      used[j0]=1;const i0=p[j0];let delta=Infinity,j1=0;
      for(let j=1;j<=m;j++)if(!used[j]) {
        const cost=j>columns.length?0:-(edges.get(`${rows[i0-1]}:${columns[j-1]}`)??-1e6),cur=cost-u[i0]-v[j];
        if(cur<min[j]){min[j]=cur;way[j]=j0;}
        if(min[j]<delta){delta=min[j];j1=j;}
      }
      for(let j=0;j<=m;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else min[j]-=delta;
      j0=j1;
    }while(p[j0]);
    do {const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0);
  }
  const pairs=[];
  for(let j=1;j<=columns.length;j++)if(p[j]){const trackId=rows[p[j]-1],personId=columns[j-1],score=edges.get(`${trackId}:${personId}`);if(score>0)pairs.push({trackId,personId,score});}
  return pairs.sort((a,b)=>rows.indexOf(a.trackId)-rows.indexOf(b.trackId));
}
const centre=box=>[(box[0]+box[2])/2,(box[1]+box[3])/2];
const distance=(a,b,aspect)=>Math.hypot((a[0]-b[0])*aspect,a[1]-b[1]);
const MOTION_MEMORY_SECONDS=8; // Motion precision decays; roster identities do not expire.

/** Recompute deterministically from manual anchors; seeking has no side effects.
 * Auto labels remain suggestions. No absent box is synthesized to force 13.
 * Manual labels win; only missing members of the fixed roster can reconnect.
 */
function reconnectBase(data,review,onProgress=()=>{},options={}) {
  const keeperContext=options.keeperContext||buildKeeperContext(data,review,(completed,total)=>onProgress({phase:'골키퍼 위치·이동 이력 확인',completed,total}));
  data={...data,keeperContext};
  const classify=(box,time,appearance=box?.appearance)=>classifyKit(box,time,review.uniforms,keeperContext,appearance);
  const result={segments:[],suggestions:[],warnings:[],issues:[],waiting:[],masks:[],duplicates:[],data,keeperContext,hasAppearance:data.frames.some(f=>f.boxes.some(b=>b.appearance?.length))};
  const report=(phase,completed,total)=>onProgress({phase,completed,total});
  const timeline=uniformTimeline(data,review.uniforms,(completed,total)=>report('1/3 · 유니폼 색상 확인',completed,total),classify);
  result.timeline=timeline;
  result.lockedConflicts=lockedTeamConflicts(data,review,timeline,classify);
  result.masks=identityMasks(review,timeline);
  for(const m of result.masks)result.warnings.push({trackId:m.trackId,personId:m.personId,time:m.from,reason:'유니폼과 지정 팀이 달라 기존 번호 연결을 보류했습니다.'});
  for(const s of review.segments.filter(s=>s.locked)) {
    const conflict=timeline.get(s.trackId)?.find(run=>run.from<s.to&&run.to>s.from&&teamConflict(s,run));
    if(conflict)result.warnings.push({trackId:s.trackId,personId:s.personId,time:Math.max(s.from,conflict.from),reason:'유니폼과 팀이 다릅니다. 작업자 확정은 유지했으니 확인해 주세요.'});
  }
  report('2/3 · 중복 트랙 정리',0,0);
  const continuity=options.reversePass?{data,duplicates:[],segments:[]}:consolidate(data,review,timeline,result.masks);
  result.data=continuity.data;result.duplicates=continuity.duplicates;result.segments=continuity.segments;
  if(!review.setup)return result;
  result.issues=options.reversePass?[]:setupIssues(review,data,review.setup.time);
  if(result.issues.length||!review.autoReconnect||!result.hasAppearance)return result;
  data=result.data;
  // Keep the existing association as the independent baseline. Human points
  // influence it through the constrained path merge, not as automatic seeds
  // that can run through an unexamined collision in this legacy pass.
  review={...review,checkpoints:[]};
  const anchors={...review,segments:effectiveSegments(review,result)};
  const step=1/data.detector.sampleFps,aspect=data.video.width/data.video.height;
  const known=new Map(),active=new Map(),histories=new Map(),manualConflicts=new Set(),warningKeys=new Set();
  const candidatesAtEnd=new Map(),boundaries=new Map(),openWaits=new Map(),lastOccupied=new Map(),origins=new Map();
  const observations=new Map();
  for(const frame of data.frames)for(const box of frame.boxes){const list=observations.get(box.id)||[];list.push({time:frame.t,box});observations.set(box.id,list);}
  // Offline lookahead validates a newcomer before backdating its identity.
  const futureEvidence=(id,time)=>{
    const list=observations.get(id)||[];let lo=0,hi=list.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(list[mid].time<time)lo=mid+1;else hi=mid;}
    const future=[];let previous=time;
    for(let i=lo;i<list.length&&list[i].time<=time+.6+1e-6;i++){
      if(list[i].time-previous>step*1.6)break;
      future.push(list[i]);previous=list[i].time;
    }
    return future;
  };
  const finish=(trackId,end)=> {
    const current=active.get(trackId);if(!current)return;
    const to=Math.min(end,current.last+step,data.video.clipEnd);
    if(to>current.from){result.segments.push({...current,to,source:'auto'});boundaries.set(trackId,to);}
    active.delete(trackId);
  };
  function observe(personId,box,time,color,learnAppearance=true) {
    const pos=centre(box.box),prev=known.get(personId);
    if(!origins.has(personId))origins.set(personId,pos);
    let velocity=prev?.velocity||[0,0];
    if(prev&&time>prev.time&&time-prev.time<.5) {
      const dt=time-prev.time;
      velocity=pos.map((n,i)=>.6*velocity[i]+.4*(n-prev.pos[i])/dt);
    }
    const position=courtPosition(box.box,data.detector.roi,aspect);
    const near=position&&position.distance<=TOUCHLINE_NEAR;
    const boundaryCount=near?(prev&&time-prev.time<.5?prev.boundaryCount||0:0)+1:0;
    const profiles=prev?.profiles?.slice()||[];
    if(learnAppearance&&box.appearance?.length&&color?.group===personIdentity(review,personId).group&&color.margin>=.5) {
      profiles.push(box.appearance);if(profiles.length>8)profiles.shift();
    }
    const profile=profiles.length?compactAppearance(profiles.flatMap(ps=>ps.map(p=>({...p,weight:p.weight/profiles.length})))):prev?.profile;
    known.set(personId,{time,pos,velocity,trackId:box.id,boundaryCount,boundary:boundaryCount>=3?position:null,profile,profiles});
  }
  for(const [index,frame] of data.frames.entries()) {
    if(index%32===0)report('3/3 · 선수 재연결',index,data.frames.length);
    if(frame.t+step/2<review.setup.time)continue;
    const time=frame.t,visible=new Map(frame.boxes.map(b=>[b.id,b])),manual=new Map(),occupied=new Map();
    manualConflicts.clear();
    for(const box of frame.boxes) {
      const samples=histories.get(box.id)||[];samples.push({time,box});
      while(samples.length>8)samples.shift();histories.set(box.id,samples);
      let identity=identityAt(anchors,box.id,Math.max(time,review.setup.time));
      if(result.masks.some(m=>m.trackId===box.id&&m.personId===identity?.personId&&m.from<=time&&time<m.to))identity=null;
      if(identity){manual.set(box.id,identity);boundaries.set(box.id,Math.min(identity.to,time+step));}
      if(identity?.personId) {
        if(occupied.has(identity.personId))manualConflicts.add(identity.personId);
        occupied.set(identity.personId,box.id);
      }
    }
    for(const [id,entry] of active) {
      if(manual.has(id)||occupied.has(entry.personId)||teamConflict(entry,uniformAt(timeline,id,time))) {finish(id,time);continue;}
      if(visible.has(id))occupied.set(entry.personId,id);
      if(time-entry.last>3)finish(id,time);
    }
    for(const box of frame.boxes) {
      const identity=manual.get(box.id)||active.get(box.id);
      if(!identity?.personId||manualConflicts.has(identity.personId))continue;
      const rawUniform=classify(box,time),stable=uniformAt(timeline,box.id,time);
      const uniform=rawUniform.group?rawUniform:{...rawUniform,group:stable?.group||null};
      const expected=personIdentity(review,identity.personId).group;
      // Do not use a contradictory observation as a new identity anchor.
      if(uniform.group&&uniform.group!==expected&&uniform.strength>.22&&uniform.margin>.5) {
        const key=`${box.id}:${identity.personId}`;
        if(!warningKeys.has(key)) {result.warnings.push({trackId:box.id,time,personId:identity.personId,reason:'지정한 그룹과 유니폼 색상이 다릅니다.'});warningKeys.add(key);}
        // A single colour error cannot revoke an identity. Stable contradictory
        // runs close it above; do not learn appearance or position from this box.
        if(active.has(box.id))active.get(box.id).last=time;
        continue;
      }
      const collision=frame.boxes.some(other=>other.id!==box.id&&overlap(box.box,other.box)>.12&&teamConflict(identity,uniformAt(timeline,other.id,time)));
      // A merged/ambiguous box must not move the last trusted player position.
      if((!collision||uniform.group===expected)&&(!uniform.group||uniform.group===expected||identity.locked))observe(identity.personId,box,time,uniform,!collision);
      if(active.has(box.id))active.get(box.id).last=time;
    }
    for(const id of occupied.keys())lastOccupied.set(id,time);
    const missing=review.roster.filter(p=>!occupied.has(p.id)&&known.has(p.id));
    const waiting=new Set(missing.filter(p=>known.get(p.id).boundary).map(p=>p.id));
    for(const id of openWaits.keys())if(!waiting.has(id))openWaits.delete(id);
    for(const id of waiting) {
      if(!openWaits.has(id)){const entry={personId:id,from:time,to:time};openWaits.set(id,entry);result.waiting.push(entry);}
      openWaits.get(id).to=Math.min(data.video.clipEnd,time+step);
    }
    const targets=frame.boxes.filter(b=>!manual.has(b.id)&&!active.has(b.id));
    const targetColors=new Map(targets.map(b=>[b.id,classify(b,time)]));
    const edges=new Map(),details=new Map();
    for(const box of targets) {
      const history=(histories.get(box.id)||[]).filter(h=>time-h.time<=.45);
      if(history.length<3||history.reduce((s,h)=>s+h.box.confidence,0)/history.length<.35)continue;
      const samples=history.flatMap(h=>(h.box.appearance||[]).map(p=>({...p,weight:p.weight/history.length})));
      const appearance=compactAppearance(samples);
      const uniform=classify(box,time,samples);
      const consistentFrames=history.filter(h=>classify(h.box,h.time).group===uniform.group).length;
      const future=futureEvidence(box.id,time),futureColors=future.map(h=>classify(h.box,h.time));
      const persistent=future.length>=3&&future.at(-1).time-time>=.35&&futureColors.filter(c=>c.group===uniform.group).length/future.length>=.8;
      const collision=frame.boxes.some(other=>other.id!==box.id&&overlap(box.box,other.box)>.25);
      const options=[];
      for(const p of missing) {
        const last=known.get(p.id),gap=time-last.time;
        if(review.rejections.some(r=>r.trackId===box.id&&r.personId===p.id&&r.from<=time&&time<r.to))continue;
        if(!uniform.group||uniform.group!==p.group)continue;
        const predicted=last.pos.map((v,i)=>v+last.velocity[i]*Math.min(gap,.6));
        // Last position remains useful when a player stops or changes direction
        // during a duel. Do not let a stale velocity override a close return.
        const predictedDistance=distance(centre(box.box),predicted,aspect),lastDistance=distance(centre(box.box),last.pos,aspect);
        const dist=Math.min(predictedDistance,lastDistance),gate=Math.min(.30,.04+.10*gap);
        const color=Math.min(1,uniform.strength/.22)*.5+uniform.margin*.5;
        const uniqueGroup=missing.filter(other=>other.group===p.group).length===1;
        if(gap>MOTION_MEMORY_SECONDS&&lastDistance>.18&&!uniqueGroup&&!last.boundary)continue;
        const similarity=appearanceSimilarity(last.profile,appearance);
        const normalScore=gap<=MOTION_MEMORY_SECONDS&&dist<=gate ? .45*Math.max(0,1-dist/gate)+.35*color+.10*Math.max(0,1-gap/MOTION_MEMORY_SECONDS)+.10*(similarity??color) : -1;
        const boundary=consistentFrames/history.length>=.6?touchlineEvidence(last,box.box,data.detector.roi,aspect,gap,consistentFrames):null;
        const boundaryScore=boundary ? .5*boundary.motion+.35*color+.15*boundary.recency : -1;
        const position=courtPosition(box.box,data.detector.roi,aspect);
        const sameGroupMissing=missing.filter(other=>other.group===p.group);
        const teammates=review.roster.filter(other=>other.group===p.group&&other.id!==p.id);
        const stableOthers=teammates.every(other=>occupied.has(other.id)&&time-(known.get(other.id)?.time??-Infinity)<=step*2.1);
        const sameGroupTargets=targets.filter(b=>targetColors.get(b.id)?.group===p.group);
        // Closed-roster inference needs every other member accounted for, one
        // sustained human candidate, and no overlap or implausible short jump.
        // GK roles are unique, but location is only a soft prior (flying keepers).
        const unique=sameGroupMissing.length===1&&sameGroupTargets.length===1&&stableOthers;
        const reachable=lastDistance<=Math.min(.7,.05+.12*gap);
        const plausiblePosition=position?position.inside||!!boundary:lastDistance<=.18;
        const rosterEvidence=unique&&persistent&&!collision&&reachable&&plausiblePosition&&color>=.85&&(similarity??0)>=.6;
        const origin=origins.get(p.id),keeper=p.group.endsWith('_gk');
        const keeperPrior=keeper&&origin?Math.max(0,1-distance(centre(box.box),origin,aspect)/.8):.5;
        const rosterScore=rosterEvidence?.90+.025*(similarity??0)+.015*keeperPrior:-1;
        // Multi-person recovery still needs motion/appearance separation. Old
        // positions lose authority over time; ambiguity stays in the review queue.
        const persistentScore=persistent&&!collision&&gap>MOTION_MEMORY_SECONDS&&lastDistance<.18&&(similarity??0)>=.7 ? .48*Math.max(0,1-lastDistance/.24)+.35*color+.12*(similarity??0)+.05*keeperPrior:-1;
        const scores={motion:normalScore,touchline:boundaryScore,roster:rosterScore,tracklet:persistentScore};
        const [mode,score]=Object.entries(scores).sort((a,b)=>b[1]-a[1])[0];
        if(score<0)continue;
        const maskedFrom=Math.max(0,...result.masks.filter(m=>m.trackId===box.id&&m.from<=time&&time<m.to).map(m=>m.from));
        const nearbyRadius=persistent&&(similarity??0)>=.8?.14:.10;
        const nearbyMissing=missing.filter(other=>other.group===p.group&&distance(centre(box.box),known.get(other.id).pos,aspect)<=nearbyRadius);
        const soleNearby=nearbyMissing.length===1&&gap<=MOTION_MEMORY_SECONDS&&lastDistance<=(nearbyRadius>.1?.12:.065)&&consistentFrames>=3&&consistentFrames/history.length>=.6&&(similarity??0)>=.6;
        const detail={trackId:box.id,personId:p.id,time,from:Math.max(history[0].time,last.time+step,(lastOccupied.get(p.id)??-step)+step,boundaries.get(box.id)||0,maskedFrom),score,gap,distance:mode==='touchline'?boundary.distance:dist,uniform:uniform.group,colorScore:color,appearanceScore:similarity,previousTrack:last.trackId,mode,soleNearby,...(mode==='touchline'?{boundaryEdge:boundary.edge,evidenceFrames:consistentFrames}:{})};
        options.push(detail);if(score>=.55){edges.set(`${box.id}:${p.id}`,score);details.set(`${box.id}:${p.id}`,detail);}
      }
      options.sort((a,b)=>b.score-a.score);
      if(options.length&&options[0].score>(candidatesAtEnd.get(box.id)?.options[0]?.score??-1))candidatesAtEnd.set(box.id,{trackId:box.id,time,options:options.slice(0,3),reason:'후보 차이가 작거나 연결 근거가 부족합니다.'});
      else if(!candidatesAtEnd.has(box.id))candidatesAtEnd.set(box.id,{trackId:box.id,time,options:[],reason:uniform.group?'색상·위치·시간이 맞는 미검출 선수가 없습니다.':'유니폼 색상이 불명확합니다.'});
    }
    const pairs=maximumMatching(targets.map(b=>b.id),missing.map(p=>p.id),edges);
    for(const pair of pairs) {
      const key=`${pair.trackId}:${pair.personId}`,detail=details.get(key);
      const rowAlt=Math.max(0,...missing.filter(p=>p.id!==pair.personId).map(p=>edges.get(`${pair.trackId}:${p.id}`)||0));
      const colAlt=Math.max(0,...targets.filter(b=>b.id!==pair.trackId).map(b=>edges.get(`${b.id}:${pair.personId}`)||0));
      if(pair.score<Math.max(options.reversePass?.86:0,detail.soleNearby ? .70 : .82)||pair.score-Math.max(rowAlt,colAlt)<.12||detail.from>time)continue;
      // A person's previous automatic fragment must close before the new one.
      for(const [id,entry] of active)if(entry.personId===pair.personId)finish(id,detail.from);
      const identity=personIdentity(review,pair.personId);
      active.set(pair.trackId,{...identity,...detail,trackId:pair.trackId,from:detail.from,last:time,source:'auto'});
      observe(pair.personId,visible.get(pair.trackId),time,classify(visible.get(pair.trackId),time));occupied.set(pair.personId,pair.trackId);
      candidatesAtEnd.delete(pair.trackId);
    }
  }
  for(const id of [...active.keys()])finish(id,data.video.clipEnd);
  const courtTracks=new Set(data.frames.flatMap(f=>f.boxes.filter(b=>courtPosition(b.box,data.detector.roi,aspect)?.inside!==false).map(b=>b.id)));
  result.suggestions=[...candidatesAtEnd.values()].filter(s=>!result.segments.some(a=>a.trackId===s.trackId)&&(s.options.length||courtTracks.has(s.trackId)));
  report('3/3 · 선수 재연결',data.frames.length,data.frames.length);
  if(!options.reversePass&&!options.forwardOnly) {
    // A later reliable anchor can identify the preceding missing fragment.
    // Reverse only observed time; no synthetic boxes or interpolated gaps.
    const first=data.frames[0].t,last=data.frames.at(-1).t,pivot=first+last;
    const mirror=s=>({...s,from:Math.max(data.video.clipStart,pivot-s.to+step),to:Math.min(data.video.clipEnd,pivot-s.from+step)});
    const fixed=effectiveSegments(review,result);
    // All existing labels occupy their roster slot during the reverse pass.
    // Low-score proposals cannot seed recovery into additional fragments.
    const seeds=fixed.filter(s=>s.source!=='auto'||s.mode==='continuity'||s.score>=.86);
    if(seeds.length) {
      const reversed=validateDataset({...data,frames:data.frames.toReversed().map(f=>({...f,t:pivot-f.t}))});
      const reverseReview={...review,checkpoints:[],setup:{time:reversed.frames[0].t},segments:seeds.map(s=>({...mirror(s),locked:true})).filter(s=>s.from<s.to),
        rejections:review.rejections.map(mirror).filter(s=>s.from<s.to)};
      const back=reconnect(reversed,reverseReview,info=>onProgress({...info,phase:'4/4 · 이후 관측으로 빈 구간 복구'}),{reversePass:true,keeperContext:{...keeperContext,timeline:new Map([...keeperContext.timeline].map(([id,runs])=>[id,runs.map(mirror).sort((a,b)=>a.from-b.from)]))}});
      // Never overwrite a forward/manual track interval, nor duplicate an
      // occupied person on another observed box. Split at observation boundaries.
      const indexByTrack=new Map();for(const s of fixed){const list=indexByTrack.get(s.trackId)||[];list.push(s);indexByTrack.set(s.trackId,list);}
      const reverseByTrack=new Map();for(const s of back.segments){const list=reverseByTrack.get(s.trackId)||[];list.push({...mirror(s),time:pivot-s.time,mode:'backward',evidenceMode:s.mode});reverseByTrack.set(s.trackId,list);}
      const spans=new Map(),added=[];
      for(const frame of data.frames){
        const occupied=new Set(frame.boxes.map(b=>indexByTrack.get(b.id)?.find(s=>s.from<=frame.t&&frame.t<s.to)?.personId).filter(Boolean));
        for(const box of frame.boxes){
          if(indexByTrack.get(box.id)?.some(s=>s.from<=frame.t&&frame.t<s.to))continue;
          const candidate=reverseByTrack.get(box.id)?.find(s=>s.from<=frame.t+1e-7&&frame.t+1e-7<s.to);if(!candidate||occupied.has(candidate.personId))continue;
          occupied.add(candidate.personId);
          const key=`${box.id}:${candidate.personId}`,previous=spans.get(key),to=Math.min(data.video.clipEnd,frame.t+step);
          if(previous&&Math.abs(previous.to-frame.t)<step*.1){previous.to=to;previous.last=frame.t;}
          else{const segment={...candidate,from:frame.t,to,last:frame.t};spans.set(key,segment);added.push(segment);}
        }
      }
      result.segments.push(...added);
      // Retain pending fragments with any unlabelled observations; partial
      // reverse recovery must not hide the rest of a track from the review queue.
      const completed=new Map();for(const s of [...fixed,...added]){const list=completed.get(s.trackId)||[];list.push(s);completed.set(s.trackId,list);}
      const unlabelled=new Set();for(const frame of data.frames)for(const box of frame.boxes)if(!completed.get(box.id)?.some(s=>s.from<=frame.t&&frame.t<s.to))unlabelled.add(box.id);
      result.suggestions=result.suggestions.filter(s=>unlabelled.has(s.trackId));
    }
  }
  return result;
}

export function reconnect(data,review,onProgress=()=>{},options={}) {
  // The worker may reuse the exact initial-only result for unchanged inputs.
  // A manually selected hidden/raw BB needs fresh duplicate consolidation.
  const keeperCheckpoint=(review.checkpoints||[]).some(c=>c.assignments.some(a=>review.roster.find(p=>p.id===a.personId)?.group.endsWith('_gk')));
  const reusable=options.baseline&&!keeperCheckpoint&&(review.checkpoints||[]).every(c=>{
    const frame=checkpointFrame(options.baseline.data,c.time).frame;
    return c.assignments.every(a=>frame.boxes.some(b=>b.id===a.trackId));
  });
  let result=reusable?options.baseline:reconnectBase(data,review,onProgress,options);
  if(!options.reversePass&&review.checkpoints?.length&&review.autoReconnect&&review.setup&&!result.issues.length){
    const graph=recoverCheckpoints(result.data,review,result.timeline,onProgress);
    result=mergeCheckpointRecovery(result.data,review,result,graph);
  }
  if(!options.reversePass&&review.setup&&!result.issues.length){
    result.checkpointPlan=planCheckpoints(result.data,review,effectiveSegments(review,result),onProgress);
  }
  return result;
}
