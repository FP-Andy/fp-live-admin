'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiJson } from '../../../../lib/api';

type OperatorJob = {
  id: string;
  owner_id: string | null;
  owner_name?: string | null;
  status: string;
  original_filename: string;
  display_name: string | null;
  source_type: string | null;
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
  padding: 14,
  border: '1px solid var(--border-ghost)',
};

function dateKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
function timeStr(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function ProcessListPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<OperatorJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const data = await apiJson<OperatorJob[]>('/highlight/operator-jobs');
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

  const groups: { date: string; items: OperatorJob[] }[] = [];
  for (const job of jobs) {
    const key = dateKey(job.created_at);
    const last = groups[groups.length - 1];
    if (last && last.date === key) last.items.push(job);
    else groups.push({ date: key, items: [job] });
  }

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <h2 style={{ fontSize: 18, margin: 0 }}>업로드 처리</h2>

      {error ? <p style={{ color: 'var(--danger, #ef4444)', fontSize: 13 }}>{error}</p> : null}
      {loading ? <p style={{ color: 'var(--muted, #999)', fontSize: 13 }}>불러오는 중...</p> : null}
      {!loading && jobs.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--muted, #999)' }}>처리할 업로드가 없습니다.</div>
      ) : null}

      {groups.map((group) => (
        <div key={group.date} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted, #999)' }}>{group.date}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
          {group.items.map((job) => (
            <button
              key={job.id}
              onClick={() => router.push(`/admin/highlight/process/${job.id}`)}
              style={{ ...card, textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'inherit' }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {job.display_name || job.original_filename}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted, #999)', marginTop: 2 }}>
                  {timeStr(job.created_at)} · {job.owner_name || job.owner_id || '알 수 없음'} · {job.source_type === 'link' ? '링크' : '파일'}
                </div>
              </div>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '3px 10px',
                  borderRadius: 999,
                  background: job.status === 'done' ? 'var(--accent, #3b82f6)' : 'var(--border-ghost)',
                  color: job.status === 'done' ? '#fff' : 'var(--muted, #999)',
                  flexShrink: 0,
                }}
              >
                {STATUS_LABEL[job.status] || job.status}
              </span>
            </button>
          ))}
          </div>
        </div>
      ))}
    </div>
  );
}
