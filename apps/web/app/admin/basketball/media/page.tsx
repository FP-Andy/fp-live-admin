'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiJson } from '../../../../lib/api';
import { RTMP_SERVER, rtmpServerAddress } from '../../../../lib/rtmp';
import BasketballRecording from '../../../../components/basketball/BasketballRecording';

type Match = {id:string; name:string; archived:boolean};
type Recording = {id:string; status:string; desired:boolean; stream_key:string|null; server_url:string; duration:number; bytes:number; preview_url:string|null; preview_at:string|null; error:string|null};
type Row = {match:Match; recording?:Recording; receiverReady?:boolean; error?:string};
const labels:Record<string,string> = {waiting:'송출 대기',recording:'수신 · 녹화 중',saving:'마지막 구간 저장 중',assembling:'전체 MP4 생성 중',ready:'저장 완료',empty:'수신된 영상 없음',error:'저장 확인 필요'};
const pageSize=6;
function duration(value:number){return `${Math.floor(value/3600).toString().padStart(2,'0')}:${Math.floor(value%3600/60).toString().padStart(2,'0')}:${Math.floor(value%60).toString().padStart(2,'0')}`;}

export default function BasketballMediaPage(){
  const [rows,setRows]=useState<Row[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(0),[archived,setArchived]=useState(false);
  const [selected,setSelected]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true),[checkedAt,setCheckedAt]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{
    let cancelled=false,inFlight=false;
    setRows([]);setLoading(true);setSelected('');
    async function load(){
      if(inFlight)return;inFlight=true;
      try{
        const matches=await apiJson<{items:Match[];total:number}>(`/matches/page?sport=BASKETBALL&archived=${archived}&limit=${pageSize}&offset=${page*pageSize}&compact=true`);
        const next=await Promise.all(matches.items.map(async match=>{
          try{
            const state=await apiJson<{recordings:Recording[];receiver_ready:boolean}>(`/recordings/matches/${match.id}`);
            return {match,recording:state.recordings.find(item=>item.desired)||state.recordings[0],receiverReady:state.receiver_ready};
          }catch{return {match,error:'수신 상태를 확인하지 못했습니다.'};}
        }));
        if(!cancelled){setRows(next);setTotal(matches.total);setError('');setCheckedAt(new Date().toLocaleTimeString('ko-KR'));}
      }catch(ex){if(!cancelled)setError(ex instanceof Error?ex.message:'경기 목록을 불러오지 못했습니다.');}
      finally{inFlight=false;if(!cancelled)setLoading(false);}
    }
    void load();const timer=setInterval(()=>{if(!document.hidden)void load();},10000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[archived,page,revision]);
  async function copy(text:string){try{await navigator.clipboard.writeText(text);setNotice('복사했습니다.');}catch{setNotice('복사하지 못했습니다. 경기의 녹화·다운로드를 열어 직접 복사하세요.');}}
  const readyRows=rows.filter(row=>row.recording?.desired&&row.recording.stream_key);
  const chosen=rows.find(row=>row.match.id===selected);
  return <main className="page-stack console-page">
    <section className="card card-panel grid">
      <div className="section-heading"><div><div className="sidebar-eyebrow">BASKETBALL · MEDIA</div><h2>농구 미디어</h2><p className="muted">송출 수신, 최근 저장 화면과 녹화 영상을 확인합니다. 약 10초마다 상태를 갱신합니다.</p></div><button className="btn" disabled={loading} onClick={()=>setRevision(value=>value+1)}>새로고침</button></div>
      <div className="basketball-media-server"><div><span className="muted">축구·농구 공통 RTMP 서버</span><code>{RTMP_SERVER}</code></div><button className="btn" onClick={()=>void copy(RTMP_SERVER)}>서버 주소 복사</button></div>
      <div className="row" style={{gap:12,flexWrap:'wrap'}}><label className="row" style={{gap:8}}><input type="checkbox" checked={archived} onChange={e=>{setArchived(e.target.checked);setPage(0);}}/>보관된 경기</label><button className="btn" disabled={!readyRows.length} onClick={()=>void copy(readyRows.map(({match,recording:r})=>`${match.name}\n서버: ${rtmpServerAddress(r!.server_url)}\n키: ${r!.stream_key}`).join('\n\n'))}>현재 목록 송출 정보 복사</button><span className="muted">{checkedAt?`마지막 확인 ${checkedAt}`:'상태 확인 중…'}</span></div>
      {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="form-error">{error}</p>}
    </section>
    {loading&&<p role="status">농구 경기 수신 상태를 확인하고 있습니다.</p>}
    {!loading&&!rows.length&&!error&&<section className="card card-panel"><p>{archived?'보관된 농구 경기가 없습니다.':'등록된 농구 경기가 없습니다.'}</p><Link href="/admin/dashboard">대시보드에서 경기 생성</Link></section>}
    <section className="basketball-media-grid" aria-label="경기별 수신 상태">{rows.map(({match,recording:r,receiverReady,error:rowError})=>{
      const status=rowError?'상태 확인 실패':!r?'녹화 준비 전':r.status==='waiting'&&receiverReady===false?'수신 서버 연결 대기':labels[r.status]||r.status;
      return <article className="card card-panel basketball-media-card" key={match.id}>
        <div className="section-heading"><h3>{match.name}</h3><span className={`status-pill ${rowError||r?.error?'warning':r?.status==='recording'?'running':'stopped'}`}>{status}</span></div>
        {rowError&&<p role="alert" className="form-error">{rowError}</p>}{r?.error&&<p role="alert" className="form-error">{r.error}</p>}
        {r?.preview_url?<figure><img src={`${r.preview_url}?v=${encodeURIComponent(r.preview_at||'')}`} alt={`${match.name} 최근 저장 화면`} width={640} height={360}/><figcaption className="muted">최근 저장 프레임 · {r.preview_at?new Date(r.preview_at).toLocaleString('ko-KR'):''} · 실시간 영상 아님</figcaption></figure>:<div className="basketball-media-placeholder">{r?.desired?'첫 영상 구간이 저장되면 미리보기가 표시됩니다.':'녹화를 준비하면 송출 서버와 키를 확인할 수 있습니다.'}</div>}
        <p>저장 {duration(r?.duration||0)} · {((r?.bytes||0)/1024/1024).toFixed(1)} MB</p>
        <div className="row" style={{gap:10,flexWrap:'wrap'}}><button className="btn btn-primary" disabled={!r?.stream_key||!!rowError} onClick={()=>r?.stream_key&&void copy(r.stream_key)}>스트림키 복사</button><button className="btn" onClick={()=>setSelected(selected===match.id?'':match.id)} aria-expanded={selected===match.id}>녹화·다운로드</button><Link className="button-link btn-secondary" href={`/admin/basketball/match/${match.id}`}>경기 제어</Link></div>
        {selected===match.id&&<a href="#basketball-media-controls">아래 녹화 설정으로 이동 ↓</a>}
      </article>;
    })}</section>
    {total>pageSize&&<nav className="row" aria-label="농구 미디어 페이지" style={{gap:16}}><button className="btn" disabled={page===0} onClick={()=>setPage(page-1)}>이전</button><span>{page+1} / {Math.ceil(total/pageSize)}</span><button className="btn" disabled={(page+1)*pageSize>=total} onClick={()=>setPage(page+1)}>다음</button></nav>}
    {chosen&&<section id="basketball-media-controls"><h2>{chosen.match.name}</h2><BasketballRecording key={chosen.match.id} matchId={chosen.match.id}/></section>}
  </main>;
}
