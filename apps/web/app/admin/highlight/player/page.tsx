'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, apiJson } from '../../../../lib/api';

type Box = { cls: string; tid: number; cx: number; cy: number; w: number; h: number };

type PossessionEvent = {
  id: number;
  track_id: number;
  start: number;
  end: number;
  start_frame: number;
  end_frame: number;
  mid_frame: number;
  mid_cx: number;
  mid_cy: number;
  n_touch: number;
};

// 클릭 = '이 터치 = 내 선수' 보증. event(공 보유 이벤트) 또는 mark(공 미탐지 시 수동).
type Pick =
  | { key: string; kind: 'event'; evId: number; track_id: number; start: number; end: number; n_touch: number }
  | { key: string; kind: 'mark'; t: number; start: number; end: number };

type Segment = {
  start: number;
  end: number;
  involve_start: number;
  involve_end: number;
  clip?: string;
};

type PlayerJobMeta = {
  mode?: string;
  fps?: number;
  n_player_tracks?: number;
  events?: PossessionEvent[];
  clips?: string[];
  message?: string;
  video_w?: number;
  video_h?: number;
  proxy_file?: string | null;
  proxy_status?: string;
};

type PlayerJob = {
  id: string;
  status: string;
  mode: string;
  original_filename: string;
  display_name?: string | null;
  error_message?: string | null;
  job_metadata: PlayerJobMeta;
  progress?: number | null;
  stage?: string | null;
  created_at: string;
  updated_at: string;
};

type DetResp = {
  fps: number;
  stride: number;
  video_w: number;
  video_h: number;
  frames: Record<string, Box[]>;
};
type DetData = {
  fps: number;
  stride: number;
  vw: number;
  vh: number;
  byFrame: Map<number, Box[]>;
  framesSorted: number[];
  trackFrames: Map<number, number[]>;
};
type PreviewResp = { job_id: string; clip_count: number; total_seconds?: number; segments: Segment[] };
type ExtractResp = { job_id: string; clip_count: number; clips: string[]; segments: Segment[] };

const PC_JUMP_K = 2.5; // 연속 샘플 위치변화 > 박스높이×K → '다른 선수로 바뀜' 의심
const SPEEDS = [1, 1.5, 2, 3, 4];
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024 * 1024;

