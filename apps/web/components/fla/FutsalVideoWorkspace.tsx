'use client';
import {useEffect,useRef,useState,type MouseEvent} from 'react';
import Link from 'next/link';
import {apiJson} from '../../lib/api';
import {VideoClock,formatVideoTime as fmt,videoHotkey,type Team} from '../../lib/fla-video-clock';
import {futsalPitchPoint} from '../../lib/futsal-pitch';
import {FutsalShotPitch,futsalShotThreat} from './FutsalShotPitch';
import AttackDirectionPitch from '../AttackDirectionPitch';
import {ResponsiveContainer,AreaChart,Area,XAxis,YAxis,CartesianGrid,Tooltip,ReferenceLine} from 'recharts';
import './fla-video.css';

type Lane='LEFT'|'CENTER'|'RIGHT';
const base='/futsal/fla-video';
export default function FutsalVideoWorkspace({id}:{id:string}){
  const video=useRef<HTMLVideoElement>(null),workspace=useRef<HTMLDivElement>(null),clock=useRef(new VideoClock());
  const [data,setData]=useState<any>(null),[uploads,setUploads]=useState<any[]>([]),[uploadId,setUploadId]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[mediaTime,setMediaTime]=useState(0),[duration,setDuration]=useState(0);
  const [,render]=useState(0),[lane,setLane]=useState<Lane>('CENTER'),[shot,setShot]=useState<{x:number;y:number}|null>(null);
  const [expanded,setExpanded]=useState(false);
  const [goal,setGoal]=useState(false),[ownGoal,setOwnGoal]=useState(false),[player,setPlayer]=useState(''),[buffering,setBuffering]=useState(false);
  const lastPaint=useRef(0);
  const saving=useRef<Promise<void>|null>(null),client=useRef(''),restoring=useRef<number|null>(null),lastMedia=useRef(0),eventBusy=useRef(false),writable=useRef(false);
  const request=async(path:string,body?:unknown,method='POST')=>apiJson<any>(`${base}${path}`,body===undefined?undefined:{method,body:JSON.stringify(body)});
  const redraw=()=>render(n=>n+1);
  const merge=(next:any)=>setData((old:any)=>({...old,...next}));
  const fail=(e:unknown)=>{video.current?.pause();clock.current.playing=false;setError(e instanceof Error?e.message:String(e));redraw();};
  useEffect(()=>{
    let alive=true;client.current=sessionStorage.getItem('fla-video-client:'+id)||crypto.randomUUID();sessionStorage.setItem('fla-video-client:'+id,client.current);
    Promise.all([request(`/matches/${id}`),request('/fixtures')]).then(([match,list])=>{
      if(!alive)return;writable.current=match.can_write;clock.current=new VideoClock(match.state);setData(match);setUploads(list.uploads);
      const candidate=new URLSearchParams(location.search).get('upload');setUploadId(match.state.upload_id||(list.uploads.some((u:any)=>u.id===candidate)?candidate:''));redraw();
    }).catch(fail);
    return()=>{alive=false;video.current?.pause();};
  },[id]);

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
    const timer=setInterval(()=>{if(clock.current.state.started&&!saving.current&&!document.hidden&&writable.current)void actions.current.flush().catch(()=>{});},2000);
    const hidden=()=>{if(document.hidden)video.current?.pause();};document.addEventListener('visibilitychange',hidden);
    const leaving=(e:BeforeUnloadEvent)=>{if(clock.current.pending.length){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',leaving);
    return()=>{cancelAnimationFrame(frame);clearInterval(timer);document.removeEventListener('visibilitychange',hidden);window.removeEventListener('beforeunload',leaving);};
  },[]);

  async function configure(){
    const v=video.current;if(!v||!Number.isFinite(v.duration))return;
    setBusy(true);setError('');try{
      const next=await request(`/matches/${id}/config`,{upload_id:uploadId,offset_ms:Math.round(v.currentTime*1000),duration_ms:Math.floor(v.duration*1000),version:clock.current.state.version},'PUT');
      clock.current=new VideoClock(next.state);merge(next);setNotice(`영상 ${fmt(next.state.offset_ms)}를 경기 00:00으로 저장했습니다.`);redraw();
    }catch(e){fail(e);}finally{setBusy(false);}
  }
  async function start(){
    const v=video.current;if(!v||!clock.current.state.upload_id||busy)return;
    setBusy(true);try{v.pause();clock.current.state.cursor_ms=0;restoring.current=clock.current.state.offset_ms;v.currentTime=restoring.current/1000;await flush('start');await v.play();}catch(e){fail(e);}finally{setBusy(false);}
  }
  async function toggle(){
    const v=video.current;if(!v||busy||error)return;
    try{if(v.paused)await v.play();else v.pause();}catch(e){fail(e);}
  }
  function choose(team:Team){
    if(!writable.current)return;sample();clock.current.choose(team);setPlayer('');redraw();
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
    if(eventBusy.current||!writable.current||!clock.current.state.started||(type==='XG'&&!shot))return;
    sample();const s=clock.current.state;const selectedPlayer=players.find((p:any)=>`${p.number}|${p.name}`===player);
    const payload={event_id:crypto.randomUUID(),client_id:client.current,type,clock_ms:s.cursor_ms,team:s.selected_team,...(type==='ATTACK_LANE'?{lane}:{shot_x:shot!.x+20,shot_y:shot!.y,is_goal:goal,is_own_goal:ownGoal,player_name:selectedPlayer?.name||'',player_number:String(selectedPlayer?.number||'')})};
    eventBusy.current=true;setBusy(true);
    try{await flush();const next=await request(`/matches/${id}/events`,payload);merge(next);setNotice(`${fmt(payload.clock_ms)} · ${type==='XG'?'슈팅':'공격'} 기록 저장`);if(type==='XG'){setShot(null);setGoal(false);setOwnGoal(false);}}
    catch(e){fail(e);}finally{eventBusy.current=false;setBusy(false);}
  }
  async function fullscreen(){
    if(document.fullscreenElement){await document.exitFullscreen();return;}
    if(expanded){setExpanded(false);return;}
    if(document.fullscreenEnabled&&workspace.current?.requestFullscreen){
      try{await workspace.current.requestFullscreen();return;}catch{}
    }
    setExpanded(true);
  }
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setExpanded(false);};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[]);
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
  const players=data?.match.lineups?.teams?.[s.selected_team]||[];
  const totals={HOME:0,AWAY:0,NONE:0,...data?.possession};for(const seg of clock.current.pending)totals[seg.team]+=seg.end_ms-seg.start_ms;
  const total=totals.HOME+totals.AWAY,homePct=total?100*totals.HOME/total:0,awayPct=total?100*totals.AWAY/total:0;
  const status=error?'저장 확인 필요':buffering?'영상 불러오는 중':!s.started?'경기 시작 준비':s.ended?'기록 완료 · 이벤트 보완':review?'이벤트 추가 · 점유 기록 안 함':playing?'기록 중':'일시정지';
  const glow=s.started&&!error&&!buffering?(playing&&!s.ended?'recording':'paused'):'idle';
  const csv=()=>{const rows=['start_ms,end_ms,team',...(data?.segments||[]).map((p:any)=>`${p.start_ms},${p.end_ms},${p.team}`)];const url=URL.createObjectURL(new Blob([rows.join('\n')],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='fla-possession.csv';a.click();URL.revokeObjectURL(url);};
  if(!data)return <p role="status">{error||'경기 불러오는 중…'}</p>;
  return <div className={`fv-workspace${expanded?' fv-expanded':''}`} ref={workspace} data-state={glow}>
    {process.env.NEXT_PUBLIC_FLA_VIDEO_PREVIEW==='1'?<div className="fv-preview">로컬 검토 · 운영 데이터에 저장되지 않습니다 · 현재 영상은 기능 확인용 샘플입니다.</div>:null}
    <header className="fv-top"><div className="fv-match-name"><Link href="/admin/futsal/fla/video">← 경기 목록</Link><strong>{names.HOME} <span className="muted">vs</span> {names.AWAY}</strong><small className="muted">{data.match.fixture?.stage} {data.match.fixture?.round}경기 · {data.match.fixture?.court}구장</small></div><div className="fv-timer"><span role="status">{status}</span><strong aria-label="경기 시간">{fmt(s.cursor_ms)}</strong>{review?<small>마지막 기록 {fmt(s.frontier_ms)}</small>:null}</div><div className="row">{!s.started?<button className="btn-primary" onClick={start} disabled={!canWrite||!s.upload_id||busy}>경기 시작</button>:<><button onClick={toggle} disabled={Boolean(error)} className="btn-primary">{playing?'일시정지':'재생'} <kbd>Space</kbd></button>{!s.ended?<button className="btn-secondary" disabled={busy} onClick={async()=>{video.current?.pause();try{await flush('finish');setNotice('점유 기록을 마쳤습니다. 과거 장면에 이벤트를 추가할 수 있습니다.');}catch{}}}>기록 종료</button>:null}</>}<button className="btn-secondary" aria-label="작업 전체화면" onClick={()=>void fullscreen()}>⛶</button></div></header>
    {error?<div className="fv-error" role="alert">{error}<button onClick={()=>{setError('');void flush().catch(()=>{});}}>저장 다시 시도</button></div>:null}
    <div className="fv-body"><section className="fv-video-column" aria-label="경기 영상">
      {!s.started?<div className="fv-source"><label>{process.env.NEXT_PUBLIC_FLA_VIDEO_PREVIEW==='1'?'로컬 샘플 영상':'S3 경기 영상'}<select aria-label="경기 영상 선택" value={uploadId} onChange={e=>{video.current?.pause();setUploadId(e.target.value);setDuration(0);}} disabled={!canWrite}><option value="">영상을 선택하세요</option>{uploads.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label><button className="btn-secondary" onClick={configure} disabled={!canWrite||!duration||busy}>현재 장면을 경기 시작으로</button>{s.upload_id?<small>시작 기준 · 영상 {fmt(s.offset_ms)}</small>:null}</div>:null}
      <div className="fv-player">{uploadId?<video key={uploadId} ref={video} src={`/api/futsal/fla-video/uploads/${uploadId}/source`} playsInline preload="metadata"
        onLoadedMetadata={()=>{const v=video.current!;setDuration(v.duration*1000);clock.current.state.duration_ms=Math.floor(v.duration*1000);const target=s.upload_id===uploadId?s.offset_ms+s.cursor_ms:0;restoring.current=target;lastMedia.current=target;v.currentTime=target/1000;v.playbackRate=s.rate;setMediaTime(target);setBuffering(false);}}
        onPlay={()=>{clock.current.playing=true;redraw();}}
        onPlaying={()=>{setBuffering(false);clock.current.playing=true;redraw();}}
        onPause={()=>{sample();clock.current.playing=false;redraw();if(s.started)void flush().catch(()=>{});}}
        onWaiting={()=>setBuffering(true)}
        onSeeking={()=>{const v=video.current!;const target=v.currentTime*1000;if(restoring.current!==null&&Math.abs(target-restoring.current)<3)return;if(s.started&&target>lastMedia.current+3){restoring.current=lastMedia.current;v.currentTime=lastMedia.current/1000;setNotice('앞으로 이동할 수 없습니다.');return;}v.pause();clock.current.seek(target);lastMedia.current=target;redraw();}}
        onSeeked={()=>{restoring.current=null;sample();setBuffering(false);}}
        onEnded={()=>{clock.current.playing=false;void flush(s.started&&!s.ended?'finish':'save').catch(()=>{});redraw();}}
        onError={()=>{setBuffering(false);setError('영상을 재생하지 못했습니다. 연결을 다시 불러오거나 영상 형식을 확인하세요.');}} />:<div className="fv-video-empty"><span>▷</span><strong>기록할 영상을 선택하세요</strong><p>S3 업로드 영상을 경기와 연결합니다.</p></div>}</div>
      <div className="fv-player-controls"><button aria-label="영상 재생 정지" onClick={toggle} disabled={!uploadId||Boolean(error)}>{playing?'Ⅱ':'▶'}</button><button aria-label="5초 뒤로" onClick={()=>rewind(mediaTime-5000)}>−5초</button><span>{fmt(mediaTime)}</span><input aria-label="영상 탐색" type="range" min={s.started?s.offset_ms:0} max={duration||1} value={Math.min(mediaTime,duration||1)} step={33} onChange={e=>rewind(Number(e.target.value))}/><span>{fmt(duration)}</span><select aria-label="재생 배속" value={s.rate} onChange={e=>{sample();s.rate=Number(e.target.value);if(video.current)video.current.playbackRate=s.rate;redraw();}}>{[.5,.75,1,1.25,1.5,2,3,4].map(r=><option key={r} value={r}>{r}×</option>)}</select></div>
      <div className="fv-player-note"><span><kbd>Space</kbd> 재생/정지 · <kbd>Q W E</kbd> 점유 · <kbd>A S D</kbd> 공격 위치</span><span>{s.started?'앞으로 탐색 잠금':'시작 장면을 지정하세요'}</span></div>
      <div className="fv-notice" role="status">{notice}</div>
    </section>
    <aside className="fv-inputs" aria-label="FLA 기록 입력" tabIndex={-1}>
      <section className="card"><div className="row"><h3>점유 팀</h3><span className="muted">{review?'점유 기록 유지':names[s.possession_team]}</span></div><div className="fv-possession"><span>{names.HOME}</span><strong>{homePct.toFixed(1)}% : {awayPct.toFixed(1)}%</strong><span>{names.AWAY}</span></div><div className="fv-team-buttons">{(['HOME','AWAY','NONE'] as Team[]).map((t,i)=><button key={t} className={(review?s.selected_team:s.possession_team)===t?'btn-active':'btn-secondary'} aria-pressed={(review?s.selected_team:s.possession_team)===t} disabled={!canWrite} onClick={()=>choose(t)}>{names[t]} <kbd>{['Q','W','E'][i]}</kbd></button>)}</div><small className="muted">{review?'팀 선택은 추가 이벤트에만 적용됩니다.':`유효 점유 ${fmt(total)} · 루즈볼 ${fmt(totals.NONE)}`}</small></section>
      <section className="card"><h3>공격 방향 기록</h3><div className="fv-control-row"><span>홈 공격 방향</span><div>{(['L2R','R2L'] as const).map(d=><button key={d} disabled={!canWrite} className={s.direction===d?'btn-active':'btn-secondary'} onClick={()=>{s.direction=d;redraw();}}>{d==='L2R'?'오른쪽 →':'← 왼쪽'}</button>)}</div></div><div className="fv-control-row"><span>기록 팀</span><div>{(['HOME','AWAY'] as const).map(t=><button key={t} disabled={!canWrite} className={s.selected_team===t?'btn-active':'btn-secondary'} onClick={()=>{s.selected_team=t;setPlayer('');redraw();}}>{names[t]}</button>)}</div></div><div className="fv-control-row"><span>공격 위치</span><div>{(['LEFT','CENTER','RIGHT'] as Lane[]).map((l,i)=><button key={l} className={lane===l?'btn-active':'btn-secondary'} onClick={()=>setLane(l)}>{['왼쪽','중앙','오른쪽'][i]} <kbd>{['A','S','D'][i]}</kbd></button>)}</div></div><button className="btn-primary" onClick={()=>addEvent('ATTACK_LANE')} disabled={!canWrite||!s.started||busy}>공격 기록 <kbd>Enter</kbd></button><AttackDirectionPitch homeDirection={s.direction} team={s.selected_team} teamName={names[s.selected_team]} lane={lane}/></section>
      <section className="card"><h3>슈팅 위협도 기록</h3><div className="row"><select aria-label="슈팅 기록 팀" value={s.selected_team} onChange={e=>{s.selected_team=e.target.value as 'HOME'|'AWAY';setPlayer('');redraw();}}><option value="HOME">{names.HOME}</option><option value="AWAY">{names.AWAY}</option></select><select aria-label="슈팅 선수" value={player} onChange={e=>setPlayer(e.target.value)}><option value="">{players.length?'선수 선택 (선택)':'선수 미지정'}</option>{players.map((p:any)=><option key={`${p.number}|${p.name}`} value={`${p.number}|${p.name}`}>No.{p.number} {p.name}</option>)}</select></div><div className="row"><button aria-pressed={goal} className={goal?'btn-active':'btn-secondary'} onClick={()=>{setGoal(!goal);setOwnGoal(false);}}>골</button><button aria-pressed={ownGoal} className={ownGoal?'btn-active':'btn-secondary'} onClick={()=>{setOwnGoal(!ownGoal);setGoal(false);}}>OG</button><span className="fv-shot-value">Shot Threat <strong>{shot&&!ownGoal?futsalShotThreat(shot.x+20,shot.y).toFixed(3):'—'}</strong></span></div>{ownGoal?<small className="muted">기록 팀은 자책골로 점수를 얻는 팀입니다.</small>:null}<button className="btn-primary fv-wide" disabled={!canWrite||!s.started||!shot||busy} onClick={()=>addEvent('XG')}>슈팅 기록</button><FutsalShotPitch shotPoint={shot} isOnTarget={false} onClick={(e:MouseEvent<HTMLDivElement>)=>{if(!canWrite)return;const r=e.currentTarget.getBoundingClientRect();setShot(futsalPitchPoint((e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height));}}/></section>
      <section className="card"><h3>최근 기록 <span className="muted">{data.events.length}</span></h3>{data.events.slice(0,30).map((e:any)=><div className="fv-log" key={e.id}><time>{fmt(e.clock_ms)}</time><strong>{names[e.team as 'HOME'|'AWAY']}</strong><span>{e.type==='ATTACK_LANE'?`공격 · ${{LEFT:'왼쪽',CENTER:'중앙',RIGHT:'오른쪽'}[e.lane as Lane]}`:e.is_own_goal?'자책골':e.is_goal?'골':'슈팅'}</span></div>)}{!data.events.length?<p className="muted">아직 기록이 없습니다.</p>:null}</section>
      <section className="card"><div className="row"><h3>점유 타임라인</h3><button className="btn-secondary" disabled={!data.segments.length} onClick={csv}>CSV</button></div>{data.segments.slice(-20).reverse().map((p:any,i:number)=><div key={i} className="fv-log"><time>{fmt(p.start_ms)}–{fmt(p.end_ms)}</time><span>{names[p.team as Team]}</span></div>)}</section>
      <section className="card"><h3>경기 흐름 · 1분 단위</h3><div style={{height:210,width:'100%'}}><ResponsiveContainer><AreaChart data={(data.flow||[]).map((b:any)=>({...b,minute:b.start_ms/60000}))}><CartesianGrid strokeDasharray="3 3" stroke="#ffffff15"/><XAxis dataKey="minute"/><YAxis domain={[-1,1]} width={28}/><Tooltip/><ReferenceLine y={0} stroke="#888"/><Area type="monotone" dataKey="dominance" stroke="#ff7400" fill="#ff740030"/></AreaChart></ResponsiveContainer></div></section>
    </aside></div>
  </div>;
}
