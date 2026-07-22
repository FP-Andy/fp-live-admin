'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, apiFetch, apiJson } from '../../../../lib/api';
import { FPA_DRAFT_EVENT, FPA_DRAFT_STORAGE_KEY } from '../../../../components/FpaDraftGuard';

type DualDotTeam = 'ally' | 'opponent';
type TeamSide = 'home' | 'away';

// 팀 레이어는 화면 표시용 home/away와 xFP scoring용 ally/opponent를 분리한다.
// ally/opponent는 현재 Stat Input의 Team 값 기준으로 payload 생성 시 확정된다.
type DualLayer = { key: string; label: string; hotkey: string; teamSide: TeamSide; role: 'field' | 'gk'; color: string };
const DUAL_LAYERS: DualLayer[] = [
  { key: 'home_field', label: '홈', hotkey: 'q', teamSide: 'home', role: 'field', color: '#2f6df6' },
  { key: 'away_field', label: '어웨이', hotkey: 'w', teamSide: 'away', role: 'field', color: '#e0524f' },
  { key: 'home_gk', label: '홈 GK', hotkey: 'e', teamSide: 'home', role: 'gk', color: '#16357a' },
  { key: 'away_gk', label: '어웨이 GK', hotkey: 'r', teamSide: 'away', role: 'gk', color: '#7a1f1d' },
];

function relationForTeamSide(teamSide: TeamSide | undefined, actorTeam: TeamSide): DualDotTeam {
  return teamSide === actorTeam ? 'ally' : 'opponent';
}

function newDotId() {
  return Math.random().toString(36).slice(2, 10);
}

type PitchDot = {
  id?: string;       // 점 식별자 — 화살표 연결(삭제·드래그)용
  meter_x: number;
  meter_y: number;
  screen_x: number;
  screen_y: number;
  team?: DualDotTeam;
  teamSide?: TeamSide; // absolute home/away layer; team is actor-relative ally/opponent
  layer?: string;
  role?: string;     // field | gk (레이어)
  color?: string;    // 레이어 색
  number?: string;   // 등번호 — stat input 코드의 행위자 번호가 제출 시 그 점에 지정됨 (xFP/fpa)
};

type PitchSide = 'before' | 'after';

type InputMode = 'single' | 'dual';

type SelectedDualDot = {
  side: PitchSide;
  index: number;
};

type RenderPitchDot = PitchDot & {
  left: string;
  top: string;
  label: string;
  team: DualDotTeam;
  isPrimaryAlly: boolean;
};

// code/rowIndex: 끝점 드래그로 도착점을 옮겼을 때 그 로그 행을 재채점하기 위한 연결 (신규 생성 화살표에만 채워짐)
type PassArrow = { side: PitchSide; startId?: string; x1: number; y1: number; x2: number; y2: number; code?: string; rowIndex?: number };

// 저장된 장면 — 로그행 + 캔버스 스냅샷(점·화살표). 불러오기 시 그대로 복원, 저장 시 제자리 덮어쓰기.
type SavedScene = {
  rows: LogPreview[];
  logs: string[];
  beforeDots: PitchDot[];
  afterDots: PitchDot[];
  passArrows: PassArrow[];
  primary: number | null;
};

type LogPreview = {
  Time: string;
  Team: string;
  Player: string;
  Action: string;
  Receiver: string;
  Coord: string;
  Tags: string;
  DualState?: string;
  xG?: string;
  xGOT?: string;
  EPV?: string;
  PC?: string;
  StatInput?: string; // 원본 스탯 코드 — 장면 저장 시 최종 좌표로 재채점하기 위해 각 행에 보존
};

type PersistedLogRow = LogPreview & {
  SceneIndex?: string;
  SceneActionIndex?: string;
  SceneState?: string;
};

type MetricKey = 'xG' | 'xGOT' | 'EPV' | 'PC';

type GoalmouthPoint = {
  x: number;
  y: number;
};

type PendingXgot = {
  canvas: 'live' | 'edit'; // 어느 캔버스의 슛인지 — 완료 시 그쪽 rows/logs 에 기록
  rowIndex: number;
  xg: number;
  isGoal: boolean;
  isHeader: boolean;
  isWeakFoot: boolean;
  underPressure: boolean;
  oneOnOne: boolean;
};

type XgotEstimateResult = {
  xgot: number;
  delta: number;
  label: string;
};

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

type DualStatePoint = {
  meter_x?: number;
  meter_y?: number;
  team?: DualDotTeam;
  team_side?: TeamSide;
  role?: string;
  layer?: string;
  number?: string;
  id?: string;
};

type ParsedDualState = {
  actor_team?: TeamSide;
  primary_row_index?: number | null;
  before?: DualStatePoint[];
  after?: DualStatePoint[];
};

function parseMatchTeams(match: Match) {
  const metadataHome = match.metadata?.home_team?.trim();
  const metadataAway = match.metadata?.away_team?.trim();
  if (metadataHome && metadataAway) return { home: metadataHome, away: metadataAway };
  const cleaned = match.name.replace(/^\[[^\]]+\]\s*/, '');
  const [home, away] = cleaned.split(/\s+vs\s+/i).map((part) => part.trim());
  return { home: home || 'Home', away: away || 'Away' };
}

function extractReceiveCoord(logText?: string) {
  if (!logText) return '';
  const matches = Array.from(logText.matchAll(/Pos\((.+?), (.+?)\)/g));
  if (matches.length < 2) return '';
  const [, x, y] = matches[matches.length - 1];
  return `Pos(${x}, ${y})`;
}

function extractDualStateSummary(logText?: string) {
  if (!logText) return '';
  const marker = 'DualState: ';
  const start = logText.indexOf(marker);
  if (start < 0) return '';
  try {
    const parsed = JSON.parse(logText.slice(start + marker.length)) as {
      actor_team?: string;
      before?: Array<{ team?: string; team_side?: string }>;
      after?: Array<{ team?: string; team_side?: string }>;
    };
    const before = parsed.before || [];
    const after = parsed.after || [];
    const beforeHome = before.filter((point) => point.team_side === 'home').length;
    const beforeAway = before.filter((point) => point.team_side === 'away').length;
    const afterHome = after.filter((point) => point.team_side === 'home').length;
    const afterAway = after.filter((point) => point.team_side === 'away').length;
    const actorTeam = typeof parsed.actor_team === 'string' ? parsed.actor_team : '';
    if (beforeHome + beforeAway + afterHome + afterAway > 0) {
      return `${actorTeam ? `${actorTeam} · ` : ''}B H${beforeHome}/A${beforeAway} · A H${afterHome}/A${afterAway}`;
    }
    const beforeOpponents = before.filter((point) => point.team === 'opponent').length;
    const afterOpponents = after.filter((point) => point.team === 'opponent').length;
    return `B${before.length}/${beforeOpponents}O A${after.length}/${afterOpponents}O`;
  } catch {
    return 'Dual';
  }
}

function extractMetricValue(logText: string | undefined, key: MetricKey) {
  if (!logText) return '';
  const match = logText.match(new RegExp(`${key}=([^,|]+)`));
  return match?.[1]?.trim() || '';
}

function displayMetric(row: LogPreview, logText: string | undefined, key: MetricKey) {
  return row[key] || extractMetricValue(logText, key) || '-';
}

function mergeMetricsIntoLog(logText: string, metrics: Partial<Record<MetricKey, string>>) {
  const current: Partial<Record<MetricKey, string>> = {};
  (['xG', 'xGOT', 'EPV', 'PC'] as MetricKey[]).forEach((key) => {
    const value = extractMetricValue(logText, key);
    if (value) current[key] = value;
  });
  const nextMetrics = { ...current, ...metrics };
  const metricText = (['xG', 'xGOT', 'EPV', 'PC'] as MetricKey[])
    .map((key) => {
      const value = nextMetrics[key];
      return value ? `${key}=${value}` : '';
    })
    .filter(Boolean)
    .join(', ');
  if (!metricText) return logText;

  const parts = logText.split(' | ');
  const metricIndex = parts.findIndex((part) => part.startsWith('Metrics: '));
  if (metricIndex >= 0) {
    parts[metricIndex] = `Metrics: ${metricText}`;
    return parts.join(' | ');
  }
  const dualIndex = parts.findIndex((part) => part.startsWith('DualState: '));
  if (dualIndex >= 0) {
    parts.splice(dualIndex, 0, `Metrics: ${metricText}`);
  } else {
    parts.push(`Metrics: ${metricText}`);
  }
  return parts.join(' | ');
}

function extractActionCode(statInput: string) {
  const baseAction = statInput.trim().toLowerCase().split('.', 1)[0] || '';
  const match = baseAction.match(/^\d+([a-z]+)\d*$/i);
  return match?.[1] || '';
}

function shouldPromptXgot(statInput: string, row: LogPreview) {
  const actionCode = extractActionCode(statInput);
  if (actionCode === 'dd' || actionCode === 'ddd') return true;
  return row.Action === 'Shot' && /(^|, )On Target|(^|, )Goal/.test(row.Tags || '');
}

function screenFromMeter(meterX: number, meterY: number) {
  return {
    screen_x: Number(((meterX / 105) * 1050).toFixed(2)),
    screen_y: Number((((68 - meterY) / 68) * 680).toFixed(2)),
  };
}

function toPayloadDot(dot: PitchDot, actorTeam?: TeamSide) {
  const payload: {
    meter_x: number;
    meter_y: number;
    team?: DualDotTeam;
    team_side?: TeamSide;
    role?: string;
    layer?: string;
    number?: string;
    id?: string;
  } = {
    meter_x: dot.meter_x,
    meter_y: dot.meter_y,
  };
  const actorRelativeTeam = dot.teamSide && actorTeam ? relationForTeamSide(dot.teamSide, actorTeam) : dot.team;
  if (actorRelativeTeam) payload.team = actorRelativeTeam;
  if (dot.teamSide) payload.team_side = dot.teamSide;
  if (dot.role) payload.role = dot.role;
  if (dot.layer) payload.layer = dot.layer;
  if (dot.number) payload.number = dot.number;
  if (dot.id) payload.id = dot.id;
  return payload;
}

function colorForDualDot(teamSide?: TeamSide, role?: string, team?: DualDotTeam) {
  const layer = DUAL_LAYERS.find((candidate) => candidate.teamSide === teamSide && candidate.role === role);
  if (layer) return layer.color;
  if (teamSide === 'home') return role === 'gk' ? '#16357a' : '#2f6df6';
  if (teamSide === 'away') return role === 'gk' ? '#7a1f1d' : '#e0524f';
  return team === 'opponent' ? '#e0524f' : '#2f6df6';
}

function normalizePitchDot(raw: Partial<PitchDot> & { team_side?: TeamSide }, actorTeam?: TeamSide): PitchDot | null {
  const meterX = Number(raw.meter_x);
  const meterY = Number(raw.meter_y);
  if (!Number.isFinite(meterX) || !Number.isFinite(meterY)) return null;
  const screen = Number.isFinite(Number(raw.screen_x)) && Number.isFinite(Number(raw.screen_y))
    ? { screen_x: Number(raw.screen_x), screen_y: Number(raw.screen_y) }
    : screenFromMeter(meterX, meterY);
  const legacyLayerSide: TeamSide | undefined =
    raw.layer === 'atk' || raw.layer === 'atk_gk' ? 'home'
      : raw.layer === 'def' || raw.layer === 'def_gk' ? 'away'
        : undefined;
  const teamSide = raw.teamSide || raw.team_side || legacyLayerSide;
  const team = teamSide && actorTeam ? relationForTeamSide(teamSide, actorTeam) : raw.team;
  const rawRole = raw.role || (raw.layer?.includes('gk') ? 'gk' : undefined);
  const role = rawRole === 'attacker' || rawRole === 'defender' ? 'field' : rawRole;
  const layer = raw.layer || (teamSide ? `${teamSide}_${role === 'gk' ? 'gk' : 'field'}` : undefined);
  return {
    ...raw,
    id: raw.id || newDotId(),
    meter_x: Number(meterX.toFixed(2)),
    meter_y: Number(meterY.toFixed(2)),
    ...screen,
    team: team || 'ally',
    teamSide,
    layer,
    role,
    color: raw.color || colorForDualDot(teamSide, role, team),
  };
}

function parseDualStateFromLog(logText?: string): ParsedDualState | null {
  if (!logText) return null;
  const marker = 'DualState: ';
  const start = logText.indexOf(marker);
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(logText.slice(start + marker.length)) as ParsedDualState;
    if (!Array.isArray(parsed.before) && !Array.isArray(parsed.after)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function latestDualStateFromLogs(logsToScan: string[]): ParsedDualState | null {
  for (let index = logsToScan.length - 1; index >= 0; index -= 1) {
    const parsed = parseDualStateFromLog(logsToScan[index]);
    if (parsed) return parsed;
  }
  return null;
}

function dotsFromDualState(logsToScan: string[], side: PitchSide, fallbackActorTeam?: TeamSide) {
  const state = latestDualStateFromLogs(logsToScan);
  const actorTeam = state?.actor_team || fallbackActorTeam;
  const points = side === 'before' ? state?.before : state?.after;
  if (!Array.isArray(points)) return [];
  return points
    .map((point) => normalizePitchDot(point, actorTeam))
    .filter((dot): dot is PitchDot => Boolean(dot));
}

function hydrateSceneDots(dots: PitchDot[], logsToScan: string[], side: PitchSide, fallbackActorTeam?: TeamSide) {
  const normalized = dots
    .map((dot) => normalizePitchDot(dot, fallbackActorTeam))
    .filter((dot): dot is PitchDot => Boolean(dot));
  return normalized.length ? normalized : dotsFromDualState(logsToScan, side, fallbackActorTeam);
}

function sceneFromDualLogs(rows: LogPreview[], logsToScan: string[], fallbackActorTeam?: TeamSide): SavedScene | null {
  const state = latestDualStateFromLogs(logsToScan);
  if (!state) return null;
  const header = logsToScan[0]?.split(' | ') || [];
  const headerTeam = header[1] === 'home' || header[1] === 'away' ? header[1] : undefined;
  const actorTeam = state.actor_team || headerTeam || fallbackActorTeam;
  const beforeDotsFromState = dotsFromDualState(logsToScan, 'before', actorTeam);
  const afterDotsFromState = dotsFromDualState(logsToScan, 'after', actorTeam);
  if (!beforeDotsFromState.length && !afterDotsFromState.length) return null;
  return {
    rows,
    logs: logsToScan,
    beforeDots: beforeDotsFromState,
    afterDots: afterDotsFromState,
    passArrows: [],
    primary: typeof state.primary_row_index === 'number' ? state.primary_row_index : null,
  };
}

function sceneStateFromRow(row: LogPreview) {
  const raw = (row as PersistedLogRow).SceneState;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as {
      beforeDots?: PitchDot[];
      afterDots?: PitchDot[];
      before?: PitchDot[];
      after?: PitchDot[];
      passArrows?: PassArrow[];
      primary?: number | null;
    };
  } catch {
    return null;
  }
}

function scenesFromPersistedRows(rows: LogPreview[], logsToScan: string[], fallbackActorTeam?: TeamSide) {
  const groups = new Map<string, { rows: LogPreview[]; logs: string[]; state: ReturnType<typeof sceneStateFromRow> }>();
  rows.forEach((row, index) => {
    const sceneIndex = (row as PersistedLogRow).SceneIndex;
    if (!sceneIndex) return;
    const existing = groups.get(sceneIndex) || { rows: [], logs: [], state: null };
    existing.rows.push(row);
    existing.logs.push(logsToScan[index] || '');
    existing.state = existing.state || sceneStateFromRow(row);
    groups.set(sceneIndex, existing);
  });

  return Array.from(groups.entries())
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, group]) => {
      const state = group.state;
      if (!state) return null;
      const beforeSource = state.beforeDots || state.before || [];
      const afterSource = state.afterDots || state.after || [];
      const scene: SavedScene = {
        rows: group.rows,
        logs: group.logs,
        beforeDots: hydrateSceneDots(beforeSource, group.logs, 'before', fallbackActorTeam),
        afterDots: hydrateSceneDots(afterSource, group.logs, 'after', fallbackActorTeam),
        passArrows: Array.isArray(state.passArrows) ? state.passArrows.map((arrow) => ({ ...arrow })) : [],
        primary: typeof state.primary === 'number' ? state.primary : null,
      };
      return scene;
    })
    .filter((scene): scene is SavedScene => Boolean(scene));
}

function dotFromClientPoint(clientX: number, clientY: number, rect: DOMRect): PitchDot {
  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);
  return {
    meter_x: Number(((x / rect.width) * 105).toFixed(2)),
    meter_y: Number((((rect.height - y) / rect.height) * 68).toFixed(2)),
    screen_x: Number(((x / rect.width) * 1050).toFixed(2)),
    screen_y: Number(((y / rect.height) * 680).toFixed(2)),
  };
}

// 피치 빈 곳(점이 아닌 곳)에서 우클릭했을 때, 커서에 가장 가까운 점의 인덱스를 찾는다.
// 점은 작아서 정확히 맞히기 어렵기에 반경(px) 안이면 그 점을 지운다. 반경 밖이면 -1.
const DOT_HIT_RADIUS_PX = 24;
function nearestDotIndex(dots: PitchDot[], clientX: number, clientY: number, rect: DOMRect): number {
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  let best = -1;
  let bestDist = DOT_HIT_RADIUS_PX;
  dots.forEach((dot, index) => {
    const dx = (dot.screen_x / 1050) * rect.width - px;
    const dy = (dot.screen_y / 680) * rect.height - py;
    const dist = Math.hypot(dx, dy);
    if (dist <= bestDist) {
      bestDist = dist;
      best = index;
    }
  });
  return best;
}

function isAllyDot(dot: PitchDot) {
  return (dot.team || 'ally') === 'ally';
}

function clonePitchDotsForNextScene(dotsToClone: PitchDot[]) {
  return dotsToClone.map((dot) => ({ ...dot, id: newDotId() }));
}

function clonePitchDotsWithIdMap(dotsToClone: PitchDot[]) {
  const idMap = new Map<string, string>();
  const dots = dotsToClone.map((dot) => {
    const nextId = newDotId();
    if (dot.id) idMap.set(dot.id, nextId);
    return { ...dot, id: nextId };
  });
  return { dots, idMap };
}

