'use client';

import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '../../../../lib/api';

type TeamSide = 'home' | 'away';
type DotTeam = 'ally' | 'opponent';

type Match = {
  id: string;
  name: string;
  competition_class: string;
  round_number: number;
  archived: boolean;
  created_at: string;
  metadata?: {
    home_team?: string;
    away_team?: string;
  } | null;
};

type ReplayMatch = Match & {
  savedLogs: SavedLogsResponse;
  sceneCount: number;
};

type SavedLogsResponse = {
  match_id: string;
  logs: string[];
  rows: Array<Record<string, string>>;
  teamid_h: string;
  teamid_a: string;
  updated_at?: string | null;
};

type PitchDot = {
  id?: string;
  meter_x: number;
  meter_y: number;
  team?: DotTeam;
  teamSide?: TeamSide;
  team_side?: TeamSide;
  role?: string;
  number?: string;
};

type PassArrow = {
  side?: 'before' | 'after';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type ReplayDot = {
  key: string;
  label: string;
  teamSide: TeamSide | undefined;
  role: string | undefined;
  from: PitchDot;
  to: PitchDot;
};

type PassSegment = {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type MetricKey = 'xG' | 'xGOT' | 'EPV' | 'PC';

type ReplayScene = {
  index: number;
  title: string;
  logs: string[];
  rows: Array<Record<string, string>>;
  actorTeam?: TeamSide;
  beforeDots: PitchDot[];
  afterDots: PitchDot[];
  dots: ReplayDot[];
  passes: PassSegment[];
};

type MotionStyle = CSSProperties & {
  '--from-left': string;
  '--from-top': string;
  '--to-left': string;
  '--to-top': string;
  '--delay'?: string;
};

type MotionGridStyle = CSSProperties & {
  '--fpa-replay-pitch-height'?: string;
};

const FIELD_W = 105;
const FIELD_H = 68;
const METRIC_KEYS: MetricKey[] = ['xG', 'xGOT', 'EPV', 'PC'];

function parseMatchTeams(match: Match) {
  const metadataHome = match.metadata?.home_team?.trim();
  const metadataAway = match.metadata?.away_team?.trim();
  if (metadataHome && metadataAway) return { home: metadataHome, away: metadataAway };
  const cleaned = match.name.replace(/^\[[^\]]+\]\s*/, '');
  const [home, away] = cleaned.split(/\s+vs\s+/i).map((part) => part.trim());
  return { home: home || 'Home', away: away || 'Away' };
}

function percentX(dot: PitchDot) {
  return (dot.meter_x / 105) * 100;
}

function percentY(dot: PitchDot) {
  return (1 - dot.meter_y / 68) * 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeDot(raw: unknown): PitchDot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const meterX = Number(value.meter_x ?? value.x);
  const meterY = Number(value.meter_y ?? value.y);
  if (!Number.isFinite(meterX) || !Number.isFinite(meterY)) return null;
  const teamSide = value.teamSide === 'home' || value.teamSide === 'away'
    ? value.teamSide
    : value.team_side === 'home' || value.team_side === 'away'
      ? value.team_side
      : undefined;
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    meter_x: Math.max(0, Math.min(105, meterX)),
    meter_y: Math.max(0, Math.min(68, meterY)),
    team: value.team === 'opponent' ? 'opponent' : 'ally',
    teamSide,
    team_side: teamSide,
    role: typeof value.role === 'string' ? value.role : undefined,
    number: typeof value.number === 'string' ? value.number : undefined,
  };
}

function parseJsonObject(raw: string | undefined) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseDualStateFromLog(logText: string | undefined) {
  if (!logText) return null;
  const marker = 'DualState: ';
  const start = logText.indexOf(marker);
  if (start < 0) return null;
  return parseJsonObject(logText.slice(start + marker.length));
}

function parseDots(raw: unknown) {
  return Array.isArray(raw) ? raw.map(normalizeDot).filter((dot): dot is PitchDot => Boolean(dot)) : [];
}

