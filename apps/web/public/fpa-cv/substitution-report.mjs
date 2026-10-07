import {courtProjection} from './court-projection.mjs';
import {classifyUniform} from './colors.mjs';
import {augmentPlayerActivity} from './heatmap-augmentation.mjs';
import {validateHeatmapAugmentation} from './heatmap-augmentation-schema.mjs';
import {heatmapDensityScale} from './heatmap-render.mjs';
import {validateSubstitutionLog} from '../fla-video/substitution-log.mjs';

export const SUBSTITUTION_REPORT_VERSION='substitution-report/v1';
const fail=message=>{throw Error(message);};
const side=group=>group?.startsWith('home')?'home':group?.startsWith('away')?'away':null;
const sum=values=>values.reduce((a,b)=>a+b,0);
const clip=(positions,from,to)=>positions.flatMap(p=>{const a=Math.max(from,p.t),z=Math.min(to,p.t+p.seconds);return z>a+1e-8?[{...p,t:a,seconds:z-a}]:[];});
const within=(a,b)=>Math.abs(a-b)<.002;
const newId=e=>'sub-'+e.id;

/** A derived report, never a mutation of the operator's immutable snapshot.
 * Boundary evidence is in camera coordinates, heat is in the saved pitch turn.
 * Unresolved crossings block export; nearest time alone never assigns identity.
 */
