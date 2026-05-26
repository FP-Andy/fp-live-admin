'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { API_BASE, apiJson } from '../../../../../lib/api';
import type { BroadcastFullscreenGraphic, BroadcastGraphic, BroadcastSnapshot, BroadcastState } from '../../../../../components/live-coder/types';

const ANALYSIS_OPTIONS: Array<{ value: BroadcastGraphic; label: string }> = [
  { value: null, label: 'Clear Card' },
  { value: 'ATTACK_DIRECTION_HOME', label: 'Home Attack Direction' },
  { value: 'ATTACK_DIRECTION_AWAY', label: 'Away Attack Direction' },
  { value: 'XG', label: 'xG Shot Card' },
];

const FULLSCREEN_OPTIONS: Array<{ value: BroadcastFullscreenGraphic; label: string }> = [
  { value: null, label: 'Clear' },
  { value: 'MATCH_DOMINANCE', label: 'Dominance Fullscreen' },
  { value: 'HALFTIME', label: 'Halftime' },
  { value: 'FULLTIME', label: 'Fulltime' },
  { value: 'LINEUP', label: 'Lineup' },
];

function parseClockInput(value: string) {
  const parts = value.trim().split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 2) {
    return (parts[0] * 60 + parts[1]) * 1000;
  }
  if (parts.length === 3) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }
  return null;
}

