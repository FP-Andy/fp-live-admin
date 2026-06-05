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
  progress?: number | null;
  stage?: string | null;
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
type TimelineItem = { type: 'clip' | 'image'; name: string; duration?: number; job_id?: string };

type OverlayDef = {
  kind: 'scoreboard' | 'scorer';
  enabled: boolean;
  image_path?: string;
  image_job_id?: string | null;
  width_pct?: number;
  height_pct?: number;
  home?: string; home_score?: number; away?: string; away_score?: number;
  number?: string; name?: string;
  bg_color?: string;
  x_pct: number; y_pct: number;
  start_sec: number; duration_sec: number;
};

type BgmTrack = {
  name: string; start_sec: number; duration_sec: number;
  volume: number; fade_in_sec: number; fade_out_sec: number;
};

type EditorProjectInfo = { id: string; name: string; updated_at?: number; item_count?: number; overlay_count?: number };

const numInput: React.CSSProperties = { width: 56, fontSize: 11, padding: '2px 4px' };
const txtInput: React.CSSProperties = { width: 90, fontSize: 11, padding: '2px 6px' };
const miniBtn: React.CSSProperties = { fontSize: 11, padding: '4px 10px', background: 'var(--button-dark)', border: '1px solid var(--border-ghost)', borderRadius: 6, cursor: 'pointer', color: 'var(--text)' };
const fieldLabel: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)' };

function OverlayRow({ ov, onChange, onRemove }: {
  ov: OverlayDef; onChange: (patch: Partial<OverlayDef>) => void; onRemove: () => void;
}) {
  const isImage = !!ov.image_path;
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 10px',
      background: ov.enabled ? 'rgba(255,116,0,0.06)' : 'rgba(255,255,255,0.03)',
      border: '1px solid var(--border-ghost)', borderRadius: 8,
    }}>
      <input type="checkbox" checked={ov.enabled} onChange={(e) => onChange({ enabled: e.target.checked })}
        title="활성화" style={{ accentColor: 'var(--accent)' }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', minWidth: 52 }}>
        {ov.kind === 'scoreboard' ? '점수판' : '득점자'}{isImage ? '🖼' : ''}
      </span>

      {!isImage && ov.kind === 'scoreboard' && (
        <>
          <label style={fieldLabel}>홈 <input value={ov.home ?? ''} onChange={(e) => onChange({ home: e.target.value })} style={txtInput} /></label>
          <input type="number" value={ov.home_score ?? 0} min={0} onChange={(e) => onChange({ home_score: parseInt(e.target.value) || 0 })} style={numInput} />
          <span style={{ color: 'var(--muted)' }}>-</span>
          <input type="number" value={ov.away_score ?? 0} min={0} onChange={(e) => onChange({ away_score: parseInt(e.target.value) || 0 })} style={numInput} />
          <label style={fieldLabel}>원정 <input value={ov.away ?? ''} onChange={(e) => onChange({ away: e.target.value })} style={txtInput} /></label>
        </>
      )}
      {!isImage && ov.kind === 'scorer' && (
        <>
          <label style={fieldLabel}>번호 <input value={ov.number ?? ''} onChange={(e) => onChange({ number: e.target.value })} style={{ ...txtInput, width: 48 }} /></label>
          <label style={fieldLabel}>선수 <input value={ov.name ?? ''} onChange={(e) => onChange({ name: e.target.value })} style={txtInput} /></label>
        </>
      )}
      {!isImage && (
        <label style={fieldLabel}>색 <input type="color" value={ov.bg_color || '#FF7400'} onChange={(e) => onChange({ bg_color: e.target.value })} style={{ width: 32, height: 24, padding: 0, cursor: 'pointer' }} /></label>
      )}
      {isImage && (
        <label style={fieldLabel}>폭% <input type="number" value={ov.width_pct ?? 30} min={5} max={100} onChange={(e) => onChange({ width_pct: parseFloat(e.target.value) || 30 })} style={numInput} /></label>
      )}

      <label style={fieldLabel}>X% <input type="number" value={Math.round(ov.x_pct)} min={0} max={100} onChange={(e) => onChange({ x_pct: parseFloat(e.target.value) || 0 })} style={numInput} /></label>
      <label style={fieldLabel}>Y% <input type="number" value={Math.round(ov.y_pct)} min={0} max={100} onChange={(e) => onChange({ y_pct: parseFloat(e.target.value) || 0 })} style={numInput} /></label>
      <label style={fieldLabel}>시작 <input type="number" value={ov.start_sec} min={0} step={0.5} onChange={(e) => onChange({ start_sec: parseFloat(e.target.value) || 0 })} style={numInput} />s</label>
      <label style={fieldLabel}>길이 <input type="number" value={ov.duration_sec} min={0.5} step={0.5} onChange={(e) => onChange({ duration_sec: parseFloat(e.target.value) || 1 })} style={numInput} />s</label>
      <button onClick={onRemove} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 15 }}>✕</button>
    </div>
  );
}

