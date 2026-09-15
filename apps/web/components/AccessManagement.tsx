'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiFetch } from '../lib/api';

type AccessStatus = {
  admins: Array<{ login: string; name: string; role: string }>;
  operator_enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
};

export default function AccessManagement() {
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const load = async () => {
    setError('');
    try {
      const response = await apiFetch('/admin/access');
      if (!response.ok) throw new Error(response.status === 403 ? '관리자만 접근 설정을 변경할 수 있습니다.' : '접근 설정을 불러오지 못했습니다.');
      setStatus(await response.json());
    } catch (cause) { setError(cause instanceof Error ? cause.message : '접근 설정을 불러오지 못했습니다.'); }
  };
  useEffect(() => { void load(); }, []);
  const changeCode = async (disable = false) => {
    if (pending.current) return;
    setMessage('');
    setError('');
    if (!disable && (code.trim().length < 8 || code !== confirmation)) {
      setError(code !== confirmation ? '두 코드가 일치하지 않습니다.' : '운영자 코드를 8자 이상 입력하세요.');
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const response = await apiFetch('/admin/access/operator-code', { method: disable ? 'DELETE' : 'PUT', ...(disable ? {} : { body: JSON.stringify({ code }) }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : '접근 설정을 저장하지 못했습니다.');
      setStatus(payload);
      setCode('');
      setConfirmation('');
      setMessage(disable ? '운영자 로그인을 중지했습니다. 기존 운영자 세션도 종료되었습니다.' : '코드를 저장했습니다. 운영자에게 새 코드를 공유해 주세요.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '접근 설정을 저장하지 못했습니다.'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section className="card card-panel access-management" id="system-access">
    <div className="section-heading"><div><div className="sidebar-eyebrow">Access Management</div><h3>계정 · 접근</h3></div>
      {status && <span className={`status-pill ${status.operator_enabled ? 'ok' : 'neutral'}`}>운영자 로그인 {status.operator_enabled ? '허용' : '중지'}</span>}
    </div>
    {error && <div className="form-error" role="alert">{error}{!status && <button type="button" onClick={() => void load()}>다시 불러오기</button>}</div>}
    {message && <div className="console-feedback" role="status">{message}</div>}
    {!status && !error && <p className="muted">접근 설정을 불러오는 중입니다.</p>}
    {status && <div className="access-grid">
      <div className="access-admins"><h4>관리자 계정 <span className="muted">{status.admins.length}명</span></h4>
        <p className="muted">등록된 아이디와 개별 비밀번호로 로그인합니다.</p>
        <ul>{status.admins.map(account => <li key={account.login}><div><strong>{account.name}</strong><span>{account.login}</span></div><span className="access-role">ADMIN</span></li>)}</ul>
      </div>
      <form className="access-code-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void changeCode(); }}>
        <h4>운영자 공통 코드</h4><p className="muted">운영자는 자유로운 사용자명과 이 코드로 로그인합니다.</p>
        <label className="field-stack" htmlFor="operator-code"><span className="field-label">새 액세스 코드</span><input id="operator-code" type="password" autoComplete="new-password" minLength={8} maxLength={200} required placeholder="8자 이상 입력" value={code} onChange={event => setCode(event.target.value)} disabled={busy} aria-describedby="operator-code-help" /></label>
        <label className="field-stack" htmlFor="operator-code-confirm"><span className="field-label">코드 확인</span><input id="operator-code-confirm" type="password" autoComplete="new-password" minLength={8} maxLength={200} required placeholder="같은 코드 다시 입력" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>
        <p className="muted access-code-help" id="operator-code-help">코드를 변경하거나 로그인을 중지하면 기존 운영자는 다시 로그인해야 합니다. 저장한 코드는 다시 표시되지 않습니다.</p>
        <div className="access-actions"><button type="submit" className="btn-primary" disabled={busy}>{busy ? '저장 중…' : '코드 저장'}</button>{status.operator_enabled && <button type="button" className="btn-danger" disabled={busy} onClick={() => void changeCode(true)}>운영자 로그인 중지</button>}</div>
        {status.updated_at && <div className="muted access-updated">최근 변경 · {status.updated_by || '관리자'} · {new Date(`${status.updated_at}Z`).toLocaleString('ko-KR')}</div>}
      </form>
    </div>}
  </section>;
}