function formatClock(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function localUrl(path: string) {
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path}`;
}

export default function LiveCoderMatchPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [snapshot, setSnapshot] = useState<BroadcastSnapshot | null>(null);
  const [status, setStatus] = useState('');
  const [clockInput, setClockInput] = useState('00:00');
  const [now, setNow] = useState(() => Date.now());
  const clockCapturedAtRef = useRef(Date.now());

  const overlayUrls = useMemo(() => ({
    scoreboard: localUrl(`/overlay/football/${id}/scoreboard`),
    cardAnalysis: localUrl(`/overlay/football/${id}/card-analysis`),
    possession: localUrl(`/overlay/football/${id}/possession`),
    fullscreen: localUrl(`/overlay/football/${id}/fullscreen`),
  }), [id]);

  const load = async () => {
    const data = await apiJson<BroadcastSnapshot>(`/broadcast/matches/${id}/snapshot`);
    setSnapshot(data);
  };

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const data = await apiJson<BroadcastSnapshot>(`/broadcast/matches/${id}/snapshot`);
        if (active) setSnapshot(data);
      } catch (error) {
        if (active) setStatus(error instanceof Error ? error.message : 'Snapshot unavailable');
      }
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    const capturedAt = Date.now();
    clockCapturedAtRef.current = capturedAt;
    setNow(capturedAt);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot?.match.id, snapshot?.match.clock_ms, snapshot?.match.running, snapshot?.updated_at]);

  const updateState = async (patch: Partial<BroadcastState>) => {
    if (!snapshot) return;
    const next = await apiJson<BroadcastState>(`/broadcast/matches/${id}/state`, {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    setSnapshot({ ...snapshot, broadcast_state: next });
    setStatus(`Updated ${new Date(next.updated_at).toLocaleTimeString('ko-KR', { hour12: false })}`);
    await load();
  };

  const updateClock = async (clock_action: 'start' | 'pause' | 'reset') => {
    await updateState({ clock_action } as Partial<BroadcastState>);
  };

  const setClock = async () => {
    const clock_ms = parseClockInput(clockInput);
    if (clock_ms == null) {
      setStatus('Clock format should be MM:SS or HH:MM:SS');
      return;
    }
    await updateState({ clock_ms } as Partial<BroadcastState>);
  };

  const copyUrl = async (url: string, label: string) => {
    await navigator.clipboard.writeText(url);
    setStatus(`${label} URL copied`);
  };

  const uploadLogo = async (team: 'HOME' | 'AWAY', file: File | null) => {
    if (!snapshot || !file) return;
    const body = new FormData();
    body.append('team', team);
    body.append('file', file);
    const response = await fetch(`${API_BASE}/broadcast/matches/${id}/logo`, {
      method: 'POST',
      credentials: 'include',
      body,
    });
    if (!response.ok) {
      setStatus(await response.text() || 'Logo upload failed');
      return;
    }
    const next = await response.json() as BroadcastState;
    setSnapshot({ ...snapshot, broadcast_state: next });
    setStatus(`${team} logo uploaded`);
    await load();
  };

  const uploadFullscreenImage = async (scene: 'LINEUP' | 'HALFTIME' | 'FULLTIME' | 'MATCH_DOMINANCE', file: File | null) => {
    if (!snapshot || !file) return;
    const body = new FormData();
    body.append('scene', scene);
    body.append('file', file);
    const response = await fetch(`${API_BASE}/broadcast/matches/${id}/fullscreen-image`, {
      method: 'POST',
      credentials: 'include',
      body,
    });
    if (!response.ok) {
      setStatus(await response.text() || 'Fullscreen image upload failed');
      return;
    }
    const next = await response.json() as BroadcastState;
    setSnapshot({ ...snapshot, broadcast_state: next });
    setStatus(`${scene} image uploaded`);
    await load();
  };

  const state = snapshot?.broadcast_state;
  const xgRows = snapshot?.analysis.xg || [];
  const displayClock = useMemo(() => {
    if (!snapshot) return '00:00';
    const baseMs = Number(snapshot.match.clock_ms || 0);
    if (!snapshot.match.running) return formatClock(baseMs);
    const elapsed = now - clockCapturedAtRef.current;
    return formatClock(baseMs + elapsed);
  }, [now, snapshot]);

  return (
    <main className="page-stack live-coder-page">
      <section className="card card-hero live-coder-hero">
        <div>
          <span className="status-pill tech">OBS Overlay Pack</span>
          <h2>{snapshot?.match.name || 'Live Coder'}</h2>
          <div className="live-coder-hero-urls">
            {Object.entries(overlayUrls).map(([label, url]) => (
              <div className="live-coder-hero-url" key={label}>
                <strong>{label}</strong>
                <span>{url}</span>
                <button className="button-compact btn-secondary" onClick={() => copyUrl(url, label)}>Copy</button>
              </div>
            ))}
          </div>
        </div>
        <div className="live-coder-score">
          <strong>{snapshot?.match.home.name || 'HOME'} {snapshot?.match.home.score ?? 0}</strong>
          <span>{displayClock}</span>
          <strong>{snapshot?.match.away.score ?? 0} {snapshot?.match.away.name || 'AWAY'}</strong>
        </div>
      </section>

      <section className="live-coder-grid">
        <div className="card card-panel">
          <div className="section-heading">
            <h3>Controls</h3>
            <span className="muted">seq {state?.sequence ?? 0}</span>
          </div>
          <div className="live-coder-clock-panel">
            <div>
              <span className="muted">Coder Clock</span>
              <strong>{displayClock}</strong>
              <span className="muted">FLA clock: {snapshot?.match.fla_clock || '00:00:00'}</span>
            </div>
            <div className="live-coder-clock-actions">
              <button
                className={state?.clock_running ? 'btn-secondary' : 'btn-success'}
                onClick={() => updateClock(state?.clock_running ? 'pause' : 'start')}
              >
                {state?.clock_running ? 'Pause' : 'Start'}
              </button>
              <button className="btn-ghost" onClick={() => updateClock('reset')}>Reset</button>
            </div>
            <div className="live-coder-clock-set">
              <input value={clockInput} onChange={(event) => setClockInput(event.target.value)} placeholder="MM:SS" />
              <button className="btn-secondary" onClick={setClock}>Set</button>
            </div>
          </div>

          <div className="live-coder-section live-coder-output-section">
            <div>
              <h4>Scoreboard</h4>
              <span className="muted">/scoreboard source</span>
            </div>
            <div>
              <div className="live-coder-control-grid compact">
                <button className={state?.scoreboard_visible ? 'btn-primary' : 'btn-ghost'} onClick={() => updateState({ scoreboard_visible: true })}>
                  Scoreboard On
                </button>
                <button className={!state?.scoreboard_visible ? 'btn-secondary' : 'btn-ghost'} onClick={() => updateState({ scoreboard_visible: false })}>
                  Scoreboard Off
                </button>
              </div>
              <div className="live-coder-scoreboard-grid">
                <label>
                  <span>Home name</span>
                  <input
                    key={`home-label-${state?.home_label || 'Home'}`}
                    defaultValue={state?.home_label || 'Home'}
                    onBlur={(event) => updateState({ home_label: event.target.value } as Partial<BroadcastState>)}
                  />
                </label>
                <label>
                  <span>Home score</span>
                  <input
                    key={`home-score-${snapshot?.match.home.score ?? 0}`}
                    type="number"
                    min={0}
                    defaultValue={snapshot?.match.home.score ?? 0}
                    onBlur={(event) => updateState({ home_score: Number(event.target.value || 0) } as Partial<BroadcastState>)}
                  />
                </label>
                <label className="color">
                  <span>Home uniform</span>
                  <input
                    type="color"
                    value={state?.home_color || '#ff7900'}
                    onChange={(event) => updateState({ home_color: event.target.value } as Partial<BroadcastState>)}
                  />
                </label>
                <label className="file">
                  <span>Home logo</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => uploadLogo('HOME', event.target.files?.[0] || null)}
                  />
                </label>
                <label>
                  <span>Away name</span>
                  <input
                    key={`away-label-${state?.away_label || 'Away'}`}
                    defaultValue={state?.away_label || 'Away'}
                    onBlur={(event) => updateState({ away_label: event.target.value } as Partial<BroadcastState>)}
                  />
                </label>
                <label>
                  <span>Away score</span>
                  <input
                    key={`away-score-${snapshot?.match.away.score ?? 0}`}
                    type="number"
                    min={0}
                    defaultValue={snapshot?.match.away.score ?? 0}
                    onBlur={(event) => updateState({ away_score: Number(event.target.value || 0) } as Partial<BroadcastState>)}
                  />
                </label>
                <label className="color">
                  <span>Away uniform</span>
                  <input
                    type="color"
                    value={state?.away_color || '#3d22f3'}
                    onChange={(event) => updateState({ away_color: event.target.value } as Partial<BroadcastState>)}
                  />
                </label>
                <label className="file">
                  <span>Away logo</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => uploadLogo('AWAY', event.target.files?.[0] || null)}
                  />
                </label>
              </div>
            </div>
            <iframe className="live-coder-inline-preview" title="scoreboard preview" src={`/overlay/football/${id}/scoreboard`} />
          </div>

          <div className="live-coder-section live-coder-output-section">
            <div>
              <h4>Card Analysis</h4>
              <span className="muted">/card-analysis source</span>
            </div>
            <div>
              <div className="live-coder-control-grid compact">
                {ANALYSIS_OPTIONS.map((item) => (
                  <button
                    key={item.value || 'clear'}
                    className={state?.active_graphic === item.value ? 'btn-primary' : 'btn-ghost'}
                    onClick={() => updateState({ active_graphic: item.value })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <label className="live-coder-select-row">
                <span>xG Map scene</span>
                <select
                  value={state?.selected_xg_event_id || ''}
                  onChange={(event) => updateState({ active_graphic: 'XG', selected_xg_event_id: event.target.value || null } as Partial<BroadcastState>)}
                >
                  <option value="">Latest xG event</option>
                  {xgRows.map((row, index) => (
                    <option key={row.event_id || index} value={row.event_id || ''}>
                      {row.event_clock || '--:--'} · {row.player_number ? `No.${row.player_number} ` : ''}{row.player_name || '선수 정보 없음'} · xG {Number(row.xg || 0).toFixed(2)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <iframe className="live-coder-inline-preview" title="card analysis preview" src={`/overlay/football/${id}/card-analysis`} />
          </div>

          <div className="live-coder-section live-coder-output-section">
            <div>
              <h4>Possession</h4>
              <span className="muted">/possession source</span>
            </div>
            <div className="live-coder-control-grid compact">
              <button className={state?.possession_visible ? 'btn-primary' : 'btn-ghost'} onClick={() => updateState({ possession_visible: true } as Partial<BroadcastState>)}>
                Possession On
              </button>
              <button className={!state?.possession_visible ? 'btn-secondary' : 'btn-ghost'} onClick={() => updateState({ possession_visible: false } as Partial<BroadcastState>)}>
                Clear Possession
              </button>
            </div>
            <iframe className="live-coder-inline-preview" title="possession preview" src={`/overlay/football/${id}/possession`} />
          </div>

          <div className="live-coder-section live-coder-output-section">
            <div>
              <h4>Fullscreen</h4>
              <span className="muted">/fullscreen source</span>
            </div>
            <div>
              <div className="live-coder-control-grid compact fullscreen-actions">
                {FULLSCREEN_OPTIONS.map((item) => (
                  <button
                    key={item.value || 'clear'}
                    className={state?.fullscreen_graphic === item.value ? 'btn-primary' : 'btn-ghost'}
                    onClick={() => updateState({ fullscreen_graphic: item.value })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="live-coder-fullscreen-upload-grid">
                {([
                  ['MATCH_DOMINANCE', 'Dominance bg'],
                  ['LINEUP', 'Lineup image'],
                  ['HALFTIME', 'Halftime image'],
                  ['FULLTIME', 'Fulltime image'],
                ] as const).map(([scene, label]) => (
                  <label className="live-coder-select-row" key={scene}>
                    <span>{label}</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) => uploadFullscreenImage(scene, event.target.files?.[0] || null)}
                    />
                  </label>
                ))}
              </div>
            </div>
            <iframe className="live-coder-inline-preview" title="fullscreen preview" src={`/overlay/football/${id}/fullscreen`} />
          </div>
          {status ? <p className="muted">{status}</p> : null}
        </div>

      </section>
    </main>
  );
}
