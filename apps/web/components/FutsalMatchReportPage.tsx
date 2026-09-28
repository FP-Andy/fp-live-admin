'use client';

import { toPng } from 'html-to-image';
import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type ReactElement } from 'react';
import { apiJson } from '../lib/api';
import { useSportContext } from './SportContext';
import { paintHeatmap } from '../public/fpa-cv/heatmap-render.mjs';
import { saveReport, loadReport, listReports } from '../public/fpa-cv/report-store.mjs';
import { attachHeatmap, attackDirection, blankPlayer, commentDraft, emptyDraft, eventKind, eventPoint, parseFpaSource, reportEvents, restoreDraft, spatialSummary, validateHeatmap, POSITIONS, POSITION_LABEL, type HeatSource, type HeatPlayer, type PlayerText, type ReportDraft, type Direction } from '../lib/futsal-report';
import { safeName } from './futsal/graphics';
import type { FpaEvent } from './futsal/fpaGraphics';
import './futsal-match-report.css';

type Match={id:string;name:string;metadata?:{home_team?:string;away_team?:string;lineups?:{teams?:Record<string,Array<{number:string;name:string;position?:string}>>}}};
const errorText=(e:unknown)=>e instanceof Error?e.message:'작업을 완료하지 못했습니다.';
const time=(n:number)=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
function downloadJSON(value:unknown,name:string){const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function Field({label,children}:{label:string;children:ReactNode}){return <label className="mr-field"><span>{label}</span>{isValidElement(children)?cloneElement(children as ReactElement,{'aria-label':label}):children}</label>;}
function Pitch({source,player,events,direction,kind}:{source:HeatSource|null;player?:HeatPlayer;events:FpaEvent[];direction:Direction;kind:'heat'|'events'}){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{const c=ref.current;if(!c)return;c.width=1320;
  if(kind==='heat'&&source&&player)paintHeatmap(c,source,player);
  else paintHeatmap(c,{width:80,height:40,scale:1},{grid:Array(3200).fill(0)});
  if(kind==='events'){
   const ctx=c.getContext('2d')!,unit=c.width/44;
   events.forEach(e=>{const p=eventPoint(e,direction);if(!p)return;const x=(2+p.x)*unit,y=(2+p.y)*unit,r=9;
    ctx.fillStyle=eventKind(e)==='shot'?'#A13067':'#E162A7';ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();
    if(eventKind(e)==='shot')ctx.arc(x,y,r,0,Math.PI*2);else for(let i=0;i<10;i++){const angle=-Math.PI/2+i*Math.PI/5,rad=i%2?r*.45:r;const px=x+Math.cos(angle)*rad,py=y+Math.sin(angle)*rad;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath();ctx.fill();ctx.stroke();
   });
  }
 },[source,player,events,direction,kind]);
 return <canvas ref={ref} aria-label={kind==='heat'?'선수 활동 히트맵':'볼 회수·슈팅 이벤트맵'} />;
}

export default function FutsalMatchReportPage(){
 const {sport,setSport}=useSportContext();
 const [draft,setDraft]=useState<ReportDraft|null>(null),[matches,setMatches]=useState<Match[]>([]),[matchChoice,setMatchChoice]=useState('');
 const [saved,setSaved]=useState<Array<{id:string;title:string;updatedAt:string}>>([]),[notice,setNotice]=useState(''),[saveState,setSaveState]=useState(''),[busy,setBusy]=useState(false),[exporting,setExporting]=useState(false),[scale,setScale]=useState(1);
 const preview=useRef<HTMLDivElement>(null),sheet=useRef<HTMLDivElement>(null),latest=useRef<ReportDraft|null>(null),loadTicket=useRef(0);
 latest.current=draft;
 useEffect(()=>{if(sport!=='FUTSAL')setSport('FUTSAL');},[sport,setSport]);
 function activate(d:ReportDraft){setDraft(d);setMatchChoice(d.matchId);const u=new URL(location.href);u.searchParams.set('report',d.id);history.replaceState(history.state,'',u);}
 async function openSaved(id:string){const raw=await loadReport(id) as {kind?:string;heatmap?:unknown;fpa?:unknown;id:string}|undefined;if(!raw)throw Error('저장된 리포트가 없습니다. JSON 파일을 불러오세요.');
  if(raw.kind==='source'){let d=attachHeatmap(emptyDraft(),validateHeatmap(raw.heatmap));d={...d,id:raw.id,fpa:raw.fpa?parseFpaSource(raw.fpa):null,fpaLabel:'트래킹 작업 화면의 FPA 로그',homeName:String((raw.fpa as Record<string,unknown>)?.teamid_h||''),awayName:String((raw.fpa as Record<string,unknown>)?.teamid_a||'')};activate(d);}else activate(restoreDraft(raw));
 }
 useEffect(()=>{let active=true;(async()=>{
  try{const items=await listReports();if(active)setSaved(items);const id=new URLSearchParams(location.search).get('report');if(id){if(active)await openSaved(id);}else if(active)activate(emptyDraft());}
  catch(e){if(active){setNotice(errorText(e));activate(emptyDraft());}}
 })();return()=>{active=false;};},[]);
 useEffect(()=>{let active=true;(async()=>{const all:Match[]=[];let total=1;while(all.length<total){const page=await apiJson<{items:Match[];total:number}>(`/matches/page?sport=FUTSAL&limit=100&offset=${all.length}&compact=false`);if(!active)return;all.push(...page.items);total=page.total;if(!page.items.length)break;}setMatches(all);})().catch(()=>{if(active)setNotice('경기 목록을 불러오지 못했습니다. 파일 불러오기와 직접 입력은 사용할 수 있습니다.');});return()=>{active=false;};},[]);
 useEffect(()=>{if(!draft)return;setSaveState('저장 대기');const timer=setTimeout(()=>{const record={...draft,updatedAt:new Date().toISOString()};void saveReport(record).then(()=>{if(latest.current?.id!==record.id)return;setSaveState('이 브라우저에 저장됨');setSaved(old=>[{id:record.id,title:record.title,updatedAt:record.updatedAt},...old.filter(r=>r.id!==record.id)]);}).catch(e=>{setSaveState('저장 실패 · JSON 저장을 이용하세요');setNotice(errorText(e));});},800);return()=>clearTimeout(timer);},[draft]);
 useEffect(()=>{if(!draft||!preview.current)return;const node=preview.current;const update=()=>setScale(Math.min(1,Math.max(.25,(node.clientWidth-2)/900)));const ro=new ResizeObserver(update);ro.observe(node);update();return()=>ro.disconnect();},[!!draft]);
 const person=draft?.players[draft.selected]||blankPlayer(),heatPlayer=draft?.heatmap?.players.find(p=>p.id===draft.selected),direction=draft?attackDirection(draft,person):'right';
 const events=useMemo(()=>draft?reportEvents(draft.fpa,person,draft.homeName,draft.awayName):[],[draft?.fpa,person.side,person.eventNumber,draft?.homeName,draft?.awayName]);
 const spatial=useMemo(()=>spatialSummary(draft?.heatmap||null,heatPlayer,direction),[draft?.heatmap,heatPlayer,direction]);
 const patch=(value:Partial<ReportDraft>)=>setDraft(d=>d?{...d,...value}:d);
 const patchPlayer=(value:Partial<PlayerText>)=>setDraft(d=>d?{...d,players:{...d.players,[d.selected]:{...d.players[d.selected],...value}}}:d);
 async function importFile(file:File|undefined,kind:'heat'|'fpa'|'draft'){
  if(!file||!draft)return;try{if(file.size>100*1024*1024)throw Error('100MB 이하 JSON 파일을 선택하세요.');const raw=JSON.parse(await file.text());
   if(kind==='draft'){const restored=restoreDraft(raw);await saveReport({...draft,updatedAt:new Date().toISOString()});activate({...restored,id:crypto.randomUUID()});}
   else if(kind==='heat'){const h=validateHeatmap(raw);if(draft.heatmap&&!window.confirm('선수별 문구와 기존 히트맵을 새 좌표로 바꿉니다. 계속할까요?'))return;await saveReport({...draft,updatedAt:new Date().toISOString()});setDraft(d=>d?attachHeatmap(d,h):d);}
   else patch({fpa:parseFpaSource(raw),fpaLabel:file.name,matchId:''});
   setNotice('파일을 불러왔습니다. 경기·선수 연결을 확인하세요.');
  }catch(e){setNotice(errorText(e));}
 }
 async function importMatch(){if(!draft||!matchChoice)return;const ticket=++loadTicket.current,targetId=draft.id;setBusy(true);setNotice('');
  try{const [logs,match,snapshot]=await Promise.all([apiJson<unknown>(`/fpa/matches/${matchChoice}/logs`),apiJson<Match>(`/matches/${matchChoice}`),apiJson<{match:{home:{score:number};away:{score:number}}}>(`/broadcast/matches/${matchChoice}/snapshot`).catch(()=>null)]);
   if(ticket!==loadTicket.current||latest.current?.id!==targetId)return;
   const fpa=parseFpaSource(logs),parts=match.name.replace(/^\[[^\]]*\]\s*/,'').split(/\s+vs\.?\s+/i);
   setDraft(d=>{if(!d||d.id!==targetId)return d;const players=Object.fromEntries(Object.entries(d.players).map(([id,p])=>{const lineup=match.metadata?.lineups?.teams?.[p.side.toUpperCase()]||[];const found=lineup.find(l=>String(l.number)===p.eventNumber);return [id,{...p,name:p.name||found?.name||'',position:p.position||(POSITIONS.includes(found?.position||'')?found?.position||'':'')}];}));return {...d,players,fpa,fpaLabel:match.name,matchId:match.id,matchName:match.name,homeName:match.metadata?.home_team||parts[0]||'',awayName:match.metadata?.away_team||parts[1]||'',homeScore:Number.isFinite(snapshot?.match?.home?.score)?String(snapshot!.match.home.score):'',awayScore:Number.isFinite(snapshot?.match?.away?.score)?String(snapshot!.match.away.score):''};});
   setNotice(`FPA ${fpa.rows.length}행을 불러왔습니다. 히트맵과 같은 경기인지 확인하세요.${snapshot?'':' 스코어는 직접 입력하세요.'}`);
  }catch(e){setNotice(errorText(e));}finally{if(ticket===loadTicket.current)setBusy(false);}
 }
 function makeComments(){if(!draft)return;if([person.heatComment,person.eventComment,...person.strengths,...person.improvements].some(Boolean)&&!window.confirm('현재 선수의 코멘트를 데이터 기반 초안으로 바꿀까요?'))return;patchPlayer(commentDraft(draft.heatmap,heatPlayer,person,events,direction));setNotice('데이터 기반 초안을 만들었습니다. 추가 메모를 참고해 문구를 편집하세요.');}
 async function exportPNG(){if(!sheet.current||!draft)return;setExporting(true);setNotice('');try{await document.fonts.ready;const png=await toPng(sheet.current,{backgroundColor:'#EFCADE',width:900,height:sheet.current.scrollHeight,pixelRatio:2,style:{zoom:'1',width:'900px',maxWidth:'none'},fontEmbedCSS:''});const a=document.createElement('a');a.href=png;a.download=`${safeName(draft.matchName||draft.title)}-${safeName(person.name||person.jersey||'선수')}-report.png`;a.click();}catch(e){setNotice(`PNG 생성 실패: ${errorText(e)}`);}finally{setExporting(false);}}
 if(!draft)return <p role="status">리포트 작업실을 여는 중입니다.</p>;
 const ownName=person.side==='home'?draft.homeName:draft.awayName,opponent=person.side==='home'?draft.awayName:draft.homeName,ownScore=person.side==='home'?draft.homeScore:draft.awayScore,opponentScore=person.side==='home'?draft.awayScore:draft.homeScore;
 const hasScore=/^\d+$/.test(ownScore)&&/^\d+$/.test(opponentScore),result=hasScore?Number(ownScore)>Number(opponentScore)?'WIN':Number(ownScore)<Number(opponentScore)?'LOSE':'DRAW':'';
 const reviews=[{key:'strengths' as const,title:'좋았던 장면',en:'STRENGTHS'},{key:'improvements' as const,title:'다음 경기를 위한 제안',en:'NEXT STEP'}];
 const fileInput=(kind:'heat'|'fpa'|'draft',label:string)=><Field label={label}><input aria-label={label} type="file" accept=".json,application/json" onChange={e=>{void importFile(e.target.files?.[0],kind);e.target.value='';}} /></Field>;
 return <main className="page-stack mr-page">
  <header className="mr-header"><div><div className="sidebar-eyebrow">FCM · FUTSAL</div><h1>매치 리포트</h1><p className="muted">데이터를 연결하고, 선수에게 전할 이야기를 완성하세요.</p></div><div className="mr-actions"><button type="button" onClick={()=>downloadJSON(draft,`${safeName(draft.title)}-report.json`)}>리포트 JSON 저장</button><button type="button" className="btn-primary" disabled={exporting||!person.jersey||!person.name} onClick={()=>void exportPNG()}>{exporting?'PNG 생성 중…':'리포트 PNG 다운로드'}</button></div></header>
  {notice&&<p role="status" className="mr-notice">{notice}</p>}
  <div className="mr-workspace"><aside className="mr-controls">
   <section className="card card-panel"><h2>리포트 작업</h2><Field label="저장된 작업"><select value={saved.some(s=>s.id===draft.id)?draft.id:''} onChange={e=>{const id=e.target.value;if(id)void saveReport({...draft,updatedAt:new Date().toISOString()}).then(()=>openSaved(id)).catch(err=>setNotice(errorText(err)));}}><option value="">새 작업</option>{saved.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></Field><Field label="작업 이름"><input value={draft.title} maxLength={120} onChange={e=>patch({title:e.target.value})}/></Field><div className="mr-actions"><button type="button" onClick={()=>void saveReport({...draft,updatedAt:new Date().toISOString()}).then(()=>activate(emptyDraft())).catch(e=>setNotice(errorText(e)))}>새 리포트</button><small>{saveState}</small></div><p className="field-help">작업은 이 브라우저에 저장됩니다. 다른 기기로 옮길 때는 리포트 JSON을 사용하세요.</p>{fileInput('draft','리포트 JSON 불러오기')}</section>
   <section className="card card-panel"><h2>데이터 연결</h2>{fileInput('heat','히트맵 좌표·품질 JSON')}<small className="mr-source">{draft.heatmap?`${draft.heatmap.video} · ${draft.heatmap.resultVersion??'—'}차 결과`:'FPA 트래킹의 히트맵 탭에서도 바로 보낼 수 있습니다.'}</small><Field label="FPC 풋살 경기"><select value={matchChoice} disabled={busy} onChange={e=>setMatchChoice(e.target.value)}><option value="">경기 선택</option>{matches.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></Field><button type="button" disabled={!matchChoice||busy} onClick={()=>void importMatch()}>{busy?'불러오는 중…':'경기 정보·FPA 불러오기'}</button><details><summary>FPA 파일로 연결</summary>{fileInput('fpa','FPA 로그·검수 JSON')}</details><small className="mr-source">{draft.fpa?`${draft.fpaLabel} · ${draft.fpa.rows.length}행`:'FPA 기록 미연결'}</small></section>
   <section className="card card-panel"><h2>선수</h2>{draft.heatmap&&<Field label="히트맵 선수"><select value={draft.selected} onChange={e=>patch({selected:e.target.value})}>{draft.heatmap.players.map(p=><option key={p.id} value={p.id}>{p.group==='home'?'홈':'어웨이'} #{p.jersey}{p.name?` ${p.name}`:''}</option>)}</select></Field>}<div className="mr-two"><Field label="리포트 등번호"><input value={person.jersey} maxLength={6} onChange={e=>patchPlayer({jersey:e.target.value})}/></Field><Field label="포지션"><select value={person.position} onChange={e=>patchPlayer({position:e.target.value})}>{POSITIONS.map(p=><option key={p} value={p}>{POSITION_LABEL[p]}</option>)}</select></Field></div><Field label="선수 이름"><input value={person.name} maxLength={40} onChange={e=>patchPlayer({name:e.target.value})}/></Field><div className="mr-two"><Field label="소속 팀"><select value={person.side} disabled={!!heatPlayer} onChange={e=>patchPlayer({side:e.target.value as PlayerText['side']})}><option value="home">홈</option><option value="away">어웨이</option></select></Field><Field label="FPA 기록 등번호"><input value={person.eventNumber} maxLength={6} onChange={e=>patchPlayer({eventNumber:e.target.value})}/></Field></div><p className="field-help">연결된 볼 회수·슈팅 {events.length}건 · 좌표 없음 {events.filter(e=>!e.points.length).length}건</p></section>
   <section className="card card-panel"><h2>경기 · 방향</h2><Field label="경기 이름"><input value={draft.matchName} maxLength={120} onChange={e=>patch({matchName:e.target.value})}/></Field><div className="mr-two"><Field label="홈 팀"><input value={draft.homeName} maxLength={40} onChange={e=>patch({homeName:e.target.value})}/></Field><Field label="어웨이 팀"><input value={draft.awayName} maxLength={40} onChange={e=>patch({awayName:e.target.value})}/></Field><Field label="홈 스코어"><input type="number" min="0" max="99" value={draft.homeScore} onChange={e=>patch({homeScore:e.target.value})}/></Field><Field label="어웨이 스코어"><input type="number" min="0" max="99" value={draft.awayScore} onChange={e=>patch({awayScore:e.target.value})}/></Field></div><Field label="히트맵 기준 홈 공격 방향"><select value={draft.homeDirection} onChange={e=>patch({homeDirection:e.target.value as Direction})}><option value="right">오른쪽 → · 어웨이 ←</option><option value="left">왼쪽 ← · 어웨이 →</option></select></Field><p className="field-help">코트 40 × 20m. 불러온 히트맵에서 홈이 공격하는 방향을 지정하세요. 이벤트는 기록된 방향을 기준으로 맞춥니다.</p></section>
   <section className="card card-panel"><h2>코멘트 편집</h2><Field label="포지션·전술 추가 메모 (리포트 미표시)"><textarea rows={2} maxLength={1000} value={person.context} onChange={e=>patchPlayer({context:e.target.value})} placeholder="예: 왼쪽 알라, 후반에는 픽소 역할"/></Field><button type="button" onClick={makeComments} disabled={!spatial&&!events.length}>데이터 기반 초안 만들기</button><p className="field-help">활동 분포·기록된 이벤트에 따른 기본 문구입니다. 메모를 참고해 직접 다듬어 주세요.</p><Field label="히트맵 코멘트"><textarea rows={5} maxLength={650} value={person.heatComment} onChange={e=>patchPlayer({heatComment:e.target.value})}/></Field><Field label="이벤트맵 코멘트"><textarea rows={5} maxLength={650} value={person.eventComment} onChange={e=>patchPlayer({eventComment:e.target.value})}/></Field>{reviews.map(r=><div key={r.key}><h3>{r.title}</h3>{person[r.key].map((v,i)=><Field key={i} label={`${r.title} ${i+1}`}><textarea rows={2} maxLength={220} value={v} onChange={e=>patchPlayer({[r.key]:person[r.key].map((old,n)=>n===i?e.target.value:old)})}/></Field>)}</div>)}</section>
  </aside>
  <section className="mr-preview" aria-label="리포트 미리보기"><div className="mr-preview-bar"><span>출력 미리보기</span><small>PNG · 1800px · 문구 길이에 따라 높이 조절</small></div><div ref={preview} className="mr-preview-viewport"><div className="mr-sheet" ref={sheet} style={{zoom:scale} as CSSProperties}>
   <header className="mr-sheet-top"><span>FINE PLAY · QUEEN CUP</span><span>PLAYER MATCH REPORT</span></header>
   <div className="mr-player-heading"><span className="mr-number">{person.jersey?`NO. ${person.jersey}`:'NO. —'}</span><h1>{person.name||'선수 이름'}{person.position&&<span className="mr-position">{person.position}</span>}</h1><p>{draft.matchName||'경기 이름'}</p></div>
   <div className="mr-match-band"><div><small>OPPONENT</small><strong>{opponent||'상대 팀'}</strong></div><div className="mr-score"><strong>{opponentScore||'—'} <i>:</i> {ownScore||'—'}</strong>{result&&<span>{result}</span>}</div><div className="mr-own-team"><small>MY TEAM</small><strong>{ownName||'소속 팀'}</strong></div></div>
   <section className="mr-map-section"><div className="mr-map-panel"><div className="mr-map-heading"><h2>HEAT MAP</h2><span>{direction==='right'?'공격 방향 →':'← 공격 방향'}</span></div><Pitch kind="heat" source={draft.heatmap} player={heatPlayer} events={events} direction={direction}/><small>{spatial?`유효 관측 ${(spatial.coverage*100).toFixed(1)}% · 영상 ${time(draft.heatmap!.from)}–${time(draft.heatmap!.to)}`:'히트맵 데이터 미연결'}</small></div><div className="mr-comment"><h3>활동 이야기</h3><p>{person.heatComment||'히트맵 코멘트를 입력하세요.'}</p></div></section>
   <section className="mr-map-section"><div className="mr-map-panel"><div className="mr-map-heading"><h2>EVENT MAP</h2><span>★ 볼 회수 · ● 슈팅</span></div><Pitch kind="events" source={draft.heatmap} events={events} direction={direction}/><small>{draft.fpa?`선택한 FPA 기록 전체 · 표시 ${events.filter(e=>e.points.length).length}건 · 좌표 없음 ${events.filter(e=>!e.points.length).length}건`:'FPA 데이터 미연결'}</small></div><div className="mr-comment"><h3>플레이 이야기</h3><p>{person.eventComment||'이벤트맵 코멘트를 입력하세요.'}</p></div></section>
   <section className="mr-review"><div className="mr-review-heading"><h2>MATCH REVIEW</h2><span>한 경기의 기록, 다음 경기를 위한 힌트</span></div><div className="mr-review-grid">{reviews.map(r=><div key={r.key}><h3><small>{r.en}</small>{r.title}</h3><ol>{person[r.key].map((text,i)=><li key={i}><span>{String(i+1).padStart(2,'0')}</span><p>{text||'—'}</p></li>)}</ol></div>)}</div></section>
   <footer className="mr-sheet-footer"><strong>FINE PLAY ANALYTICS</strong><span>40 × 20m · 관측·기록된 구간 기준{draft.heatmap?.resultVersion?` · CV ${draft.heatmap.resultVersion}차`:''}</span></footer>
  </div></div></section></div>
 </main>;
}
