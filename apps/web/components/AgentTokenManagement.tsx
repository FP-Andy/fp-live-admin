'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiFetch } from '../lib/api';

/** 시스템 › 에이전트 토큰 — 직원용 FLA 에이전트 API(/api/agent/fla) 토큰 발급·폐기와 수정 이력. SUPERADMIN 전용. */
type AgentToken = {
  id: string; display_prefix: string; person_name: string | null; label: string; scopes: string[];
  state: 'active' | 'revoked' | 'expired'; created_by: string | null; created_at: string; expires_at: string;
  last_used_at: string | null;
};
type AgentChange = {
  change_id: string; match_id: string; match_name: string | null; status: string; live: boolean; actor_name: string;
  summary: string; request_summary: string; applied_at: string | null; reverted_at: string | null;
  score?: { before: Record<string, number>; after: Record<string, number> } | null;
};

const when = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export default function AgentTokenManagement() {
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [changes, setChanges] = useState<AgentChange[]>([]);
  const [person, setPerson] = useState('');
  const [label, setLabel] = useState('');
  const [write, setWrite] = useState(true);
  const [days, setDays] = useState(90);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const load = async () => {
    setError('');
    try {
      const [t, c] = await Promise.all([apiFetch('/admin/agent-fla/tokens'), apiFetch('/admin/agent-fla/changes?limit=30')]);
      if (!t.ok || !c.ok) throw new Error(t.status === 403 ? '관리자만 볼 수 있습니다.' : '에이전트 토큰 정보를 불러오지 못했습니다.');
      setTokens((await t.json()).items);
      setChanges((await c.json()).items);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '에이전트 토큰 정보를 불러오지 못했습니다.'); }
  };
  useEffect(() => { void load(); }, []);

  const run = async (action: () => Promise<Response>, done: (payload: any) => void) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const response = await action();
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : '처리하지 못했습니다.');
      done(payload);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '처리하지 못했습니다.'); }
    finally { pending.current = false; setBusy(false); }
  };

  const issue = (event: FormEvent) => {
    event.preventDefault();
    if (!person.trim()) { setError('직원 실명을 입력하세요.'); return; }
    void run(() => apiFetch('/admin/agent-fla/tokens', { method: 'POST', body: JSON.stringify({
      person_name: person.trim(), label: label.trim(), expires_days: days, scopes: write ? ['fla:read', 'fla:write'] : ['fla:read'] }) }),
    (payload) => { setIssued({ name: payload.person_name, token: payload.token }); setPerson(''); setLabel(''); });
  };
  const revoke = (token: AgentToken) => {
    if (!window.confirm(`${token.person_name}님의 토큰(${token.display_prefix}…)을 폐기할까요? 바로 쓸 수 없게 됩니다.`)) return;
    void run(() => apiFetch(`/admin/agent-fla/tokens/${token.id}/revoke`, { method: 'POST' }), () => {});
  };

  return <section className="card card-panel access-management" id="system-agent-tokens">
    <div className="section-heading"><div><div className="sidebar-eyebrow">FLA Agent API</div><h3>에이전트 토큰</h3></div>
      {tokens && <span className="status-pill neutral">사용 중 {tokens.filter((t) => t.state === 'active').length}개</span>}
    </div>
    <p className="muted">직원 AI 에이전트가 <code>/api/agent/fla</code> 로 FLA 기록을 읽고 고칠 때 쓰는 개인 토큰입니다. 한 사람에 하나, 기본 90일. 토큰은 발급 순간에만 보입니다.</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    {issued && <div className="console-feedback" role="status">
      <div><strong>{issued.name}</strong>님 토큰 — 지금만 보입니다. 직원 패키지(.env)에 넣고 이 창을 닫으세요.</div>
      <code style={{ wordBreak: 'break-all', userSelect: 'all' }}>{issued.token}</code>
      <div className="access-actions"><button type="button" onClick={() => { void navigator.clipboard?.writeText(issued.token); }}>복사</button>
        <button type="button" onClick={() => setIssued(null)}>닫기</button></div>
    </div>}
    <form className="access-code-form" onSubmit={issue}>
      <label className="field-stack"><span className="field-label">직원 실명</span><input value={person} maxLength={40} onChange={(e) => setPerson(e.target.value)} disabled={busy} placeholder="감사 기록에 남는 이름" /></label>
      <label className="field-stack"><span className="field-label">메모</span><input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} disabled={busy} placeholder="예: FLA 기록 정정용" /></label>
      <label className="field-stack"><span className="field-label">유효기간(일)</span><input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 90)))} disabled={busy} /></label>
      <label><input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} disabled={busy} /> 기록 수정 허용(fla:write) — 끄면 읽기만</label>
      <div className="access-actions"><button type="submit" className="btn-primary" disabled={busy}>{busy ? '처리 중…' : '토큰 발급'}</button></div>
    </form>
    {tokens && tokens.map((t) => <div key={t.id} className="log-row">
      <div className="grid" style={{ gap: 4 }}>
        <strong>{t.person_name} <code>{t.display_prefix}…</code></strong>
        <div className="muted">{t.scopes.includes('fla:write') ? '읽기·수정' : '읽기'} · {{ active: '사용 중', revoked: '폐기', expired: '만료' }[t.state]} · 만료 {when(t.expires_at)} · 마지막 사용 {when(t.last_used_at)}{t.label ? ` · ${t.label}` : ''}</div>
      </div>
      {t.state === 'active' && <button type="button" className="btn-danger" disabled={busy} onClick={() => revoke(t)}>폐기</button>}
    </div>)}
    <h4>최근 에이전트 수정</h4>
    {!changes.length ? <p className="muted">아직 없습니다.</p> : changes.map((c) => <div key={c.change_id} className="log-row">
      <div className="grid" style={{ gap: 4 }}>
        <strong>{c.actor_name} · {c.summary}</strong>
        <div className="muted">{c.match_name || c.match_id}{c.live ? ' · 진행 중 수정' : ''}{c.score && JSON.stringify(c.score.before) !== JSON.stringify(c.score.after) ? ` · 점수 ${c.score.before.HOME}:${c.score.before.AWAY} → ${c.score.after.HOME}:${c.score.after.AWAY}` : ''}</div>
        <div className="muted">요청: {c.request_summary}</div>
      </div>
      <div className="muted">{when(c.applied_at)}{c.status === 'reverted' ? ` · 되돌림 ${when(c.reverted_at)}` : ''}</div>
    </div>)}
  </section>;
}
