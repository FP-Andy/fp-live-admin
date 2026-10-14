import {courtProjection} from './court-projection.mjs';
import {classifyUniform} from './colors.mjs';
import {planSubstitutionRedetection} from './substitution-redetection.mjs';

/** Plan observed track losses, not only the original substitution timestamp.
 * A plan never runs a GPU job or confirms an identity. */
export function planContinuationRecovery(snapshot,data,saved,result,{maxVideoSeconds=(snapshot.heatmap.to-snapshot.heatmap.from)*.05}={}){
 if(!Number.isFinite(maxVideoSeconds)||maxVideoSeconds<0)throw Error('추가 탐지 예산을 확인하세요.');
 const base=planSubstitutionRedetection(snapshot,data,saved,result),h=result.heatmap;
 const candidates=[],deferred=[],associationReview=[];
 const project=data.detector?.roi?.length===4?courtProjection(data.detector.roi,h.turn||0):null;
 const length=h.court?.lengthM||40,width=h.court?.widthM||20;
 // Missing identity is not missing detection. Look for several measured boxes
 // near the recent route before scheduling another model. This is a review
 // suggestion, never an automatic identity assignment.
 const nearbyEvidence=(p,lostAt)=>{
  if(!project||!data.frames?.length||!p.positions?.length)return null;
  const last=p.positions.at(-1),prior=[...p.positions].reverse().find(q=>q.t<=last.t-.4&&q.t>=last.t-1);
  const dt=prior?last.t-prior.t:0,v=prior?[(last.x-prior.x)/dt,(last.y-prior.y)/dt]:[0,0];
  const speed=Math.hypot(v[0]*length,v[1]*width);if(speed>10)return null;
  let frames=0,matched=0;const trackIds=new Set();
  for(const f of data.frames){if(f.t<lostAt||f.t>lostAt+1.2)continue;frames++;
   const elapsed=f.t-last.t,px=last.x+v[0]*elapsed,py=last.y+v[1]*elapsed;
   const candidates=f.boxes.filter(b=>{
    if(b.confidence<.15)return false;
    const c=classifyUniform(b.appearance,snapshot.review?.uniforms||{}),team=c.group?.startsWith('home')?'home':c.group?.startsWith('away')?'away':null;
    if(team&&team!==p.group&&c.margin>.45)return false;
    const xy=project([(b.box[0]+b.box[2])/2,h.point==='center'?(b.box[1]+b.box[3])/2:b.box[3]]);
    return xy&&Math.hypot(length*(xy[0]-px),width*(xy[1]-py))<1.2+elapsed;
   });
   if(candidates.length){matched++;for(const b of candidates)trackIds.add(b.id);}
  }
  return frames>=4&&matched>=4&&matched/frames>=.6?{trackIds:[...trackIds],matchedFrames:matched,frames}:null;
 };
 for(const row of result.continuation?.audit||[]){
  const event=result.events.find(e=>e.inPersonId===row.personId),p=h.players.find(p=>p.id===row.personId);
  const last=p?.positions?.at(-1),lostAt=Number.isFinite(row.lastObservedAt)?row.lastObservedAt:last?last.t+last.seconds:row.stoppedAt;
  if(!p||!event||event.held||row.manualConflicts||!Number.isFinite(lostAt)||lostAt>=row.until-1)continue;
  if(row.after>=30&&!row.oppositeKitStop)continue;
  const from=Math.max(h.from,p.activeFrom,lostAt-2),to=Math.min(h.to,row.until,lostAt+12);
  if(to-from<2)continue;
  const available=nearbyEvidence(p,lostAt);if(available){associationReview.push({personId:p.id,eventId:event.id,from,to,reason:'existing-detections',...available});continue;}
  candidates.push({from,to,eventIds:[event.id],personIds:[p.id],priority:row.after<10?0:row.after<30?1:2,observed:row.after,reason:row.oppositeKitStop?'identity-switch':'short-continuation'});
 }
 candidates.sort((a,b)=>a.priority-b.priority||a.observed-b.observed||a.from-b.from);
 const windows=[];let seconds=0;
 for(const candidate of candidates){
  const overlaps=windows.filter(w=>candidate.from<=w.to&&w.from<=candidate.to),from=Math.min(candidate.from,...overlaps.map(w=>w.from)),to=Math.max(candidate.to,...overlaps.map(w=>w.to));
  const extra=to-from-overlaps.reduce((n,w)=>n+w.to-w.from,0);
  if(to-from>80||seconds+extra>maxVideoSeconds+1e-7){deferred.push(candidate);continue;}
  for(const w of overlaps)windows.splice(windows.indexOf(w),1);
  windows.push({...candidate,from,to,eventIds:[...new Set([...candidate.eventIds,...overlaps.flatMap(w=>w.eventIds)])],personIds:[...new Set([...candidate.personIds,...overlaps.flatMap(w=>w.personIds)])]});seconds+=extra;
 }
 return {...base,purpose:'track-continuation',preferredDetector:'rfdetr',scope:'court',baseRecoveryId:result.provenance.redetectionId||null,
  windows:windows.sort((a,b)=>a.from-b.from).map((w,i)=>({...w,id:i+1})),totalSeconds:seconds,maxVideoSeconds,deferred,associationReview,
  estimatedDetectorMultiplier:1+seconds/Math.max(1,h.to-h.from)*9.342312245351726,
  estimateScope:'Pilot detector time only; excludes loading, decoding, association and network.'};
}
