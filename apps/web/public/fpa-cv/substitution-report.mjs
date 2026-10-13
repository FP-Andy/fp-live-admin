import {substitutionEvidence} from './substitution-evidence.mjs';
import {mergeSubstitutionRedetection} from './substitution-redetection.mjs';
import {courtProjection} from './court-projection.mjs';
import {classifyUniform} from './colors.mjs';
import {augmentPlayerActivity} from './heatmap-augmentation.mjs';
import {validateHeatmapAugmentation} from './heatmap-augmentation-schema.mjs';
import {heatmapDensityScale} from './heatmap-render.mjs';
import {validateSubstitutionLog} from '../fla-video/substitution-log.mjs';

export const SUBSTITUTION_REPORT_VERSION='substitution-report/v5';
const fail=message=>{throw Error(message);};
const side=group=>group?.startsWith('home')?'home':group?.startsWith('away')?'away':null;
const sum=values=>values.reduce((a,b)=>a+b,0);
const clip=(positions,from,to)=>positions.flatMap(p=>{const a=Math.max(from,p.t),z=Math.min(to,p.t+p.seconds);return z>a+1e-8?[{...p,t:a,seconds:z-a}]:[];});
const newId=e=>'sub-'+e.id;

/** A derived report, never a mutation of the operator's immutable snapshot.
 * Boundary evidence is in camera coordinates, heat is in the saved pitch turn.
 * Unresolved crossings block export; nearest time alone never assigns identity.
 */
