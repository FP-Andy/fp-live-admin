'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { API_BASE, apiJson } from '../../../../lib/api';

type OperatorJob = {
  id: string;
  owner_id: string | null;
  owner_name?: string | null;
  status: string;
  mode: string;
  original_filename: string;
  display_name: string | null;
  source_type: string | null;
  source_url: string | null;
  export_path: string | null;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  queued: '대기 중',
  downloading: '다운로드 중',
  ready: '처리 대기',
  processing: '처리 중',
  clips_ready: '편집 중',
  merging: '합치는 중',
  done: '추출 완료',
  error: '오류',
};

const card: React.CSSProperties = {
  background: 'var(--surface-card)',
  borderRadius: 'var(--radius-card)',
  padding: 16,
  border: '1px solid var(--border-ghost)',
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function MyClipsPage() {
  const [jobs, setJobs] = useState<OperatorJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const data = await apiJson<OperatorJob[]>('/highlight/operator-jobs?scope=mine');
      setJobs(data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>내 업로드</h2>
        <Link
          href="/admin/highlight/upload"
          style={{ padding: '6px 14px', borderRadius: 8, background: 'var(--accent, #3b82f6)', color: '#fff', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}
        >
          + 새 업로드
        </Link>
      </div>

      {error ? <p style={{ color: 'var(--danger, #ef4444)', fontSize: 13 }}>{error}</p> : null}
      {loading ? <p style={{ color: 'var(--muted, #999)', fontSize: 13 }}>불러오는 중...</p> : null}
      {!loading && jobs.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--muted, #999)', fontSize: 14 }}>
          아직 업로드한 영상이 없습니다.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
      {jobs.map((job) => {
        const done = job.status === 'done' && !!job.export_path;
        return (
          <div key={job.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.display_name || job.original_filename}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted, #999)', marginTop: 2 }}>
                {fmtDate(job.created_at)} · {job.source_type === 'link' ? '링크' : '파일'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '3px 10px',
                  borderRadius: 999,
                  background: done ? 'var(--accent, #3b82f6)' : 'var(--border-ghost)',
                  color: done ? '#fff' : 'var(--muted, #999)',
                }}
              >
                {STATUS_LABEL[job.status] || job.status}
              </span>
              {done ? (
                <a
                  href={`${API_BASE}/highlight/jobs/${job.id}/export/download`}
                  style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent, #3b82f6)', textDecoration: 'none' }}
                >
                  다운로드 ↓
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
