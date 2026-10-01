import {identityAt,checkpointSegments} from './core.mjs';

export const SHADOW_BODY_VERSION='contained-body/v1';
const area=b=>Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
const center=b=>[(b[0]+b[2])/2,(b[1]+b[3])/2];
const containment=(a,b)=>Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]))/Math.max(1e-12,area(b));
const norm=v=>Math.hypot(...v),dot=(a,b)=>a[0]*b[0]+a[1]*b[1];
export function darkMass(samples){
  const mass=(samples||[]).reduce((s,p)=>s+p.weight,0);
  return mass?(samples||[]).reduce((s,p)=>s+(Math.max(...p.rgb)<48?p.weight:0),0)/mass:0;
}
function candidate(big,body,aspect){
  const ratio=area(body.box)/area(big.box);
  if(ratio<.15||ratio>.60||containment(big.box,body.box)<.88||body.confidence<.10)return null;
  const a=center(big.box),b=center(body.box),delta=[(a[0]-b[0])*aspect,a[1]-b[1]],length=norm(delta);
  const bw=(body.box[2]-body.box[0])*aspect,bh=body.box[3]-body.box[1],scale=Math.hypot(bw,bh);
  if(length<scale*.12||length>scale*1.8)return null;
  const largeDark=darkMass(big.appearance),smallDark=darkMass(body.appearance);
  // Darkness is supporting evidence for a contained pair, never a reason to
  // remove a standalone player or a dark kit.
  if(largeDark<.40||largeDark<smallDark+.12)return null;
  return {big:big.id,body:body.id,delta,direction:delta.map(v=>v/length),scale,ratio};
}
function append(list,value,step,keys){
  const last=list.at(-1);
  if(last&&keys.every(k=>last[k]===value[k])&&Math.abs(last.to-value.from)<step*.1)last.to=value.to;
  else list.push(value);
}

/** Offline, reversible normalization of observed body/shadow pairs.
 * Every removed box has a simultaneous retained body, repeated co-motion,
 * scene-level directional support, and no independently observed second person.
 * No coordinates or observations are invented; raw track IDs remain intact.
 */
