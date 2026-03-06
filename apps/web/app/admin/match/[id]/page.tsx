'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import HlsPlayer from '../../../../components/HlsPlayer';
import { ComposedChart, Area, Line, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '/api';
const DEFAULT_HLS = process.env.NEXT_PUBLIC_DEFAULT_HLS_URL || '';
const HALF_PITCH_LENGTH = 52.5;
const XG_VISIBLE_LENGTH = 40;
const XG_VISIBLE_OFFSET = HALF_PITCH_LENGTH - XG_VISIBLE_LENGTH;
const PITCH_WIDTH = 68;

type Team = 'HOME' | 'AWAY';
type PossessionTeam = Team | 'NONE';
type Lane = 'LEFT' | 'CENTER' | 'RIGHT';

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // UUID v4 fallback for non-secure HTTP contexts.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function MatchPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [userId, setUserId] = useState('analyst-1');
  const [match, setMatch] = useState<any>(null);
  const [summary, setSummary] = useState<any>(null);
  const [dominance, setDominance] = useState<any[]>([]);
  const [outbox, setOutbox] = useState<any[]>([]);
  const [possessionLogs, setPossessionLogs] = useState<string[]>([]);

  const [clockMs, setClockMs] = useState(0);
  const [running, setRunning] = useState(false);
  const [possessionTeam, setPossessionTeam] = useState<PossessionTeam>('NONE');
  const [selectedTeam, setSelectedTeam] = useState<Team>('HOME');
  const [pendingLane, setPendingLane] = useState<Lane>('CENTER');

  const [xgTeam, setXgTeam] = useState<Team>('HOME');
  const [xgValue, setXgValue] = useState('0.10');
  const [shotPoint, setShotPoint] = useState<{ x: number; y: number } | null>(null);
  const [isHeaderShot, setIsHeaderShot] = useState(false);
  const [isWeakFootShot, setIsWeakFootShot] = useState(false);
  const [xgEstimateMeta, setXgEstimateMeta] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [isAttachingStream, setIsAttachingStream] = useState(false);
  const [isStoppingStream, setIsStoppingStream] = useState(false);
  const [isClearingHls, setIsClearingHls] = useState(false);

  const perfRef = useRef<number | null>(null);
  const baseRef = useRef<number>(0);
  const clockRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);
  const initializedRef = useRef<boolean>(false);
  const lastPossessionLogSecondRef = useRef<number>(-1);
  const fetchSeqRef = useRef<number>(0);

  useEffect(() => {
    clockRef.current = clockMs;
  }, [clockMs]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    if (possessionTeam === 'HOME' || possessionTeam === 'AWAY') {
      setSelectedTeam(possessionTeam);
      setXgTeam(possessionTeam);
    }
  }, [possessionTeam]);

  const isOperator = useMemo(() => match?.operator_id && match.operator_id === userId, [match, userId]);
  const canWrite = useMemo(() => !match?.operator_id || match.operator_id === userId, [match, userId]);

  const saveState = async (next?: Partial<{clockMs:number; running:boolean; possessionTeam:PossessionTeam; selectedTeam:Team;}>) => {
    const payload = {
      state_id: makeId(),
      clock_ms: next?.clockMs ?? clockMs,
      running: next?.running ?? running,
      possession_team: next?.possessionTeam ?? possessionTeam,
      selected_team: next?.selectedTeam ?? selectedTeam,
      attack_lr: 'L2R',
      user_id: userId,
    };
    await fetch(`${API_BASE}/matches/${id}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  const fetchAll = async () => {
    const seq = ++fetchSeqRef.current;
    const [m, s, d, o] = await Promise.all([
      fetch(`${API_BASE}/matches/${id}`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`${API_BASE}/matches/${id}/summary`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`${API_BASE}/matches/${id}/dominance?bin_seconds=180`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`${API_BASE}/outbox`, { cache: 'no-store' }).then((r) => r.json()),
    ]);
    if (seq !== fetchSeqRef.current) return;
    setMatch(m);
    setSummary(s);
    setDominance(d.bins || []);
    setOutbox(o || []);

    if (s?.state && !initializedRef.current) {
      initializedRef.current = true;
      setClockMs(s.state.clock_ms || 0);
      setRunning(Boolean(s.state.running));
      setPossessionTeam(s.state.possession_team || 'NONE');
      setSelectedTeam(s.state.selected_team || 'HOME');
      setXgTeam(s.state.selected_team || 'HOME');
      baseRef.current = s.state.clock_ms || 0;
      perfRef.current = performance.now();
    }
  };

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 1000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    const s = summary?.state;
    const p = summary?.possession;
    if (!s || !p) return;

    const second = Math.floor((s.clock_ms || 0) / 1000);
    if (second <= lastPossessionLogSecondRef.current) return;
    lastPossessionLogSecondRef.current = second;

    const teamLabel =
      s.possession_team === 'HOME'
        ? 'Home'
        : s.possession_team === 'AWAY'
        ? 'Away'
        : 'None';
    const homePct = Math.round(Number(p.home_pct || 0));
    const awayPct = Math.round(Number(p.away_pct || 0));
    const line = `${fmt(second * 1000)} | ${teamLabel} | ${homePct} : ${awayPct}`;

    setPossessionLogs((prev) => [line, ...prev].slice(0, 120));
  }, [summary]);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const loop = () => {
      if (perfRef.current != null) {
        const delta = performance.now() - perfRef.current;
        setClockMs(Math.floor(baseRef.current + delta));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  useEffect(() => {
    const t = setInterval(() => {
      if (canWrite) {
        saveState({ clockMs: clockRef.current }).catch(() => undefined);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [running, possessionTeam, selectedTeam, canWrite, userId]);

  const toggleRun = async () => {
    if (!canWrite) return;
    if (running) {
      const finalClock = perfRef.current == null ? clockMs : Math.floor(baseRef.current + (performance.now() - perfRef.current));
      setClockMs(finalClock);
      baseRef.current = finalClock;
      perfRef.current = null;
      setRunning(false);
      await saveState({ clockMs: finalClock, running: false });
    } else {
      perfRef.current = performance.now();
      baseRef.current = clockMs;
      setRunning(true);
      await saveState({ running: true });
    }
  };

  const copyText = async (value: string, label: string) => {
    if (!value) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const t = document.createElement('textarea');
        t.value = value;
        t.style.position = 'fixed';
        t.style.opacity = '0';
        document.body.appendChild(t);
        t.focus();
        t.select();
        document.execCommand('copy');
        document.body.removeChild(t);
      }
      setCopyMessage(`${label} copied`);
      setTimeout(() => setCopyMessage(''), 1500);
    } catch {
      setCopyMessage(`Failed to copy ${label.toLowerCase()}`);
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  const downloadPossessionCsv = () => {
    if (possessionLogs.length === 0) return;
    const header = 'timeline,team,home_pct,away_pct';
    const rows = possessionLogs
      .slice()
      .reverse()
      .map((line) => {
        const parts = line.split('|').map((v) => v.trim());
        const timeline = parts[0] || '';
        const team = parts[1] || '';
        const ratio = (parts[2] || '').split(':').map((v) => v.trim());
        const homePct = ratio[0] || '';
        const awayPct = ratio[1] || '';
        return `${timeline},${team},${homePct},${awayPct}`;
      });
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `possession_timeline_${id}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const resetClock = async () => {
    if (!canWrite) return;
    setClockMs(0);
    baseRef.current = 0;
    perfRef.current = performance.now();
    await saveState({ clockMs: 0 });
  };

  const changePossession = async (team: PossessionTeam) => {
    if (!canWrite) return;
    setPossessionTeam(team);
    if (team === 'HOME' || team === 'AWAY') {
      setSelectedTeam(team);
      setXgTeam(team);
      await saveState({ possessionTeam: team, selectedTeam: team });
      return;
    }
    await saveState({ possessionTeam: team });
  };

  const sendLane = async (lane: Lane) => {
    if (!canWrite) return;
    await fetch(`${API_BASE}/matches/${id}/events/attack_lane`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: makeId(), team: selectedTeam, lane, clock_ms: clockMs, user_id: userId }),
    });
  };

  const submitXg = async () => {
    if (!canWrite) return;
    const xg = Number(xgValue);
    if (!Number.isFinite(xg) || xg < 0) return;
    await fetch(`${API_BASE}/matches/${id}/events/xg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: makeId(), team: xgTeam, xg, clock_ms: clockMs, user_id: userId }),
    });
    setXgValue('0.10');
  };

  const attachRtmp = async () => {
    if (!canWrite || isAttachingStream) return;
    setIsAttachingStream(true);
    try {
      const res = await fetch(`${API_BASE}/matches/${id}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingest_protocol: 'RTMP' }),
      });
      setCopyMessage(res.ok ? 'Stream attached' : 'Stream attach failed');
      await fetchAll();
    } catch {
      setCopyMessage('Stream attach failed');
    } finally {
      setIsAttachingStream(false);
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  const stopStream = async () => {
    if (!canWrite || isStoppingStream) return;
    if (!window.confirm('이 매치 스트림을 중지할까요?')) return;
    setIsStoppingStream(true);
    try {
      const res = await fetch(`${API_BASE}/matches/${id}/stream/stop`, { method: 'POST' });
      setCopyMessage(res.ok ? 'Stream stopped' : 'Stream stop failed');
      await fetchAll();
    } catch {
      setCopyMessage('Stream stop failed');
    } finally {
      setIsStoppingStream(false);
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  const clearHls = async () => {
    if (!canWrite || isClearingHls) return;
    if (!window.confirm('기존 HLS 영상 파일을 정리할까요?')) return;
    setIsClearingHls(true);
    try {
      const res = await fetch(`${API_BASE}/matches/${id}/stream/clear`, { method: 'POST' });
      if (!res.ok) {
        setCopyMessage('HLS clear failed');
      } else {
        setCopyMessage('HLS cleared');
        await fetchAll();
      }
    } catch {
      setCopyMessage('HLS clear failed');
    } finally {
      setIsClearingHls(false);
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  const onPitchClick = (e: { currentTarget: HTMLDivElement; clientX: number; clientY: number }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Rotated fixed-width zone (CCW 90deg visual): top is goal, bottom is 40m line.
    const y = (px / rect.width) * PITCH_WIDTH;
    const x = (1 - py / rect.height) * XG_VISIBLE_LENGTH;
    setShotPoint({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
    setXgEstimateMeta('');
  };

  const estimateXgFromPitch = async () => {
    if (!shotPoint) {
      setXgEstimateMeta('Click on the pitch first');
      return;
    }
    const res = await fetch(`${API_BASE}/xg/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Fixed half-pitch mode: always evaluate toward the same goal.
        team: 'HOME',
        attack_lr: 'L2R',
        start_x: Number((HALF_PITCH_LENGTH + XG_VISIBLE_OFFSET + shotPoint.x).toFixed(2)),
        start_y: shotPoint.y,
        is_header: isHeaderShot,
        is_weak_foot: isWeakFootShot,
      }),
    });
    if (!res.ok) {
      setXgEstimateMeta(`Estimate failed (${res.status})`);
      return;
    }
    const data = await res.json();
    setXgValue(String(data.xg));
    setXgEstimateMeta(`xG=${data.xg} | dist=${data.distance}m | ${data.is_in_box ? 'in-box' : 'out-box'}`);
  };

  const acquire = async () => {
    await fetch(`${API_BASE}/matches/${id}/lock/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    await fetchAll();
  };

  const release = async () => {
    await fetch(`${API_BASE}/matches/${id}/lock/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    await fetchAll();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.code === 'Space') {
        e.preventDefault();
        toggleRun();
      } else if (e.key === 'r' || e.key === 'R') {
        resetClock();
      } else if (e.key === 'q' || e.key === 'Q') {
        changePossession('HOME');
      } else if (e.key === 'w' || e.key === 'W') {
        changePossession('AWAY');
      } else if (e.key === 'e' || e.key === 'E') {
        changePossession('NONE');
      } else if (e.key === 'a' || e.key === 'A') {
        setPendingLane('LEFT');
      } else if (e.key === 's' || e.key === 'S') {
        setPendingLane('CENTER');
      } else if (e.key === 'd' || e.key === 'D') {
        setPendingLane('RIGHT');
      } else if (e.key === 'Enter') {
        sendLane(pendingLane);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, canWrite, possessionTeam, userId, pendingLane]);

  const hlsSrc = match?.hls_url || DEFAULT_HLS;
  const rtmpServer = match?.metadata?.rtmp?.server_url || '';
  const streamKey = match?.metadata?.rtmp?.stream_key || id;
  const pushUrl = match?.metadata?.rtmp?.push_url || (rtmpServer && streamKey ? `${rtmpServer}/${streamKey}` : '');
  const possessionLabel =
    possessionTeam === 'HOME' ? 'Home' : possessionTeam === 'AWAY' ? 'Away' : 'Loose Ball';
  const dominanceBaseData = useMemo(
    () =>
      dominance.map((d) => ({
        minuteVal: Number(d.start_ms || 0) / 60000,
        dominance: Number(d.dominance || 0),
      })),
    [dominance]
  );
  const dominanceXAxisTicks = useMemo(
    () => dominanceBaseData.map((d) => d.minuteVal),
    [dominanceBaseData]
  );
  const dominanceChartData = useMemo(() => {
    return dominanceBaseData.map((d) => ({
      minuteVal: d.minuteVal,
      dominance: d.dominance,
    }));
  }, [dominanceBaseData]);

  return (
    <main className="container grid">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="grid" style={{ gap: 6 }}>
          <h2 style={{ margin: 0 }}>{match?.name || 'Match'}</h2>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="muted">RTMP Server: {rtmpServer || 'N/A'}</span>
            <button onClick={() => copyText(rtmpServer, 'Server URL')} disabled={!rtmpServer}>Copy Server</button>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="muted">Stream Key: {streamKey || 'N/A'}</span>
            <button onClick={() => copyText(streamKey, 'Stream key')} disabled={!streamKey}>Copy Key</button>
            <button onClick={() => copyText(pushUrl, 'Push URL')} disabled={!pushUrl}>Copy Full URL</button>
          </div>
          {copyMessage ? <div className="muted">{copyMessage}</div> : null}
        </div>
        <div className="row">
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="user_id" />
          {!isOperator
            ? <button className="btn-primary" onClick={acquire}>Acquire Lock</button>
            : <button className="btn-danger" onClick={release}>Release Lock</button>}
          <span className="muted">operator: {match?.operator_id || 'none'} / me: {canWrite ? 'write' : 'read-only'}</span>
        </div>
      </div>

      <div className="split">
        <div className="grid" style={{ gap: 12, alignContent: 'start' }}>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
              <strong>Timer</strong>
              <strong style={{ fontSize: 24 }}>{fmt(clockMs)}</strong>
              <button className={running ? 'btn-active' : ''} onClick={toggleRun} disabled={!canWrite}>Start/Pause <span className="kbd">Space</span></button>
              <button onClick={resetClock} disabled={!canWrite}>Reset <span className="kbd">R</span></button>
            </div>
          </div>

          <div className="card grid">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>HLS Stream</h3>
              <div className="row">
                <button onClick={attachRtmp} disabled={!canWrite || isAttachingStream}>
                  {isAttachingStream ? 'Attaching...' : 'Attach RTMP'}
                </button>
                <button onClick={stopStream} disabled={!canWrite || isStoppingStream}>
                  {isStoppingStream ? 'Stopping...' : 'Stop Stream'}
                </button>
                <button onClick={clearHls} disabled={!canWrite || isClearingHls}>
                  {isClearingHls ? 'Clearing...' : 'Clear HLS'}
                </button>
              </div>
            </div>
            {hlsSrc ? <HlsPlayer src={hlsSrc} /> : <div className="muted">No HLS URL configured</div>}
          </div>

          <div className="card grid" style={{ minHeight: 280 }}>
            <h3>Recent Events</h3>
            <div
              className="grid"
              style={{
                height: 220,
                overflowY: 'auto',
                paddingRight: 4,
              }}
            >
              {(summary?.events || []).slice(0, 40).map((e: any) => (
                <div key={e.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{e.type} {e.team} @ {fmt(e.clock_ms)} {e.lane ? `lane=${e.lane}` : ''} {typeof e.xg === 'number' ? `xg=${e.xg}` : ''}</span>
                  <span className="muted">{new Date(e.created_at).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid" style={{ gap: 12, alignContent: 'start' }}>
          <div className="card grid">
            <h3>xG Input</h3>
            <div className="row">
              <select value={xgTeam} onChange={(e) => setXgTeam(e.target.value as Team)}>
                <option value="HOME">HOME</option>
                <option value="AWAY">AWAY</option>
              </select>
              <input value={xgValue} onChange={(e) => setXgValue(e.target.value)} placeholder="xG" />
              <button onClick={estimateXgFromPitch} disabled={!canWrite}>Estimate xG (Pitch)</button>
              <button className="btn-primary" onClick={submitXg} disabled={!canWrite}>Record xG</button>
            </div>
            <div
              onClick={onPitchClick}
              style={{
                position: 'relative',
                width: '100%',
                maxWidth: 520,
                aspectRatio: '68 / 40',
                border: '1px solid #1f2937',
                borderRadius: 8,
                cursor: 'crosshair',
                background:
                  'repeating-linear-gradient(0deg, #3f7f3f 0 10%, #3a733a 10% 20%)',
              }}
            >
              <div style={{ position: 'absolute', inset: 0, border: '2px solid rgba(255,255,255,0.9)', borderRadius: 8 }} />
              <div style={{ position: 'absolute', left: '20.35%', top: '0%', width: '59.29%', height: '41.25%', border: '1px solid rgba(255,255,255,0.8)' }} />
              <div style={{ position: 'absolute', left: '36.53%', top: '0%', width: '26.94%', height: '13.75%', border: '1px solid rgba(255,255,255,0.75)' }} />
              <div style={{ position: 'absolute', left: '50%', top: '27.5%', width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', transform: 'translate(-50%, -50%)' }} />
              <svg
                viewBox="0 0 68 40"
                preserveAspectRatio="none"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
              >
                <path d="M26.69 16.5 A9.15 9.15 0 0 0 41.31 16.5" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.18" />
              </svg>
              {shotPoint ? (
                <div
                  style={{
                    position: 'absolute',
                    left: `${(shotPoint.y / PITCH_WIDTH) * 100}%`,
                    top: `${(1 - shotPoint.x / XG_VISIBLE_LENGTH) * 100}%`,
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: '#ef4444',
                    border: '2px solid white',
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              ) : null}
              <div style={{ position: 'absolute', left: 8, top: 6, color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: 600 }}>Goal Side</div>
              <div style={{ position: 'absolute', left: 8, bottom: 6, color: 'rgba(255,255,255,0.75)', fontSize: 10 }}>68m x 40m (rotated)</div>
            </div>
            <div className="row" style={{ gap: 12 }}>
              <label><input type="checkbox" checked={isHeaderShot} onChange={(e) => setIsHeaderShot(e.target.checked)} /> Header</label>
              <label><input type="checkbox" checked={isWeakFootShot} onChange={(e) => setIsWeakFootShot(e.target.checked)} /> Weak Foot</label>
              <span className="muted">{shotPoint ? `shot=(${shotPoint.x}, ${shotPoint.y})` : 'Click pitch to set shot location'}</span>
            </div>
            {xgEstimateMeta ? <div className="muted">{xgEstimateMeta}</div> : null}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="card grid" style={{ minHeight: 180, gap: 8 }}>
              <h3>Possession</h3>
              <div className="row">
                <span>Current: {possessionLabel}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>Home</span>
                <strong>{summary?.possession?.home_pct?.toFixed(2) || '0.00'}% : {summary?.possession?.away_pct?.toFixed(2) || '0.00'}%</strong>
                <span>Away</span>
              </div>
              <div className="row">
                <button className={possessionTeam === 'HOME' ? 'btn-active' : ''} onClick={() => changePossession('HOME')} disabled={!canWrite}>Home <span className="kbd">Q</span></button>
                <button className={possessionTeam === 'AWAY' ? 'btn-active' : ''} onClick={() => changePossession('AWAY')} disabled={!canWrite}>Away <span className="kbd">W</span></button>
                <button className={possessionTeam === 'NONE' ? 'btn-active' : ''} onClick={() => changePossession('NONE')} disabled={!canWrite}>Loose Ball <span className="kbd">E</span></button>
              </div>
            </div>

            <div className="card grid" style={{ minHeight: 180, gap: 8 }}>
              <h3>Possession Timeline Log</h3>
              <div className="row" style={{ marginBottom: 8 }}>
                <button onClick={downloadPossessionCsv} disabled={possessionLogs.length === 0}>Download CSV</button>
              </div>
              <div
                className="grid"
                style={{
                  height: 105,
                  overflowY: 'auto',
                  paddingRight: 4,
                }}
              >
                {possessionLogs.length === 0 ? (
                  <span className="muted">No logs yet</span>
                ) : (
                  possessionLogs.map((line, idx) => (
                    <span key={`${idx}-${line}`} className="muted">{line}</span>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="card grid">
            <h3>Attack Direction Input (Event)</h3>
            <div className="row">
              <span>Team:</span>
              <button className={selectedTeam === 'HOME' ? 'btn-active' : ''} onClick={() => changePossession('HOME')} disabled={!canWrite}>HOME <span className="kbd">Q</span></button>
              <button className={selectedTeam === 'AWAY' ? 'btn-active' : ''} onClick={() => changePossession('AWAY')} disabled={!canWrite}>AWAY <span className="kbd">W</span></button>
              <span>{selectedTeam}</span>
            </div>
            <div className="row">
              <span>Lane select:</span>
              <button className={pendingLane === 'LEFT' ? 'btn-active' : ''} onClick={() => setPendingLane('LEFT')} disabled={!canWrite}>LEFT <span className="kbd">A</span></button>
              <button className={pendingLane === 'CENTER' ? 'btn-active' : ''} onClick={() => setPendingLane('CENTER')} disabled={!canWrite}>CENTER <span className="kbd">S</span></button>
              <button className={pendingLane === 'RIGHT' ? 'btn-active' : ''} onClick={() => setPendingLane('RIGHT')} disabled={!canWrite}>RIGHT <span className="kbd">D</span></button>
              <span>selected={pendingLane}</span>
            </div>
            <div className="row">
              <button className="btn-primary" onClick={() => sendLane(pendingLane)} disabled={!canWrite}>Record Lane <span className="kbd">Enter</span></button>
            </div>
            <div className="muted">
              HOME Lane(events): L {summary?.lanes?.home?.left_pct?.toFixed(1) || '0'}% / C {summary?.lanes?.home?.center_pct?.toFixed(1) || '0'}% / R {summary?.lanes?.home?.right_pct?.toFixed(1) || '0'}% (n={summary?.lanes?.home?.total_count || 0})
              <br />
              AWAY Lane(events): L {summary?.lanes?.away?.left_pct?.toFixed(1) || '0'}% / C {summary?.lanes?.away?.center_pct?.toFixed(1) || '0'}% / R {summary?.lanes?.away?.right_pct?.toFixed(1) || '0'}% (n={summary?.lanes?.away?.total_count || 0})
            </div>
          </div>

        </div>
      </div>

      <div className="card">
        <h3>Match Dominance (-1 ~ +1, 3-min bins)</h3>
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <ComposedChart data={dominanceChartData}>
              <defs>
                <linearGradient id="dominanceFillSingle" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0.18} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="minuteVal"
                ticks={dominanceXAxisTicks}
                tickFormatter={(v) => Number(v).toFixed(1)}
                domain={['dataMin', 'dataMax']}
              />
              <YAxis domain={[-1, 1]} />
              <Tooltip />
              <ReferenceLine y={0} stroke="#6b7280" />
              <Area type="monotone" dataKey="dominance" baseValue={0} stroke="none" fill="url(#dominanceFillSingle)" />
              <Line type="monotone" dataKey="dominance" stroke="#10b981" dot />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card">
        <h3>Outbox / Webhook Status</h3>
        <div className="grid">
          {outbox.slice(0, 20).map((o) => (
            <div key={o.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{o.kind} attempts={o.attempts}</span>
              <span className="muted">{o.last_error || 'pending/scheduled'}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
