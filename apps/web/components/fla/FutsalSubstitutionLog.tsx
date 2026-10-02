'use client';
import {useRef,useState,useEffect} from 'react';
import {validateSubstitutionLog,saveSubstitution,removeSubstitution,exportSubstitutionLog,substitutionCsv,parseLogTime,hasPlayerPair,formatLogTime as fmt,type SubstitutionLog,type LogVideo,type LogTeam} from '../../public/fla-video/substitution-log.mjs';
export type SavedSubstitutions={revision:number;log:SubstitutionLog|null};
type Props={matchId:string;video:LogVideo|null;saved:SavedSubstitutions;names:{home:string;away:string};canWrite:boolean;busy:boolean;gameClockKnown:boolean;observedTo:number;ended:boolean;
  capture:()=>number;seek:(seconds:number)=>void;save:(log:SubstitutionLog,revision:number,requestId:string)=>Promise<SavedSubstitutions>};

export default function FutsalSubstitutionLog(props:Props){
  const [saved,setSaved]=useState(props.saved),[saving,setSaving]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [team,setTeam]=useState<LogTeam>('home'),[time,setTime]=useState(''),[note,setNote]=useState(''),[editing,setEditing]=useState<string|null>(null),[textEditing,setTextEditing]=useState(false);
  const pending=useRef(false),importer=useRef<HTMLInputElement>(null),editor=useRef<HTMLDetailsElement>(null);
  const attempted=useRef<{key:string;requestId:string}|null>(null);
  useEffect(()=>{if(props.saved.revision>saved.revision){setSaved(props.saved);resetEvent();setMessage('');setError('');attempted.current=null;}},[props.saved,saved.revision]);
  const log=saved.log,disabled=!props.canWrite||props.busy||saving;
  const label=(id?:string)=>{const p=log?.players.find(p=>p.id===id);return p?`${p.name}${p.jersey?` · No.${p.jersey}`:''}`:id||'';};
  const workingLog=():SubstitutionLog=>{
    if(!props.video)throw Error('연결된 경기 영상을 불러온 뒤 기록하세요.');
    return {...(log||{video:props.video,players:[],initialPlayers:[],substitutions:[]}),schema:'fpa-substitution-log/v2'};
  };
  async function commit(next:SubstitutionLog){
    if(disabled||pending.current)return false;
    pending.current=true;setSaving(true);setError('');
    try{
      const validated=validateSubstitutionLog(next,props.video||undefined),key=JSON.stringify([saved.revision,validated]);
      if(attempted.current?.key!==key)attempted.current={key,requestId:crypto.randomUUID()};
      const result=await props.save(validated,saved.revision,attempted.current.requestId);
      setSaved(result);attempted.current=null;setMessage('교체 시각 저장됨');return true;
    }catch(e){setError(e instanceof Error?e.message:String(e));return false;}finally{pending.current=false;setSaving(false);}
  }
  const safely=(action:()=>void|Promise<void>)=>{setError('');Promise.resolve().then(action).catch(e=>setError(e.message||String(e)));};
  function resetEvent(){setEditing(null);setTime('');setNote('');}
  async function record(side:LogTeam){
    const at=props.capture();
    if(await commit(saveSubstitution(workingLog(),{id:crypto.randomUUID(),time:at,team:side,note:''}))){
      resetEvent();setMessage(`${props.names[side]} · 영상 ${fmt(at)} 교체 기록됨`);
    }
  }
  function download(kind:'json'|'csv'){
    if(!log)return;
    const exported=exportSubstitutionLog(log);
    // Do not expose full-source appearance estimates as confirmed playing time.
    const content=kind==='json'?JSON.stringify({...exported,appearances:[],matchId:props.matchId,reviewedThrough:props.observedTo,recordingComplete:props.ended,gameClockKnown:props.gameClockKnown},null,2):substitutionCsv(log);
    const url=URL.createObjectURL(new Blob([content],{type:kind==='json'?'application/json':'text/csv;charset=utf-8'})),a=document.createElement('a');
    a.href=url;a.download=`${props.names.home}-${props.names.away}-교체타임로그.${kind==='json'?'json':'csv'}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    setMessage('교체 타임로그를 내보냈습니다.');
  }
  let matchTime='';try{if(time&&props.video&&props.gameClockKnown)matchTime=fmt(Math.max(0,parseLogTime(time)-props.video.from));}catch{}
  const events=log?.substitutions||[],unresolved=events.filter(e=>!hasPlayerPair(e)).length;
  return <section className="card card-panel fv-substitutions" aria-label="교체 타임로그" data-fla-text-edit={textEditing?'true':undefined}
    onFocusCapture={e=>{const target=e.target;setTextEditing(target instanceof HTMLElement&&(target.matches('input,select,textarea')||!!target.closest('form')));}}
    onBlurCapture={e=>{const next=e.relatedTarget;setTextEditing(next instanceof HTMLElement&&e.currentTarget.contains(next)&&(next.matches('input,select,textarea')||!!next.closest('form')));}}>
    <div className="row"><h3>교체 타임로그</h3><span className="muted">{events.length}건</span></div>
    <p className="muted">교체 장면에서 팀 버튼을 누르세요. 현재 영상 시각을 저장합니다.</p>
    {!props.video?<p className="muted">연결된 경기 영상을 불러온 뒤 기록하세요.</p>:<>
      <div className="fv-log-quick"><button className="btn-primary" aria-label="홈 교체 기록" disabled={disabled} onClick={()=>safely(()=>record('home'))}><small>HOME</small>{props.names.home} 교체 기록</button><button className="btn-secondary" aria-label="어웨이 교체 기록" disabled={disabled} onClick={()=>safely(()=>record('away'))}><small>AWAY</small>{props.names.away} 교체 기록</button></div>
      <small className="muted">선수 선택 없이 기록 · 촬영 화면 하단 경계 기준</small>
      {props.ended&&<small className="muted">완료 상태 유지 · 교체 로그만 보완</small>}
      {!props.gameClockKnown&&<small className="muted">경기 시작 설정 없이 원본 영상 시각으로 저장합니다.</small>}
      <details ref={editor} className="fv-log-editor"><summary>{editing?'교체 로그 수정':'시각 직접 입력 · 메모'}</summary>
        <form onSubmit={e=>{e.preventDefault();safely(async()=>{
          const at=parseLogTime(time),old=log?.substitutions.find(e=>e.id===editing);
          // Time or team changes invalidate previous identity evidence.
          const pair=old&&old.time===at&&old.team===team&&hasPlayerPair(old)?{outId:old.outId,inId:old.inId}:{};
          if(await commit(saveSubstitution(workingLog(),{id:editing||crypto.randomUUID(),time:at,team,note:note.trim(),...pair}))){resetEvent();if(editor.current)editor.current.open=false;}
        });}}><fieldset disabled={disabled} className="fv-log-form">
          <button type="button" className="btn-secondary" onClick={()=>safely(()=>setTime(fmt(props.capture())))}>현재 시각 가져오기</button>
          <label>원본 영상 시각<input aria-label="교체 원본 시각" placeholder="분:초.000" value={time} onChange={e=>setTime(e.target.value)} required/></label>{matchTime&&<small>경기 시각 {matchTime}</small>}
          <label>팀<select aria-label="교체 팀" value={team} onChange={e=>setTeam(e.target.value as LogTeam)}><option value="home">홈 · {props.names.home}</option><option value="away">어웨이 · {props.names.away}</option></select></label>
          <label>메모 (선택)<input aria-label="교체 메모" value={note} maxLength={500} placeholder="예: 두 명 동시 교체" onChange={e=>setNote(e.target.value)}/></label>
          <button className="btn-primary" type="submit">{saving?'저장 중…':editing?'교체 수정 저장':'교체 시각 저장'}</button>
          {editing&&<button type="button" onClick={resetEvent}>수정 취소</button>}
        </fieldset></form>
        {textEditing&&<small className="fv-log-editing">교체 입력 중 · 기록 단축키 잠시 해제</small>}
      </details>
      {events.length>0&&<details className="fv-log-history">
        <summary>기록된 교체 <span>{events.length}건</span>{unresolved>0&&<small> · 선수 판정 대기 {unresolved}건</small>}</summary>
        <div className="fv-log-events" role="region" aria-label="기록된 교체 목록" tabIndex={0}>{events.map(e=><article key={e.id}>
        <div className="fv-log-event-head"><strong>{e.team==='home'?'홈':'어웨이'} · {props.names[e.team]}</strong><span className="fv-log-pending">{hasPlayerPair(e)?'기존 선수 연결':'선수 판정 대기'}</span></div>
        <button type="button" onClick={()=>props.seek(e.time)} title="이 장면으로 이동">영상 {fmt(e.time)}{props.gameClockKnown&&<small>경기 {fmt(e.time-log!.video.from)}</small>}</button>
        {hasPlayerPair(e)&&<small>{label(e.outId)} → {label(e.inId)}</small>}{e.note&&<small>{e.note}</small>}
        <div className="row"><button disabled={disabled} onClick={()=>{setEditing(e.id);setTime(fmt(e.time));setTeam(e.team);setNote(e.note);if(editor.current)editor.current.open=true;}}>수정</button><button disabled={disabled} onClick={()=>safely(async()=>{if(await commit(removeSubstitution(workingLog(),e.id))&&editing===e.id)resetEvent();})}>삭제</button></div>
      </article>)}</div>
      </details>}
      {unresolved>0&&<p className="muted">선수 판정 대기 {unresolved}건 · 하단 경계의 출입·추적 기록과 대조할 시각입니다. 히트맵 분리는 아직 적용되지 않았습니다.</p>}
      {events.length>0&&<div className="row"><button onClick={()=>download('csv')}>교체 CSV</button><button onClick={()=>download('json')}>JSON 백업</button></div>}
    </>}
    <input ref={importer} type="file" hidden accept=".json" aria-label="교체 타임로그 JSON" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;safely(async()=>{if(file.size>5*1024*1024)throw Error('5MB 이하 JSON을 선택하세요.');const value=JSON.parse(await file.text());if(value.matchId&&value.matchId!==props.matchId)throw Error('다른 경기의 타임로그입니다.');const imported=value.sourceVideo?{...value,video:value.sourceVideo}:value;const next=validateSubstitutionLog(imported,props.video||undefined);if(log&&!confirm('현재 교체 타임로그를 이 파일로 바꿀까요?'))return;await commit(next);});}}/>
    <button className="btn-secondary" disabled={disabled||!props.video} onClick={()=>importer.current?.click()}>타임로그 JSON 불러오기</button>
    <p role={error?'alert':'status'} className={error?'fv-log-error':'muted'}>{error||message}</p>
  </section>;
}
