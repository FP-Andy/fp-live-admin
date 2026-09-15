'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { apiFetch, primeSessionUser, type SessionUser } from '../lib/api';

export default function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'ADMIN' | 'OPERATOR'>('ADMIN');
  const [name, setName] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const admin = mode === 'ADMIN';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    if (!name.trim() || !accessKey) {
      setError(admin ? '관리자 아이디와 비밀번호를 입력하세요.' : '사용자명과 액세스 키를 입력하세요.');
      return;
    }
    pending.current = true;
    setSubmitting(true);
    setError('');
    try {
      const response = await apiFetch('/session/login', {
        method: 'POST', body: JSON.stringify({ name, access_key: accessKey, mode }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(typeof payload.detail === 'string' ? payload.detail : '로그인 정보를 확인해 주세요.');
        return;
      }
      primeSessionUser(await response.json() as SessionUser);
      router.replace(nextPath);
      router.refresh();
    } catch {
      setError('서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.');
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form className="card login-form" onSubmit={submit}>
      <div className="login-form-heading"><h2>로그인</h2><span className="muted">FPC Access</span></div>
      <div className="login-modes" role="group" aria-label="로그인 유형">
        {(['ADMIN', 'OPERATOR'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={submitting} onClick={() => { setMode(value); setName(''); setAccessKey(''); setError(''); }}>
          {value === 'ADMIN' ? '관리자' : '운영자'}
        </button>)}
      </div>
      <p className="muted login-mode-help" id="login-mode-help">{admin ? '등록된 관리자 계정으로 로그인하세요.' : '사용자명은 자유롭게, 액세스 키는 관리자가 공유한 코드를 입력하세요.'}</p>
      <label className="field-stack" htmlFor="login-name"><span className="field-label">{admin ? '관리자 아이디' : '사용자명'}</span>
        <input id="login-name" autoComplete={admin ? 'username' : 'nickname'} value={name} onChange={e => setName(e.target.value)} placeholder={admin ? '관리자 아이디 입력' : '경기 기록에 표시할 이름'} maxLength={80} required autoFocus disabled={submitting} autoCapitalize="none" spellCheck={false} />
      </label>
      <label className="field-stack" htmlFor="access-key"><span className="field-label">{admin ? '비밀번호' : '액세스 키'}</span>
        <input id="access-key" autoComplete="current-password" type="password" value={accessKey} onChange={e => setAccessKey(e.target.value)} placeholder={admin ? '비밀번호 입력' : '관리자가 공유한 코드 입력'} maxLength={200} required disabled={submitting} aria-describedby="login-mode-help" />
      </label>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <button type="submit" className="btn-primary login-submit" disabled={submitting}>{submitting ? '로그인 중…' : `${admin ? '관리자' : '운영자'}로 로그인`}</button>
    </form>
  );
}
