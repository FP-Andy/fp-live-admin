'use client';
import {useRef,useState} from 'react';
import type {ReportDraft} from '../../lib/futsal-report';
import type {Crossing,SubstitutionResultEvent} from '../../public/fpa-cv/substitution-report.mjs';
import {formatLogTime as time} from '../../public/fla-video/substitution-log.mjs';
import type {useSubstitutionReport} from './useSubstitutionReport';
type Controller=ReturnType<typeof useSubstitutionReport>;
function Resolution({event,draft,control,show}:{event:SubstitutionResultEvent;draft:ReportDraft;control:Controller;show:(c:Crossing)=>void}){
 const [person,setPerson]=useState(event.outPersonId||''),[out,setOut]=useState(String(event.outTrackId??'')),[incoming,setIncoming]=useState(String(event.inTrackId??'')),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const select=(kind:'out'|'in',values:Crossing[],value:string,set:(s:string)=>void)=><label>{kind==='out'?'퇴장 객체':'입장 객체'}<select aria-label={kind==='out'?'퇴장 객체':'입장 객체'} value={value} onChange={e=>set(e.target.value)}><option value="">장면에서 선택</option>{values.map(c=><option key={`${c.trackId}-${c.time}`} value={c.trackId}>TRACK #{c.trackId} · {time(c.time)}</option>)}</select><button disabled={!value} onClick={()=>show(values.find(c=>String(c.trackId)===value)!)}>장면 보기</button></label>;
 return <details className="mr-sub-event" open={event.status==='review'}><summary>{event.team==='home'?draft.homeName:draft.awayName} · {time(event.time)} · {event.status==='review'?'확인 필요':`#${event.outNumber} → #${event.inNumber}`}</summary>
 {event.reason&&<p>{event.reason}</p>}{select('out',event.outs,out,setOut)}{select('in',event.ins,incoming,setIncoming)}
 <label>퇴장한 분석번호<select aria-label="퇴장한 분석번호" value={person} onChange={e=>setPerson(e.target.value)}><option value="">번호 선택</option>{event.people.map(p=><option key={p.id} value={p.id}>#{p.number}</option>)}</select></label>
 <button className="btn-primary" disabled={!person||!out||!incoming||out===incoming||saving||!control.canWrite||control.state==='working'} onClick={async()=>{setSaving(true);setError('');try{await control.confirm(event.id,{snapshotId:draft.sourceSnapshot!.id,outPersonId:person,outTrackId:Number(out),inTrackId:Number(incoming)});}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}}}>{saving?'반영 중…':'이 연결 확인 · 리포트 갱신'}</button>
 {(!event.outs.length||!event.ins.length)&&<a href={`/admin/futsal/fla/video/${draft.matchId}`}>영상 기록에서 시각 확인</a>}{error&&<p role="alert">{error}</p>}
 </details>;
}
export default function SubstitutionReportPanel({draft,control}:{draft:ReportDraft;control:Controller}){
 const video=useRef<HTMLVideoElement>(null),[scene,setScene]=useState<Crossing|null>(null),[ratio,setRatio]=useState('16 / 9'),[frameReady,setFrameReady]=useState(false),[frameError,setFrameError]=useState('');
 const show=(c:Crossing)=>{if(!c)return;setFrameReady(false);setFrameError('');setScene(c);if(video.current){video.current.pause();video.current.currentTime=c.time;}};
 const result=draft.substitutionReport;
 return <section className="card card-panel mr-substitutions"><h2>교체 자동 반영</h2><p role="status">{control.state==='working'?control.progress:control.state==='checking'?'교체로그 확인 중…':control.state==='ready'?`최신 교체로그 ${control.saved?.log?.substitutions.length||0}건 반영됨`:control.state==='review'?'불확실한 연결을 확인하면 PDF에 반영됩니다.':control.error||'경기와 분석 스냅샷을 연결하세요.'}</p>
 {control.error&&<p role="alert">{control.error}</p>}<button disabled={control.state==='working'} onClick={()=>void control.refresh()}>교체로그 다시 확인</button>
 {!!result?.events.length&&draft.sourceSnapshot&&<><div className="mr-sub-video" style={{aspectRatio:ratio}}>{scene?<img key={`${scene.trackId}-${scene.time}`} alt={`TRACK ${scene.trackId} · ${time(scene.time)}`} src={`/api/tracking/jobs/${draft.sourceSnapshot.jobId}/report-frame?time=${scene.time}`} onLoad={e=>{setRatio(`${e.currentTarget.naturalWidth} / ${e.currentTarget.naturalHeight}`);setFrameReady(true);}} onError={()=>setFrameError('장면을 불러오지 못했습니다. 다른 후보를 선택하거나 다시 확인하세요.')} style={{width:'100%',display:frameReady?'block':'none'}}/>:<video ref={video} src={`/api/tracking/jobs/${draft.sourceSnapshot.jobId}/source`} preload="metadata" playsInline controls onLoadedMetadata={()=>{if(video.current)setRatio(`${video.current.videoWidth} / ${video.current.videoHeight}`);}}/>}{scene&&!frameReady&&<p role="status">{frameError||'교체 장면 불러오는 중…'}</p>}{scene&&frameReady&&<div className="mr-sub-box" style={{left:`${scene.box[0]*100}%`,top:`${scene.box[1]*100}%`,width:`${(scene.box[2]-scene.box[0])*100}%`,height:`${(scene.box[3]-scene.box[1])*100}%`}}><span>#{scene.trackId}</span></div>}</div><small>후보의 ‘장면 보기’로 해당 객체를 확인하세요.</small></>}
 {result?.events.map(e=><Resolution key={`${result.provenance.logRevision}-${e.id}`} event={e} draft={draft} control={control} show={show}/>)}
 {!!result?.events.length&&<p className="field-help">새 번호는 출전 구간을 구분하는 분석번호입니다. 재입장한 동일인인지는 별도로 확인합니다.</p>}
 </section>;
}
