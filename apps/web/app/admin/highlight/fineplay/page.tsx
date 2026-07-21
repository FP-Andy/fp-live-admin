'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import HighlightSubTabs from '../HighlightSubTabs';
import { apiJson } from '../../../../lib/api';
import { ProgressBar, LeaveBadge } from '../../../../components/HlProgress';

// FinePlay 연동 태깅: claim 한 작업의 원본을 S3 스트리밍으로 재생하며 태깅하고,
// 구간을 서버로 보내면 서버가 클립 렌더 → S3 업로드 → 결과 콜백까지 처리한다.
// 원본을 내려받지도, 브라우저에서 자르지도 않는다.

type FpJob = {
  id: string;
  status: string;
  original_filename: string;
  display_name?: string | null;
  error_message?: string | null;
  created_at: string;
  job_metadata?: {
    display_name?: string | null;
    analysis_request_id?: number | string;
    manifest?: { videos?: { durationSeconds?: number }[] } | null;
    clips?: { start: number; end: number }[];
    progress?: { detail?: string } | null;
    result_payload?: { clips?: unknown[] } | null;
    callback_status?: string;
  } | null;
};

type Tag = { id: string; t: number };

const card: React.CSSProperties = {
  background: 'var(--surface-card, #1b1b1f)',
  border: '1px solid var(--border-ghost, #2c2c32)',
  borderRadius: 'var(--radius-card, 10px)',
  padding: 16,
  marginBottom: 16,
};
const btn: React.CSSProperties = {
  fontSize: 13,
  padding: '8px 16px',
  background: 'var(--button-dark, #2a2a30)',
  border: '1px solid var(--border-ghost, #3a3a42)',
  borderRadius: 8,
  cursor: 'pointer',
  color: 'var(--text, #eee)',
};
const smallBtn: React.CSSProperties = { ...btn, padding: '4px 10px', fontSize: 12 };
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--accent, #3b82f6)', borderColor: 'transparent' };
const numInput: React.CSSProperties = {
  width: 60,
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--border-ghost, #3a3a42)',
  background: 'var(--surface-input, #1b1b1f)',
  color: 'var(--text, #eee)',
  fontSize: 13,
};