function statInputHasReceiver(statInput: string) {
  const baseAction = statInput.trim().split('.', 1)[0] || '';
  return /^\d+[a-z]+\d+$/i.test(baseAction);
}

// 드리블/돌파/침투: 도착점은 행위자가 after 프레임에서 서 있는 위치다. 리시버가 붙으면 패스 계열.
const MOVE_ACTION_CODES = ['r', 'rr', 'e', 'ee', 'pn'];

function statInputIsMoveAction(statInput: string) {
  if (statInputHasReceiver(statInput)) return false;
  return MOVE_ACTION_CODES.includes(extractActionCode(statInput));
}

function statInputIsNumberOnly(statInput: string) {
  return /^\d+$/.test(statInput.trim());
}

// 수비 화살표 액션 — before 프레임에 상대 볼/슛 경로를 화살표(start→end)로 그림 (2클릭). 리시버 번호 없음.
// aa/q/ww = 패스/볼 경로 → EPV(end)−EPV(start) 로 채점하므로 양 끝이 모두 점수에 들어간다.
// qw = 슛 블락 → xG(슈터 위치)만으로 채점. end(블록 지점)는 기록용이고 점수에 안 쓰인다.
//   상대팀은 좌표만 찍으므로 슛 위치 마커가 필요해 화살표를 유지한다 (2026-07-10 결정).
// 제외: Duel(b/bb)·Clear(w)=포인트 액션.
const DEFENSE_ARROW_CODES = new Set(['aa', 'q', 'ww', 'qw']);
const SHOT_BLOCK_CODES = new Set(['qw']);
function statInputActionCode(statInput?: string | null) {
  const base = (statInput ?? '').trim().split('.', 1)[0] || '';
  return base.match(/^\d+([a-z]+)$/i)?.[1].toLowerCase() ?? '';
}
function statInputIsDefenseArrow(statInput?: string | null) {
  return DEFENSE_ARROW_CODES.has(statInputActionCode(statInput));
}
function statInputIsShotBlock(statInput?: string | null) {
  return SHOT_BLOCK_CODES.has(statInputActionCode(statInput));
}

// 화살표 그리기 대기 상태 서술자 — 피치 위 배지/커서/미리보기 렌더에 사용
type ArrowArm = { side: PitchSide; code: string; stage: 'start' | 'end'; sx: number; sy: number };

// 패스(아군 볼) vs 수비(상대 볼 차단)를 한눈에 구분 — 색·선종류·끝점 마커가 모두 다름.
// aa/q/ww/qw 세부 구분은 화살표에 붙는 코드 칩이 담당한다.
const ARROW_COLORS = { pass: '#16c2c2', defense: '#e0524f' } as const;
type ArrowKind = keyof typeof ARROW_COLORS;
function arrowKind(code?: string): ArrowKind {
  return statInputIsDefenseArrow(code) ? 'defense' : 'pass';
}

// 각 클릭이 무엇을 뜻하는지 — 피치 배지와 하단 상태바가 같은 문구를 쓴다
function arrowArmHint(code: string, stage: 'start' | 'end') {
  if (statInputIsShotBlock(code)) {
    return stage === 'start' ? '슛 위치(슈터) 클릭 · xG 채점 기준' : '블록 지점 클릭 · 기록용';
  }
  if (statInputIsDefenseArrow(code)) {
    return stage === 'start' ? '상대 볼 출발점 클릭' : '끊은 지점 클릭';
  }
  return '패스 도착점 클릭';
}

function arrowBelongsToRemovedDot(arrow: PassArrow, side: PitchSide, removedId: string) {
  if (arrow.startId !== removedId) return false;
  return arrow.side === side || side === 'before';
}

function mirroredBeforeArrowsForAfter(arrows: PassArrow[], idMap: Map<string, string>) {
  return arrows
    .filter((arrow) => arrow.side === 'before')
    .map((arrow) => ({
      ...arrow,
      side: 'after' as PitchSide,
      startId: arrow.startId ? idMap.get(arrow.startId) || arrow.startId : undefined,
    }));
}

function sceneStateForPersistence(scene: SavedScene, sceneIndex: number) {
  return JSON.stringify({
    schema: 'fineplay.fpa.scene_state.v0.1',
    scene_index: sceneIndex,
    beforeDots: scene.beforeDots,
    afterDots: scene.afterDots,
    passArrows: scene.passArrows,
    primary: scene.primary,
  });
}

function validateMatchIdForSave(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'ID') return '';
  if (/\s/.test(trimmed)) return 'Match ID에는 띄어쓰기를 사용할 수 없습니다';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return 'Match ID는 UUID 형식이어야 합니다. 비워두면 자동 생성됩니다';
  }
  return '';
}

function generateMatchId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (char) =>
    (Number(char) ^ (Math.random() * 16) >> (Number(char) / 4)).toString(16));
}

function buildRenderPitchDots(sourceDots: PitchDot[]): RenderPitchDot[] {
  let allyCount = 0;
  let opponentCount = 0;
  return sourceDots.map((sourceDot) => {
    const dot = normalizePitchDot(sourceDot) || sourceDot;
    const dotTeam = dot.team || 'ally';
    const teamIndex = dotTeam === 'ally' ? (allyCount += 1) : (opponentCount += 1);
    return {
      ...dot,
      team: dotTeam,
      left: `${(dot.screen_x / 1050) * 100}%`,
      top: `${(dot.screen_y / 680) * 100}%`,
      label: dot.number || `${dotTeam === 'ally' ? 'A' : 'O'}${teamIndex}`,
      isPrimaryAlly: dotTeam === 'ally' && teamIndex <= 2,
    };
  });
}

// 라이브 dual 캔버스 undo 단위 — 조작 직전의 캔버스+로그 스냅샷 (Undo 는 마지막 조작 자체를 되돌림)
type DualUndoSnapshot = {
  beforeDots: PitchDot[];
  afterDots: PitchDot[];
  passArrows: PassArrow[];
  rows: LogPreview[];
  logs: string[];
  primaryRowIndex: number | null;
  selectedRowIndex: number | null;
};

