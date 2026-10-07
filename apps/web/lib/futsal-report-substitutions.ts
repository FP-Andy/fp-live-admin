import {blankPlayer,type ReportDraft,type HeatSource,type HeatPlayer} from './futsal-report';
import type {SubstitutionReport} from '../public/fpa-cv/substitution-report.mjs';
function samePlayer(before:HeatPlayer|undefined,after:HeatPlayer){
 if(!before||before.id!==after.id||before.group!==after.group)return false;
 const a=before.substitutionStint,b=after.substitutionStint;
 if((a?.kind||'starter')!==(b?.kind||'starter'))return false;
 if(b?.kind==='substitute')return !!a?.eventId&&a.eventId===b.eventId&&a.entryTrackId!==undefined&&a.entryTrackId===b.entryTrackId&&a.sourceId===b.sourceId;
 return (a?.sourceId||before.id)===(b?.sourceId||after.id);
}
export function applySubstitutionReport(d:ReportDraft,result:SubstitutionReport):ReportDraft{
 if(result.provenance.snapshotId!==d.sourceSnapshot?.id||result.provenance.matchId!==d.matchId)throw Error('현재 리포트와 교체 분석 원본이 다릅니다.');
 const {heatmap:h,...metadata}=result;const players=Object.fromEntries(h.players.map(p=>{const old=d.players[p.id],before=d.heatmap?.players.find(q=>q.id===p.id);
  // Changed boundaries do not change identity. A different incoming track does.
  return [p.id,old&&samePlayer(before,p)?old:{...blankPlayer(p),eventNumber:'',flaNumber:''}];}));
 const all=(side:'home'|'away')=>h.players.filter(p=>p.group===side).map(p=>p.id);
 return {...d,heatmap:h,players,substitutionReport:{...metadata,images:d.substitutionReport?.provenance.logRevision===metadata.provenance.logRevision?d.substitutionReport.images:undefined},selected:players[d.selected]?d.selected:h.players[0].id,teamReport:d.teamReport?{...d.teamReport,homePlayers:all('home'),awayPlayers:all('away')}:d.teamReport};
}
/** Back up the latest edit, including removal of the final substitution. Edits
 * made while IDB is writing must reach the backup before the result is applied. */
export async function preserveAndApplySubstitutions(getLatest:()=>ReportDraft|null,apply:(draft:ReportDraft)=>void,save:(draft:ReportDraft)=>Promise<unknown>,result:SubstitutionReport){
 const initial=getLatest();if(!initial)return;
 const backupId=crypto.randomUUID();
 const matches=(d:ReportDraft|null):d is ReportDraft=>!!d&&d.id===initial.id&&d.sourceSnapshot?.id===result.provenance.snapshotId&&d.matchId===result.provenance.matchId;
 let current=getLatest(),backedUp=false;
 while(matches(current)){
  if(current.heatmap&&(current.substitutionReport?.provenance.logRevision!==result.provenance.logRevision||current.substitutionReport?.provenance.snapshotId!==result.provenance.snapshotId)){
   await save({...current,id:backupId,title:current.title+' · 교체 갱신 전',updatedAt:new Date().toISOString()});
   backedUp=true;
   if(getLatest()!==current){current=getLatest();continue;}
  }
  const next=applySubstitutionReport(current,result),before=current;
  const reset=Object.keys(next.players).filter(id=>next.players[id]!==before.players[id]).length;
  const removed=Object.keys(current.players).filter(id=>!next.players[id]).length;
  apply(next);return {reset,removed,backedUp};
 }
}
export function appearanceSource(source:HeatSource|null,p?:HeatPlayer):HeatSource|null{
 if(!source||p?.activeFrom===undefined||p.activeTo===undefined)return source;
 const from=p.activeFrom,to=p.activeTo;
 return {...source,from,to,players:source.players.map(q=>({...q,positions:q.positions.flatMap(o=>{const a=Math.max(o.t,from),z=Math.min(o.t+o.seconds,to);return z>a?[{...o,t:a,seconds:z-a}]:[];})}))};
}
export function substitutionGuidePages(d:ReportDraft,side:'home'|'away'){
 const events=(d.substitutionReport?.events||[]).filter(e=>e.team===side&&e.status!=='review');
 return Array.from({length:Math.ceil(events.length/2)},(_,i)=>events.slice(i*2,i*2+2));
}
export async function captureSubstitutionFrames(d:ReportDraft,progress:(completed:number,total:number)=>void){
 const result=d.substitutionReport;if(!result?.events.length)return d;
 const events=result.events.filter(e=>e.status!=='review'&&e.inTime!==undefined&&e.entryBox),images={...result.images};
 for(const [i,e]of events.entries()){
  if(!images[e.id]){
   const response=await fetch(`/api/tracking/jobs/${d.sourceSnapshot!.jobId}/report-frame?time=${e.inTime}`,{signal:AbortSignal.timeout(45000)});
   if(!response.ok)throw Error('교체 장면을 불러오지 못했습니다. 잠시 후 다시 추출하세요.');
   const url=URL.createObjectURL(await response.blob());
   try{const frame=new Image();frame.src=url;await frame.decode();const c=document.createElement('canvas');c.width=frame.naturalWidth;c.height=frame.naturalHeight;const g=c.getContext('2d')!;g.drawImage(frame,0,0);
    const [x,y,z,w]=e.entryBox!.map((v,i)=>v*(i%2?c.height:c.width));g.lineWidth=3;g.strokeStyle='#FF7400';g.strokeRect(x-3,y-3,z-x+6,w-y+6);g.font='bold 21px Arial';const label=`NEW #${e.inNumber}`,width=g.measureText(label).width+16,left=Math.max(0,Math.min(c.width-width,x)),top=Math.max(0,y-35);g.fillStyle='white';g.fillRect(left,top,width,30);g.fillStyle='#171717';g.fillText(label,left+8,top+23);images[e.id]=c.toDataURL('image/jpeg',.9);
   }finally{URL.revokeObjectURL(url);}
  }progress(i+1,events.length);
 }
 return {...d,substitutionReport:{...result,images}};
}
