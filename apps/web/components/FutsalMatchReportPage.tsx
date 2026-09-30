'use client';

import { toPng } from 'html-to-image';
import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type ReactElement } from 'react';
import { apiJson } from '../lib/api';
import { useSportContext } from './SportContext';
import { saveReport, loadReport, listReports } from '../public/fpa-cv/report-store.mjs';
import { listAnalysisSnapshots, loadAnalysisSnapshot, type AnalysisSnapshotSummary } from '../public/fpa-cv/analysis-snapshots.mjs';
import { attachHeatmap, blankPlayer, emptyDraft, parseFpaSource, restoreDraft, updateSnapshotSource, phaseSummary, spatialSummary, validateHeatmap, POSITIONS, POSITION_LABEL, type PlayerText, type ReportDraft, type Direction } from '../lib/futsal-report';
import { teamLogo } from '../lib/futsal-team-logos';
import { REPORT_WIDTH, REPORT_HEIGHT, reportPDF, reportOverflow, reportFontCSS } from '../lib/report-pdf';
import { safeName } from './futsal/graphics';
import PlayerReportSheet from './futsal/PlayerReportSheet';
import TeamReportSheet from './futsal/TeamReportSheet';
import {defaultTeamReport,matchComment,validateMatchReportData,type TeamReportOptions} from '../lib/futsal-team-report';
import type {Summary,Dominance,Shot} from './futsal/graphics';
import {reportPlayer} from '../lib/futsal-report-events';
import './futsal-match-report.css';

