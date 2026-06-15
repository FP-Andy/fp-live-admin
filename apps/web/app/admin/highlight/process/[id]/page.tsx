'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch, apiJson } from '../../../../../lib/api';

type ClipInfo = { name: string; start: number; end: number; label: number };
type OperatorJob = {
  id: string;
  status: string;
  original_filename: string;
  display_name: string | null;
  source_type: string | null;
  source_url: string | null;
  export_path: string | null;
  owner_name?: string | null;
  job_metadata?: { clip_info?: ClipInfo[]; progress?: { detail?: string; percent?: number } };
  stage?: string | null;
  progress?: number | null;
};

const card: React.CSSProperties = {
  background: 'var(--surface-card)',
  borderRadius: 'var(--radius-card)',
  padding: 16,
  border: '1px solid var(--border-ghost)',
};
const btn: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid var(--border-ghost)',
  background: 'transparent',
  color: 'var(--text, #eee)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
const primaryBtn: React.CSSProperties = { ...btn, border: 'none', background: 'var(--accent, #3b82f6)', color: '#fff' };

function fmt(sec: number) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SPEEDS = [1, 2, 3, 4];

export default function ProcessJobPage() {
  const params = useParams();
  const jobId = String(params?.id || '');
  const videoRef = useRef<HTMLVideoElement>(null);

  const [job, setJob] = useState<OperatorJob | null>(null);
  const [error, setError] = useState('');
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [before, setBefore] = useState(7);
  const [after, setAfter] = useState(4);
  const [labels, setLabels] = useState<number[]>([]);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editStart, setEditStart] = useState(0);
  const [editEnd, setEditEnd] = useState(0);

  const loadJob = useCallback(async () => {
    try {
      const data = await apiJson<OperatorJob>(`/highlight/operator-jobs/${jobId}`);
      setJob(data);
      setError('');
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패');
      return null;
    }
  }, [jobId]);

  // Initial load + trigger link download if needed.
  useEffect(() => {
    let active = true;
    (async () => {
      const data = await loadJob();
      if (!active || !data) return;
      if (data.source_type === 'link' && (data.status === 'queued' || data.status === 'error')) {
        await apiFetch(`/highlight/operator-jobs/${jobId}/fetch`, { method: 'POST' });
      }
    })();
    return () => { active = false; };
  }, [jobId, loadJob]);

  // Poll while the server is working.
  const status = job?.status;
  useEffect(() => {
    if (!status || !['queued', 'downloading', 'processing', 'merging'].includes(status)) return;
    const timer = setInterval(loadJob, 2000);
    return () => clearInterval(timer);
  }, [status, loadJob]);

  // Keep playback rate in sync.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  // Hotkey 't' to label the current moment.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        const t = videoRef.current?.currentTime ?? 0;
        setLabels((prev) => (prev.some((x) => Math.abs(x - t) < 0.05) ? prev : [...prev, t].sort((a, b) => a - b)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const videoReady = job && ['ready', 'processing', 'clips_ready', 'merging', 'done'].includes(job.status) && job.status !== 'queued';
  const clips = job?.job_metadata?.clip_info || [];

  const generateClips = async () => {
    if (labels.length === 0) { setBusy('라벨이 없습니다. 영상 재생 중 t 키로 표시하세요.'); return; }
    setBusy('클립 생성 요청 중...');
    try {
      await apiFetch(`/highlight/operator-jobs/${jobId}/clips`, {
        method: 'POST',
        body: JSON.stringify({ labels, before, after }),
      });
      setBusy('클립 생성 중...');
      await loadJob();
    } catch (e) {
      setBusy(e instanceof Error ? e.message : '클립 생성 실패');
    }
  };

  const saveTrim = async (name: string) => {
    if (editEnd <= editStart) { setBusy('종료 시점이 시작보다 커야 합니다.'); return; }
    setBusy('트림 저장 중...');
    try {
      await apiFetch(`/highlight/operator-jobs/${jobId}/clips/${name}/trim`, {
        method: 'POST',
        body: JSON.stringify({ start: editStart, end: editEnd }),
      });
      setEditing(null);
      setBusy('');
      await loadJob();
    } catch (e) {
      setBusy(e instanceof Error ? e.message : '트림 실패');
    }
  };

  const deleteClip = async (name: string) => {
    if (!confirm('이 클립을 삭제할까요?')) return;
    await apiFetch(`/highlight/jobs/${jobId}/clips/${name}`, { method: 'DELETE' });
    await loadJob();
  };

  const mergeClips = async () => {
    setBusy('합치는 중...');
    try {
      await apiFetch(`/highlight/operator-jobs/${jobId}/merge`, { method: 'POST' });
      await loadJob();
    } catch (e) {
      setBusy(e instanceof Error ? e.message : '합치기 실패');
    }
  };

  const seek = (t: number) => {
    if (videoRef.current) { videoRef.current.currentTime = t; setCurrent(t); }
  };

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 18, margin: 0 }}>{job?.display_name || job?.original_filename || '처리'}</h2>
        {job?.owner_name ? <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>업로더: {job.owner_name}</span> : null}
      </div>

      {error ? <p style={{ color: 'var(--danger, #ef4444)', fontSize: 13 }}>{error}</p> : null}

      {!videoReady ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--muted, #999)' }}>
          {job?.status === 'downloading' || job?.source_type === 'link' && job?.status === 'queued'
            ? '링크 영상을 다운로드하는 중입니다...'
            : job?.status === 'error'
            ? `오류: ${job?.stage || ''}`
            : '영상을 불러오는 중...'}
        </div>
      ) : (
        <>
          {/* Player */}
          <div style={card}>
            <video
              ref={videoRef}
              src={`${API_BASE}/highlight/operator-jobs/${jobId}/video`}
              controls
              style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: 460 }}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
            />

            {/* Timeline with labels */}
            <div style={{ marginTop: 12 }}>
              <div
                style={{ position: 'relative', height: 14, borderRadius: 7, background: 'var(--border-ghost)', cursor: 'pointer' }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  seek(((e.clientX - rect.left) / rect.width) * duration);
                }}
              >
                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${duration ? (current / duration) * 100 : 0}%`, background: 'var(--accent, #3b82f6)', borderRadius: 7 }} />
                {labels.map((t, i) => (
                  <div key={i} title={fmt(t)} style={{ position: 'absolute', top: -3, left: `${duration ? (t / duration) * 100 : 0}%`, width: 2, height: 20, background: '#f59e0b' }} />
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted, #999)', marginTop: 4 }}>
                <span>{fmt(current)}</span>
                <span>총 {fmt(duration)}</span>
              </div>
            </div>

            {/* Controls */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginTop: 12 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>배속</span>
                {SPEEDS.map((s) => (
                  <button key={s} onClick={() => setSpeed(s)} style={{ ...btn, padding: '4px 10px', background: speed === s ? 'var(--accent, #3b82f6)' : 'transparent', color: speed === s ? '#fff' : 'var(--text,#eee)', borderColor: speed === s ? 'transparent' : 'var(--border-ghost)' }}>
                    {s}x
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>과거(초)</span>
                <input type="number" value={before} min={0} onChange={(e) => setBefore(Number(e.target.value))} style={{ width: 56, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border-ghost)', background: 'var(--surface-input,#1b1b1f)', color: 'var(--text,#eee)' }} />
                <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>미래(초)</span>
                <input type="number" value={after} min={0} onChange={(e) => setAfter(Number(e.target.value))} style={{ width: 56, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border-ghost)', background: 'var(--surface-input,#1b1b1f)', color: 'var(--text,#eee)' }} />
              </div>
            </div>

            {/* Labels list */}
            <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>라벨 ({labels.length}) — 영상 재생 중 <kbd>t</kbd> 키</span>
              {labels.map((t, i) => (
                <span key={i} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: 'var(--border-ghost)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <button onClick={() => seek(t)} style={{ background: 'none', border: 'none', color: 'var(--accent,#3b82f6)', cursor: 'pointer', padding: 0 }}>{fmt(t)}</button>
                  <button onClick={() => setLabels((p) => p.filter((_, idx) => idx !== i))} style={{ background: 'none', border: 'none', color: 'var(--muted,#999)', cursor: 'pointer', padding: 0 }}>×</button>
                </span>
              ))}
            </div>

            <button onClick={generateClips} disabled={job?.status === 'processing'} style={{ ...primaryBtn, marginTop: 14 }}>
              {job?.status === 'processing' ? '클립 생성 중...' : '클립 생성'}
            </button>
          </div>

          {/* Clip edit area */}
          {clips.length > 0 ? (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 15, margin: 0 }}>클립 편집 ({clips.length})</h3>
                <button onClick={mergeClips} disabled={job?.status === 'merging'} style={primaryBtn}>
                  {job?.status === 'merging' ? '합치는 중...' : '클립 합치기'}
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                {clips.map((clip) => (
                  <div key={clip.name} style={{ border: '1px solid var(--border-ghost)', borderRadius: 8, padding: 8 }}>
                    <video src={`${API_BASE}/highlight/jobs/${jobId}/clips/${clip.name}`} controls style={{ width: '100%', borderRadius: 6, background: '#000' }} />
                    {editing === clip.name ? (
                      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                          시작<input type="number" step="0.1" value={editStart} onChange={(e) => setEditStart(Number(e.target.value))} style={{ width: 64, padding: '3px 5px', borderRadius: 6, border: '1px solid var(--border-ghost)', background: 'var(--surface-input,#1b1b1f)', color: 'var(--text,#eee)' }} />
                          끝<input type="number" step="0.1" value={editEnd} onChange={(e) => setEditEnd(Number(e.target.value))} style={{ width: 64, padding: '3px 5px', borderRadius: 6, border: '1px solid var(--border-ghost)', background: 'var(--surface-input,#1b1b1f)', color: 'var(--text,#eee)' }} />
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => saveTrim(clip.name)} style={{ ...primaryBtn, padding: '4px 10px', fontSize: 12 }}>저장</button>
                          <button onClick={() => setEditing(null)} style={{ ...btn, padding: '4px 10px', fontSize: 12 }}>취소</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: 'var(--muted,#999)' }}>{fmt(clip.start)}~{fmt(clip.end)}</span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => { setEditing(clip.name); setEditStart(clip.start); setEditEnd(clip.end); }} style={{ ...btn, padding: '3px 8px', fontSize: 12 }}>편집</button>
                          <button onClick={() => deleteClip(clip.name)} style={{ ...btn, padding: '3px 8px', fontSize: 12 }}>🗑</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Result */}
          {job?.status === 'done' && job?.export_path ? (
            <div style={card}>
              <h3 style={{ fontSize: 15, marginTop: 0 }}>완성된 하이라이트</h3>
              <video src={`${API_BASE}/highlight/jobs/${jobId}/export/download`} controls style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: 460 }} />
              <a href={`${API_BASE}/highlight/jobs/${jobId}/export/download`} style={{ ...primaryBtn, display: 'inline-block', textDecoration: 'none', marginTop: 12 }}>
                다운로드 ↓
              </a>
            </div>
          ) : null}
        </>
      )}

      {busy ? <p style={{ fontSize: 13, color: 'var(--muted, #999)' }}>{busy}</p> : null}
    </div>
  );
}