export function normalizeShadowBodies(data,review,onProgress=()=>{}){
  const empty={data,segments:[],masks:[],duplicates:[],shadowBodies:{version:SHADOW_BODY_VERSION,pairs:0,hidden:0,transfers:0}};
  if(!review.shadowCorrection)return empty;
  const step=1/data.detector.sampleFps,aspect=data.video.width/data.video.height;
  const checkpoints=checkpointSegments(review),anchors={...review,segments:[...checkpoints,...review.segments]};
  const observations=new Map(),rawCandidates=[],buckets=new Map();
  for(const [index,frame] of data.frames.entries()){
    if(index%128===0)onProgress({phase:'몸·그림자 관계 확인',completed:index,total:data.frames.length});
    for(const box of frame.boxes){const list=observations.get(box.id)||[];list.push({index,time:frame.t,box});observations.set(box.id,list);}
    const candidates=[];
    for(const big of frame.boxes){
      const children=frame.boxes.filter(b=>b.id!==big.id&&area(b.box)<area(big.box)*.65&&containment(big.box,b.box)>.80);
      // A box containing two possible bodies could be a duel: keep all of it.
      if(children.length!==1)continue;
      const body=children[0],pair=candidate(big,body,aspect);if(!pair)continue;
      const a=identityAt(anchors,big.id,frame.t),b=identityAt(anchors,body.id,frame.t);
      if(a?.team==='ignore'||b?.team==='ignore'||a?.locked||a?.checkpoint||b?.checkpoint||(a?.personId&&b?.personId&&a.personId!==b.personId)||(review.autoReconnect===false&&a?.personId&&!b?.personId))continue;
      if(a?.personId&&review.rejections?.some(r=>r.trackId===body.id&&r.personId===a.personId&&r.from<=frame.t&&frame.t<r.to))continue;
      candidates.push({...pair,index,time:frame.t});
    }
    rawCandidates.push(candidates);
    // One vote per body per local time bucket; long-lived duplicates must not
    // overwhelm the direction inferred from different players.
    const key=Math.floor(frame.t/30),votes=buckets.get(key)||new Map();
    for(const p of candidates)if(!votes.has(p.body))votes.set(p.body,p.direction);
    buckets.set(key,votes);
  }
  const directions=new Map();
  for(const [bucket,votes] of buckets){
    const vectors=[...votes.values()];if(vectors.length<3)continue;
    const best=vectors.map(v=>vectors.filter(w=>dot(v,w)>.80)).sort((a,b)=>b.length-a.length)[0];
    if(best.length<3||best.length/vectors.length<.60)continue;
    const sum=best.reduce((s,v)=>[s[0]+v[0],s[1]+v[1]],[0,0]),length=norm(sum);
    directions.set(bucket,sum.map(v=>v/length));
  }
  const pairRuns=new Map();
  for(const list of rawCandidates)for(const p of list){
    const direction=directions.get(Math.floor(p.time/30));if(!direction||dot(direction,p.direction)<.75)continue;
    const key=`${p.big}:${p.body}`,runs=pairRuns.get(key)||[],last=runs.at(-1);
    if(last&&p.time-last.at(-1).time<=step*1.6)last.push(p);else runs.push([p]);
    pairRuns.set(key,runs);
  }
  const safe=[];
  for(const [key,runs] of pairRuns){
    const [bigId,bodyId]=key.split(':').map(Number),bigObs=observations.get(bigId),bodyObs=observations.get(bodyId);
    const bi=new Map(bigObs.map(x=>[x.index,x]));
    // If these tracks were seen as separate bodies before the overlap, they
    // retain independent identities. Do not merge them when they later meet.
    const first=bodyObs.find(x=>bi.has(x.index));
    if(!first||containment(bi.get(first.index).box.box,first.box.box)<.80)continue;
    for(const run of runs){
      if(run.length<3||run.at(-1).time-run[0].time<.12)continue;
      const start=run[0],end=run.at(-1),mean=run.reduce((s,p)=>[s[0]+p.delta[0]/run.length,s[1]+p.delta[1]/run.length],[0,0]);
      if(run.some(p=>norm([p.delta[0]-mean[0],p.delta[1]-mean[1]])>p.scale*.40))continue;
      // Two already independent tracks must not become a pair solely because
      // one briefly encloses the other during contact.
      const separated=bodyObs.filter(o=>o.time<start.time&&bi.has(o.index)&&containment(bi.get(o.index).box.box,o.box.box)<.5);
      if(separated.length>=3)continue;
      safe.push({run,big:bigId,body:bodyId,from:start.time,to:Math.min(data.video.clipEnd,end.time+step),confirmedAt:run[2].time});
    }
  }
  const removed=new Map(),muted=new Map(),segments=[],masks=[],duplicates=[];
  let transfers=0;
  for(const pair of safe){
    for(const p of pair.run){
      const set=removed.get(p.index)||new Map();
      // Do not allow nested chains or one body to explain multiple boxes.
      if(set.has(p.body)||[...set.values()].includes(p.big)||[...set.values()].includes(p.body))continue;
      set.set(p.big,p.body);removed.set(p.index,set);
      const a=identityAt(anchors,p.big,p.time),b=identityAt(anchors,p.body,p.time),to=Math.min(data.video.clipEnd,p.time+step);
      append(duplicates,{trackId:p.big,canonicalTrackId:p.body,from:p.time,to,confirmedAt:pair.confirmedAt,reason:'body-shadow'},step,['trackId','canonicalTrackId']);
      if(a?.personId&&!b?.personId&&!review.rejections?.some(r=>r.trackId===p.body&&r.personId===a.personId&&r.from<=p.time&&p.time<r.to)){
        append(masks,{trackId:p.big,personId:a.personId,from:p.time,to,reason:'몸 박스로 번호 승계'},step,['trackId','personId']);
        append(segments,{...a,trackId:p.body,from:p.time,to,source:'auto',mode:'body-representative',previousTrack:p.big,time:p.time,gap:0,uniform:a.group,confirmedAt:pair.confirmedAt},step,['trackId','personId']);transfers++;
      }
    }
    // Weak, shadow-dominated colour just before/after an established pair must
    // not overturn a seed. Reduce that evidence; do not borrow future colours.
    for(const o of observations.get(pair.big))if(o.time>=pair.from-.35&&o.time<pair.to+.2&&darkMass(o.box.appearance)>.40){
      const anchor=identityAt(anchors,pair.big,o.time);
      if(anchor?.locked||anchor?.checkpoint||anchor?.team==='ignore')continue;
      const set=muted.get(o.index)||new Set();set.add(pair.big);muted.set(o.index,set);
    }
  }
  const frames=data.frames.map((frame,index)=>{
    const hide=removed.get(index),mute=muted.get(index);if(!hide&&!mute)return frame;
    return {...frame,boxes:frame.boxes.filter(b=>!hide?.has(b.id)).map(b=>mute?.has(b.id)?{...b,appearance:b.appearance.map(p=>({...p,weight:p.weight*(Math.max(...p.rgb)<48?.05:1)})),shadowColourMuted:true}:b)};
  });
  return {data:{...data,frames},segments,masks,duplicates,shadowBodies:{version:SHADOW_BODY_VERSION,pairs:safe.length,hidden:[...removed.values()].reduce((n,m)=>n+m.size,0),transfers}};
}