export default function FpaLivePage() {
  const didHydrateRef = useRef(false);
  const pitchRef = useRef<HTMLDivElement | null>(null);
  const beforePitchRef = useRef<HTMLDivElement | null>(null);
  const afterPitchRef = useRef<HTMLDivElement | null>(null);
  const editBeforePitchRef = useRef<HTMLDivElement | null>(null);
  const editAfterPitchRef = useRef<HTMLDivElement | null>(null);
  const draggingDualDotRef = useRef<(SelectedDualDot & { canvas: 'live' | 'edit'; historyPushed?: boolean }) | null>(null);
  // 패스 화살표 끝점 드래그 상태 — index=passArrows 배열 실제 인덱스, end='end'(도착점) 이동, moved=실제 이동 여부(클릭과 구분)
  const draggingArrowRef = useRef<{ index: number; end: 'start' | 'end'; side: PitchSide; canvas: 'live' | 'edit'; moved: boolean } | null>(null);
  const logBodyRef = useRef<HTMLDivElement | null>(null);
  const statInputRef = useRef<HTMLInputElement | null>(null);
  const editStatInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [half, setHalf] = useState<'1H' | '2H'>('1H');
  const [team, setTeam] = useState<'home' | 'away'>('home');
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [timeline, setTimeline] = useState('00:00');
  const [statInput, setStatInput] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('single');
  const [activeLayer, setActiveLayer] = useState<string>('home_field');
  const currentLayer = DUAL_LAYERS.find((layer) => layer.key === activeLayer) ?? DUAL_LAYERS[0];
  const [dots, setDots] = useState<PitchDot[]>([]);
  const [beforeDots, setBeforeDots] = useState<PitchDot[]>([]);
  const [afterDots, setAfterDots] = useState<PitchDot[]>([]);
  const [selectedDualDot, setSelectedDualDot] = useState<SelectedDualDot | null>(null);
  const [pendingXgot, setPendingXgot] = useState<PendingXgot | null>(null);
  const [goalmouthPoint, setGoalmouthPoint] = useState<GoalmouthPoint | null>(null);
  const [xgotEstimate, setXgotEstimate] = useState<XgotEstimateResult | null>(null);
  const [xgotBusy, setXgotBusy] = useState(false);
  // rows/logs = "현재 작업 중 장면"의 액션 (single 모드는 그냥 flat 로그). 저장된 장면은 savedScenes.
  const [logs, setLogs] = useState<string[]>([]);
  const [rows, setRows] = useState<LogPreview[]>([]);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [primaryRowIndex, setPrimaryRowIndex] = useState<number | null>(null);
  // 저장된 장면들(순서 보존). 기록된 로그가 이걸 장면 단위로 보여줌.
  const [savedScenes, setSavedScenes] = useState<SavedScene[]>([]);
  // 불러와 편집 중인 장면 index (null=새 장면). 저장 시 이 index 자리에 덮어씀 → 순서 유지.
  const [editingSceneIndex, setEditingSceneIndex] = useState<number | null>(null);
  // 패스/크로스: 시작 점에서 코드 입력 후 도착점 클릭 대기. 도착점 클릭 시 [시작,도착] 2점으로 채점.
  const [pendingPass, setPendingPass] = useState<{ code: string; side: PitchSide; startId?: string; sx: number; sy: number; mx: number; my: number } | null>(null);
  const [passArrows, setPassArrows] = useState<PassArrow[]>([]);
  // 기록된 로그: dual 은 장면 단위 선택 → 불러오기/수정
  const [selectedSceneIndex, setSelectedSceneIndex] = useState<number | null>(null);
  // 수정용 피치 — 기록된 로그 아래 별도 편집 캔버스. 라이브(찍는) 데이터와 완전 분리해 유실 방지.
  const [editRows, setEditRows] = useState<LogPreview[]>([]);
  const [editLogs, setEditLogs] = useState<string[]>([]);
  const [editBeforeDots, setEditBeforeDots] = useState<PitchDot[]>([]);
  const [editAfterDots, setEditAfterDots] = useState<PitchDot[]>([]);
  const [editPassArrows, setEditPassArrows] = useState<PassArrow[]>([]);
  const [editPrimary, setEditPrimary] = useState<number | null>(null);
  // 드래그 종료(pointerup) 시점에 최신 화살표 좌표를 읽기 위한 미러 (render마다 동기 갱신)
  const passArrowsRef = useRef<PassArrow[]>(passArrows);
  passArrowsRef.current = passArrows;
  const editPassArrowsRef = useRef<PassArrow[]>(editPassArrows);
  editPassArrowsRef.current = editPassArrows;
  // undo 스냅샷용 최신 상태 미러 (이벤트 리스너의 stale closure 회피 — render마다 동기 갱신)
  const dualUndoStateRef = useRef<DualUndoSnapshot>({ beforeDots, afterDots, passArrows, rows, logs, primaryRowIndex, selectedRowIndex });
  dualUndoStateRef.current = { beforeDots, afterDots, passArrows, rows, logs, primaryRowIndex, selectedRowIndex };
  const dualUndoHistoryRef = useRef<DualUndoSnapshot[]>([]);
  const [editSelectedDot, setEditSelectedDot] = useState<SelectedDualDot | null>(null);
  const [editSelectedRowIndex, setEditSelectedRowIndex] = useState<number | null>(null);
  // 수정용 입력 상태 — 라이브 입력값과 분리 (과거 장면은 half/시간/공격방향이 지금 라이브와 다름). 레이어만 공유(activeLayer).
  const [editHalf, setEditHalf] = useState<'1H' | '2H'>('1H');
  const [editTeam, setEditTeam] = useState<'home' | 'away'>('home');
  const [editDirection, setEditDirection] = useState<'left' | 'right'>('right');
  const [editTimeline, setEditTimeline] = useState('00:00');
  const [editStatInput, setEditStatInput] = useState('');
  const [editPendingPass, setEditPendingPass] = useState<{ code: string; side: PitchSide; startId?: string; sx: number; sy: number; mx: number; my: number } | null>(null);
  // 수비 화살표 1차 클릭 대기 — 상대 볼 출발점을 찍으면 pendingPass 로 승격되어 2차 클릭에서 화살표 완성
  const [pendingDefStart, setPendingDefStart] = useState<{ code: string; side: PitchSide } | null>(null);
  const [editPendingDefStart, setEditPendingDefStart] = useState<{ code: string; side: PitchSide } | null>(null);
  // 화살표 그리는 중 커서 위치(viewBox 좌표) — 시작점→커서 고무줄 미리보기용
  const [arrowPreview, setArrowPreview] = useState<{ canvas: 'live' | 'edit'; side: PitchSide; x: number; y: number } | null>(null);

  // pendingDefStart(출발점 대기) / pendingPass(도착점 대기)를 피치 렌더가 쓰기 좋은 형태로 통합
  const liveArrowArm: ArrowArm | null = pendingPass
    ? { side: pendingPass.side, code: pendingPass.code, stage: 'end', sx: pendingPass.sx, sy: pendingPass.sy }
    : pendingDefStart
      ? { side: pendingDefStart.side, code: pendingDefStart.code, stage: 'start', sx: 0, sy: 0 }
      : null;
  const editArrowArm: ArrowArm | null = editPendingPass
    ? { side: editPendingPass.side, code: editPendingPass.code, stage: 'end', sx: editPendingPass.sx, sy: editPendingPass.sy }
    : editPendingDefStart
      ? { side: editPendingDefStart.side, code: editPendingDefStart.code, stage: 'start', sx: 0, sy: 0 }
      : null;

  const cancelArrowDraw = () => {
    if (!pendingPass && !pendingDefStart && !editPendingPass && !editPendingDefStart) return;
    setPendingPass(null);
    setPendingDefStart(null);
    setEditPendingPass(null);
    setEditPendingDefStart(null);
    setArrowPreview(null);
    setStatus('화살표 그리기 취소');
  };

  // 화살표 대기 중인 피치 위에서만 커서를 추적 (미리보기 선). 그 외에는 리렌더 없음
  const trackArrowPreview = (
    canvas: 'live' | 'edit',
    side: PitchSide,
    arm: ArrowArm | null,
    event: React.PointerEvent<HTMLDivElement>,
    rect: DOMRect | undefined,
  ) => {
    if (!arm || arm.side !== side || !rect) return;
    const c = dotFromClientPoint(event.clientX, event.clientY, rect);
    setArrowPreview({ canvas, side, x: c.screen_x, y: c.screen_y });
  };

  const armedLive = !!liveArrowArm;
  const armedEdit = !!editArrowArm;
  useEffect(() => {
    if (!armedLive && !armedEdit) setArrowPreview(null);
  }, [armedLive, armedEdit]);

  // 라이브·수정용 피치가 공유하는 화살표 오버레이 (기존 화살표 + 그리는 중 미리보기)
  const renderArrowOverlay = (canvas: 'live' | 'edit', side: PitchSide, arrows: PassArrow[], arm: ArrowArm | null) => {
    const armedHere = arm?.side === side;
    const previewHere = arrowPreview?.canvas === canvas && arrowPreview.side === side ? arrowPreview : null;
    if (!arrows.some((arrow) => arrow.side === side) && !armedHere) return null;
    const liveArrows = canvas === 'edit' ? editPassArrowsRef : passArrowsRef;
    const markerId = (kind: ArrowKind) => `fpa-arrowhead-${kind}-${canvas}-${side}`;
    const armColor = ARROW_COLORS[arm ? arrowKind(arm.code) : 'pass'];

    // 드래그 핸들 — 시작점/도착점 양끝. 점이 아니라 화살표 좌표만 움직이고, 놓으면 재채점
    const handle = (index: number, end: 'start' | 'end', cx: number, cy: number, color: string, fallback: PassArrow) => (
      <circle className="fpa-arrow-handle" cx={cx} cy={cy} fill={color} r={13} stroke={color}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation();
          draggingArrowRef.current = { index, end, side, canvas, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={() => {
          const info = draggingArrowRef.current;
          if (info && info.canvas === canvas && info.index === index && info.moved) {
            void rescorePassArrow(canvas, liveArrows.current[index] ?? fallback);
          }
        }} />
    );

    return (
      <svg className="fpa-scene-arrows" preserveAspectRatio="none" viewBox="0 0 1050 680">
        <defs>
          {(Object.keys(ARROW_COLORS) as ArrowKind[]).map((kind) => (
            <marker id={markerId(kind)} key={kind} markerHeight="6" markerWidth="6" orient="auto" refX="4.5" refY="3">
              <path d="M0,0 L6,3 L0,6 Z" fill={ARROW_COLORS[kind]} />
            </marker>
          ))}
        </defs>
        {armedHere && arm?.stage === 'end' ? (
          <g className="fpa-arrow-preview">
            <circle className="fpa-arrow-start-marker" cx={arm.sx} cy={arm.sy} r={11} stroke={armColor} />
            {previewHere ? (
              <line markerEnd={`url(#${markerId(arrowKind(arm.code))})`} stroke={armColor} strokeDasharray="12 8"
                x1={arm.sx} y1={arm.sy} x2={previewHere.x} y2={previewHere.y} />
            ) : null}
          </g>
        ) : null}
        {arrows.map((arrow, index) => {
          if (arrow.side !== side) return null;
          const kind = arrowKind(arrow.code);
          const color = ARROW_COLORS[kind];
          const defense = kind === 'defense';
          return (
            <g key={`${canvas}-arrow-${side}-${index}`}>
              <line
                markerEnd={defense ? undefined : `url(#${markerId(kind)})`}
                stroke={color} strokeDasharray={defense ? '14 7' : undefined} strokeWidth={4}
                x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2} />
              {defense ? (
                // 상대 볼이 어디서 출발해(○) 어디서 끊겼는지(✕). 방향이 드러나므로 화살촉은 생략
                <g className="fpa-arrow-defense-caps" stroke={color}>
                  <circle cx={arrow.x1} cy={arrow.y1} fill={color} r={6} />
                  <line x1={arrow.x2 - 10} y1={arrow.y2 - 10} x2={arrow.x2 + 10} y2={arrow.y2 + 10} />
                  <line x1={arrow.x2 - 10} y1={arrow.y2 + 10} x2={arrow.x2 + 10} y2={arrow.y2 - 10} />
                </g>
              ) : null}
              {handle(index, 'start', arrow.x1, arrow.y1, color, arrow)}
              {handle(index, 'end', arrow.x2, arrow.y2, color, arrow)}
            </g>
          );
        })}
      </svg>
    );
  };

  // 화살표 중점의 코드 칩 — SVG는 preserveAspectRatio="none" 이라 글자가 늘어나므로 HTML 오버레이로 그린다
  const renderArrowChips = (side: PitchSide, arrows: PassArrow[]) =>
    arrows.map((arrow, index) => (arrow.side === side && arrow.code ? (
      <div
        className={`fpa-arrow-chip ${arrowKind(arrow.code)}`}
        key={`chip-${side}-${index}`}
        style={{
          left: `${((arrow.x1 + arrow.x2) / 2 / 1050) * 100}%`,
          top: `${((arrow.y1 + arrow.y2) / 2 / 680) * 100}%`,
        }}
      >
        {arrow.code}
      </div>
    ) : null));
  const [matchId, setMatchId] = useState('ID');
  const [teamIdH, setTeamIdH] = useState('Home');
  const [teamIdA, setTeamIdA] = useState('Away');
  const [matchIdError, setMatchIdError] = useState('');
  const [status, setStatus] = useState('실시간 입력 준비됨');
  const [busy, setBusy] = useState(false);
  const [availableMatches, setAvailableMatches] = useState<Match[]>([]);
  const [matchPickerOpen, setMatchPickerOpen] = useState(false);
  const [matchFilterClass, setMatchFilterClass] = useState('ALL');
  const [matchFilterRound, setMatchFilterRound] = useState('ALL');

  const matchClassOptions = Array.from(new Set(availableMatches.map((m) => m.competition_class)))
    .sort((a, b) => a.localeCompare(b, 'ko'));
  const matchRoundOptions = Array.from(new Set(
    availableMatches
      .filter((m) => matchFilterClass === 'ALL' || m.competition_class === matchFilterClass)
      .map((m) => m.round_number)
  )).sort((a, b) => a - b);
  const filteredAvailableMatches = availableMatches.filter((m) =>
    (matchFilterClass === 'ALL' || m.competition_class === matchFilterClass) &&
    (matchFilterRound === 'ALL' || String(m.round_number) === matchFilterRound)
  );

  // 전체 로그 = 저장된 장면들(flatten) + 현재 버퍼 (single 은 savedScenes 비어 있어 = 현재 버퍼). 저장/내보내기용.
  const allLogs = [...savedScenes.flatMap((scene) => scene.logs), ...logs];
  const allRows = [...savedScenes.flatMap((scene) => scene.rows), ...rows];

  const buildRowsForPersistence = () => {
    if (inputMode !== 'dual') return allRows;
    const scenesToPersist: SavedScene[] = [
      ...savedScenes,
      ...(rows.length
        ? [{
          rows,
          logs,
          beforeDots,
          afterDots,
          passArrows,
          primary: primaryRowIndex,
        }]
        : []),
    ];
    return scenesToPersist.flatMap((scene, sceneIndex) => {
      const sceneState = sceneStateForPersistence(scene, sceneIndex + 1);
      return scene.rows.map((row, actionIndex) => ({
        ...row,
        SceneIndex: String(sceneIndex + 1),
        SceneActionIndex: String(actionIndex + 1),
        SceneState: sceneState,
      }));
    });
  };

  useEffect(() => {
    if (typeof window === 'undefined' || didHydrateRef.current) return;
    didHydrateRef.current = true;
    const raw = window.sessionStorage.getItem(FPA_DRAFT_STORAGE_KEY);
    if (!raw) return;

    try {
      const draft = JSON.parse(raw) as {
        half?: '1H' | '2H';
        team?: 'home' | 'away';
        direction?: 'left' | 'right';
        timeline?: string;
        statInput?: string;
        inputMode?: InputMode;
        activeLayer?: string;
        dots?: PitchDot[];
        beforeDots?: PitchDot[];
        afterDots?: PitchDot[];
        selectedDualDot?: SelectedDualDot | null;
        logs?: string[];
        rows?: LogPreview[];
        savedScenes?: SavedScene[];
        editingSceneIndex?: number | null;
        editRows?: LogPreview[];
        editLogs?: string[];
        editBeforeDots?: PitchDot[];
        editAfterDots?: PitchDot[];
        editPassArrows?: PassArrow[];
        editPrimary?: number | null;
        editHalf?: '1H' | '2H';
        editTeam?: 'home' | 'away';
        editDirection?: 'left' | 'right';
        editTimeline?: string;
        editStatInput?: string;
        passArrows?: PassArrow[];
        primaryRowIndex?: number | null;
        selectedRowIndex?: number | null;
        matchId?: string;
        teamIdH?: string;
        teamIdA?: string;
      };

      if (draft.half) setHalf(draft.half);
      if (draft.team) setTeam(draft.team);
      if (draft.direction) setDirection(draft.direction);
      if (draft.timeline) setTimeline(draft.timeline);
      if (typeof draft.statInput === 'string') setStatInput(draft.statInput);
      if (draft.inputMode) setInputMode(draft.inputMode);
      if (draft.activeLayer) {
        const legacyLayerMap: Record<string, string> = {
          atk: 'home_field',
          def: 'away_field',
          atk_gk: 'home_gk',
          def_gk: 'away_gk',
        };
        const layerKey = legacyLayerMap[draft.activeLayer] || draft.activeLayer;
        setActiveLayer(DUAL_LAYERS.some((layer) => layer.key === layerKey) ? layerKey : 'home_field');
      }
      if (Array.isArray(draft.dots)) setDots(draft.dots);
      if (Array.isArray(draft.beforeDots)) setBeforeDots(draft.beforeDots);
      if (Array.isArray(draft.afterDots)) setAfterDots(draft.afterDots);
      if (draft.selectedDualDot) setSelectedDualDot(draft.selectedDualDot);
      if (Array.isArray(draft.logs)) setLogs(draft.logs);
      if (Array.isArray(draft.rows)) setRows(draft.rows);
      if (Array.isArray(draft.savedScenes)) setSavedScenes(draft.savedScenes);
      if (typeof draft.editingSceneIndex === 'number' || draft.editingSceneIndex === null) setEditingSceneIndex(draft.editingSceneIndex ?? null);
      if (Array.isArray(draft.editRows)) setEditRows(draft.editRows);
      if (Array.isArray(draft.editLogs)) setEditLogs(draft.editLogs);
      if (Array.isArray(draft.editBeforeDots)) setEditBeforeDots(draft.editBeforeDots);
      if (Array.isArray(draft.editAfterDots)) setEditAfterDots(draft.editAfterDots);
      if (Array.isArray(draft.editPassArrows)) setEditPassArrows(draft.editPassArrows);
      if (typeof draft.editPrimary === 'number' || draft.editPrimary === null) setEditPrimary(draft.editPrimary ?? null);
      if (draft.editHalf) setEditHalf(draft.editHalf);
      if (draft.editTeam) setEditTeam(draft.editTeam);
      if (draft.editDirection) setEditDirection(draft.editDirection);
      if (draft.editTimeline) setEditTimeline(draft.editTimeline);
      if (typeof draft.editStatInput === 'string') setEditStatInput(draft.editStatInput);
      if (Array.isArray(draft.passArrows)) setPassArrows(draft.passArrows);
      if (typeof draft.primaryRowIndex === 'number' || draft.primaryRowIndex === null) setPrimaryRowIndex(draft.primaryRowIndex ?? null);
      if (typeof draft.selectedRowIndex === 'number' || draft.selectedRowIndex === null) {
        setSelectedRowIndex(draft.selectedRowIndex);
      }
      if (typeof draft.matchId === 'string') setMatchId(draft.matchId);
      if (typeof draft.teamIdH === 'string') setTeamIdH(draft.teamIdH);
      if (typeof draft.teamIdA === 'string') setTeamIdA(draft.teamIdA);
      setStatus('이전 입력 상태를 복구했습니다');
    } catch {
      window.sessionStorage.removeItem(FPA_DRAFT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !didHydrateRef.current) return;

    const hasDraft =
      logs.length > 0 ||
      rows.length > 0 ||
      savedScenes.length > 0 ||
      dots.length > 0 ||
      beforeDots.length > 0 ||
      afterDots.length > 0 ||
      inputMode !== 'single' ||
      activeLayer !== 'home_field' ||
      statInput.trim().length > 0 ||
      matchId !== 'ID' ||
      teamIdH !== 'Home' ||
      teamIdA !== 'Away';

    if (!hasDraft) {
      window.sessionStorage.removeItem(FPA_DRAFT_STORAGE_KEY);
      window.dispatchEvent(new CustomEvent(FPA_DRAFT_EVENT, { detail: { hasDraft: false } }));
      return;
    }

    const draft = {
      half,
      team,
      direction,
      timeline,
      statInput,
      inputMode,
      activeLayer,
      dots,
      beforeDots,
      afterDots,
      selectedDualDot,
      logs,
      rows,
      savedScenes,
      editingSceneIndex,
      editRows,
      editLogs,
      editBeforeDots,
      editAfterDots,
      editPassArrows,
      editPrimary,
      editHalf,
      editTeam,
      editDirection,
      editTimeline,
      editStatInput,
      passArrows,
      primaryRowIndex,
      selectedRowIndex,
      matchId,
      teamIdH,
      teamIdA,
    };
    window.sessionStorage.setItem(FPA_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    window.dispatchEvent(new CustomEvent(FPA_DRAFT_EVENT, { detail: { hasDraft: true } }));
  }, [afterDots, beforeDots, direction, dots, activeLayer, editAfterDots, editBeforeDots, editDirection, editHalf, editLogs, editPassArrows, editPrimary, editRows, editStatInput, editTeam, editTimeline, editingSceneIndex, half, inputMode, logs, matchId, passArrows, primaryRowIndex, rows, savedScenes, selectedDualDot, selectedRowIndex, statInput, team, teamIdA, teamIdH, timeline]);

  useEffect(() => {
    const logBody = logBodyRef.current;
    if (!logBody) return;
    logBody.scrollTop = logBody.scrollHeight;
  }, [rows.length]);

  const pitchDots = useMemo(
    () =>
      dots.map((dot, index) => ({
        ...dot,
        left: `${(dot.screen_x / 1050) * 100}%`,
        top: `${(dot.screen_y / 680) * 100}%`,
        label: String(index + 1),
      })),
    [dots]
  );

  const beforePitchDots = useMemo(
    () => buildRenderPitchDots(beforeDots),
    [beforeDots]
  );

  const afterPitchDots = useMemo(
    () => buildRenderPitchDots(afterDots),
    [afterDots]
  );

  const editBeforePitchDots = useMemo(
    () => buildRenderPitchDots(editBeforeDots),
    [editBeforeDots]
  );

  const editAfterPitchDots = useMemo(
    () => buildRenderPitchDots(editAfterDots),
    [editAfterDots]
  );

  const dualPointSummary = useMemo(() => {
    const beforeAllyCount = beforeDots.filter(isAllyDot).length;
    const afterAllyCount = afterDots.filter(isAllyDot).length;
    return {
      beforeAllyCount,
      beforeOpponentCount: beforeDots.length - beforeAllyCount,
      afterAllyCount,
      afterOpponentCount: afterDots.length - afterAllyCount,
    };
  }, [afterDots, beforeDots]);

  const updateDualDot = (side: PitchSide, index: number, nextDot: PitchDot) => {
    const update = (prev: PitchDot[]) => prev.map((dot, dotIndex) => (dotIndex === index ? nextDot : dot));
    if (side === 'before') {
      setBeforeDots(update);
    } else {
      setAfterDots(update);
    }
  };

  const updateEditDot = (side: PitchSide, index: number, nextDot: PitchDot) => {
    const update = (prev: PitchDot[]) => prev.map((dot, dotIndex) => (dotIndex === index ? nextDot : dot));
    if (side === 'before') {
      setEditBeforeDots(update);
    } else {
      setEditAfterDots(update);
    }
  };

  // 라이브/수정 캔버스 점 선택은 상호 배타 — Delete 키가 엉뚱한 캔버스 점을 지우지 않도록
  const selectLiveDualDot = (sel: SelectedDualDot) => {
    setSelectedDualDot(sel);
    setEditSelectedDot(null);
  };

  const selectEditDot = (sel: SelectedDualDot) => {
    setEditSelectedDot(sel);
    setSelectedDualDot(null);
  };

  const assignNumberToLiveSelectedDot = (number: string) => {
    const sel = selectedDualDot;
    if (!sel) {
      setStatus('번호를 붙일 좌표를 먼저 선택하세요');
      return false;
    }
    const dotsArr = sel.side === 'before' ? beforeDots : afterDots;
    if (!dotsArr[sel.index]) {
      setStatus('선택된 좌표를 찾을 수 없습니다');
      return false;
    }
    // 행위자 번호는 아군(우리 팀) 점에만 — 상대(away) 점엔 절대 안 붙게
    if (!isAllyDot(dotsArr[sel.index])) {
      setStatus('행위자 번호는 아군 점에만 붙일 수 있습니다 (상대 점 선택됨)');
      return false;
    }
    pushDualUndo();
    const assign = (prev: PitchDot[]) =>
      prev.map((dot, index) => (index === sel.index ? { ...dot, number } : dot));
    if (sel.side === 'before') setBeforeDots(assign);
    else setAfterDots(assign);
    setStatInput('');
    setStatus(`${number}번을 ${sel.side === 'before' ? 'Before' : 'After'} 좌표에 할당했습니다`);
    requestAnimationFrame(() => statInputRef.current?.focus());
    return true;
  };

  const assignNumberToEditSelectedDot = (number: string) => {
    const sel = editSelectedDot;
    if (!sel) {
      setStatus('수정용 피치에서 번호를 붙일 좌표를 먼저 선택하세요');
      return false;
    }
    const dotsArr = sel.side === 'before' ? editBeforeDots : editAfterDots;
    if (!dotsArr[sel.index]) {
      setStatus('수정용 피치의 선택된 좌표를 찾을 수 없습니다');
      return false;
    }
    if (!isAllyDot(dotsArr[sel.index])) {
      setStatus('행위자 번호는 아군 점에만 붙일 수 있습니다 (상대 점 선택됨)');
      return false;
    }
    const assign = (prev: PitchDot[]) =>
      prev.map((dot, index) => (index === sel.index ? { ...dot, number } : dot));
    if (sel.side === 'before') setEditBeforeDots(assign);
    else setEditAfterDots(assign);
    setEditStatInput('');
    setStatus(`${number}번을 수정용 ${sel.side === 'before' ? 'Before' : 'After'} 좌표에 할당했습니다`);
    requestAnimationFrame(() => editStatInputRef.current?.focus());
    return true;
  };

  const handlePitchClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = pitchRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nextDot = dotFromClientPoint(event.clientX, event.clientY, rect);
    setDots((prev) => [...prev, nextDot]);
    statInputRef.current?.focus();
  };

  const handleDualPitchClick = (side: PitchSide, event: React.MouseEvent<HTMLDivElement>) => {
    const rect = (side === 'before' ? beforePitchRef.current : afterPitchRef.current)?.getBoundingClientRect();
    if (!rect) return;
    // 패스 도착점 대기 중 + 같은 프레임이면 → 새 점이 아니라 화살표 끝점 + [시작,도착] 2점으로 채점
    if (pendingPass && pendingPass.side === side) {
      const c = dotFromClientPoint(event.clientX, event.clientY, rect);
      pushDualUndo();
      const arrow = { side, startId: pendingPass.startId, x1: pendingPass.sx, y1: pendingPass.sy, x2: c.screen_x, y2: c.screen_y, code: pendingPass.code, rowIndex: rows.length };
      setPassArrows((prev) => [...prev, arrow]);
      const start: PitchDot = { meter_x: pendingPass.mx, meter_y: pendingPass.my, screen_x: pendingPass.sx, screen_y: pendingPass.sy };
      const end: PitchDot = { meter_x: c.meter_x, meter_y: c.meter_y, screen_x: c.screen_x, screen_y: c.screen_y };
      const code = pendingPass.code;
      setPendingPass(null);
      void scorePass(code, start, end);
      return;
    }
    // 수비 화살표 1차 클릭 = 상대 볼 출발점 → pendingPass 로 승격(2차 클릭에서 화살표 완성)
    if (pendingDefStart && pendingDefStart.side === side) {
      const c = dotFromClientPoint(event.clientX, event.clientY, rect);
      setPendingPass({ code: pendingDefStart.code, side, sx: c.screen_x, sy: c.screen_y, mx: c.meter_x, my: c.meter_y });
      setPendingDefStart(null);
      setStatus(`${arrowArmHint(pendingDefStart.code, 'end')} · Esc 취소`);
      return;
    }
    const nextDot: PitchDot = {
      id: newDotId(),
      ...dotFromClientPoint(event.clientX, event.clientY, rect),
      team: relationForTeamSide(currentLayer.teamSide, team),
      teamSide: currentLayer.teamSide,
      layer: currentLayer.key,
      role: currentLayer.role,
      color: currentLayer.color,
    };
    pushDualUndo();
    const place = (prev: PitchDot[]) => {
      const index = prev.length;
      selectLiveDualDot({ side, index });
      return [...prev, nextDot];
    };
    if (side === 'before') setBeforeDots(place);
    else setAfterDots(place);
    // 익명 점 생성 후 stat input 자동 포커스 (xFP/fpa: 점 찍고 바로 코드 입력)
    requestAnimationFrame(() => statInputRef.current?.focus());
  };

  const removeLastDot = () => {
    setDots((prev) => prev.slice(0, -1));
  };

  // 라이브 dual 캔버스를 바꾸는 모든 조작 직전에 호출 — 현재 상태를 undo 스택에 push (최대 50단계)
  const pushDualUndo = () => {
    dualUndoHistoryRef.current = [...dualUndoHistoryRef.current.slice(-49), { ...dualUndoStateRef.current }];
  };

  // 장면 저장/새 장면/불러오기 등 장면 경계에서 undo 스택 비움 (장면을 넘나드는 undo 방지)
  const resetDualUndo = () => {
    dualUndoHistoryRef.current = [];
  };

  const undoDual = () => {
    if (busy) {
      setStatus('채점 중에는 되돌릴 수 없습니다');
      return;
    }
    const stack = dualUndoHistoryRef.current;
    const snap = stack[stack.length - 1];
    if (!snap) {
      setStatus('되돌릴 조작이 없습니다');
      return;
    }
    dualUndoHistoryRef.current = stack.slice(0, -1);
    setBeforeDots(snap.beforeDots);
    setAfterDots(snap.afterDots);
    setPassArrows(snap.passArrows);
    setRows(snap.rows);
    setLogs(snap.logs);
    setPrimaryRowIndex(snap.primaryRowIndex);
    setSelectedRowIndex(snap.selectedRowIndex);
    setSelectedDualDot(null);
    setPendingPass(null);
    setPendingDefStart(null);
    setStatus('마지막 조작을 되돌렸습니다');
  };

  const removeSelectedDualDot = () => {
    if (!selectedDualDot) return;
    const sel = selectedDualDot;
    const dotsArr = sel.side === 'before' ? beforeDots : afterDots;
    if (!dotsArr[sel.index]) return;
    pushDualUndo();
    const removedId = dotsArr[sel.index]?.id;
    const removeAt = (prev: PitchDot[]) => prev.filter((_, index) => index !== sel.index);
    if (sel.side === 'before') {
      setBeforeDots(removeAt);
    } else {
      setAfterDots(removeAt);
    }
    if (removedId) setPassArrows((prev) => prev.filter((arrow) => !arrowBelongsToRemovedDot(arrow, sel.side, removedId)));
    setSelectedDualDot(null);
    setStatus('선택한 dual pitch 좌표 삭제');
  };

  const removeDualDotAt = (side: PitchSide, index: number) => {
    const dotsArr = side === 'before' ? beforeDots : afterDots;
    if (!dotsArr[index]) return;
    pushDualUndo();
    const removedId = dotsArr[index]?.id;
    if (side === 'before') setBeforeDots((prev) => prev.filter((_, i) => i !== index));
    else setAfterDots((prev) => prev.filter((_, i) => i !== index));
    // 그 점에 딸린 패스 화살표도 함께 삭제
    if (removedId) setPassArrows((prev) => prev.filter((arrow) => !arrowBelongsToRemovedDot(arrow, side, removedId)));
    setSelectedDualDot(null);
    setStatus('점 삭제');
  };

  const removeLastDualDot = (side: PitchSide) => {
    const dotsArr = side === 'before' ? beforeDots : afterDots;
    if (!dotsArr.length) return;
    pushDualUndo();
    const removedId = dotsArr[dotsArr.length - 1]?.id;
    if (side === 'before') {
      setBeforeDots((prev) => prev.slice(0, -1));
    } else {
      setAfterDots((prev) => prev.slice(0, -1));
    }
    if (removedId) setPassArrows((prev) => prev.filter((arrow) => !arrowBelongsToRemovedDot(arrow, side, removedId)));
    setSelectedDualDot(null);
  };

  const clearDualDots = (side: PitchSide) => {
    const sideDots = side === 'before' ? beforeDots : afterDots;
    if (!sideDots.length && !passArrows.some((arrow) => arrow.side === side)) return;
    pushDualUndo();
    const clearedIds = new Set(sideDots.map((dot) => dot.id).filter(Boolean));
    setPassArrows((prev) => prev.filter((arrow) => {
      if (arrow.side === side) return false;
      if (side === 'before' && arrow.startId && clearedIds.has(arrow.startId)) return false;
      return true;
    }));
    if (side === 'before') {
      setBeforeDots([]);
    } else {
      setAfterDots([]);
    }
    setSelectedDualDot(null);
  };

  const copyBeforeToAfter = () => {
    pushDualUndo();
    const { dots: nextAfterDots, idMap } = clonePitchDotsWithIdMap(beforeDots);
    // 패스·수비(상대 공 경로) 화살표 모두 after 에 동일하게 복사 (2026-07-20: 수비 제외하던 규칙 폐기)
    const nextAfterArrows = mirroredBeforeArrowsForAfter(passArrows, idMap);
    setAfterDots(nextAfterDots);
    setPassArrows((prev) => [...prev.filter((arrow) => arrow.side !== 'after'), ...nextAfterArrows]);
    setSelectedDualDot(null);
    setStatus('Before 좌표와 패스 화살표를 After로 복사했습니다');
  };

  // 현재 작업 캔버스+버퍼 비우기 (저장/새장면/불러오기 공용)
  const clearCurrentScene = () => {
    resetDualUndo();
    // 미완료 xGOT 대기가 남으면 다음 장면의 모든 입력이 가드에 막힌다 — 장면 경계에서 자동 해제(=skip)
    if (pendingXgot?.canvas === 'live') resetXgotState();
    setRows([]);
    setLogs([]);
    setPrimaryRowIndex(null);
    setSelectedRowIndex(null);
    setBeforeDots([]);
    setAfterDots([]);
    setSelectedDualDot(null);
    setPendingPass(null);
    setPendingDefStart(null);
    setPassArrows([]);
  };

  // 장면 저장: 저장 시점의 최종 before/after(+화살표)로 이 장면의 모든 액션을 재채점한 뒤 스냅샷을 savedScenes 에 append.
  //  → 코드 입력 순서와 무관하게 이동 액션(드리블/침투) 경로·획득 t/f 가 최종 좌표 기준으로 확정됨.
  const saveScene = async () => {
    if (!rows.length) {
      setStatus('저장할 액션이 없습니다');
      return;
    }
    setBusy(true);
    setStatus('장면 저장 · 최종 좌표로 재채점 중…');
    const { rows: scoredRows, logs: scoredLogs } = await rescoreSceneRows(rows, logs, {
      before: beforeDots,
      after: afterDots,
      arrows: passArrows,
      actorTeam: team,
      half,
      direction,
      timeline,
      primary: primaryRowIndex,
    });
    const snapshot: SavedScene = { rows: scoredRows, logs: scoredLogs, beforeDots, afterDots, passArrows, primary: primaryRowIndex };
    const nextBeforeDots = clonePitchDotsForNextScene(afterDots);
    // 저장으로 행이 확정되면 남은 xGOT 대기는 갱신할 행이 없다 — 해제 안 하면 다음 장면 입력이 잠김
    if (pendingXgot?.canvas === 'live') resetXgotState();
    resetDualUndo();
    setSavedScenes((prev) => [...prev, snapshot]);
    setRows([]);
    setLogs([]);
    setPrimaryRowIndex(null);
    setSelectedRowIndex(null);
    setBeforeDots(nextBeforeDots);
    setAfterDots([]);
    setSelectedDualDot(null);
    setPendingPass(null);
    setPendingDefStart(null);
    setPassArrows([]);
    setBusy(false);
    setStatus('장면 저장됨 · 최종 좌표로 재채점 완료 — After 좌표를 다음 Before로 복사했습니다');
    // 저장 버튼 클릭으로 포커스가 버튼에 남는다 — 바로 다음 코드 타이핑이 되도록 입력창으로 복귀
    requestAnimationFrame(() => statInputRef.current?.focus());
  };

  // 새 장면: 저장 안 한 현재 장면을 버리고 새로 시작
  const startNewScene = () => {
    clearCurrentScene();
    setStatus('현재 장면 비움 (미저장)');
    requestAnimationFrame(() => statInputRef.current?.focus());
  };

  // 불러오기: 선택한 저장 장면을 기록된 로그 아래 "수정용 피치"로 복원 — 라이브 캔버스(찍는 데이터)는 안 건드림
  const loadSelectedScene = () => {
    if (selectedSceneIndex == null) return;
    const scene = savedScenes[selectedSceneIndex];
    if (!scene) return;
    const header = scene.logs[0]?.split(' | ') || [];
    const nextEditHalf = header[0] === '1H' || header[0] === '2H' ? header[0] : half;
    const nextEditTeam = header[1] === 'home' || header[1] === 'away' ? header[1] : team;
    const nextEditDirection = header[2] === 'left' || header[2] === 'right' ? header[2] : direction;
    const nextEditTimeline = /^\d{1,3}:\d{2}$/.test(header[3] || '') ? header[3] : timeline;
    setEditRows(scene.rows);
    setEditLogs(scene.logs);
    setEditBeforeDots(hydrateSceneDots(scene.beforeDots, scene.logs, 'before', nextEditTeam).map((dot) => ({ ...dot })));
    setEditAfterDots(hydrateSceneDots(scene.afterDots, scene.logs, 'after', nextEditTeam).map((dot) => ({ ...dot })));
    setEditPassArrows(scene.passArrows.map((arrow) => ({ ...arrow })));
    setEditPrimary(scene.primary);
    setEditingSceneIndex(selectedSceneIndex);
    setEditSelectedDot(null);
    setEditSelectedRowIndex(null);
    // 수정용 입력값 시드: 로그 헤더(half | team | direction | timeline)에서 복원, 없으면 라이브 현재값
    setEditHalf(nextEditHalf);
    setEditTeam(nextEditTeam);
    setEditDirection(nextEditDirection);
    setEditTimeline(nextEditTimeline);
    setEditStatInput('');
    setEditPendingPass(null);
    setEditPendingDefStart(null);
    setStatus(`장면 ${selectedSceneIndex + 1} 수정용 피치로 불러옴 — 아래에서 수정 후 "수정 저장"`);
  };

  // 수정용 피치 닫기 (저장 안 한 편집은 버림 — 라이브 데이터와 무관)
  const closeSceneEditor = () => {
    setEditingSceneIndex(null);
    setEditRows([]);
    setEditLogs([]);
    setEditBeforeDots([]);
    setEditAfterDots([]);
    setEditPassArrows([]);
    setEditPrimary(null);
    setEditSelectedDot(null);
    setEditSelectedRowIndex(null);
    setEditStatInput('');
    setEditPendingPass(null);
    setEditPendingDefStart(null);
    if (pendingXgot?.canvas === 'edit') resetXgotState();
  };

  const deleteSelectedScene = () => {
    if (selectedSceneIndex == null) return;
    const removedIndex = selectedSceneIndex;
    setSavedScenes((prev) => prev.filter((_, index) => index !== removedIndex));
    setSelectedSceneIndex(null);
    if (editingSceneIndex === removedIndex) {
      closeSceneEditor();
    } else if (editingSceneIndex != null && editingSceneIndex > removedIndex) {
      setEditingSceneIndex(editingSceneIndex - 1);
    }
    setStatus(`장면 ${removedIndex + 1} 삭제됨`);
  };

  // 기록된 로그 전체 삭제 — 저장된 장면 + 현재 작업 장면(캔버스 포함) 모두 비움. 서버에 저장된 데이터는 안 건드림.
  const clearAllRecordedLogs = () => {
    if (!allLogs.length && !savedScenes.length) return;
    const detail = inputMode === 'dual'
      ? `장면 ${savedScenes.length}개 · 액션 ${allLogs.length}건`
      : `액션 ${allLogs.length}건`;
    if (!window.confirm(`기록된 로그를 전체 삭제할까요? (${detail})\n삭제하면 되돌릴 수 없습니다.`)) return;
    setSavedScenes([]);
    setSelectedSceneIndex(null);
    closeSceneEditor();
    clearCurrentScene();
    setDots([]);
    setStatus('기록된 로그 전체 삭제됨');
  };

  // 수정 저장: 편집 중 장면을 최종 좌표로 재채점 후 제자리 덮어쓰기 (순서 유지)
  const saveEditedScene = async () => {
    if (editingSceneIndex == null) return;
    if (!editRows.length) {
      setStatus('장면에 액션이 없습니다 — 빈 장면은 저장할 수 없습니다');
      return;
    }
    const savedIndex = editingSceneIndex;
    setBusy(true);
    setStatus('수정 저장 · 최종 좌표로 재채점 중…');
    const { rows: scoredRows, logs: scoredLogs } = await rescoreSceneRows(editRows, editLogs, {
      before: editBeforeDots,
      after: editAfterDots,
      arrows: editPassArrows,
      actorTeam: editTeam,
      half: editHalf,
      direction: editDirection,
      timeline: editTimeline,
      primary: editPrimary,
    });
    const snapshot: SavedScene = {
      rows: scoredRows,
      logs: scoredLogs,
      beforeDots: editBeforeDots,
      afterDots: editAfterDots,
      passArrows: editPassArrows,
      primary: editPrimary,
    };
    setSavedScenes((prev) => prev.map((scene, index) => (index === savedIndex ? snapshot : scene)));
    setBusy(false);
    setStatus(`장면 ${savedIndex + 1} 수정 저장됨 · 최종 좌표로 재채점 완료`);
    closeSceneEditor();
  };

  const handleEditPitchClick = (side: PitchSide, event: React.MouseEvent<HTMLDivElement>) => {
    const rect = (side === 'before' ? editBeforePitchRef.current : editAfterPitchRef.current)?.getBoundingClientRect();
    if (!rect) return;
    // 패스 도착점 대기 중 + 같은 프레임이면 → 새 점이 아니라 화살표 끝점 + [시작,도착] 2점으로 채점 (라이브와 동일)
    if (editPendingPass && editPendingPass.side === side) {
      const c = dotFromClientPoint(event.clientX, event.clientY, rect);
      const arrow = { side, startId: editPendingPass.startId, x1: editPendingPass.sx, y1: editPendingPass.sy, x2: c.screen_x, y2: c.screen_y, code: editPendingPass.code, rowIndex: editRows.length };
      setEditPassArrows((prev) => [...prev, arrow]);
      const start: PitchDot = { meter_x: editPendingPass.mx, meter_y: editPendingPass.my, screen_x: editPendingPass.sx, screen_y: editPendingPass.sy };
      const end: PitchDot = { meter_x: c.meter_x, meter_y: c.meter_y, screen_x: c.screen_x, screen_y: c.screen_y };
      const code = editPendingPass.code;
      setEditPendingPass(null);
      void scoreEditPass(code, start, end);
      return;
    }
    // 수비 화살표 1차 클릭 = 상대 볼 출발점 → editPendingPass 로 승격 (라이브와 동일)
    if (editPendingDefStart && editPendingDefStart.side === side) {
      const c = dotFromClientPoint(event.clientX, event.clientY, rect);
      setEditPendingPass({ code: editPendingDefStart.code, side, sx: c.screen_x, sy: c.screen_y, mx: c.meter_x, my: c.meter_y });
      setEditPendingDefStart(null);
      setStatus(`수정용: ${arrowArmHint(editPendingDefStart.code, 'end')} · Esc 취소`);
      return;
    }
    const nextDot: PitchDot = {
      id: newDotId(),
      ...dotFromClientPoint(event.clientX, event.clientY, rect),
      team: relationForTeamSide(currentLayer.teamSide, editTeam),
      teamSide: currentLayer.teamSide,
      layer: currentLayer.key,
      role: currentLayer.role,
      color: currentLayer.color,
    };
    const place = (prev: PitchDot[]) => {
      selectEditDot({ side, index: prev.length });
      return [...prev, nextDot];
    };
    if (side === 'before') setEditBeforeDots(place);
    else setEditAfterDots(place);
    requestAnimationFrame(() => editStatInputRef.current?.focus());
  };

  const removeEditDotAt = (side: PitchSide, index: number) => {
    const dotsArr = side === 'before' ? editBeforeDots : editAfterDots;
    if (index < 0 || !dotsArr[index]) return;
    const removedId = dotsArr[index]?.id;
    if (side === 'before') setEditBeforeDots((prev) => prev.filter((_, i) => i !== index));
    else setEditAfterDots((prev) => prev.filter((_, i) => i !== index));
    if (removedId) setEditPassArrows((prev) => prev.filter((arrow) => !arrowBelongsToRemovedDot(arrow, side, removedId)));
    setEditSelectedDot(null);
    setStatus('수정용 피치 점 삭제');
  };

  const removeLastEditDot = (side: PitchSide) => {
    const dotsArr = side === 'before' ? editBeforeDots : editAfterDots;
    removeEditDotAt(side, dotsArr.length - 1);
  };

  const clearEditDots = (side: PitchSide) => {
    const clearedIds = new Set((side === 'before' ? editBeforeDots : editAfterDots).map((dot) => dot.id).filter(Boolean));
    setEditPassArrows((prev) => prev.filter((arrow) => {
      if (arrow.side === side) return false;
      if (side === 'before' && arrow.startId && clearedIds.has(arrow.startId)) return false;
      return true;
    }));
    if (side === 'before') setEditBeforeDots([]);
    else setEditAfterDots([]);
    setEditSelectedDot(null);
  };

  // 수정용 장면의 액션 삭제 + primary/선택 인덱스 동기화
  const removeEditLogAt = (removedIdx: number) => {
    setEditLogs((prev) => prev.filter((_, index) => index !== removedIdx));
    setEditRows((prev) => prev.filter((_, index) => index !== removedIdx));
    setEditSelectedRowIndex((sel) => (sel == null ? null : sel === removedIdx ? null : sel > removedIdx ? sel - 1 : sel));
    setEditPrimary((p) => (p == null ? p : p === removedIdx ? null : p > removedIdx ? p - 1 : p));
    setStatus('수정용 장면 액션 삭제');
  };

  const resetXgotState = () => {
    setPendingXgot(null);
    setGoalmouthPoint(null);
    setXgotEstimate(null);
  };

  const finishXgotFlow = (message: string, canvas: 'live' | 'edit' = 'live') => {
    resetXgotState();
    if (canvas === 'live') {
      setSelectedDualDot(null);
    }
    setStatus(message);
    window.setTimeout(() => (canvas === 'edit' ? editStatInputRef : statInputRef).current?.focus(), 0);
  };

  const handleGoalmouthClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    const y = Math.min(Math.max(1 - (event.clientY - rect.top) / rect.height, 0), 1);
    const nextPoint = { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) };
    setGoalmouthPoint(nextPoint);
    setXgotEstimate(null);
    void requestXgotEstimate(nextPoint);
  };

  const skipXgotInput = () => {
    finishXgotFlow('xGOT 입력을 건너뛰고 피치로 복귀했습니다', pendingXgot?.canvas ?? 'live');
  };

  const requestXgotEstimate = async (pointOverride?: GoalmouthPoint) => {
    if (!pendingXgot) return null;
    const shotPoint = pointOverride || goalmouthPoint;
    if (!shotPoint) {
      setStatus('골문 위치를 먼저 클릭하세요');
      return null;
    }

    setXgotBusy(true);
    setStatus('xGOT 자동 계산 중');
    try {
      const response = await apiFetch('/xgot/estimate', {
        method: 'POST',
        body: JSON.stringify({
          xg: pendingXgot.xg,
          is_on_target: true,
          goalmouth_x: shotPoint.x,
          goalmouth_y: shotPoint.y,
          is_goal: pendingXgot.isGoal,
          is_header: pendingXgot.isHeader,
          is_weak_foot: pendingXgot.isWeakFoot,
          under_pressure: pendingXgot.underPressure,
          one_on_one: pendingXgot.oneOnOne,
          shot_pace_band: 'MID',
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || 'xGOT 계산 실패');
        return null;
      }

      const data = await response.json() as { xgot: number; delta: number; label: string };
      setXgotEstimate(data);
      setStatus(`xGOT=${Number(data.xgot).toFixed(3)} 자동 산출 완료`);
      return data;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'xGOT 계산 실패');
      return null;
    } finally {
      setXgotBusy(false);
    }
  };

  const submitXgotInput = async () => {
    if (!pendingXgot) return;
    const estimate = xgotEstimate || await requestXgotEstimate();
    if (!estimate) return;

    try {
      setXgotBusy(true);
      const xgot = Number(estimate.xgot).toFixed(3);
      const xg = pendingXgot.xg.toFixed(3);
      const setTargetLogs = pendingXgot.canvas === 'edit' ? setEditLogs : setLogs;
      const setTargetRows = pendingXgot.canvas === 'edit' ? setEditRows : setRows;
      setTargetLogs((prev) => prev.map((log, index) => (
        index === pendingXgot.rowIndex ? mergeMetricsIntoLog(log, { xG: xg, xGOT: xgot }) : log
      )));
      setTargetRows((prev) => prev.map((row, index) => (
        index === pendingXgot.rowIndex ? { ...row, xG: xg, xGOT: xgot } : row
      )));
      finishXgotFlow(`xGOT=${xgot} 입력 완료 (${estimate.delta >= 0 ? '+' : ''}${estimate.delta}, ${estimate.label})`, pendingXgot.canvas);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'xGOT 계산 실패');
    } finally {
      setXgotBusy(false);
    }
  };

  // 특정 코드에 대해 before/after에서 제출용 좌표를 뽑는 공용 로직 (라이브 제출 + 저장 시 재채점 공용)
  const submitDotsForCode = (code: string, before: PitchDot[], after: PitchDot[]): PitchDot[] => {
    const beforeAllies = before.filter(isAllyDot);
    const afterAllies = after.filter(isAllyDot);
    // pn/dribble 등 이동 액션: 첫 ally([0])가 아니라 코드 앞번호(행위자)와 일치하는 점을 before·after에서 골라 변위 계산
    const actorNum = code.trim().match(/^(\d+)/)?.[1];
    const pickActor = (arr: PitchDot[]) => (actorNum && arr.find((dot) => dot.number === actorNum)) || arr[0];
    if (statInputHasReceiver(code) && beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    // 이동 액션은 시작=before 행위자, 도착=after 행위자. 입력 시점엔 after 가 아직 없으므로
    // [시작, 시작] 으로 임시 채점하고, 장면 저장 시 rescoreSceneRows 가 프레임으로 확정한다.
    if (statInputIsMoveAction(code)) {
      const start = beforeAllies.length ? pickActor(beforeAllies) : pickActor(afterAllies);
      if (!start) return [];
      const end = beforeAllies.length && afterAllies.length ? pickActor(afterAllies) : start;
      return [start, end];
    }
    if (beforeAllies.length && afterAllies.length) return [pickActor(beforeAllies), pickActor(afterAllies)];
    if (beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    if (afterAllies.length >= 2) return afterAllies.slice(0, 2);
    return [...beforeAllies, ...afterAllies];
  };

  const buildDualSubmitDots = () => {
    if (inputMode !== 'dual') return dots;
    return submitDotsForCode(statInput, beforeDots, afterDots);
  };

  // 패스/크로스 채점: 시작 점 + 도착점(클릭) 2점 → codex /fpa/logs/generate
  const scorePass = async (code: string, start: PitchDot, end: PitchDot) => {
    setBusy(true);
    setStatus('패스 채점 중');
    try {
      const nextRowIndex = rows.length;
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: code,
          dots: [toPayloadDot(start, team), toPayloadDot(end, team)],
          dual_pitch: buildDualPitchPayload(),
          half,
          team,
          direction,
          timeline,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || '패스 채점 실패');
        return;
      }
      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = code;
      setLogs((prev) => [...prev, data.log_text]);
      setRows((prev) => {
        const next = [...prev, data.log_data];
        setSelectedRowIndex(next.length - 1);
        return next;
      });
      setPrimaryRowIndex((prev) => (prev == null ? nextRowIndex : prev));
      setStatus('패스 화살표 완성 · 채점됨');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '패스 채점 실패');
    } finally {
      setBusy(false);
    }
  };

  // 화살표 screen 좌표(0~1050 / 0~680) → meter dot 역변환 (dotFromClientPoint 의 역)
  const screenToMeterDot = (sx: number, sy: number): PitchDot => ({
    meter_x: Number(((sx / 1050) * 105).toFixed(2)),
    meter_y: Number((((680 - sy) / 680) * 68).toFixed(2)),
    screen_x: sx,
    screen_y: sy,
  });

  // 패스 화살표 도착점을 드래그로 옮긴 뒤 놓을 때 → 해당 로그 행을 새 [시작,도착]으로 재채점(제자리 교체)
  const rescorePassArrow = async (canvas: 'live' | 'edit', arrow: PassArrow) => {
    if (arrow.code == null || arrow.rowIndex == null) return;
    const isEdit = canvas === 'edit';
    const actorTeam = isEdit ? editTeam : team;
    const start = screenToMeterDot(arrow.x1, arrow.y1);
    const end = screenToMeterDot(arrow.x2, arrow.y2);
    setBusy(true);
    setStatus('화살표 이동 → 재채점 중');
    try {
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: arrow.code,
          dots: [toPayloadDot(start, actorTeam), toPayloadDot(end, actorTeam)],
          dual_pitch: isEdit ? buildEditDualPitchPayload() : buildDualPitchPayload(),
          half: isEdit ? editHalf : half,
          team: actorTeam,
          direction: isEdit ? editDirection : direction,
          timeline: isEdit ? editTimeline : timeline,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || '재채점 실패');
        return;
      }
      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = arrow.code;
      const ri = arrow.rowIndex;
      (isEdit ? setEditLogs : setLogs)((prev) => prev.map((entry, idx) => (idx === ri ? data.log_text : entry)));
      (isEdit ? setEditRows : setRows)((prev) => prev.map((row, idx) => (idx === ri ? data.log_data : row)));
      setStatus('화살표 이동 · 재채점 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '재채점 실패');
    } finally {
      setBusy(false);
    }
  };

  // 장면 저장 시 호출 — 그 장면의 모든 행을 현재(최종) before/after(+패스 화살표) 기준으로 재채점해 교체본을 반환.
  //  · 패스/크로스: 연결된 화살표(rowIndex)의 시작·도착 좌표 사용
  //  · 그 외(이동/점 액션): submitDotsForCode 로 before/after에서 코드 기반 좌표 재선택
  //  · StatInput 없는 행(옛 데이터/xGOT 등)은 임시값 그대로 유지
  const rescoreSceneRows = async (
    sceneRows: LogPreview[],
    sceneLogs: string[],
    ctx: {
      before: PitchDot[];
      after: PitchDot[];
      arrows: PassArrow[];
      actorTeam: 'home' | 'away';
      half: string;
      direction: 'left' | 'right';
      timeline: string;
      primary: number | null;
    },
  ): Promise<{ rows: LogPreview[]; logs: string[] }> => {
    const dualPayload = {
      actor_team: ctx.actorTeam,
      primary_row_index: ctx.primary,
      input_tier: ctx.before.length + ctx.after.length >= 6 ? 'recommended' : 'minimal',
      before: { dots: ctx.before.map((dot) => toPayloadDot(dot, ctx.actorTeam)) },
      after: { dots: ctx.after.map((dot) => toPayloadDot(dot, ctx.actorTeam)) },
    };
    const nextRows = [...sceneRows];
    const nextLogs = [...sceneLogs];
    for (let i = 0; i < sceneRows.length; i += 1) {
      const code = sceneRows[i].StatInput;
      if (!code) continue;
      const arrow = ctx.arrows.find((item) => item.rowIndex === i);
      const dotsForRow = arrow
        ? [screenToMeterDot(arrow.x1, arrow.y1), screenToMeterDot(arrow.x2, arrow.y2)]
        : submitDotsForCode(code, ctx.before, ctx.after);
      if (!dotsForRow.length) continue;
      try {
        const response = await apiFetch('/fpa/logs/generate', {
          method: 'POST',
          body: JSON.stringify({
            stat_input: code,
            dots: dotsForRow.map((dot) => toPayloadDot(dot, ctx.actorTeam)),
            dual_pitch: dualPayload,
            half: ctx.half,
            team: ctx.actorTeam,
            direction: ctx.direction,
            timeline: ctx.timeline,
          }),
        });
        if (!response.ok) continue;
        const data = await response.json() as { log_text: string; log_data: LogPreview };
        data.log_data.StatInput = code;
        // xGOT는 백엔드 채점이 만들지 않음(골문클릭 플로우에서 나중에 채워짐) → 재채점이 덮어쓰지 않게 기존값 보존
        if (sceneRows[i].xGOT) data.log_data.xGOT = sceneRows[i].xGOT;
        nextRows[i] = data.log_data;
        nextLogs[i] = data.log_text;
      } catch {
        // 개별 행 재채점 실패는 임시값 유지 (전체 저장은 계속)
      }
    }
    return { rows: nextRows, logs: nextLogs };
  };

  const buildDualPitchPayload = () => {
    if (inputMode !== 'dual') return undefined;
    return {
      actor_team: team,
      primary_row_index: primaryRowIndex,
      input_tier: beforeDots.length + afterDots.length >= 6 ? 'recommended' : 'minimal',
      before: {
        dots: beforeDots.map((dot) => toPayloadDot(dot, team)),
      },
      after: {
        dots: afterDots.map((dot) => toPayloadDot(dot, team)),
      },
    };
  };

  // ── 수정용 피치 채점 경로 — 라이브 addLog/scorePass 미러, 대상만 edit 상태 ──

  const buildEditSubmitDots = () => {
    const beforeAllies = editBeforeDots.filter(isAllyDot);
    const afterAllies = editAfterDots.filter(isAllyDot);
    const actorNum = editStatInput.trim().match(/^(\d+)/)?.[1];
    const pickActor = (arr: PitchDot[]) => (actorNum && arr.find((dot) => dot.number === actorNum)) || arr[0];
    if (statInputHasReceiver(editStatInput) && beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    if (beforeAllies.length && afterAllies.length) return [pickActor(beforeAllies), pickActor(afterAllies)];
    if (beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    if (afterAllies.length >= 2) return afterAllies.slice(0, 2);
    return [...beforeAllies, ...afterAllies];
  };

  const buildEditDualPitchPayload = () => ({
    actor_team: editTeam,
    primary_row_index: editPrimary,
    input_tier: editBeforeDots.length + editAfterDots.length >= 6 ? 'recommended' : 'minimal',
    before: {
      dots: editBeforeDots.map((dot) => toPayloadDot(dot, editTeam)),
    },
    after: {
      dots: editAfterDots.map((dot) => toPayloadDot(dot, editTeam)),
    },
  });

  const adjustEditTimeline = (deltaSeconds: number) => {
    const [minutesRaw, secondsRaw] = editTimeline.split(':');
    const minutes = Number(minutesRaw || 0);
    const seconds = Number(secondsRaw || 0);
    const next = Math.max(0, minutes * 60 + seconds + deltaSeconds);
    const mm = String(Math.floor(next / 60)).padStart(2, '0');
    const ss = String(next % 60).padStart(2, '0');
    setEditTimeline(`${mm}:${ss}`);
  };

  const scoreEditPass = async (code: string, start: PitchDot, end: PitchDot) => {
    setBusy(true);
    setStatus('수정용 장면 패스 채점 중');
    try {
      const nextRowIndex = editRows.length;
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: code,
          dots: [toPayloadDot(start, editTeam), toPayloadDot(end, editTeam)],
          dual_pitch: buildEditDualPitchPayload(),
          half: editHalf,
          team: editTeam,
          direction: editDirection,
          timeline: editTimeline,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || '패스 채점 실패');
        return;
      }
      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = code;
      setEditLogs((prev) => [...prev, data.log_text]);
      setEditRows((prev) => {
        const next = [...prev, data.log_data];
        setEditSelectedRowIndex(next.length - 1);
        return next;
      });
      setEditPrimary((prev) => (prev == null ? nextRowIndex : prev));
      setStatus('수정용 장면에 패스 추가 · 채점됨');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '패스 채점 실패');
    } finally {
      setBusy(false);
    }
  };

  const addEditLog = async () => {
    if (!editStatInput.trim()) return;
    if (pendingXgot) {
      setStatus('진행 중인 xGOT 입력을 먼저 완료하세요');
      return;
    }
    if (statInputIsNumberOnly(editStatInput)) {
      assignNumberToEditSelectedDot(editStatInput.trim());
      return;
    }
    // 수비(태클/인터셉트/차단/블록) = 상대 공 경로를 Before 에 화살표로 (라이브와 동일)
    if (statInputIsDefenseArrow(editStatInput)) {
      const code = editStatInput.trim();
      // 수비 행위자 번호를 선택된 아군 점에 반영 (라이브와 동일)
      const actorNum = code.match(/^(\d+)/)?.[1];
      const actorSel = editSelectedDot;
      const actorTarget = actorSel ? (actorSel.side === 'before' ? editBeforeDots : editAfterDots)[actorSel.index] : undefined;
      if (actorSel && actorNum && actorTarget && isAllyDot(actorTarget)) {
        const assign = (prev: PitchDot[]) =>
          prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
        if (actorSel.side === 'before') setEditBeforeDots(assign);
        else setEditAfterDots(assign);
      }
      setEditPendingDefStart({ code, side: 'before' });
      setEditStatInput('');
      setStatus(`수정용 Before: ${arrowArmHint(code, 'start')} · Esc 취소`);
      return;
    }
    // 패스/크로스(받는번호 O) = 시작 점 선택 후 도착점 클릭까지 채점 지연 (라이브와 동일)
    if (statInputHasReceiver(editStatInput)) {
      const sel = editSelectedDot;
      const dotsArr = sel?.side === 'before' ? editBeforeDots : editAfterDots;
      const startDot = sel ? dotsArr[sel.index] : undefined;
      if (!sel || !startDot) {
        setStatus('수정용 피치에서 패스 시작 점을 먼저 찍으세요');
        return;
      }
      if (!isAllyDot(startDot)) {
        setStatus('패스 시작 점은 아군 점이어야 합니다 (상대 점 선택됨)');
        return;
      }
      const actorNum = editStatInput.trim().match(/^(\d+)/)?.[1];
      if (actorNum) {
        const assign = (prev: PitchDot[]) => prev.map((dot, index) => (index === sel.index ? { ...dot, number: actorNum } : dot));
        if (sel.side === 'before') setEditBeforeDots(assign);
        else setEditAfterDots(assign);
      }
      setEditPendingPass({ code: editStatInput, side: sel.side, startId: startDot.id, sx: startDot.screen_x, sy: startDot.screen_y, mx: startDot.meter_x, my: startDot.meter_y });
      setEditStatInput('');
      setStatus('수정용 피치에서 패스 도착점을 클릭하세요 (화살표 · Esc 취소)');
      return;
    }
    setBusy(true);
    setStatus('수정용 장면 로그 생성 중');
    const requestedStatInput = editStatInput;
    const nextRowIndex = editRows.length;

    try {
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: editStatInput,
          dots: buildEditSubmitDots().map((dot) => toPayloadDot(dot, editTeam)),
          dual_pitch: buildEditDualPitchPayload(),
          half: editHalf,
          team: editTeam,
          direction: editDirection,
          timeline: editTimeline,
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || '로그 생성 실패');
        return;
      }

      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = requestedStatInput;
      setEditLogs((prev) => [...prev, data.log_text]);
      setEditRows((prev) => {
        const nextRows = [...prev, data.log_data];
        setEditSelectedRowIndex(nextRows.length - 1);
        return nextRows;
      });
      setEditStatInput('');
      const promptXgot = shouldPromptXgot(requestedStatInput, data.log_data);
      const rawXg = Number(data.log_data.xG || extractMetricValue(data.log_text, 'xG') || 0);
      if (promptXgot && Number.isFinite(rawXg)) {
        const tags = data.log_data.Tags || '';
        setPendingXgot({
          canvas: 'edit',
          rowIndex: nextRowIndex,
          xg: Math.min(Math.max(rawXg, 0), 1),
          isGoal: extractActionCode(requestedStatInput) === 'ddd' || tags.includes('Goal'),
          isHeader: tags.includes('Header'),
          isWeakFoot: tags.includes('Weak Foot'),
          underPressure: tags.includes('Under Pressure'),
          oneOnOne: tags.includes('One-on-One') || tags.includes('1v1'),
        });
        setGoalmouthPoint(null);
        setXgotEstimate(null);
        setStatus('유효슈팅 로그 추가 완료. 골문 위치를 클릭해 xGOT를 입력하세요');
        return;
      }
      setEditPrimary((prev) => (prev == null ? nextRowIndex : prev));
      // 비패스 액션: 선택된 점에 행위자 번호 지정 (패스는 도착점 클릭으로 별도 처리)
      const actorNum = requestedStatInput.trim().match(/^(\d+)/)?.[1];
      const actorSel = editSelectedDot;
      const actorTarget = actorSel ? (actorSel.side === 'before' ? editBeforeDots : editAfterDots)[actorSel.index] : undefined;
      const actorOnOpponent = !!(actorSel && actorNum && actorTarget && !isAllyDot(actorTarget));
      if (actorSel && actorNum && actorTarget && isAllyDot(actorTarget)) {
        const assign = (prev: PitchDot[]) =>
          prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
        if (actorSel.side === 'before') setEditBeforeDots(assign);
        else setEditAfterDots(assign);
      }
      setStatus(actorOnOpponent
        ? '액션 추가됨 · 행위자 번호는 상대 점에 안 붙었습니다 — 아군 점 선택 후 재지정하세요'
        : '수정용 장면에 액션 추가 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      // 패스 화살표 끝점 드래그 — 점과 분리, 화살표만 이동
      const arrowDrag = draggingArrowRef.current;
      if (arrowDrag) {
        const isEditArrow = arrowDrag.canvas === 'edit';
        const arrowRef = arrowDrag.side === 'before'
          ? (isEditArrow ? editBeforePitchRef.current : beforePitchRef.current)
          : (isEditArrow ? editAfterPitchRef.current : afterPitchRef.current);
        const arrowRect = arrowRef?.getBoundingClientRect();
        if (!arrowRect) return;
        // 실제로 움직이기 시작한 첫 순간에만 undo 스냅샷 (클릭만으로는 안 쌓음)
        if (!arrowDrag.moved && !isEditArrow) pushDualUndo();
        arrowDrag.moved = true;
        const coords = dotFromClientPoint(event.clientX, event.clientY, arrowRect);
        (isEditArrow ? setEditPassArrows : setPassArrows)((prev) => prev.map((arrow, idx) => {
          if (idx !== arrowDrag.index) return arrow;
          return arrowDrag.end === 'end'
            ? { ...arrow, x2: coords.screen_x, y2: coords.screen_y }
            : { ...arrow, x1: coords.screen_x, y1: coords.screen_y };
        }));
        return;
      }
      const dragging = draggingDualDotRef.current;
      if (!dragging) return;
      const isEdit = dragging.canvas === 'edit';
      const ref = dragging.side === 'before'
        ? (isEdit ? editBeforePitchRef.current : beforePitchRef.current)
        : (isEdit ? editAfterPitchRef.current : afterPitchRef.current);
      const rect = ref?.getBoundingClientRect();
      if (!rect) return;
      const currentDots = dragging.side === 'before'
        ? (isEdit ? editBeforeDots : beforeDots)
        : (isEdit ? editAfterDots : afterDots);
      const existing = currentDots[dragging.index];
      if (!existing) return;
      if (!dragging.historyPushed) {
        if (!isEdit) pushDualUndo();
        dragging.historyPushed = true;
      }
      const coords = dotFromClientPoint(event.clientX, event.clientY, rect);
      // 위치만 갱신 — team/role/color/number/id 보존 (안 하면 레이어 색 사라져 홈/어웨이 뒤바뀐 듯 보임)
      (isEdit ? updateEditDot : updateDualDot)(dragging.side, dragging.index, { ...existing, ...coords });
      // 그 점에서 출발하는 패스 화살표 시작점도 따라 이동
      if (existing.id) {
        (isEdit ? setEditPassArrows : setPassArrows)((prev) => prev.map((arrow) =>
          arrow.startId === existing.id && (arrow.side === dragging.side || dragging.side === 'before')
            ? { ...arrow, x1: coords.screen_x, y1: coords.screen_y }
            : arrow));
      }
    };

    const handlePointerUp = () => {
      draggingDualDotRef.current = null;
      draggingArrowRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [afterDots, beforeDots, editAfterDots, editBeforeDots]);

  const syncTeam = (nextTeam: 'home' | 'away') => {
    if (nextTeam === team) return;
    setTeam(nextTeam);
    setDirection((prev) => (prev === 'right' ? 'left' : 'right'));
  };

  const addLog = async () => {
    if (!statInput.trim()) return;
    if (pendingXgot) {
      setStatus('진행 중인 xGOT 입력을 먼저 완료하세요');
      return;
    }
    if (inputMode === 'dual' && statInputIsNumberOnly(statInput)) {
      assignNumberToLiveSelectedDot(statInput.trim());
      return;
    }
    // 수비(태클/인터셉트/차단/블록) = 상대 공 경로를 Before 에 화살표로. 코드 입력 후 2번 클릭(출발점→끊은지점)
    if (inputMode === 'dual' && statInputIsDefenseArrow(statInput)) {
      const code = statInput.trim();
      // 수비 행위자 번호(예: 4q의 4)는 방금 찍은(선택된) 아군 점에 반영 — 화살표는 상대 공 경로라 점과 별개
      const actorNum = code.match(/^(\d+)/)?.[1];
      const actorSel = selectedDualDot;
      const actorTarget = actorSel ? (actorSel.side === 'before' ? beforeDots : afterDots)[actorSel.index] : undefined;
      if (actorSel && actorNum && actorTarget && isAllyDot(actorTarget)) {
        const assign = (prev: PitchDot[]) =>
          prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
        if (actorSel.side === 'before') setBeforeDots(assign);
        else setAfterDots(assign);
      }
      setPendingDefStart({ code, side: 'before' });
      setStatInput('');
      setStatus(`Before: ${arrowArmHint(code, 'start')} · Esc 취소`);
      return;
    }
    // 패스/크로스(받는번호 O) = 2점(시작·도착). 점 1개만 찍고 코드 입력 → 채점은 도착점 클릭 시 (xFP/fpa)
    if (inputMode === 'dual' && statInputHasReceiver(statInput)) {
      const actorNum = statInput.trim().match(/^(\d+)/)?.[1];
      let side: PitchSide | undefined = selectedDualDot?.side;
      let startIndex: number | undefined = selectedDualDot?.index;
      let startDot =
        side != null && startIndex != null ? (side === 'before' ? beforeDots : afterDots)[startIndex] : undefined;
      // 선택이 없으면(예: 장면 저장 후 after→before 복사 직후) 코드의 행위자 번호로 시작 점 탐색 → 그 점에서 화살표 시작
      if (!startDot && actorNum) {
        const bIdx = beforeDots.findIndex((dot) => isAllyDot(dot) && dot.number === actorNum);
        if (bIdx >= 0) {
          side = 'before';
          startIndex = bIdx;
          startDot = beforeDots[bIdx];
        } else {
          const aIdx = afterDots.findIndex((dot) => isAllyDot(dot) && dot.number === actorNum);
          if (aIdx >= 0) {
            side = 'after';
            startIndex = aIdx;
            startDot = afterDots[aIdx];
          }
        }
      }
      if (!startDot || side == null || startIndex == null) {
        setStatus('패스 시작 점을 먼저 찍으세요 (또는 시작 선수 번호가 찍혀 있어야 합니다)');
        return;
      }
      if (!isAllyDot(startDot)) {
        setStatus('패스 시작 점은 아군 점이어야 합니다 (상대 점 선택됨)');
        return;
      }
      if (actorNum) {
        const idx = startIndex;
        const targetSide = side;
        const assign = (prev: PitchDot[]) => prev.map((dot, index) => (index === idx ? { ...dot, number: actorNum } : dot));
        if (targetSide === 'before') setBeforeDots(assign);
        else setAfterDots(assign);
      }
      setPendingPass({ code: statInput, side, startId: startDot.id, sx: startDot.screen_x, sy: startDot.screen_y, mx: startDot.meter_x, my: startDot.meter_y });
      setStatInput('');
      setStatus('패스 도착점을 클릭하세요 (화살표 · Esc 취소)');
      return;
    }
    setBusy(true);
    setStatus('로그 생성 중');
    const requestedStatInput = statInput;
    const nextRowIndex = rows.length;

    try {
      const submitDots = buildDualSubmitDots();
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: statInput,
          dots: submitDots.map((dot) => toPayloadDot(dot, team)),
          dual_pitch: buildDualPitchPayload(),
          half,
          team,
          direction,
          timeline,
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || '로그 생성 실패');
        return;
      }

      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = requestedStatInput;
      if (inputMode === 'dual') pushDualUndo();
      setLogs((prev) => [...prev, data.log_text]);
      setRows((prev) => {
        const nextRows = [...prev, data.log_data];
        setSelectedRowIndex(nextRows.length - 1);
        return nextRows;
      });
      setStatInput('');
      const promptXgot = inputMode === 'dual' && shouldPromptXgot(requestedStatInput, data.log_data);
      const rawXg = Number(data.log_data.xG || extractMetricValue(data.log_text, 'xG') || 0);
      if (promptXgot && Number.isFinite(rawXg)) {
        const tags = data.log_data.Tags || '';
        setPendingXgot({
          canvas: 'live',
          rowIndex: nextRowIndex,
          xg: Math.min(Math.max(rawXg, 0), 1),
          isGoal: extractActionCode(requestedStatInput) === 'ddd' || tags.includes('Goal'),
          isHeader: tags.includes('Header'),
          isWeakFoot: tags.includes('Weak Foot'),
          underPressure: tags.includes('Under Pressure'),
          oneOnOne: tags.includes('One-on-One') || tags.includes('1v1'),
        });
        setGoalmouthPoint(null);
        setXgotEstimate(null);
        setStatus('유효슈팅 로그 추가 완료. 골문 위치를 클릭해 xGOT를 입력하세요');
        return;
      }
      if (inputMode === 'dual') {
        // 좌표(점)는 유지 — 같은 장면에 액션 계속 누적. 초기화는 "새 장면"에서만 (xFP/fpa)
        setPrimaryRowIndex((prev) => (prev == null ? nextRowIndex : prev));
        // 비패스 액션: 방금 찍은(선택된) 점에 행위자 번호 지정 (패스는 위에서 도착점 클릭으로 별도 처리)
        const actorNum = requestedStatInput.trim().match(/^(\d+)/)?.[1];
        const actorSel = selectedDualDot;
        const actorTarget = actorSel ? (actorSel.side === 'before' ? beforeDots : afterDots)[actorSel.index] : undefined;
        // 행위자 번호는 아군 점에만 — 상대(away) 점 선택 시 지정 스킵(오염 방지)
        const actorOnOpponent = !!(actorSel && actorNum && actorTarget && !isAllyDot(actorTarget));
        if (actorSel && actorNum && actorTarget && isAllyDot(actorTarget)) {
          const assign = (prev: PitchDot[]) =>
            prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
          if (actorSel.side === 'before') setBeforeDots(assign);
          else setAfterDots(assign);
        }
        setStatus(actorOnOpponent
          ? '로그 추가됨 · 단 행위자 번호는 상대 점에 안 붙었습니다 — 아군 점 선택 후 재지정하세요'
          : '로그 추가 완료');
      } else {
        setDots([]);
        setStatus('로그 추가 완료');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  const exportWorkbook = async () => {
    if (!allLogs.length) return;
    setBusy(true);
    setStatus('분석 파일 생성 중');

    try {
      const response = await apiFetch('/fpa/analyze/export', {
        method: 'POST',
        body: JSON.stringify({
          logs: allLogs,
          rows: buildRowsForPersistence(),
          match_id: matchId,
          teamid_h: teamIdH,
          teamid_a: teamIdA,
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || '엑셀 생성 실패');
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const disposition = response.headers.get('content-disposition') || '';
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
      link.href = url;
      link.download = fileNameMatch?.[1] || 'fpa_live_analyzed_data.xlsx';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setStatus('분석 및 내보내기 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '엑셀 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  const importWorkbook = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setStatus('기존 FPA 로그를 불러오는 중');

    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_BASE}/fpa/logs/import`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!response.ok) {
        setStatus((await response.text()) || '로그 불러오기 실패');
        return;
      }

      const data = await response.json() as {
        logs: string[];
        rows: LogPreview[];
        match_id: string;
        teamid_h: string;
        teamid_a: string;
      };
      const importedLogs = data.logs || [];
      const importedRows = data.rows || [];
      const persistedScenes = scenesFromPersistedRows(importedRows, importedLogs, team);
      const dualScene = sceneFromDualLogs(importedRows, importedLogs, team);
      if (persistedScenes.length) {
        setInputMode('dual');
        setSavedScenes(persistedScenes);
        setSelectedSceneIndex(0);
        setLogs([]);
        setRows([]);
        setBeforeDots([]);
        setAfterDots([]);
        setPassArrows([]);
        setPrimaryRowIndex(null);
        closeSceneEditor();
      } else if (dualScene) {
        setInputMode('dual');
        setSavedScenes([dualScene]);
        setSelectedSceneIndex(0);
        setLogs([]);
        setRows([]);
        setBeforeDots([]);
        setAfterDots([]);
        setPassArrows([]);
        setPrimaryRowIndex(null);
        closeSceneEditor();
      } else {
        setLogs(importedLogs);
        setRows(importedRows);
        setSelectedRowIndex(importedRows.length ? 0 : null);
        setSavedScenes([]);
        closeSceneEditor();
      }
      resetDualUndo();
      if (data.match_id) setMatchId(data.match_id);
      if (data.teamid_h) setTeamIdH(data.teamid_h);
      if (data.teamid_a) setTeamIdA(data.teamid_a);
      setStatus(`로그 ${data.logs?.length || 0}건 불러오기 완료`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 불러오기 실패');
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
      setBusy(false);
    }
  };

  const openMatchPicker = async () => {
    setMatchPickerOpen(true);
    setMatchFilterClass('ALL');
    setMatchFilterRound('ALL');
    setStatus('경기 목록 불러오는 중');
    try {
      const data = await apiJson<Match[]>('/matches');
      setAvailableMatches(Array.isArray(data) ? data : []);
      setStatus('경기 선택 준비됨');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '경기 목록 불러오기 실패');
    }
  };

  const loadMatch = async (match: Match) => {
    setBusy(true);
    setStatus('경기와 저장된 FPA 로그 불러오는 중');
    try {
      const teams = parseMatchTeams(match);
      setMatchId(match.id);
      setTeamIdH(teams.home);
      setTeamIdA(teams.away);

      const saved = await apiJson<{
        logs: string[];
        rows: LogPreview[];
        teamid_h: string;
        teamid_a: string;
      }>(`/fpa/matches/${match.id}/logs`);
      const savedLogs = saved.logs || [];
      const savedRows = saved.rows || [];
      const persistedScenes = scenesFromPersistedRows(savedRows, savedLogs, team);
      const dualScene = sceneFromDualLogs(savedRows, savedLogs, team);
      if (persistedScenes.length) {
        setInputMode('dual');
        setSavedScenes(persistedScenes);
        setSelectedSceneIndex(0);
        setLogs([]);
        setRows([]);
        setSelectedRowIndex(null);
      } else if (dualScene) {
        setInputMode('dual');
        setSavedScenes([dualScene]);
        setSelectedSceneIndex(0);
        setLogs([]);
        setRows([]);
        setSelectedRowIndex(null);
      } else {
        setLogs(savedLogs);
        setRows(savedRows);
        setSelectedRowIndex(savedRows.length ? 0 : null);
        // 불러온 경기 로그는 현재 버퍼로 (장면 구조 없음). scene/수정용 피치 상태 초기화.
        setSavedScenes([]);
        setSelectedSceneIndex(null);
      }
      closeSceneEditor();
      resetDualUndo();
      setPrimaryRowIndex(null);
      setPendingPass(null);
      setPendingDefStart(null);
      setPassArrows([]);
      if (saved.teamid_h) setTeamIdH(saved.teamid_h);
      if (saved.teamid_a) setTeamIdA(saved.teamid_a);
      setMatchPickerOpen(false);
      setStatus(saved.logs?.length ? `저장된 FPA 로그 ${saved.logs.length}건 불러오기 완료` : '경기 정보 불러오기 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '경기 불러오기 실패');
    } finally {
      setBusy(false);
    }
  };

  const saveLogsToMatch = async () => {
    if (!allLogs.length) {
      setStatus('저장할 로그가 없습니다');
      return;
    }
    const rawMatchId = matchId.trim();
    const matchIdForSave = rawMatchId && rawMatchId !== 'ID' ? rawMatchId : generateMatchId();
    const generatedMatchId = matchIdForSave !== rawMatchId;
    const nextMatchIdError = validateMatchIdForSave(matchIdForSave);
    setMatchIdError(nextMatchIdError);
    if (nextMatchIdError) {
      setStatus(nextMatchIdError);
      return;
    }
    const homeTeamForSave = teamIdH.trim() || 'Home';
    const awayTeamForSave = teamIdA.trim() || 'Away';
    setBusy(true);
    setStatus(generatedMatchId ? '랜덤 Match ID 생성 후 FPA 로그 DB 저장 중' : 'FPA 로그 DB 저장 중');
    try {
      const response = await apiFetch(`/fpa/matches/${encodeURIComponent(matchIdForSave)}/logs`, {
        method: 'PUT',
        body: JSON.stringify({
          logs: allLogs,
          rows: buildRowsForPersistence(),
          teamid_h: homeTeamForSave,
          teamid_a: awayTeamForSave,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || 'FPA 로그 저장 실패');
        return;
      }
      setMatchId(matchIdForSave);
      setTeamIdH(homeTeamForSave);
      setTeamIdA(awayTeamForSave);
      setStatus(generatedMatchId ? `FPA 로그 ${allLogs.length}건 저장 완료 · Match ID 자동 생성됨` : `FPA 로그 ${allLogs.length}건 저장 완료`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'FPA 로그 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  // 현재 버퍼(현재 장면/single 로그)에서 특정 인덱스 액션 삭제 + primary/선택 동기화
  const removeLogAt = (removedIdx: number) => {
    if (inputMode === 'dual') pushDualUndo();
    setLogs((prev) => prev.filter((_, index) => index !== removedIdx));
    setRows((prev) => prev.filter((_, index) => index !== removedIdx));
    setSelectedRowIndex((sel) => (sel == null ? null : sel === removedIdx ? null : sel > removedIdx ? sel - 1 : sel));
    setPrimaryRowIndex((p) => (p == null ? p : p === removedIdx ? null : p > removedIdx ? p - 1 : p));
    setStatus('액션 삭제');
  };

  const removeSelectedLog = () => {
    if (selectedRowIndex == null) return;
    removeLogAt(selectedRowIndex);
  };

  const moveSelectedLog = (directionDelta: -1 | 1) => {
    if (selectedRowIndex == null) return;
    const nextIndex = selectedRowIndex + directionDelta;
    if (nextIndex < 0 || nextIndex >= rows.length) return;

    const reorder = <T,>(items: T[]) => {
      const nextItems = [...items];
      const [picked] = nextItems.splice(selectedRowIndex, 1);
      nextItems.splice(nextIndex, 0, picked);
      return nextItems;
    };

    if (inputMode === 'dual') pushDualUndo();
    setLogs((prev) => reorder(prev));
    setRows((prev) => reorder(prev));
    setSelectedRowIndex(nextIndex);
    // scene 인덱스 동기화 (인접 swap)
    const swap = (i: number) => (i === selectedRowIndex ? nextIndex : i === nextIndex ? selectedRowIndex : i);
    setPrimaryRowIndex((p) => (p == null ? p : swap(p)));
    setStatus(directionDelta < 0 ? '선택한 로그를 위로 이동' : '선택한 로그를 아래로 이동');
  };

  const adjustTimeline = (deltaSeconds: number) => {
    const [minutesRaw, secondsRaw] = timeline.split(':');
    const minutes = Number(minutesRaw || 0);
    const seconds = Number(secondsRaw || 0);
    const next = Math.max(0, minutes * 60 + seconds + deltaSeconds);
    const mm = String(Math.floor(next / 60)).padStart(2, '0');
    const ss = String(next % 60).padStart(2, '0');
    setTimeline(`${mm}:${ss}`);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      // Esc 취소는 어느 입력칸에 포커스가 있든 동작해야 함 (코드 입력 직후가 대부분)
      if (event.key === 'Escape' && (pendingPass || pendingDefStart || editPendingPass || editPendingDefStart)) {
        event.preventDefault();
        cancelArrowDraw();
        return;
      }
      // ⌘Z/Ctrl+Z = 라이브 dual 캔버스 undo. 입력칸에 지울 텍스트가 있으면 브라우저 기본 undo 우선
      if (inputMode === 'dual' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') {
        if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value) return;
        event.preventDefault();
        undoDual();
        return;
      }
      if (target instanceof HTMLElement && target.tagName === 'INPUT' && target.id !== 'fpa-live-timeline' && target.id !== 'fpa-live-stat-input') {
        return;
      }
      const isTextEntryTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (inputMode === 'dual' && !isTextEntryTarget) {
        const eventHotkey = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
        const layer = DUAL_LAYERS.find((entry) => entry.hotkey === eventHotkey);
        if (layer) {
          event.preventDefault();
          setActiveLayer(layer.key);
          setStatus(`레이어: ${layer.label}`);
          return;
        }
      }

      if (
        inputMode === 'dual' &&
        editSelectedDot &&
        (event.key === 'Backspace' || event.key === 'Delete') &&
        !isTextEntryTarget
      ) {
        event.preventDefault();
        removeEditDotAt(editSelectedDot.side, editSelectedDot.index);
        return;
      }

      if (
        inputMode === 'dual' &&
        selectedDualDot &&
        (event.key === 'Backspace' || event.key === 'Delete') &&
        !isTextEntryTarget
      ) {
        event.preventDefault();
        removeSelectedDualDot();
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        event.preventDefault();
        adjustTimeline(60);
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        event.preventDefault();
        adjustTimeline(-60);
        return;
      }

      if (event.key === 'Enter' && document.activeElement?.id === 'fpa-live-stat-input') {
        event.preventDefault();
        void addLog();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [afterDots, beforeDots, busy, direction, dots, activeLayer, editAfterDots, editBeforeDots, editPendingDefStart, editPendingPass, editSelectedDot, half, inputMode, pendingDefStart, pendingPass, pendingXgot, rows.length, selectedDualDot, statInput, team, timeline]);

  const renderXgotPanel = () => {
    if (!pendingXgot) return null;
    return (
      <div className="fpa-xgot-panel">
        <div className="fpa-xgot-summary">
          <div>
            <span>xG</span>
            <strong>{pendingXgot.xg.toFixed(3)}</strong>
          </div>
          <div>
            <span>Shot</span>
            <strong>{pendingXgot.isGoal ? 'Goal' : 'On Target'}</strong>
          </div>
          <div>
            <span>xGOT</span>
            <strong>{xgotBusy ? '...' : xgotEstimate ? xgotEstimate.xgot.toFixed(3) : '-'}</strong>
          </div>
        </div>

        <div className="fpa-xgot-body">
          <div className="fpa-goalmouth-target" onClick={handleGoalmouthClick} role="button" tabIndex={0}>
            <div className="fpa-goalmouth-frame">
              <div className="fpa-goalmouth-net" />
              <div className="fpa-goalmouth-post left" />
              <div className="fpa-goalmouth-post right" />
              <div className="fpa-goalmouth-line one" />
              <div className="fpa-goalmouth-line two" />
              <div className="fpa-goalmouth-line horizontal" />
              {goalmouthPoint ? (
                <div
                  className="fpa-goalmouth-point"
                  style={{ left: `${goalmouthPoint.x * 100}%`, top: `${(1 - goalmouthPoint.y) * 100}%` }}
                />
              ) : null}
            </div>
          </div>
        </div>

        <div className="fpa-xgot-footer">
          <div className="fpa-xgot-actions">
            <button disabled={xgotBusy} onClick={skipXgotInput} type="button">Skip</button>
            <button className="primary" disabled={!goalmouthPoint || xgotBusy} onClick={submitXgotInput} type="button">
              {xgotBusy ? 'Saving' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderDualPitch = (side: PitchSide) => {
    const renderDots = side === 'before' ? beforePitchDots : afterPitchDots;
    const panelRef = side === 'before' ? beforePitchRef : afterPitchRef;
    const title = side === 'before' ? 'Before' : 'After';
    const allyCount = renderDots.filter((dot) => dot.team === 'ally').length;
    const opponentCount = renderDots.length - allyCount;
    const armedHere = liveArrowArm?.side === side;
    return (
      <div className="fpa-dual-pitch-card">
        <div className="fpa-dual-pitch-head">
          <span>{title}</span>
          <div>
            <span className="fpa-dual-pitch-count">A{allyCount} O{opponentCount}</span>
            <button onClick={undoDual} title="마지막 조작 되돌리기 (⌘Z)" type="button">Undo</button>
            <button onClick={() => clearDualDots(side)} type="button">Clear</button>
          </div>
        </div>
        <div
          className={`fpa-pitch fpa-pitch-cream ${armedHere ? 'fpa-pitch-armed' : ''}`}
          onClick={(event) => handleDualPitchClick(side, event)}
          onContextMenu={(event) => {
            // 점 위 우클릭은 점 자체 핸들러가 처리(그 점 삭제). 여기(빈 곳)로 오면
            // 커서에 가장 가까운 점을 지우고, 근처에 점이 없을 때만 마지막 점을 지운다.
            event.preventDefault();
            const rect = panelRef.current?.getBoundingClientRect();
            const idx = rect ? nearestDotIndex(renderDots, event.clientX, event.clientY, rect) : -1;
            if (idx >= 0) removeDualDotAt(side, idx);
            else removeLastDualDot(side);
          }}
          onPointerLeave={() => {
            if (arrowPreview?.canvas === 'live' && arrowPreview.side === side) setArrowPreview(null);
          }}
          onPointerMove={(event) => trackArrowPreview('live', side, liveArrowArm, event, panelRef.current?.getBoundingClientRect())}
          ref={panelRef}
          role="button"
          tabIndex={0}
        >
          <img alt={`${title} football field`} className="fpa-pitch-image" draggable={false} src="/fpa-field.png" />
          {armedHere && liveArrowArm ? (
            <div className="fpa-arrow-arm-badge" onClick={(event) => event.stopPropagation()}>
              <b>{liveArrowArm.code}</b>
              <span>{arrowArmHint(liveArrowArm.code, liveArrowArm.stage)}</span>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  cancelArrowDraw();
                }}
                title="화살표 그리기 취소 (Esc)"
                type="button"
              >
                ✕
              </button>
            </div>
          ) : null}
          {renderDots.map((dot, index) => {
            const selected = selectedDualDot?.side === side && selectedDualDot.index === index;
            return (
              <div
                className={`fpa-pitch-dot fpa-dual-dot ${dot.team === 'opponent' ? 'opponent' : 'ally'} ${dot.isPrimaryAlly ? 'primary-ally' : ''} ${selected ? 'selected' : ''}`}
                key={`${side}-${index}-${dot.left}-${dot.top}`}
                onClick={(event) => {
                  // 화살표 그리는 중엔 점을 선택하지 않고 피치로 흘려보냄 (끊은 지점이 수비수 점 위인 경우가 흔함)
                  if (armedHere) return;
                  event.stopPropagation();
                  selectLiveDualDot({ side, index });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  removeDualDotAt(side, index);
                }}
                onPointerDown={(event) => {
                  if (armedHere) return;
                  event.stopPropagation();
                  draggingDualDotRef.current = { side, index, canvas: 'live' };
                  selectLiveDualDot({ side, index });
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                style={{
                  left: dot.left,
                  top: dot.top,
                  ...(dot.color ? { background: dot.color } : {}),
                  ...(dot.role === 'gk' ? { boxShadow: '0 0 0 2px #fff' } : {}),
                }}
                tabIndex={0}
              >
                {dot.label}
              </div>
            );
          })}
          {renderArrowOverlay('live', side, passArrows, liveArrowArm)}
          {renderArrowChips(side, passArrows)}
        </div>
      </div>
    );
  };

  // 수정용 피치 캔버스 — 기록된 로그 아래. 라이브 Before/After 와 같은 조작(점 추가·드래그·삭제), 데이터만 분리
  const renderEditPitch = (side: PitchSide) => {
    const renderDots = side === 'before' ? editBeforePitchDots : editAfterPitchDots;
    const panelRef = side === 'before' ? editBeforePitchRef : editAfterPitchRef;
    const title = side === 'before' ? 'Before' : 'After';
    const allyCount = renderDots.filter((dot) => dot.team === 'ally').length;
    const opponentCount = renderDots.length - allyCount;
    const armedHere = editArrowArm?.side === side;
    return (
      <div className="fpa-dual-pitch-card">
        <div className="fpa-dual-pitch-head">
          <span>{title}</span>
          <div>
            <span className="fpa-dual-pitch-count">A{allyCount} O{opponentCount}</span>
            <button onClick={() => removeLastEditDot(side)} type="button">Undo</button>
            <button onClick={() => clearEditDots(side)} type="button">Clear</button>
          </div>
        </div>
        <div
          className={`fpa-pitch fpa-pitch-cream ${armedHere ? 'fpa-pitch-armed' : ''}`}
          onClick={(event) => handleEditPitchClick(side, event)}
          onContextMenu={(event) => {
            // 점 위 우클릭은 점 자체 핸들러가 처리(그 점 삭제). 빈 곳으로 오면
            // 커서에 가장 가까운 점을 지우고, 근처에 점이 없을 때만 마지막 점을 지운다.
            event.preventDefault();
            const rect = panelRef.current?.getBoundingClientRect();
            const idx = rect ? nearestDotIndex(renderDots, event.clientX, event.clientY, rect) : -1;
            if (idx >= 0) removeEditDotAt(side, idx);
            else removeLastEditDot(side);
          }}
          onPointerLeave={() => {
            if (arrowPreview?.canvas === 'edit' && arrowPreview.side === side) setArrowPreview(null);
          }}
          onPointerMove={(event) => trackArrowPreview('edit', side, editArrowArm, event, panelRef.current?.getBoundingClientRect())}
          ref={panelRef}
          role="button"
          tabIndex={0}
        >
          <img alt={`${title} football field (수정용)`} className="fpa-pitch-image" draggable={false} src="/fpa-field.png" />
          {armedHere && editArrowArm ? (
            <div className="fpa-arrow-arm-badge" onClick={(event) => event.stopPropagation()}>
              <b>{editArrowArm.code}</b>
              <span>{arrowArmHint(editArrowArm.code, editArrowArm.stage)}</span>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  cancelArrowDraw();
                }}
                title="화살표 그리기 취소 (Esc)"
                type="button"
              >
                ✕
              </button>
            </div>
          ) : null}
          {renderDots.map((dot, index) => {
            const selected = editSelectedDot?.side === side && editSelectedDot.index === index;
            return (
              <div
                className={`fpa-pitch-dot fpa-dual-dot ${dot.team === 'opponent' ? 'opponent' : 'ally'} ${dot.isPrimaryAlly ? 'primary-ally' : ''} ${selected ? 'selected' : ''}`}
                key={`edit-${side}-${index}-${dot.left}-${dot.top}`}
                onClick={(event) => {
                  if (armedHere) return;
                  event.stopPropagation();
                  selectEditDot({ side, index });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  removeEditDotAt(side, index);
                }}
                onPointerDown={(event) => {
                  if (armedHere) return;
                  event.stopPropagation();
                  draggingDualDotRef.current = { side, index, canvas: 'edit' };
                  selectEditDot({ side, index });
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                style={{
                  left: dot.left,
                  top: dot.top,
                  ...(dot.color ? { background: dot.color } : {}),
                  ...(dot.role === 'gk' ? { boxShadow: '0 0 0 2px #fff' } : {}),
                }}
                tabIndex={0}
              >
                {dot.label}
              </div>
            );
          })}
          {renderArrowOverlay('edit', side, editPassArrows, editArrowArm)}
          {renderArrowChips(side, editPassArrows)}
        </div>
      </div>
    );
  };

  // 수정용 피치 패널 — 기록된 로그 아래. 저장 장면 편집 전용 (라이브 찍는 데이터는 위 캔버스에 그대로)
  const renderSceneEditor = () => {
    if (editingSceneIndex == null) return null;
    return (
      <section className="fpa-pitch-panel fpa-scene-editor">
        <div className="fpa-panel-header">
          <div className="fpa-panel-title">수정용 피치 · 장면 {editingSceneIndex + 1} 편집 중</div>
          <div className="fpa-panel-actions">
            <button onClick={closeSceneEditor} type="button">편집 취소</button>
            <button className="primary" disabled={!editRows.length} onClick={saveEditedScene} type="button">수정 저장</button>
          </div>
        </div>
        <div className="fpa-dual-input-bar">
          {renderPointTypeControl()}
          <div className="fpa-live-control-group">
            <span>Direction</span>
            <div className="fpa-segmented">
              <button className={editDirection === 'right' ? 'active' : ''} onClick={() => setEditDirection('right')} type="button">Right</button>
              <button className={editDirection === 'left' ? 'active' : ''} onClick={() => setEditDirection('left')} type="button">Left</button>
            </div>
          </div>
          <div className="fpa-live-meta-field">
            <span>Half</span>
            <div className="fpa-segmented">
              <button className={editHalf === '1H' ? 'active' : ''} onClick={() => setEditHalf('1H')} type="button">1st</button>
              <button className={editHalf === '2H' ? 'active' : ''} onClick={() => setEditHalf('2H')} type="button">2nd</button>
            </div>
          </div>
          <div className="fpa-live-control-group">
            <span>Team</span>
            <div className="fpa-segmented">
              <button className={editTeam === 'home' ? 'active' : ''} onClick={() => setEditTeam('home')} type="button">Home</button>
              <button className={editTeam === 'away' ? 'active' : ''} onClick={() => setEditTeam('away')} type="button">Away</button>
            </div>
          </div>
        </div>
        <div className="fpa-scene-editor-grid">
          <div className="fpa-scene-editor-pitches">
            {renderEditPitch('before')}
            {pendingXgot && pendingXgot.canvas === 'edit' ? (
              <div className="fpa-dual-pitch-card fpa-dual-xgot-card">
                <div className="fpa-dual-pitch-head">
                  <span>xGOT Input</span>
                  <div>
                    <span className="fpa-dual-pitch-count">Shot {pendingXgot.isGoal ? 'Goal' : 'On Target'}</span>
                  </div>
                </div>
                {renderXgotPanel()}
              </div>
            ) : (
              renderEditPitch('after')
            )}
          </div>
          <aside className="fpa-scene-editor-actions">
            <div className="fpa-scene-actions">
              {editRows.length === 0 ? (
                <span className="muted">이 장면에 남은 액션이 없습니다</span>
              ) : (
                editRows.map((row, index) => {
                  const isPrimary = editPrimary === index;
                  return (
                    <div
                      className="fpa-scene-action-row"
                      key={`edit-${index}-${row.Player}-${row.Action}`}
                      onClick={() => setEditSelectedRowIndex(index)}
                      role="button"
                      tabIndex={0}
                      style={{ outline: editSelectedRowIndex === index ? '1px solid var(--accent)' : 'none' }}
                    >
                      <span>
                        <button
                          className={`fpa-scene-primary ${isPrimary ? 'on' : ''}`}
                          onClick={(event) => { event.stopPropagation(); setEditPrimary(index); }}
                          title="primary 액션으로 지정"
                          type="button"
                        >★</button>
                        {row.Team} {row.Player} · {row.Action}{row.Receiver ? ` → ${row.Receiver}` : ''}
                      </span>
                      <span className="metrics">
                        xG {row.xG ?? '-'} · EPV {row.EPV ?? '-'} · PC {row.PC ?? '-'}
                        {row.xGOT ? ` · xGOT ${row.xGOT}` : ''}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            <div className="fpa-scene-footer">
              <button
                className="fpa-scene-del-btn"
                disabled={editSelectedRowIndex == null}
                onClick={() => { if (editSelectedRowIndex != null) removeEditLogAt(editSelectedRowIndex); }}
                type="button"
              >선택 액션 삭제</button>
            </div>
          </aside>
        </div>
        <div className="fpa-dual-entry-bar">
          <div className="fpa-live-control-group">
            <span>Game Time</span>
            <div className="fpa-time-control">
              <button onClick={() => adjustEditTimeline(-60)} type="button">-1</button>
              <input
                id="fpa-edit-timeline"
                value={editTimeline}
                onChange={(event) => setEditTimeline(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); adjustEditTimeline(60); }
                  if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); adjustEditTimeline(-60); }
                }}
              />
              <button onClick={() => adjustEditTimeline(60)} type="button">+1</button>
            </div>
          </div>
          <div className="fpa-live-control-group fpa-live-control-group-wide">
            <span>Stat Input</span>
            <div className="fpa-stat-input-row">
              <input
                id="fpa-edit-stat-input"
                ref={editStatInputRef}
                value={editStatInput}
                onChange={(event) => setEditStatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void addEditLog();
                  }
                }}
                placeholder="스탯 코드 (예: 10ss8.k.f.w, 4tt7.lt)"
              />
              <button className="submit" disabled={!editStatInput.trim() || busy || Boolean(pendingXgot)} onClick={addEditLog} type="button">
                ↵
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  };

  // 로그 행 1줄. clickable=true(single) → 행 클릭 선택, false(dual 장면 내) → 표시만(장면 그룹이 클릭 처리)
  const renderLogRow = (row: LogPreview, logStr: string | undefined, key: string, clickable: boolean, index: number) => {
    const logParts = logStr?.split(' | ') || [];
    return (
      <div
        className={`fpa-log-entry ${clickable && selectedRowIndex === index ? 'selected' : ''}`}
        key={key}
        onClick={clickable ? () => setSelectedRowIndex(index) : undefined}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
      >
        <span>{logParts[0] || '-'}</span>
        <span>{row.Time}</span>
        <span>{row.Team}</span>
        <span>{logParts[2] || '-'}</span>
        <span>{row.Player}</span>
        <span>{row.Action}</span>
        <span>{row.Receiver || '-'}</span>
        <span>{row.Coord}</span>
        <span>{extractReceiveCoord(logStr) || '-'}</span>
        <span title={row.Tags || '-'}>{row.Tags || '-'}</span>
        <span>{displayMetric(row, logStr, 'xG')}</span>
        <span>{displayMetric(row, logStr, 'xGOT')}</span>
        <span>{displayMetric(row, logStr, 'EPV')}</span>
        <span>{displayMetric(row, logStr, 'PC')}</span>
        <span title={extractDualStateSummary(logStr) || '-'}>{extractDualStateSummary(logStr) || '-'}</span>
      </div>
    );
  };

  const renderLogPanel = () => (
    <section className="fpa-log-panel">
      <div className="fpa-panel-header">
        <div className="fpa-panel-title">기록된 로그</div>
        <div className="fpa-panel-actions">
          <input
            accept=".xlsx,.xls"
            hidden
            onChange={(event) => void importWorkbook(event.target.files?.[0] || null)}
            ref={importInputRef}
            type="file"
          />
          <button onClick={() => importInputRef.current?.click()} type="button">
            수정 및 불러오기
          </button>
          <button onClick={openMatchPicker} type="button">
            경기 불러오기
          </button>
          <button className="primary" disabled={!allLogs.length || busy} onClick={exportWorkbook} type="button">
            분석 및 내보내기
          </button>
          <button className="primary" disabled={!allLogs.length || busy} onClick={saveLogsToMatch} type="button">
            저장
          </button>
          <button className="fpa-scene-del-btn" disabled={!allLogs.length || busy} onClick={clearAllRecordedLogs} type="button">
            전체 삭제
          </button>
        </div>
      </div>
      <div className="fpa-log-board">
        <div className="fpa-log-header">
          <span>Half</span>
          <span>Time</span>
          <span>Team</span>
          <span>Dir</span>
          <span>Player</span>
          <span>Action</span>
          <span>Receiver</span>
          <span>Pos</span>
          <span>Receive Pos</span>
          <span>Tags</span>
          <span>xG</span>
          <span>xGOT</span>
          <span>EPV</span>
          <span>PC</span>
          <span>State</span>
        </div>
        <div className="fpa-log-body" ref={logBodyRef}>
          {inputMode === 'dual'
            // dual: 저장된 장면 + 현재 작업 중 장면을 함께 표시한다.
            ? (
              <>
                {savedScenes.map((scene, sceneIdx) => (
                <div
                  className={`fpa-log-scene ${selectedSceneIndex === sceneIdx ? 'selected' : ''} ${editingSceneIndex === sceneIdx ? 'editing' : ''}`}
                  key={`scene-${sceneIdx}`}
                  onClick={() => setSelectedSceneIndex(sceneIdx)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="fpa-log-scene-divider">장면 {sceneIdx + 1}{editingSceneIndex === sceneIdx ? ' (편집 중)' : ''}</div>
                  {scene.rows.map((row, j) => renderLogRow(row, scene.logs[j], `s${sceneIdx}-${j}`, false, -1))}
                </div>
                ))}
                {rows.length ? (
                  <div className="fpa-log-scene current" key="current-scene">
                    <div className="fpa-log-scene-divider">현재 장면 (미저장)</div>
                    {rows.map((row, index) => renderLogRow(row, logs[index], `current-${index}`, false, -1))}
                  </div>
                ) : null}
              </>
            )
            // single: 원본대로 액션 단위 로그
            : rows.map((row, index) => renderLogRow(row, logs[index], `r-${index}`, true, index))}
        </div>
      </div>
      <div className={`fpa-log-actions ${inputMode === 'dual' ? 'fpa-log-actions-dual' : ''}`}>
        {inputMode === 'dual' ? (
          <>
            <button disabled={selectedSceneIndex == null} onClick={loadSelectedScene} type="button">
              선택 장면 수정 (아래 수정용 피치)
            </button>
            <button
              className="fpa-scene-del-btn"
              disabled={selectedSceneIndex == null}
              onClick={deleteSelectedScene}
              type="button"
            >
              선택 장면 삭제
            </button>
          </>
        ) : (
          <>
            <button disabled={selectedRowIndex == null} onClick={() => moveSelectedLog(-1)} type="button">
              선택 로그 위로
            </button>
            <button disabled={selectedRowIndex == null} onClick={() => moveSelectedLog(1)} type="button">
              선택 로그 아래로
            </button>
            <button disabled={selectedRowIndex == null} onClick={removeSelectedLog} type="button">
              선택 로그 삭제
            </button>
          </>
        )}
      </div>
    </section>
  );

  const renderSinglePitchPanel = () => (
    <section className="fpa-pitch-panel">
      <div className="fpa-panel-title">축구장</div>
      <div
        className="fpa-pitch fpa-pitch-cream"
        onClick={handlePitchClick}
        onContextMenu={(event) => {
          event.preventDefault();
          removeLastDot();
        }}
        ref={pitchRef}
        role="button"
        tabIndex={0}
      >
        <img alt="Football field" className="fpa-pitch-image" draggable={false} src="/fpa-field.png" />
        {pitchDots.map((dot) => (
          <div className="fpa-pitch-dot" key={`${dot.label}-${dot.left}-${dot.top}`} style={{ left: dot.left, top: dot.top }}>
            {dot.label}
          </div>
        ))}
      </div>
    </section>
  );

  const renderDualPitchPanel = () => (
    <section className="fpa-pitch-panel fpa-dual-state-panel">
      <div className="fpa-panel-header">
        <div className="fpa-panel-title">Dual Pitch State</div>
      </div>
      <div className="fpa-dual-pitch-grid">
        {renderDualPitch('before')}
        <div className="fpa-dual-copy">
          <button disabled={Boolean(pendingXgot) || !beforeDots.length} onClick={copyBeforeToAfter} type="button">
            →
          </button>
        </div>
        {pendingXgot && pendingXgot.canvas === 'live' ? (
          <div className="fpa-dual-pitch-card fpa-dual-xgot-card">
            <div className="fpa-dual-pitch-head">
              <span>xGOT Input</span>
              <div>
                <span className="fpa-dual-pitch-count">Shot {pendingXgot.isGoal ? 'Goal' : 'On Target'}</span>
              </div>
            </div>
            {renderXgotPanel()}
          </div>
        ) : (
          renderDualPitch('after')
        )}
      </div>
    </section>
  );

  // 찍은 점에 코드/번호 부여 (xFP/fpa clip 인라인 입력)
  const renderPointTypeControl = () => (
    <div className="fpa-live-control-group fpa-dual-point-type fpa-dual-layers">
      <span>레이어 (찍기 전 선택)</span>
      <div className="fpa-segmented">
        {DUAL_LAYERS.map((layer) => (
          <button
            key={layer.key}
            className={activeLayer === layer.key ? 'active' : ''}
            onClick={() => setActiveLayer(layer.key)}
            style={activeLayer === layer.key
              ? { background: layer.color, borderColor: layer.color, color: '#fff' }
              : { borderLeft: `4px solid ${layer.color}` }}
            type="button"
          >
            {layer.label} ({layer.hotkey.toUpperCase()})
          </button>
        ))}
      </div>
    </div>
  );

  const renderHalfControl = () => (
    <div className="fpa-live-meta-field">
      <span>Half</span>
      <div className="fpa-segmented">
        <button className={half === '1H' ? 'active' : ''} onClick={() => setHalf('1H')} type="button">1st</button>
        <button className={half === '2H' ? 'active' : ''} onClick={() => setHalf('2H')} type="button">2nd</button>
      </div>
    </div>
  );

  // 레이아웃 A: Input State 를 피치 위 가로 바로 (clip UX)
  const renderDualInputBar = () => (
    <section className="fpa-dual-input-bar">
      {renderPointTypeControl()}
      {renderDirectionControl()}
      {renderHalfControl()}
      {renderTeamControl()}
    </section>
  );

  // 피치 오른쪽 장면 요약 — 현재 작업 중 장면(rows 버퍼)의 액션들 + primary, codex 채점(xG/EPV/PC)
  const renderSceneSummary = () => {
    const overload = dualPointSummary.afterAllyCount - dualPointSummary.afterOpponentCount;
    const sceneRows = rows;
    return (
      <section className="fpa-dual-side-box fpa-scene-summary">
        <div className="fpa-panel-header">
          <div className="fpa-panel-title">장면 요약</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="fpa-scene-new" onClick={startNewScene} type="button">새 장면</button>
            <button className="fpa-scene-save" disabled={sceneRows.length === 0} onClick={saveScene} type="button">장면 저장</button>
          </div>
        </div>
        <div className="fpa-scene-counts">
          <span>Ally {dualPointSummary.afterAllyCount}</span>
          <span>Opp {dualPointSummary.afterOpponentCount}</span>
          <span>Overload {overload > 0 ? `+${overload}` : overload}</span>
          <span>액션 {sceneRows.length}</span>
        </div>
        <div className="fpa-scene-actions">
          {sceneRows.length === 0 ? (
            <span className="muted">이 장면 액션 없음 — 스탯 입력으로 추가하세요</span>
          ) : (
            sceneRows.map((row, index) => {
              const isPrimary = primaryRowIndex === index;
              return (
                <div
                  className="fpa-scene-action-row"
                  key={`${index}-${row.Player}-${row.Action}`}
                  onClick={() => setSelectedRowIndex(index)}
                  role="button"
                  tabIndex={0}
                  style={{ outline: selectedRowIndex === index ? '1px solid var(--accent)' : 'none' }}
                >
                  <span>
                    <button
                      className={`fpa-scene-primary ${isPrimary ? 'on' : ''}`}
                      onClick={(event) => { event.stopPropagation(); setPrimaryRowIndex(index); }}
                      title="primary 액션으로 지정"
                      type="button"
                    >★</button>
                    {row.Team} {row.Player} · {row.Action}{row.Receiver ? ` → ${row.Receiver}` : ''}
                  </span>
                  <span className="metrics">
                    xG {row.xG ?? '-'} · EPV {row.EPV ?? '-'} · PC {row.PC ?? '-'}
                    {row.xGOT ? ` · xGOT ${row.xGOT}` : ''}
                  </span>
                </div>
              );
            })
          )}
        </div>
        <div className="fpa-scene-footer">
          <button
            className="fpa-scene-del-btn"
            disabled={selectedRowIndex == null}
            onClick={() => { if (selectedRowIndex != null) removeLogAt(selectedRowIndex); }}
            type="button"
          >선택 액션 삭제</button>
        </div>
      </section>
    );
  };

  const renderStatInputControl = () => (
    <div className="fpa-live-control-group fpa-live-control-group-wide">
      <span>Stat Input</span>
      <div className="fpa-stat-input-row">
        <input
          id="fpa-live-stat-input"
          ref={statInputRef}
          value={statInput}
          onChange={(event) => setStatInput(event.target.value)}
          placeholder="스탯 코드 (예: 10ss8.k.f.w, 4tt7.lt)"
        />
        <button className="submit" disabled={!statInput.trim() || busy || Boolean(pendingXgot)} onClick={addLog} type="button">
          ↵
        </button>
      </div>
    </div>
  );

  const renderDirectionControl = () => (
    <div className="fpa-live-control-group">
      <span>Direction</span>
      <div className="fpa-segmented">
        <button className={direction === 'right' ? 'active' : ''} onClick={() => setDirection('right')} type="button">Right</button>
        <button className={direction === 'left' ? 'active' : ''} onClick={() => setDirection('left')} type="button">Left</button>
      </div>
    </div>
  );

  const renderTeamControl = () => (
    <div className="fpa-live-control-group">
      <span>Team</span>
      <div className="fpa-segmented">
        <button className={team === 'home' ? 'active' : ''} onClick={() => syncTeam('home')} type="button">Home</button>
        <button className={team === 'away' ? 'active' : ''} onClick={() => syncTeam('away')} type="button">Away</button>
      </div>
    </div>
  );

  const renderTimeControl = () => (
    <div className="fpa-live-control-group">
      <span>Game Time</span>
      <div className="fpa-time-control">
        <button onClick={() => adjustTimeline(-60)} type="button">-1</button>
        <input id="fpa-live-timeline" value={timeline} onChange={(event) => setTimeline(event.target.value)} />
        <button onClick={() => adjustTimeline(60)} type="button">+1</button>
      </div>
    </div>
  );

  const renderDualEntryBar = () => (
    <section className="fpa-dual-entry-bar">
      {renderTimeControl()}
      {renderStatInputControl()}
    </section>
  );

  const renderLiveControls = (variant: InputMode) => (
    <section className={`fpa-live-controls ${variant === 'dual' ? 'compact' : ''}`}>
      <div className="fpa-live-controls-title">실시간 입력 (Live Controls)</div>
      {variant === 'dual' ? (
        <>
          {renderStatInputControl()}
          <div className="fpa-live-controls-compact-row">
            {renderDirectionControl()}
            {renderTeamControl()}
            {renderTimeControl()}
          </div>
        </>
      ) : (
        <div className="fpa-live-controls-row">
          {renderDirectionControl()}
          {renderTeamControl()}
          {renderTimeControl()}
          {renderStatInputControl()}
        </div>
      )}
    </section>
  );

  return (
    <div className="page-stack">
      {matchPickerOpen ? (
        <div className="fcm-modal-backdrop" role="presentation" onClick={() => setMatchPickerOpen(false)}>
          <div className="card card-panel fcm-modal fpa-match-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">FLA Match</div>
                <h3>경기 불러오기</h3>
              </div>
              <button className="button-compact btn-secondary" onClick={() => setMatchPickerOpen(false)}>닫기</button>
            </div>
            <div className="row" style={{ gap: 8, marginBottom: 10, justifyContent: 'flex-start' }}>
              <label className="field-stack" style={{ minWidth: 140 }}>
                <span className="field-label">대회</span>
                <select
                  value={matchFilterClass}
                  onChange={(e) => {
                    setMatchFilterClass(e.target.value);
                    setMatchFilterRound('ALL');
                  }}
                >
                  <option value="ALL">전체</option>
                  {matchClassOptions.map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              </label>
              <label className="field-stack" style={{ minWidth: 110 }}>
                <span className="field-label">라운드</span>
                <select value={matchFilterRound} onChange={(e) => setMatchFilterRound(e.target.value)}>
                  <option value="ALL">전체</option>
                  {matchRoundOptions.map((round) => (
                    <option key={round} value={String(round)}>{round}R</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="fcm-guide-table-wrap fpa-match-table-wrap">
              <table className="fcm-guide-table">
                <thead>
                  <tr>
                    <th>대회</th>
                    <th>경기</th>
                    <th>상태</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAvailableMatches.map((match) => (
                    <tr key={match.id}>
                      <td>{match.competition_class}</td>
                      <td>{match.name}</td>
                      <td>{match.archived ? 'Archived' : 'Active'}</td>
                      <td>
                        <button className="button-compact btn-secondary" disabled={busy} onClick={() => loadMatch(match)}>
                          불러오기
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!filteredAvailableMatches.length ? (
                    <tr>
                      <td colSpan={4} className="muted">해당 조건의 경기가 없습니다</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      <section className="fpa-live-shell">
        <div className="fpa-live-brand">
          <span className="fpa-live-brandmark">F</span>
          <span>Fine Play Analytics</span>
        </div>

        <div className={`fpa-live-meta ${inputMode === 'dual' ? 'dual' : ''}`}>
          <label className="fpa-live-meta-field">
            <span>Home Team</span>
            <input value={teamIdH} onChange={(event) => setTeamIdH(event.target.value)} placeholder="Home" />
          </label>
          <label className="fpa-live-meta-field">
            <span>Away Team</span>
            <input value={teamIdA} onChange={(event) => setTeamIdA(event.target.value)} placeholder="Away" />
          </label>
          <label className="fpa-live-meta-field">
            <span>Match ID</span>
            <div className="fpa-match-id-row">
              <input
                className={matchIdError ? 'invalid' : ''}
                value={matchId}
                onBlur={() => {
                  if (matchIdError) setMatchIdError(validateMatchIdForSave(matchId));
                }}
                onChange={(event) => {
                  setMatchId(event.target.value);
                  setMatchIdError('');
                }}
                placeholder="비워두면 자동 생성"
              />
              <button
                onClick={() => {
                  setMatchId(generateMatchId());
                  setMatchIdError('');
                }}
                type="button"
              >
                랜덤
              </button>
            </div>
            {matchIdError ? <small className="fpa-field-error">{matchIdError}</small> : null}
          </label>
          {inputMode === 'single' ? renderHalfControl() : null}
          <div className="fpa-live-meta-field">
            <span>Mode</span>
            <div className="fpa-segmented">
              <button className={inputMode === 'single' ? 'active' : ''} onClick={() => setInputMode('single')} type="button">Single</button>
              <button className={inputMode === 'dual' ? 'active' : ''} onClick={() => setInputMode('dual')} type="button">Dual</button>
            </div>
          </div>
        </div>

        {inputMode === 'dual' ? (
          <>
            {renderDualInputBar()}
            <div className="fpa-dual-layout">
              {renderDualPitchPanel()}
              {renderSceneSummary()}
            </div>
            {renderDualEntryBar()}
            {renderLogPanel()}
            {renderSceneEditor()}
          </>
        ) : (
          <>
            <div className="fpa-live-main">
              {renderLogPanel()}
              {renderSinglePitchPanel()}
            </div>
            {renderLiveControls('single')}
          </>
        )}

        <div className="fpa-live-status">
          <span>{status}</span>
          <span>
            {inputMode === 'dual'
              ? `레이어 ${currentLayer.label} / Before A${dualPointSummary.beforeAllyCount} O${dualPointSummary.beforeOpponentCount} / After A${dualPointSummary.afterAllyCount} O${dualPointSummary.afterOpponentCount}${selectedDualDot ? ` / 선택 ${selectedDualDot.side === 'before' ? 'B' : 'A'}${selectedDualDot.index + 1}` : ''}`
              : dots.length
                ? `좌표 ${dots.map((dot) => `(${dot.meter_x}, ${dot.meter_y})`).join(' / ')}`
                : '좌표 없음'}
          </span>
        </div>
      </section>
    </div>
  );
}
