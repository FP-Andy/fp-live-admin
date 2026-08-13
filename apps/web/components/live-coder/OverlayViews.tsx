'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiJson } from '../../lib/api';
import type { BroadcastSnapshot } from './types';

type OverlayKind = 'scoreboard' | 'card-analysis' | 'analysis' | 'possession' | 'event' | 'fullscreen';
type CaptureGraphic = 'ATTACK_DIRECTION_HOME' | 'ATTACK_DIRECTION_AWAY' | 'XG' | 'POSSESSION' | 'MATCH_DOMINANCE';
type FadePhase = 'enter' | 'shown' | 'exit';
type FadedOverlay = {
  key: string;
  phase: FadePhase;
  snapshot: BroadcastSnapshot;
};

const OVERLAY_FADE_MS = 360;

function initials(name: string) {
  return (name || '?').replace(/\[[^\]]+\]/g, '').trim().slice(0, 3).toUpperCase();
}

function fmtPct(value: number | undefined) {
  return `${Math.round(Number(value || 0))}%`;
}

function fmtMinute(ms: number | undefined) {
  return `${Math.round(Number(ms || 0) / 60000)}`;
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

function latestXg(snapshot: BroadcastSnapshot) {
  const rows = snapshot.analysis.xg || [];
  return rows[rows.length - 1] || null;
}

function selectedXg(snapshot: BroadcastSnapshot) {
  const rows = snapshot.analysis.xg || [];
  const selectedId = snapshot.broadcast_state.selected_xg_event_id;
  return rows.find((row) => row.event_id === selectedId) || rows[rows.length - 1] || null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function starPoints(cx: number, cy: number, outerRadius = 42, innerRadius = 18) {
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    return `${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius}`;
  }).join(' ');
}

function dominanceX(itemsLength: number, index: number) {
  return itemsLength <= 1 ? 0 : (index / (itemsLength - 1)) * 1000;
}

function dominanceY(value: number | undefined) {
  return 260 - Math.max(-1, Math.min(1, Number(value || 0))) * 180;
}

function dominancePointAtTime(items: Array<{ dominance?: number; base_time_ms?: number }>, clockMs: number) {
  if (!items.length) return { x: 0, y: 260 };
  const firstMs = Number(items[0]?.base_time_ms || 0);
  const lastMs = Number(items[items.length - 1]?.base_time_ms ?? firstMs);
  const x = lastMs <= firstMs ? 0 : clamp(((clockMs - firstMs) / (lastMs - firstMs)) * 1000, 0, 1000);
  const nextIndex = items.findIndex((item) => Number(item.base_time_ms || 0) >= clockMs);
  if (nextIndex <= 0) return { x, y: dominanceY(items[0]?.dominance) };
  const prev = items[nextIndex - 1];
  const next = items[nextIndex];
  const prevMs = Number(prev.base_time_ms || 0);
  const nextMs = Number(next.base_time_ms || prevMs);
  const ratio = nextMs <= prevMs ? 0 : clamp((clockMs - prevMs) / (nextMs - prevMs), 0, 1);
  const prevValue = Number(prev.dominance || 0);
  const nextValue = Number(next.dominance || 0);
  return { x, y: dominanceY(prevValue + (nextValue - prevValue) * ratio) };
}

function smoothPath(items: Array<{ dominance?: number; base_time_ms?: number }> = []) {
  const points = items.map((item, index) => ({
    x: dominanceX(items.length, index),
    y: dominanceY(item.dominance),
  }));
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const prev = points[index - 1];
    const cx = (prev.x + point.x) / 2;
    return `${path} C ${cx} ${prev.y}, ${cx} ${point.y}, ${point.x} ${point.y}`;
  }, '');
}

function areaPath(items: Array<{ dominance?: number; base_time_ms?: number }> = []) {
  const line = smoothPath(items);
  if (!line) return '';
  return `${line} L 1000 260 L 0 260 Z`;
}

function teamLogo(url: string | null | undefined, name: string, className = '') {
  const value = String(url || '').trim();
  if (value) return <img className={className} src={value} alt={name} />;
  return <i className={className}>{initials(name)}</i>;
}