function passArrowToSegment(arrow: PassArrow, index: number): PassSegment {
  return {
    key: `arrow-${arrow.side || 'scene'}-${index}-${arrow.x1}-${arrow.y1}`,
    x1: arrow.x1,
    y1: arrow.y1,
    x2: arrow.x2,
    y2: arrow.y2,
  };
}

function parsePathPoints(value: string | undefined) {
  if (!value) return [];
  return value
    .split(';')
    .map((pair) => pair.split(',').map((part) => Number(part.trim())))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite))
    .map(([x, y]) => ({ meter_x: x, meter_y: y } as PitchDot));
}

function pathToSegment(row: Record<string, string>, logText: string | undefined, index: number): PassSegment | null {
  const fromRow = parsePathPoints(row.PathPoints);
  const fromLog = !fromRow.length ? parsePathPoints(logText?.match(/Path\(([^)]+)\)/)?.[1]) : [];
  const points = fromRow.length ? fromRow : fromLog;
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  return {
    key: `path-${index}-${start.meter_x}-${end.meter_x}`,
    x1: (start.meter_x / 105) * 1050,
    y1: (1 - start.meter_y / 68) * 680,
    x2: (end.meter_x / 105) * 1050,
    y2: (1 - end.meter_y / 68) * 680,
  };
}

function findTargetDot(before: PitchDot, beforeIndex: number, afterDots: PitchDot[], used: Set<number>) {
  const candidates = [
    (dot: PitchDot) => before.id && dot.id === before.id,
    (dot: PitchDot) => before.number && dot.number === before.number && dot.teamSide === before.teamSide,
    (dot: PitchDot) => before.number && dot.number === before.number,
    (_dot: PitchDot, index: number) => index === beforeIndex,
  ];
  for (const predicate of candidates) {
    const index = afterDots.findIndex((dot, dotIndex) => !used.has(dotIndex) && predicate(dot, dotIndex));
    if (index >= 0) {
      used.add(index);
      return afterDots[index];
    }
  }
  return before;
}

function buildReplayDots(beforeDots: PitchDot[], afterDots: PitchDot[]) {
  const usedAfter = new Set<number>();
  const dots = beforeDots.map((before, index) => {
    const target = findTargetDot(before, index, afterDots, usedAfter);
    const label = before.number || target.number || `${before.teamSide === 'away' ? 'A' : 'H'}${index + 1}`;
    return {
      key: before.id || `${label}-${index}`,
      label,
      teamSide: before.teamSide || target.teamSide,
      role: before.role || target.role,
      from: before,
      to: target,
    };
  });
  afterDots.forEach((dot, index) => {
    if (usedAfter.has(index)) return;
    const label = dot.number || `${dot.teamSide === 'away' ? 'A' : 'H'}${index + 1}`;
    dots.push({
      key: dot.id || `after-${label}-${index}`,
      label,
      teamSide: dot.teamSide,
      role: dot.role,
      from: dot,
      to: dot,
    });
  });
  return dots;
}

function sceneFromState(
  state: Record<string, unknown>,
  rows: Array<Record<string, string>>,
  logs: string[],
  sceneIndex: number,
): ReplayScene | null {
  const beforeDots = parseDots(state.beforeDots || state.before);
  const afterDots = parseDots(state.afterDots || state.after);
  if (!beforeDots.length && !afterDots.length) return null;
  const actorTeam = state.actor_team === 'home' || state.actor_team === 'away' ? state.actor_team : undefined;
  const rawArrows = Array.isArray(state.passArrows) ? state.passArrows : [];
  const arrowSegments = rawArrows
    .filter((arrow): arrow is PassArrow => Boolean(arrow) && typeof arrow === 'object' && Number.isFinite(Number((arrow as PassArrow).x1)))
    .map(passArrowToSegment);
  const pathSegments = rows
    .map((row, rowIndex) => pathToSegment(row, logs[rowIndex], rowIndex))
    .filter((segment): segment is PassSegment => Boolean(segment));
  const passes = arrowSegments.length ? arrowSegments : pathSegments;
  return {
    index: sceneIndex,
    title: `Scene ${sceneIndex + 1}`,
    logs,
    rows,
    actorTeam,
    beforeDots,
    afterDots,
    dots: buildReplayDots(beforeDots, afterDots),
    passes,
  };
}

