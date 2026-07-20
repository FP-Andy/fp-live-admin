'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch, apiJson } from '../../../../lib/api';
import HighlightSubTabs from '../HighlightSubTabs';

// 수동 태깅으로 만든 하이라이트 목록. 전원 SUPERADMIN 이라 누가 만들었든 모두 조회·다운로드한다.

type ClipInfo = { name: string; requested_start: number; requested_end: number };

type ManualJob = {
  id: string;
  owner_id: string | null;
  status: string;
  original_filename: string;
  display_name?: string | null;
  export_path?: string | null;
  error_message?: string | null;
  stage?: string | null;
  created_at: string;
  job_metadata?: { clip_info?: ClipInfo[] } | null;
};

const card: React.CSSProperties = {
  background: 'var(--surface-card, #1b1b1f)',
  border: '1px solid var(--border-ghost, #2c2c32)',
  borderRadius: 'var(--radius-card, 10px)',
  padding: 16,
  marginBottom: 16,
};
const btn: React.CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  background: 'var(--button-dark, #2a2a30)',
  border: '1px solid var(--border-ghost, #3a3a42)',
  borderRadius: 8,
  cursor: 'pointer',
  color: 'var(--text, #eee)',
};

const STATUS_LABEL: Record<string, string> = {
  collecting: '클립 수신 중',
  merging: '합치는 중',
  done: '완료',
  error: '실패',
};

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ManualResultsPage() {
  const [jobs, setJobs] = useState<ManualJob[]>([]);
  const [expanded, setExpanded] = useState<string>('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await apiJson<ManualJob[]>('/highlight/jobs?mode=manual&limit=100');
      setJobs(rows);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 처리 중인 작업이 있을 때만 주기적으로 다시 읽는다.
  useEffect(() => {
    const busy = jobs.some((j) => j.status === 'merging' || j.status === 'collecting');
    if (!busy) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    if (timerRef.current) return;
    timerRef.current = setInterval(() => { void load(); }, 4000);
  }, [jobs, load]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const remove = async (job: ManualJob) => {
    if (!window.confirm(`"${job.display_name || job.original_filename}" 을(를) 삭제할까요?\n클립과 합본 파일이 함께 지워집니다.`)) return;
    try {
      const res = await apiFetch(`/highlight/jobs/${job.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text() || '삭제 실패');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ width: '100%' }}>
      <HighlightSubTabs />

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>수동 하이라이트 결과물</h2>
          <button style={{ ...btn, marginLeft: 'auto' }} onClick={() => void load()}>새로고침</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
          수동 태깅으로 만든 하이라이트입니다. 만든 사람과 관계없이 모두 조회·다운로드할 수 있습니다.
        </p>
      </div>

      {error ? (
        <div
          style={{
            ...card,
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.4)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div style={card}><p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>불러오는 중...</p></div>
      ) : jobs.length === 0 ? (
        <div style={card}>
          <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
            아직 만든 하이라이트가 없습니다. <strong>수동 태깅</strong> 탭에서 시작하세요.
          </p>
        </div>
      ) : (
        jobs.map((job) => {
          const clips = job.job_metadata?.clip_info || [];
          const open = expanded === job.id;
          return (
            <div key={job.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, wordBreak: 'break-all' }}>
                    {job.display_name || job.original_filename}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted, #999)', marginTop: 2 }}>
                    {fmtWhen(job.created_at)} · 클립 {clips.length}개 ·{' '}
                    <span style={{ color: job.status === 'error' ? '#ef4444' : job.status === 'done' ? '#22c55e' : undefined }}>
                      {STATUS_LABEL[job.status] || job.status}
                    </span>
                    {job.status !== 'done' && job.stage ? ` — ${job.stage}` : ''}
                  </div>
                  {job.error_message ? (
                    <div style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>{job.error_message}</div>
                  ) : null}
                </div>

                {job.export_path ? (
                  <a
                    href={`${API_BASE}/highlight/jobs/${job.id}/export/download`}
                    style={{ ...btn, textDecoration: 'none', background: 'var(--accent, #3b82f6)', borderColor: 'transparent' }}
                  >
                    합본 다운로드
                  </a>
                ) : null}
                {clips.length ? (
                  <button style={btn} onClick={() => setExpanded(open ? '' : job.id)}>
                    {open ? '클립 접기' : `클립 ${clips.length}개`}
                  </button>
                ) : null}
                <button style={btn} onClick={() => void remove(job)}>삭제</button>
              </div>

              {open ? (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {clips.map((clip, i) => (
                    <div
                      key={clip.name}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                        padding: '6px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
                      }}
                    >
                      <span style={{ color: 'var(--muted, #999)', width: 24 }}>{i + 1}</span>
                      <span>{fmtClock(clip.requested_start)} ~ {fmtClock(clip.requested_end)}</span>
                      <a
                        href={`${API_BASE}/highlight/jobs/${job.id}/clips/${clip.name}`}
                        style={{ ...btn, marginLeft: 'auto', textDecoration: 'none' }}
                      >
                        다운로드
                      </a>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