function useSnapshot(matchId: string, intervalMs = 3000, view?: string) {
  const [snapshot, setSnapshot] = useState<BroadcastSnapshot | null>(null);
  const lastGoodRef = useRef<BroadcastSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    const suffix = view ? `?view=${encodeURIComponent(view)}` : '';
    const load = async () => {
      try {
        const data = await apiJson<BroadcastSnapshot>(`/broadcast/matches/${matchId}/snapshot${suffix}`);
        if (!active) return;
        lastGoodRef.current = data;
        setSnapshot(data);
      } catch {
        if (active && lastGoodRef.current) setSnapshot(lastGoodRef.current);
      }
    };
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [matchId, intervalMs, view]);

  return snapshot;
}

function useDisplayClock(snapshot: BroadcastSnapshot | null) {
  const [now, setNow] = useState(() => Date.now());
  const capturedAtRef = useRef(Date.now());

  useEffect(() => {
    const capturedAt = Date.now();
    capturedAtRef.current = capturedAt;
    setNow(capturedAt);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot?.match.id, snapshot?.match.clock_ms, snapshot?.match.running, snapshot?.updated_at]);

  if (!snapshot) return '00:00';
  const baseMs = Number(snapshot.match.clock_ms || 0);
  if (!snapshot.match.running) return formatClock(baseMs);
  const elapsed = now - capturedAtRef.current;
  return formatClock(baseMs + elapsed);
}

function overlayDisplayKey(kind: OverlayKind, snapshot: BroadcastSnapshot) {
  const state = snapshot.broadcast_state;
  if (kind === 'scoreboard') return state.scoreboard_visible ? 'scoreboard' : null;
  if (kind === 'analysis' || kind === 'card-analysis') {
    if (!state.active_graphic) return null;
    return `${state.active_graphic}:${state.active_graphic === 'XG' ? state.selected_xg_event_id || 'latest' : ''}`;
  }
  if (kind === 'possession') return state.possession_visible ? 'possession' : null;
  if (kind === 'event') return state.event_graphic || null;
  if (kind === 'fullscreen') return state.fullscreen_graphic || null;
  return null;
}

function useFadedOverlay(snapshot: BroadcastSnapshot | null, displayKey: string | null) {
  const [display, setDisplay] = useState<FadedOverlay | null>(null);
  const displayRef = useRef<FadedOverlay | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  useEffect(() => {
    if (!snapshot) return;
    const current = displayRef.current;
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current);

    if (current?.key === displayKey) {
      setDisplay(displayKey ? { ...current, snapshot, phase: current.phase === 'exit' ? 'exit' : current.phase } : null);
      return;
    }

    const showNext = () => {
      if (!displayKey) {
        setDisplay(null);
        return;
      }
      setDisplay({ key: displayKey, snapshot, phase: 'enter' });
      enterTimerRef.current = setTimeout(() => {
        setDisplay((next) => (next?.key === displayKey ? { ...next, phase: 'shown' } : next));
      }, OVERLAY_FADE_MS);
    };

    if (current) {
      setDisplay({ ...current, phase: 'exit' });
      exitTimerRef.current = setTimeout(showNext, OVERLAY_FADE_MS);
      return;
    }

    showNext();
  }, [snapshot, displayKey]);

  useEffect(() => {
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
    };
  }, []);

  return display;
}

