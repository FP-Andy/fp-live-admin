'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiJson } from '../../../lib/api';

type ClipTimestamp = { start: number; end: number };

type JobMetadata = {
  clips?: string[];
  selected?: Record<string, boolean>;
  clip_scores?: Record<string, number>;
  clip_features?: Record<string, string>;
  clip_feature_stats?: Record<string, Record<string, number>>;
  clip_timestamps?: Record<string, ClipTimestamp>;
  events?: Array<{ clip: string; source: string; event_type?: string }>;
  message?: string;
  trimmed?: Record<string, { start: number; end: number }>;
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
  display_name?: string | null;
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

// ── Trim Modal ────────────────────────────────────────────────────────────────
function TrimModal({
  jobId, clipName, onClose, onDone,
}: { jobId: string; clipName: string; onClose: () => void; onDone: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimming, setTrimming] = useState(false);
  const src = `${API_BASE}/highlight/jobs/${jobId}/clips/${clipName}`;

  const handleLoaded = () => {
    const d = videoRef.current?.duration || 0;
    setDuration(d);
    setTrimEnd(d);
  };

  const handleTrim = async () => {
    setTrimming(true);
    try {
      await apiJson(`/highlight/jobs/${jobId}/clips/${clipName}/trim`, {
        method: 'POST',
        body: JSON.stringify({ start: trimStart, end: trimEnd }),
      });
      onDone();
    } catch (err) {
      alert(`트림 실패: ${err}`);
    } finally {
      setTrimming(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
    }}>
      <div style={{
        background: 'var(--surface-card)', borderRadius: 16, padding: 24,
        width: 'min(680px, 95vw)', border: '1px solid var(--border-ghost)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>클립 편집 — {clipName}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 18 }}>✕</button>
        </div>

        <video
          ref={videoRef}
          src={src}
          controls
          onLoadedMetadata={handleLoaded}
          style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: 320 }}
        />

        <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span style={{ color: 'var(--muted)' }}>시작 (초)</span>
            <input
              type="number" min={0} max={trimEnd - 0.1} step={0.1}
              value={trimStart.toFixed(1)}
              onChange={(e) => setTrimStart(Math.max(0, parseFloat(e.target.value) || 0))}
              style={{ width: 90, fontSize: 13 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span style={{ color: 'var(--muted)' }}>끝 (초)</span>
            <input
              type="number" min={trimStart + 0.1} max={duration} step={0.1}
              value={trimEnd.toFixed(1)}
              onChange={(e) => setTrimEnd(Math.min(duration, parseFloat(e.target.value) || duration))}
              style={{ width: 90, fontSize: 13 }}
            />
          </label>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 16 }}>
            구간: {fmtTime(trimStart)} ~ {fmtTime(trimEnd)} ({(trimEnd - trimStart).toFixed(1)}초)
          </div>
          <button
            onClick={() => {
              const cur = videoRef.current?.currentTime;
              if (cur !== undefined) setTrimStart(parseFloat(cur.toFixed(1)));
            }}
            style={{ marginTop: 16, fontSize: 11, padding: '5px 10px', background: 'var(--button-dark)', border: '1px solid var(--border-ghost)', borderRadius: 6, cursor: 'pointer', color: 'var(--text)' }}
          >
            현재 위치를 시작으로
          </button>
          <button
            onClick={() => {
              const cur = videoRef.current?.currentTime;
              if (cur !== undefined) setTrimEnd(parseFloat(cur.toFixed(1)));
            }}
            style={{ marginTop: 16, fontSize: 11, padding: '5px 10px', background: 'var(--button-dark)', border: '1px solid var(--border-ghost)', borderRadius: 6, cursor: 'pointer', color: 'var(--text)' }}
          >
            현재 위치를 끝으로
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} style={{ fontSize: 13, padding: '8px 20px', background: 'var(--button-dark)', border: '1px solid var(--border-ghost)', borderRadius: 8, cursor: 'pointer', color: 'var(--text)' }}>
            취소
          </button>
          <button
            onClick={handleTrim}
            disabled={trimming || trimEnd <= trimStart}
            style={{ fontSize: 13, padding: '8px 20px', fontWeight: 700, background: trimming ? 'var(--button-dark)' : 'var(--accent)', color: trimming ? 'var(--muted)' : '#fff', border: 'none', borderRadius: 8, cursor: trimming ? 'not-allowed' : 'pointer' }}
          >
            {trimming ? '트림 중...' : '적용'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Timeline Editor ───────────────────────────────────────────────────────────
type TimelineItem = { type: 'clip' | 'image'; name: string; duration?: number };

function TimelineEditor({ job, bgmList }: { job: HighlightJob; bgmList: string[] }) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [imageCards, setImageCards] = useState<string[]>([]);
  const [transitionSec, setTransitionSec] = useState(0.5);
  const [audioVolume, setAudioVolume] = useState(1.0);
  const [bgmName, setBgmName] = useState('');
  const [bgmVolume, setBgmVolume] = useState(0.3);
  const [exporting, setExporting] = useState(false);
  const [exportReady, setExportReady] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const imgInputRef = useRef<HTMLInputElement>(null);
  const dragIdx = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);

  const clips = job.job_metadata?.clips || [];

  const loadImageCards = useCallback(async () => {
    try {
      const d = await apiJson<{ cards: string[] }>(`/highlight/jobs/${job.id}/image-cards`);
      setImageCards(d.cards || []);
    } catch { /* ignore */ }
  }, [job.id]);

  useEffect(() => { loadImageCards(); }, [loadImageCards]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      await fetch(`${API_BASE}/highlight/jobs/${job.id}/image-cards`, {
        method: 'POST', credentials: 'include', body: form,
      });
      await loadImageCards();
    } catch (err) { setStatusMsg(`업로드 실패: ${err}`); }
    e.target.value = '';
  };

  const addClip = (name: string) => setItems((prev) => [...prev, { type: 'clip', name }]);
  const addImage = (name: string) => setItems((prev) => [...prev, { type: 'image', name, duration: 3.0 }]);
  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));
  const updateDuration = (idx: number, val: number) =>
    setItems((prev) => prev.map((it, i) => i === idx ? { ...it, duration: val } : it));

  const handleDragStart = (idx: number) => { dragIdx.current = idx; };
  const handleDragEnter = (idx: number) => { dragOverIdx.current = idx; };
  const handleDragEnd = () => {
    if (dragIdx.current === null || dragOverIdx.current === null) return;
    const next = [...items];
    const [moved] = next.splice(dragIdx.current, 1);
    next.splice(dragOverIdx.current, 0, moved);
    setItems(next);
    dragIdx.current = null;
    dragOverIdx.current = null;
  };

  const handleExport = async () => {
    if (!items.length) { setStatusMsg('타임라인이 비어 있습니다.'); return; }
    setExporting(true);
    setStatusMsg('합치는 중... 시간이 걸릴 수 있습니다.');
    setExportReady(false);
    try {
      await apiJson(`/highlight/jobs/${job.id}/export/timeline`, {
        method: 'POST',
        body: JSON.stringify({
          timeline: items.map((it) => ({ type: it.type, name: it.name, duration: it.duration ?? 3.0 })),
          transition_sec: transitionSec,
          audio_volume: audioVolume,
          bgm_name: bgmName,
          bgm_volume: bgmVolume,
        }),
      });
      setExportReady(true);
      setStatusMsg('완료!');
    } catch (err) { setStatusMsg(`오류: ${err}`); }
    finally { setExporting(false); }
  };

  const sliderStyle = { width: 76, accentColor: 'var(--accent)' } as React.CSSProperties;
  const ctrlLabel = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' } as React.CSSProperties;
  const itemCardStyle = (type: string) => ({
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
    background: type === 'clip' ? 'rgba(255,116,0,0.08)' : 'rgba(72,187,120,0.08)',
    border: `1px solid ${type === 'clip' ? 'rgba(255,116,0,0.25)' : 'rgba(72,187,120,0.25)'}`,
    borderRadius: 8, cursor: 'grab', userSelect: 'none' as const,
  });

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>

      {/* Left: clip & image picker */}
      <div style={{ flex: '0 0 200px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 14, border: '1px solid var(--border-ghost)' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 10 }}>클립 목록</div>
          {clips.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>클립 없음</div>}
          {clips.map((c) => (
            <div key={c} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {c.replace(/\.mp4$/, '').slice(-20)}
              </span>
              <button onClick={() => addClip(c)} title="타임라인에 추가"
                style={{ background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, padding: '2px 8px', cursor: 'pointer', flexShrink: 0 }}>
                +
              </button>
            </div>
          ))}
        </div>

        <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 14, border: '1px solid var(--border-ghost)' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 10 }}>이미지 카드</div>
          <input ref={imgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
          <button onClick={() => imgInputRef.current?.click()}
            style={{ width: '100%', fontSize: 11, padding: '5px 0', background: 'var(--button-dark)', border: '1px solid var(--border-ghost)', borderRadius: 6, cursor: 'pointer', color: 'var(--text)', marginBottom: 8 }}>
            + 이미지 업로드
          </button>
          {imageCards.map((c) => (
            <div key={c} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{c}</span>
              <button onClick={() => addImage(c)} title="타임라인에 추가"
                style={{ background: 'rgba(72,187,120,0.7)', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, padding: '2px 8px', cursor: 'pointer', flexShrink: 0 }}>
                +
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Right: timeline + export controls */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* export controls */}
        <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: '14px 20px', border: '1px solid var(--border-ghost)', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          <label style={ctrlLabel}>
            전환
            <input type="range" min={0} max={1.5} step={0.1} value={transitionSec} onChange={(e) => setTransitionSec(parseFloat(e.target.value))} style={sliderStyle} />
            <span style={{ minWidth: 30 }}>{transitionSec.toFixed(1)}s</span>
          </label>
          <label style={ctrlLabel}>
            중계음
            <input type="range" min={0} max={2} step={0.05} value={audioVolume} onChange={(e) => setAudioVolume(parseFloat(e.target.value))} style={sliderStyle} />
            <span style={{ minWidth: 30 }}>{audioVolume.toFixed(2)}</span>
          </label>
          <label style={ctrlLabel}>
            BGM
            <select value={bgmName} onChange={(e) => setBgmName(e.target.value)}
              style={{ background: 'var(--button-dark)', color: 'var(--text)', border: '1px solid var(--border-ghost)', borderRadius: 6, padding: '3px 8px', fontSize: 12 }}>
              <option value="">없음</option>
              {bgmList.map((t) => <option key={t} value={t}>{t.replace(/\.[^.]+$/, '')}</option>)}
            </select>
          </label>
          {bgmName && (
            <label style={ctrlLabel}>
              BGM 볼륨
              <input type="range" min={0} max={1} step={0.05} value={bgmVolume} onChange={(e) => setBgmVolume(parseFloat(e.target.value))} style={sliderStyle} />
              <span style={{ minWidth: 30 }}>{bgmVolume.toFixed(2)}</span>
            </label>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            {statusMsg && <span style={{ fontSize: 11, color: exportReady ? 'var(--success)' : 'var(--muted)' }}>{statusMsg}</span>}
            <button onClick={handleExport} disabled={exporting || !items.length}
              style={{ fontSize: 12, padding: '8px 20px', fontWeight: 700, background: exporting || !items.length ? 'var(--button-dark)' : 'var(--accent)', color: exporting || !items.length ? 'var(--muted)' : '#fff', border: 'none', borderRadius: 'var(--radius-control)', cursor: exporting || !items.length ? 'not-allowed' : 'pointer' }}>
              {exporting ? '합치는 중...' : '합치기'}
            </button>
            {exportReady && (
              <a href={`${API_BASE}/highlight/jobs/${job.id}/export/download`} download
                style={{ display: 'inline-flex', alignItems: 'center', fontSize: 12, padding: '8px 20px', fontWeight: 700, background: 'var(--success)', color: '#000', borderRadius: 'var(--radius-control)', textDecoration: 'none' }}>
                ↓ 다운로드
              </a>
            )}
          </div>
        </div>

        {/* timeline items */}
        <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 16, border: '1px solid var(--border-ghost)', minHeight: 120 }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 12 }}>
            TIMELINE — {items.length}개 항목 · 드래그로 순서 변경
          </div>
          {!items.length && (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--muted)', fontSize: 13 }}>
              왼쪽에서 클립이나 이미지를 추가하세요
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((item, idx) => (
              <div key={`${item.name}-${idx}`} draggable
                onDragStart={() => handleDragStart(idx)} onDragEnter={() => handleDragEnter(idx)}
                onDragEnd={handleDragEnd} onDragOver={(e) => e.preventDefault()}
                style={itemCardStyle(item.type)}>
                <span style={{ fontSize: 11, fontWeight: 700, minWidth: 44, color: item.type === 'clip' ? 'var(--accent)' : 'var(--success)' }}>
                  {item.type === 'clip' ? '▶ 클립' : '🖼 이미지'}
                </span>
                <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.name}
                </span>
                {item.type === 'image' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
                    표시
                    <input type="number" min={0.5} max={60} step={0.5} value={item.duration ?? 3.0}
                      onChange={(e) => updateDuration(idx, parseFloat(e.target.value) || 3.0)}
                      style={{ width: 50, fontSize: 11, padding: '2px 4px' }} />초
                  </label>
                )}
                <button onClick={() => removeItem(idx)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16, padding: '0 4px', flexShrink: 0 }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function HighlightPage() {
  const [jobs, setJobs] = useState<HighlightJob[]>([]);
  const [activeJob, setActiveJob] = useState<HighlightJob | null>(null);
  const [activeTab, setActiveTab] = useState<'clips' | 'timeline'>('clips');
  const [mode, setMode] = useState<'ai' | 'log_ai'>('ai');
  const [displayName, setDisplayName] = useState('');
  const [highlightCount, setHighlightCount] = useState(40);
  const [secondHalfMin, setSecondHalfMin] = useState('');
  const [secondHalfSecPart, setSecondHalfSecPart] = useState('');
  const [logDataJson, setLogDataJson] = useState('');
  const [selectedClips, setSelectedClips] = useState<Record<string, boolean>>({});
  const [clipOrder, setClipOrder] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportReady, setExportReady] = useState(false);
  const [status, setStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logFileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  // export controls (clips tab)
  const [transitionSec, setTransitionSec] = useState(0.5);
  const [audioVolume, setAudioVolume] = useState(1.0);
  const [bgmList, setBgmList] = useState<string[]>([]);
  const [bgmName, setBgmName] = useState('');
  const [bgmVolume, setBgmVolume] = useState(0.3);

  // trim modal
  const [trimTarget, setTrimTarget] = useState<string | null>(null);
  const [clipVersion, setClipVersion] = useState<Record<string, number>>({});

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
    apiJson<{ tracks: string[] }>('/highlight/bgm')
      .then((d) => setBgmList(d.tracks || []))
      .catch(() => {});
  }, [loadJobs]);

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

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setStatus('영상 파일을 선택해주세요.');
      return;
    }

    setUploading(true);
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
    form.append('display_name', displayName.trim());

    try {
      const res = await fetch(`${API_BASE}/highlight/jobs`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { job_id: string };
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
        body: JSON.stringify({
          selected: ordered,
          order: ordered,
          transition_sec: transitionSec,
          audio_volume: audioVolume,
          bgm_name: bgmName,
          bgm_volume: bgmVolume,
        }),
      });
      setExportReady(true);
      setStatus('합치기 완료 — 다운로드 버튼을 눌러주세요.');
    } catch (err) {
      setStatus(`내보내기 오류: ${err}`);
    } finally {
      setExporting(false);
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
  const clips = activeJob?.status === 'done' ? (clipOrder.length ? clipOrder : meta.clips || []) : [];
  const selectedCount = Object.values(selectedClips).filter(Boolean).length;

  const sliderStyle = { width: 80, accentColor: 'var(--accent)' } as React.CSSProperties;
  const ctrlLabel = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' } as React.CSSProperties;

  return (
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
              <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>이름 (선택)</div>
              <input
                type="text" value={displayName} placeholder="예: 2026 K3 1라운드"
                onChange={(e) => setDisplayName(e.target.value)}
                style={{ width: '100%', fontSize: 12 }}
              />
            </div>

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
                  {(() => { const n = job.display_name || job.original_filename; return n.length > 22 ? n.slice(0, 20) + '…' : n; })()}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {job.mode === 'log_ai' ? 'Log+AI' : 'AI'} · {new Date(job.created_at).toLocaleDateString()}
                </div>
              </div>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 999,
                background: job.status === 'done' ? 'var(--success-soft)' : job.status === 'error' ? 'var(--danger-soft)' : 'var(--accent-soft)',
                color: job.status === 'done' ? 'var(--success)' : job.status === 'error' ? 'var(--danger)' : 'var(--accent)',
              }}>
                {job.status.toUpperCase()}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right panel: analysis result ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* progress / status bar */}
        {activeJob && (activeJob.status === 'queued' || activeJob.status === 'processing') && (
          <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 24, border: '1px solid var(--border-ghost)' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12 }}>PROCESSING</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 12, height: 12, borderRadius: '50%',
                background: 'var(--accent)', animation: 'pulse 1.2s ease-in-out infinite',
              }} />
              <span style={{ fontSize: 13, color: 'var(--text)' }}>
                {activeJob.status === 'queued' ? '분석 대기 중...' : 'YOLO 탐지 + 스코어 계산 중 (수분~수십분 소요)'}
              </span>
            </div>
          </div>
        )}

        {activeJob?.status === 'error' && (
          <div style={{ background: 'var(--danger-soft)', borderRadius: 'var(--radius-card)', padding: 24, border: '1px solid var(--border-danger)' }}>
            <div style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 8 }}>ERROR</div>
            <div style={{ fontSize: 13 }}>{activeJob.error_message}</div>
          </div>
        )}

        {/* tab bar */}
        {activeJob?.status === 'done' && clips.length > 0 && (
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-ghost)', paddingBottom: 0 }}>
            {(['clips', 'timeline'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                style={{
                  padding: '8px 18px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: 'none', border: 'none', borderBottom: activeTab === t ? '2px solid var(--accent)' : '2px solid transparent',
                  color: activeTab === t ? 'var(--accent)' : 'var(--muted)',
                  borderRadius: 0, transition: 'color 0.15s',
                }}
              >
                {t === 'clips' ? '클립 목록' : '타임라인 편집기'}
              </button>
            ))}
          </div>
        )}

        {/* clips grid */}
        {activeJob?.status === 'done' && clips.length > 0 && activeTab === 'clips' && (
          <>
            {/* export bar */}
            <div style={{
              background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: '16px 24px',
              border: '1px solid var(--border-ghost)', display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
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

              {/* export controls */}
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center', borderTop: '1px solid var(--border-ghost)', paddingTop: 12 }}>
                <label style={ctrlLabel}>
                  전환
                  <input type="range" min={0} max={1.5} step={0.1} value={transitionSec}
                    onChange={(e) => setTransitionSec(parseFloat(e.target.value))}
                    style={sliderStyle} />
                  <span style={{ minWidth: 32 }}>{transitionSec.toFixed(1)}s</span>
                </label>
                <label style={ctrlLabel}>
                  중계음
                  <input type="range" min={0} max={2} step={0.05} value={audioVolume}
                    onChange={(e) => setAudioVolume(parseFloat(e.target.value))}
                    style={sliderStyle} />
                  <span style={{ minWidth: 32 }}>{audioVolume.toFixed(2)}</span>
                </label>
                <label style={ctrlLabel}>
                  BGM
                  <select
                    value={bgmName}
                    onChange={(e) => setBgmName(e.target.value)}
                    style={{ background: 'var(--button-dark)', color: 'var(--text)', border: '1px solid var(--border-ghost)', borderRadius: 6, padding: '3px 8px', fontSize: 12 }}
                  >
                    <option value="">없음</option>
                    {bgmList.map((t) => (
                      <option key={t} value={t}>{t.replace(/\.[^.]+$/, '')}</option>
                    ))}
                  </select>
                </label>
                {bgmName && (
                  <label style={ctrlLabel}>
                    BGM 볼륨
                    <input type="range" min={0} max={1} step={0.05} value={bgmVolume}
                      onChange={(e) => setBgmVolume(parseFloat(e.target.value))}
                      style={sliderStyle} />
                    <span style={{ minWidth: 32 }}>{bgmVolume.toFixed(2)}</span>
                  </label>
                )}
              </div>
            </div>

            {/* order hint */}
            <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 4 }}>
              드래그로 순서 변경 · 체크박스로 포함/제외 · ✂ 버튼으로 클립 편집
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
                const isTrimmed = !!meta.trimmed?.[clip];
                const ver = clipVersion[clip] || 0;

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
                      src={`${API_BASE}/highlight/jobs/${activeJob.id}/clips/${clip}${ver ? `?v=${ver}` : ''}`}
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
                          {isTrimmed && (
                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 999, background: 'var(--success-soft)', color: 'var(--success)' }}>✂ 편집됨</span>
                          )}
                          <span style={{ fontSize: 11, color: scoreColor(score), fontWeight: 600 }}>
                            {score > 0 ? score.toFixed(3) : '—'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <button
                            onClick={() => setTrimTarget(clip)}
                            title="클립 편집 (트림)"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 14, padding: '2px 4px' }}
                          >
                            ✂
                          </button>
                          <input
                            type="checkbox"
                            checked={!!selectedClips[clip]}
                            onChange={(e) => setSelectedClips((prev) => ({ ...prev, [clip]: e.target.checked }))}
                            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
                          />
                        </div>
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

        {/* timeline editor tab */}
        {activeJob?.status === 'done' && activeTab === 'timeline' && (
          <TimelineEditor job={activeJob} bgmList={bgmList} />
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

      {/* Trim Modal */}
      {trimTarget && activeJob && (
        <TrimModal
          jobId={activeJob.id}
          clipName={trimTarget}
          onClose={() => setTrimTarget(null)}
          onDone={() => {
            setTrimTarget(null);
            setClipVersion((prev) => ({ ...prev, [trimTarget]: (prev[trimTarget] || 0) + 1 }));
            // refresh job metadata to show trimmed flag
            apiJson<HighlightJob>(`/highlight/jobs/${activeJob.id}`)
              .then((j) => setActiveJob(j))
              .catch(() => {});
          }}
        />
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
