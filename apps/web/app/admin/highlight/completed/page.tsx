'use client';

import { useEffect, useState } from 'react';
import { API_BASE, apiFetch, apiJson } from '../../../../lib/api';

type OperatorJob = {
  id: string;
  owner_id: string | null;
  owner_name?: string | null;
  status: string;
  original_filename: string;
  display_name: string | null;
  source_type: string | null;
  export_path: string | null;
  created_at: string;
  job_metadata?: { completed?: boolean };
};

const card: React.CSSProperties = {
  background: 'var(--surface-card)',
  borderRadius: 'var(--radius-card)',
  padding: 14,
  border: '1px solid var(--border-ghost)',
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

export default function CompletedPage() {
  const [jobs, setJobs] = useState<OperatorJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    try {
      const data = await apiJson<OperatorJob[]>('/highlight/operator-jobs');
      setJobs(data.filter((j) => j.status === 'done' || j.job_metadata?.completed));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const complete = async (id: string) => {
    if (!confirm('완료 처리하면 원본 영상이 삭제됩니다. 진행할까요?')) return;
    setBusy(id);
    try {
      const res = await apiFetch(`/highlight/operator-jobs/${id}/complete`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '완료 처리 실패');
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    if (!confirm('이 하이라이트를 영구 삭제합니다. 영상·클립 파일도 서버에서 삭제되며 되돌릴 수 없습니다. 진행할까요?')) return;
    setBusy(id);
    try {
      const res = await apiFetch(`/highlight/operator-jobs/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패');
    } finally {
      setBusy('');
    }
  };

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ fontSize: 18, margin: 0 }}>완료 관리</h2>

      {error ? <p style={{ color: 'var(--danger, #ef4444)', fontSize: 13 }}>{error}</p> : null}
      {loading ? <p style={{ color: 'var(--muted, #999)', fontSize: 13 }}>불러오는 중...</p> : null}
      {!loading && jobs.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--muted, #999)' }}>완성된 하이라이트가 없습니다.</div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
      {jobs.map((job) => {
        const completed = !!job.job_metadata?.completed;
        return (
          <div key={job.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.display_name || job.original_filename}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted, #999)', marginTop: 2 }}>
                {fmtDate(job.created_at)} · {job.owner_name || job.owner_id || '알 수 없음'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              {completed ? (
                <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 999, background: 'var(--accent, #3b82f6)', color: '#fff' }}>
                  개인 추출 완료
                </span>
              ) : (
                <button
                  onClick={() => complete(job.id)}
                  disabled={busy === job.id}
                  style={{ padding: '5px 12px', borderRadius: 8, border: 'none', background: 'var(--accent, #3b82f6)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                >
                  {busy === job.id ? '처리 중...' : '완료'}
                </button>
              )}
              {job.export_path ? (
                <a href={`${API_BASE}/highlight/jobs/${job.id}/export/download`} style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent, #3b82f6)', textDecoration: 'none' }}>
                  다운로드 ↓
                </a>
              ) : null}
              <button
                onClick={() => remove(job.id)}
                disabled={busy === job.id}
                style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid var(--danger, #ef4444)', background: 'transparent', color: 'var(--danger, #ef4444)', fontSize: 13, fontWeight: 600, cursor: busy === job.id ? 'default' : 'pointer' }}
              >
                {busy === job.id ? '...' : '삭제'}
              </button>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