function Scoreboard({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const state = snapshot.broadcast_state;
  const isGoal = state.event_graphic === 'GOAL';
  const clock = useDisplayClock(snapshot);
  const homeColor = state.home_color || '#ff7900';
  const awayColor = state.away_color || '#3d22f3';
  const homeLabel = state.home_label || 'Home';
  const awayLabel = state.away_label || 'Away';
  const homeColorStyle = { '--team-color': homeColor } as CSSProperties;
  const awayColorStyle = { '--team-color': awayColor } as CSSProperties;
  if (!state.scoreboard_visible) return null;
  return (
    <div className={`lc-scorebug ${isGoal ? 'goal-flash' : ''}`}>
      <div className="lc-bug-brand">
        <img src="/live-coder/fineplay-logo.png" alt="Fine Play" />
      </div>
      <div className="lc-bug-teams">
        <div className="lc-bug-team" style={homeColorStyle}>
          <span>{teamLogo(state.home_logo_url, snapshot.match.home.name, 'lc-bug-team-logo')}<b>{homeLabel}</b></span>
          <strong>{snapshot.match.home.score}</strong>
          <em />
        </div>
        <div className="lc-bug-team" style={awayColorStyle}>
          <span>{teamLogo(state.away_logo_url, snapshot.match.away.name, 'lc-bug-team-logo')}<b>{awayLabel}</b></span>
          <strong>{snapshot.match.away.score}</strong>
          <em />
        </div>
      </div>
      <div className="lc-bug-clock">{clock}</div>
    </div>
  );
}

function AttackDirection({ snapshot, team }: { snapshot: BroadcastSnapshot; team: 'HOME' | 'AWAY' }) {
  const row = snapshot.analysis.attack_direction?.find((item) => item.team === team);
  const ratio = row?.direction_ratio || {};
  const state = snapshot.broadcast_state;
  const teamName = team === 'HOME' ? state.home_label || snapshot.match.home.name : state.away_label || snapshot.match.away.name;
  const logoUrl = team === 'HOME' ? state.home_logo_url : state.away_logo_url;
  const lanes = [
    { label: 'L', value: Number(ratio.left_pct || 0), x: 235 },
    { label: 'C', value: Number(ratio.center_pct || 0), x: 390 },
    { label: 'R', value: Number(ratio.right_pct || 0), x: 545 },
  ];
  const laneOrder = new Map([...lanes]
    .sort((left, right) => right.value - left.value)
    .map((lane, index) => [lane.label, index]));
  return (
    <div className="lc-analysis-card compact">
      <div className="lc-attack-head">
        <div className="lc-attack-team-logo">{teamLogo(logoUrl, teamName)}</div>
        <strong>{teamName}</strong>
        <span>공격 방향(%)</span>
      </div>
      <div className="lc-attack-visual">
        <svg className="lc-attack-pitch" viewBox="0 0 780 620" preserveAspectRatio="xMidYMid meet">
          <rect className="lc-attack-pitch-line" x="74" y="42" width="632" height="512" rx="18" />
          <line className="lc-attack-pitch-line" x1="74" x2="706" y1="298" y2="298" />
          <circle className="lc-attack-pitch-line" cx="390" cy="298" r="74" />
          <rect className="lc-attack-pitch-line" x="222" y="42" width="336" height="116" rx="14" />
          <rect className="lc-attack-pitch-line" x="292" y="42" width="196" height="52" rx="10" />
          <rect className="lc-attack-pitch-line" x="222" y="438" width="336" height="116" rx="14" />
          <rect className="lc-attack-pitch-line" x="292" y="502" width="196" height="52" rx="10" />
          {lanes.map((lane) => {
            const length = 160 + clamp(lane.value, 0, 100) * 2.42;
            const strokeWidth = 16 + clamp(lane.value, 0, 100) * 0.42;
            const y2 = 496 - length;
            return (
              <g className="lc-attack-lane" key={lane.label} style={{ animationDelay: `${Number(laneOrder.get(lane.label) || 0) * 180}ms` }}>
                <line x1={lane.x} x2={lane.x} y1="496" y2={y2} strokeWidth={strokeWidth} />
                <path d={`M ${lane.x - strokeWidth * 0.72} ${y2 + strokeWidth * 0.75} L ${lane.x} ${y2 - strokeWidth * 0.9} L ${lane.x + strokeWidth * 0.72} ${y2 + strokeWidth * 0.75}`} strokeWidth={Math.max(10, strokeWidth * 0.45)} />
              </g>
            );
          })}
        </svg>
        <div className="lc-attack-percent-row">
          {lanes.map((lane) => <strong key={lane.label}>{fmtPct(lane.value)}</strong>)}
        </div>
      </div>
      <div className="lc-attack-brand">
        <img src="/live-coder/fineplay-logo.png" alt="Fine Play" />
      </div>
    </div>
  );
}

function XgCard({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const row = selectedXg(snapshot);
  const shotX = Number(row?.shot_x ?? 88);
  const shotY = Number(row?.shot_y ?? 34);
  const goalmouthX = Number(row?.goalmouth_x ?? 0.5);
  const goalmouthY = Number(row?.goalmouth_y ?? 0.5);
  const pitchWidthM = 68;
  const attackingZoneLengthM = 40;
  const penaltyBoxWidthM = 40.32;
  const penaltyBoxDepthM = 16.5;
  const pitch = { x: 70, y: 230, width: 860, height: 860 * (attackingZoneLengthM / pitchWidthM) };
  const pitchScale = pitch.width / pitchWidthM;
  const box = {
    x: pitch.x + ((pitchWidthM - penaltyBoxWidthM) / 2) * pitchScale,
    y: pitch.y,
    width: penaltyBoxWidthM * pitchScale,
    height: penaltyBoxDepthM * pitchScale,
  };
  const goal = { x: 350, y: 54, width: 300, height: 176 };
  const shotPoint = {
    x: pitch.x + clamp(shotY / 68, 0, 1) * pitch.width,
    y: pitch.y + clamp((105 - shotX) / attackingZoneLengthM, 0, 1) * pitch.height,
  };
  const targetPoint = {
    x: goal.x + clamp(goalmouthX, 0, 1) * goal.width,
    y: goal.y + clamp(1 - goalmouthY, 0, 1) * goal.height,
  };
  const playerLabel = row?.player_number ? `No.${row.player_number}` : 'No.--';
  return (
    <div className="lc-xg-map-card">
      <div className="lc-xg-map-head">
        <strong>xG Map</strong>
        <img src="/live-coder/fineplay-logo.png" alt="Fine Play" />
      </div>
      <svg className="lc-xg-map-pitch" viewBox="0 0 1000 760" preserveAspectRatio="xMidYMid meet">
        <rect className="lc-xg-pitch-line" x={pitch.x} y={pitch.y} width={pitch.width} height={pitch.height} rx="24" />
        <rect className="lc-xg-pitch-line" x={box.x} y={box.y} width={box.width} height={box.height} rx="22" />
        <path className="lc-xg-pitch-line" d={`M ${goal.x} ${pitch.y} V ${goal.y + 24} Q ${goal.x} ${goal.y} ${goal.x + 24} ${goal.y} H ${goal.x + goal.width - 24} Q ${goal.x + goal.width} ${goal.y} ${goal.x + goal.width} ${goal.y + 24} V ${pitch.y}`} />
        <circle className="lc-xg-shot-dot" cx={shotPoint.x} cy={shotPoint.y} r="34" />
        <line className="lc-xg-shot-line" x1={shotPoint.x} y1={shotPoint.y} x2={targetPoint.x} y2={targetPoint.y} />
        <polygon className="lc-xg-goal-star" points={starPoints(targetPoint.x, targetPoint.y)} />
      </svg>
      <div className="lc-xg-map-bottom">
        <div>
          <strong>{playerLabel}</strong>
          <span>{row?.player_name || '선수 정보 없음'}</span>
        </div>
        <div>
          <strong>골 기대값</strong>
          <span>{Number(row?.xg || 0).toFixed(2)}골</span>
        </div>
      </div>
    </div>
  );
}

function Possession({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const home = Number(snapshot.analysis.possession?.home_pct || 0);
  const away = Number(snapshot.analysis.possession?.away_pct || 0);
  const homeColor = snapshot.broadcast_state.home_color || '#ff7417';
  const awayColor = snapshot.broadcast_state.away_color || '#3d22f3';
  return (
    <div className="lc-possession">
      <div className="lc-team-crest">{teamLogo(snapshot.broadcast_state.home_logo_url, snapshot.match.home.name)}</div>
      <div className="lc-possession-core">
        <div className="lc-possession-title">볼 점유율(%)</div>
        <div className="lc-possession-bar">
          <span className="home" style={{ width: `${Math.max(0, Math.min(100, home))}%`, backgroundColor: homeColor }} />
          <span className="away" style={{ width: `${Math.max(0, Math.min(100, away))}%`, backgroundColor: awayColor }} />
          <strong className="home-pct">{fmtPct(home)}</strong>
          <strong className="away-pct">{fmtPct(away)}</strong>
        </div>
        <div className="lc-possession-brand">
          <img src="/live-coder/fineplay-logo.png" alt="Fine Play" />
        </div>
      </div>
      <div className="lc-team-crest away">{teamLogo(snapshot.broadcast_state.away_logo_url, snapshot.match.away.name)}</div>
    </div>
  );
}

function Dominance({ snapshot, fullscreen = false }: { snapshot: BroadcastSnapshot; fullscreen?: boolean }) {
  const items = snapshot.analysis.match_dominance?.items || [];
  const path = useMemo(() => smoothPath(items), [items]);
  const fill = useMemo(() => areaPath(items), [items]);
  const ticks = useMemo(() => items.map((item, index) => ({
    x: dominanceX(items.length, index),
    label: fmtMinute(item.base_time_ms),
  })), [items]);
  const goalMarkers = useMemo(() => (snapshot.analysis.xg || []).filter((row) => row.is_goal).map((row) => {
    const point = dominancePointAtTime(items, Number(row.event_clock_ms || 0));
    return {
      x: point.x,
      y: point.y,
      team: row.team === 'AWAY' ? 'away' : 'home',
    };
  }), [items, snapshot.analysis.xg]);
  const bgUrl = snapshot.broadcast_state.fullscreen_image_urls?.MATCH_DOMINANCE;
  const homeLabel = snapshot.broadcast_state.home_label || snapshot.match.home.name;
  const awayLabel = snapshot.broadcast_state.away_label || snapshot.match.away.name;
  const style = {
    '--home-color': snapshot.broadcast_state.home_color || '#ff7900',
    '--away-color': snapshot.broadcast_state.away_color || '#3d22f3',
    '--dominance-bg': bgUrl ? `url(${bgUrl})` : 'none',
  } as CSSProperties;
  return (
    <div className={`lc-dominance ${fullscreen ? 'fullscreen' : ''}`} style={style}>
      <div className="lc-dominance-header">
        <span>{homeLabel} vs {awayLabel}</span>
        <strong>매치 도미넌스</strong>
      </div>
      <div className="lc-dominance-body">
        <div className="lc-dominance-logos">
          <div>{teamLogo(snapshot.broadcast_state.home_logo_url, snapshot.match.home.name)}</div>
          <div>{teamLogo(snapshot.broadcast_state.away_logo_url, snapshot.match.away.name)}</div>
        </div>
        <svg viewBox="0 0 1000 520" preserveAspectRatio="none">
          <defs>
            <clipPath id="lc-dom-top">
              <rect x="0" y="0" width="1000" height="260" />
            </clipPath>
            <clipPath id="lc-dom-bottom">
              <rect x="0" y="260" width="1000" height="260" />
            </clipPath>
          </defs>
          <path d={fill} className="lc-dom-fill home" clipPath="url(#lc-dom-top)" />
          <path d={fill} className="lc-dom-fill away" clipPath="url(#lc-dom-bottom)" />
          <line x1="0" x2="1000" y1="260" y2="260" className="lc-dom-mid" />
          <path d={path} className="lc-dom-line" />
          {goalMarkers.map((marker, index) => (
            <g className={`lc-dom-goal-marker ${marker.team}`} key={`${marker.x}-${marker.y}-${index}`}>
              <line x1={marker.x} x2={marker.x} y1={marker.y} y2={marker.team === 'home' ? 42 : 478} />
              <text x={marker.x} y={marker.team === 'home' ? 54 : 490} textAnchor="middle">⚽</text>
            </g>
          ))}
          {ticks.map((tick, index) => (
            <g className="lc-dom-tick" key={`${tick.label}-${index}`}>
              <line x1={tick.x} x2={tick.x} y1="484" y2="498" />
              <text x={tick.x} y="516" textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}>
                {tick.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="lc-dominance-brand">
        <img src="/live-coder/fineplay-logo.png" alt="Fine Play" />
      </div>
    </div>
  );
}

function Analysis({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const graphic = snapshot.broadcast_state.active_graphic;
  if (graphic === 'ATTACK_DIRECTION_HOME') return <AttackDirection snapshot={snapshot} team="HOME" />;
  if (graphic === 'ATTACK_DIRECTION_AWAY') return <AttackDirection snapshot={snapshot} team="AWAY" />;
  if (graphic === 'XG') return <XgCard snapshot={snapshot} />;
  return null;
}

function EventGraphic({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const event = snapshot.broadcast_state.event_graphic;
  if (!event) return null;
  const labels: Record<string, string> = {
    GOAL: 'GOAL',
    YELLOW_CARD: 'YELLOW CARD',
    RED_CARD: 'RED CARD',
    SUBSTITUTION: 'SUBSTITUTION',
  };
  return (
    <div className={`lc-event-graphic ${event.toLowerCase()}`}>
      <span>{labels[event]}</span>
      <strong>{snapshot.match.home.score} - {snapshot.match.away.score}</strong>
      <em>{snapshot.match.home.name} vs {snapshot.match.away.name}</em>
    </div>
  );
}

function Fullscreen({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const graphic = snapshot.broadcast_state.fullscreen_graphic;
  if (graphic === 'MATCH_DOMINANCE') {
    return <Dominance snapshot={snapshot} fullscreen />;
  }
  if (!graphic) return null;
  const imageUrl = snapshot.broadcast_state.fullscreen_image_urls?.[graphic];
  if (imageUrl) {
    return (
      <div className="lc-fullscreen-image">
        <img src={imageUrl} alt={graphic} />
      </div>
    );
  }
  return (
    <div className="lc-fullscreen-card">
      <span>{graphic}</span>
      <strong>{snapshot.match.home.name} {snapshot.match.home.score} - {snapshot.match.away.score} {snapshot.match.away.name}</strong>
      <div className="lc-card-brand">Fine Play</div>
    </div>
  );
}

export default function OverlayView({ matchId, kind }: { matchId: string; kind: OverlayKind }) {
  const searchParams = useSearchParams();
  const snapshot = useSnapshot(matchId, kind === 'scoreboard' ? 1000 : 3000, kind === 'scoreboard' ? 'scoreboard' : undefined);
  const [scale, setScale] = useState(1);
  const requestedGraphic = searchParams.get('render') as CaptureGraphic | null;
  const allowedGraphic = requestedGraphic && (
    ((kind === 'analysis' || kind === 'card-analysis') && ['ATTACK_DIRECTION_HOME', 'ATTACK_DIRECTION_AWAY', 'XG'].includes(requestedGraphic)) ||
    (kind === 'possession' && requestedGraphic === 'POSSESSION') ||
    (kind === 'fullscreen' && requestedGraphic === 'MATCH_DOMINANCE')
  ) ? requestedGraphic : null;
  const renderedSnapshot = useMemo(() => {
    if (!snapshot || !allowedGraphic) return snapshot;
    const state = { ...snapshot.broadcast_state };
    if (allowedGraphic === 'POSSESSION') state.possession_visible = true;
    if (allowedGraphic === 'MATCH_DOMINANCE') state.fullscreen_graphic = 'MATCH_DOMINANCE';
    if (['ATTACK_DIRECTION_HOME', 'ATTACK_DIRECTION_AWAY', 'XG'].includes(allowedGraphic)) {
      state.active_graphic = allowedGraphic as BroadcastSnapshot['broadcast_state']['active_graphic'];
    }
    return { ...snapshot, broadcast_state: state };
  }, [allowedGraphic, snapshot]);
  const displayKey = renderedSnapshot ? overlayDisplayKey(kind, renderedSnapshot) : null;
  const faded = useFadedOverlay(renderedSnapshot, displayKey);

  useEffect(() => {
    document.documentElement.classList.add('live-coder-overlay-document');
    document.body.classList.add('live-coder-overlay-body');
    return () => {
      document.documentElement.classList.remove('live-coder-overlay-document');
      document.body.classList.remove('live-coder-overlay-body');
    };
  }, []);

  useEffect(() => {
    const resize = () => {
      const nextScale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
      setScale(Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  if (!snapshot) return null;
  return (
    <main className="lc-overlay-root" data-live-coder-capture-ready={faded ? 'true' : undefined} style={{ transform: `scale(${scale})` }}>
      {faded ? (
        <div className={`lc-fade-slot ${faded.phase}`}>
          {kind === 'scoreboard' ? <Scoreboard snapshot={faded.snapshot} /> : null}
          {kind === 'analysis' || kind === 'card-analysis' ? <Analysis snapshot={faded.snapshot} /> : null}
          {kind === 'possession' ? <Possession snapshot={faded.snapshot} /> : null}
          {kind === 'event' ? <EventGraphic snapshot={faded.snapshot} /> : null}
          {kind === 'fullscreen' ? <Fullscreen snapshot={faded.snapshot} /> : null}
        </div>
      ) : null}
    </main>
  );
}
