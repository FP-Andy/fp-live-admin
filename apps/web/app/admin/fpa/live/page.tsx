'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, apiFetch, apiJson } from '../../../../lib/api';
import { FPA_DRAFT_EVENT, FPA_DRAFT_STORAGE_KEY } from '../../../../components/FpaDraftGuard';

type DualDotTeam = 'ally' | 'opponent';

// 팀 레이어 (옵시디언 설계: 색 구분, team+role). 단축키 q·w·e·r 순서
type DualLayer = { key: string; label: string; hotkey: string; team: DualDotTeam; role: string; color: string };
const DUAL_LAYERS: DualLayer[] = [
  { key: 'atk', label: '홈', hotkey: 'q', team: 'ally', role: 'attacker', color: '#2f6df6' },
  { key: 'def', label: '어웨이', hotkey: 'w', team: 'opponent', role: 'defender', color: '#e0524f' },
  { key: 'atk_gk', label: '골키퍼(홈)', hotkey: 'e', team: 'ally', role: 'gk', color: '#16357a' },
  { key: 'def_gk', label: '골키퍼(어웨이)', hotkey: 'r', team: 'opponent', role: 'gk', color: '#7a1f1d' },
];

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
  role?: string;     // attacker | defender | gk (레이어)
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

type PassArrow = { side: PitchSide; startId?: string; x1: number; y1: number; x2: number; y2: number };

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
      before?: Array<{ team?: string }>;
      after?: Array<{ team?: string }>;
    };
    const before = parsed.before || [];
    const after = parsed.after || [];
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

