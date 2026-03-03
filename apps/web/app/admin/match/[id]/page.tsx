'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import HlsPlayer from '../../../../components/HlsPlayer';
import { ComposedChart, Area, Line, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '/api';
const DEFAULT_HLS = process.env.NEXT_PUBLIC_DEFAULT_HLS_URL || '';

type Team = 'HOME' | 'AWAY';
type PossessionTeam = Team | 'NONE';
type Lane = 'LEFT' | 'CENTER' | 'RIGHT';
type AttackLR = 'L2R' | 'R2L';

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
  const [playerPaused, setPlayerPaused] = useState(false);
  const [possessionTeam, setPossessionTeam] = useState<PossessionTeam>('NONE');
  const [selectedTeam, setSelectedTeam] = useState<Team>('HOME');
  const [attackLR, setAttackLR] = useState<AttackLR>('L2R');
  const [pendingLane, setPendingLane] = useState<Lane>('CENTER');

  const [xgTeam, setXgTeam] = useState<Team>('HOME');
  const [xgValue, setXgValue] = useState('0.10');
  const [shotPoint, setShotPoint] = useState<{ x: number; y: number } | null>(null);
  const [isHeaderShot, setIsHeaderShot] = useState(false);
  const [isWeakFootShot, setIsWeakFootShot] = useState(false);
  const [xgEstimateMeta, setXgEstimateMeta] = useState('');
  const [copyMessage, setCopyMessage] = useState('');

  const perfRef = useRef<number | null>(null);
  const baseRef = useRef<number>(0);
  const clockRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);
  const initializedRef = useRef<boolean>(false);
  const lastPossessionLogSecondRef = useRef<number>(-1);

  useEffect(() => {
    clockRef.current = clockMs;
  }, [clockMs]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  const isOperator = useMemo(() => match?.operator_id && match.operator_id === userId, [match, userId]);
  const canWrite = useMemo(() => !match?.operator_id || match.operator_id === userId, [match, userId]);

  const saveState = async (next?: Partial<{clockMs:number; running:boolean; possessionTeam:PossessionTeam; selectedTeam:Team; attackLR:AttackLR;}>) => {
    const payload = {
      state_id: makeId(),
      clock_ms: next?.clockMs ?? clockMs,
      running: next?.running ?? running,
      possession_team: next?.possessionTeam ?? possessionTeam,
      selected_team: next?.selectedTeam ?? selectedTeam,
      attack_lr: next?.attackLR ?? attackLR,
      user_id: userId,
    };
    await fetch(`${API_BASE}/matches/${id}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  const fetchAll = async () => {
    const [m, s, d, o] = await Promise.all([
      fetch(`${API_BASE}/matches/${id}`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`${API_BASE}/matches/${id}/summary`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`${API_BASE}/matches/${id}/dominance?bin_seconds=180`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`${API_BASE}/outbox`, { cache: 'no-store' }).then((r) => r.json()),
    ]);
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
      setAttackLR(s.state.attack_lr || 'L2R');
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
    if (second === lastPossessionLogSecondRef.current) return;
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
  }, [running, possessionTeam, selectedTeam, attackLR, canWrite, userId]);

  const toggleRun = async () => {
    if (!canWrite) return;
    if (running) {
      const finalClock = perfRef.current == null ? clockMs : Math.floor(baseRef.current + (performance.now() - perfRef.current));
      setClockMs(finalClock);
      baseRef.current = finalClock;
      perfRef.current = null;
      setRunning(false);
      setPlayerPaused(true);
      await saveState({ clockMs: finalClock, running: false });
    } else {
      perfRef.current = performance.now();
      baseRef.current = clockMs;
      setRunning(true);
      setPlayerPaused(false);
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

  const toggleAttack = async () => {
    if (!canWrite) return;
    const next = attackLR === 'L2R' ? 'R2L' : 'L2R';
    setAttackLR(next);
    await saveState({ attackLR: next });
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

  const onPitchClick = (e: { currentTarget: HTMLDivElement; clientX: number; clientY: number }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const x = (px / rect.width) * 105;
    const y = (py / rect.height) * 68;
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
        team: xgTeam,
        attack_lr: attackLR,
        start_x: shotPoint.x,
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
      } else if (e.key === 'q' || e.key === 'Q' || e.key === 'ArrowLeft') {
        changePossession('HOME');
      } else if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowRight') {
        changePossession('AWAY');
      } else if (e.key === '1') {
        setSelectedTeam('HOME');
        setXgTeam('HOME');
        saveState({ selectedTeam: 'HOME' });
      } else if (e.key === '2') {
        setSelectedTeam('AWAY');
        setXgTeam('AWAY');
        saveState({ selectedTeam: 'AWAY' });
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
  }, [running, selectedTeam, canWrite, possessionTeam, attackLR, userId, pendingLane]);

  const hlsSrc = match?.hls_url || DEFAULT_HLS;
  const rtmpServer = match?.metadata?.rtmp?.server_url || '';
  const streamKey = match?.metadata?.rtmp?.stream_key || id;
  const pushUrl = match?.metadata?.rtmp?.push_url || (rtmpServer && streamKey ? `${rtmpServer}/${streamKey}` : '');
  const dominanceChartData = dominance.map((d) => {
    const value = Number(d.dominance || 0);
    return {
      ...d,
      minute: (d.start_ms / 60000).toFixed(1),
      dominance: value,
      dominance_pos: value > 0 ? value : 0,
      dominance_neg: value < 0 ? value : 0,
    };
  });

  return (
    <main className="container grid">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{match?.name || 'Match'}</h2>
        <div className="row">
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="user_id" />
          {!isOperator
            ? <button className="btn-primary" onClick={acquire}>Acquire Lock</button>
            : <button className="btn-danger" onClick={release}>Release Lock</button>}
          <span className="muted">operator: {match?.operator_id || 'none'} / me: {canWrite ? 'write' : 'read-only'}</span>
        </div>
      </div>

      <div className="split">
        <div className="grid">
          <div className="card grid">
            <h3>HLS Stream</h3>
            {hlsSrc ? <HlsPlayer src={hlsSrc} paused={playerPaused} /> : <div className="muted">No HLS URL configured</div>}
            <div className="grid" style={{ marginTop: 8 }}>
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
          </div>

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
                aspectRatio: '105 / 68',
                border: '1px solid #1f2937',
                borderRadius: 8,
                cursor: 'crosshair',
                background:
                  'repeating-linear-gradient(90deg, #3f7f3f 0 10%, #3a733a 10% 20%)',
              }}
            >
              <div style={{ position: 'absolute', inset: 0, border: '2px solid rgba(255,255,255,0.9)', borderRadius: 8 }} />
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.7)' }} />
              <div style={{ position: 'absolute', left: '50%', top: '50%', width: 64, height: 64, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.7)', transform: 'translate(-50%, -50%)' }} />
              <div style={{ position: 'absolute', left: '0%', top: '20.35%', width: '15.71%', height: '59.29%', border: '1px solid rgba(255,255,255,0.8)' }} />
              <div style={{ position: 'absolute', right: '0%', top: '20.35%', width: '15.71%', height: '59.29%', border: '1px solid rgba(255,255,255,0.8)' }} />
              <div style={{ position: 'absolute', left: '0%', top: '36.8%', width: '5.71%', height: '26.4%', border: '1px solid rgba(255,255,255,0.75)' }} />
              <div style={{ position: 'absolute', right: '0%', top: '36.8%', width: '5.71%', height: '26.4%', border: '1px solid rgba(255,255,255,0.75)' }} />
              <div style={{ position: 'absolute', left: '89.5%', top: '49%', width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', transform: 'translate(-50%, -50%)' }} />
              <div style={{ position: 'absolute', left: '10.5%', top: '49%', width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', transform: 'translate(-50%, -50%)' }} />
              {shotPoint ? (
                <div
                  style={{
                    position: 'absolute',
                    left: `${(shotPoint.x / 105) * 100}%`,
                    top: `${(shotPoint.y / 68) * 100}%`,
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: '#ef4444',
                    border: '2px solid white',
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              ) : null}
              <div style={{ position: 'absolute', left: 8, top: 6, color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: 600 }}>0m</div>
              <div style={{ position: 'absolute', right: 8, top: 6, color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: 600 }}>105m</div>
              <div style={{ position: 'absolute', left: 8, bottom: 6, color: 'rgba(255,255,255,0.75)', fontSize: 10 }}>y=0</div>
              <div style={{ position: 'absolute', left: 8, bottom: 20, color: 'rgba(255,255,255,0.75)', fontSize: 10 }}>y=68</div>
            </div>
            <div className="row" style={{ gap: 12 }}>
              <label><input type="checkbox" checked={isHeaderShot} onChange={(e) => setIsHeaderShot(e.target.checked)} /> Header</label>
              <label><input type="checkbox" checked={isWeakFootShot} onChange={(e) => setIsWeakFootShot(e.target.checked)} /> Weak Foot</label>
              <span className="muted">{shotPoint ? `shot=(${shotPoint.x}, ${shotPoint.y})` : 'Click pitch to set shot location'}</span>
            </div>
            {xgEstimateMeta ? <div className="muted">{xgEstimateMeta}</div> : null}
          </div>
        </div>

        <div className="grid">
          <div className="card grid">
            <h3>Timer</h3>
            <div className="row">
              <strong style={{ fontSize: 24 }}>{fmt(clockMs)}</strong>
              <button className={running ? 'btn-active' : ''} onClick={toggleRun} disabled={!canWrite}>Start/Pause <span className="kbd">Space</span></button>
              <button onClick={resetClock} disabled={!canWrite}>Reset <span className="kbd">R</span></button>
            </div>
          </div>

          <div className="card grid">
            <h3>Possession</h3>
            <div className="row">
              <span>Current:</span>
              <button className={possessionTeam === 'HOME' ? 'btn-active' : ''} onClick={() => changePossession('HOME')} disabled={!canWrite}>HOME <span className="kbd">Q</span></button>
              <button className={possessionTeam === 'AWAY' ? 'btn-active' : ''} onClick={() => changePossession('AWAY')} disabled={!canWrite}>AWAY <span className="kbd">W</span></button>
              <button className={possessionTeam === 'NONE' ? 'btn-active' : ''} onClick={() => changePossession('NONE')} disabled={!canWrite}>NONE</button>
              <span>{possessionTeam}</span>
            </div>
            <div className="row">
              <span>HOME {summary?.possession?.home_pct?.toFixed(1) || '0.0'}%</span>
              <span>AWAY {summary?.possession?.away_pct?.toFixed(1) || '0.0'}%</span>
            </div>
          </div>

          <div className="card grid">
            <h3>Possession Timeline Log</h3>
            <div className="row" style={{ marginBottom: 8 }}>
              <button onClick={downloadPossessionCsv} disabled={possessionLogs.length === 0}>Download CSV</button>
            </div>
            <div
              className="grid"
              style={{
                maxHeight: 220,
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

          <div className="card grid">
            <h3>Attack Direction Input (Event)</h3>
            <div className="row">
              <span>Team:</span>
              <button className={selectedTeam === 'HOME' ? 'btn-active' : ''} onClick={() => { setSelectedTeam('HOME'); setXgTeam('HOME'); saveState({ selectedTeam: 'HOME' }); }} disabled={!canWrite}>HOME <span className="kbd">1</span></button>
              <button className={selectedTeam === 'AWAY' ? 'btn-active' : ''} onClick={() => { setSelectedTeam('AWAY'); setXgTeam('AWAY'); saveState({ selectedTeam: 'AWAY' }); }} disabled={!canWrite}>AWAY <span className="kbd">2</span></button>
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
              <button className="btn-active" onClick={toggleAttack} disabled={!canWrite}>Attack LR: {attackLR}</button>
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
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="minute" />
              <YAxis domain={[-1, 1]} />
              <Tooltip />
              <ReferenceLine y={0} stroke="#6b7280" />
              <Area type="monotone" dataKey="dominance_pos" stroke="none" fill="#22c55e" fillOpacity={0.35} />
              <Area type="monotone" dataKey="dominance_neg" stroke="none" fill="#ef4444" fillOpacity={0.35} />
              <Line type="monotone" dataKey="dominance" stroke="#10b981" dot />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card">
        <h3>Recent Events</h3>
        <div className="grid">
          {(summary?.events || []).slice(0, 20).map((e: any) => (
            <div key={e.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{e.type} {e.team} @ {fmt(e.clock_ms)} {e.lane ? `lane=${e.lane}` : ''} {typeof e.xg === 'number' ? `xg=${e.xg}` : ''}</span>
              <span className="muted">{new Date(e.created_at).toLocaleTimeString()}</span>
            </div>
          ))}
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