export function deriveSubstitutionReport(snapshot,data,saved,progress=()=>{},recovery=null){
 const originalData=data;
 if(recovery)data=mergeSubstitutionRedetection(snapshot,data,saved,recovery);
 const original=snapshot.heatmap,log=saved.log?validateSubstitutionLog(saved.log):null;
 if(!original||data.datasetId!==original.datasetId)fail('스냅샷과 추적 데이터가 다른 분석입니다.');
 if(log?.substitutions?.length&&(log.video.name!==data.video.name||Math.abs(log.video.duration-data.video.duration)>.2))fail('교체로그와 분석 영상이 다릅니다.');
 const events=log?.substitutions||[],provenance={algorithm:SUBSTITUTION_REPORT_VERSION,snapshotId:snapshot.id,jobId:snapshot.jobId,logRevision:saved.revision,matchId:snapshot.matchId,...(data.substitutionRecovery?{redetectionId:data.substitutionRecovery.id,redetection:data.substitutionRecovery}:{} )};
 if(!events.length)return {provenance,status:'ready',events:[],heatmap:structuredClone(original)};
 if(events.some(e=>e.time<original.from||e.time>=original.to))fail('분석 구간 밖 교체가 있습니다. 해당 구간을 포함한 스냅샷을 선택하세요.');
 const project=courtProjection(data.detector.roi,original.turn||0),evidence=substitutionEvidence(snapshot,data,events),{paths,pathOf,crossings}=evidence;
 if(recovery){
  // A supplemental crop must not remove an existing candidate. Keep both
  // evidence sets for the operator, projected onto the same path namespace.
  const baseline=substitutionEvidence(snapshot,originalData,events);
  for(const c of crossings)c.origin='redetection';
  for(const c of baseline.crossings){
   const p=pathOf.get(c.trackId);if(!p)continue;
   const i=crossings.findIndex(q=>q.kind===c.kind&&q.trackId===c.trackId&&Math.abs(q.time-c.time)<2);
   const preserved={...c,pathId:p.id,pathIds:p.ids,origin:'original'};
   if(i>=0)crossings[i]=preserved;else crossings.push(preserved);
  }
 }
 const stints=original.players.map(p=>({id:p.id,sourceId:p.id,group:p.group,jersey:p.jersey,from:original.from,to:original.to,kind:'starter'}));
 const used=new Set(),results=[],nextNumber={home:1,away:1};
 for(const p of snapshot.review?.roster||original.players){const n=Number(p.jersey);if(side(p.group)&&Number.isInteger(n))nextNumber[side(p.group)]=Math.max(nextNumber[side(p.group)],n+1);}
 const key=c=>c.kind+':'+c.pathId+':'+c.time;
 const activeOut=(c,team)=>{const eligible=stints.filter(s=>s.group===team&&s.from<c.time&&s.to>=c.time);const exact=eligible.filter(s=>s.entryPathId===c.pathId);if(exact.length===1)return exact[0];const source=eligible.filter(s=>c.ownerCertain&&s.sourceId===c.sourceId);return source.length===1?source[0]:null;};
 const incomingSource=(n,departed)=>{
  const votes=evidence.votes(n.pathIds,n.time,-.1,20),spatial=!evidence.certain(votes)?evidence.spatialOwner(paths.get(n.pathId),n.time,'in'):null;if(!evidence.certain(votes)&&!spatial)return null;
  const id=evidence.certain(votes)?votes[0][0]:spatial.id;if(!departed.some(s=>s.sourceId===id))return null;
  const list=clip(original.players.find(p=>p.id===id)?.positions||[],n.time,Math.min(original.to,n.time+20));
  const onPath=sum(list.filter(q=>n.pathIds.includes(q.trackId)).map(q=>q.seconds));
  return spatial||onPath>=Math.min(.4,(original.to-n.time)*.5)?id:null;
 };
 const groups=[];for(const team of ['home','away'])for(const e of events.filter(e=>e.team===team).sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id))){const last=groups.at(-1);if(last&&last[0].team===team&&e.time-last.at(-1).time<=6)last.push(e);else groups.push([e]);}groups.sort((a,b)=>a[0].time-b[0].time);
 const completeMatch=(edges,count)=>{const answers=[];let visits=0,overflow=false;const visit=(i,picked)=>{if(++visits>50000){overflow=true;return;}if(answers.length>1||overflow)return;if(picked.length===count){answers.push(picked);return;}for(let j=i;j<edges.length;j++){const e=edges[j];if(picked.some(p=>p.s.id===e.s.id||p.n.pathId===e.n.pathId||p.o.pathId===e.o.pathId))continue;visit(j+1,[...picked,e]);}};visit(0,[]);return !overflow&&answers.length===1?answers[0]:null;};
 for(const [i,batch]of groups.entries()){
  progress({phase:'교체 출입·번호 연결',completed:i,total:groups.length});
  const team=batch[0].team,candidates=crossings.filter(c=>batch.some(e=>Math.abs(c.time-e.time)<=12)&&(!c.team||c.team===team)&&!used.has(key(c)));
  const outs=candidates.filter(c=>c.kind==='out').map(c=>{const s=activeOut(c,team);return {...c,...(s?{resolvedPersonId:s.id,resolvedNumber:s.jersey}:{})};}),ins=candidates.filter(c=>c.kind==='in'),options=stints.filter(s=>s.group===team&&s.from<batch.at(-1).time+12&&s.to>batch[0].time-12).map(s=>({id:s.id,number:s.jersey}));
  const pending=[],selected=[];
  for(const e of batch){const decision=e.tracking;
   if(decision){const o=outs.find(c=>c.trackId===decision.outTrackId&&(decision.outTime===undefined||Math.abs(c.time-decision.outTime)<.001)),n=ins.find(c=>c.trackId===decision.inTrackId&&(decision.inTime===undefined||Math.abs(c.time-decision.inTime)<.001)),s=stints.find(s=>s.id===decision.outPersonId&&s.group===team&&s.from<(o?.time??0)&&s.to>=(o?.time??Infinity));
    if(decision.snapshotId===snapshot.id&&(!decision.redetectionId||decision.redetectionId===recovery?.id)&&o&&n&&s&&o.pathId!==n.pathId&&!selected.some(p=>p.s===s||p.n.pathId===n.pathId||p.o.pathId===o.pathId))selected.push({e,o,n,s,manual:true});
    else results.push({id:e.id,team,time:e.time,status:'review',reason:'저장된 연결의 출입 근거가 변경되었습니다.',outs,ins,people:options});
   }else pending.push(e);
  }
  const validOut=outs.filter(o=>!(recovery?.reviewOnly&&o.origin==='redetection')&&!o.returning&&!o.colorConflict&&activeOut(o,team)&&!selected.some(p=>p.o.pathId===o.pathId)),validIn=ins.filter(n=>!(recovery?.reviewOnly&&n.origin==='redetection')&&!n.returning&&!n.colorConflict&&n.team===team&&!selected.some(p=>p.n.pathId===n.pathId));
  const edges=[];for(const o of validOut)for(const n of validIn){const s=activeOut(o,team);if(o.pathId===n.pathId)continue;const source=incomingSource(n,[s]);if(source||(validOut.length===1&&validIn.length===1&&!n.sourceId))edges.push({o,n,s});}
  let chosen=pending.length?completeMatch(edges,pending.length):[];
  let groupOnly=false;
  // Simultaneous substitutions identify a set of outgoing players and a set
  // of arrivals. They do not establish who replaced whom. Keep that distinction
  // in the report and resolve each entrant's trajectory independently.
  if(!chosen&&pending.length>1&&validOut.length===pending.length&&validIn.length===pending.length&&new Set(validOut.map(o=>activeOut(o,team).id)).size===pending.length&&new Set(validIn.map(n=>n.pathId)).size===pending.length&&validIn.every(n=>!validOut.some(o=>o.pathId===n.pathId)&&(!n.sourceId||validOut.some(o=>activeOut(o,team).sourceId===n.sourceId)))){
   const oo=[...validOut].sort((a,b)=>a.time-b.time||a.trackId-b.trackId),nn=[...validIn].sort((a,b)=>a.time-b.time||a.trackId-b.trackId);chosen=oo.map((o,j)=>({o,n:nn[j],s:activeOut(o,team)}));groupOnly=true;
  }
  if(chosen){chosen.sort((a,b)=>(a.o.time+a.n.time)-(b.o.time+b.n.time)||a.n.trackId-b.n.trackId);chosen.forEach((p,j)=>selected.push({...p,e:pending[j],groupOnly}));}
  else {
   const reason=!outs.length&&!ins.length?'로그 전후 12초에서 경기장 하단의 출입 경로를 찾지 못했습니다. 영상 시각을 확인하세요.'
    :!outs.length?'입장 후보는 있으나 퇴장 경로가 없습니다. 나간 선수의 장면을 확인하세요.'
    :!ins.length?'퇴장 후보는 있으나 입장 경로가 없습니다. 들어온 선수의 장면을 확인하세요.'
    :recovery?.reviewOnly&&[...outs,...ins].some(c=>c.origin==='redetection'&&!c.returning&&!c.colorConflict)?'재탐지로 출입 후보를 찾았습니다. 나간 사람과 들어온 사람이 맞는지 확인하면 출전 구간을 분리합니다.'
    :!validOut.length?'퇴장 후보의 기존 기록을 자동으로 찾지 못했습니다. 출입 장면과 기존 추적 연결을 확인하세요.'
    :!validIn.length?'입장 후보의 팀 또는 재진입 여부가 불확실합니다. 들어온 선수의 장면을 확인하세요.'
    :pending.length>1&&(validOut.length<pending.length||validIn.length<pending.length)?`동시 교체 ${pending.length}건 중 퇴장 ${validOut.length}개·입장 ${validIn.length}개 경로를 확인했습니다. 부족한 출입을 확인하세요.`
    :!edges.length?'퇴장 분석번호와 입장 후 번호의 연결 근거가 일치하지 않습니다. 두 장면을 비교하세요.'
    :'가능한 연결이 여러 개입니다. 퇴장 번호와 입장 객체를 함께 확인하세요.';
   for(const e of pending)results.push({id:e.id,team,time:e.time,status:'review',reason,outs,ins,people:options});
  }
  const departed=selected.map(p=>p.s),batchOutNumbers=departed.map(s=>s.jersey);
  for(const {e,o,n,s,manual,groupOnly:batchPair}of selected){
   const sourceId=incomingSource(n,batchPair?departed:[s]);
   s.to=Math.min(s.to,o.time);const entrant={id:newId(e),sourceId,group:team,jersey:String(nextNumber[team]++),from:n.time,to:original.to,kind:'substitute',entryTrackId:n.trackId,entryPathId:n.pathId,eventId:e.id,manual:!!manual};stints.push(entrant);
   used.add(key(o));used.add(key(n));results.push({id:e.id,team,time:e.time,status:manual?'confirmed':'automatic',connectionConfirmed:!!manual,outPersonId:s.id,inPersonId:entrant.id,outNumber:s.jersey,inNumber:entrant.jersey,outTime:o.time,inTime:n.time,outTrackId:o.trackId,inTrackId:n.trackId,entryBox:n.box,outs,ins,people:options,...(batchPair?{pairing:'batch',batchId:batch[0].id,batchOutNumbers}:{}),evidence:{out:o.evidence,in:n.evidence,joinedTracks:n.pathIds.length}});
  }
 }
 const resultFor=s=>results.find(r=>r.inPersonId===s.id);
 const markReview=(s,reason)=>{const r=resultFor(s);if(r){r.status='review';r.reason=reason;}};
 const allocations=new Map(stints.map(s=>[s.id,[]]));
 // Allocate each saved observation once, then add only genuinely unassigned
 // detector observations. A new track must never duplicate an active player's heat.
 for(const base of original.players)for(const q of base.positions){
  const eligible=stints.filter(s=>(s.sourceId===base.id||s.manual&&s.entryPathId===pathOf.get(q.trackId)?.id)&&s.from<q.t+q.seconds&&s.to>q.t);
  const boundaries=[...new Set([q.t,q.t+q.seconds,...eligible.flatMap(s=>[Math.max(q.t,s.from),Math.min(q.t+q.seconds,s.to)])])].sort((a,b)=>a-b);
  for(let j=0;j<boundaries.length-1;j++){const a=boundaries[j],z=boundaries[j+1];if(z-a<1e-8)continue;const possible=eligible.filter(s=>s.from<=a&&s.to>=z),exact=possible.find(s=>s.manual&&s.entryPathId===pathOf.get(q.trackId)?.id)||possible.find(s=>s.entryPathId===pathOf.get(q.trackId)?.id),chosen=exact||possible.sort((a,b)=>b.from-a.from)[0];if(chosen)allocations.get(chosen.id).push({...q,t:a,seconds:z-a});}
 }
 const occupied=new Map();for(const [id,list]of allocations)for(const q of list){const a=occupied.get(q.trackId)||[];a.push({...q,id});occupied.set(q.trackId,a);}for(const list of occupied.values())list.sort((a,b)=>a.t-b.t);
 const raw=new Map();for(const s of stints.filter(s=>!s.sourceId)){
  for(const q of paths.get(s.entryPathId)?.list||[]){if(q.t<s.from||q.t>=s.to||q.b.confidence<.35)continue;const box=q.b.box,xy=project([(box[0]+box[2])/2,original.point==='center'?(box[1]+box[3])/2:box[3]]),color=classifyUniform(q.b.appearance,snapshot.review?.uniforms||{});
   if(!xy||xy.some(n=>n<0||n>1)||(side(color.group)&&side(color.group)!==s.group&&color.strength>.3))continue;
   const seconds=Math.min(q.dt,s.to-q.t),conflict=(paths.get(s.entryPathId)?.ids||[q.b.id]).some(id=>(occupied.get(id)||[]).some(p=>p.t<q.t+seconds-1e-7&&p.t+p.seconds>q.t+1e-7));
   if((paths.get(s.entryPathId)?.ids||[q.b.id]).some(id=>(occupied.get(id)||[]).some(p=>p.id===s.id&&p.t<q.t+seconds-1e-7&&p.t+p.seconds>q.t+1e-7)))continue;
   if(conflict){markReview(s,'입장 트랙이 다른 출전 선수의 관측과 겹칩니다. 기존 관측은 보존하고 이 연결을 확인하세요.');continue;}
   const k=q.t.toFixed(6)+':'+q.b.id,a=raw.get(k)||[];a.push({s,q:{t:q.t,x:xy[0],y:xy[1],seconds,trackId:q.b.id,source:'automatic'}});raw.set(k,a);
  }
 }
 for(const a of raw.values()){if(a.length===1)allocations.get(a[0].s.id).push(a[0].q);else for(const {s}of a)markReview(s,'동일 입장 경로를 두 출전 구간이 요청했습니다. 교체 연결을 확인하세요.');}
 const players=stints.map(s=>{
  const base=original.players.find(p=>p.id===s.sourceId),positions=allocations.get(s.id).sort((a,b)=>a.t-b.t);
  const grid=Array(original.width*original.height).fill(0);for(const p of positions)grid[Math.min(original.height-1,Math.floor(p.y*original.height))*original.width+Math.min(original.width-1,Math.floor(p.x*original.width))]+=p.seconds;
  const blockedIntervals=(base?.blockedIntervals||[]).map(b=>({...b,from:Math.max(b.from,s.from),to:Math.min(b.to,s.to)})).filter(b=>b.to>b.from),inactiveIntervals=[...(s.from>original.from?[{from:original.from,to:s.from,reason:'substitution'}]:[]),...(s.to<original.to?[{from:s.to,to:original.to,reason:'substitution'}]:[])];
  const observed=sum(positions.map(p=>p.seconds)),p={id:s.id,group:s.group,jersey:s.jersey,positions,grid,observed,coverage:observed/(original.to-original.from),activeFrom:s.from,activeTo:s.to,blockedIntervals,inactiveIntervals,substitutionStint:s};
  // An unconnected track end is an identity gap, not permission to invent the rest of the stint.
  if(!positions.length){const r=results.find(r=>r.inPersonId===s.id);if(r){r.status='review';r.reason='투입 선수의 유효 좌표가 없습니다. FPA 검수 후 새 스냅샷을 저장하세요.';}}
  if(!base&&positions.length&&positions.at(-1).t+positions.at(-1).seconds<s.to-.1){p.blockedIntervals.push({from:positions.at(-1).t+positions.at(-1).seconds,to:s.to,reason:'inactive'});const r=results.find(r=>r.inPersonId===s.id);if(r&&r.status!=='review'){r.status='review';r.reason='입장 선수의 이후 트랙 연결이 끊겼습니다. FPA 검수를 반영해 새 스냅샷을 저장하세요.';}}
  if(original.augmentation)p.augmentation=augmentPlayerActivity(p,{from:original.from,to:original.to,width:original.width,height:original.height,targetRatio:s.to-s.from<30?0:original.augmentation.targetRatio*(s.to-s.from)/(original.to-original.from)});
  return p;
 });
 const seen=new Set();for(const p of players)for(const q of p.positions){const k=q.t.toFixed(5)+':'+q.trackId;if(seen.has(k))fail('같은 관측이 두 출전 구간에 연결되었습니다. 교체 연결을 확인하세요.');seen.add(k);}
 results.sort((a,b)=>events.findIndex(e=>e.id===a.id)-events.findIndex(e=>e.id===b.id));
 const heatmap={...original,players,substitutionsApplied:results.every(r=>r.status!=='review')};
 heatmap.scale=heatmapDensityScale(heatmap);validateHeatmapAugmentation(heatmap);
 // Normalize comparable full stints by time. Very short stints use their own scale.
 const eligible=players.filter(p=>p.activeTo-p.activeFrom>=30);
 const rate=heatmapDensityScale({...heatmap,players:eligible.map(p=>({...p,grid:p.grid.map(v=>v/(p.activeTo-p.activeFrom)),...(p.augmentation?{augmentation:{...p.augmentation,estimatedGrid:p.augmentation.estimatedGrid.map(v=>v/(p.activeTo-p.activeFrom))}}:{})}))});
 for(const p of players)p.renderScale=p.activeTo-p.activeFrom<30?heatmapDensityScale({...heatmap,players:[p]}):rate*(p.activeTo-p.activeFrom);
 return {provenance,status:heatmap.substitutionsApplied?'ready':'review',events:results,heatmap};
}