type Fixture={key:string;match_id:string|null;home:string;away:string;stage:string;round:number;court:string;date:string;video?:{started?:boolean;ended?:boolean}};
type Match={id:string;name:string;metadata?:{home_team?:string;away_team?:string;lineups?:{teams?:Record<string,Array<{number:string;name:string;position?:string}>>}}};
const errorText=(e:unknown)=>e instanceof Error?e.message:'작업을 완료하지 못했습니다.';
function downloadJSON(value:unknown,name:string){const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function Field({label,children}:{label:string;children:ReactNode}){return <label className="mr-field"><span>{label}</span>{isValidElement(children)?cloneElement(children as ReactElement,{'aria-label':label}):children}</label>;}

export default function FutsalMatchReportPage(){
 const {sport,setSport}=useSportContext();
 const [draft,setDraft]=useState<ReportDraft|null>(null),[matches,setMatches]=useState<Fixture[]>([]),[matchChoice,setMatchChoice]=useState('');
 const [snapshots,setSnapshots]=useState<AnalysisSnapshotSummary[]>([]),[snapshotChoice,setSnapshotChoice]=useState(''),[snapshotError,setSnapshotError]=useState('');
 const [reportView,setReportView]=useState<'player'|'team'>('player');
 const bundle=useRef<HTMLDivElement>(null);
 const [exportDraft,setExportDraft]=useState<ReportDraft|null>(null);
 const exportPlayers=useRef<string[]>([]);
 const [saved,setSaved]=useState<Array<{id:string;title:string;updatedAt:string}>>([]),[notice,setNotice]=useState(''),[saveState,setSaveState]=useState(''),[busy,setBusy]=useState(false),[exporting,setExporting]=useState(false),[scale,setScale]=useState(1),[overflow,setOverflow]=useState<string[]>([]);
 const preview=useRef<HTMLDivElement>(null),sheet=useRef<HTMLDivElement>(null),latest=useRef<ReportDraft|null>(null),loadTicket=useRef(0);
 latest.current=draft;
 useEffect(()=>{if(sport!=='FUTSAL')setSport('FUTSAL');},[sport,setSport]);
 function activate(d:ReportDraft){setDraft(d);setMatchChoice(d.matchId);setSnapshotChoice(d.sourceSnapshot?.id||'');const u=new URL(location.href);u.searchParams.delete('snapshot');u.searchParams.set('report',d.id);history.replaceState(history.state,'',u);}
 async function openSnapshot(id:string){
  const source=await loadAnalysisSnapshot(id);let d=attachHeatmap(emptyDraft(),validateHeatmap(source.heatmap));
  d={...d,title:`${source.title} · 확정 v${source.version}`,fpa:parseFpaSource(source.fpa),fpaLabel:`분석 완료 스냅샷 v${source.version}`,matchId:source.matchId||'',matchName:source.matchName,homeName:source.homeName,awayName:source.awayName,
   sourceSnapshot:{id:source.id,version:source.version,createdAt:source.createdAt,jobId:source.jobId},
   players:Object.fromEntries(Object.entries(d.players).map(([key,p])=>{const found=source.roster.find(r=>r.id===key);return [key,{...p,name:found?.name||p.name,position:POSITIONS.includes(found?.position||'')?found?.position||'':''}];}))};
  activate(d);setSnapshotChoice(id);setNotice(`확정 v${source.version}의 히트맵과 FPA ${d.fpa!.rows.length}행을 함께 불러왔습니다. 문구 수정은 원본 스냅샷을 변경하지 않습니다.`);
 }
 async function openSaved(id:string){const raw=await loadReport(id) as {kind?:string;heatmap?:unknown;fpa?:unknown;id:string}|undefined;if(!raw)throw Error('저장된 리포트가 없습니다. JSON 파일을 불러오세요.');
  if(raw.kind==='source'){let d=attachHeatmap(emptyDraft(),validateHeatmap(raw.heatmap));d={...d,id:raw.id,fpa:raw.fpa?parseFpaSource(raw.fpa):null,fpaLabel:'트래킹 작업 화면의 FPA 로그',homeName:String((raw.fpa as Record<string,unknown>)?.teamid_h||''),awayName:String((raw.fpa as Record<string,unknown>)?.teamid_a||'')};activate(d);}else activate(restoreDraft(raw));
 }
 useEffect(()=>{let active=true;(async()=>{
  try{const items=await listReports();if(active)setSaved(items);const params=new URLSearchParams(location.search),id=params.get('report'),snapshot=params.get('snapshot');if(snapshot){if(active)await openSnapshot(snapshot);}else if(id){if(active)await openSaved(id);}else if(active)activate(emptyDraft());}
  catch(e){if(active){setNotice(errorText(e));activate(emptyDraft());}}
 })();return()=>{active=false;};},[]);
 useEffect(()=>{let active=true,running=false;
  const refresh=async()=>{if(running||document.visibilityState==='hidden')return;running=true;try{
   const rows=await listAnalysisSnapshots();if(!active)return;setSnapshots(rows);setSnapshotError('');
   const current=latest.current;if(!current?.sourceSnapshot)return;
   const newer=rows.filter(s=>s.jobId===current.sourceSnapshot!.jobId&&s.version>current.sourceSnapshot!.version).sort((a,b)=>b.version-a.version)[0];
   if(!newer)return;const source=await loadAnalysisSnapshot(newer.id);if(!active)return;
   setDraft(d=>d?.id===current.id?updateSnapshotSource(d,source):d);
   if(latest.current?.id===current.id){setSnapshotChoice(newer.id);setNotice(`새 스냅샷 v${newer.version}으로 지도를 업데이트했습니다. 작성한 선수 정보와 코멘트는 유지했습니다.`);}
  }catch(e){if(active)setSnapshotError(errorText(e));}finally{running=false;}};
  const storage=(e:StorageEvent)=>{if(e.key==='fpc-analysis-snapshot-updated')void refresh();};
  const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('fpc-analysis-snapshots'):null;
  if(channel)channel.onmessage=()=>void refresh();
  const onFocus=()=>void refresh();window.addEventListener('focus',onFocus);window.addEventListener('storage',storage);document.addEventListener('visibilitychange',onFocus);
  const timer=setInterval(onFocus,15000);void refresh();
  return()=>{active=false;clearInterval(timer);channel?.close();window.removeEventListener('focus',onFocus);window.removeEventListener('storage',storage);document.removeEventListener('visibilitychange',onFocus);};
 },[draft?.id,!!draft?.sourceSnapshot]);
 useEffect(()=>{let active=true;apiJson<{fixtures:Fixture[]}>('/futsal/fla-video/fixtures').then(data=>{if(active)setMatches(data.fixtures);}).catch(()=>{if(active)setNotice('영상 기록 경기 목록을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.');});return()=>{active=false;};},[]);
 useEffect(()=>{if(!draft)return;setSaveState('저장 대기');const timer=setTimeout(()=>{const record={...draft,updatedAt:new Date().toISOString()};void saveReport(record).then(()=>{if(latest.current?.id!==record.id)return;setSaveState('이 브라우저에 저장됨');setSaved(old=>[{id:record.id,title:record.title,updatedAt:record.updatedAt},...old.filter(r=>r.id!==record.id)]);}).catch(e=>{setSaveState('저장 실패 · JSON 저장을 이용하세요');setNotice(errorText(e));});},800);return()=>clearTimeout(timer);},[draft]);
 useEffect(()=>{if(!draft||!preview.current)return;const node=preview.current;const update=()=>setScale(Math.min(1,Math.max(.25,(node.clientWidth-2)/REPORT_WIDTH)));const ro=new ResizeObserver(update);ro.observe(node);update();return()=>ro.disconnect();},[!!draft]);
 useEffect(()=>{if(!sheet.current)return;const node=sheet.current;const update=()=>setOverflow(reportOverflow(node));const ro=new ResizeObserver(update);ro.observe(node);const frame=requestAnimationFrame(update);void document.fonts.ready.then(update);return()=>{ro.disconnect();cancelAnimationFrame(frame);};},[draft,reportView]);
 const reportData=useMemo(()=>draft?reportPlayer(draft):null,[draft]);
 const person=reportData?.person||blankPlayer(),heatPlayer=reportData?.player,direction=reportData?.direction||'right',events=reportData?.map.personal||[];
 const matchStart=draft?.matchStartSeconds??draft?.fla?.videoStartSeconds??draft?.heatmap?.from??0;
 const phases=useMemo(()=>phaseSummary(draft?.heatmap||null,heatPlayer,direction,matchStart),[draft?.heatmap,heatPlayer,direction,matchStart]);
 const spatial=useMemo(()=>spatialSummary(draft?.heatmap||null,heatPlayer,direction),[draft?.heatmap,heatPlayer,direction]);
 const patch=(value:Partial<ReportDraft>)=>setDraft(d=>d?{...d,...value}:d);
 const patchPlayer=(value:Partial<PlayerText>)=>setDraft(d=>d?{...d,players:{...d.players,[d.selected]:{...d.players[d.selected],...value}}}:d);
 const teamOptions=draft?.teamReport||defaultTeamReport();
 const patchTeam=(value:Partial<TeamReportOptions>)=>setDraft(d=>d?{...d,teamReport:{...(d.teamReport||defaultTeamReport()),...value}}:d);
 const teamPlayers=draft?.heatmap?.players.filter(p=>p.group===teamOptions.side)||[];
 const chosenPlayers=(teamOptions.side==='home'?teamOptions.homePlayers:teamOptions.awayPlayers)??teamPlayers.slice(0,5).map(p=>p.id);
 const selectedPlayers=teamPlayers.filter(p=>chosenPlayers.includes(p.id));
 async function loadFla(automatic=false){
  if(!draft)return;const id=draft.matchId||matchChoice;if(!id)return;const target=draft.id,ticket=++loadTicket.current;setBusy(true);
  try{
   const [summary,dominance,video,match,score]=await Promise.all([
    apiJson<Summary>(`/matches/${id}/summary`),apiJson<Dominance>(`/matches/${id}/dominance?bin_seconds=60&split_halves=true`),
    apiJson<{match?:{archived?:boolean};state:{started?:boolean;ended?:boolean;configured?:boolean;offset_ms?:number};events?:Array<Shot&{clock_ms?:number}>}>(`/futsal/fla-video/matches/${id}`),apiJson<Match>(`/matches/${id}`),
    apiJson<{match:{home:{score:number};away:{score:number}}}>(`/broadcast/matches/${id}/snapshot`).catch(()=>null)]);
   const hasRecords=summary.possession.home_ms+summary.possession.away_ms>0||summary.lanes.home.total_count+summary.lanes.away.total_count>0||!!video.events?.length;
   const fla=validateMatchReportData({matchId:id,loadedAt:new Date().toISOString(),summary,dominance,started:!!video.state.started||hasRecords,ended:!!video.state.ended|| (!!video.match?.archived&&hasRecords),sourceKind:video.state.started?'video':hasRecords?'dashboard':'none',events:(video.events||[]).filter(e=>e.type==='XG'),videoStartSeconds:video.state.configured&&video.state.started?(video.state.offset_ms||0)/1000:undefined});
   if(ticket!==loadTicket.current||latest.current?.id!==target)return;
   setDraft(d=>d?.id===target?{...d,matchId:id,matchName:d.matchName||match.name,homeName:d.homeName||match.metadata?.home_team||'',awayName:d.awayName||match.metadata?.away_team||'',
    homeScore:hasRecords&&score?String(score.match.home.score):d.homeScore,awayScore:hasRecords&&score?String(score.match.away.score):d.awayScore,fla}:d);
   if(!automatic)setReportView('team');setNotice(hasRecords?`같은 경기의 ${fla.sourceKind==='video'?'영상 기록':'대시보드'} FLA를 연결했습니다. 공격 방향·점유율·슈팅·경기 흐름을 반영했습니다.`:'아직 이 경기에 FLA 기록이 없습니다.');
  }catch(e){setNotice(errorText(e));}finally{if(ticket===loadTicket.current)setBusy(false);}
 }
 useEffect(()=>{if(draft?.matchId&&!draft.fla)void loadFla(true);},[draft?.id,draft?.matchId]);
 async function exportBundle(){
  if(!draft||exporting||selectedPlayers.length!==5||!draft.fla||draft.fla.matchId!==draft.matchId)return;
  exportPlayers.current=selectedPlayers.map(p=>p.id);
  setExportDraft(draft);setExporting(true);setNotice('팀 리포트 6페이지를 만드는 중…');
  try{
   await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
   await document.fonts.ready;const fontEmbedCSS=await reportFontCSS();
   if(!bundle.current)throw Error('리포트 페이지를 준비하지 못했습니다. 다시 시도하세요.');
   const pages=Array.from(bundle.current.querySelectorAll<HTMLElement>('.mr-sheet'));if(pages.length!==6)throw Error('선수 5명을 선택하세요.');
   const pngs=[];
   for(const [i,node] of pages.entries()){
    const problems=reportOverflow(node);if(problems.length)throw Error(`${i+1}페이지의 문구를 줄여 주세요: ${problems.join(', ')}`);
    await Promise.all(Array.from(node.querySelectorAll('img')).map(img=>img.decode()));
    pngs.push(await toPng(node,{backgroundColor:'#FFFFFF',width:REPORT_WIDTH,height:REPORT_HEIGHT,pixelRatio:3,style:{zoom:'1',width:`${REPORT_WIDTH}px`,height:`${REPORT_HEIGHT}px`,maxWidth:'none'},fontEmbedCSS}));
    setNotice(`팀 리포트 ${i+1}/6페이지 생성`);
   }
   const name=`${safeName(draft.matchName||draft.title)}-${safeName(teamOptions.side==='home'?draft.homeName:draft.awayName)}-team-report`;
   const bytes=await reportPDF(pngs,name),url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),a=document.createElement('a');a.href=url;a.download=name+'.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);setNotice('경기 요약 1장과 선수 리포트 5장을 PDF로 저장했습니다.');
  }catch(e){setNotice(`내보내기 실패: ${errorText(e)}`);}finally{setExporting(false);setExportDraft(null);}
 }
 async function importFile(file:File|undefined,kind:'heat'|'fpa'|'draft'){
  if(!file||!draft)return;try{if(file.size>100*1024*1024)throw Error('100MB 이하 JSON 파일을 선택하세요.');const raw=JSON.parse(await file.text());
   if(kind==='draft'){const restored=restoreDraft(raw);await saveReport({...draft,updatedAt:new Date().toISOString()});activate({...restored,id:crypto.randomUUID()});}
   else if(kind==='heat'){const h=validateHeatmap(raw);if(draft.heatmap&&!window.confirm('선수별 문구와 기존 히트맵을 새 좌표로 바꿉니다. 계속할까요?'))return;await saveReport({...draft,updatedAt:new Date().toISOString()});setDraft(d=>d?attachHeatmap(d,h):d);}
   else patch({fpa:parseFpaSource(raw),fpaLabel:file.name,matchId:'',fla:undefined});
   setNotice('파일을 불러왔습니다. 경기·선수 연결을 확인하세요.');
  }catch(e){setNotice(errorText(e));}
 }
 async function importMatch(){if(!draft||!matchChoice)return;const ticket=++loadTicket.current,targetId=draft.id;setBusy(true);setNotice('');
  try{const [logs,match,snapshot]=await Promise.all([apiJson<unknown>(`/fpa/matches/${matchChoice}/logs`),apiJson<Match>(`/matches/${matchChoice}`),apiJson<{match:{home:{score:number};away:{score:number}}}>(`/broadcast/matches/${matchChoice}/snapshot`).catch(()=>null)]);
   if(ticket!==loadTicket.current||latest.current?.id!==targetId)return;
   const hasRecordedScore=!!matches.find(m=>m.match_id===matchChoice)?.video?.started;
   const fpa=parseFpaSource(logs),parts=match.name.replace(/^\[[^\]]*\]\s*/,'').split(/\s+vs\.?\s+/i);
   setDraft(d=>{if(!d||d.id!==targetId)return d;const players=Object.fromEntries(Object.entries(d.players).map(([id,p])=>{const lineup=match.metadata?.lineups?.teams?.[p.side.toUpperCase()]||[];const found=lineup.find(l=>String(l.number)===p.eventNumber);return [id,{...p,name:p.name||found?.name||'',position:p.position||(POSITIONS.includes(found?.position||'')?found?.position||'':'')}];}));return {...d,players,fpa,fla:d.matchId===match.id?d.fla:undefined,fpaLabel:match.name,matchId:match.id,matchName:match.name,homeName:match.metadata?.home_team||parts[0]||'',awayName:match.metadata?.away_team||parts[1]||'',homeScore:hasRecordedScore&&Number.isFinite(snapshot?.match?.home?.score)?String(snapshot!.match.home.score):'',awayScore:hasRecordedScore&&Number.isFinite(snapshot?.match?.away?.score)?String(snapshot!.match.away.score):''};});
   setNotice(`FPA ${fpa.rows.length}행을 불러왔습니다. 히트맵과 같은 경기인지 확인하세요.${snapshot&&hasRecordedScore?'':' 스코어는 직접 입력하세요.'}`);
  }catch(e){setNotice(errorText(e));}finally{if(ticket===loadTicket.current)setBusy(false);}
 }
 function makeComments(){if(!draft)return;if([reportData?.raw.heatComment,reportData?.raw.eventComment,...(reportData?.raw.strengths||[]),...(reportData?.raw.improvements||[])].some(Boolean)&&!window.confirm('현재 선수의 코멘트를 데이터 기반 초안으로 바꿀까요?'))return;if(reportData)patchPlayer(reportData.generated);setNotice('데이터 기반 초안을 만들었습니다. 추가 메모를 참고해 문구를 편집하세요.');}
 async function exportReport(format:'pdf'|'png'){
  if(!sheet.current||!draft)return;
  const node=sheet.current.querySelector<HTMLElement>('.mr-sheet');if(!node)return;setExporting(true);setNotice('');
  try{
   await document.fonts.ready;
   const problems=reportOverflow(node);
   if(problems.length)throw Error(`A4 한 장을 넘는 문구를 줄여 주세요: ${problems.join(', ')}`);
   await Promise.all(Array.from(node.querySelectorAll('img')).map(async img=>{try{await img.decode();}catch{throw Error(`${img.alt}를 불러오지 못했습니다. 다시 시도하세요.`);}}));
   const png=await toPng(node,{backgroundColor:'#FFFFFF',width:REPORT_WIDTH,height:REPORT_HEIGHT,pixelRatio:3,style:{zoom:'1',width:`${REPORT_WIDTH}px`,height:`${REPORT_HEIGHT}px`,maxWidth:'none'},fontEmbedCSS:await reportFontCSS()});
   const name=`${safeName(draft.matchName||draft.title)}-${safeName(person.name||person.jersey||'선수')}-report`;
   const a=document.createElement('a');
   if(format==='pdf'){
    const bytes=await reportPDF(png,name);const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));a.href=url;setTimeout(()=>URL.revokeObjectURL(url),30000);
   }else a.href=png;
   a.download=`${name}.${format}`;a.click();
  }catch(e){setNotice(`내보내기 실패: ${errorText(e)}`);}finally{setExporting(false);setExportDraft(null);}
 }
 if(!draft)return <p role="status">리포트 작업실을 여는 중입니다.</p>;
 const reviews=[{key:'strengths' as const,title:'좋았던 장면',en:'STRENGTHS'},{key:'improvements' as const,title:'다음 경기를 위한 제안',en:'NEXT STEP'}];
 const fileInput=(kind:'heat'|'fpa'|'draft',label:string)=><Field label={label}><input aria-label={label} type="file" disabled={kind!=='draft'&&!!draft.sourceSnapshot} accept=".json,application/json" onChange={e=>{void importFile(e.target.files?.[0],kind);e.target.value='';}} /></Field>;
 return <main className="page-stack mr-page">
  <header className="mr-header"><div><div className="sidebar-eyebrow">FCM · FUTSAL</div><h1>매치 리포트</h1><p className="muted">데이터를 연결하고, 선수에게 전할 이야기를 완성하세요.</p></div><div className="mr-actions"><button type="button" onClick={()=>downloadJSON(draft,`${safeName(draft.title)}-report.json`)}>리포트 JSON 저장</button><button type="button" disabled={exporting||!!overflow.length||(reportView==='player'&&(!person.jersey||!person.name))} onClick={()=>void exportReport('png')}>PNG</button><button type="button" className="btn-primary" disabled={exporting||!!overflow.length||(reportView==='player'&&(!person.jersey||!person.name))} onClick={()=>void exportReport('pdf')}>{exporting?'파일 생성 중…':'A4 PDF 다운로드'}</button></div></header>
  {notice&&<p role="status" className="mr-notice">{notice}</p>}
  <div className="mr-workspace"><aside className="mr-controls">
   <section className="card card-panel"><h2>팀 리포트 · 6페이지</h2>
    <Field label="리포트 기준 팀"><select value={teamOptions.side} disabled={exporting} onChange={e=>patchTeam({side:e.target.value as 'home'|'away'})}><option value="home">{draft.homeName||'홈 팀'} 기준</option><option value="away">{draft.awayName||'어웨이 팀'} 기준</option></select></Field>
    <div className="mr-two"><Field label={`${draft.homeName||'홈 팀'} 포인트 색상`}><input type="color" value={teamOptions.homeColor} onChange={e=>patchTeam({homeColor:e.target.value})}/></Field><Field label={`${draft.awayName||'어웨이 팀'} 포인트 색상`}><input type="color" value={teamOptions.awayColor} onChange={e=>patchTeam({awayColor:e.target.value})}/></Field></div>
    <button type="button" disabled={busy||exporting||!(draft.matchId||matchChoice)} onClick={()=>void loadFla()}>최신 FLA 기록 불러오기</button>
    <p className="field-help">{draft.fla?`${draft.fla.sourceKind==='dashboard'?'대시보드':draft.fla.sourceKind==='video'?'영상 기록':'FLA'} · ${draft.fla.started?'기록 연결됨':'기록 없음'} · ${new Date(draft.fla.loadedAt).toLocaleString('ko-KR')}`:'영상 기록 경기를 연결한 뒤 FLA 기록을 불러오세요.'}</p>
    <Field label="경기 총평"><textarea rows={5} maxLength={1400} value={teamOptions.side==='home'?teamOptions.homeComment:teamOptions.awayComment} placeholder={draft.fla?matchComment(draft.fla,teamOptions.side):'FLA 기록을 불러오면 데이터 기반 총평이 들어갑니다.'} onChange={e=>patchTeam({[teamOptions.side==='home'?'homeComment':'awayComment']:e.target.value})}/></Field>
    <button type="button" disabled={!draft.fla} onClick={()=>draft.fla&&patchTeam({[teamOptions.side==='home'?'homeComment':'awayComment']:matchComment(draft.fla,teamOptions.side)})}>데이터 기반 총평 넣기</button>
    <h3>함께 내보낼 선수 · {selectedPlayers.length}/5</h3><div className="mr-player-picks">{teamPlayers.map(p=><label key={p.id}><input type="checkbox" checked={chosenPlayers.includes(p.id)} disabled={exporting||(!chosenPlayers.includes(p.id)&&selectedPlayers.length>=5)} onChange={e=>patchTeam({[teamOptions.side==='home'?'homePlayers':'awayPlayers']:e.target.checked?[...chosenPlayers,p.id]:chosenPlayers.filter(id=>id!==p.id)})}/>{draft.players[p.id]?.name||`#${draft.players[p.id]?.jersey||p.jersey}`}</label>)}</div>
    <button type="button" className="btn-primary" disabled={exporting||!draft.fla||selectedPlayers.length!==5} onClick={()=>void exportBundle()}>{exporting?'PDF 만드는 중…':'팀 리포트 PDF · 6페이지'}</button>
   </section>
   <section className="card card-panel"><h2>완료된 분석</h2><Field label="완료된 분석 스냅샷"><select value={snapshotChoice} disabled={busy} onChange={e=>setSnapshotChoice(e.target.value)}><option value="">확정 결과 선택</option>{snapshots.filter(s=>!snapshots.some(other=>other.jobId===s.jobId&&other.version>s.version)).map(s=><option key={s.id} value={s.id}>{s.title} · v{s.version} · 유효 {(s.meanCoverage*100).toFixed(1)}% · FPA {s.eventCount}건</option>)}</select></Field><button type="button" disabled={!snapshotChoice||busy} onClick={()=>{setBusy(true);void (async()=>{if(draft)await saveReport({...draft,updatedAt:new Date().toISOString()});await openSnapshot(snapshotChoice);})().catch(e=>setNotice(errorText(e))).finally(()=>setBusy(false));}}>히트맵·이벤트맵 함께 불러오기</button>{snapshotError&&<p role="status" className="field-help">{snapshotError}</p>}{draft.sourceSnapshot?<p className="field-help">확정 v{draft.sourceSnapshot.version} · {new Date(draft.sourceSnapshot.createdAt).toLocaleString('ko-KR')}<br/>새 스냅샷 저장 시 지도가 자동 갱신됩니다. 작성한 선수 정보와 코멘트는 유지됩니다.</p>:<p className="field-help">FPA 히트맵에서 ‘분석 완료 판정’한 결과가 표시됩니다.</p>}</section>
   <section className="card card-panel"><h2>리포트 작업</h2><Field label="저장된 작업"><select value={saved.some(s=>s.id===draft.id)?draft.id:''} onChange={e=>{const id=e.target.value;if(id)void saveReport({...draft,updatedAt:new Date().toISOString()}).then(()=>openSaved(id)).catch(err=>setNotice(errorText(err)));}}><option value="">새 작업</option>{saved.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></Field><Field label="작업 이름"><input value={draft.title} maxLength={120} onChange={e=>patch({title:e.target.value})}/></Field><div className="mr-actions"><button type="button" onClick={()=>void saveReport({...draft,updatedAt:new Date().toISOString()}).then(()=>activate(emptyDraft())).catch(e=>setNotice(errorText(e)))}>새 리포트</button><small>{saveState}</small></div><p className="field-help">작업은 이 브라우저에 저장됩니다. 다른 기기로 옮길 때는 리포트 JSON을 사용하세요.</p>{fileInput('draft','리포트 JSON 불러오기')}</section>
   <section className="card card-panel"><h2>데이터 연결</h2>{fileInput('heat','히트맵 좌표·품질 JSON')}<small className="mr-source">{draft.heatmap?`${draft.heatmap.video} · ${draft.heatmap.resultVersion??'—'}차 결과`:'FPA 트래킹의 히트맵 탭에서도 바로 보낼 수 있습니다.'}</small><Field label={`영상 기록 대상 경기 · ${matches.length}경기`}><select value={matchChoice} disabled={busy} onChange={e=>setMatchChoice(e.target.value)}><option value="">경기 선택</option>{matches.map(m=><option key={m.key} value={m.match_id||''} disabled={!m.match_id}>{m.date.slice(5)} · {m.stage} {m.round}경기 · {m.court}구장 · {m.home} vs {m.away}{!m.match_id?' (미생성)':''}</option>)}</select></Field><button type="button" disabled={!matchChoice||busy||!!draft.sourceSnapshot} onClick={()=>void importMatch()}>{busy?'불러오는 중…':'경기 정보·FPA 불러오기'}</button><details><summary>FPA 파일로 연결</summary>{fileInput('fpa','FPA 로그·검수 JSON')}</details><small className="mr-source">{draft.fpa?`${draft.fpaLabel} · ${draft.fpa.rows.length}행`:'FPA 기록 미연결'}</small></section>
   <section className="card card-panel"><h2>선수</h2>{draft.heatmap&&<Field label="히트맵 선수"><select value={draft.selected} onChange={e=>patch({selected:e.target.value})}>{draft.heatmap.players.map(p=><option key={p.id} value={p.id}>{p.group==='home'?'홈':'어웨이'} #{p.jersey}{p.name?` ${p.name}`:''}</option>)}</select></Field>}<div className="mr-two"><Field label="리포트 등번호"><input value={person.jersey} maxLength={6} onChange={e=>patchPlayer({jersey:e.target.value})}/></Field><Field label="포지션"><select value={person.position} onChange={e=>patchPlayer({position:e.target.value})}>{POSITIONS.map(p=><option key={p} value={p}>{POSITION_LABEL[p]}</option>)}</select></Field></div><Field label="선수 이름"><input value={person.name} maxLength={40} onChange={e=>patchPlayer({name:e.target.value})}/></Field><div className="mr-two"><Field label="소속 팀"><select value={person.side} disabled={!!heatPlayer} onChange={e=>patchPlayer({side:e.target.value as PlayerText['side']})}><option value="home">홈</option><option value="away">어웨이</option></select></Field><Field label="FPA 기록 등번호"><input value={person.eventNumber} maxLength={6} onChange={e=>patchPlayer({eventNumber:e.target.value})}/></Field></div><Field label="FLA 실제 등번호 (선수 슈팅 강조)"><input value={person.flaNumber||''} maxLength={12} onChange={e=>patchPlayer({flaNumber:e.target.value})} placeholder="초기 인식 번호와 구분해 입력"/></Field><p className="field-help">연결된 수비·슈팅 {events.length}건 · 좌표 없음 {events.filter(e=>!e.points.length).length}건</p></section>
   <section className="card card-panel"><h2>경기 · 방향</h2><Field label="경기 이름"><input value={draft.matchName} maxLength={120} onChange={e=>patch({matchName:e.target.value})}/></Field><div className="mr-two"><Field label="홈 팀"><input value={draft.homeName} maxLength={40} onChange={e=>patch({homeName:e.target.value})}/></Field><Field label="어웨이 팀"><input value={draft.awayName} maxLength={40} onChange={e=>patch({awayName:e.target.value})}/></Field><Field label="홈 스코어"><input type="number" min="0" max="99" value={draft.homeScore} onChange={e=>patch({homeScore:e.target.value})}/></Field><Field label="어웨이 스코어"><input type="number" min="0" max="99" value={draft.awayScore} onChange={e=>patch({awayScore:e.target.value})}/></Field></div><p className="field-help">로고 · 홈: {teamLogo(draft.homeName)?'연결됨':'파일 없음 · 팀명 표시'} / 어웨이: {teamLogo(draft.awayName)?'연결됨':'파일 없음 · 팀명 표시'}</p><Field label="히트맵 기준 홈 공격 방향"><select value={draft.homeDirection} onChange={e=>patch({homeDirection:e.target.value as Direction})}><option value="right">오른쪽 → · 어웨이 ←</option><option value="left">왼쪽 ← · 어웨이 →</option></select></Field><p className="field-help">코트 40 × 20m. 불러온 히트맵에서 홈이 공격하는 방향을 지정하세요. 이벤트는 기록된 방향을 기준으로 맞춥니다.</p></section>
   <section className="card card-panel"><h2>시간대별 움직임</h2><Field label="경기 0:00에 해당하는 영상 시점 (초)"><input type="number" min="0" step="0.1" value={matchStart} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)&&n>=0)patch({matchStartSeconds:n});}}/></Field><p className="field-help">영상 기록의 시작 시점이 있으면 자동 연결합니다. 없으면 분석 시작 시점을 사용하니 경기 시작에 맞춰 주세요.</p><div className="mr-phases">{phases.map(p=><div key={p.label}><strong>{p.label} <small>{p.range}</small></strong><span>{p.reliable?`${['우리 진영','코트 가운데','상대 진영'][p.zone]} · ${['왼쪽','중앙','오른쪽'][p.side]}`:'비교할 관측이 아직 적어요'}</span><small>관측 {Math.round(p.seconds)}초 · {(p.coverage*100).toFixed(0)}%</small></div>)}</div></section>
   <section className="card card-panel"><h2>코멘트 편집</h2><Field label="포지션·전술 추가 메모 (리포트 미표시)"><textarea rows={2} maxLength={1000} value={person.context} onChange={e=>patchPlayer({context:e.target.value})} placeholder="예: 왼쪽 알라, 후반에는 픽소 역할"/></Field><button type="button" onClick={makeComments} disabled={!spatial&&!events.length}>데이터 기반 초안 만들기</button><p className="field-help">활동·플레이 이야기와 좋았던 장면·다음 제안은 데이터로 자동 채워집니다. 직접 수정한 문구는 유지됩니다. 팀 기록은 개인 성과로 쓰지 않습니다.</p><Field label="히트맵 코멘트"><textarea rows={5} maxLength={650} value={person.heatComment} onChange={e=>patchPlayer({heatComment:e.target.value})}/></Field><Field label="이벤트맵 코멘트"><textarea rows={5} maxLength={650} value={person.eventComment} onChange={e=>patchPlayer({eventComment:e.target.value})}/></Field>{reviews.map(r=><div key={r.key}><h3>{r.title}</h3>{person[r.key].map((v,i)=><Field key={i} label={`${r.title} ${i+1}`}><textarea rows={2} maxLength={220} value={v} onChange={e=>patchPlayer({[r.key]:person[r.key].map((old,n)=>n===i?e.target.value:old)})}/></Field>)}</div>)}</section>
  </aside>
  <section className="mr-preview" aria-label="리포트 미리보기"><div className="mr-preview-bar"><div className="mr-actions"><button type="button" aria-pressed={reportView==='player'} onClick={()=>setReportView('player')}>개인 리포트</button><button type="button" aria-pressed={reportView==='team'} onClick={()=>setReportView('team')}>경기 요약</button></div><small>A4 세로 · 210 × 297mm · 1페이지</small></div>{!!overflow.length&&<p className="mr-overflow" role="alert">A4 영역을 넘는 문구를 줄여 주세요: {overflow.join(', ')}. 수정 후 다운로드할 수 있습니다.</p>}<div ref={preview} className="mr-preview-viewport"><div ref={sheet} style={{zoom:scale} as CSSProperties}>{reportView==='team'?<TeamReportSheet draft={draft}/>:<PlayerReportSheet draft={draft}/>}</div></div></section></div>
  {exportDraft&&<div ref={bundle} className="mr-bundle-output" aria-hidden="true"><TeamReportSheet draft={exportDraft}/>{exportPlayers.current.map(id=><PlayerReportSheet key={id} draft={exportDraft} selected={id}/>)}</div>}
 </main>;
}