export function deriveSubstitutionReport(snapshot,data,saved,progress=()=>{}){
 const original=snapshot.heatmap,log=saved.log?validateSubstitutionLog(saved.log):null;
 if(!original||data.datasetId!==original.datasetId)fail('스냅샷과 추적 데이터가 다른 분석입니다.');
 if(log?.substitutions?.length&&(log.video.name!==data.video.name||Math.abs(log.video.duration-data.video.duration)>.2))fail('교체로그와 분석 영상이 다릅니다.');
 const events=log?.substitutions||[],provenance={algorithm:SUBSTITUTION_REPORT_VERSION,snapshotId:snapshot.id,jobId:snapshot.jobId,logRevision:saved.revision,matchId:snapshot.matchId};
 if(!events.length)return {provenance,status:'ready',events:[],heatmap:structuredClone(original)};
 if(events.some(e=>e.time<original.from||e.time>=original.to))fail('분석 구간 밖 교체가 있습니다. 해당 구간을 포함한 스냅샷을 선택하세요.');
 const camera=courtProjection(data.detector.roi),project=courtProjection(data.detector.roi,original.turn||0),step=1/data.detector.sampleFps;
 const tracks=new Map(),owners=new Map();
 for(const p of original.players)for(const q of p.positions){const a=owners.get(q.trackId)||[];a.push({t:q.t,to:q.t+q.seconds,id:p.id});owners.set(q.trackId,a);}
 for(const [i,f]of data.frames.entries())for(const b of f.boxes){const list=tracks.get(b.id)||[];list.push({t:f.t,dt:Math.min(step,(data.frames[i+1]?.t??original.to)-f.t),b});tracks.set(b.id,list);}
 const ownerAt=(id,t,window=2)=>{const votes=new Map();for(const q of owners.get(id)||[])if(q.to>=t-window&&q.t<=t+window)votes.set(q.id,(votes.get(q.id)||0)+Math.min(step,q.to-q.t));return [...votes].sort((a,b)=>b[1]-a[1]);};
 const crossings=[];
 for(const [trackId,list]of tracks){let last=null,lastT=-Infinity;
  for(const [i,o]of list.entries()){
   if(!events.some(e=>Math.abs(e.time-o.t)<=16))continue;
   const b=o.b.box,xy=camera([(b[0]+b[2])/2,(b[1]+b[3])/2]);if(!xy||xy[0]<0||xy[0]>1||xy[1]<.65)continue;
   const state=xy[1]<.97?'inside':xy[1]>1.025?'outside':null;
   if(o.t-lastT>2)last=null;lastT=o.t;if(!state)continue;
   if(last&&last!==state){
    const kind=state==='inside'?'in':'out',votes=ownerAt(trackId,o.t),teams=new Map();
    for(const a of list.filter(q=>Math.abs(q.t-o.t)<2).filter((_,j)=>j%4===0)){const c=classifyUniform(a.b.appearance,snapshot.review?.uniforms);const s=side(c.group);if(s&&c.strength>=.15)teams.set(s,(teams.get(s)||0)+c.strength);}
    const ranked=[...teams].sort((a,b)=>b[1]-a[1]),source=original.players.find(p=>p.id===votes[0]?.[0]);
    const color=ranked[0]&&ranked[0][1]>(ranked[1]?.[1]||0)*1.5?ranked[0][0]:null;
    const future=list.slice(i).filter(q=>q.t<=o.t+1.5),held=future.filter(q=>{const p=camera([(q.b.box[0]+q.b.box[2])/2,(q.b.box[1]+q.b.box[3])/2]);return p&&(kind==='in'?p[1]<1:p[1]>1);});
    if(sum(held.map(q=>q.dt))>=Math.min(.2,original.to-o.t-.1))crossings.push({trackId,time:o.t,kind,team:color||source?.group||null,sourceId:votes[0]?.[0]||null,ownerCertain:!!votes[0]&&(!votes[1]||votes[0][1]>votes[1][1]*3),colorConflict:!!color&&!!source&&color!==source.group,box:[...b],x:xy[0],y:xy[1]});
   }
   last=state;lastT=o.t;
  }
 }
 // A player briefly stepping outside and returning is not a substitution.
 for(const c of crossings)c.returning=crossings.some(q=>q.trackId===c.trackId&&q.kind!==c.kind&&Math.abs(q.time-c.time)<12);
 const stints=original.players.map(p=>({id:p.id,sourceId:p.id,group:p.group,jersey:p.jersey,from:original.from,to:original.to,kind:'starter'}));
 const used=new Set(),results=[],nextNumber={home:1,away:1};
 for(const p of snapshot.review?.roster||original.players){const n=Number(p.jersey);if(side(p.group)&&Number.isInteger(n))nextNumber[side(p.group)]=Math.max(nextNumber[side(p.group)],n+1);}
 const key=c=>c.kind+':'+c.trackId+':'+c.time;
 for(const [i,e]of events.entries()){
  progress({phase:'교체 출입·번호 연결',completed:i,total:events.length});
  const candidates=crossings.filter(c=>Math.abs(c.time-e.time)<=12&&(!c.team||c.team===e.team)&&!used.has(key(c)));
  const outs=candidates.filter(c=>c.kind==='out'),ins=candidates.filter(c=>c.kind==='in');
  const decision=e.tracking?.snapshotId===snapshot.id?e.tracking:null;
  const matches=[];
  for(const o of outs)for(const n of ins){
   if(o.trackId===n.trackId||o.returning||n.returning||o.colorConflict||n.colorConflict)continue;
   const current=stints.filter(s=>s.group===e.team&&s.from<o.time&&s.to>=o.time&&s.sourceId===o.sourceId);
   const inherited=n.ownerCertain&&n.sourceId===o.sourceId;
   const newArrival=!n.sourceId&&ins.filter(c=>!c.returning&&c.team===e.team).length===1&&outs.filter(c=>!c.returning&&c.ownerCertain).length===1;
   if(current.length!==1||!o.ownerCertain||(!inherited&&!newArrival)||n.team!==e.team)continue;
   matches.push({o,n,s:current[0],score:Math.abs(o.time-e.time)+Math.abs(n.time-e.time)});
  }
  matches.sort((a,b)=>a.score-b.score);
  // Multiple adjacent logs must each have unambiguous evidence, not a greedy nearest pair.
  let selected=matches.length===1?matches[0]:null;
  if(selected&&events.some(other=>other.id!==e.id&&other.team===e.team&&Math.abs(other.time-selected.o.time)+Math.abs(other.time-selected.n.time)<selected.score))selected=null;
  if(decision){const o=outs.find(c=>c.trackId===decision.outTrackId),n=ins.find(c=>c.trackId===decision.inTrackId),s=stints.find(s=>s.id===decision.outPersonId&&s.group===e.team&&s.from<(o?.time??0)&&s.to>=(o?.time??Infinity));selected=o&&n&&s&&o.trackId!==n.trackId?{o,n,s,score:0}:null;}
  const options=stints.filter(s=>s.group===e.team&&s.from<e.time+12&&s.to>e.time-12).map(s=>({id:s.id,number:s.jersey}));
  if(!selected){results.push({id:e.id,team:e.team,time:e.time,status:'review',reason:decision?'저장된 연결의 출입 근거가 변경되었습니다.':'퇴장 번호·입장 경로를 함께 확인하세요.',outs,ins,people:options});continue;}
  const {o,n,s}=selected;
  // A changed legacy identity on an unassigned incoming track is not evidence for a full stint.
  const durationAfter=original.to-n.time,originalIncoming=clip(original.players.find(p=>p.id===s.sourceId)?.positions||[],n.time,Math.min(original.to,n.time+20));
  const continuity=originalIncoming.some(q=>q.trackId===n.trackId)&&sum(originalIncoming.map(q=>q.seconds))>=Math.min(2,durationAfter*.5);
  s.to=Math.min(s.to,o.time);const entrant={id:newId(e),sourceId:continuity?s.sourceId:null,group:e.team,jersey:String(nextNumber[e.team]++),from:n.time,to:original.to,kind:'substitute',entryTrackId:n.trackId,eventId:e.id};stints.push(entrant);
  used.add(key(o));used.add(key(n));results.push({id:e.id,team:e.team,time:e.time,status:decision?'confirmed':'automatic',outPersonId:s.id,inPersonId:entrant.id,outNumber:s.jersey,inNumber:entrant.jersey,outTime:o.time,inTime:n.time,outTrackId:o.trackId,inTrackId:n.trackId,entryBox:n.box,outs,ins,people:options});
 }
 const players=stints.map(s=>{
  const base=original.players.find(p=>p.id===s.sourceId);let positions;
  if(base)positions=clip(base.positions,s.from,s.to).filter(q=>{
   const eligible=stints.filter(a=>a.sourceId===s.sourceId&&a.from<=q.t&&a.to>q.t);
   const exact=eligible.find(a=>a.entryTrackId===q.trackId)||eligible.find(a=>results.some(r=>r.outPersonId===a.id&&r.outTrackId===q.trackId));
   const chosen=exact||eligible.sort((a,b)=>b.from-a.from)[0];return chosen?.id===s.id;
  });
  else positions=(tracks.get(s.entryTrackId)||[]).filter(q=>q.t>=s.from&&q.t<s.to&&q.b.confidence>=.35).flatMap(q=>{const box=q.b.box,xy=project([(box[0]+box[2])/2,original.point==='center'?(box[1]+box[3])/2:box[3]]);const color=classifyUniform(q.b.appearance,snapshot.review?.uniforms);if(!xy||xy.some(n=>n<0||n>1)||(side(color.group)&&side(color.group)!==s.group&&color.strength>.3))return [];return [{t:q.t,x:xy[0],y:xy[1],seconds:Math.min(q.dt,s.to-q.t),trackId:q.b.id,source:'manual'}];});
  const grid=Array(original.width*original.height).fill(0);for(const p of positions)grid[Math.min(original.height-1,Math.floor(p.y*original.height))*original.width+Math.min(original.width-1,Math.floor(p.x*original.width))]+=p.seconds;
  const blockedIntervals=(base?.blockedIntervals||[]).map(b=>({...b,from:Math.max(b.from,s.from),to:Math.min(b.to,s.to)})).filter(b=>b.to>b.from),inactiveIntervals=[...(s.from>original.from?[{from:original.from,to:s.from,reason:'substitution'}]:[]),...(s.to<original.to?[{from:s.to,to:original.to,reason:'substitution'}]:[])];
  const observed=sum(positions.map(p=>p.seconds)),p={id:s.id,group:s.group,jersey:s.jersey,positions,grid,observed,coverage:observed/(original.to-original.from),activeFrom:s.from,activeTo:s.to,blockedIntervals,inactiveIntervals,substitutionStint:s};
  // An unconnected track end is an identity gap, not permission to invent the rest of the stint.
  if(!positions.length){const r=results.find(r=>r.inPersonId===s.id);if(r){r.status='review';r.reason='투입 선수의 유효 좌표가 없습니다. FPA 검수 후 새 스냅샷을 저장하세요.';}}
  if(!base&&positions.length&&positions.at(-1).t+positions.at(-1).seconds<s.to-.1){p.blockedIntervals.push({from:positions.at(-1).t+positions.at(-1).seconds,to:s.to,reason:'inactive'});const r=results.find(r=>r.inPersonId===s.id);if(r){r.status='review';r.reason='입장 선수의 이후 트랙 연결이 끊겼습니다. FPA 검수를 반영해 새 스냅샷을 저장하세요.';}}
  if(original.augmentation)p.augmentation=augmentPlayerActivity(p,{from:original.from,to:original.to,width:original.width,height:original.height,targetRatio:s.to-s.from<30?0:original.augmentation.targetRatio*(s.to-s.from)/(original.to-original.from)});
  return p;
 });
 const seen=new Set();for(const p of players)for(const q of p.positions){const k=q.t.toFixed(5)+':'+q.trackId;if(seen.has(k))fail('같은 관측이 두 출전 구간에 연결되었습니다. 교체 연결을 확인하세요.');seen.add(k);}
 const heatmap={...original,players,substitutionsApplied:results.every(r=>r.status!=='review')};
 heatmap.scale=heatmapDensityScale(heatmap);validateHeatmapAugmentation(heatmap);
 // Normalize comparable full stints by time. Very short stints use their own scale.
 const eligible=players.filter(p=>p.activeTo-p.activeFrom>=30);
 const rate=heatmapDensityScale({...heatmap,players:eligible.map(p=>({...p,grid:p.grid.map(v=>v/(p.activeTo-p.activeFrom)),...(p.augmentation?{augmentation:{...p.augmentation,estimatedGrid:p.augmentation.estimatedGrid.map(v=>v/(p.activeTo-p.activeFrom))}}:{})}))});
 for(const p of players)p.renderScale=p.activeTo-p.activeFrom<30?heatmapDensityScale({...heatmap,players:[p]}):rate*(p.activeTo-p.activeFrom);
 return {provenance,status:heatmap.substitutionsApplied?'ready':'review',events:results,heatmap};
}
