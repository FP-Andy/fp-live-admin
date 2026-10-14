import {classifyUniform} from './colors.mjs';

export const REFINEMENT_VERSION='substitution-refinement/v2';
export const side=group=>group?.startsWith('home')?'home':group?.startsWith('away')?'away':null;
export const lower=(rows,t)=>{let a=0,b=rows.length;while(a<b){const m=(a+b)>>1;if(rows[m].t<t)a=m+1;else b=m;}return a;};
export const area=b=>Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
export const intersection=(a,b)=>Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
export const iou=(a,b)=>intersection(a,b)/Math.max(1e-9,area(a)+area(b)-intersection(a,b));
export const nearest=(rows,t)=>{const i=lower(rows,t);return [rows[i-1],rows[i]].filter(Boolean).sort((a,b)=>Math.abs(a.t-t)-Math.abs(b.t-t))[0];};
export function courtDistance(snapshot){
 const court=snapshot.heatmap?.court||{};
 const length=Number(court.lengthM)||40,width=Number(court.widthM)||20;
 return (a,b)=>Math.hypot(length*(a[0]-b[0]),width*(a[1]-b[1]));
}

/** Split only sustained kit switches. The source observations and raw IDs stay
 * unchanged; segment IDs exist only in the derived association graph. */
export function refineEvidence(ev,snapshot,{split=true,quality=true}={}){
 const distance=courtDistance(snapshot),cache=new WeakMap(),excluded=new Map(),splits=[];
 const team=o=>{if(excluded.has(`${o.b.id}:${o.t.toFixed(6)}`))return null;if(!cache.has(o)){const c=classifyUniform(o.b.appearance,snapshot.review?.uniforms||{});const h=c.scores.home||0,a=c.scores.away||0,mixed=Math.min(h,a)>=.06&&Math.min(h,a)>=Math.max(h,a)*.3;cache.set(o,!mixed&&c.margin>.45?side(c.group):null);}return cache.get(o);};
 const frames=new Map();
 if(quality)for(const p of ev.paths.values())for(const o of p.list){const k=o.t.toFixed(6),rows=frames.get(k)||[];if(!rows.some(q=>q.b.id===o.b.id))rows.push(o);frames.set(k,rows);}
 // Only exclude a large box if two spatially distinct opposing bodies are
 // independently visible inside it. Size alone is not evidence of a collision.
 if(quality)for(const rows of frames.values())for(const o of rows){
  const a=area(o.b.box);if(!a)continue;
  const inside=rows.filter(q=>q.b.id!==o.b.id&&q.b.confidence>=.15&&area(q.b.box)<a*.75&&area(q.b.box)>a*.12&&intersection(o.b.box,q.b.box)/area(q.b.box)>.75);
  const collision=inside.some((q,i)=>inside.slice(i+1).some(r=>team(q)&&team(r)&&team(q)!==team(r)&&iou(q.b.box,r.b.box)<.15));
  if(collision)excluded.set(`${o.b.id}:${o.t.toFixed(6)}`,'merged-people');
 }
 // Close, distinct bodies contaminate shirt samples even when the detector
 // emits no enclosing third box. Duplicate boxes on one body are exempt.
 if(quality)for(const rows of frames.values())for(const o of rows){
  const box=o.b.box,center=(box[0]+box[2])/2;
  if(rows.some(q=>q.b.id!==o.b.id&&q.b.confidence>=.15&&iou(box,q.b.box)<.8&&
   intersection(box,q.b.box)/Math.max(1e-9,Math.min(area(box),area(q.b.box)))>.3&&
   intersection(box,q.b.box)/Math.max(1e-9,Math.min(area(box),area(q.b.box)))<.85&&
   Math.abs(center-(q.b.box[0]+q.b.box[2])/2)>.25*Math.min(box[2]-box[0],q.b.box[2]-q.b.box[0])))
   excluded.set(`${o.b.id}:${o.t.toFixed(6)}`,'contact-overlap');
 }
 // A collision may leave only a single enlarged box. Quarantine a sudden
 // expansion in BOTH dimensions relative to this track's recent body boxes.
 // Identity can continue across it; the enlarged foot coordinate is not measured.
 if(quality)for(const p of ev.paths.values()){
  let history=[],reference=null;
  for(const o of p.list){
   const box=o.b.box,w=box[2]-box[0],h=box[3]-box[1],key=`${o.b.id}:${o.t.toFixed(6)}`;
   history=history.filter(q=>o.t-q.t<=3);
   if(history.length>=4){
    const values=history.map(q=>q.w*q.h).sort((a,b)=>a-b),referenceArea=values[Math.floor(values.length/2)];
    const scores=classifyUniform(o.b.appearance,snapshot.review?.uniforms||{}).scores;
    const home=scores.home||0,away=scores.away||0;
    if(Math.min(home,away)>=.06&&Math.min(home,away)>=Math.max(home,away)*.3&&w*h>referenceArea*1.3)
     excluded.set(key,excluded.get(key)||'mixed-kit-contact');
   }
   if(!reference&&history.length>=4){
    const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
    const rw=median(history.map(q=>q.w)),rh=median(history.map(q=>q.h));
    if(w>rw*1.5&&h>rh*1.5&&w*h>rw*rh*3)reference={w:rw,h:rh};
   }
   if(reference){
    if(w*h<reference.w*reference.h*1.8&&w<reference.w*1.5&&h<reference.h*1.5){reference=null;history=[];}
    else excluded.set(key,excluded.get(key)||'geometry-jump');
   }
   if(!excluded.has(key)&&o.b.confidence>=.35)history.push({t:o.t,w,h});
  }
 }
 const paths=new Map(),segmentsByTrack=new Map();
 for(const original of ev.paths.values()){
  const cuts=[0];let current=null,support=0,pending=null;
  for(let i=0;i<original.list.length;i++){
   const o=original.list[i],previous=original.list[i-1];
   // A reused tracker ID after missing frames is a fresh segment. Geometry,
   // reciprocal matching and human ownership must reconnect it explicitly.
   if(previous&&o.t-previous.t>Math.max(.75,ev.step*3)){
    cuts.push(i);splits.push({pathId:original.id,time:o.t,reason:'observation-gap'});
    current=null;support=0;pending=null;
   }
   if(!split)continue;
   const label=team(o),dt=Math.min(o.dt,.25);
   if(pending&&o.t-pending.last>1)pending=null;
   if(!label)continue;
   if(!current){current=label;support=dt;continue;}
   if(label===current){support+=dt;pending=null;continue;}
   if(!pending||pending.team!==label||o.t-pending.first>2)pending={team:label,index:i,first:o.t,last:o.t,seconds:0};
   pending.last=o.t;pending.seconds+=dt;
   if(pending.seconds>=.8-1e-7&&support>=.6){
    cuts.push(pending.index);splits.push({pathId:original.id,time:pending.first,from:current,to:label,reason:'opposite-kit'});
    current=label;support=pending.seconds;pending=null;
   }
  }
  cuts.push(original.list.length);
  for(let i=0;i<cuts.length-1;i++){
   const list=original.list.slice(cuts[i],cuts[i+1]);if(!list.length)continue;
   const p={...original,id:cuts.length===2?original.id:`${original.id}@${list[0].t.toFixed(6)}`,originalPathId:original.id,list};
   paths.set(p.id,p);
   for(const id of p.ids){const rows=segmentsByTrack.get(id)||[];rows.push(p);segmentsByTrack.set(id,rows);}
  }
 }
 const pathAt=(id,t)=>{const rows=segmentsByTrack.get(id)||[];return rows.find(p=>p.list[0].t-ev.step*.6<=t&&p.list.at(-1).t+ev.step*.6>=t);};
 const pathOf=new Map([...segmentsByTrack].map(([id,rows])=>[id,rows[0]]));
 return {...ev,paths,pathOf,pathAt,segmentsByTrack,team,distance,excluded,splits,
  crossings:ev.crossings.map(c=>({...c,pathId:pathAt(c.trackId,c.time)?.id??c.pathId})),
  qualityReason:o=>excluded.get(`${o.b.id}:${o.t.toFixed(6)}`)};
}