function BgmTrackRow({ track, bgmList, onChange, onRemove }: {
  track: BgmTrack; bgmList: string[]; onChange: (patch: Partial<BgmTrack>) => void; onRemove: () => void;
}) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 10px',
      background: 'rgba(72,187,120,0.06)', border: '1px solid var(--border-ghost)', borderRadius: 8,
    }}>
      <select value={track.name} onChange={(e) => onChange({ name: e.target.value })}
        style={{ background: 'var(--button-dark)', color: 'var(--text)', border: '1px solid var(--border-ghost)', borderRadius: 6, padding: '3px 6px', fontSize: 11, maxWidth: 140 }}>
        {bgmList.map((t) => <option key={t} value={t}>{t.replace(/\.[^.]+$/, '')}</option>)}
      </select>
      <label style={fieldLabel}>시작 <input type="number" value={track.start_sec} min={0} step={0.5} onChange={(e) => onChange({ start_sec: parseFloat(e.target.value) || 0 })} style={numInput} />s</label>
      <label style={fieldLabel}>길이 <input type="number" value={track.duration_sec} min={0.5} step={0.5} onChange={(e) => onChange({ duration_sec: parseFloat(e.target.value) || 1 })} style={numInput} />s</label>
      <label style={fieldLabel}>볼륨 <input type="number" value={track.volume} min={0} max={2} step={0.05} onChange={(e) => onChange({ volume: parseFloat(e.target.value) || 0 })} style={numInput} /></label>
      <label style={fieldLabel}>페이드 <input type="number" value={track.fade_in_sec} min={0} step={0.5} onChange={(e) => onChange({ fade_in_sec: parseFloat(e.target.value) || 0 })} style={{ ...numInput, width: 44 }} />/<input type="number" value={track.fade_out_sec} min={0} step={0.5} onChange={(e) => onChange({ fade_out_sec: parseFloat(e.target.value) || 0 })} style={{ ...numInput, width: 44 }} />s</label>
      <button onClick={onRemove} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 15 }}>✕</button>
    </div>
  );
}