const STATUS_LABEL: Record<string, string> = {
  tagging: '태깅 대기',
  queued: '생성 대기',
  merging: '생성 중',
  done: '완료',
  error: '실패',
};

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function FineplayJobsPage() {
  const [jobs, setJobs] = useState<FpJob[]>([]);
  const [listError, setListError] = useState('');
  const [polling, setPolling] = useState(false);
  const [pollMsg, setPollMsg] = useState('');

  const [selected, setSelected] = useState<FpJob | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [tags, setTags] = useState<Tag[]>([]);
  const [padBefore, setPadBefore] = useState(7);
  const [padAfter, setPadAfter] = useState(4);
  const [makeVertical, setMakeVertical] = useState(false);
  const [producing, setProducing] = useState(false);
  const [produceMsg, setProduceMsg] = useState('');
  const [produceError, setProduceError] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const rows = await apiJson<FpJob[]>('/highlight/jobs?mode=fineplay&limit=100');
      setJobs(rows);
      setListError('');
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const pollNew = async () => {
    setPolling(true);
    setPollMsg('');
    try {
      const res = await apiJson<{ claimed: string[]; skipped: number }>(
        '/highlight/fineplay-jobs/poll', { method: 'POST' },
      );
      setPollMsg(res.claimed.length ? `새 작업 ${res.claimed.length}건 가져옴` : '새 작업 없음');
      await loadJobs();
    } catch (err) {
      setPollMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPolling(false);
    }
  };

  const selectJob = async (job: FpJob) => {
    setSelected(job);
    setSourceUrl('');
    setSourceError('');
    setTags([]);
    setDuration(0);
    setCurrent(0);
    setPlaying(false);
    setProduceMsg('');
    setProduceError('');
    try {
      const res = await apiJson<{ url: string }>(`/highlight/fineplay-jobs/${job.id}/source-url`);
      setSourceUrl(res.url);
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : String(err));
    }
  };

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { void v.play(); } else { v.pause(); }
  }, []);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || t, t));
  }, []);

  const addTag = useCallback(() => {
    const v = videoRef.current;
    if (!v || !sourceUrl) return;
    const t = v.currentTime;
    setTags((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, t }]
      .sort((a, b) => a.t - b.t));
  }, [sourceUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!videoRef.current || !sourceUrl) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
      if (e.code === 'ArrowLeft') { e.preventDefault(); seekTo(videoRef.current.currentTime - 5); return; }
      if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(videoRef.current.currentTime + 5); return; }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); addTag(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekTo, addTag, sourceUrl]);

  const produce = async () => {
    if (!selected || !tags.length || producing) return;
    setProducing(true);
    setProduceError('');
    try {
      const clips = tags.map((tag) => ({
        start: Math.max(0, tag.t - padBefore),
        end: Math.min(duration || tag.t + padAfter, tag.t + padAfter),
        makeVertical,
      }));
      await apiJson(`/highlight/fineplay-jobs/${selected.id}/produce`, {
        method: 'POST',
        body: JSON.stringify({ clips }),
      });
      setProduceMsg('서버에서 클립 만드는 중...');

      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const job = await apiJson<FpJob>(`/highlight/jobs/${selected.id}`);
        if (job.status === 'done') {
          const meta = job.job_metadata || {};
          const n = meta.result_payload?.clips?.length ?? tags.length;
          setProduceMsg(`완료 — 클립 ${n}개 업로드, 콜백: ${meta.callback_status || '-'}`);
          break;
        }
        if (job.status === 'error') throw new Error(job.error_message || '생성 실패');
        setProduceMsg(job.job_metadata?.progress?.detail || '처리 중...');
      }
      await loadJobs();
    } catch (err) {
      setProduceError(err instanceof Error ? err.message : String(err));
      setProduceMsg('');
    } finally {
      setProducing(false);
    }
  };

  return (
    <div style={{ width: '100%' }}>
      <HighlightSubTabs />

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>FinePlay 분석 작업</h2>
          <button style={{ ...btn, marginLeft: 'auto' }} onClick={pollNew} disabled={polling}>
            {polling ? '가져오는 중...' : '↺ 새 작업 가져오기'}
          </button>
          <button style={btn} onClick={() => void loadJobs()}>새로고침</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
          FinePlay 사용자가 신청한 분석 영상을 가져와(claim) 태깅하고, 서버가 클립을 만들어
          돌려보냅니다. 원본은 S3 스트리밍으로 재생되며 내려받지 않습니다.
        </p>
        {pollMsg ? <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '6px 0 0' }}>{pollMsg}</p> : null}
        {listError ? <p style={{ fontSize: 12, color: '#ef4444', margin: '6px 0 0' }}>{listError}</p> : null}
      </div>

      {jobs.length === 0 ? (
        <div style={card}>
          <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
            가져온 작업이 없습니다. <strong>새 작업 가져오기</strong>로 FinePlay 대기열을 확인하세요.
          </p>
        </div>
      ) : (
        <div style={card}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {jobs.map((job) => {
              const meta = job.job_metadata || {};
              const active = selected?.id === job.id;
              return (
                <div
                  key={job.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                    padding: '8px 10px', borderRadius: 6,
                    background: active ? 'var(--button-dark, #2a2a30)' : 'var(--surface-input, #16161a)',
                    border: active ? '1px solid var(--accent, #3b82f6)' : '1px solid transparent',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{meta.display_name || job.original_filename}</span>
                  <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>#{meta.analysis_request_id}</span>
                  <span style={{
                    fontSize: 12,
                    color: job.status === 'error' ? '#ef4444' : job.status === 'done' ? '#22c55e' : 'var(--muted, #999)',
                  }}>
                    {STATUS_LABEL[job.status] || job.status}
                  </span>
                  {meta.callback_status ? (
                    <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>· 콜백 {meta.callback_status}</span>
                  ) : null}
                  <button style={{ ...smallBtn, marginLeft: 'auto' }} onClick={() => void selectJob(job)}>
                    {active ? '선택됨' : job.status === 'done' ? '다시 열기' : '태깅하기'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selected ? (
        <div style={card}>
          <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>
            태깅 — {selected.job_metadata?.display_name || selected.original_filename}
          </h3>
          {sourceError ? (
            <p style={{ fontSize: 13, color: '#ef4444' }}>원본 재생 실패: {sourceError}</p>
          ) : !sourceUrl ? (
            <p style={{ fontSize: 13, color: 'var(--muted, #999)' }}>원본 주소 가져오는 중...</p>
          ) : (
            <>
              <video
                ref={videoRef}
                src={sourceUrl}
                controls
                style={{ width: '100%', maxHeight: 480, background: '#000', borderRadius: 8 }}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
                onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                <button style={btn} onClick={togglePlay}>{playing ? '⏸ 정지' : '▶ 재생'}</button>
                <button style={primaryBtn} onClick={addTag}>＋ 지금 지점 태깅 (S)</button>
                <span style={{ fontSize: 13, color: 'var(--muted, #999)' }}>
                  {fmt(current)} / {fmt(duration)}
                </span>
                <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                  앞 <input type="number" value={padBefore} min={0} max={60}
                    onChange={(e) => setPadBefore(Math.max(0, Number(e.target.value) || 0))} style={numInput} /> 초
                </label>
                <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  뒤 <input type="number" value={padAfter} min={1} max={60}
                    onChange={(e) => setPadAfter(Math.max(1, Number(e.target.value) || 1))} style={numInput} /> 초
                </label>
              </div>

              {tags.length ? (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {tags.map((tag, i) => (
                    <div key={tag.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                      padding: '6px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
                    }}>
                      <span style={{ color: 'var(--muted, #999)', width: 24 }}>{i + 1}</span>
                      <button style={smallBtn} onClick={() => seekTo(tag.t)}>{fmt(tag.t)}</button>
                      <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                        클립 {fmt(Math.max(0, tag.t - padBefore))} ~ {fmt(tag.t + padAfter)}
                      </span>
                      <button
                        style={{ ...smallBtn, marginLeft: 'auto' }}
                        onClick={() => setTags((prev) => prev.filter((x) => x.id !== tag.id))}
                      >
                        삭제
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '10px 0 0' }}>
                  영상을 보며 <strong>S</strong> 키 또는 태깅 버튼으로 하이라이트 지점을 찍으세요.
                </p>
              )}

              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-ghost, #2c2c32)' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button style={primaryBtn} onClick={produce} disabled={producing || !tags.length}>
                    {producing ? '처리 중...' : `⬆ 클립 ${tags.length}개 생성해서 FinePlay로 보내기`}
                  </button>
                  <label style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={makeVertical} onChange={(e) => setMakeVertical(e.target.checked)} />
                    세로(9:16)도 생성
                  </label>
                  {produceMsg ? (
                    <span style={{ fontSize: 13, color: producing ? 'var(--muted, #999)' : '#22c55e' }}>{produceMsg}</span>
                  ) : null}
                </div>
                {producing ? (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>서버에서 클립 렌더 · 업로드 중</span>
                      <LeaveBadge canLeave />
                    </div>
                    <ProgressBar indeterminate color="#22c55e" />
                    <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: 0 }}>
                      태깅한 구간만 서버로 보냈습니다. 렌더와 업로드는 서버가 하므로 탭을 닫아도 됩니다.
                    </p>
                  </div>
                ) : null}
                {produceError ? (
                  <div style={{
                    marginTop: 12, padding: 12, borderRadius: 8, fontSize: 13,
                    background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
                  }}>
                    실패: {produceError}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
