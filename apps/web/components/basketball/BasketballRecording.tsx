'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

type Recording = {
  id: string; status: string; desired: boolean; created_at: string; preview_at: string | null;
  server_url: string; stream_key: string | null; duration: number; bytes: number;
  full_url: string | null; preview_url: string | null; interruptions: number; error: string | null;
  parts: { number: number; duration: number; bytes: number; saved_at: string; url: string }[];
};
const statuses: Record<string,string> = {waiting:'송출 대기 · 재연결 중',recording:'수신 · 녹화 중',saving:'마지막 구간 저장 중',assembling:'전체 영상 만드는 중',ready:'저장 완료',empty:'수신된 영상 없음',error:'저장 확인 필요'};
const duration = (seconds:number) => `${Math.floor(seconds/3600).toString().padStart(2,'0')}:${Math.floor(seconds%3600/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
async function request(path:string, method='GET') {
  const response = await apiFetch(path,{method});
  if(!response.ok) {const body=await response.json().catch(()=>null);throw new Error(typeof body?.detail==='string'?body.detail:'녹화 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');}
  return response.json();
}
export default function BasketballRecording({matchId}:{matchId:string}) {
  const [items,setItems]=useState<Recording[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const [video,setVideo]=useState<string|null>(null),[notice,setNotice]=useState('');
  const base=`/recordings/matches/${matchId}`;
  const load=useCallback(async()=>{try{const data=await request(base);setItems(data.recordings);setError('');}catch(ex){setError(ex instanceof Error?ex.message:'녹화 상태 확인 실패');}finally{setLoading(false);}},[base]);
  useEffect(()=>{setItems([]);setVideo(null);setLoading(true);void load();const timer=setInterval(()=>{if(!document.hidden)void load();},10000);return()=>clearInterval(timer);},[load]);
  async function action(path:string){if(busy)return;setBusy(true);setError('');try{await request(base+path,'POST');await load();}catch(ex){setError(ex instanceof Error?ex.message:'요청 실패');}finally{setBusy(false);}}
  async function copy(value:string){try{await navigator.clipboard.writeText(value);setNotice('복사했습니다.');}catch{setNotice('복사하지 못했습니다. 주소를 직접 선택해 복사해 주세요.');}}
  const active=items.find(item=>item.desired);
  return <section className="card card-panel basketball-recording" aria-label="농구 스트리밍 녹화">
    <div className="section-heading"><div><div className="sidebar-eyebrow">STREAM ARCHIVE</div><h3>경기 영상 · 스트리밍 녹화</h3><p className="muted">원본 화질로 저장합니다. 경기 기록 타이머와 녹화는 별도로 동작합니다.</p></div>
      <button className="btn btn-primary" disabled={busy||loading||!!active} onClick={()=>void action('/start')}>{busy?'처리 중…':active?'녹화 수신 준비됨':'스트리밍 녹화 준비'}</button></div>
    {loading&&<p role="status">녹화 상태를 확인하고 있습니다.</p>}
    {error&&<p role="alert" className="form-error">{error} <button className="btn" onClick={()=>void load()}>다시 확인</button></p>}
    {notice&&<p role="status">{notice}</p>}
    {active&&<div className="recording-connection">
      <p>OBS 등 송출 프로그램에서 아래 주소와 키를 입력한 뒤 방송을 시작하세요. <strong>H.264 영상 + AAC 오디오, 키프레임 2초</strong>를 권장합니다.</p>
      <label>RTMP 서버<div className="row"><input readOnly value={active.server_url} aria-label="RTMP 서버 주소"/><button className="btn" onClick={()=>void copy(active.server_url)}>주소 복사</button></div></label>
      <label>스트림 키<div className="row"><input readOnly value={active.stream_key||''} type="password" aria-label="스트림 키"/><button className="btn" onClick={()=>void copy(active.stream_key||'')}>키 복사</button></div></label>
      <p className="muted">서버가 꺼져 있으면 준비에 1–2분 걸릴 수 있습니다. 약 30초마다 저장된 구간의 최근 프레임을 갱신합니다. 송출이 끊기면 자동으로 다시 기다립니다. 최대 12시간 녹화되며, 방송이 끝나면 아래 ‘녹화 종료·저장’을 눌러 주세요.</p>
    </div>}
    {video&&<div className="recording-player"><video key={video} src={video} controls playsInline preload="metadata"/><button className="btn" onClick={()=>setVideo(null)}>재생 닫기</button></div>}
    {!loading&&!items.length&&!error&&<p className="muted">저장된 영상이 없습니다. 녹화를 준비한 뒤 송출을 시작하면 자동으로 저장됩니다.</p>}
    <div className="recording-list">{items.map(item=><article key={item.id} className="recording-session">
      <div className="section-heading"><div><strong>{statuses[item.status]||item.status}</strong><p>{new Date(item.created_at).toLocaleString('ko-KR')} · 저장 {duration(item.duration)} · {(item.bytes/1024/1024).toFixed(1)} MB</p></div>
        {item.desired&&<button className="btn" disabled={busy} onClick={()=>void action(`/${item.id}/stop`)}>녹화 종료·저장</button>}
        {item.status==='error'&&<button className="btn" disabled={busy} onClick={()=>void action(`/${item.id}/retry`)}>저장 재시도</button>}</div>
      {item.error&&<p role="alert" className="form-error">{item.error}</p>}
      {item.preview_url&&<figure><img src={`${item.preview_url}?v=${encodeURIComponent(item.preview_at||'')}`} width={640} height={360} alt="최근 저장된 농구 영상 프레임"/><figcaption>마지막 저장 프레임 · {item.preview_at?new Date(item.preview_at).toLocaleTimeString('ko-KR'):''} · 실시간 재생 화면이 아닙니다.</figcaption></figure>}
      {!!item.interruptions&&<p className="muted">수신 재연결 {item.interruptions}회 · 받지 못한 시간은 영상에 포함되지 않습니다.</p>}
      {item.full_url&&<div className="row"><button className="btn btn-primary" onClick={()=>setVideo(item.full_url)}>전체 영상 보기</button><a className="btn" href={`${item.full_url}?download=true`}>전체 MP4 다운로드</a></div>}
      {!!item.parts.length&&<details><summary>저장된 구간 {item.parts.length}개 · 개별 재생 / 다운로드</summary><div className="recording-parts">{item.parts.map(part=><div className="row" key={part.number}><span>구간 {part.number} · {duration(part.duration)}</span><button className="btn" onClick={()=>setVideo(part.url)}>보기</button><a className="btn" href={`${part.url}?download=true`}>다운로드</a></div>)}</div></details>}
    </article>)}</div>
  </section>;
}