/** A second tracker ID can start long before the first one disappears.
 * Require repeated same-body overlap and reject people seen apart earlier. */
export function addOverlapLinks(ev,snapshot,base){
 const distance=ev.distance||courtDistance(snapshot),team=ev.team||(o=>{const c=classifyUniform(o.b.appearance,snapshot.review?.uniforms||{});return c.margin>.45?side(c.group):null;});
 const paths=[...ev.paths.values()].filter(p=>p.list.length>=4),starts=paths.map(p=>({p,t:p.list[0].t})).sort((a,b)=>a.t-b.t),ends=paths.map(p=>({p,t:p.list.at(-1).t})).sort((a,b)=>a.t-b.t);
 const candidates=[];let cursor=0,active=[];
 for(const {p:a,t} of ends){
  while(cursor<starts.length&&starts[cursor].t<t+.001)active.push(starts[cursor++].p);
  active=active.filter(p=>p.list.at(-1).t>t+.4);
  for(const b of active){
   if(a.id===b.id||base.next.has(a.id))continue;
   const from=Math.max(a.list[0].t,b.list[0].t);let count=0,close=0,contained=0,error=0,opposing=0,first=null,last=null,bodyFirst=null,bodyLast=null,sampled=-Infinity;
   for(let i=lower(a.list,Math.max(from,t-3));i<a.list.length;i++){
    const q=a.list[i];if(q.t-sampled<.05)continue;sampled=q.t;
    const r=nearest(b.list,q.t);if(!r||Math.abs(r.t-q.t)>ev.step*.6)continue;
    if(ev.qualityReason?.(q)||ev.qualityReason?.(r))continue;
    count++;const d=distance(q.xy,r.xy),at=team(q),bt=team(r);
    if(at&&bt&&at!==bt)opposing++;
    if(d<.65&&iou(q.b.box,r.b.box)>.35){close++;error+=d;first??=q.t;last=q.t;}
    const ab=q.b.box,bb=r.b.box,ratio=area(bb)/area(ab);
    if(ratio>.18&&ratio<.7&&intersection(ab,bb)/area(bb)>.65&&Math.abs(ab[3]-bb[3])<.4*(ab[3]-ab[1])&&at&&at===bt){contained++;bodyFirst??=q.t;bodyLast=q.t;}
   }
   const shadow=contained>=4&&contained/count>.8&&bodyLast-bodyFirst>=.18&&t-bodyLast<.2;
   if((!shadow&&(close<4||close/count<.8||last-first<.5||t-last>.3))||opposing/count>.2)continue;
   let separate=0;sampled=-Infinity;
   for(let i=lower(a.list,from);i<a.list.length;i++){
    const q=a.list[i];if(q.t-sampled<.4)continue;sampled=q.t;
    const r=nearest(b.list,q.t);
    if(r&&Math.abs(r.t-q.t)<=ev.step*.6&&distance(q.xy,r.xy)>1.5&&++separate>=3)break;
   }
   if(separate>=3)continue;
   candidates.push({a:a.id,b:b.id,gap:0,error:close?error/close:0,overlapSamples:shadow?contained:close,score:shadow?.3:error/close,at:t,bt:t,method:shadow?'shadow-contained-body':'sustained-overlap'});
  }
 }
 const incoming=new Map(),outgoing=new Map();
 for(const e of candidates)for(const [map,key]of [[incoming,e.b],[outgoing,e.a]]){const rows=map.get(key)||[];rows.push(e);map.set(key,rows);}
 const best=rows=>{rows?.sort((a,b)=>a.score-b.score);return rows?.length&&(!rows[1]||rows[1].score-rows[0].score>.25&&rows[1].score>2*rows[0].score)?rows[0]:null;};
 for(const e of candidates)if(best(incoming.get(e.b))===e&&best(outgoing.get(e.a))===e&&!base.links.some(q=>q.b===e.b)){
  base.next.set(e.a,e);base.links.push(e);
 }
 return {...base,overlapCandidates:candidates.length};
}

/** Low-confidence detections must be bracketed by nearby good observations.
 * This recovers measured boxes, never predictions or interpolated positions. */
export function weakObservationSupported(path,index,ev,expectedTeam){
 const o=path.list[index];if(o.b.confidence<.1||ev.qualityReason?.(o))return false;
 const label=ev.team(o);if(label&&label!==expectedTeam)return false;
 const good=q=>q.b.confidence>=.35&&!ev.qualityReason?.(q)&&ev.team(q)===expectedTeam;
 let a,b;
 for(let j=index-1;j>=0&&o.t-path.list[j].t<=.65;j--)if(good(path.list[j])){a=path.list[j];break;}
 for(let j=index+1;j<path.list.length&&path.list[j].t-o.t<=.65;j++)if(good(path.list[j])){b=path.list[j];break;}
 if(!a||!b||b.t-a.t>1)return false;
 const mix=(o.t-a.t)/(b.t-a.t),xy=a.xy.map((v,i)=>v+(b.xy[i]-v)*mix);
 return ev.distance(xy,o.xy)<=.6&&ev.distance(a.xy,b.xy)/(b.t-a.t)<=10;
}
