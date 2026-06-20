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
  jersey_number?: string | null;
  player_name?: string | null;
  uniform_color?: string | null;
  has_reference_image?: boolean;
  source_type: string | null;
  source_url: string | null;
  export_path: string | null;
  owner_name?: string | null;
  job_metadata?: {
    clip_info?: ClipInfo[];
    operator_action?: { type?: string };
    progress?: { detail?: string; percent?: number };
  };
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

// M:SS.s — finer readout for the trim handles.
function fmt1(sec: number) {
  if (!isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function TrimHandle({ left, label, onDown }: { left: string; label: string; onDown: () => void }) {
  return (
    <div
      onPointerDown={(e) => { e.preventDefault(); onDown(); }}
      style={{ position: 'absolute', top: -4, bottom: -4, left, transform: 'translateX(-50%)', width: 14, background: 'var(--accent,#3b82f6)', borderRadius: 4, cursor: 'ew-resize', touchAction: 'none' }}
    >
      <span style={{ position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)', fontSize: 11, color: 'var(--accent,#3b82f6)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{label}</span>
    </div>
  );
}

// CapCut-style drag trimmer. Re-cut happens on the ORIGINAL source video, so the
// timeline is zoomed to a window around the clip for precise dragging.
function TrimModal({
  jobId, clip, onCancel, onSave,
}: {
  jobId: string;
  clip: ClipInfo;
  onCancel: () => void;
  onSave: (start: number, end: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [srcDuration, setSrcDuration] = useState(0);
  const [start, setStart] = useState(clip.start);
  const [end, setEnd] = useState(clip.end);
  const [drag, setDrag] = useState<null | 'start' | 'end'>(null);
  const [previewing, setPreviewing] = useState(false);

  const clipLen = Math.max(0.5, clip.end - clip.start);
  const margin = Math.max(5, clipLen);
  const winStart = Math.max(0, clip.start - margin);
  const winEnd = srcDuration ? Math.min(srcDuration, clip.end + margin) : clip.end + margin;
  const span = Math.max(0.1, winEnd - winStart);
  const pct = (t: number) => `${((t - winStart) / span) * 100}%`;

  useEffect(() => {
    if (!drag) return;
    const timeFromX = (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return winStart + r * span;
    };
    const onMove = (e: PointerEvent) => {
      const t = timeFromX(e.clientX);
      if (drag === 'start') {
        const ns = Math.max(winStart, Math.min(t, end - 0.2));
        setStart(ns);
        if (videoRef.current) videoRef.current.currentTime = ns;
      } else {
        const ne = Math.min(winEnd, Math.max(t, start + 0.2));
        setEnd(ne);
        if (videoRef.current) videoRef.current.currentTime = ne;
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, start, end, winStart, winEnd, span]);

  const previewRegion = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = start;
    v.play();
    setPreviewing(true);
  };

  return (
    <div
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface-card, #1b1b1f)', borderRadius: 12, border: '1px solid var(--border-ghost)', padding: 20, width: 'min(900px, 96vw)', maxHeight: '92vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>클립 자르기</h3>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--muted,#999)', fontSize: 22, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <video
          ref={videoRef}
          src={`${API_BASE}/highlight/operator-jobs/${jobId}/video`}
          controls
          style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: '52vh' }}
          onLoadedMetadata={(e) => { setSrcDuration(e.currentTarget.duration); e.currentTarget.currentTime = clip.start; }}
          onTimeUpdate={(e) => { if (previewing && e.currentTarget.currentTime >= end) { e.currentTarget.pause(); setPreviewing(false); } }}
        />

        {/* Drag-to-trim timeline (zoomed around the clip) */}
        <div style={{ paddingTop: 22, paddingBottom: 4 }}>
          <div
            ref={trackRef}
            style={{ position: 'relative', height: 40, borderRadius: 8, background: 'var(--border-ghost)', userSelect: 'none', touchAction: 'none' }}
          >
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct(start), width: `calc(${pct(end)} - ${pct(start)})`, background: 'rgba(59,130,246,0.30)', border: '1px solid var(--accent,#3b82f6)', borderRadius: 6 }} />
            <TrimHandle left={pct(start)} label={fmt1(start)} onDown={() => setDrag('start')} />
            <TrimHandle left={pct(end)} label={fmt1(end)} onDown={() => setDrag('end')} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted,#999)', marginTop: 6 }}>
            <span>{fmt1(winStart)}</span>
            <span>{fmt1(winEnd)}</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
          <span>시작 <b style={{ color: 'var(--accent,#3b82f6)' }}>{fmt1(start)}</b></span>
          <span>끝 <b style={{ color: 'var(--accent,#3b82f6)' }}>{fmt1(end)}</b></span>
          <span>길이 <b>{(end - start).toFixed(1)}s</b></span>
          <button onClick={previewRegion} style={{ ...btn, padding: '5px 12px' }}>▶ 구간 미리보기</button>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btn}>취소</button>
          <button onClick={() => onSave(Number(start.toFixed(2)), Number(end.toFixed(2)))} disabled={end <= start} style={primaryBtn}>저장</button>
        </div>
      </div>
    </div>
  );
}

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
  const [editingClip, setEditingClip] = useState<ClipInfo | null>(null);

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

  // Hotkeys: 't' to label the current moment, space to play/pause.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        const t = videoRef.current?.currentTime ?? 0;
        setLabels((prev) => (prev.some((x) => Math.abs(x - t) < 0.05) ? prev : [...prev, t].sort((a, b) => a - b)));
      } else if (e.key === ' ' || e.code === 'Space') {
        const v = videoRef.current;
        if (!v) return;
        e.preventDefault();
        if (v.paused) v.play(); else v.pause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pendingAction = job?.job_metadata?.operator_action?.type;
  const videoReady = job && (
    ['ready', 'processing', 'clips_ready', 'merging', 'done'].includes(job.status) ||
    (job.status === 'queued' && Boolean(pendingAction) && pendingAction !== 'download')
  );
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

  const saveTrim = async (name: string, start: number, end: number) => {
    if (end <= start) { setBusy('종료 시점이 시작보다 커야 합니다.'); return; }
    setBusy('트림 저장 중...');
    try {
      await apiFetch(`/highlight/operator-jobs/${jobId}/clips/${name}/trim`, {
        method: 'POST',
        body: JSON.stringify({ start, end }),
      });
      setEditingClip(null);
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
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
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
          <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 480px', minWidth: 0 }}>
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
            </div>

            <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 분석할 선수 기준 이미지 */}
            {job?.has_reference_image ? (
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${API_BASE}/highlight/operator-jobs/${jobId}/reference`}
                  alt="분석 대상 선수"
                  style={{ width: 96, borderRadius: 6, border: '1px solid var(--border-ghost)', background: '#000' }}
                />
                <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontWeight: 600 }}>분석 대상 선수</span>
                  {job?.player_name ? <span>{job.player_name}</span> : null}
                  {job?.jersey_number ? <span style={{ color: 'var(--muted,#999)' }}>등번호 {job.jersey_number}</span> : null}
                  {job?.uniform_color ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted,#999)' }}>
                      유니폼
                      <span style={{ width: 14, height: 14, borderRadius: '50%', background: job.uniform_color, border: '1px solid rgba(255,255,255,0.25)' }} />
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
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

            <button onClick={generateClips} disabled={job?.status === 'processing'} style={{ ...primaryBtn, marginTop: 2 }}>
              {job?.status === 'processing' ? '클립 생성 중...' : '클립 생성'}
            </button>
            </div>
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
                    <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: 'var(--muted,#999)' }}>{fmt(clip.start)}~{fmt(clip.end)}</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => setEditingClip(clip)} style={{ ...btn, padding: '3px 8px', fontSize: 12 }}>편집</button>
                        <button onClick={() => deleteClip(clip.name)} style={{ ...btn, padding: '3px 8px', fontSize: 12 }}>🗑</button>
                      </div>
                    </div>
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

      {editingClip ? (
        <TrimModal
          jobId={jobId}
          clip={editingClip}
          onCancel={() => setEditingClip(null)}
          onSave={(s, e) => saveTrim(editingClip.name, s, e)}
        />
      ) : null}

      {busy ? <p style={{ fontSize: 13, color: 'var(--muted, #999)' }}>{busy}</p> : null}
    </div>
  );
}