const card: React.CSSProperties = {
  background: 'var(--card, #1b1b1f)',
  border: '1px solid var(--border, #2c2c32)',
  borderRadius: 10,
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

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function PlayerClipPage() {
  const [file, setFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<PlayerJob | null>(null);
  const [status, setStatus] = useState('');

  // 선택/추출 상태
  const [picks, setPicks] = useState<Pick[]>([]);
  const [excludes, setExcludes] = useState<[number, number][]>([]);
  const [exPending, setExPending] = useState<number | null>(null);
  const [padBefore, setPadBefore] = useState(3);
  const [padAfter, setPadAfter] = useState(3);
  const [speed, setSpeed] = useState(1);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [clipSegs, setClipSegs] = useState<Segment[]>([]);
  const [clipSel, setClipSel] = useState<Set<string>>(new Set());
  const [verifyStat, setVerifyStat] = useState('');
  const [proxyInfo, setProxyInfo] = useState('');
  const [proxyBusy, setProxyBusy] = useState(false);
  const [hasProxy, setHasProxy] = useState(false);
  const [videoVer, setVideoVer] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [, forceTick] = useState(0); // 박스 그리기 외 타임라인/시간 표시 갱신용

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timelineRef = useRef<HTMLCanvasElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const proxyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef = useRef<number | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewSeqRef = useRef(0);
  const seekResumeRef = useRef<number>(0);

  // 애니메이션 루프가 읽는 데이터는 ref 로 (리렌더 없이)
  const detRef = useRef<DetData | null>(null);
  const eventsRef = useRef<PossessionEvent[]>([]);
  const picksRef = useRef<Pick[]>([]);
  const excludesRef = useRef<[number, number][]>([]);
  const exPendingRef = useRef<number | null>(null);
  const tlDirtyRef = useRef(true);
  const tlLayerRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => { picksRef.current = picks; tlDirtyRef.current = true; }, [picks]);
  useEffect(() => { excludesRef.current = excludes; }, [excludes]);
  useEffect(() => { exPendingRef.current = exPending; }, [exPending]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // ── 탐지 완료 후 데이터 로드 ──────────────────────────────
  const loadDetection = useCallback(async (jobId: string) => {
    const det = await apiJson<DetResp>(`/highlight/player-jobs/${jobId}/detections`);
    const byFrame = new Map<number, Box[]>();
    for (const [f, boxes] of Object.entries(det.frames)) byFrame.set(Number(f), boxes);
    const framesSorted = [...byFrame.keys()].sort((a, b) => a - b);
    const trackFrames = new Map<number, number[]>();
    for (const f of framesSorted) {
      for (const o of byFrame.get(f)!) {
        if (o.cls !== 'player' || o.tid === -1) continue;
        if (!trackFrames.has(o.tid)) trackFrames.set(o.tid, []);
        trackFrames.get(o.tid)!.push(f);
      }
    }
    detRef.current = {
      fps: det.fps || 30, stride: det.stride || 7,
      vw: det.video_w || 0, vh: det.video_h || 0,
      byFrame, framesSorted, trackFrames,
    };
    try {
      const e = await apiJson<{ events: PossessionEvent[] }>(`/highlight/player-jobs/${jobId}/events`);
      eventsRef.current = e.events || [];
    } catch { eventsRef.current = []; }
    tlDirtyRef.current = true;
    setLoaded(true);
  }, []);

  const startPolling = useCallback((jobId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const j = await apiJson<PlayerJob>(`/highlight/jobs/${jobId}`);
        setJob(j);
        if (j.status === 'done' || j.status === 'error') {
          stopPolling();
          if (j.status === 'done') {
            setHasProxy(!!j.job_metadata?.proxy_file);
            setStatus(j.job_metadata?.message || '탐지 완료 — 공 잡는 순간 선수를 클릭하세요.');
            try { await loadDetection(jobId); }
            catch (err) { setStatus(`탐지 데이터 로드 오류: ${err}`); }
          } else {
            setStatus(`오류: ${j.error_message || '탐지 실패'}`);
          }
        }
      } catch (err) {
        stopPolling();
        setStatus(`폴링 오류: ${err}`);
      }
    }, 3000);
  }, [stopPolling, loadDetection]);

  useEffect(() => () => {
    stopPolling();
    if (proxyPollRef.current) clearInterval(proxyPollRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, [stopPolling]);

  const handleUpload = async () => {
    if (!file) { setStatus('영상 파일을 선택하세요.'); return; }
    if (file.size > MAX_UPLOAD_BYTES) {
      setStatus('3GB 이하 영상만 업로드할 수 있습니다.');
      return;
    }
    setUploading(true);
    setStatus('업로드 중...');
    setJob(null); setLoaded(false); setPicks([]); setExcludes([]); setExPending(null);
    setPreview(null); setClipSegs([]); setClipSel(new Set()); setHasProxy(false);
    detRef.current = null; eventsRef.current = [];
    const form = new FormData();
    form.append('video', file);
    form.append('display_name', displayName);
    try {
      const data = await new Promise<{ job_id: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/highlight/player-jobs`);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) {
            setStatus('업로드 중...');
            return;
          }
          const pct = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
          setStatus(`업로드 중... ${pct}%`);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText || '{}') as { job_id: string });
            } catch {
              reject(new Error('업로드 응답을 읽을 수 없습니다.'));
            }
            return;
          }
          reject(new Error(xhr.responseText || `업로드 실패 (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('업로드 연결 오류'));
        xhr.onabort = () => reject(new Error('업로드가 취소되었습니다.'));
        xhr.send(form);
      });
      setStatus('탐지 시작됨 — 풀경기는 수 분 소요됩니다.');
      const j = await apiJson<PlayerJob>(`/highlight/jobs/${data.job_id}`);
      setJob(j);
      startPolling(data.job_id);
    } catch (err) {
      setStatus(`오류: ${err}`);
    } finally {
      setUploading(false);
    }
  };

  // ── 프레임 매핑 / 이벤트 매칭 ──────────────────────────────
  const currentFrame = useCallback(() => {
    const d = detRef.current, vid = videoRef.current;
    if (!d || !vid) return 0;
    const base = d.framesSorted.length ? d.framesSorted[0] : 0;
    return Math.round((vid.currentTime * d.fps - base) / d.stride) * d.stride + base;
  }, []);

  const activeEvent = useCallback((F: number, C: number | null): PossessionEvent | null => {
    let any: PossessionEvent | null = null;
    for (const e of eventsRef.current) {
      if (e.start_frame <= F && F <= e.end_frame) {
        if (C != null && e.track_id === C) return e;
        if (!any) any = e;
      }
    }
    return any;
  }, []);

  const togglePick = useCallback((pick: Pick) => {
    setPicks((prev) => {
      const i = prev.findIndex((p) => p.key === pick.key);
      if (i >= 0) { const n = [...prev]; n.splice(i, 1); return n; }
      return [...prev, pick];
    });
  }, []);

  // ── 신원 검증 타임라인 (초록 커버리지 / 빨강 위치급변) ──────
  const buildTimelineLayer = useCallback(() => {
    const d = detRef.current, cv = timelineRef.current, vid = videoRef.current;
    if (!d || !cv) return;
    const W = cv.clientWidth || 600, H = 34;
    cv.width = W; cv.height = H;
    const layer = document.createElement('canvas');
    layer.width = W; layer.height = H;
    const ctx = layer.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#161616'; ctx.fillRect(0, 0, W, H);
    tlLayerRef.current = layer;
    const D = (vid && isFinite(vid.duration) && vid.duration > 0)
      ? vid.duration
      : (d.framesSorted.length ? d.framesSorted[d.framesSorted.length - 1] / d.fps : 0);
    if (D <= 0) return;
    // 선택한 선수(이벤트 pick)의 track_id 집합 — 이게 '내 선수' 추적 커버리지의 기준
    const pickedTids = new Set<number>();
    for (const p of picksRef.current) if (p.kind === 'event') pickedTids.add(p.track_id);
    const slabW = Math.max(1, (d.stride / d.fps) / D * W);
    let covered = 0, gaps = 0, jumps = 0, inGap = true;
    let prev: { f: number; cx: number; cy: number; h: number } | null = null;
    if (pickedTids.size) {
      for (const f of d.framesSorted) {
        const b = (d.byFrame.get(f) || []).find((x) => x.cls === 'player' && pickedTids.has(x.tid));
        const sec = f / d.fps, x = sec / D * W;
        if (b) {
          ctx.fillStyle = '#2fae46'; ctx.fillRect(x, 7, slabW, H - 14);
          covered++; inGap = false;
          if (prev && (f - prev.f) <= 2 * d.stride) {
            const dist = Math.hypot(b.cx - prev.cx, b.cy - prev.cy);
            if (dist > PC_JUMP_K * Math.max(b.h, prev.h, 1)) {
              jumps++; ctx.fillStyle = '#ff5a5a'; ctx.fillRect(Math.max(0, x - 1), 0, 3, H);
            }
          }
          prev = { f, cx: b.cx, cy: b.cy, h: b.h };
        } else {
          if (!inGap) { inGap = true; gaps++; }
          prev = null;
        }
      }
      const cov = d.framesSorted.length ? Math.round(covered / d.framesSorted.length * 100) : 0;
      setVerifyStat(`선택 선수 추적 커버리지 ${cov}% · 끊김 ${gaps}곳 · 위치급변 ${jumps}곳`);
    } else {
      setVerifyStat('공 잡는 순간 선수를 클릭하면 그 선수의 추적 커버리지가 표시됩니다.');
    }
  }, []);

  const videoDuration = useCallback(() => {
    const vid = videoRef.current, d = detRef.current;
    if (vid && isFinite(vid.duration) && vid.duration > 0) return vid.duration;
    if (d && d.framesSorted.length) return d.framesSorted[d.framesSorted.length - 1] / d.fps;
    return 0;
  }, []);

  // ── 메인 드로 루프: 영상 프레임 + 박스 + 타임라인 ──────────
  useEffect(() => {
    if (!loaded) return;
    const draw = () => {
      const cv = canvasRef.current, vid = videoRef.current, d = detRef.current;
      if (cv && vid && d) {
        if (cv.width !== cv.clientWidth || cv.height !== cv.clientHeight) {
          cv.width = cv.clientWidth; cv.height = cv.clientHeight;
        }
        const ctx = cv.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, cv.width, cv.height);
          if (vid.readyState >= 2) { try { ctx.drawImage(vid, 0, 0, cv.width, cv.height); } catch { /* noop */ } }
          const vw = d.vw || vid.videoWidth || 1, vh = d.vh || vid.videoHeight || 1;
          const sx = cv.width / vw, sy = cv.height / vh;
          const curF = currentFrame();
          const boxes = d.byFrame.get(curF) || [];
          const actEv = activeEvent(curF, null);
          const holderTid = actEv ? actEv.track_id : null;
          const picked = !!actEv && picksRef.current.some((p) => p.key === 'e' + actEv!.id);
          for (const b of boxes) {
            if (b.cls !== 'player' && b.cls !== 'ball') continue;
            const isBall = b.cls === 'ball';
            const isHolder = !isBall && holderTid !== null && b.tid === holderTid;
            const x = (b.cx - b.w / 2) * sx, y = (b.cy - b.h / 2) * sy, w = b.w * sx, h = b.h * sy;
            ctx.lineWidth = isHolder ? 3 : 1.5;
            ctx.strokeStyle = isBall ? '#ffd166' : (isHolder ? (picked ? '#39d353' : '#ffd166') : 'rgba(150,150,150,0.7)');
            ctx.strokeRect(x, y, w, h);
            if (isHolder) {
              ctx.fillStyle = picked ? '#39d353' : '#ffd166';
              ctx.font = '12px sans-serif';
              ctx.fillText(picked ? '✓ 선택됨' : '공 보유 (클릭)', x, Math.max(10, y - 3));
            }
          }
        }
      }
      // 타임라인
      const tcv = timelineRef.current;
      if (tcv) {
        if (tlDirtyRef.current || tcv.width !== tcv.clientWidth) { buildTimelineLayer(); tlDirtyRef.current = false; }
        const tctx = tcv.getContext('2d');
        const layer = tlLayerRef.current;
        const D = videoDuration();
        if (tctx && layer && D > 0) {
          const W = tcv.width, H = tcv.height;
          tctx.drawImage(layer, 0, 0);
          tctx.fillStyle = 'rgba(255,60,60,0.35)';
          for (const [s, e] of excludesRef.current) tctx.fillRect(s / D * W, 0, Math.max(2, (e - s) / D * W), H);
          if (exPendingRef.current != null) { tctx.fillStyle = '#ffd166'; tctx.fillRect(exPendingRef.current / D * W - 1, 0, 2, H); }
          const cur = videoRef.current?.currentTime || 0;
          tctx.fillStyle = '#fff'; tctx.fillRect(cur / D * W - 1, 0, 2, H);
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [loaded, currentFrame, activeEvent, buildTimelineLayer, videoDuration]);

  // ── 캔버스 클릭 = 그 시각 공 보유 이벤트 선택(토글) ──────────
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = detRef.current, vid = videoRef.current, cv = canvasRef.current;
    if (!d || !vid || !cv) return;
    const rect = cv.getBoundingClientRect();
    const vw = d.vw || vid.videoWidth || 1, vh = d.vh || vid.videoHeight || 1;
    const px = (e.clientX - rect.left) / rect.width * vw;
    const py = (e.clientY - rect.top) / rect.height * vh;
    const F = currentFrame();
    const T = vid.currentTime || (F / d.fps);
    const boxes = (d.byFrame.get(F) || []).filter((b) => b.cls === 'player' && b.tid !== -1);
    let C: number | null = null, bestD = Infinity;
    for (const b of boxes) {
      if (Math.abs(px - b.cx) <= b.w / 2 && Math.abs(py - b.cy) <= b.h / 2) {
        const dd = Math.hypot(px - b.cx, py - b.cy);
        if (dd < bestD) { C = b.tid; bestD = dd; }
      }
    }
    const ev = activeEvent(F, C);
    if (ev) {
      togglePick({ key: 'e' + ev.id, kind: 'event', evId: ev.id, track_id: ev.track_id, start: ev.start, end: ev.end, n_touch: ev.n_touch });
    } else {
      const t = +T.toFixed(1);
      togglePick({ key: 'm' + t, kind: 'mark', t, start: t, end: t });
    }
  };

  // ── 재생/배속/단축키 ──────────────────────────────────────
  const togglePlay = () => {
    const vid = videoRef.current; if (!vid) return;
    if (vid.paused) vid.play().catch(() => undefined); else vid.pause();
  };
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = speed; }, [speed, loaded, videoVer]);

  useEffect(() => {
    if (!loaded) return;
    const onKey = (e: KeyboardEvent) => {
      const vid = videoRef.current; if (!vid || !vid.src) return;
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === ' ') { togglePlay(); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { vid.currentTime += e.shiftKey ? 0.1 : 1; e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { vid.currentTime -= e.shiftKey ? 0.1 : 1; e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loaded]);

  // ── 페이로드 / 미리보기(디바운스) / 추출 ────────────────────
  const buildBody = useCallback(() => ({
    track_windows: picks.filter((p): p is Extract<Pick, { kind: 'event' }> => p.kind === 'event').map((p) => [p.track_id, p.start, p.end]),
    direct_marks: picks.filter((p): p is Extract<Pick, { kind: 'mark' }> => p.kind === 'mark').map((p) => p.t),
    pad_before: padBefore,
    pad_after: padAfter,
    exclude_intervals: excludes,
  }), [picks, padBefore, padAfter, excludes]);

  useEffect(() => {
    if (!job || !picks.length) { setPreview(null); return; }
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    const seq = ++previewSeqRef.current;
    previewTimerRef.current = setTimeout(async () => {
      try {
        const resp = await apiJson<PreviewResp>(`/highlight/player-jobs/${job.id}/preview`, {
          method: 'POST', body: JSON.stringify(buildBody()),
        });
        if (seq === previewSeqRef.current) setPreview(resp);
      } catch { /* noop */ }
    }, 350);
  }, [job, picks, excludes, padBefore, padAfter, buildBody]);

  const handleExtract = async () => {
    if (!job) return;
    if (!picks.length) { setStatus('공 잡는 순간 선수를 클릭해 터치를 선택하세요.'); return; }
    setExtracting(true);
    setStatus('공 관여 구간 추출 중...');
    try {
      const resp = await apiJson<ExtractResp>(`/highlight/player-jobs/${job.id}/extract`, {
        method: 'POST', body: JSON.stringify(buildBody()),
      });
      setClipSegs((resp.segments || []).filter((s) => s.clip));
      setClipSel(new Set());
      setStatus(`추출 완료 — ${resp.clip_count}개 클립`);
    } catch (err) {
      setStatus(`추출 오류: ${err}`);
    } finally {
      setExtracting(false);
    }
  };

  const deleteClips = async (names: string[]) => {
    if (!job) return;
    setStatus(`클립 삭제 중 (${names.length}개)...`);
    let ok = 0;
    for (const name of names) {
      try {
        const r = await fetch(`${API_BASE}/highlight/jobs/${job.id}/clips/${encodeURIComponent(name)}`, {
          method: 'DELETE', credentials: 'include',
        });
        if (r.ok) ok++;
      } catch { /* noop */ }
    }
    const gone = new Set(names);
    setClipSegs((prev) => prev.filter((s) => !gone.has(s.clip!)));
    setClipSel((prev) => { const n = new Set(prev); names.forEach((x) => n.delete(x)); return n; });
    setStatus(`클립 ${ok}개 삭제됨`);
  };

  // ── 제외 구간 ─────────────────────────────────────────────
  const onTimelineClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const D = videoDuration(); const vid = videoRef.current;
    if (!vid || D <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    vid.currentTime = Math.max(0, Math.min(D, (e.clientX - r.left) / r.width * D));
  };
  const exStart = () => setExPending(+(videoRef.current?.currentTime || 0).toFixed(1));
  const exEnd = () => {
    if (exPending == null) return;
    const end = +(videoRef.current?.currentTime || 0).toFixed(1);
    const s = Math.min(exPending, end), e = Math.max(exPending, end);
    if (e - s >= 0.1) setExcludes((prev) => [...prev, [+s.toFixed(1), +e.toFixed(1)]]);
    setExPending(null);
  };

  // ── 프록시(고배속 재생 최적화) ────────────────────────────
  const requestProxy = async () => {
    if (!job) return;
    setProxyBusy(true);
    setProxyInfo('재생용 저화질 영상 생성 중... (수 분 소요)');
    try {
      await fetch(`${API_BASE}/highlight/player-jobs/${job.id}/proxy`, { method: 'POST', credentials: 'include' });
    } catch { setProxyInfo('요청 실패'); setProxyBusy(false); return; }
    if (proxyPollRef.current) clearInterval(proxyPollRef.current);
    proxyPollRef.current = setInterval(async () => {
      try {
        const m = await apiJson<PlayerJob>(`/highlight/jobs/${job.id}`);
        if (m.job_metadata?.proxy_file) {
          if (proxyPollRef.current) clearInterval(proxyPollRef.current);
          setHasProxy(true); setProxyBusy(false);
          setProxyInfo('✅ 최적화 완료 — 3·4배속 재생 가능');
          seekResumeRef.current = videoRef.current?.currentTime || 0;
          setVideoVer((v) => v + 1); // src 갱신 → 프록시 로드
        } else if (m.job_metadata?.proxy_status === 'error') {
          if (proxyPollRef.current) clearInterval(proxyPollRef.current);
          setProxyBusy(false); setProxyInfo('생성 실패 — 원본으로 재생됩니다.');
        }
      } catch { /* noop */ }
    }, 3000);
  };

  const detecting = job != null && (job.status === 'queued' || job.status === 'processing');
  const ready = job != null && job.status === 'done';
  const vh = detRef.current?.vh || 0;
  const showProxyBtn = ready && !hasProxy && (vh === 0 || vh > 720);
  const aspect = (detRef.current && detRef.current.vw > 0 && detRef.current.vh > 0)
    ? `${detRef.current.vw} / ${detRef.current.vh}` : '16 / 9';
  const sortedPicks = useMemo(() => [...picks].sort((a, b) => a.start - b.start), [picks]);

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: 24, color: 'var(--text, #eee)' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>🎯 개인 클립 추출</h1>
      <p style={{ fontSize: 13, color: 'var(--muted, #999)', marginBottom: 20 }}>
        영상을 올리면 선수·공을 탐지합니다. 훑어보다가 <b>타깃 선수가 공을 잡는 순간 그 선수를 클릭</b>하세요.
        클릭은 <b>&quot;이 터치 = 내 선수&quot;</b> 표시일 뿐 추적을 따라가지 않으므로, track id 가 직후 바뀌어도 무관합니다.
      </p>

      <div style={card}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <input
            type="text"
            placeholder="이름(선택)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={{ ...btn, cursor: 'text', minWidth: 160 }}
          />
          <button style={primaryBtn} onClick={handleUpload} disabled={uploading || detecting}>
            {uploading ? '업로드 중...' : detecting ? '탐지 중...' : '업로드 & 탐지'}
          </button>
        </div>
        {status && <p style={{ fontSize: 13, marginTop: 12, color: 'var(--muted, #999)' }}>{status}</p>}
      </div>

      {detecting && (() => {
        const pct = typeof job?.progress === 'number' ? Math.max(0, Math.min(100, job.progress)) : null;
        const hasPct = job?.status === 'processing' && pct !== null;
        return (
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <p style={{ fontSize: 14, margin: 0 }}>
                ⏳ {job?.stage ? `${job.stage} 중...` : '탐지·추적 진행 중...'}
              </p>
              {hasPct && <span style={{ fontSize: 13, color: 'var(--accent, #4a9eff)', fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>}
            </div>
            {hasPct && (
              <div style={{ marginTop: 12, height: 6, borderRadius: 3, background: 'var(--border-ghost, #2a2a2a)', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent, #4a9eff)', transition: 'width 0.4s ease' }} />
              </div>
            )}
          </div>
        );
      })()}

      {ready && loaded && job && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
          {/* 좌: 영상 + 캔버스 오버레이 */}
          <div style={card}>
            <h2 style={{ fontSize: 15, marginBottom: 10 }}>영상 리뷰 — 공 잡는 선수 클릭</h2>
            <div style={{ position: 'relative', width: '100%', aspectRatio: aspect, background: '#000', borderRadius: 8, overflow: 'hidden' }}>
              <video
                ref={videoRef}
                key={videoVer}
                src={`${API_BASE}/highlight/player-jobs/${job.id}/video?v=${videoVer}`}
                muted
                playsInline
                onLoadedMetadata={() => {
                  if (videoRef.current) {
                    videoRef.current.playbackRate = speed;
                    if (seekResumeRef.current) { try { videoRef.current.currentTime = seekResumeRef.current; } catch { /* noop */ } seekResumeRef.current = 0; }
                  }
                }}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              />
              <canvas
                ref={canvasRef}
                onClick={onCanvasClick}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair' }}
              />
            </div>

            {/* 컨트롤 */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
              <button style={smallBtn} onClick={togglePlay}>⏯ 재생/정지</button>
              <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 4 }}>
                배속
                <select value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} style={{ ...smallBtn, padding: '3px 6px' }}>
                  {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
                </select>
              </label>
              <span style={{ fontSize: 11, color: 'var(--muted, #999)' }}>Space 재생 · ←→ 1초(Shift 0.1초)</span>
              {showProxyBtn && (
                <button style={smallBtn} onClick={requestProxy} disabled={proxyBusy}>⚡ 고배속 최적화</button>
              )}
            </div>
            {proxyInfo && <p style={{ fontSize: 11, color: 'var(--muted, #999)', marginTop: 6 }}>{proxyInfo}</p>}

            {/* 신원 검증 타임라인 */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--muted, #999)', marginBottom: 4 }}>{verifyStat}</div>
              <canvas
                ref={timelineRef}
                onClick={onTimelineClick}
                style={{ width: '100%', height: 34, borderRadius: 6, cursor: 'pointer', display: 'block' }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <button style={smallBtn} onClick={exStart}>제외 시작</button>
                <button style={smallBtn} onClick={exEnd} disabled={exPending == null}>제외 끝</button>
                {exPending != null && (
                  <span style={{ fontSize: 11, color: '#ffd166' }}>제외 시작 {exPending.toFixed(1)}s — 끝 위치로 이동 후 &apos;제외 끝&apos;</span>
                )}
                <span style={{ fontSize: 11, color: 'var(--muted, #999)' }}>
                  <span style={{ color: '#39d353' }}>▮</span> 선택 선수 추적 · <span style={{ color: '#ff5a5a' }}>▮</span> 위치 급변(의심)
                </span>
              </div>
              {excludes.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {excludes.map((iv, i) => (
                    <span key={i} style={{ background: 'rgba(255,60,60,0.18)', border: '1px solid rgba(255,60,60,0.45)', color: '#ff8a8a', borderRadius: 6, padding: '3px 8px', fontSize: 11, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      제외 {iv[0]}s~{iv[1]}s
                      <button onClick={() => setExcludes((prev) => prev.filter((_, j) => j !== i))}
                        style={{ background: 'none', border: 'none', color: '#ff8a8a', cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1 }}>✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 우: 선택한 터치 + 패딩 + 추출 */}
          <div style={card}>
            <h2 style={{ fontSize: 15, marginBottom: 4 }}>
              선택한 터치 {picks.length}개 · {job.job_metadata?.n_player_tracks ?? 0}개 추적
            </h2>
            <p style={{ fontSize: 12, color: 'var(--muted, #999)', marginBottom: 10 }}>
              {picks.length ? '공 잡는 순간을 더 클릭해 추가하거나 칩의 ✕로 해제하세요.' : '공 잡는 순간 선수를 클릭하세요 (id 가 바뀌어도 무관).'}
            </p>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxHeight: 240, overflowY: 'auto' }}>
              {sortedPicks.map((p) => {
                const t = Math.floor(p.start), mm = Math.floor(t / 60), ss = String(t % 60).padStart(2, '0');
                return (
                  <div key={p.key} style={{ flex: '0 0 auto', minWidth: 100, borderRadius: 8, padding: '6px 8px', fontSize: 11, border: '1px solid #39d353', background: '#16240f' }}>
                    <div style={{ fontWeight: 600, color: '#39d353' }}>
                      {mm}:{ss} · {p.kind === 'event' ? `${p.n_touch}터치` : '수동'}
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <button style={{ ...smallBtn, padding: '2px 6px', fontSize: 11 }}
                        onClick={() => { if (videoRef.current) { videoRef.current.currentTime = p.start; videoRef.current.pause(); } forceTick((x) => x + 1); }}>▶</button>
                      <button style={{ ...smallBtn, padding: '2px 6px', fontSize: 11 }}
                        onClick={() => togglePick(p)}>✕</button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                앞 패딩(초)
                <input type="number" step="0.5" value={padBefore} onChange={(e) => setPadBefore(parseFloat(e.target.value) || 0)}
                  style={{ ...smallBtn, cursor: 'text', width: 70, marginLeft: 6 }} />
              </label>
              <label style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                뒤 패딩(초)
                <input type="number" step="0.5" value={padAfter} onChange={(e) => setPadAfter(parseFloat(e.target.value) || 0)}
                  style={{ ...smallBtn, cursor: 'text', width: 70, marginLeft: 6 }} />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
              <button style={primaryBtn} onClick={handleExtract} disabled={extracting || !picks.length}>
                {extracting ? '추출 중...' : '공 관여 클립 추출'}
              </button>
              {preview && (
                <span style={{ fontSize: 12, color: preview.clip_count ? '#39d353' : 'var(--muted, #999)' }}>
                  {preview.clip_count ? `예상 ${preview.clip_count}개 · 총 ${Math.round(preview.total_seconds ?? 0)}초` : '관여 구간 없음'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {clipSegs.length > 0 && job && (
        <div style={card}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <h2 style={{ fontSize: 15, margin: 0 }}>추출된 클립 ({clipSegs.length})</h2>
            <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>선택 {clipSel.size}개</span>
            <button style={smallBtn} onClick={() => setClipSel((prev) => prev.size === clipSegs.length ? new Set() : new Set(clipSegs.map((s) => s.clip!)))}>
              전체 선택/해제
            </button>
            <button style={{ ...smallBtn, background: '#7a2230' }} onClick={() => { if (clipSel.size && confirm(`선택한 ${clipSel.size}개 클립을 삭제할까요?`)) deleteClips([...clipSel]); }}>
              🗑 선택 삭제
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {clipSegs.map((seg) => (
              <div key={seg.clip} style={{ position: 'relative' }}>
                <input type="checkbox" checked={clipSel.has(seg.clip!)}
                  onChange={(e) => setClipSel((prev) => { const n = new Set(prev); if (e.target.checked) n.add(seg.clip!); else n.delete(seg.clip!); return n; })}
                  style={{ position: 'absolute', top: 8, left: 8, width: 18, height: 18, zIndex: 2, cursor: 'pointer' }} />
                <video
                  src={`${API_BASE}/highlight/jobs/${job.id}/clips/${encodeURIComponent(seg.clip!)}`}
                  controls preload="metadata"
                  style={{ width: '100%', borderRadius: 8, background: '#000' }}
                />
                <p style={{ fontSize: 11, color: 'var(--muted, #999)', marginTop: 4 }}>
                  공 관여 {seg.involve_start}s~{seg.involve_end}s (클립 {seg.start}~{seg.end}s)
                </p>
                <button style={{ ...smallBtn, fontSize: 11 }} onClick={() => { if (confirm('이 클립을 삭제할까요?')) deleteClips([seg.clip!]); }}>🗑 삭제</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
