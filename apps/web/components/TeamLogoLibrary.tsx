'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../lib/api';
import { responseError } from '../lib/response-error';

type Competition = { code: string; name: string; team_options?: string[] };
type TeamLogo = { id: string; competition_class: string; team_name: string; logo_url: string };

async function readResponse(response: Response) {
  if (!response.ok) throw new Error(await responseError(response, '팀 로고 요청을 처리하지 못했습니다.'));
  return response.json();
}

export default function TeamLogoLibrary({ competitions }: { competitions: Competition[] }) {
  const [logos, setLogos] = useState<TeamLogo[]>([]);
  const [competition, setCompetition] = useState('K3');
  const [team, setTeam] = useState('');
  const [customTeam, setCustomTeam] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const preview = useMemo(() => file ? URL.createObjectURL(file) : '', [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    if (competitions.length && !competitions.some(item => item.code === competition)) {
      setCompetition(competitions[0].code); setTeam(''); setCustomTeam(false);
    }
  }, [competitions, competition]);
  const load = async () => {
    setLoading(true); setError('');
    try { setLogos(await readResponse(await fetch(`${API_BASE}/fcm/team-logos`, { credentials: 'include' }))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '팀 로고를 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || !team.trim() || busyRef.current) return;
    if (file.size > 5 * 1024 * 1024) { setError('파일이 너무 큽니다. 5MB 이하의 파일을 선택해 주세요.'); return; }
    busyRef.current = true;
    setBusy(true); setMessage(''); setError('');
    try {
      const form = new FormData();
      form.set('competition_class', competition); form.set('team_name', team.trim()); form.set('file', file);
      const saved: TeamLogo = await readResponse(await fetch(`${API_BASE}/fcm/team-logos`, { method: 'POST', credentials: 'include', body: form }));
      setLogos(previous => [...previous.filter(item => item.id !== saved.id), saved].sort((a, b) => a.team_name.localeCompare(b.team_name, 'ko')));
      setMessage(`${saved.team_name} 로고를 등록했습니다. 같은 대회의 해당 팀 경기에 자동 적용됩니다.`);
      setFile(null); if (fileInput.current) fileInput.current.value = '';
    } catch (cause) { setError(cause instanceof Error ? cause.message : '팀 로고를 저장하지 못했습니다.'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const remove = async (logo: TeamLogo) => {
    if (busyRef.current) return;
    if (!window.confirm(`${logo.team_name}의 공용 로고 등록을 해제할까요? 해당 팀의 자동 연결이 해제됩니다.`)) return;
    busyRef.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      await readResponse(await fetch(`${API_BASE}/fcm/team-logos/${logo.id}`, { method: 'DELETE', credentials: 'include' }));
      setLogos(previous => previous.filter(item => item.id !== logo.id));
      setMessage(`${logo.team_name} 로고의 자동 연결을 해제했습니다.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '등록을 해제하지 못했습니다.'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const visible = logos.filter(item => item.competition_class === competition);
  const teamOptions = Array.from(new Set([
    ...(competitions.find(item => item.code === competition)?.team_options || []),
    ...visible.map(item => item.team_name),
  ])).sort((a, b) => a.localeCompare(b, 'ko'));
  return <section className="card card-panel team-logo-library" aria-labelledby="team-logo-heading">
    <div className="section-heading">
      <div><div className="sidebar-eyebrow">Team identity</div><h2 id="team-logo-heading">팀 로고</h2><p className="muted">한 번 등록하면 같은 대회·팀의 Broadcast 이미지와 FCM 골키퍼 카드에 자동으로 연결됩니다.</p></div>
      <span className="console-count">{logos.length}개 등록</span>
    </div>
    <form className="team-logo-form" onSubmit={save} aria-busy={busy}>
      <label className="field-stack"><span className="field-label">대회</span><select aria-label="팀 로고 대회" value={competition} onChange={event => { setCompetition(event.target.value); setTeam(''); setCustomTeam(false); }} disabled={busy}>
        {(competitions.length ? competitions : [{ code: 'K3', name: 'K3' }]).map(item => <option key={item.code} value={item.code}>{item.name === item.code ? item.name : `${item.name} · ${item.code}`}</option>)}
      </select></label>
      <label className="field-stack"><span className="field-label">팀명</span><select aria-label="팀 로고 팀명" required value={customTeam ? '__custom__' : team} disabled={busy} onChange={event => {
        const custom = event.target.value === '__custom__'; setCustomTeam(custom); setTeam(custom ? '' : event.target.value);
      }}>
        <option value="" disabled>팀을 선택하세요</option>
        {teamOptions.map(name => <option key={name} value={name}>{name}</option>)}
        <option value="__custom__">목록에 없는 팀 직접 입력</option>
      </select>
      </label>
      {customTeam ? <label className="field-stack team-logo-custom"><span className="field-label">팀명 직접 입력</span><input aria-label="팀 로고 팀명 직접 입력" required maxLength={160} placeholder="경기에 등록된 팀명을 입력하세요" value={team} onChange={event => setTeam(event.target.value)} disabled={busy} /></label> : null}
      <label className="field-stack"><span className="field-label">로고 파일 <small className="muted">PNG · JPG · WEBP / 최대 5MB</small></span><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" required disabled={busy} onChange={event => setFile(event.target.files?.[0] || null)} /></label>
      <button type="submit" disabled={busy || !file || !team.trim()}>{busy ? '저장 중…' : '로고 등록·교체'}</button>
    </form>
    {preview ? <div className="team-logo-preview"><img src={preview} alt="등록할 팀 로고 미리보기" /><span>{file?.name}</span></div> : null}
    <p className="muted team-logo-hint">같은 대회·팀명으로 등록하면 기존 로고가 교체됩니다. 경기에서 직접 지정한 로고가 있으면 해당 설정을 우선합니다.</p>
    {message ? <p role="status" className="console-feedback">{message}</p> : null}
    {error ? <p role="alert" className="console-feedback">{error} <button type="button" onClick={load} disabled={loading}>다시 불러오기</button></p> : null}
    <div className="team-logo-list" aria-live="polite">
      {loading ? <p className="muted">팀 로고를 불러오는 중…</p> : visible.length ? visible.map(logo => <article className="team-logo-item" key={logo.id}>
        <img src={logo.logo_url.replace(/^\/api/, API_BASE)} alt={`${logo.team_name} 로고`} />
        <div><strong>{logo.team_name}</strong><span className="muted">{logo.competition_class} · 자동 연결</span></div>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setTeam(logo.team_name); setCustomTeam(false); fileInput.current?.click(); }}>교체</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => remove(logo)} aria-label={`${logo.team_name} 로고 등록 해제`}>해제</button>
      </article>) : <p className="muted">이 대회에 등록된 팀 로고가 없습니다. 위에서 첫 로고를 등록하세요.</p>}
    </div>
  </section>;
}
