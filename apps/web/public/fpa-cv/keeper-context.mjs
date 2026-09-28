import {classifyUniform,colorDistance} from './colors.mjs';
import {courtProjection} from './court-projection.mjs';
import {checkpointSegments} from './core.mjs';

const keepers=['home_gk','away_gk'];
const centre=b=>[(b[0]+b[2])/2,b[3]];
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const similarity=(a,b)=>{
  if(!a?.length||!b?.length)return 0;
  const directed=(x,y)=>x.reduce((s,p)=>s+p.weight*Math.max(...y.map(q=>Math.max(0,1-colorDistance(p.rgb,q.rgb)/45)**2)),0)/(x.reduce((s,p)=>s+p.weight,0)||1);
  return (directed(a,b)+directed(b,a))/2;
};
const collision=(a,b)=>{
  const area=x=>(x[2]-x[0])*(x[3]-x[1]);
  return Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]))/Math.min(area(a),area(b))>.25;
};
export function keeperAt(context,id,time){
  return context?.timeline?.get(id)?.find(s=>s.from<=time+1e-7&&time<s.to-1e-7);
}

/** Role evidence is independent of colour. A manually observed keeper seeds
 * a physical path; proximity alone never promotes an attacker to goalkeeper.
 * No box/identity is invented while the keeper is hidden. */
