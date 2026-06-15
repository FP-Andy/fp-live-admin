'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiJson } from '../../../lib/api';
import HighlightSubTabs from './HighlightSubTabs';

type ClipTimestamp = { start: number; end: number };
type JobProgress = {
  phase?: string;
  percent?: number;
  detail?: string;
  updated_at?: string;
};

type JobMetadata = {
  clips?: string[];
  selected?: Record<string, boolean>;
  clip_scores?: Record<string, number>;
  clip_features?: Record<string, string>;
  clip_feature_stats?: Record<string, Record<string, number>>;
  clip_timestamps?: Record<string, ClipTimestamp>;
  events?: Array<{ clip: string; source: string; event_type?: string }>;
  message?: string;
  progress?: JobProgress;
};

const FEATURE_LABELS: Record<string, string> = {
  inv_dist_centroid_masked: '공격 집중도',
  player_density: '선수 밀집도',
  f_ball_accel: '공 가속도',
  f_ball_speed: '공 속도',
  f_ball_dir_change: '공 방향전환',
  f_players_near_ball: '공 주변 선수',
  f_audio: '관중 환호',
  inv_dist_centroid_masked_max: '공격 집중 (피크)',
  inv_dist_centroid_masked_mean: '공격 집중 (평균)',
  f_ball_speed_max: '공 속도 (피크)',
  f_ball_speed_anchor: '공 속도 (순간)',
  f_ball_accel_std: '공 가속 변동성',
  f_goalpost_visible_mean: '골대 시야 확보율',
  f_ball_dir_change_max: '공 방향전환 (피크)',
  f_ball_dir_change_mean: '공 방향전환 (평균)',
  f_possession_switches_mean: '점유권 전환 빈도',
  f_sprint_count_max: '스프린트 선수 수',
  f_ball_to_goal_width_ratio_mean: '공-골대 근접도',
  f_goal_bbox_width_norm_mean: '골대 확대 수준',
  f_players_near_ball_max: '공 근처 선수 (피크)',
};

function ShapChart({ stats, compact = false }: { stats: Record<string, number>; compact?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stats) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.offsetWidth || canvas.width;
    const H = canvas.offsetHeight || canvas.height;
    canvas.width = W;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    const entries = Object.entries(stats)
      .map(([k, v]) => ({ key: k, val: v }))
      .sort((a, b) => Math.abs(b.val) - Math.abs(a.val));

    const shown = compact ? entries.slice(0, 5) : entries;
    if (!shown.length) return;

    const maxAbs = Math.max(...shown.map((e) => Math.abs(e.val)), 1e-9);
    const rowH = Math.floor(H / shown.length);
    const labelW = compact ? 88 : 140;
    const barAreaW = W - labelW - 8;
    const midX = labelW + barAreaW * 0.5;

    ctx.font = `${compact ? 10 : 12}px system-ui, sans-serif`;

    shown.forEach((e, i) => {
      const y = i * rowH;
      const barLen = (Math.abs(e.val) / maxAbs) * (barAreaW * 0.45);
      const isPos = e.val >= 0;
      const label = FEATURE_LABELS[e.key] || e.key;
      const pct = (e.val * 100).toFixed(1);

      ctx.fillStyle = '#c9b7a7';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, labelW - 4, y + rowH * 0.5);

      const barX = isPos ? midX : midX - barLen;
      const barY = y + rowH * 0.2;
      const barH = rowH * 0.6;
      ctx.fillStyle = isPos ? '#ff8a1d' : '#6ab4f5';
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(barX, barY, barLen, barH, 2);
      } else {
        ctx.rect(barX, barY, barLen, barH);
      }
      ctx.fill();

      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(midX, y);
      ctx.lineTo(midX, y + rowH);
      ctx.stroke();

      if (!compact) {
        ctx.fillStyle = isPos ? '#ffb37c' : '#90c8f8';
        ctx.textAlign = isPos ? 'left' : 'right';
        ctx.fillText(
          `${isPos ? '+' : ''}${pct}%`,
          isPos ? midX + barLen + 3 : midX - barLen - 3,
          y + rowH * 0.5,
        );
      }
    });
  }, [stats, compact]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: '100%',
        height: compact ? 80 : 200,
        marginTop: 8,
        borderRadius: 6,
        background: 'rgba(0,0,0,0.25)',
      }}
    />
  );
}

