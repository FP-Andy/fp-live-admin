'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, apiFetch, apiJson } from '../../../../lib/api';
import { FPA_DRAFT_EVENT, FPA_DRAFT_STORAGE_KEY } from '../../../../components/FpaDraftGuard';

type DualDotTeam = 'ally' | 'opponent';

type PitchDot = {
  meter_x: number;
  meter_y: number;
  screen_x: number;
  screen_y: number;
  team?: DualDotTeam;
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
      label: `${dotTeam === 'ally' ? 'A' : 'O'}${teamIndex}`,
      isPrimaryAlly: dotTeam === 'ally' && teamIndex <= 2,
    };
  });
}

export default function FpaLivePage() {
  const didHydrateRef = useRef(false);
  const pitchRef = useRef<HTMLDivElement | null>(null);
  const beforePitchRef = useRef<HTMLDivElement | null>(null);
  const afterPitchRef = useRef<HTMLDivElement | null>(null);
  const draggingDualDotRef = useRef<SelectedDualDot | null>(null);
  const logBodyRef = useRef<HTMLDivElement | null>(null);
  const statInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [half, setHalf] = useState<'1H' | '2H'>('1H');
  const [team, setTeam] = useState<'home' | 'away'>('home');
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [timeline, setTimeline] = useState('00:00');
  const [statInput, setStatInput] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('single');
  const [dualDotTeam, setDualDotTeam] = useState<DualDotTeam>('ally');
  const [dots, setDots] = useState<PitchDot[]>([]);
  const [beforeDots, setBeforeDots] = useState<PitchDot[]>([]);
  const [afterDots, setAfterDots] = useState<PitchDot[]>([]);
  const [selectedDualDot, setSelectedDualDot] = useState<SelectedDualDot | null>(null);
  const [pendingXgot, setPendingXgot] = useState<PendingXgot | null>(null);
  const [goalmouthPoint, setGoalmouthPoint] = useState<GoalmouthPoint | null>(null);
  const [xgotEstimate, setXgotEstimate] = useState<XgotEstimateResult | null>(null);
  const [xgotBusy, setXgotBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [rows, setRows] = useState<LogPreview[]>([]);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [matchId, setMatchId] = useState('ID');
  const [teamIdH, setTeamIdH] = useState('Home');
  const [teamIdA, setTeamIdA] = useState('Away');
  const [status, setStatus] = useState('실시간 입력 준비됨');
  const [busy, setBusy] = useState(false);
  const [availableMatches, setAvailableMatches] = useState<Match[]>([]);
  const [matchPickerOpen, setMatchPickerOpen] = useState(false);

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
        dualDotTeam?: DualDotTeam;
        dots?: PitchDot[];
        beforeDots?: PitchDot[];
        afterDots?: PitchDot[];
        selectedDualDot?: SelectedDualDot | null;
        logs?: string[];
        rows?: LogPreview[];
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
      if (draft.dualDotTeam) setDualDotTeam(draft.dualDotTeam);
      if (Array.isArray(draft.dots)) setDots(draft.dots);
      if (Array.isArray(draft.beforeDots)) setBeforeDots(draft.beforeDots);
      if (Array.isArray(draft.afterDots)) setAfterDots(draft.afterDots);
      if (draft.selectedDualDot) setSelectedDualDot(draft.selectedDualDot);
      if (Array.isArray(draft.logs)) setLogs(draft.logs);
      if (Array.isArray(draft.rows)) setRows(draft.rows);
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
      dots.length > 0 ||
      beforeDots.length > 0 ||
      afterDots.length > 0 ||
      inputMode !== 'single' ||
      dualDotTeam !== 'ally' ||
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
      dualDotTeam,
      dots,
      beforeDots,
      afterDots,
      selectedDualDot,
      logs,
      rows,
      selectedRowIndex,
      matchId,
      teamIdH,
      teamIdA,
    };
    window.sessionStorage.setItem(FPA_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    window.dispatchEvent(new CustomEvent(FPA_DRAFT_EVENT, { detail: { hasDraft: true } }));
  }, [afterDots, beforeDots, direction, dots, dualDotTeam, half, inputMode, logs, matchId, rows, selectedDualDot, selectedRowIndex, statInput, team, teamIdA, teamIdH, timeline]);

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
    const nextDot = { ...dotFromClientPoint(event.clientX, event.clientY, rect), team: dualDotTeam };
    if (side === 'before') {
      setBeforeDots((prev) => {
        setSelectedDualDot({ side, index: prev.length });
        return [...prev, nextDot];
      });
    } else {
      setAfterDots((prev) => {
        setSelectedDualDot({ side, index: prev.length });
        return [...prev, nextDot];
      });
    }
    event.currentTarget.focus();
  };

  const removeLastDot = () => {
    setDots((prev) => prev.slice(0, -1));
  };

  const removeSelectedDualDot = () => {
    if (!selectedDualDot) return;
    const removeAt = (prev: PitchDot[]) => prev.filter((_, index) => index !== selectedDualDot.index);
    if (selectedDualDot.side === 'before') {
      setBeforeDots(removeAt);
    } else {
      setAfterDots(removeAt);
    }
    setSelectedDualDot(null);
    setStatus('선택한 dual pitch 좌표 삭제');
  };

  const removeLastDualDot = (side: PitchSide) => {
    if (side === 'before') {
      setBeforeDots((prev) => prev.slice(0, -1));
    } else {
      setAfterDots((prev) => prev.slice(0, -1));
    }
    setSelectedDualDot(null);
  };

  const clearDualDots = (side: PitchSide) => {
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

  const resetXgotState = () => {
    setPendingXgot(null);
    setGoalmouthPoint(null);
    setXgotEstimate(null);
  };

  const finishXgotFlow = (message: string) => {
    resetXgotState();
    setBeforeDots([]);
    setAfterDots([]);
    setSelectedDualDot(null);
    setStatus(message);
    window.setTimeout(() => statInputRef.current?.focus(), 0);
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
    finishXgotFlow('xGOT 입력을 건너뛰고 피치로 복귀했습니다');
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
      setLogs((prev) => prev.map((log, index) => (
        index === pendingXgot.rowIndex ? mergeMetricsIntoLog(log, { xG: xg, xGOT: xgot }) : log
      )));
      setRows((prev) => prev.map((row, index) => (
        index === pendingXgot.rowIndex ? { ...row, xG: xg, xGOT: xgot } : row
      )));
      finishXgotFlow(`xGOT=${xgot} 입력 완료 (${estimate.delta >= 0 ? '+' : ''}${estimate.delta}, ${estimate.label})`);
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

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragging = draggingDualDotRef.current;
      if (!dragging) return;
      const ref = dragging.side === 'before' ? beforePitchRef.current : afterPitchRef.current;
      const rect = ref?.getBoundingClientRect();
      if (!rect) return;
      const currentDots = dragging.side === 'before' ? beforeDots : afterDots;
      updateDualDot(dragging.side, dragging.index, {
        ...dotFromClientPoint(event.clientX, event.clientY, rect),
        team: currentDots[dragging.index]?.team || 'ally',
      });
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
  }, [afterDots, beforeDots]);

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
        setBeforeDots([]);
        setAfterDots([]);
        setSelectedDualDot(null);
      } else {
        setDots([]);
      }
      setStatus('로그 추가 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  const exportWorkbook = async () => {
    if (!logs.length) return;
    setBusy(true);
    setStatus('분석 파일 생성 중');

    try {
      const response = await apiFetch('/fpa/analyze/export', {
        method: 'POST',
        body: JSON.stringify({
          logs,
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
    if (!logs.length) {
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
          logs,
          rows,
          teamid_h: teamIdH,
          teamid_a: teamIdA,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || 'FPA 로그 저장 실패');
        return;
      }
      setStatus(`FPA 로그 ${logs.length}건 저장 완료`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'FPA 로그 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  const removeSelectedLog = () => {
    if (selectedRowIndex == null) return;
    setLogs((prev) => prev.filter((_, index) => index !== selectedRowIndex));
    setRows((prev) => {
      const nextRows = prev.filter((_, index) => index !== selectedRowIndex);
      if (!nextRows.length) {
        setSelectedRowIndex(null);
      } else if (selectedRowIndex >= nextRows.length) {
        setSelectedRowIndex(nextRows.length - 1);
      }
      setStatus('선택한 로그 삭제');
      return nextRows;
    });
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
        if (event.key.toLowerCase() === 'q') {
          event.preventDefault();
          setDualDotTeam('ally');
          setStatus('Point Type: Ally');
          return;
        }
        if (event.key.toLowerCase() === 'w') {
          event.preventDefault();
          setDualDotTeam('opponent');
          setStatus('Point Type: Opponent');
          return;
        }
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
  }, [afterDots, beforeDots, busy, direction, dots, dualDotTeam, half, inputMode, pendingXgot, rows.length, selectedDualDot, statInput, team, timeline]);

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
                  setSelectedDualDot({ side, index });
                  event.currentTarget.focus();
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  draggingDualDotRef.current = { side, index };
                  setSelectedDualDot({ side, index });
                  event.currentTarget.focus();
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                style={{ left: dot.left, top: dot.top }}
                tabIndex={0}
              >
                {dot.label}
              </div>
            );
          })}
        </div>
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
          <button className="primary" disabled={!logs.length || busy} onClick={exportWorkbook} type="button">
            분석 및 내보내기
          </button>
          <button className="primary" disabled={!logs.length || busy || !matchId || matchId === 'ID'} onClick={saveLogsToMatch} type="button">
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
          {rows.map((row, index) => {
            const logParts = logs[index]?.split(' | ') || [];
            return (
              <div
                className={`fpa-log-entry ${selectedRowIndex === index ? 'selected' : ''}`}
                key={`${row.Time}-${row.Player}-${index}`}
                onClick={() => setSelectedRowIndex(index)}
                role="button"
                tabIndex={0}
              >
                <span>{logParts[0] || '-'}</span>
                <span>{row.Time}</span>
                <span>{row.Team}</span>
                <span>{logParts[2] || '-'}</span>
                <span>{row.Player}</span>
                <span>{row.Action}</span>
                <span>{row.Receiver || '-'}</span>
                <span>{row.Coord}</span>
                <span>{extractReceiveCoord(logs[index]) || '-'}</span>
                <span>{row.Tags || '-'}</span>
                <span>{displayMetric(row, logs[index], 'xG')}</span>
                <span>{displayMetric(row, logs[index], 'xGOT')}</span>
                <span>{displayMetric(row, logs[index], 'EPV')}</span>
                <span>{displayMetric(row, logs[index], 'PC')}</span>
                <span>{extractDualStateSummary(logs[index]) || '-'}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="fpa-log-actions">
        <button disabled={selectedRowIndex == null} onClick={() => moveSelectedLog(-1)} type="button">
          선택 로그 위로
        </button>
        <button disabled={selectedRowIndex == null} onClick={() => moveSelectedLog(1)} type="button">
          선택 로그 아래로
        </button>
        <button disabled={selectedRowIndex == null} onClick={removeSelectedLog} type="button">
          선택 로그 삭제
        </button>
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
        {pendingXgot ? (
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

  const renderPointTypeControl = () => (
    <div className="fpa-live-control-group fpa-dual-point-type">
      <span>Point Type</span>
      <div className="fpa-segmented">
        <button className={dualDotTeam === 'ally' ? 'active ally' : ''} onClick={() => setDualDotTeam('ally')} type="button">Ally (Q)</button>
        <button className={dualDotTeam === 'opponent' ? 'active opponent' : ''} onClick={() => setDualDotTeam('opponent')} type="button">Opp (W)</button>
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

  const renderDualSideBox = () => (
    <section className="fpa-dual-side-box">
      <div className="fpa-panel-title">Input State</div>
      {renderPointTypeControl()}
      {renderDirectionControl()}
      {renderHalfControl()}
      {renderTeamControl()}
    </section>
  );

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
            <div className="fpa-dual-layout">
              {renderDualPitchPanel()}
              {renderDualSideBox()}
            </div>
            {renderDualEntryBar()}
            {renderLogPanel()}
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
              ? `Type ${dualDotTeam === 'ally' ? 'Ally' : 'Opp'} / Before A${dualPointSummary.beforeAllyCount} O${dualPointSummary.beforeOpponentCount} / After A${dualPointSummary.afterAllyCount} O${dualPointSummary.afterOpponentCount}${selectedDualDot ? ` / 선택 ${selectedDualDot.side === 'before' ? 'B' : 'A'}${selectedDualDot.index + 1}` : ''}`
              : dots.length
                ? `좌표 ${dots.map((dot) => `(${dot.meter_x}, ${dot.meter_y})`).join(' / ')}`
                : '좌표 없음'}
          </span>
        </div>
      </section>
    </div>
  );
}