function buildReplayScenes(rows: Array<Record<string, string>>, logs: string[]) {
  const groups = new Map<string, { rows: Array<Record<string, string>>; logs: string[]; state: Record<string, unknown> | null }>();
  rows.forEach((row, index) => {
    if (!row.SceneIndex) return;
    const current = groups.get(row.SceneIndex) || { rows: [], logs: [], state: null };
    current.rows.push(row);
    current.logs.push(logs[index] || '');
    current.state = current.state || parseJsonObject(row.SceneState);
    groups.set(row.SceneIndex, current);
  });
  const persistedScenes = Array.from(groups.entries())
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, group], index) => group.state ? sceneFromState(group.state, group.rows, group.logs, index) : null)
    .filter((scene): scene is ReplayScene => Boolean(scene));
  if (persistedScenes.length) return persistedScenes;

  return rows
    .map((row, index) => {
      const state = parseJsonObject(row.DualState) || parseDualStateFromLog(logs[index]);
      return state ? sceneFromState(state, [row], [logs[index] || ''], index) : null;
    })
    .filter((scene): scene is ReplayScene => Boolean(scene));
}

function motionStyle(from: PitchDot, to: PitchDot, delay = 0): MotionStyle {
  return {
    '--from-left': `${percentX(from)}%`,
    '--from-top': `${percentY(from)}%`,
    '--to-left': `${percentX(to)}%`,
    '--to-top': `${percentY(to)}%`,
    '--delay': `${delay}s`,
  };
}

function passStyle(segment: PassSegment): MotionStyle {
  return {
    '--from-left': `${(segment.x1 / 1050) * 100}%`,
    '--from-top': `${(segment.y1 / 680) * 100}%`,
    '--to-left': `${(segment.x2 / 1050) * 100}%`,
    '--to-top': `${(segment.y2 / 680) * 100}%`,
  };
}

function parseLogPositions(logText: string | undefined) {
  if (!logText) return [];
  return [...logText.matchAll(/Pos\(([^,]+),\s*([^)]+)\)/g)]
    .map((match) => ({ meter_x: Number(match[1]), meter_y: Number(match[2]) }))
    .filter((point) => Number.isFinite(point.meter_x) && Number.isFinite(point.meter_y));
}

function parseLogDirection(logText: string | undefined) {
  const parts = logText?.split(' | ') || [];
  return parts[2]?.trim().toLowerCase() === 'left' ? 'left' : 'right';
}

function metricFromRowOrLog(row: Record<string, string>, logText: string | undefined, key: MetricKey) {
  const rowValue = row[key]?.trim();
  if (rowValue) return rowValue;
  const match = logText?.match(new RegExp(`${key}=([^,|]+)`));
  return match?.[1]?.trim() || '';
}

