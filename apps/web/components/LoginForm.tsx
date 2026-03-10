'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '../lib/api';

export default function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      setError('이름을 입력하세요.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const response = await apiFetch('/session/login', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        setError((await response.text()) || '로그인에 실패했습니다.');
        return;
      }

      router.replace(nextPath);
      router.refresh();
    } catch {
      setError('로그인 요청에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card login-form">
      <label htmlFor="name">Operator Name</label>
      <input
        id="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder="예: Andy Kim"
        autoFocus
      />
      {error ? <div className="form-error">{error}</div> : null}
      <button className="btn-primary" onClick={submit} disabled={submitting}>
        {submitting ? 'Signing In...' : 'Sign In'}
      </button>
    </div>
  );
}