type HighlightJob = {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  mode: 'ai' | 'log_ai';
  original_filename: string;
  error_message?: string;
  job_metadata: JobMetadata;
  created_at: string;
  updated_at: string;
};

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function scoreColor(score: number) {
  if (score >= 0.7) return 'var(--success)';
  if (score >= 0.4) return 'var(--warning)';
  return 'var(--muted)';
}

export default function HighlightPage() {
  const [jobs, setJobs] = useState<HighlightJob[]>([]);
  const [activeJob, setActiveJob] = useState<HighlightJob | null>(null);
  const [mode, setMode] = useState<'ai' | 'log_ai'>('ai');
  const [highlightCount, setHighlightCount] = useState(40);
  const [secondHalfMin, setSecondHalfMin] = useState('');
  const [secondHalfSecPart, setSecondHalfSecPart] = useState('');
  const [logDataJson, setLogDataJson] = useState('');
  const [selectedClips, setSelectedClips] = useState<Record<string, boolean>>({});
  const [clipOrder, setClipOrder] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportReady, setExportReady] = useState(false);
  const [status, setStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logFileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const data = await apiJson<HighlightJob[]>('/highlight/jobs?limit=10');
      setJobs(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const job = await apiJson<HighlightJob>(`/highlight/jobs/${jobId}`);
        setActiveJob(job);
        if (job.status === 'done' || job.status === 'error') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          if (job.status === 'done') {
            const clips = job.job_metadata?.clips || [];
            setClipOrder(clips);
            const initial: Record<string, boolean> = {};
            clips.forEach((c) => (initial[c] = true));
            setSelectedClips(initial);
            setExportReady(false);
          }
          loadJobs();
        }
      } catch {
        clearInterval(pollRef.current!);
        pollRef.current = null;
      }
    }, 3000);
  }, [loadJobs]);

  const handleLogFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setLogDataJson(ev.target?.result as string);
    reader.readAsText(file);
  };

  const uploadHighlightJob = (form: FormData) => new Promise<{ job_id: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/highlight/jobs`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setUploadProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(form);
  });

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setStatus('영상 파일을 선택해주세요.');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setStatus('업로드 중...');
    setActiveJob(null);
    setSelectedClips({});
    setClipOrder([]);
    setExportReady(false);

    const form = new FormData();
    form.append('video', file);
    form.append('mode', mode);
    form.append('highlight_count', String(highlightCount));
    form.append('second_half_start_sec', String((parseInt(secondHalfMin) || 0) * 60 + (parseInt(secondHalfSecPart) || 0)));
    form.append('log_data_json', logDataJson || '[]');

    try {
      const data = await uploadHighlightJob(form);
      setUploadProgress(100);
      setStatus('분석 시작됨 — 완료까지 수분~수십분 소요됩니다.');
      const job = await apiJson<HighlightJob>(`/highlight/jobs/${data.job_id}`);
      setActiveJob(job);
      startPolling(data.job_id);
      loadJobs();
    } catch (err) {
      setStatus(`오류: ${err}`);
    } finally {
      setUploading(false);
    }
  };

  const handleExport = async () => {
    if (!activeJob) return;
    const ordered = clipOrder.filter((c) => selectedClips[c]);
    if (!ordered.length) {
      setStatus('내보낼 클립을 선택해주세요.');
      return;
    }
    setExporting(true);
    setStatus('클립 합치는 중...');
    try {
      await apiJson(`/highlight/jobs/${activeJob.id}/export`, {
        method: 'POST',
        body: JSON.stringify({ selected: ordered, order: ordered }),
      });
      setExportReady(true);
      setStatus('합치기 완료 — 다운로드 버튼을 눌러주세요.');
    } catch (err) {
      setStatus(`내보내기 오류: ${err}`);
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async (jobId: string) => {
    if (!window.confirm('이 작업과 모든 클립을 삭제할까요?')) return;
    try {
      await apiJson(`/highlight/jobs/${jobId}`, { method: 'DELETE' });
      if (activeJob?.id === jobId) {
        setActiveJob(null);
        setSelectedClips({});
        setClipOrder([]);
        setExportReady(false);
      }
      loadJobs();
      setStatus('삭제 완료');
    } catch (err) {
      setStatus(`삭제 오류: ${err}`);
    }
  };

  const handleDragStart = (idx: number) => { dragItem.current = idx; };
  const handleDragEnter = (idx: number) => { dragOverItem.current = idx; };
  const handleDragEnd = () => {
    if (dragItem.current === null || dragOverItem.current === null) return;
    const newOrder = [...clipOrder];
    const dragged = newOrder.splice(dragItem.current, 1)[0];
    newOrder.splice(dragOverItem.current, 0, dragged);
    setClipOrder(newOrder);
    dragItem.current = null;
    dragOverItem.current = null;
  };

  const meta = activeJob?.job_metadata || {};
  const progress = meta.progress || {};
  const processingPercent = Math.max(0, Math.min(Number(progress.percent || 0), 100));
  const progressLabel = progress.detail || (activeJob?.status === 'queued' ? '분석 대기 중...' : '하이라이트 추출 중...');
  const clips = activeJob?.status === 'done' ? (clipOrder.length ? clipOrder : meta.clips || []) : [];
  const selectedCount = Object.values(selectedClips).filter(Boolean).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
    <HighlightSubTabs />
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>

    {/* ── Left panel: upload form + job history ── */}
    <div style={{ flex: '0 1 270px', minWidth: 160, maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12 }}>

        <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 16, border: '1px solid var(--border-ghost)' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 10 }}>NEW ANALYSIS</div>

          {/* mode toggle */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {(['ai', 'log_ai'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  flex: 1, padding: '6px 0', fontSize: 11, fontWeight: 600,
                  background: mode === m ? 'var(--accent)' : 'var(--button-dark)',
                  color: mode === m ? '#fff' : 'var(--muted)',
                  border: 'none', borderRadius: 'var(--radius-control)', cursor: 'pointer',
                }}
              >
                {m === 'ai' ? 'AI Only' : 'Log + AI'}
              </button>
            ))}
          </div>

          <form onSubmit={handleUpload} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>영상 파일</div>
              <input ref={fileInputRef} type="file" accept="video/*" style={{ width: '100%', fontSize: 11 }} />
            </div>

            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>클립 수</div>
              <input
                type="number" min={1} max={100} value={highlightCount}
                onChange={(e) => setHighlightCount(Number(e.target.value))}
                style={{ width: '100%', fontSize: 12 }}
              />
            </div>

            <div style={{ visibility: mode === 'log_ai' ? 'visible' : 'hidden', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 3 }}>후반전 시작</div>
                  <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="text" inputMode="numeric" pattern="[0-9]*"
                      value={secondHalfMin} placeholder="0"
                      onChange={(e) => setSecondHalfMin(e.target.value.replace(/\D/g, ''))}
                      style={{ flex: '1 1 70px', minWidth: 0, fontSize: 11, padding: '4px 6px' }}
                    />
                    <span style={{ fontSize: 10, color: 'var(--muted)' }}>분</span>
                    <input
                      type="text" inputMode="numeric" pattern="[0-9]*"
                      value={secondHalfSecPart} placeholder="0"
                      onChange={(e) => setSecondHalfSecPart(e.target.value.replace(/\D/g, ''))}
                      style={{ flex: '1 1 70px', minWidth: 0, fontSize: 11, padding: '4px 6px' }}
                    />
                    <span style={{ fontSize: 10, color: 'var(--muted)' }}>초</span>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 3 }}>로그 데이터</div>
                  <input
                    ref={logFileInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={handleLogFile}
                  />
                  <button
                    type="button"
                    onClick={() => logFileInputRef.current?.click()}
                    style={{
                      width: '100%', padding: '5px 0', fontSize: 11,
                      background: logDataJson ? 'var(--success-soft)' : 'var(--button-dark)',
                      color: logDataJson ? 'var(--success)' : 'var(--text)',
                      border: `1px solid ${logDataJson ? 'var(--success)' : 'var(--border-ghost)'}`,
                      borderRadius: 'var(--radius-control)', cursor: 'pointer',
                    }}
                  >
                    {logDataJson ? '✓ 로드됨 (재선택)' : 'JSON 파일 선택'}
                  </button>
                </div>
            </div>

            <button
              type="submit"
              disabled={uploading}
              style={{
                padding: '9px 0', fontWeight: 700, fontSize: 12,
                background: uploading ? 'var(--button-dark)' : 'var(--accent)',
                color: uploading ? 'var(--muted)' : '#fff',
                border: 'none', borderRadius: 'var(--radius-control)', cursor: uploading ? 'not-allowed' : 'pointer',
              }}
            >
              {uploading ? '처리 중...' : '분석 시작'}
            </button>
          </form>

          {uploading && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 5 }}>
                <span>업로드 진행률</span>
                <strong style={{ color: 'var(--text)' }}>{uploadProgress}%</strong>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: 'var(--button-dark)', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${uploadProgress}%`,
                    height: '100%',
                    borderRadius: 999,
                    background: 'var(--accent)',
                    transition: 'width 160ms ease',
                  }}
                />
              </div>
            </div>
          )}

          {status && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>{status}</div>
          )}
        </div>

        {/* job history */}
        <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 16, border: '1px solid var(--border-ghost)' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 10 }}>RECENT JOBS</div>
          {jobs.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>없음</div>}
          {jobs.map((job) => (
            <div
              key={job.id}
              onClick={() => {
                setActiveJob(job);
                if (job.status === 'done') {
                  const c = job.job_metadata?.clips || [];
                  setClipOrder(c);
                  const init: Record<string, boolean> = {};
                  c.forEach((x) => (init[x] = true));
                  setSelectedClips(init);
                  setExportReady(false);
                } else if (job.status === 'queued' || job.status === 'processing') {
                  startPolling(job.id);
                }
              }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', marginBottom: 8, cursor: 'pointer',
                background: activeJob?.id === job.id ? 'var(--accent-soft)' : 'var(--button-dark)',
                borderRadius: 'var(--radius-control)',
                border: activeJob?.id === job.id ? '1px solid var(--border-emphasis)' : '1px solid transparent',
              }}
            >
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
                  {job.original_filename.length > 22
                    ? job.original_filename.slice(0, 20) + '…'
                    : job.original_filename}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {job.mode === 'log_ai' ? 'Log+AI' : 'AI'} · {new Date(job.created_at).toLocaleDateString()}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 999,
                  background: job.status === 'done' ? 'var(--success-soft)' : job.status === 'error' ? 'var(--danger-soft)' : 'var(--accent-soft)',
                  color: job.status === 'done' ? 'var(--success)' : job.status === 'error' ? 'var(--danger)' : 'var(--accent)',
                }}>
                  {job.status.toUpperCase()}
                </span>
                <button
                  onClick={(ev) => { ev.stopPropagation(); handleDelete(job.id); }}
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, fontSize: 14 }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right panel: analysis result ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* progress / status bar */}
        {activeJob && (activeJob.status === 'queued' || activeJob.status === 'processing') && (
          <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 24, border: '1px solid var(--border-ghost)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>PROCESSING</div>
              <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 700 }}>{processingPercent}%</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <div style={{
                width: 12, height: 12, borderRadius: '50%',
                background: 'var(--accent)', animation: 'pulse 1.2s ease-in-out infinite', flex: '0 0 auto',
              }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--text)' }}>{progressLabel}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                  {activeJob.status === 'queued' ? '작업은 대기열에 있으며 페이지를 나가도 유지됩니다.' : 'GPU 워커가 백그라운드에서 처리 중입니다. 페이지를 나가도 계속 진행됩니다.'}
                </div>
              </div>
            </div>
            <div style={{ height: 10, borderRadius: 999, background: 'var(--button-dark)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${processingPercent}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: 'var(--accent)',
                  transition: 'width 220ms ease',
                }}
              />
            </div>
          </div>
        )}

        {activeJob?.status === 'error' && (
          <div style={{ background: 'var(--danger-soft)', borderRadius: 'var(--radius-card)', padding: 24, border: '1px solid var(--border-danger)' }}>
            <div style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 8 }}>ERROR</div>
            <div style={{ fontSize: 13 }}>{activeJob.error_message}</div>
          </div>
        )}

        {/* clips grid */}
        {activeJob?.status === 'done' && clips.length > 0 && (
          <>
            {/* export bar */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
              background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: '16px 24px',
              border: '1px solid var(--border-ghost)',
            }}>
              <div style={{ fontSize: 13 }}>
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{selectedCount}</span>
                <span style={{ color: 'var(--muted)' }}> / {clips.length}개 선택됨</span>
                <span style={{ marginLeft: 16, fontSize: 11, color: 'var(--muted)' }}>{meta.message}</span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => {
                    const all: Record<string, boolean> = {};
                    clips.forEach((c) => (all[c] = true));
                    setSelectedClips(all);
                  }}
                  style={{ fontSize: 12, padding: '8px 16px', background: 'var(--button-dark)', border: '1px solid var(--border-ghost)', borderRadius: 'var(--radius-control)', cursor: 'pointer', color: 'var(--text)' }}
                >
                  전체 선택
                </button>
                <button
                  onClick={handleExport}
                  disabled={exporting || selectedCount === 0}
                  style={{
                    fontSize: 12, padding: '8px 20px', fontWeight: 700,
                    background: exporting || selectedCount === 0 ? 'var(--button-dark)' : 'var(--accent)',
                    color: exporting || selectedCount === 0 ? 'var(--muted)' : '#fff',
                    border: 'none', borderRadius: 'var(--radius-control)', cursor: exporting || selectedCount === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {exporting ? '합치는 중...' : '선택 클립 합치기'}
                </button>
                {exportReady && (
                  <a
                    href={`${API_BASE}/highlight/jobs/${activeJob.id}/export/download`}
                    download
                    style={{
                      display: 'inline-flex', alignItems: 'center',
                      fontSize: 12, padding: '8px 20px', fontWeight: 700,
                      background: 'var(--success)', color: '#000',
                      borderRadius: 'var(--radius-control)', textDecoration: 'none',
                    }}
                  >
                    ↓ 다운로드
                  </a>
                )}
              </div>
            </div>

            {/* order hint */}
            <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 4 }}>
              드래그로 순서 변경 · 체크박스로 포함/제외
            </div>

            {/* clips */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
              {clips.map((clip, idx) => {
                const ts = meta.clip_timestamps?.[clip];
                const score = meta.clip_scores?.[clip] ?? 0;
                const feat = meta.clip_features?.[clip] ?? '';
                const shapStats = meta.clip_feature_stats?.[clip];
                const evMeta = meta.events?.find((e) => e.clip === clip);
                const isLog = evMeta?.source === 'log';

                return (
                  <div
                    key={clip}
                    draggable
                    onDragStart={() => handleDragStart(idx)}
                    onDragEnter={() => handleDragEnter(idx)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => e.preventDefault()}
                    style={{
                      background: 'var(--surface-card)',
                      borderRadius: 'var(--radius-card)',
                      border: selectedClips[clip]
                        ? '1px solid var(--border-emphasis)'
                        : '1px solid var(--border-ghost)',
                      overflow: 'hidden',
                      cursor: 'grab',
                      opacity: selectedClips[clip] ? 1 : 0.55,
                    }}
                  >
                    <video
                      src={`${API_BASE}/highlight/jobs/${activeJob.id}/clips/${clip}`}
                      controls
                      preload="metadata"
                      style={{ width: '100%', display: 'block', background: '#000', maxHeight: 160 }}
                    />
                    <div style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
                            background: isLog ? 'var(--tech-soft)' : 'var(--accent-soft)',
                            color: isLog ? 'var(--tech)' : 'var(--accent)',
                          }}>
                            {isLog ? (evMeta?.event_type || 'LOG') : 'AI'}
                          </span>
                          <span style={{ fontSize: 11, color: scoreColor(score), fontWeight: 600 }}>
                            {score > 0 ? score.toFixed(3) : '—'}
                          </span>
                        </div>
                        <input
                          type="checkbox"
                          checked={!!selectedClips[clip]}
                          onChange={(e) => setSelectedClips((prev) => ({ ...prev, [clip]: e.target.checked }))}
                          style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
                        />
                      </div>
                      {ts && (
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                          ⏱ {fmtTime(ts.start)} ~ {fmtTime(ts.end)}
                        </div>
                      )}
                      {feat && !shapStats && (
                        <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{feat}</div>
                      )}
                      {shapStats && <ShapChart stats={shapStats} compact />}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {!activeJob && (
          <div style={{
            background: 'var(--surface-card)', borderRadius: 'var(--radius-card)',
            padding: 48, textAlign: 'center', border: '1px solid var(--border-ghost)',
          }}>
            <div style={{ fontSize: 32, marginBottom: 16, opacity: 0.4 }}>▶</div>
            <div style={{ color: 'var(--muted)', fontSize: 14 }}>
              왼쪽에서 영상을 업로드하거나 기존 작업을 선택하세요
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
    </div>
  );
}