export function buildKeeperContext(data,review,onProgress=()=>{}){
  const context={enabled:false,timeline:new Map(),goals:{}};
  let project;try{project=courtProjection(data.detector.roi);}catch{return context;}
  const step=1/data.detector.sampleFps,people=new Map(review.roster.map(p=>[p.id,p]));
  const anchors=new Map(),first={};
  const manual=[...review.segments.filter(s=>s.personId&&s.source!=='auto'),...checkpointSegments(review)];
  for(const s of manual){
    const group=people.get(s.personId)?.group;if(!group)continue;
    let lo=0,hi=data.frames.length;
    while(lo<hi){const m=(lo+hi)>>1;if(data.frames[m].t<s.from-1e-6)lo=m+1;else hi=m;}
    const frame=data.frames[lo],box=frame?.boxes.find(b=>b.id===s.trackId);
    if(!box||frame.t>=s.to)continue;
    const list=anchors.get(lo)||[];list.push({group,box});anchors.set(lo,list);
    if(keepers.includes(group)&&(!first[group]||frame.t<first[group].time))first[group]={point:project(centre(box.box)),time:frame.t};
  }
  if(keepers.some(g=>!first[g]?.point?.every(Number.isFinite)))return context;
  const a=first.home_gk.point,b=first.away_gk.point,axis=Math.abs(a[0]-b[0])>=Math.abs(a[1]-b[1])?0:1;
  // Calibrate the long axis from the two observed keepers, including rotated
  // cameras. Refuse an implausible setup instead of assuming screen left/right.
  if(Math.abs(a[axis]-b[axis])<.5||Math.min(a[axis],b[axis])>.3||Math.max(a[axis],b[axis])<.7)return context;
  const point=box=>{const p=project(centre(box.box));return p?.every(Number.isFinite)?[p[axis]*40,p[1-axis]*20]:null;};
  for(const group of keepers)context.goals[group]=[first[group].point[axis]<.5?0:40,10];
  context.enabled=true;
  const states=new Map(),history=new Map(),rejected=new Map(keepers.map(g=>[g,new Set()]));
  function append(id,group,time,confidence,reason){
    const list=context.timeline.get(id)||[],last=list.at(-1),to=Math.min(data.video.clipEnd,time+step);
    if(last?.group===group&&last.reason===reason&&Math.abs(last.to-time)<step*.1)last.to=to;
    else list.push({from:time,to,group,confidence,reason});
    context.timeline.set(id,list);
  }
  for(const [index,frame] of data.frames.entries()){
    if(index%128===0)onProgress(index,data.frames.length);
    const time=frame.t,visible=new Map(),manualField=new Set(),reserved=new Set();
    for(const box of frame.boxes){
      const pos=point(box);if(!pos)continue;
      const samples=history.get(box.id)||[];samples.push({time,pos});
      while(samples.length&&time-samples[0].time>2)samples.shift();history.set(box.id,samples);
      visible.set(box.id,{box,pos});
    }
    for(const anchor of anchors.get(index)||[]){
      const item=visible.get(anchor.box.id);if(!item)continue;
      if(!keepers.includes(anchor.group)){manualField.add(anchor.box.id);continue;}
      rejected.get(anchor.group).delete(anchor.box.id);
      states.set(anchor.group,{id:anchor.box.id,pos:item.pos,time,profile:anchor.box.appearance});
      // Explicit later keeper observations can also establish a change of ends.
      if(Math.abs(item.pos[0]-context.goals[anchor.group][0])>30&&(item.pos[0]<8||item.pos[0]>32))context.goals[anchor.group]=[item.pos[0]<20?0:40,10];
      append(anchor.box.id,anchor.group,time,1,'manual');reserved.add(anchor.box.id);
    }
    for(const group of keepers){
      const state=states.get(group);if(!state)continue;
      if(manualField.has(state.id)){rejected.get(group).add(state.id);state.id=null;}
      const current=visible.get(state.id),gap=time-state.time;
      if(reserved.has(state.id))continue;
      const otherField=group==='home_gk'?'away':'home';
      if(current&&!manualField.has(state.id)&&gap<=1&&distance(current.pos,state.pos)<=Math.min(5,.8+6*gap)){
        const kit=classifyUniform(current.box.appearance,review.uniforms);
        const contrary=kit.group===otherField&&kit.strength>.22&&kit.margin>.5;
        state.conflictSince=contrary?(state.conflictSince??time):null;
        const crowded=frame.boxes.some(b=>b.id!==state.id&&collision(current.box.box,b.box));
        if(state.conflictSince===null||time-state.conflictSince<.6){
          append(state.id,group,time,.95,'continuity');reserved.add(state.id);
          state.pos=current.pos;state.time=time;
          if(!crowded&&!contrary)state.profile=current.box.appearance;
          continue;
        }
      }
      const candidates=[];
      for(const [id,item] of visible){
        if(reserved.has(id)||manualField.has(id)||rejected.get(group).has(id)||item.box.confidence<.35)continue;
        if(frame.boxes.some(b=>b.id!==id&&collision(item.box.box,b.box)))continue;
        const samples=history.get(id),span=time-samples[0].time;
        if(samples.length<3||span<.15)continue;
        const kit=classifyUniform(item.box.appearance,review.uniforms);
        if(kit.group===otherField&&kit.margin>.5&&kit.strength>.22)continue;
        const appearance=similarity(state.profile,item.box.appearance),goalDistance=distance(item.pos,context.goals[group]);
        const gate=Math.min(5,.8+4*Math.max(0,gap)),moved=distance(item.pos,state.pos);
        const near=gap<=3&&moved<gate&&appearance>=.4;
        const spread=Math.max(...samples.map(s=>distance(s.pos,item.pos)));
        const dwell=span>=1.2&&goalDistance<8&&spread<4&&samples.every(s=>distance(s.pos,context.goals[group])<10);
        const colour=Math.min(1,(kit.scores[group]||0)/.25);
        const score=near?.60*(1-moved/gate)+.30*appearance+.10*colour:dwell&&appearance>=.45?.35*(1-goalDistance/12)+.4*appearance+.15*colour+.1:-1;
        if(score>=.68)candidates.push({id,item,score});
      }
      candidates.sort((a,b)=>b.score-a.score);
      const best=candidates[0];if(!best||best.score-(candidates[1]?.score??0)<.15)continue;
      append(best.id,group,time,best.score,'reacquired');reserved.add(best.id);
      states.set(group,{id:best.id,pos:best.item.pos,time,profile:best.item.box.appearance});
    }
  }
  return context;
}

export function classifyKit(box,time,uniforms,context,appearance=box?.appearance){
  const raw=classifyUniform(appearance,uniforms);
  if(!context?.enabled||!box)return raw;
  const role=keeperAt(context,box.id,time);
  if(role)return {...raw,group:role.group,strength:Math.max(raw.scores[role.group]||0,.25*role.confidence),margin:.8,role:role.reason,contextual:true};
  const ranked=['home','away','referee'].map(g=>[g,raw.scores[g]||0]).sort((a,b)=>b[1]-a[1]);
  const [group,strength]=ranked[0],margin=strength?(strength-ranked[1][1])/strength:0;
  // Distinctive keeper colours without a trusted path stay unassigned. They
  // cannot claim an opposing field number just because a shirt is sunlit.
  const keeperScore=Math.max(...keepers.map(g=>raw.scores[g]||0));
  const ambiguousKeeper=keeperScore>=.1&&keeperScore>strength*1.5;
  return {...raw,group:!ambiguousKeeper&&strength>=.1&&margin>=.28?group:null,strength,margin,role:ambiguousKeeper?'keeper-unresolved':'field',contextual:true};
}
