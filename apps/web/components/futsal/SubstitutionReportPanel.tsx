'use client';
import {useEffect,useState} from 'react';
import {substitutionScene} from '../../lib/substitution-scenes';
import type {ReportDraft} from '../../lib/futsal-report';
import type {Crossing,SubstitutionResultEvent} from '../../public/fpa-cv/substitution-report.mjs';
import {formatLogTime as time} from '../../public/fla-video/substitution-log.mjs';
import type {useSubstitutionReport} from './useSubstitutionReport';
type Controller=ReturnType<typeof useSubstitutionReport>;
const choice=(id:number|undefined,t:number|undefined)=>id===undefined?'':`${id}@${t??''}`;
const label=(c:Crossing)=>`${c.origin==='redetection'?'재탐지':'기존 추적'} · TRACK #${c.trackId}`;
function Scene({candidate:c,jobId}:{candidate:Crossing;jobId:string}){
 const [ready,setReady]=useState(false),[error,setError]=useState(false),[src,setSrc]=useState('');
 useEffect(()=>{let active=true;setReady(false);setError(false);setSrc('');void substitutionScene(`/api/tracking/jobs/${jobId}/report-frame?time=${c.time}`).then(value=>{if(active)setSrc(value);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[jobId,c.time]);
 return <div className="mr-sub-candidate-scene">
  {src&&<img src={src} alt={`${label(c)} · 영상 ${time(c.time)}`} onLoad={()=>setReady(true)} onError={()=>setError(true)}/>}
  {!ready&&<span className="mr-sub-loading">{error?'장면을 불러오지 못했습니다':'장면 불러오는 중…'}</span>}
  {ready&&<span className="mr-sub-box" style={{left:`${c.box[0]*100}%`,top:`${c.box[1]*100}%`,width:`${(c.box[2]-c.box[0])*100}%`,height:`${(c.box[3]-c.box[1])*100}%`}}><span>#{c.trackId}</span></span>}
 </div>;
}
function Candidates({title,values,value,set,jobId,show}:{title:string;values:Crossing[];value:string;set:(s:string)=>void;jobId:string;show:(c:Crossing)=>void}){
 return <section className="mr-sub-candidates"><h3>{title}</h3>{!values.length&&<p>확인된 후보가 없습니다.</p>}
 {values.map(c=><div className={`mr-sub-candidate ${value===choice(c.trackId,c.time)?'is-selected':''}`} key={`${c.trackId}-${c.time}`}>
  <button className="mr-sub-pick" aria-label={`${title} ${label(c)} 선택`} aria-pressed={value===choice(c.trackId,c.time)} onClick={()=>set(choice(c.trackId,c.time))}><Scene candidate={c} jobId={jobId}/><strong>{value===choice(c.trackId,c.time)?'✓ ':''}{label(c)}</strong><small>영상 {time(c.time)}{c.evidence==='boundary-wait'?' · 경계 대기 후 입장':''}{c.teamConflict?' · 팀 색상 확인 필요':''}{c.extendedWindow?' · 검색 시간 확장':''}{c.returning?' · 재진입 확인 필요':''}</small></button>
  <button onClick={()=>show(c)}>장면 크게 보기</button>
 </div>)}
 </section>;
}
function Resolution({event,draft,control,show,initialOpen}:{event:SubstitutionResultEvent;draft:ReportDraft;control:Controller;show:(c:Crossing)=>void;initialOpen:boolean}){
 const [open,setOpen]=useState(initialOpen),[person,setPerson]=useState(event.outPersonId||''),[out,setOut]=useState(choice(event.outTrackId,event.outTime)),[incoming,setIncoming]=useState(choice(event.inTrackId,event.inTime)),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const outgoing=event.outs.find(c=>choice(c.trackId,c.time)===out),resolvedPerson=outgoing?.resolvedPersonId||person;
 const unchanged=event.connectionConfirmed&&resolvedPerson===event.outPersonId&&out===choice(event.outTrackId,event.outTime)&&incoming===choice(event.inTrackId,event.inTime);
 const state=event.held?'보류':event.status==='review'?(event.connectionConfirmed?'출입 확인됨 · 좌표 연결 검토':'출입 연결 확인 필요'):event.trackingStatus==='partial'?'출입 연결됨 · 관측 일부':event.connectionConfirmed?'연결 확인됨':event.pairing==='batch'?`동시 교체 · 새 #${event.inNumber}`:`#${event.outNumber} → #${event.inNumber}`;
 return <details className="mr-sub-event" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>{event.team==='home'?draft.homeName:draft.awayName} · {time(event.time)} · {state}</summary>
 {open&&<>{event.pairing==='batch'&&<p>동시 퇴장 {event.batchOutNumbers?.map(n=>'#'+n).join(', ')} · 입장 선수별 출전 구간을 분리합니다.</p>}{event.reason&&<p>{event.reason}</p>}{event.trackingWarning&&<p>{event.trackingWarning}</p>}
 <div className="mr-sub-candidate-columns"><Candidates title="나간 선수" values={event.outs} value={out} set={setOut} jobId={draft.sourceSnapshot!.jobId} show={show}/><Candidates title="들어온 선수" values={event.ins} value={incoming} set={setIncoming} jobId={draft.sourceSnapshot!.jobId} show={show}/></div>
 {outgoing?.resolvedPersonId?<p role="status">기존 #{outgoing.resolvedNumber}의 기록을 종료하고, 들어온 선수는 새 분석번호로 분리합니다.</p>:<label>퇴장한 분석번호<select aria-label="퇴장한 분석번호" value={person} onChange={e=>setPerson(e.target.value)}><option value="">기존 기록 연결 확인 필요</option>{event.people.map(p=><option key={p.id} value={p.id}>#{p.number}</option>)}</select></label>}
 {event.held&&<p>보류한 교체는 자동으로 연결하지 않습니다. 검토 후 영상 기록의 교체 메모에서 [보류]를 지우면 다시 연결할 수 있습니다.</p>}
 <button className="btn-primary" disabled={event.held||!resolvedPerson||!out||!incoming||out.split('@')[0]===incoming.split('@')[0]||saving||unchanged||!control.canWrite||control.state==='working'||control.state==='error'} onClick={async()=>{setSaving(true);setError('');try{await control.confirm(event.id,{snapshotId:draft.sourceSnapshot!.id,...(draft.substitutionReport?.provenance.redetectionId?{redetectionId:draft.substitutionReport.provenance.redetectionId}:{}),outPersonId:resolvedPerson,outTrackId:Number(out.split('@')[0]),inTrackId:Number(incoming.split('@')[0]),outTime:Number(out.split('@')[1]),inTime:Number(incoming.split('@')[1])});}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}}}>{saving?'반영 중…':unchanged?'연결 저장됨':'이 연결 확인 · 리포트 갱신'}</button>
 <a href={`/admin/futsal/fla/video/${draft.matchId}`} target="_blank" rel="noreferrer">영상 기록에서 전후 장면 보기</a>{error&&<p role="alert">{error}</p>}</>}
 </details>;
}
export default function SubstitutionReportPanel({draft,control}:{draft:ReportDraft;control:Controller}){
 const [scene,setScene]=useState<Crossing|null>(null),result=draft.substitutionReport,linked=result?.events.filter(e=>e.status!=='review').length||0,pending=result?.events.filter(e=>e.status==='review').length||0,partial=result?.events.filter(e=>e.trackingStatus==='partial').length||0;
 return <section className="card card-panel mr-substitutions"><h2>교체 자동 반영</h2><p role="status">{control.state==='working'?control.progress:control.state==='checking'?'교체로그 확인 중…':control.state==='ready'?`최신 교체로그 ${control.saved?.log?.substitutions.length||0}건 반영됨`:control.state==='review'?'나간 사람과 들어온 사람의 장면을 선택하세요. 기존 분석번호는 추적 이력으로 연결합니다.':control.error||'경기와 분석 스냅샷을 연결하세요.'}</p>
 {control.recovery?.status==='ready'&&<p className="mr-sub-recovery">재탐지 {control.recovery.windowCount}개 구간의 후보를 함께 표시합니다. 새 후보는 직접 확인한 뒤 연결됩니다.</p>}
 {!!result?.events.length&&<p>출입 연결 {linked}건 · 연결 검토 {pending}건 · 관측 일부 {partial}건{partial?' (연결된 건과 중복 집계)':''}</p>}
 {control.error&&<p role="alert">{control.error}</p>}<button disabled={control.state==='working'} onClick={()=>void control.refresh()}>교체로그 다시 확인</button>
 <div className="mr-sub-recovery">
  <button className="btn-primary" disabled={!control.canWrite||control.recoveryBusy||control.recoveryActive||control.state==='working'||control.state==='error'||!result?.recoveryPlan?.windows.length} onClick={()=>void control.startRecovery()}>{control.recoveryBusy?'요청 중…':'RF-DETR로 짧은 추적 보강'}</button>
  <p className="field-help">추적이 짧은 선수의 누락 구간부터 GPU로 추가 탐지합니다. 시작한 작업은 창을 닫아도 계속됩니다.</p>
  {control.recoveryJob&&<p role="status">{control.recoveryJob.stage}{control.recoveryActive?` · ${Math.round(control.recoveryJob.progress||0)}%`:''}{control.recoveryActive&&Number.isFinite(control.recoveryJob.eta)?` · 약 ${Math.ceil(control.recoveryJob.eta!/60)}분 남음`:''}</p>}
  {control.recoveryJob?.error&&<p role="alert">{control.recoveryJob.error}</p>}
  {control.recoveryError&&<p role="alert">{control.recoveryError}</p>}
  {control.recoveryActive&&<button disabled={!control.canWrite||control.recoveryBusy} onClick={()=>void control.cancelRecovery()}>보강 중단</button>}
 </div>
 {!!result?.continuation?.audit.length&&<details className="mr-sub-event"><summary>추적 복구 결과 · {result.continuation.audit.length}명</summary>
  <p className="field-help">실제 탐지 좌표의 연결 시간입니다. 히트맵 추정 보강은 포함하지 않습니다.</p>
  {result.recoveryPlan&&<p>기존 검출 연결 검토 {result.recoveryPlan.associationReview.length}명 · 추가 탐지 후보 {result.recoveryPlan.windows.length}구간</p>}
  {!!result.recoveryPlan?.windows.length&&<button onClick={()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(result.recoveryPlan,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`tracking-recovery-${draft.sourceSnapshot!.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>추가 탐지 구간 내보내기</button>}
  {result.continuation.audit.map(a=><div key={a.personId}>
   <strong>{a.team==='home'?draft.homeName:draft.awayName} #{a.number}</strong>
   <p>{a.before.toFixed(1)}초 → {a.after.toFixed(1)}초 · 후속 연결 {a.links.length}개{(a.removed||0)>0?` · 위치 확인 필요 ${(a.removed||0).toFixed(1)}초 제외`:''}</p>
   {!!a.manualConflicts&&<p role="status">수동 관측 {a.manualConflicts}건은 변경하지 않았습니다. 유니폼·박스 근거를 확인하세요.</p>}
   {a.scene&&<button onClick={()=>setScene({...a.scene!,kind:'in',team:a.team==='home'?'home':'away',sourceId:a.personId,ownerCertain:false})}>마지막 연결 장면</button>}
  </div>)}
 </details>}
 {result?.events.map(e=><Resolution key={[result.provenance.snapshotId,result.provenance.algorithm,result.provenance.logRevision,result.provenance.redetectionId,e.id,e.outPersonId,e.outTrackId,e.inTrackId].join(':')} event={e} draft={draft} control={control} show={setScene} initialOpen={e.id===result.events.find(q=>q.status==='review'&&!q.connectionConfirmed)?.id}/>)}
 {!!result?.events.length&&<p className="field-help">새 번호는 출전 구간을 구분하는 분석번호입니다. 연결을 확인한 뒤에도 이후 추적이 부족하면 별도 검수가 필요합니다.</p>}
 {scene&&draft.sourceSnapshot&&<div className="mr-sub-lightbox" role="dialog" aria-modal="true" aria-label="교체 후보 장면" onKeyDown={e=>{if(e.key==='Escape')setScene(null);}}><div><header><strong>{label(scene)} · 영상 {time(scene.time)}</strong><button autoFocus onClick={()=>setScene(null)}>닫기</button></header><Scene key={`${scene.trackId}-${scene.time}`} candidate={scene} jobId={draft.sourceSnapshot.jobId}/></div></div>}
 </section>;
}