function toPayloadDot(dot: PitchDot) {
  const payload: { meter_x: number; meter_y: number; team?: DualDotTeam } = {
    meter_x: dot.meter_x,
    meter_y: dot.meter_y,
  };
  if (dot.team) payload.team = dot.team;
  return payload;
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

function isAllyDot(dot: PitchDot) {
  return (dot.team || 'ally') === 'ally';
}

function statInputHasReceiver(statInput: string) {
  const baseAction = statInput.trim().split('.', 1)[0] || '';
  return /^\d+[a-z]+\d+$/i.test(baseAction);
}

function buildRenderPitchDots(sourceDots: PitchDot[]): RenderPitchDot[] {
  let allyCount = 0;
  let opponentCount = 0;
  return sourceDots.map((dot) => {
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

export default function FpaLivePage() {
  const didHydrateRef = useRef(false);
  const pitchRef = useRef<HTMLDivElement | null>(null);
  const beforePitchRef = useRef<HTMLDivElement | null>(null);
  const afterPitchRef = useRef<HTMLDivElement | null>(null);
  const editBeforePitchRef = useRef<HTMLDivElement | null>(null);
  const editAfterPitchRef = useRef<HTMLDivElement | null>(null);
  const draggingDualDotRef = useRef<(SelectedDualDot & { canvas: 'live' | 'edit' }) | null>(null);
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
  const [activeLayer, setActiveLayer] = useState<string>('atk');
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
  const [editSelectedDot, setEditSelectedDot] = useState<SelectedDualDot | null>(null);
  const [editSelectedRowIndex, setEditSelectedRowIndex] = useState<number | null>(null);
  // 수정용 입력 상태 — 라이브 입력값과 분리 (과거 장면은 half/시간/공격방향이 지금 라이브와 다름). 레이어만 공유(activeLayer).
  const [editHalf, setEditHalf] = useState<'1H' | '2H'>('1H');
  const [editTeam, setEditTeam] = useState<'home' | 'away'>('home');
  const [editDirection, setEditDirection] = useState<'left' | 'right'>('right');
  const [editTimeline, setEditTimeline] = useState('00:00');
  const [editStatInput, setEditStatInput] = useState('');
  const [editPendingPass, setEditPendingPass] = useState<{ code: string; side: PitchSide; startId?: string; sx: number; sy: number; mx: number; my: number } | null>(null);
  const [matchId, setMatchId] = useState('ID');
  const [teamIdH, setTeamIdH] = useState('Home');
  const [teamIdA, setTeamIdA] = useState('Away');
  const [status, setStatus] = useState('실시간 입력 준비됨');
  const [busy, setBusy] = useState(false);
  const [availableMatches, setAvailableMatches] = useState<Match[]>([]);
  const [matchPickerOpen, setMatchPickerOpen] = useState(false);

  // 전체 로그 = 저장된 장면들(flatten) + 현재 버퍼 (single 은 savedScenes 비어 있어 = 현재 버퍼). 저장/내보내기용.
  const allLogs = [...savedScenes.flatMap((scene) => scene.logs), ...logs];
  const allRows = [...savedScenes.flatMap((scene) => scene.rows), ...rows];

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
      if (draft.activeLayer) setActiveLayer(draft.activeLayer);
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
      activeLayer !== 'atk' ||
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
      setPassArrows((prev) => [...prev, { side, startId: pendingPass.startId, x1: pendingPass.sx, y1: pendingPass.sy, x2: c.screen_x, y2: c.screen_y }]);
      const start: PitchDot = { meter_x: pendingPass.mx, meter_y: pendingPass.my, screen_x: pendingPass.sx, screen_y: pendingPass.sy };
      const end: PitchDot = { meter_x: c.meter_x, meter_y: c.meter_y, screen_x: c.screen_x, screen_y: c.screen_y };
      const code = pendingPass.code;
      setPendingPass(null);
      void scorePass(code, start, end);
      return;
    }
    const nextDot: PitchDot = {
      id: newDotId(),
      ...dotFromClientPoint(event.clientX, event.clientY, rect),
      team: currentLayer.team, role: currentLayer.role, color: currentLayer.color,
    };
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

  const removeSelectedDualDot = () => {
    if (!selectedDualDot) return;
    const sel = selectedDualDot;
    const dotsArr = sel.side === 'before' ? beforeDots : afterDots;
    const removedId = dotsArr[sel.index]?.id;
    const removeAt = (prev: PitchDot[]) => prev.filter((_, index) => index !== sel.index);
    if (sel.side === 'before') {
      setBeforeDots(removeAt);
    } else {
      setAfterDots(removeAt);
    }
    if (removedId) setPassArrows((prev) => prev.filter((arrow) => !(arrow.side === sel.side && arrow.startId === removedId)));
    setSelectedDualDot(null);
    setStatus('선택한 dual pitch 좌표 삭제');
  };

  const removeDualDotAt = (side: PitchSide, index: number) => {
    const dotsArr = side === 'before' ? beforeDots : afterDots;
    const removedId = dotsArr[index]?.id;
    if (side === 'before') setBeforeDots((prev) => prev.filter((_, i) => i !== index));
    else setAfterDots((prev) => prev.filter((_, i) => i !== index));
    // 그 점에 딸린 패스 화살표도 함께 삭제
    if (removedId) setPassArrows((prev) => prev.filter((arrow) => !(arrow.side === side && arrow.startId === removedId)));
    setSelectedDualDot(null);
    setStatus('점 삭제');
  };

  const removeLastDualDot = (side: PitchSide) => {
    const dotsArr = side === 'before' ? beforeDots : afterDots;
    const removedId = dotsArr[dotsArr.length - 1]?.id;
    if (side === 'before') {
      setBeforeDots((prev) => prev.slice(0, -1));
    } else {
      setAfterDots((prev) => prev.slice(0, -1));
    }
    if (removedId) setPassArrows((prev) => prev.filter((arrow) => !(arrow.side === side && arrow.startId === removedId)));
    setSelectedDualDot(null);
  };

  const clearDualDots = (side: PitchSide) => {
    setPassArrows((prev) => prev.filter((arrow) => arrow.side !== side));
    if (side === 'before') {
      setBeforeDots([]);
    } else {
      setAfterDots([]);
    }
    setSelectedDualDot(null);
  };

  const copyBeforeToAfter = () => {
    setAfterDots(beforeDots.map((dot) => ({ ...dot })));
    setSelectedDualDot(null);
    setStatus('Before 좌표를 After로 복사했습니다');
  };

  // 현재 작업 캔버스+버퍼 비우기 (저장/새장면/불러오기 공용)
  const clearCurrentScene = () => {
    setRows([]);
    setLogs([]);
    setPrimaryRowIndex(null);
    setSelectedRowIndex(null);
    setBeforeDots([]);
    setAfterDots([]);
    setSelectedDualDot(null);
    setPendingPass(null);
    setPassArrows([]);
  };

  // 장면 저장: 현재 라이브 장면 스냅샷을 savedScenes 에 append. (저장된 장면 수정은 아래 수정용 피치에서)
  const saveScene = () => {
    if (!rows.length) {
      setStatus('저장할 액션이 없습니다');
      return;
    }
    const snapshot: SavedScene = { rows, logs, beforeDots, afterDots, passArrows, primary: primaryRowIndex };
    setSavedScenes((prev) => [...prev, snapshot]);
    setStatus('장면 저장됨 — 기록된 로그에 추가');
    clearCurrentScene();
  };

  // 새 장면: 저장 안 한 현재 장면을 버리고 새로 시작
  const startNewScene = () => {
    clearCurrentScene();
    setStatus('현재 장면 비움 (미저장)');
  };

  // 불러오기: 선택한 저장 장면을 기록된 로그 아래 "수정용 피치"로 복원 — 라이브 캔버스(찍는 데이터)는 안 건드림
  const loadSelectedScene = () => {
    if (selectedSceneIndex == null) return;
    const scene = savedScenes[selectedSceneIndex];
    if (!scene) return;
    setEditRows(scene.rows);
    setEditLogs(scene.logs);
    setEditBeforeDots(scene.beforeDots.map((dot) => ({ ...dot })));
    setEditAfterDots(scene.afterDots.map((dot) => ({ ...dot })));
    setEditPassArrows(scene.passArrows.map((arrow) => ({ ...arrow })));
    setEditPrimary(scene.primary);
    setEditingSceneIndex(selectedSceneIndex);
    setEditSelectedDot(null);
    setEditSelectedRowIndex(null);
    // 수정용 입력값 시드: 로그 헤더(half | team | direction | timeline)에서 복원, 없으면 라이브 현재값
    const header = scene.logs[0]?.split(' | ') || [];
    setEditHalf(header[0] === '1H' || header[0] === '2H' ? header[0] : half);
    setEditTeam(header[1] === 'home' || header[1] === 'away' ? header[1] : team);
    setEditDirection(header[2] === 'left' || header[2] === 'right' ? header[2] : direction);
    setEditTimeline(/^\d{1,3}:\d{2}$/.test(header[3] || '') ? header[3] : timeline);
    setEditStatInput('');
    setEditPendingPass(null);
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
    if (pendingXgot?.canvas === 'edit') resetXgotState();
  };

  // 수정 저장: 편집 중 장면을 제자리 덮어쓰기 (순서 유지)
  const saveEditedScene = () => {
    if (editingSceneIndex == null) return;
    if (!editRows.length) {
      setStatus('장면에 액션이 없습니다 — 빈 장면은 저장할 수 없습니다');
      return;
    }
    const savedIndex = editingSceneIndex;
    const snapshot: SavedScene = {
      rows: editRows,
      logs: editLogs,
      beforeDots: editBeforeDots,
      afterDots: editAfterDots,
      passArrows: editPassArrows,
      primary: editPrimary,
    };
    setSavedScenes((prev) => prev.map((scene, index) => (index === savedIndex ? snapshot : scene)));
    setStatus(`장면 ${savedIndex + 1} 수정 저장됨`);
    closeSceneEditor();
  };

  const handleEditPitchClick = (side: PitchSide, event: React.MouseEvent<HTMLDivElement>) => {
    const rect = (side === 'before' ? editBeforePitchRef.current : editAfterPitchRef.current)?.getBoundingClientRect();
    if (!rect) return;
    // 패스 도착점 대기 중 + 같은 프레임이면 → 새 점이 아니라 화살표 끝점 + [시작,도착] 2점으로 채점 (라이브와 동일)
    if (editPendingPass && editPendingPass.side === side) {
      const c = dotFromClientPoint(event.clientX, event.clientY, rect);
      setEditPassArrows((prev) => [...prev, { side, startId: editPendingPass.startId, x1: editPendingPass.sx, y1: editPendingPass.sy, x2: c.screen_x, y2: c.screen_y }]);
      const start: PitchDot = { meter_x: editPendingPass.mx, meter_y: editPendingPass.my, screen_x: editPendingPass.sx, screen_y: editPendingPass.sy };
      const end: PitchDot = { meter_x: c.meter_x, meter_y: c.meter_y, screen_x: c.screen_x, screen_y: c.screen_y };
      const code = editPendingPass.code;
      setEditPendingPass(null);
      void scoreEditPass(code, start, end);
      return;
    }
    const nextDot: PitchDot = {
      id: newDotId(),
      ...dotFromClientPoint(event.clientX, event.clientY, rect),
      team: currentLayer.team, role: currentLayer.role, color: currentLayer.color,
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
    if (removedId) setEditPassArrows((prev) => prev.filter((arrow) => !(arrow.side === side && arrow.startId === removedId)));
    setEditSelectedDot(null);
    setStatus('수정용 피치 점 삭제');
  };

  const removeLastEditDot = (side: PitchSide) => {
    const dotsArr = side === 'before' ? editBeforeDots : editAfterDots;
    removeEditDotAt(side, dotsArr.length - 1);
  };

  const clearEditDots = (side: PitchSide) => {
    setEditPassArrows((prev) => prev.filter((arrow) => arrow.side !== side));
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
      setBeforeDots([]);
      setAfterDots([]);
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

  const buildDualSubmitDots = () => {
    if (inputMode !== 'dual') return dots;
    const beforeAllies = beforeDots.filter(isAllyDot);
    const afterAllies = afterDots.filter(isAllyDot);
    if (statInputHasReceiver(statInput) && beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    if (beforeAllies.length && afterAllies.length) return [beforeAllies[0], afterAllies[0]];
    if (beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    if (afterAllies.length >= 2) return afterAllies.slice(0, 2);
    return [...beforeAllies, ...afterAllies];
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
          dots: [toPayloadDot(start), toPayloadDot(end)],
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

  const buildDualPitchPayload = () => {
    if (inputMode !== 'dual') return undefined;
    return {
      input_tier: beforeDots.length + afterDots.length >= 6 ? 'recommended' : 'minimal',
      before: {
        dots: beforeDots.map(toPayloadDot),
      },
      after: {
        dots: afterDots.map(toPayloadDot),
      },
    };
  };

  // ── 수정용 피치 채점 경로 — 라이브 addLog/scorePass 미러, 대상만 edit 상태 ──

  const buildEditSubmitDots = () => {
    const beforeAllies = editBeforeDots.filter(isAllyDot);
    const afterAllies = editAfterDots.filter(isAllyDot);
    if (statInputHasReceiver(editStatInput) && beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    if (beforeAllies.length && afterAllies.length) return [beforeAllies[0], afterAllies[0]];
    if (beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    if (afterAllies.length >= 2) return afterAllies.slice(0, 2);
    return [...beforeAllies, ...afterAllies];
  };

  const buildEditDualPitchPayload = () => ({
    input_tier: editBeforeDots.length + editAfterDots.length >= 6 ? 'recommended' : 'minimal',
    before: {
      dots: editBeforeDots.map(toPayloadDot),
    },
    after: {
      dots: editAfterDots.map(toPayloadDot),
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
          dots: [toPayloadDot(start), toPayloadDot(end)],
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
    // 패스/크로스(받는번호 O) = 시작 점 선택 후 도착점 클릭까지 채점 지연 (라이브와 동일)
    if (statInputHasReceiver(editStatInput)) {
      const sel = editSelectedDot;
      const dotsArr = sel?.side === 'before' ? editBeforeDots : editAfterDots;
      const startDot = sel ? dotsArr[sel.index] : undefined;
      if (!sel || !startDot) {
        setStatus('수정용 피치에서 패스 시작 점을 먼저 찍으세요');
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
      setStatus('수정용 피치에서 패스 도착점을 클릭하세요 (화살표)');
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
          dots: buildEditSubmitDots().map(toPayloadDot),
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
      if (actorSel && actorNum) {
        const assign = (prev: PitchDot[]) =>
          prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
        if (actorSel.side === 'before') setEditBeforeDots(assign);
        else setEditAfterDots(assign);
      }
      setStatus('수정용 장면에 액션 추가 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
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
      const coords = dotFromClientPoint(event.clientX, event.clientY, rect);
      // 위치만 갱신 — team/role/color/number/id 보존 (안 하면 레이어 색 사라져 홈/어웨이 뒤바뀐 듯 보임)
      (isEdit ? updateEditDot : updateDualDot)(dragging.side, dragging.index, { ...existing, ...coords });
      // 그 점에서 출발하는 패스 화살표 시작점도 따라 이동
      if (existing.id) {
        (isEdit ? setEditPassArrows : setPassArrows)((prev) => prev.map((arrow) =>
          arrow.side === dragging.side && arrow.startId === existing.id
            ? { ...arrow, x1: coords.screen_x, y1: coords.screen_y }
            : arrow));
      }
    };

    const handlePointerUp = () => {
      draggingDualDotRef.current = null;
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
    // 패스/크로스(받는번호 O) = 2점(시작·도착). 점 1개만 찍고 코드 입력 → 채점은 도착점 클릭 시 (xFP/fpa)
    if (inputMode === 'dual' && statInputHasReceiver(statInput)) {
      const sel = selectedDualDot;
      const dotsArr = sel?.side === 'before' ? beforeDots : afterDots;
      const startDot = sel ? dotsArr[sel.index] : undefined;
      if (!sel || !startDot) {
        setStatus('패스 시작 점을 먼저 찍으세요');
        return;
      }
      const actorNum = statInput.trim().match(/^(\d+)/)?.[1];
      if (actorNum) {
        const assign = (prev: PitchDot[]) => prev.map((dot, index) => (index === sel.index ? { ...dot, number: actorNum } : dot));
        if (sel.side === 'before') setBeforeDots(assign);
        else setAfterDots(assign);
      }
      setPendingPass({ code: statInput, side: sel.side, startId: startDot.id, sx: startDot.screen_x, sy: startDot.screen_y, mx: startDot.meter_x, my: startDot.meter_y });
      setStatInput('');
      setStatus('패스 도착점을 클릭하세요 (화살표)');
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
          dots: submitDots.map(toPayloadDot),
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
        if (actorSel && actorNum) {
          const assign = (prev: PitchDot[]) =>
            prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
          if (actorSel.side === 'before') setBeforeDots(assign);
          else setAfterDots(assign);
        }
        setStatus('로그 추가 완료');
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
      setLogs(data.logs || []);
      setRows(data.rows || []);
      setSelectedRowIndex((data.rows || []).length ? 0 : null);
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
      setLogs(saved.logs || []);
      setRows(saved.rows || []);
      setSelectedRowIndex((saved.rows || []).length ? 0 : null);
      // 불러온 경기 로그는 현재 버퍼로 (장면 구조 없음). scene/수정용 피치 상태 초기화.
      setSavedScenes([]);
      closeSceneEditor();
      setSelectedSceneIndex(null);
      setPrimaryRowIndex(null);
      setPendingPass(null);
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
    if (!matchId || matchId === 'ID') {
      setStatus('FLA 경기 불러오기 후 저장할 수 있습니다');
      return;
    }
    setBusy(true);
    setStatus('FPA 로그 DB 저장 중');
    try {
      const response = await apiFetch(`/fpa/matches/${matchId}/logs`, {
        method: 'PUT',
        body: JSON.stringify({
          logs: allLogs,
          rows: allRows,
          teamid_h: teamIdH,
          teamid_a: teamIdA,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || 'FPA 로그 저장 실패');
        return;
      }
      setStatus(`FPA 로그 ${allLogs.length}건 저장 완료`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'FPA 로그 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  // 현재 버퍼(현재 장면/single 로그)에서 특정 인덱스 액션 삭제 + primary/선택 동기화
  const removeLogAt = (removedIdx: number) => {
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
      if (target instanceof HTMLElement && target.tagName === 'INPUT' && target.id !== 'fpa-live-timeline' && target.id !== 'fpa-live-stat-input') {
        return;
      }
      const isTextEntryTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (inputMode === 'dual' && !isTextEntryTarget) {
        const layer = DUAL_LAYERS.find((entry) => entry.hotkey === event.key.toLowerCase());
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
  }, [afterDots, beforeDots, busy, direction, dots, activeLayer, editAfterDots, editBeforeDots, editSelectedDot, half, inputMode, pendingXgot, rows.length, selectedDualDot, statInput, team, timeline]);

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
    return (
      <div className="fpa-dual-pitch-card">
        <div className="fpa-dual-pitch-head">
          <span>{title}</span>
          <div>
            <span className="fpa-dual-pitch-count">A{allyCount} O{opponentCount}</span>
            <button onClick={() => removeLastDualDot(side)} type="button">Undo</button>
            <button onClick={() => clearDualDots(side)} type="button">Clear</button>
          </div>
        </div>
        <div
          className="fpa-pitch fpa-pitch-cream"
          onClick={(event) => handleDualPitchClick(side, event)}
          onContextMenu={(event) => {
            event.preventDefault();
            removeLastDualDot(side);
          }}
          ref={panelRef}
          role="button"
          tabIndex={0}
        >
          <img alt={`${title} football field`} className="fpa-pitch-image" draggable={false} src="/fpa-field.png" />
          {renderDots.map((dot, index) => {
            const selected = selectedDualDot?.side === side && selectedDualDot.index === index;
            return (
              <div
                className={`fpa-pitch-dot fpa-dual-dot ${dot.team === 'opponent' ? 'opponent' : 'ally'} ${dot.isPrimaryAlly ? 'primary-ally' : ''} ${selected ? 'selected' : ''}`}
                key={`${side}-${index}-${dot.left}-${dot.top}`}
                onClick={(event) => {
                  event.stopPropagation();
                  selectLiveDualDot({ side, index });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  removeDualDotAt(side, index);
                }}
                onPointerDown={(event) => {
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
          {passArrows.some((arrow) => arrow.side === side) ? (
            <svg className="fpa-scene-arrows" preserveAspectRatio="none" viewBox="0 0 1050 680">
              <defs>
                <marker id="fpa-pass-arrowhead" markerHeight="6" markerWidth="6" orient="auto" refX="4.5" refY="3">
                  <path d="M0,0 L6,3 L0,6 Z" fill="#16c2c2" />
                </marker>
              </defs>
              {passArrows.filter((arrow) => arrow.side === side).map((arrow, i) => (
                <line key={`arrow-${side}-${i}`} markerEnd="url(#fpa-pass-arrowhead)"
                  stroke="#16c2c2" strokeWidth={4} x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2} />
              ))}
            </svg>
          ) : null}
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
          className="fpa-pitch fpa-pitch-cream"
          onClick={(event) => handleEditPitchClick(side, event)}
          onContextMenu={(event) => {
            event.preventDefault();
            removeLastEditDot(side);
          }}
          ref={panelRef}
          role="button"
          tabIndex={0}
        >
          <img alt={`${title} football field (수정용)`} className="fpa-pitch-image" draggable={false} src="/fpa-field.png" />
          {renderDots.map((dot, index) => {
            const selected = editSelectedDot?.side === side && editSelectedDot.index === index;
            return (
              <div
                className={`fpa-pitch-dot fpa-dual-dot ${dot.team === 'opponent' ? 'opponent' : 'ally'} ${dot.isPrimaryAlly ? 'primary-ally' : ''} ${selected ? 'selected' : ''}`}
                key={`edit-${side}-${index}-${dot.left}-${dot.top}`}
                onClick={(event) => {
                  event.stopPropagation();
                  selectEditDot({ side, index });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  removeEditDotAt(side, index);
                }}
                onPointerDown={(event) => {
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
          {editPassArrows.some((arrow) => arrow.side === side) ? (
            <svg className="fpa-scene-arrows" preserveAspectRatio="none" viewBox="0 0 1050 680">
              <defs>
                <marker id={`fpa-pass-arrowhead-edit-${side}`} markerHeight="6" markerWidth="6" orient="auto" refX="4.5" refY="3">
                  <path d="M0,0 L6,3 L0,6 Z" fill="#16c2c2" />
                </marker>
              </defs>
              {editPassArrows.filter((arrow) => arrow.side === side).map((arrow, i) => (
                <line key={`edit-arrow-${side}-${i}`} markerEnd={`url(#fpa-pass-arrowhead-edit-${side})`}
                  stroke="#16c2c2" strokeWidth={4} x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2} />
              ))}
            </svg>
          ) : null}
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
        <span>{row.Tags || '-'}</span>
        <span>{displayMetric(row, logStr, 'xG')}</span>
        <span>{displayMetric(row, logStr, 'xGOT')}</span>
        <span>{displayMetric(row, logStr, 'EPV')}</span>
        <span>{displayMetric(row, logStr, 'PC')}</span>
        <span>{extractDualStateSummary(logStr) || '-'}</span>
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
          <button className="primary" disabled={!allLogs.length || busy || !matchId || matchId === 'ID'} onClick={saveLogsToMatch} type="button">
            저장
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
            // dual: 저장된 장면을 "장면 단위" 그룹으로 — 클릭 선택 후 "불러오기"로 수정
            ? savedScenes.map((scene, sceneIdx) => (
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
              ))
            // single: 원본대로 액션 단위 로그
            : rows.map((row, index) => renderLogRow(row, logs[index], `r-${index}`, true, index))}
        </div>
      </div>
      <div className="fpa-log-actions">
        {inputMode === 'dual' ? (
          <button disabled={selectedSceneIndex == null} onClick={loadSelectedScene} type="button">
            선택 장면 수정 (아래 수정용 피치)
          </button>
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
                  {availableMatches.map((match) => (
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
            <input value={matchId} onChange={(event) => setMatchId(event.target.value)} placeholder="ID" />
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