function TimelineEditor({ job, bgmList, onBgmUploaded }: { job: HighlightJob; bgmList: string[]; onBgmUploaded: () => void }) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [imageCards, setImageCards] = useState<string[]>([]);
  const [transitionSec, setTransitionSec] = useState(0.5);
  const [audioVolume, setAudioVolume] = useState(1.0);
  const [bgmName, setBgmName] = useState('');
  const [bgmVolume, setBgmVolume] = useState(0.3);
  const [overlays, setOverlays] = useState<OverlayDef[]>([]);
  const [bgmTracks, setBgmTracks] = useState<BgmTrack[]>([]);
  const [projects, setProjects] = useState<EditorProjectInfo[]>([]);
  const [projName, setProjName] = useState('');
  const [selProjId, setSelProjId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportReady, setExportReady] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const imgInputRef = useRef<HTMLInputElement>(null);
  const extInputRef = useRef<HTMLInputElement>(null);
  const ovImgInputRef = useRef<HTMLInputElement>(null);
  const dragIdx = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);

  const clips = job.job_metadata?.clips || [];

  const loadImageCards = useCallback(async () => {
    try {
      const d = await apiJson<{ cards: string[] }>(`/highlight/jobs/${job.id}/image-cards`);
      setImageCards(d.cards || []);
    } catch { /* ignore */ }
  }, [job.id]);

  const loadProjects = useCallback(async () => {
    try {
      const d = await apiJson<{ projects: EditorProjectInfo[] }>(`/highlight/editor/projects`);
      setProjects(d.projects || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadImageCards();
    loadProjects();
    // restore overlays / bgm tracks saved against this job
    apiJson<{ overlays: OverlayDef[] }>(`/highlight/jobs/${job.id}/overlays`)
      .then((d) => setOverlays(d.overlays || [])).catch(() => {});
    apiJson<{ bgm_tracks: BgmTrack[] }>(`/highlight/jobs/${job.id}/bgm-tracks`)
      .then((d) => setBgmTracks(d.bgm_tracks || [])).catch(() => {});
  }, [job.id, loadImageCards, loadProjects]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      await fetch(`${API_BASE}/highlight/jobs/${job.id}/image-cards`, { method: 'POST', credentials: 'include', body: form });
      await loadImageCards();
    } catch (err) { setStatusMsg(`업로드 실패: ${err}`); }
    e.target.value = '';
  };

  const handleExternalClip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setStatusMsg('외부 영상 업로드 중...');
    try {
      for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`${API_BASE}/highlight/jobs/${job.id}/external-clips`, { method: 'POST', credentials: 'include', body: form });
        if (!res.ok) throw new Error(await res.text());
        const d = await res.json() as { name: string };
        setItems((prev) => [...prev, { type: 'clip', name: d.name }]);
      }
      setStatusMsg('외부 영상 추가됨');
    } catch (err) { setStatusMsg(`업로드 실패: ${err}`); }
    e.target.value = '';
  };

  const handleOverlayImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch(`${API_BASE}/highlight/jobs/${job.id}/overlay-images`, { method: 'POST', credentials: 'include', body: form });
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json() as { name: string };
      setOverlays((prev) => [...prev, {
        kind: 'scoreboard', enabled: true, image_path: d.name, image_job_id: job.id,
        width_pct: 35, height_pct: 0, x_pct: 5, y_pct: 5, start_sec: 0, duration_sec: 5,
      }]);
      setStatusMsg('이미지 오버레이 추가됨');
    } catch (err) { setStatusMsg(`업로드 실패: ${err}`); }
    e.target.value = '';
  };

  const addClip = (name: string) => setItems((prev) => [...prev, { type: 'clip', name }]);
  const addImage = (name: string) => setItems((prev) => [...prev, { type: 'image', name, duration: 3.0 }]);
  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));
  const updateDuration = (idx: number, val: number) =>
    setItems((prev) => prev.map((it, i) => i === idx ? { ...it, duration: val } : it));

  const addOverlay = (kind: 'scoreboard' | 'scorer') => {
    const base = { enabled: true, bg_color: '#FF7400', start_sec: 0, duration_sec: 5 };
    setOverlays((prev) => [...prev, kind === 'scoreboard'
      ? { kind, ...base, home: '홈팀', home_score: 0, away: '원정', away_score: 0, x_pct: 35, y_pct: 5 }
      : { kind, ...base, number: '10', name: '선수명', x_pct: 5, y_pct: 80 }]);
  };
  const patchOverlay = (idx: number, patch: Partial<OverlayDef>) =>
    setOverlays((prev) => prev.map((o, i) => i === idx ? { ...o, ...patch } : o));
  const removeOverlay = (idx: number) => setOverlays((prev) => prev.filter((_, i) => i !== idx));

  const addBgmTrack = () => {
    if (!bgmList.length) { setStatusMsg('BGM 파일이 없습니다. 먼저 업로드하세요.'); return; }
    setBgmTracks((prev) => [...prev, { name: bgmList[0], start_sec: 0, duration_sec: 10, volume: 0.3, fade_in_sec: 1, fade_out_sec: 1 }]);
  };
  const patchBgmTrack = (idx: number, patch: Partial<BgmTrack>) =>
    setBgmTracks((prev) => prev.map((t, i) => i === idx ? { ...t, ...patch } : t));
  const removeBgmTrack = (idx: number) => setBgmTracks((prev) => prev.filter((_, i) => i !== idx));

  const handleBgmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      await fetch(`${API_BASE}/highlight/bgm/upload`, { method: 'POST', credentials: 'include', body: form });
      onBgmUploaded();
      setStatusMsg('BGM 업로드됨');
    } catch (err) { setStatusMsg(`업로드 실패: ${err}`); }
    e.target.value = '';
  };

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

  const persistEditorState = useCallback(async () => {
    // keep overlays / bgm tracks saved against the job (mirrors source autosave)
    try {
      await apiJson(`/highlight/jobs/${job.id}/overlays`, { method: 'POST', body: JSON.stringify({ overlays }) });
      await apiJson(`/highlight/jobs/${job.id}/bgm-tracks`, { method: 'POST', body: JSON.stringify({ bgm_tracks: bgmTracks }) });
    } catch { /* non-fatal */ }
  }, [job.id, overlays, bgmTracks]);

  const handleSaveProject = async () => {
    const name = projName.trim();
    if (!name) { setStatusMsg('프로젝트 이름을 입력하세요.'); return; }
    try {
      await apiJson(`/highlight/editor/projects`, {
        method: 'POST',
        body: JSON.stringify({
          name, job_id: job.id, timeline: items, overlays, bgm_tracks: bgmTracks,
          transition_sec: transitionSec, audio_volume: audioVolume,
        }),
      });
      setStatusMsg(`저장됨: ${name}`);
      loadProjects();
    } catch (err) { setStatusMsg(`저장 실패: ${err}`); }
  };

  const handleLoadProject = async () => {
    if (!selProjId) return;
    try {
      const p = await apiJson<{
        timeline?: TimelineItem[]; overlays?: OverlayDef[]; bgm_tracks?: BgmTrack[];
        transition_sec?: number; audio_volume?: number; name?: string;
      }>(`/highlight/editor/projects/${selProjId}`);
      setItems(p.timeline || []);
      setOverlays(p.overlays || []);
      setBgmTracks(p.bgm_tracks || []);
      setTransitionSec(p.transition_sec ?? 0.5);
      setAudioVolume(p.audio_volume ?? 1.0);
      setProjName(p.name || '');
      setStatusMsg(`불러옴: ${p.name || ''}`);
    } catch (err) { setStatusMsg(`불러오기 실패: ${err}`); }
  };

  const handleDeleteProject = async () => {
    if (!selProjId) return;
    if (!confirm('이 프로젝트를 삭제할까요?')) return;
    try {
      await apiJson(`/highlight/editor/projects/${selProjId}`, { method: 'DELETE' });
      setSelProjId('');
      loadProjects();
      setStatusMsg('프로젝트 삭제됨');
    } catch (err) { setStatusMsg(`삭제 실패: ${err}`); }
  };

  const handleExport = async () => {
    if (!items.length) { setStatusMsg('타임라인이 비어 있습니다.'); return; }
    setExporting(true);
    setStatusMsg('합치는 중... 시간이 걸릴 수 있습니다.');
    setExportReady(false);
    try {
      await persistEditorState();
      await apiJson(`/highlight/jobs/${job.id}/export/timeline`, {
        method: 'POST',
        body: JSON.stringify({
          timeline: items.map((it) => ({ type: it.type, name: it.name, duration: it.duration ?? 3.0, job_id: it.job_id })),
          transition_sec: transitionSec,
          audio_volume: audioVolume,
          bgm_name: bgmName,
          bgm_volume: bgmVolume,
          bgm_tracks: bgmTracks,
          overlays,
        }),
      });
      setExportReady(true);
      setStatusMsg('완료!');
    } catch (err) { setStatusMsg(`오류: ${err}`); }
    finally { setExporting(false); }
  };

  const sliderStyle = { width: 76, accentColor: 'var(--accent)' } as React.CSSProperties;
  const ctrlLabel = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' } as React.CSSProperties;
  const sectionCard: React.CSSProperties = { background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 14, border: '1px solid var(--border-ghost)' };
  const sectionTitle: React.CSSProperties = { fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 10 };
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
        <div style={sectionCard}>
          <div style={sectionTitle}>클립 목록</div>
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
          <input ref={extInputRef} type="file" accept="video/*,.mp4,.mov,.avi,.mkv,.webm,.m4v" multiple style={{ display: 'none' }} onChange={handleExternalClip} />
          <button onClick={() => extInputRef.current?.click()} title="외부 영상 파일을 타임라인에 추가"
            style={{ ...miniBtn, width: '100%', marginTop: 8 }}>+ 외부 영상 추가</button>
        </div>

        <div style={sectionCard}>
          <div style={sectionTitle}>이미지 카드</div>
          <input ref={imgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
          <button onClick={() => imgInputRef.current?.click()} style={{ ...miniBtn, width: '100%', marginBottom: 8 }}>
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
        <div style={{ ...sectionCard, padding: '14px 20px', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
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

        {/* project save / load */}
        <div style={{ ...sectionCard, padding: '12px 20px', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <span style={{ ...sectionTitle, marginBottom: 0 }}>프로젝트</span>
          <input value={projName} onChange={(e) => setProjName(e.target.value)} placeholder="프로젝트 이름"
            style={{ fontSize: 12, padding: '4px 8px', width: 170 }} />
          <button onClick={handleSaveProject} style={miniBtn} title="현재 타임라인·오버레이·BGM·설정 저장">💾 저장</button>
          <select value={selProjId} onChange={(e) => setSelProjId(e.target.value)}
            style={{ background: 'var(--button-dark)', color: 'var(--text)', border: '1px solid var(--border-ghost)', borderRadius: 6, padding: '4px 8px', fontSize: 12, minWidth: 200 }}>
            <option value="">— 저장된 프로젝트 —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.item_count ?? 0}컷)</option>)}
          </select>
          <button onClick={handleLoadProject} disabled={!selProjId} style={miniBtn}>📂 불러오기</button>
          <button onClick={handleDeleteProject} disabled={!selProjId}
            style={{ ...miniBtn, background: 'rgba(198,40,40,0.15)', borderColor: 'rgba(198,40,40,0.4)', color: '#ff6e6e' }}>삭제</button>
        </div>

        {/* timeline items */}
        <div style={{ ...sectionCard, padding: 16, minHeight: 120 }}>
          <div style={{ ...sectionTitle, marginBottom: 12 }}>
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

        {/* overlays */}
        <div style={{ ...sectionCard, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ ...sectionTitle, marginBottom: 0 }}>오버레이 ({overlays.length})</span>
            <button onClick={() => addOverlay('scoreboard')} style={miniBtn}>+ 점수판</button>
            <button onClick={() => addOverlay('scorer')} style={miniBtn}>+ 득점자</button>
            <input ref={ovImgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleOverlayImage} />
            <button onClick={() => ovImgInputRef.current?.click()} style={miniBtn}>+ 이미지 오버레이</button>
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>start/길이는 합쳐진 영상 기준 초</span>
          </div>
          {!overlays.length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>오버레이 없음</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {overlays.map((ov, idx) => (
              <OverlayRow key={idx} ov={ov} onChange={(patch) => patchOverlay(idx, patch)} onRemove={() => removeOverlay(idx)} />
            ))}
          </div>
        </div>

        {/* bgm tracks */}
        <div style={{ ...sectionCard, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ ...sectionTitle, marginBottom: 0 }}>BGM 트랙 ({bgmTracks.length})</span>
            <button onClick={addBgmTrack} style={miniBtn}>+ 트랙 추가</button>
            <label style={{ ...miniBtn, display: 'inline-flex', alignItems: 'center' }}>
              ⤴ BGM 업로드
              <input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" style={{ display: 'none' }} onChange={handleBgmUpload} />
            </label>
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>트랙이 있으면 위의 단일 BGM 대신 트랙들이 사용됩니다</span>
          </div>
          {!bgmTracks.length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>트랙 없음</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {bgmTracks.map((t, idx) => (
              <BgmTrackRow key={idx} track={t} bgmList={bgmList} onChange={(patch) => patchBgmTrack(idx, patch)} onRemove={() => removeBgmTrack(idx)} />
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
  const [uploadKind, setUploadKind] = useState<'single' | 'split'>('single');
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
  const firstHalfRef = useRef<HTMLInputElement>(null);
  const secondHalfRef = useRef<HTMLInputElement>(null);
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

  const loadBgm = useCallback(() => {
    apiJson<{ tracks: string[] }>('/highlight/bgm')
      .then((d) => setBgmList(d.tracks || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadJobs();
    loadBgm();
  }, [loadJobs, loadBgm]);

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

    const isSplit = uploadKind === 'split';
    const single = fileInputRef.current?.files?.[0];
    const first = firstHalfRef.current?.files?.[0];
    const second = secondHalfRef.current?.files?.[0];

    if (isSplit) {
      if (!first || !second) { setStatus('전반/후반 영상을 모두 선택해주세요.'); return; }
    } else if (!single) {
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
    form.append('mode', mode);
    form.append('highlight_count', String(highlightCount));
    form.append('log_data_json', logDataJson || '[]');
    form.append('display_name', displayName.trim());

    let endpoint = '/highlight/jobs';
    if (isSplit) {
      // second_half_start_sec is computed server-side from the first-half duration
      form.append('first_half', first as File);
      form.append('second_half', second as File);
      endpoint = '/highlight/jobs/split';
    } else {
      form.append('video', single as File);
      form.append('second_half_start_sec', String((parseInt(secondHalfMin) || 0) * 60 + (parseInt(secondHalfSecPart) || 0)));
    }

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
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

            {/* single vs first/second-half split */}
            <div style={{ display: 'flex', gap: 6 }}>
              {(['single', 'split'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setUploadKind(k)}
                  style={{
                    flex: 1, padding: '5px 0', fontSize: 10, fontWeight: 600,
                    background: uploadKind === k ? 'var(--accent-soft)' : 'var(--button-dark)',
                    color: uploadKind === k ? 'var(--accent)' : 'var(--muted)',
                    border: `1px solid ${uploadKind === k ? 'var(--border-emphasis)' : 'transparent'}`,
                    borderRadius: 'var(--radius-control)', cursor: 'pointer',
                  }}
                >
                  {k === 'single' ? '전체 영상' : '전반 / 후반 분리'}
                </button>
              ))}
            </div>

            {uploadKind === 'single' ? (
              <div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>영상 파일</div>
                <input ref={fileInputRef} type="file" accept="video/*,.mts,.m2ts,.ts,.mov,.mkv,.avi,.m4v" style={{ width: '100%', fontSize: 11 }} />
              </div>
            ) : (
              <>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>전반 영상</div>
                  <input ref={firstHalfRef} type="file" accept="video/*,.mts,.m2ts,.ts,.mov,.mkv,.avi,.m4v" style={{ width: '100%', fontSize: 11 }} />
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>후반 영상</div>
                  <input ref={secondHalfRef} type="file" accept="video/*,.mts,.m2ts,.ts,.mov,.mkv,.avi,.m4v" style={{ width: '100%', fontSize: 11 }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
                  후반 시작 시각은 전반 영상 길이로 자동 계산됩니다.
                </div>
              </>
            )}

            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>클립 수</div>
              <input
                type="number" min={1} max={100} value={highlightCount}
                onChange={(e) => setHighlightCount(Number(e.target.value))}
                style={{ width: '100%', fontSize: 12 }}
              />
            </div>

            <div style={{ visibility: mode === 'log_ai' ? 'visible' : 'hidden', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {uploadKind === 'single' && (
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
                )}
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
        {activeJob && (activeJob.status === 'queued' || activeJob.status === 'processing') && (() => {
          const pct = typeof activeJob.progress === 'number' ? Math.max(0, Math.min(100, activeJob.progress)) : null;
          const hasPct = activeJob.status === 'processing' && pct !== null;
          return (
            <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 24, border: '1px solid var(--border-ghost)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>PROCESSING</div>
                {hasPct && <div style={{ fontSize: 12, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>{pct}%</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                  background: 'var(--accent)', animation: 'pulse 1.2s ease-in-out infinite',
                }} />
                <span style={{ fontSize: 13, color: 'var(--text)' }}>
                  {activeJob.status === 'queued'
                    ? '분석 대기 중...'
                    : (activeJob.stage
                        ? `${activeJob.stage} 중...`
                        : 'YOLO 탐지 + 스코어 계산 중 (수분~수십분 소요)')}
                </span>
              </div>
              {hasPct && (
                <div style={{ marginTop: 14, height: 6, borderRadius: 3, background: 'var(--border-ghost)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.4s ease' }} />
                </div>
              )}
            </div>
          );
        })()}

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
          <TimelineEditor job={activeJob} bgmList={bgmList} onBgmUploaded={loadBgm} />
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
