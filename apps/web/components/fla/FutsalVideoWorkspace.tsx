'use client';
import {useEffect,useRef,useState,type MouseEvent} from 'react';
import Link from 'next/link';
import {apiJson} from '../../lib/api';
import {VideoClock,formatVideoTime as fmt,videoHotkey,type Team} from '../../lib/fla-video-clock';
import {bufferedSeconds,sameVideoFile} from '../../lib/video-buffer';
import {futsalPitchPoint} from '../../lib/futsal-pitch';
import {futsalShotThreat} from './FutsalShotPitch';
import {MatchPossessionCard,MatchAttackCard,MatchShotCard,MatchRecentRecords,MatchPossessionTimeline,MatchFlowCard} from './MatchControlCards';
import './fla-video.css';

type Lane='LEFT'|'CENTER'|'RIGHT';
type ResetKind='possession'|'events'|'recording';
const base='/futsal/fla-video';
export default function FutsalVideoWorkspace({id}:{id:string}){
  const video=useRef<HTMLVideoElement>(null),workspace=useRef<HTMLDivElement>(null),clock=useRef(new VideoClock());
  const [data,setData]=useState<any>(null),[uploads,setUploads]=useState<any[]>([]),[uploadId,setUploadId]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusyState]=useState(false),[mediaTime,setMediaTime]=useState(0),[duration,setDuration]=useState(0);
  const [,render]=useState(0),[lane,setLane]=useState<Lane>('CENTER'),[shot,setShot]=useState<{x:number;y:number}|null>(null);
  const [showSetup,setShowSetup]=useState(false),[startTime,setStartTime]=useState('00:00.000');
  const [xgValue,setXgValue]=useState('0.10'),[estimateNotice,setEstimateNotice]=useState('');
  const [goalmouth,setGoalmouth]=useState<{x:number;y:number}|null>(null),[timelineFrom,setTimelineFrom]=useState(0);
  const [shotTeam,setShotTeam]=useState<'HOME'|'AWAY'>('HOME');
  const [expanded,setExpanded]=useState(false);
  const [pendingReset,setPendingReset]=useState<ResetKind|null>(null);
  const resetDialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=resetDialog.current;if(!dialog)return;if(pendingReset&&!dialog.open)dialog.showModal();else if(!pendingReset&&dialog.open)dialog.close();},[pendingReset]);
  const [goal,setGoal]=useState(false),[ownGoal,setOwnGoal]=useState(false),[player,setPlayer]=useState(''),[buffering,setBuffering]=useState(false);
  const [localSource,setLocalSource]=useState(''),[mediaError,setMediaError]=useState(''),[sourceRetry,setSourceRetry]=useState(0),[bufferAhead,setBufferAhead]=useState(0);
  const resumeAt=useRef<number|null>(null),localPicker=useRef<HTMLInputElement>(null);
  useEffect(()=>()=>{if(localSource)URL.revokeObjectURL(localSource);},[localSource]);
  function switchPlayback(file?:File){
    if(file&&!sameVideoFile(file,uploads.find(u=>u.id===uploadId)||{})){setNotice('연결된 원본과 파일명·용량이 같은 영상을 선택하세요. 편집본은 시간 기준이 달라 사용할 수 없습니다.');return;}
    const v=video.current;if(v){sample();resumeAt.current=v.currentTime*1000;v.pause();}clock.current.playing=false;
    if(clock.current.state.started)void flush().catch(()=>{});
    setMediaError('');setBuffering(false);setBufferAhead(0);setLocalSource(file?URL.createObjectURL(file):'');setSourceRetry(n=>n+1);
    setNotice(file?'내 컴퓨터 원본으로 전환했습니다. 재생을 누르면 같은 시각에서 이어집니다.':'S3 원본을 다시 연결합니다.');
  }
  function updateBuffer(){const v=video.current;if(v)setBufferAhead(bufferedSeconds(v.buffered,v.currentTime,v.playbackRate));}
  const controlBusy=useRef(false);
  const setBusy=(value:boolean)=>{controlBusy.current=value;setBusyState(value);};
  const lastPaint=useRef(0);
  const saving=useRef<Promise<void>|null>(null),client=useRef(''),restoring=useRef<number|null>(null),lastMedia=useRef(0),eventBusy=useRef(false),writable=useRef(false);
  const request=async(path:string,body?:unknown,method='POST')=>apiJson<any>(`${base}${path}`,body===undefined?undefined:{method,body:JSON.stringify(body)});
  const redraw=()=>render(n=>n+1);
  const merge=(next:any)=>setData((old:any)=>({...old,...next}));
  const fail=(e:unknown)=>{video.current?.pause();clock.current.playing=false;setError(e instanceof Error?e.message:String(e));redraw();};
  useEffect(()=>{
    let alive=true;client.current=sessionStorage.getItem('fla-video-client:'+id)||crypto.randomUUID();sessionStorage.setItem('fla-video-client:'+id,client.current);
    Promise.all([request(`/matches/${id}`),request('/fixtures')]).then(([match,list])=>{
      if(!alive)return;writable.current=match.can_write;clock.current=new VideoClock(match.state);setData(match);setUploads(list.uploads);setShowSetup(!match.state.started);setStartTime(mediaLabel(match.state.offset_ms||0));setShotTeam(match.state.selected_team||'HOME');
      const candidate=new URLSearchParams(location.search).get('upload');setUploadId(match.state.upload_id||(list.uploads.some((u:any)=>u.id===candidate)?candidate:''));redraw();
    }).catch(fail);
    return()=>{alive=false;video.current?.pause();};
  },[id]);

  // Match the existing transport to the video's intrinsic box, including when
  // the available height changes. No wrapper or recording-state layout is added.
  useEffect(()=>{
    const media=video.current;
    const column=media?.closest<HTMLElement>('.fv-video-column');
    if(!media||!column)return;
    const fit=()=>{
      column.style.setProperty('--fv-media-ratio',`${media.videoWidth||16} / ${media.videoHeight||9}`);
      const width=media.getBoundingClientRect().width;if(width>0)column.style.setProperty('--fv-media-width',`${width}px`);
    };
    const observer=new ResizeObserver(fit);observer.observe(media);fit();
    return()=>{observer.disconnect();column.style.removeProperty('--fv-media-width');column.style.removeProperty('--fv-media-ratio');};
  },[uploadId,localSource,sourceRetry]);

  function sample(){
    const v=video.current;if(!v||v.seeking)return;
    lastMedia.current=v.currentTime*1000;clock.current.tick(lastMedia.current);
    const state=clock.current.state;
    if(state.ended&&!v.paused&&lastMedia.current>=state.offset_ms+state.frontier_ms){
      clock.current.playing=false;v.pause();restoring.current=state.offset_ms+state.frontier_ms;v.currentTime=restoring.current/1000;
    }
    if(v.paused||performance.now()-lastPaint.current>100){setMediaTime(v.currentTime*1000);redraw();lastPaint.current=performance.now();}
  }
  async function flush(action:'start'|'save'|'finish'='save'){
    while(saving.current){await saving.current;}
    if(!writable.current||(!clock.current.state.started&&action==='save'))return;
    const captured=clock.current.snapshot();
    const payload={request_id:crypto.randomUUID(),client_id:client.current,version:captured.version,action,cursor_ms:captured.cursor_ms,frontier_ms:captured.frontier_ms,
      possession_team:captured.possession_team,selected_team:captured.selected_team,direction:captured.direction,rate:captured.rate,segments:captured.segments};
    const run=(async()=>{
      // Repeat the same ID on a transport failure; the server deduplicates it.
      let next;try{next=await request(`/matches/${id}/recording`,payload);}catch(e){if(e instanceof TypeError)next=await request(`/matches/${id}/recording`,payload);else throw e;}
      clock.current.acknowledge(next.state.version,captured.frontier_ms);clock.current.state.started=next.state.started;clock.current.state.ended=next.state.ended;merge(next);redraw();
    })();saving.current=run;
    try{await run;}catch(e){fail(e);throw e;}finally{if(saving.current===run)saving.current=null;}
  }
  const actions=useRef({flush,sample});actions.current={flush,sample};
  useEffect(()=>{
    let frame=0;const tick=()=>{if(video.current&&!video.current.paused&&!video.current.seeking){actions.current.sample();}frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
    const timer=setInterval(()=>{if(clock.current.state.started&&!saving.current&&!controlBusy.current&&!document.hidden&&writable.current)void actions.current.flush().catch(()=>{});},2000);
    const hidden=()=>{if(document.hidden)video.current?.pause();};document.addEventListener('visibilitychange',hidden);
    const leaving=(e:BeforeUnloadEvent)=>{if(clock.current.pending.length){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',leaving);
    return()=>{cancelAnimationFrame(frame);clearInterval(timer);document.removeEventListener('visibilitychange',hidden);window.removeEventListener('beforeunload',leaving);};
  },[]);

  function mediaLabel(ms:number){const value=Math.round(ms);return `${fmt(value)}.${String(value%1000).padStart(3,'0')}`;}
  function parseStart(value:string){
    if(/^\d+(?:\.\d{1,3})?$/.test(value.trim()))return Math.round(Number(value)*1000);
    const parts=value.trim().match(/^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/);
    return parts?(Number(parts[1])*60+Number(parts[2]))*1000+Number((parts[3]||'').padEnd(3,'0')):NaN;
  }
  async function configure(){
    const v=video.current;if(!v||!Number.isFinite(v.duration))return;
    const offset=parseStart(startTime);
    if(!Number.isFinite(offset)||offset<0||offset>=v.duration*1000){setNotice('시작 시각을 영상 범위 안의 분:초 또는 초 단위로 입력하세요.');return;}
    v.pause();setBusy(true);setError('');try{
      const next=await request(`/matches/${id}/config`,{upload_id:uploadId,offset_ms:offset,duration_ms:Math.floor(v.duration*1000),version:clock.current.state.version},'PUT');
      clock.current=new VideoClock(next.state);merge(next);restoring.current=offset;lastMedia.current=offset;v.currentTime=offset/1000;setStartTime(mediaLabel(offset));setNotice(`영상 ${mediaLabel(offset)} → 경기 00:00으로 저장했습니다.`);redraw();
    }catch(e){fail(e);}finally{setBusy(false);}
  }
  async function start(){
    const v=video.current;if(!v||!clock.current.state.upload_id||busy)return;
    setBusy(true);try{v.pause();clock.current.state.cursor_ms=0;restoring.current=clock.current.state.offset_ms;v.currentTime=restoring.current/1000;await flush('start');setShowSetup(false);await v.play();}catch(e){fail(e);}finally{setBusy(false);}
  }
  async function toggle(){
    const v=video.current;if(!v||busy||error||mediaError)return;
    try{if(v.paused)await v.play();else v.pause();}catch(e){fail(e);}
  }
  function choose(team:Team){
    if(!writable.current||controlBusy.current)return;sample();clock.current.choose(team);if(team!=='NONE')setShotTeam(team);setPlayer('');redraw();
    if(clock.current.state.started)void flush().catch(()=>{});
  }
  function rewind(targetMs:number){
    const v=video.current;if(!v)return;sample();
    const min=clock.current.state.started?clock.current.state.offset_ms:0;
    const target=Math.max(min,Math.min(targetMs,v.duration*1000));
    if(clock.current.state.started&&target>v.currentTime*1000+.5){setNotice('기록 중에는 앞으로 이동할 수 없습니다.');return;}
    v.pause();clock.current.seek(target);restoring.current=target;lastMedia.current=target;v.currentTime=target/1000;setMediaTime(target);redraw();
  }
  async function addEvent(type:'ATTACK_LANE'|'XG'){
    if(eventBusy.current||!writable.current||!clock.current.state.started)return;
    if(type==='XG'&&ownGoal&&!shot){setEstimateNotice('피치에서 자책골 위치를 선택하세요.');return;}
    if(type==='XG'&&!ownGoal&&(!Number.isFinite(Number(xgValue))||xgValue.trim()===''||Number(xgValue)<0||Number(xgValue)>1)){setEstimateNotice('Shot Threat는 0~1 사이의 숫자로 입력해 주세요.');return;}
    if(type==='XG'&&goal&&!ownGoal&&!goalmouth){setEstimateNotice('골문에서 슈팅 도착 위치를 선택해 주세요.');return;}
    sample();const s=clock.current.state;const selectedPlayer=players.find((p:any)=>`${p.number}|${p.name}`===player);
    const payload={event_id:crypto.randomUUID(),client_id:client.current,type,clock_ms:s.cursor_ms,team:type==='XG'?shotTeam:s.selected_team,...(type==='ATTACK_LANE'?{lane}:{shot_x:shot?shot.x+20:null,shot_y:shot?.y??null,xg:ownGoal?0:Number(xgValue),goalmouth_x:goalmouth?.x,goalmouth_y:goalmouth?.y,is_goal:goal,is_own_goal:ownGoal,player_name:selectedPlayer?.name||'',player_number:String(selectedPlayer?.number||'')})};
    eventBusy.current=true;setBusy(true);
    try{await flush();const next=await request(`/matches/${id}/events`,payload);merge(next);setNotice(`${fmt(payload.clock_ms)} · ${type==='XG'?'슈팅':'공격'} 기록 저장`);if(type==='XG'){setShot(null);setGoal(false);setOwnGoal(false);setGoalmouth(null);setPlayer('');setXgValue('0.10');setEstimateNotice('');}}
    catch(e){fail(e);}finally{eventBusy.current=false;setBusy(false);}
  }
  function reset(kind:ResetKind){
    if(!canWrite||busy)return;
    video.current?.pause();setPendingReset(kind);
  }
  async function confirmReset(){
    const kind=pendingReset;
    if(!kind||!canWrite||busy)return;
    setPendingReset(null);setBusy(true);
    try{
      await flush();const state=clock.current.state;
      const next=await request(`/matches/${id}/reset`,{request_id:crypto.randomUUID(),client_id:client.current,version:state.version,kind});
      clock.current=new VideoClock(next.state);merge(next);setError('');
      if(kind==='recording'||kind==='possession')setTimelineFrom(0);
      if(kind==='recording'||kind==='events'){setShot(null);setGoalmouth(null);setGoal(false);setOwnGoal(false);setPlayer('');setXgValue('0.10');setEstimateNotice('');}
      if(kind==='recording'){setStartTime(mediaLabel(next.state.offset_ms));restoring.current=next.state.offset_ms;lastMedia.current=next.state.offset_ms;setMediaTime(next.state.offset_ms);if(video.current)video.current.currentTime=next.state.offset_ms/1000;}
      setNotice(kind==='recording'?'모든 기록을 초기화했습니다. 경기 시작을 눌러 다시 기록하세요.':'초기화했습니다.');redraw();
    }catch(e){fail(e);}finally{setBusy(false);}
  }
  function selectTeam(team:'HOME'|'AWAY'){clock.current.state.selected_team=team;setShotTeam(team);setPlayer('');redraw();}
  function estimate(){if(!shot){setEstimateNotice('피치에서 슈팅 위치를 먼저 선택하세요.');return;}const value=futsalShotThreat(shot.x+20,shot.y);setXgValue(value.toFixed(3));setEstimateNotice(`Shot Threat=${value.toFixed(3)} / 0.800 · 골문 거리·각도 기반`);}
  async function fullscreen(){
    if(document.fullscreenElement){await document.exitFullscreen();return;}
    if(expanded){setExpanded(false);return;}
    if(document.fullscreenEnabled&&workspace.current?.requestFullscreen){
      try{await workspace.current.requestFullscreen();return;}catch{}
    }
    setExpanded(true);
  }
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!document.querySelector('dialog[open]'))setExpanded(false);};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[]);
  const keys=useRef({toggle,choose,addEvent});keys.current={toggle,choose,addEvent};
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{
      const key=videoHotkey(event);if(!key||!writable.current||document.querySelector('[data-fla-text-edit="true"]'))return;
      // Capture first: native selects/buttons must not consume or double-fire reserved keys.
      event.preventDefault();event.stopImmediatePropagation();
      if(key==='Space')void keys.current.toggle();
      else if(key==='KeyQ')keys.current.choose('HOME');else if(key==='KeyW')keys.current.choose('AWAY');else if(key==='KeyE')keys.current.choose('NONE');
      else if(key==='Enter')void keys.current.addEvent('ATTACK_LANE');
      else setLane(({KeyA:'LEFT',KeyS:'CENTER',KeyD:'RIGHT'} as Record<string,Lane>)[key]);
    };window.addEventListener('keydown',onKey,true);return()=>window.removeEventListener('keydown',onKey,true);
  },[]);

  const s=clock.current.state,review=clock.current.reviewing,playing=clock.current.playing,canWrite=Boolean(data?.can_write);
  const names={HOME:data?.match.home||'Home',AWAY:data?.match.away||'Away',NONE:'루즈볼'};
  const players=data?.match.lineups?.teams?.[shotTeam]||[];
  const totals={HOME:0,AWAY:0,NONE:0,...data?.possession};for(const seg of clock.current.pending)totals[seg.team]+=seg.end_ms-seg.start_ms;
  const total=totals.HOME+totals.AWAY,homePct=total?100*totals.HOME/total:0,awayPct=total?100*totals.AWAY/total:0;
  const status=error?'저장 확인 필요':mediaError?'영상 연결 확인':buffering?'영상 불러오는 중':!s.started?'경기 시작 준비':s.ended?'기록 완료 · 이벤트 보완':review?'이벤트 추가 · 점유 기록 안 함':playing?'기록 중':'일시정지';
  const glow=s.started&&!error&&!mediaError&&!buffering?(playing&&!s.ended?'recording':'paused'):'idle';
  const csv=()=>{const rows=['start_ms,end_ms,team',...(data?.segments||[]).map((p:any)=>`${p.start_ms},${p.end_ms},${p.team}`)];const url=URL.createObjectURL(new Blob([rows.join('\n')],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='fla-possession.csv';a.click();URL.revokeObjectURL(url);};
  const summary={events:data?.events||[],possession:{home_pct:homePct,away_pct:awayPct},lanes:Object.fromEntries((['HOME','AWAY'] as const).map(team=>{
    const events=(data?.events||[]).filter((e:any)=>e.type==='ATTACK_LANE'&&e.team===team);
    return [team.toLowerCase(),{total_count:events.length,...Object.fromEntries(['LEFT','CENTER','RIGHT'].map(l=>[l.toLowerCase()+'_pct',events.length?events.filter((e:any)=>e.lane===l).length/events.length*100:0]))}];
  }))};
  const chart=(data?.flow||[]).map((b:any,i:number,arr:any[])=>({...b,minuteVal:(i===arr.length-1?b.end_ms:b.start_ms)/60000,midpointMinuteVal:(b.start_ms+b.end_ms)/120000}));
  const series:any[]=[];chart.forEach((b:any,i:number)=>{const previous=chart[i-1];if(previous&&previous.dominance*b.dominance<0){series.push({minuteVal:previous.minuteVal+(b.minuteVal-previous.minuteVal)*(-previous.dominance)/(b.dominance-previous.dominance),dominance:0,positiveDominance:0,negativeDominance:0});}series.push({...b,positiveDominance:b.dominance>=0?b.dominance:null,negativeDominance:b.dominance<=0?b.dominance:null});});
  const timeline=(data?.segments||[]).filter((p:any)=>p.end_ms>timelineFrom).slice(-120).reverse().map((p:any)=>`${mediaLabel(p.start_ms)}–${mediaLabel(p.end_ms)} · ${names[p.team as Team]}`);
  if(!data)return <p role="status">{error||'경기 불러오는 중…'}</p>;
  return <div className={`fv-workspace${expanded?' fv-expanded':''}`} ref={workspace} data-state={glow}>
    {process.env.NEXT_PUBLIC_FLA_VIDEO_PREVIEW==='1'?<div className="fv-preview">로컬 검토 · 운영 데이터에 저장되지 않습니다 · 현재 영상은 기능 확인용 샘플입니다.</div>:null}
    <header className="fv-top">
      <div className="fv-match-name">
        <div className="fv-match-title"><Link href="/admin/futsal/fla/video" aria-label="경기 목록" title="경기 목록">←</Link><strong>{names.HOME} <span className="muted">vs</span> {names.AWAY}</strong></div>
        <div className="fv-match-meta"><small className="muted">{data.match.fixture?.stage} {data.match.fixture?.round}경기 · {data.match.fixture?.court}구장</small><button className="fv-setup-toggle" aria-label="경기 시작 시각 설정" aria-expanded={showSetup} aria-controls="fv-start-settings" onClick={()=>setShowSetup(!showSetup)}>시작 시각 {s.configured?mediaLabel(s.offset_ms):'설정'} {showSetup?'▴':'▾'}</button></div>
      </div>
      <div className="fv-timer"><strong aria-label="경기 시간">{fmt(s.cursor_ms)}</strong><div><span role="status">{status}</span>{review?<small>마지막 기록 {fmt(s.frontier_ms)}</small>:null}</div></div>
      <div className="fv-top-actions">{!s.started?<button className="btn-primary" onClick={start} disabled={!canWrite||!s.upload_id||!s.configured||uploadId!==s.upload_id||parseStart(startTime)!==s.offset_ms||busy}>경기 시작</button>:<><button onClick={toggle} disabled={Boolean(error)} className="btn-primary">{playing?'일시정지':'재생'} <kbd>Space</kbd></button><button className="btn-success" disabled={busy||s.ended} onClick={async()=>{video.current?.pause();try{await flush('finish');setNotice('점유 기록을 마쳤습니다. 과거 장면에 이벤트를 추가할 수 있습니다.');}catch{}}}>{s.ended?'기록 완료됨':'기록 완료'}</button></>}<button className="btn-danger fv-reset-button" disabled={!canWrite||busy} onClick={()=>reset('recording')}>기록 초기화</button><button className="btn-secondary" aria-label="작업 전체화면" onClick={()=>void fullscreen()}>⛶</button></div>
    </header>
    {error?<div className="fv-error" role="alert">{error}<button onClick={()=>{setError('');void flush().catch(()=>{});}}>저장 다시 시도</button></div>:null}
    {showSetup?<section id="fv-start-settings" className="fv-start-settings" aria-label="경기 시작 시각 설정">
      <div className="row"><strong>{s.configured?`영상 ${mediaLabel(s.offset_ms)} → 경기 00:00`:'킥오프 장면을 지정하고 저장하세요'}</strong>{s.started?<small>기록 중 · 시작 기준 고정</small>:null}</div>
      <div className="fv-start-fields">
        <label>{process.env.NEXT_PUBLIC_FLA_VIDEO_PREVIEW==='1'?'로컬 샘플 영상':'경기 영상'}<select aria-label="경기 영상 선택" value={uploadId} onChange={e=>{video.current?.pause();setLocalSource('');resumeAt.current=null;setMediaError('');setBufferAhead(0);setUploadId(e.target.value);setDuration(0);setStartTime('00:00.000');}} disabled={!canWrite||s.started}><option value="">영상을 선택하세요</option>{uploads.map(u=><option key={u.id} value={u.id}>{u.name}{u.legacy?' · 기존 분석 원본':''}</option>)}</select></label>
        <label>경기 시작 영상 시각<input aria-label="경기 시작 영상 시각" value={startTime} onChange={e=>setStartTime(e.target.value)} placeholder="00:30.000 또는 30" disabled={!canWrite||s.started}/></label>
        <button className="btn-secondary" disabled={!duration||s.started} onClick={()=>{video.current?.pause();setStartTime(mediaLabel(video.current!.currentTime*1000));}}>현재 영상 시각 가져오기</button>
        <button className="btn-primary" onClick={configure} disabled={!canWrite||!duration||s.started||busy}>시작 시각 저장</button>
        {s.started?<div className="fv-start-locked"><span>시작 기준을 바꾸려면 기존 기록을 초기화해야 합니다.</span><button className="btn-danger" disabled={!canWrite||busy} onClick={()=>void reset('recording')}>초기화 후 시작 시각 변경</button></div>:<small>킥오프 장면으로 이동해 시각을 가져오거나, 영상의 분:초 또는 초 값을 직접 입력하세요.</small>}
      </div>
    </section>:null}
    <div className="fv-body"><section className="fv-video-column" aria-label="경기 영상">

      <div className="fv-player">{uploadId?<video key={`${uploadId}:${sourceRetry}:${localSource}`} ref={video} src={localSource||`/api/futsal/fla-video/uploads/${uploadId}/source?retry=${sourceRetry}`} playsInline preload="auto"
        onLoadedMetadata={()=>{const v=video.current!;setDuration(v.duration*1000);clock.current.state.duration_ms=Math.floor(v.duration*1000);const target=resumeAt.current??(s.upload_id===uploadId?s.offset_ms+s.cursor_ms:0);resumeAt.current=null;restoring.current=target;lastMedia.current=target;v.currentTime=target/1000;v.playbackRate=s.rate;setMediaTime(target);setBuffering(false);}}
        onPlay={()=>{setMediaError('');redraw();}}
        onPlaying={()=>{setBuffering(false);clock.current.playing=true;redraw();}}
        onPause={()=>{sample();clock.current.playing=false;redraw();if(s.started)void flush().catch(()=>{});}}
        onWaiting={()=>{sample();clock.current.playing=false;setBuffering(true);redraw();}}
        onCanPlay={()=>{setBuffering(false);updateBuffer();}} onProgress={updateBuffer} onTimeUpdate={updateBuffer}
        onStalled={()=>{const v=video.current;if(v&&!v.paused&&v.readyState<3)setBuffering(true);}}
        onSeeking={()=>{const v=video.current!;const target=v.currentTime*1000;if(restoring.current!==null&&Math.abs(target-restoring.current)<3)return;if(s.started&&target>lastMedia.current+3){restoring.current=lastMedia.current;v.currentTime=lastMedia.current/1000;setNotice('앞으로 이동할 수 없습니다.');return;}v.pause();clock.current.seek(target);lastMedia.current=target;redraw();}}
        onSeeked={()=>{restoring.current=null;sample();setBuffering(false);updateBuffer();}}
        onEnded={()=>{clock.current.playing=false;void flush(s.started&&!s.ended?'finish':'save').catch(()=>{});redraw();}}
        onError={()=>{clock.current.playing=false;setBuffering(false);setMediaError('영상 연결이 끊겼습니다. 다시 연결하거나 내 컴퓨터 원본을 선택하세요.');redraw();}} />:<div className="fv-video-empty"><span>▷</span><strong>기록할 영상을 선택하세요</strong><p>S3 업로드 영상을 경기와 연결합니다.</p></div>}</div>
      <div className="fv-player-controls"><button aria-label="영상 재생 정지" onClick={toggle} disabled={!uploadId||Boolean(error||mediaError)}>{playing?'Ⅱ':'▶'}</button><button aria-label="5초 뒤로" onClick={()=>rewind(mediaTime-5000)}>−5초</button><span>{fmt(mediaTime)}</span><input aria-label="영상 탐색" type="range" min={s.started?s.offset_ms:0} max={duration||1} value={Math.min(mediaTime,duration||1)} step={33} onChange={e=>rewind(Number(e.target.value))}/><span>{fmt(duration)}</span><select aria-label="재생 배속" value={s.rate} onChange={e=>{sample();s.rate=Number(e.target.value);if(video.current)video.current.playbackRate=s.rate;updateBuffer();redraw();}}>{[.5,.75,1,1.25,1.5,2,3,4].map(r=><option key={r} value={r}>{r}×</option>)}</select></div>
      <div className="fv-player-note"><span><kbd>Space</kbd> 재생/정지 · <kbd>Q W E</kbd> 점유 · <kbd>A S D</kbd> 공격 위치</span><span>{s.started?'앞으로 탐색 잠금':'시작 장면을 지정하세요'}</span></div>
      {uploadId&&<div className="fv-source-controls"><small role="status">{localSource?'내 컴퓨터 원본':`S3 원본 · ${buffering?'버퍼링 중 · ':''}재생 준비 ${Math.floor(bufferAhead)}초`}</small><input ref={localPicker} type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" aria-label="내 컴퓨터 원본 선택" hidden onChange={e=>{const file=e.target.files?.[0];if(file)switchPlayback(file);e.target.value='';}}/><button disabled={busy} onClick={()=>localPicker.current?.click()}>내 컴퓨터 원본 사용</button>{(localSource||mediaError)&&<button disabled={busy} onClick={()=>switchPlayback()}>S3 다시 연결</button>}</div>}
      {mediaError&&<div className="fv-error" role="alert">{mediaError}</div>}
      <div className="fv-notice" role="status">{notice}</div>
    </section>
    <aside className="fv-inputs fla-video-match-controls" aria-label="FLA 기록 입력" tabIndex={-1}>
      <MatchPossessionCard possessionTeam={s.possession_team} matchTeams={{homeTeam:names.HOME,awayTeam:names.AWAY}} summary={summary} canWrite={canWrite} isResettingPossession={busy} resetPossession={()=>void reset('possession')} changePossession={choose}/>
      {review?<div className="fla-feedback">이벤트 추가 · 점유 기록 안 함 · 기존 점유 팀은 유지됩니다.</div>:null}
      <MatchAttackCard attackLR={s.direction} selectedTeam={s.selected_team} pendingLane={lane} matchTeams={{homeTeam:names.HOME,awayTeam:names.AWAY}} summary={summary} canWrite={canWrite} canRecord={canWrite&&s.started&&!busy} changeAttackDirection={d=>{s.direction=d;redraw();if(s.started)void flush().catch(()=>{});}} selectEventTeam={selectTeam} setPendingLane={setLane} sendLane={()=>void addEvent('ATTACK_LANE')}/>
      <MatchShotCard isFutsal={true} xgTeam={shotTeam} setXgTeam={t=>{setShotTeam(t);setPlayer('');}} xgPlayerKey={player} setXgPlayerKey={setPlayer} xgPlayerOptions={players}
        isOnTargetShot={goal&&!ownGoal} setIsOnTargetShot={()=>{}} isGoalShot={goal} setIsGoalShot={v=>{setGoal(v);setOwnGoal(false);}} isHeaderShot={false} setIsHeaderShot={()=>{}} isOwnGoal={ownGoal} setIsOwnGoal={v=>{setOwnGoal(v);setGoal(false);setGoalmouth(null);}}
        shotPoint={shot} goalmouthPoint={goalmouth} canWrite={canWrite} canRecord={canWrite&&s.started&&!busy} xgValue={xgValue} setXgValue={setXgValue} xgotValue="0.000" estimateXgFromPitch={estimate} estimateXgotFromGoalmouth={()=>{}} submitXg={()=>void addEvent('XG')} isSavingShot={busy}
        onGoalmouthClick={e=>{const r=e.currentTarget.getBoundingClientRect();setGoalmouth({x:Number(Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)).toFixed(3)),y:Number(Math.max(0,Math.min(1,1-(e.clientY-r.top)/r.height)).toFixed(3))});}}
        onPitchClick={(e:MouseEvent<HTMLDivElement>)=>{if(!canWrite)return;const r=e.currentTarget.getBoundingClientRect();setShot(futsalPitchPoint((e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height));setEstimateNotice('');}} xgEstimateMeta={estimateNotice} xgotEstimateMeta=""/>
      <MatchRecentRecords summary={summary} canWrite={canWrite} isResettingEvents={busy} resetEvents={()=>void reset('events')} displayClockLabel={fmt}/>
      <MatchPossessionTimeline possessionLogs={timeline} downloadPossessionCsv={csv} resetPossessionLogView={()=>setTimelineFrom(s.frontier_ms)}/>
      <MatchFlowCard isFutsal={true} dominanceChartData={chart} dominanceXAxisTicks={(data.flow||[]).map((b:any)=>b.start_ms/60000)} formatDominanceTick={v=>String(Math.round(v))} dominanceMeta={null} dominanceSeriesData={series}/>
    </aside></div>
    <dialog ref={resetDialog} className="fv-reset-dialog" role="alertdialog" aria-labelledby="fv-reset-title" aria-describedby="fv-reset-description" data-fla-text-edit={pendingReset?'true':undefined} onCancel={()=>setPendingReset(null)}>
      <h2 id="fv-reset-title">{pendingReset==='recording'?'전체 기록을 초기화할까요?':pendingReset==='possession'?'점유율을 초기화할까요?':'이벤트 기록을 초기화할까요?'}</h2>
      <strong>{names.HOME} vs {names.AWAY}</strong>
      <p id="fv-reset-description">{pendingReset==='recording'?'점유율, 공격 방향, 슈팅·골, 경기 진행 기록을 모두 삭제합니다. 영상과 경기 시작 시각 설정은 유지됩니다.':pendingReset==='possession'?'점유율 기록을 삭제하고 0:0부터 다시 집계합니다. 공격 방향과 슈팅·골 기록은 유지됩니다.':'공격 방향과 슈팅·골 기록을 모두 삭제합니다. 점유율 기록은 유지됩니다.'}<br/>삭제한 기록은 되돌릴 수 없습니다.</p>
      <div className="fv-reset-actions"><button className="btn-secondary" onClick={()=>setPendingReset(null)}>취소</button><button className="btn-danger fv-reset-button" onClick={()=>void confirmReset()}>{pendingReset==='recording'?'전체 기록 초기화':'초기화'}</button></div>
    </dialog>
  </div>;
}