function numberMetricValue(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function segmentToMeter(segment: PassSegment | undefined) {
  if (!segment) return null;
  return {
    start: { meter_x: clamp((segment.x1 / 1050) * FIELD_W, 0, FIELD_W), meter_y: clamp((1 - segment.y1 / 680) * FIELD_H, 0, FIELD_H) },
    end: { meter_x: clamp((segment.x2 / 1050) * FIELD_W, 0, FIELD_W), meter_y: clamp((1 - segment.y2 / 680) * FIELD_H, 0, FIELD_H) },
  };
}

function actionMeterSegment(scene: ReplayScene, row: Record<string, string>, rowIndex: number) {
  const logPositions = parseLogPositions(scene.logs[rowIndex]);
  if (logPositions.length >= 2) return { start: logPositions[0], end: logPositions[1] };
  const pathPoints = parsePathPoints(row.PathPoints);
  if (pathPoints.length >= 2) return { start: pathPoints[0], end: pathPoints[pathPoints.length - 1] };
  const fromPass = segmentToMeter(scene.passes[rowIndex] || scene.passes[0]);
  if (fromPass) return fromPass;
  if (logPositions.length === 1) return { start: logPositions[0], end: logPositions[0] };
  return null;
}

function epvStateValue(x: number, y: number) {
  const progress = clamp(x / FIELD_W, 0, 1);
  const centrality = Math.max(0, 1 - Math.abs(y - FIELD_H / 2) / (FIELD_H / 2));
  const boxBoost = x >= 88.5 && y > 13.84 && y < 54.16 ? 0.012 : 0;
  return Math.min(0.085, 0.006 + 0.011 * progress + 0.038 * (progress ** 2.35) * (0.45 + 0.55 * centrality) + boxBoost);
}

function estimateEpvDelta(scene: ReplayScene, row: Record<string, string>, rowIndex: number) {
  const segment = actionMeterSegment(scene, row, rowIndex);
  if (!segment) return null;
  const direction = parseLogDirection(scene.logs[rowIndex]);
  const startX = direction === 'left' ? FIELD_W - segment.start.meter_x : segment.start.meter_x;
  const endX = direction === 'left' ? FIELD_W - segment.end.meter_x : segment.end.meter_x;
  return epvStateValue(endX, segment.end.meter_y) - epvStateValue(startX, segment.start.meter_y);
}

function teamSideForDot(dot: PitchDot, actorTeam?: TeamSide) {
  if (dot.teamSide === 'home' || dot.teamSide === 'away') return dot.teamSide;
  if (actorTeam && dot.team === 'ally') return actorTeam;
  if (actorTeam === 'home' && dot.team === 'opponent') return 'away';
  if (actorTeam === 'away' && dot.team === 'opponent') return 'home';
  return undefined;
}

function splitTeamPoints(points: PitchDot[], actorTeam?: TeamSide) {
  return points.reduce<{ home: PitchDot[]; away: PitchDot[] }>((acc, dot) => {
    const side = teamSideForDot(dot, actorTeam);
    if (side === 'home') acc.home.push(dot);
    if (side === 'away') acc.away.push(dot);
    return acc;
  }, { home: [], away: [] });
}

function pitchControlAt(point: PitchDot, homePoints: PitchDot[], awayPoints: PitchDot[]) {
  if (!homePoints.length || !awayPoints.length) return null;
  const reactionTime = 0.7;
  const sharedPlayerSpeed = 5.5;
  const tau = 1.15;
  const teamControl = (points: PitchDot[]) => points.reduce((total, dot) => {
    const distance = Math.hypot(point.meter_x - dot.meter_x, point.meter_y - dot.meter_y);
    const arrivalTime = reactionTime + distance / sharedPlayerSpeed;
    return total + Math.exp(-arrivalTime / tau);
  }, 0);
  const homeControl = teamControl(homePoints);
  const awayControl = teamControl(awayPoints);
  const denominator = homeControl + awayControl;
  if (denominator <= 0) return null;
  return ((homeControl / denominator) * 2) - 1;
}

function estimatePitchControlDelta(scene: ReplayScene, row: Record<string, string>, rowIndex: number) {
  const segment = actionMeterSegment(scene, row, rowIndex);
  if (!segment) return null;
  const before = splitTeamPoints(scene.beforeDots, scene.actorTeam);
  const afterSource = scene.afterDots.length ? scene.afterDots : scene.beforeDots;
  const after = splitTeamPoints(afterSource, scene.actorTeam);
  const beforePc = pitchControlAt(segment.start, before.home, before.away);
  const afterPc = pitchControlAt(segment.end, after.home, after.away);
  if (beforePc === null || afterPc === null) return null;
  return afterPc - beforePc;
}

function isPressRow(row: Record<string, string>) {
  return (row.Action || '').trim().toLowerCase() === 'press';
}

function actionMetricValue(scene: ReplayScene, row: Record<string, string>, rowIndex: number, key: MetricKey) {
  const persisted = numberMetricValue(metricFromRowOrLog(row, scene.logs[rowIndex], key));
  if (persisted !== null) return persisted;
  // 압박(Press)은 PC만 의미가 있어 EPV 는 (추정도) 내지 않는다 — 서버 채점과 동일하게 맞춘다.
  if (isPressRow(row)) {
    return key === 'PC' ? estimatePitchControlDelta(scene, row, rowIndex) : null;
  }
  if (key === 'EPV') return estimateEpvDelta(scene, row, rowIndex);
  if (key === 'PC') return estimatePitchControlDelta(scene, row, rowIndex);
  return null;
}

function formatMetricValue(value: number | null, key: MetricKey) {
  if (value === null || !Number.isFinite(value)) return '-';
  const fixed = Math.abs(value) < 0.0005 ? '0.000' : value.toFixed(3);
  if ((key === 'EPV' || key === 'PC') && value > 0) return `+${fixed}`;
  return fixed;
}

function sceneMetricTotal(scene: ReplayScene, key: MetricKey) {
  let hasValue = false;
  const total = scene.rows.reduce((sum, row, rowIndex) => {
    const value = actionMetricValue(scene, row, rowIndex, key);
    if (value === null) return sum;
    hasValue = true;
    return sum + value;
  }, 0);
  return hasValue ? total : null;
}

function actionLabel(row: Record<string, string>) {
  const player = row.Player || '-';
  const receiver = row.Receiver ? ` → ${row.Receiver}` : '';
  return `${player} ${row.Action || 'Action'}${receiver}`;
}

export default function FpaReplayPage() {
  const [matches, setMatches] = useState<ReplayMatch[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<ReplayMatch | null>(null);
  const [savedLogs, setSavedLogs] = useState<SavedLogsResponse | null>(null);
  const [selectedSceneIndex, setSelectedSceneIndex] = useState(0);
  const [replayTick, setReplayTick] = useState(0);
  const [status, setStatus] = useState('경기를 선택하세요');
  const [busy, setBusy] = useState(false);
  const pitchRef = useRef<HTMLDivElement | null>(null);
  const [pitchHeight, setPitchHeight] = useState(0);

  useEffect(() => {
    let active = true;
    const loadReplayMatches = async () => {
      setBusy(true);
      setStatus('듀얼모드 FPA 데이터가 있는 경기만 찾는 중');
      try {
        const data = await apiJson<Match[]>('/matches?sport=FOOTBALL');
        const sourceMatches = Array.isArray(data) ? data : [];
        const results = await Promise.allSettled(
          sourceMatches.map(async (match) => {
            const saved = await apiJson<SavedLogsResponse>(`/fpa/matches/${encodeURIComponent(match.id)}/logs`);
            const sceneCount = buildReplayScenes(saved.rows || [], saved.logs || []).length;
            return sceneCount > 0 ? { ...match, savedLogs: saved, sceneCount } : null;
          }),
        );
        if (!active) return;
        const filtered = results
          .map((result) => (result.status === 'fulfilled' ? result.value : null))
          .filter((match): match is ReplayMatch => Boolean(match));
        setMatches(filtered);
        setStatus(filtered.length ? `듀얼모드 FPA 경기 ${filtered.length}개` : '듀얼모드 FPA 데이터가 있는 경기가 없습니다');
      } catch (error) {
        if (active) setStatus(error instanceof Error ? error.message : '경기 목록을 불러오지 못했습니다');
      } finally {
        if (active) setBusy(false);
      }
    };
    void loadReplayMatches();
    return () => {
      active = false;
    };
  }, []);

  const scenes = useMemo(
    () => buildReplayScenes(savedLogs?.rows || [], savedLogs?.logs || []),
    [savedLogs],
  );
  const selectedScene = scenes[selectedSceneIndex] || scenes[0] || null;
  const selectedTeams = selectedMatch ? parseMatchTeams(selectedMatch) : { home: savedLogs?.teamid_h || 'Home', away: savedLogs?.teamid_a || 'Away' };
  const homeName = savedLogs?.teamid_h || selectedTeams.home;
  const awayName = savedLogs?.teamid_a || selectedTeams.away;
  const selectedSceneTotals = selectedScene
    ? METRIC_KEYS.map((key) => ({ key, value: sceneMetricTotal(selectedScene, key) }))
    : [];
  const motionGridStyle: MotionGridStyle | undefined = pitchHeight
    ? { '--fpa-replay-pitch-height': `${pitchHeight}px` }
    : undefined;

  useLayoutEffect(() => {
    const node = pitchRef.current;
    if (!node) return undefined;

    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const nextHeight = Math.round(node.getBoundingClientRect().height);
        if (nextHeight > 0) {
          setPitchHeight((current) => (current === nextHeight ? current : nextHeight));
        }
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [replayTick, selectedMatch?.id, selectedScene?.index]);

  const loadMatch = (match: ReplayMatch) => {
    setSelectedMatch(match);
    setSavedLogs(match.savedLogs);
    setSelectedSceneIndex(0);
    setReplayTick((value) => value + 1);
    setStatus(`장면 ${match.sceneCount}개 준비됨`);
  };

  const selectScene = (index: number) => {
    setSelectedSceneIndex(index);
    setReplayTick((value) => value + 1);
  };

  return (
    <main className="fpa-replay-page">
      <section className="card card-panel fpa-replay-hero">
        <div>
          <div className="sidebar-eyebrow">FPA Scene Motion</div>
          <h2>Scene Motion</h2>
          <p>저장된 듀얼 피치 장면을 Before에서 After로 이어지는 3초 모션으로 확인합니다.</p>
        </div>
        <span className="status-pill tech">{status}</span>
      </section>

      <section className="fpa-replay-layout">
        <aside className="card card-panel fpa-replay-sidebar">
          <div className="section-heading compact">
            <div>
              <div className="sidebar-eyebrow">Matches</div>
              <h3>경기 선택</h3>
            </div>
          </div>
          <div className="fpa-replay-match-list">
            {matches.map((match) => {
              const teams = parseMatchTeams(match);
              return (
                <button
                  className={selectedMatch?.id === match.id ? 'active' : ''}
                  disabled={busy}
                  key={match.id}
                  onClick={() => void loadMatch(match)}
                  type="button"
                >
                  <strong>{teams.home} vs {teams.away}</strong>
                  <span>{match.id}</span>
                  <small>{match.competition_class} · R{match.round_number} · Scene {match.sceneCount}</small>
                </button>
              );
            })}
            {!busy && !matches.length ? (
              <div className="fpa-replay-empty-list">듀얼모드 FPA 데이터가 있는 경기가 없습니다.</div>
            ) : null}
          </div>
        </aside>

        <section className="card card-panel fpa-replay-stage-card">
          <div className="fpa-replay-stage-head">
            <div>
              <div className="sidebar-eyebrow">Motion Preview</div>
              <h3>{selectedMatch ? `${homeName} vs ${awayName}` : '경기를 선택하세요'}</h3>
              <p>{selectedMatch?.id || '저장된 FPA 로그가 있는 경기를 누르면 장면 애니메이션이 표시됩니다.'}</p>
            </div>
            <div className="fpa-replay-controls">
              <button disabled={!selectedScene || selectedSceneIndex <= 0} onClick={() => selectScene(selectedSceneIndex - 1)} type="button">이전</button>
              <button disabled={!selectedScene} onClick={() => setReplayTick((value) => value + 1)} type="button">재생</button>
              <button disabled={!selectedScene || selectedSceneIndex >= scenes.length - 1} onClick={() => selectScene(selectedSceneIndex + 1)} type="button">다음</button>
            </div>
          </div>

          {selectedScene ? (
            <>
              <div className="fpa-replay-scene-tabs">
                {scenes.map((scene, index) => (
                  <button className={index === selectedSceneIndex ? 'active' : ''} key={scene.index} onClick={() => selectScene(index)} type="button">
                    {index + 1}
                  </button>
                ))}
              </div>

              <div className="fpa-replay-motion-grid" style={motionGridStyle}>
                <div className="fpa-replay-pitch" key={`${selectedScene.index}-${replayTick}`} ref={pitchRef}>
                  <img alt="FPA scene motion pitch" draggable={false} src="/fpa-field.png" />
                  <svg className="fpa-replay-arrows" preserveAspectRatio="none" viewBox="0 0 1050 680">
                    <defs>
                      <marker id="fpa-replay-arrow-head" markerHeight="6" markerWidth="6" orient="auto" refX="4.5" refY="3">
                        <path d="M0,0 L6,3 L0,6 Z" fill="#16c2c2" />
                      </marker>
                    </defs>
                    {selectedScene.passes.map((pass) => (
                      <line
                        key={pass.key}
                        markerEnd="url(#fpa-replay-arrow-head)"
                        x1={pass.x1}
                        x2={pass.x2}
                        y1={pass.y1}
                        y2={pass.y2}
                      />
                    ))}
                  </svg>
                  {selectedScene.dots.map((dot, index) => (
                    <span
                      className={`fpa-replay-dot ${dot.teamSide || dot.from.team || 'ally'} ${dot.role === 'gk' ? 'gk' : ''}`}
                      key={dot.key}
                      style={motionStyle(dot.from, dot.to, index * 0.025)}
                      title={`${dot.label}: (${dot.from.meter_x.toFixed(1)}, ${dot.from.meter_y.toFixed(1)}) → (${dot.to.meter_x.toFixed(1)}, ${dot.to.meter_y.toFixed(1)})`}
                    >
                      {dot.label}
                    </span>
                  ))}
                  {selectedScene.passes.map((pass) => (
                    <span className="fpa-replay-ball" key={`ball-${pass.key}`} style={passStyle(pass)} title="Pass ball">
                      ⚽
                    </span>
                  ))}
                </div>

                <aside className="fpa-replay-summary">
                  <div className="fpa-replay-summary-card">
                    <span>Scene {selectedSceneIndex + 1} / {scenes.length}</span>
                    <strong>{selectedScene.dots.length} players · {selectedScene.passes.length} passes</strong>
                  </div>
                  <div className="fpa-replay-metric-grid" aria-label="Scene expected effects">
                    {selectedSceneTotals.map(({ key, value }) => (
                      <div className={`fpa-replay-metric ${value !== null && value > 0 ? 'positive' : value !== null && value < 0 ? 'negative' : ''}`} key={key}>
                        <span>{key}</span>
                        <strong>{formatMetricValue(value, key)}</strong>
                      </div>
                    ))}
                  </div>
                  <div className="fpa-replay-action-list">
                    {selectedScene.rows.map((row, rowIndex) => (
                      <div className="fpa-replay-action-item" key={`${row.SceneActionIndex || rowIndex}-${row.Player}-${row.Action}`}>
                        <strong>{actionLabel(row)}</strong>
                        <div>
                          {METRIC_KEYS.map((key) => {
                            const value = actionMetricValue(selectedScene, row, rowIndex, key);
                            return (
                              <span className={value !== null && value > 0 ? 'positive' : value !== null && value < 0 ? 'negative' : ''} key={key}>
                                {key} {formatMetricValue(value, key)}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </aside>
              </div>
            </>
          ) : (
            <div className="fpa-replay-empty">
              <strong>표시할 듀얼 피치 장면이 없습니다.</strong>
              <p>Live Logger에서 듀얼 모드 장면을 저장한 뒤 이 화면에서 다시 불러오세요.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
