/** Offline forward linking between track fragments. Reciprocal uniqueness,
 * team consensus, two-sided motion and overlap geometry prevent nearest-only joins.
 * Bounding-box size is a soft cue at short gaps: merged players/shadows change it.
 * This graph does not itself assign identities; entry seeds and occupancy arbitrate.
 */
import {classifyUniform} from './colors.mjs';
import {refineEvidence,addOverlapLinks,weakObservationSupported,courtDistance,nearest,REFINEMENT_VERSION} from './substitution-refinement.mjs';
const side=g=>g?.startsWith('home')?'home':g?.startsWith('away')?'away':null;
const lower=(a,t)=>{let lo=0,hi=a.length;while(lo<hi){let mid=(lo+hi)>>1;if(a[mid].t<t)lo=mid+1;else hi=mid;}return lo;};
const iou=(a,b)=>{const n=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return n/Math.max(1e-9,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-n);};
export function buildContinuationGraph(ev,snapshot){
 const distance=courtDistance(snapshot);
 const nodes=[...ev.paths.values()].filter(p=>p.list.filter(q=>!ev.qualityReason?.(q)).length>=4);
 const ends=nodes.map(p=>({p,t:p.list.at(-1).t})).sort((a,b)=>a.t-b.t),starts=nodes.map(p=>({p,t:p.list[0].t})).sort((a,b)=>a.t-b.t),cache=new Map();
 function endpoint(p,end){const key=p.id+':'+end;if(cache.has(key))return cache.get(key);const a=p.list.filter(q=>!ev.qualityReason?.(q)),o=end?a.at(-1):a[0],near=a.filter(q=>Math.abs(q.t-o.t)<=.7),mt=near.reduce((n,q)=>n+q.t,0)/near.length,mxy=[0,1].map(i=>near.reduce((n,q)=>n+q.xy[i],0)/near.length),den=near.reduce((n,q)=>n+(q.t-mt)**2,0),v=[0,1].map(i=>den?near.reduce((n,q)=>n+(q.t-mt)*(q.xy[i]-mxy[i]),0)/den:0),groups=new Map();for(const q of near){const c=classifyUniform(q.b.appearance,snapshot.review?.uniforms||{}),g=side(c.group);if(g&&c.margin>.45&&c.strength>=.12)groups.set(g,(groups.get(g)||0)+c.strength);}const ranked=[...groups].sort((a,b)=>b[1]-a[1]),team=ranked[0]&&ranked[0][1]>(ranked[1]?.[1]||0)*2?ranked[0][0]:null;const vlen=distance([0,0],v);const result={o,v:vlen>10?v.map(x=>x*10/vlen):v,team};cache.set(key,result);return result;}
 const edges=[];
 for(const a of ends){const ae=endpoint(a.p,true);for(let j=lower(starts,a.t-1.2);j<starts.length&&starts[j].t<=a.t+3.5;j++){const b=starts[j];if(a.p.id===b.p.id||b.p.list.at(-1).t<a.t+.35||a.p.list[0].t>b.t-.35)continue;const be=endpoint(b.p,false),gap=be.o.t-ae.o.t;if(ae.team&&be.team&&ae.team!==be.team)continue;
  const ap=ae.o.xy,bp=be.o.xy;if([ap,bp].some(p=>p[0]<0||p[0]>1||p[1]<0||p[1]>1.03))continue;
  if(Math.max(ap[1],bp[1])>.92&&(Math.abs(ae.v[1])<.012||ae.v[1]*be.v[1]<=0))continue;
  let error,overlapSamples=0;
  if(gap<0){let count=0,close=0,err=0,strong=0;for(const q of a.p.list.filter(q=>q.t>=b.t)){const at=lower(b.p.list,q.t),r=[b.p.list[at-1],b.p.list[at]].filter(Boolean).sort((x,y)=>Math.abs(x.t-q.t)-Math.abs(y.t-q.t))[0];if(!r||Math.abs(r.t-q.t)>ev.step*.6)continue;count++;if(ev.qualityReason?.(q)||ev.qualityReason?.(r))continue;const d=distance(q.xy,r.xy);if(d<.65&&iou(q.b.box,r.b.box)>.65)strong++;if(d<.75&&iou(q.b.box,r.b.box)>.4){close++;err+=d;}}const shortReset=strong>=2&&strong/count>=.9&&distance(ae.v,be.v)<4;if(!shortReset&&(close<3||close/count<.85))continue;error=err/close;overlapSamples=close;
  }else{const af=ap.map((x,i)=>x+ae.v[i]*gap),bb=bp.map((x,i)=>x-be.v[i]*gap),forward=distance(af,bp),backward=distance(bb,ap);error=(forward+backward)/2;const shortReset=gap<=.6&&gap>=0&&ae.team&&ae.team===be.team&&distance(ap,bp)<=1+gap*.7&&error<=2.1&&iou(ae.o.b.box,be.o.b.box)>.05;
   if(!shortReset&&(error>1.05+gap*.45||Math.min(forward,backward)>.8+gap*.3||distance(ap,bp)>1+gap*7))continue;}
  const ab=ae.o.b.box,bb=be.o.b.box,ratio=((bb[2]-bb[0])*(bb[3]-bb[1]))/((ab[2]-ab[0])*(ab[3]-ab[1]));if(ratio<(gap<1?.25:.4)||ratio>(gap<1?4:2.5))continue;
  edges.push({a:a.p.id,b:b.p.id,gap,error,overlapSamples,score:error+.2*Math.max(0,gap)+Math.abs(Math.log(ratio))*.12,at:a.t,bt:b.t});
 }}
 const incoming=new Map(),outgoing=new Map();for(const e of edges)for(const [map,key]of [[incoming,e.b],[outgoing,e.a]]){const list=map.get(key)||[];list.push(e);map.set(key,list);}
 const best=rows=>{rows?.sort((a,b)=>a.score-b.score);return rows?.length&&(!rows[1]||rows[1].score-rows[0].score>.55&&rows[1].score>rows[0].score*1.8)?rows[0]:null;};
 const previous=new Map();for(const e of edges)if(best(incoming.get(e.b))===e&&best(outgoing.get(e.a))===e)previous.set(e.b,e);

 return {next:new Map([...previous.values()].map(e=>[e.a,e])),links:[...previous.values()],candidates:edges.length};
}

