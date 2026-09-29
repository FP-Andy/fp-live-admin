'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {apiJson} from '../../lib/api';
import './fla-video.css';

export default function FutsalVideoLibrary(){
  const [data,setData]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[filter,setFilter]=useState('전체');
  const refresh=()=>apiJson('/futsal/fla-video/fixtures').then(setData).catch(e=>setError(e.message));
  useEffect(()=>{void refresh();},[]);
  async function create(){setBusy(true);try{await apiJson('/futsal/fla-video/fixtures/create',{method:'POST',body:'{}'});await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}}
  const fixtures=data?.fixtures||[],created=fixtures.filter((f:any)=>f.match_id).length,ready=fixtures.filter((f:any)=>f.video.upload_id).length;
  return <main className="fla-video-library page-stack">
    {process.env.NEXT_PUBLIC_FLA_VIDEO_PREVIEW==='1'?<div className="fv-preview">로컬 검토 · 운영 데이터에 저장되지 않습니다 · 영상은 기능 확인용 샘플입니다.</div>:null}
    <header className="fv-library-heading"><div><span className="fv-eyebrow">QUEEN CUP 2026 · FLA</span><h1>경기를 보며 기록하세요</h1><p className="muted">정규 17경기 · 파이널 22경기</p></div>{data?.can_create&&created<39?<button className="btn-primary" disabled={busy} onClick={create}>{busy?'경기 준비 중…':`대상 ${39-created}경기 생성`}</button>:null}</header>
    {error?<p role="alert" className="fv-error">{error}</p>:null}
    <div className="fv-library-summary"><div><span>대상 경기</span><strong>39</strong></div><div><span>생성 완료</span><strong>{created}</strong></div><div><span>영상 연결</span><strong>{ready}</strong></div><div><span>기록 완료</span><strong>{fixtures.filter((f:any)=>f.video.ended).length}</strong></div></div>
    <div className="row fv-filters">{['전체','정규','파이널'].map(stage=><button key={stage} className={filter===stage?'btn-active':'btn-secondary'} onClick={()=>setFilter(stage)}>{stage}</button>)}<span className="muted">홈 = 일정표 왼쪽 팀</span></div>
    <div className="fv-fixtures">{fixtures.filter((f:any)=>filter==='전체'||f.stage===filter).map((f:any)=><article key={f.key} className="card fv-fixture"><div className="fv-fixture-date"><strong>{f.date.slice(5).replace('-','.')}</strong><span>{f.time} · {f.court}구장</span></div><div><small className="muted">{f.stage} · {f.round}경기</small><h3>{f.home}<span className="muted"> vs </span>{f.away}</h3><span className="muted">{f.video.upload_id?(data.uploads.find((u:any)=>u.id===f.video.upload_id)?.name||'연결된 영상'):f.candidates.length===1?'일치하는 영상 1개':f.candidates.length>1?'영상 선택 필요':'영상 직접 연결'}</span></div><div className="fv-fixture-actions"><span className={`status-pill ${f.video.started?'tech':''}`}>{f.video.ended?'기록 완료':f.video.started?'기록 중':f.video.upload_id?'시작 준비':'영상 연결 전'}</span>{f.match_id?<Link className="button-link btn-primary" href={`/admin/futsal/fla/video/${f.match_id}${f.video.upload_id?'':f.candidates.length===1?'?upload='+f.candidates[0]:''}`}>{f.video.started?'이어서 기록':'경기 열기'} →</Link>:<span className="muted">경기 생성 대기</span>}</div></article>)}</div>
  </main>;
}