/** Continue only observed detections from a known entrant. The source snapshot
 * stays immutable; this function changes a derived report, with an audit trail. */
export function continueSubstitutionReport(snapshot,ev,saved,result,options={}){
 const settings={split:true,overlap:true,quality:true,weak:true,...options};
 ev=refineEvidence(ev,snapshot,settings);
 const h=result.heatmap,players=h.players,seeds=players.filter(p=>p.substitutionStint?.kind==='substitute'&&result.events.some(e=>e.inPersonId===p.id&&e.status!=='review')).map(p=>({p,path:ev.pathAt(p.substitutionStint.entryTrackId,p.activeFrom)||ev.pathOf.get(p.substitutionStint.entryTrackId)})).filter(s=>s.path);
 if(!seeds.length)return {result,changed:new Set()};
 const base=buildContinuationGraph(ev,snapshot),graph=settings.overlap?addOverlapLinks(ev,snapshot,base):base,audit=[],requests=new Map(),owners=new Map();
 const before=new Map(players.map(p=>[p.id,p.observed])),removedQuality=new Map(),manualConflicts=new Map(),changes=new Set();
 // Repair already allocated automatic coordinates as well as new additions.
 // Human observations remain intact and surface as review conflicts.
 for(const {p} of seeds){
  const kept=[];let removed=0,conflicts=0;
  for(const q of p.positions){
   const path=ev.pathAt(q.trackId,q.t),o=path&&nearest(path.list,q.t);
   const sameTime=o&&Math.abs(o.t-q.t)<=ev.step*.6;
   const switched=sameTime&&ev.splits.some(s=>s.pathId===path.originalPathId&&s.time<=q.t)&&ev.team(o)&&ev.team(o)!==p.group;
   if(sameTime&&(ev.qualityReason(o)||switched)){
    if(q.source==='manual'||q.checkpoint){kept.push(q);conflicts++;}
    else removed+=q.seconds;
   }else kept.push(q);
  }
  if(removed){p.positions=kept;p.observed=kept.reduce((n,q)=>n+q.seconds,0);changes.add(p.id);}
  removedQuality.set(p.id,removed);manualConflicts.set(p.id,conflicts);
 }
 for(const p of players)for(const q of p.positions){const a=owners.get(q.trackId)||[];a.push({p,q});owners.set(q.trackId,a);}
 const spans=new Map(players.map(p=>[p.id,p.positions.map(q=>[q.t,q.t+q.seconds])])),additions=new Map(players.map(p=>[p.id,[]])),removals=new Map();
 for(const {p,path:first} of seeds){
  const knownExit=result.events.filter(e=>e.status!=='review'&&e.outPersonId===p.id&&Number.isFinite(e.outTime)).map(e=>e.outTime);
  let until=Math.min(h.to,...knownExit),path=first,links=[],ids=new Set(),nodes=[],rowStop=false;
  for(let n=0;path&&n<80&&!ids.has(path.id);n++){
   const rival=seeds.filter(s=>s.p.id!==p.id&&s.path.id===path.id&&s.p.activeFrom>p.activeFrom+.1).sort((a,b)=>a.p.activeFrom-b.p.activeFrom)[0];
   if(seeds.some(s=>s.p.id!==p.id&&s.path.id===path.id&&s.p.activeFrom<=p.activeFrom+.1)&&path!==first)break;
   if(rival)until=Math.min(until,rival.p.activeFrom);
   const exit=ev.crossings.filter(c=>c.kind==='out'&&c.pathId===path.id&&c.time>p.activeFrom+2&&c.time<until&&(saved.log?.substitutions||[]).some(e=>e.team===p.group&&Math.abs(e.time-c.time)<=12)).sort((a,b)=>a.time-b.time)[0];
   if(exit)until=Math.min(until,exit.time);
   // Raw tracker IDs can themselves switch people during contact. Stop after
   // sustained opposite-kit evidence instead of resuming on a later same-kit box.
   const kitWindow=[];
   for(const o of path.list){if(o.t<p.activeFrom||o.t>=until)continue;
    // Distant shirts occupy a small fraction of a crop. Use the classifier's
    // acceptance floor and sustained votes, not a high pixel share.
    const team=ev.team(o);kitWindow.push({t:o.t,dt:Math.min(o.dt,.25),team});
    while(kitWindow[0]?.t<o.t-2)kitWindow.shift();
    const wrong=kitWindow.filter(v=>v.team&&v.team!==p.group),wrongSeconds=wrong.reduce((n,v)=>n+v.dt,0),rightSeconds=kitWindow.filter(v=>v.team===p.group).reduce((n,v)=>n+v.dt,0);
    if(wrongSeconds>=.8&&wrongSeconds>rightSeconds*3){until=Math.min(until,wrong[0].t);rowStop=true;break;}
   }
   ids.add(path.id);nodes.push(path);
   const edge=graph.next.get(path.id);if(!edge||path.list.at(-1).t>=until||edge.bt>=until)break;
   links.push(edge);path=ev.paths.get(edge.b);
  }
  const splitAt=ev.splits.filter(s=>s.reason!=='observation-gap'&&nodes.some(n=>n.originalPathId===s.pathId));
  const end=nodes.at(-1)?.list.at(-1);
  const row={personId:p.id,number:p.jersey,team:p.group,before:before.get(p.id),added:0,reassigned:0,removed:removedQuality.get(p.id),manualConflicts:manualConflicts.get(p.id),weakSeconds:0,until,links,splitAt,oppositeKitStop:rowStop||!!splitAt.length,stoppedAt:end?.t,...(end?{scene:{time:end.t,trackId:end.b.id,box:[...end.b.box]}}:{})};audit.push(row);
  // Keep a raw ID's disconnected reappearance out unless the graph actually
  // reconnects that segment. A saved human observation always wins.
  const reachable=new Set(nodes.map(n=>n.id)),origins=new Set(nodes.map(n=>n.originalPathId));
  const stale=new Set();
  for(const q of p.positions){const segment=ev.pathAt(q.trackId,q.t);
   if(segment&&origins.has(segment.originalPathId)&&!reachable.has(segment.id)&&q.source!=='manual'&&!q.checkpoint){
    removals.set(q,[[q.t,q.t+q.seconds]]);stale.add(q.t);row.removed+=q.seconds;changes.add(p.id);
   }
  }
  if(stale.size)spans.set(p.id,spans.get(p.id).filter(([t])=>!stale.has(t)));
  for(const path of nodes)for(const [index,o] of path.list.entries()){
   const weak=o.b.confidence<.35;
   const xy=o.heatXY;if(o.t<p.activeFrom||o.t>=until||ev.qualityReason(o)||weak&&(!settings.weak||!weakObservationSupported(path,index,ev,p.group))||!xy||xy.some(v=>v<0||v>1))continue;
   const label=ev.team(o);if(label&&label!==p.group)continue;
   const q={t:o.t,x:xy[0],y:xy[1],seconds:Math.min(o.dt,until-o.t),trackId:o.b.id,source:'automatic',recoveryReason:weak?'bracketed-detection':'track-continuation'};
   // Existing observations of this person win; do not replace a full stint with
   // a shorter path or count two detectors at the same instant.
   if(spans.get(p.id).some(([a,z])=>a<q.t+q.seconds-1e-7&&z>q.t+1e-7))continue;
   const key=q.t.toFixed(6)+':'+q.trackId,list=requests.get(key)||[];if(!list.some(v=>v.p===p))list.push({p,q,row});requests.set(key,list);
  }
 }
 for(const list of requests.values()){
  if(list.length!==1)continue;const {p,q,row}=list[0];if(spans.get(p.id).some(([a,z])=>a<q.t+q.seconds-1e-7&&z>q.t+1e-7))continue;const conflicts=(owners.get(q.trackId)||[]).filter(v=>v.q.t<q.t+q.seconds-1e-7&&v.q.t+v.q.seconds>q.t+1e-7);
  if(conflicts.some(v=>v.p.id!==p.id&&(v.q.source==='manual'||v.q.checkpoint||v.p.group!==p.group||v.p.substitutionStint?.kind==='substitute')))continue;
  // Restore a reset track from a recycled starter slot only after a reciprocal
  // geometric link. Other independently seeded substitutes are never stolen.
  for(const v of conflicts){if(v.p.id===p.id)continue;const cuts=removals.get(v.q)||[];cuts.push([q.t,q.t+q.seconds]);removals.set(v.q,cuts);changes.add(v.p.id);row.reassigned+=Math.max(0,Math.min(v.q.t+v.q.seconds,q.t+q.seconds)-Math.max(v.q.t,q.t));}
  additions.get(p.id).push(q);spans.get(p.id).push([q.t,q.t+q.seconds]);changes.add(p.id);row.added+=q.seconds;if(q.recoveryReason==='bracketed-detection')row.weakSeconds+=q.seconds;
 }
 for(const p of players){if(!changes.has(p.id))continue;
  const kept=p.positions.flatMap(q=>{let parts=[q];for(const [a,z]of removals.get(q)||[]){parts=parts.flatMap(v=>{const lo=Math.max(a,v.t),hi=Math.min(z,v.t+v.seconds);if(hi<=lo)return[v];return [...(lo>v.t+1e-8?[{...v,seconds:lo-v.t}]:[]),...(hi<v.t+v.seconds-1e-8?[{...v,t:hi,seconds:v.t+v.seconds-hi}]:[])];});}return parts;});
  const oldLast=p.positions.at(-1)?.t+(p.positions.at(-1)?.seconds||0);p.positions=[...kept,...additions.get(p.id)].sort((a,b)=>a.t-b.t);
  p.observed=p.positions.reduce((n,q)=>n+q.seconds,0);p.coverage=p.observed/(h.to-h.from);
  if(additions.get(p.id).length){const last=p.positions.at(-1).t+p.positions.at(-1).seconds;p.activeTo=Math.max(p.activeTo,last);p.substitutionStint.to=p.activeTo;p.blockedIntervals=(p.blockedIntervals||[]).filter(b=>!(b.reason==='inactive'&&b.from>=oldLast-.2));
   p.inactiveIntervals=[{from:h.from,to:p.activeFrom,reason:'substitution'},{from:p.activeTo,to:h.to,reason:'inactive'}].filter(b=>b.to>b.from);
   if(last<p.activeTo-.1)p.blockedIntervals.push({from:last,to:p.activeTo,reason:'inactive'});
  }
  p.grid=Array(h.width*h.height).fill(0);for(const q of p.positions)p.grid[Math.min(h.height-1,Math.floor(q.y*h.height))*h.width+Math.min(h.width-1,Math.floor(q.x*h.width))]+=q.seconds;
 }
 result.continuation={algorithm:REFINEMENT_VERSION,settings,splits:ev.splits,excludedBoxes:ev.excluded.size,audit:audit.map(a=>{
  const p=players.find(p=>p.id===a.personId),last=p.positions.at(-1);
  const path=last&&ev.pathAt(last.trackId,last.t),o=path&&nearest(path.list,last.t);
  return {...a,after:p.observed,lastObservedAt:last?last.t+last.seconds:null,scene:o?{time:last.t,trackId:last.trackId,box:[...o.b.box]}:undefined};
 })};
 for(const row of result.continuation.audit){
  const event=result.events.find(e=>e.inPersonId===row.personId);
  if(event&&row.manualConflicts){event.status='review';event.reason='수동 연결과 유니폼·박스 근거가 충돌하는 장면이 있습니다. 수동 관측은 보존했습니다. 추적 복구 결과에서 확인하세요.';result.status='review';h.substitutionsApplied=false;}
 }
 return {result,changed:changes};
}
