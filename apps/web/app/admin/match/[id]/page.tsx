'use client';

import LineupUniforms from '../../../../components/LineupUniforms';
import AttackDirectionPitch from '../../../../components/AttackDirectionPitch';
import Link from 'next/link';
import { Fragment, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import HlsPlayer from '../../../../components/HlsPlayer';
import { ComposedChart, Area, Line, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceDot, ReferenceLine, ResponsiveContainer } from 'recharts';
import { API_BASE, apiFetch, apiJson, type SessionUser } from '../../../../lib/api';
import { resolveMatchTeams } from '../../dashboard/schedule-data';

const DEFAULT_HLS = process.env.NEXT_PUBLIC_DEFAULT_HLS_URL || '';
const HALF_PITCH_LENGTH = 52.5;
const XG_VISIBLE_LENGTH = 40;
const XG_VISIBLE_OFFSET = HALF_PITCH_LENGTH - XG_VISIBLE_LENGTH;
const PITCH_WIDTH = 68;
const FUTSAL_HALF_PITCH_LENGTH = 20;
const FUTSAL_PITCH_WIDTH = 20;

function futsalShotThreat(x: number, y: number) {
  // The stored coordinate is a 40 × 20 m court coordinate attacking the
  // right goal.  This matches the FPA Queen Cup ShotThreat proxy (cap .80).
  const dx = Math.max(0.001, 40 - x);
  const offset = y - 10;
  const distance = Math.hypot(dx, offset);
  const angle = Math.abs(Math.atan2(1.5 - offset, dx) - Math.atan2(-1.5 - offset, dx));
  return Math.max(0, Math.min(0.8, 0.8 * Math.exp(-0.1 * distance) * Math.pow(angle / Math.PI, 0.55)));
}

function FutsalShotPitch({
  shotPoint,
  onClick,
  isOnTarget,
}: {
  shotPoint: { x: number; y: number } | null;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
  isOnTarget: boolean;
}) {
  return (
    <div
      className="futsal-shot-pitch"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label="풋살 슛 위치 입력 피치"
    >
      <svg viewBox="-2 -2 24 24" preserveAspectRatio="none" aria-hidden="true">
        <rect x="-2" y="-2" width="24" height="24" fill="#e6302f" />
        <rect x="0" y="0" width="20" height="20" fill="#007ac0" />
        <g fill="none" stroke="#fff" strokeWidth="0.14">
          <rect x="0" y="0" width="20" height="20" />
          <path d="M8.5 0V-1.2H11.5V0M2.17 0A6 6 0 0 1 8.17 6H11.83A6 6 0 0 1 17.83 0" />
          <path d="M0 20H20M0 0H20" />
        </g>
        <g fill="#fff"><circle cx="10" cy="6" r=".12" /><circle cx="10" cy="10" r=".12" /></g>
      </svg>
      {shotPoint ? <span className="futsal-shot-marker" style={{ left: `${(shotPoint.y / FUTSAL_PITCH_WIDTH) * 100}%`, top: `${(1 - shotPoint.x / FUTSAL_HALF_PITCH_LENGTH) * 100}%` }} /> : null}
      <span className="futsal-shot-pitch-label top">상대 골문</span>
      <span className="futsal-shot-pitch-label bottom">20m × 20m · 공격 하프</span>
      <span className="futsal-shot-pitch-label state">{isOnTarget ? '골문 좌표 입력 활성화' : '피치를 눌러 슛 위치 입력'}</span>
    </div>
  );
}

function regulationHalfMinutes(competitionClass?: string | null, firstHalfMinutes?: number | null) {
  if (Number.isFinite(Number(firstHalfMinutes)) && Number(firstHalfMinutes) > 0) {
    return Number(firstHalfMinutes);
  }
  const normalized = (competitionClass || '').trim().toUpperCase();
  if (normalized.includes('SUFA')) return 20;
  return 45;
}

type Team = 'HOME' | 'AWAY';
type PossessionTeam = Team | 'NONE';
type ClockSpeed = 1 | 2;
type Lane = 'LEFT' | 'CENTER' | 'RIGHT';
type AttackLR = 'L2R' | 'R2L';
type LineupPlayer = { number: string; position?: string; name: string; label?: string };

function fmt(ms: number) {
  // Match clock: minutes accumulate past 60 (e.g. 90:00, 120:00) instead of rolling into hours.
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatCreatedAtKst(createdAt: string) {
  const raw = /Z$|[+-]\d{2}:\d{2}$/.test(createdAt) ? createdAt : `${createdAt}Z`;
  const d = new Date(raw);
  return d.toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
}

function formatDateTimeKst(value: string | null | undefined) {
  if (!value) return '-';
  const raw = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
  const d = new Date(raw);
  return d.toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
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

  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [match, setMatch] = useState<any>(null);
  const [summary, setSummary] = useState<any>(null);
  const [dominance, setDominance] = useState<any[]>([]);
  const [dominanceMeta, setDominanceMeta] = useState<any>(null);
  const [outbox, setOutbox] = useState<any[]>([]);
  const [possessionLogs, setPossessionLogs] = useState<string[]>([]);

  const [clockMs, setClockMs] = useState(0);
  const [running, setRunning] = useState(false);
  const [possessionTeam, setPossessionTeam] = useState<PossessionTeam>('NONE');
  const [selectedTeam, setSelectedTeam] = useState<Team>('HOME');
  const [pendingLane, setPendingLane] = useState<Lane>('CENTER');
  const [attackLR, setAttackLR] = useState<AttackLR>('L2R');

  const [xgTeam, setXgTeam] = useState<Team>('HOME');
  const [xgValue, setXgValue] = useState('0.10');
  const [xgotValue, setXgotValue] = useState('0.000');
  const [xgPlayerKey, setXgPlayerKey] = useState('');
  const [lineupFirstSide, setLineupFirstSide] = useState<Team | 'AUTO'>('AUTO');
  const [isUploadingLineup, setIsUploadingLineup] = useState(false);
  const [isUploadingRecordSheet, setIsUploadingRecordSheet] = useState(false);
  const [isSwappingLineup, setIsSwappingLineup] = useState(false);
  const [manualLineupSide, setManualLineupSide] = useState<Team>('HOME');
  const [manualLineupNumber, setManualLineupNumber] = useState('');
  const [manualLineupPosition, setManualLineupPosition] = useState('');
  const [manualLineupName, setManualLineupName] = useState('');
  const [isSavingManualLineup, setIsSavingManualLineup] = useState(false);
  const [isManualLineupOpen, setIsManualLineupOpen] = useState(false);
  const setupRef = useRef<HTMLDetailsElement | null>(null);
  const lineupInputRef = useRef<HTMLInputElement | null>(null);
  const recordSheetInputRef = useRef<HTMLInputElement | null>(null);
  const [shotPoint, setShotPoint] = useState<{ x: number; y: number } | null>(null);
  const [isOnTargetShot, setIsOnTargetShot] = useState(false);
  const [goalmouthPoint, setGoalmouthPoint] = useState<{ x: number; y: number } | null>(null);
  const [isHeaderShot, setIsHeaderShot] = useState(false);
  const [isGoalShot, setIsGoalShot] = useState(false);
  const [isOwnGoal, setIsOwnGoal] = useState(false);
  const [isUnderPressureShot, setIsUnderPressureShot] = useState(false);
  const [isOneOnOneShot, setIsOneOnOneShot] = useState(false);
  const [xgEstimateMeta, setXgEstimateMeta] = useState('');
  const [xgotEstimateMeta, setXgotEstimateMeta] = useState('');
  const [mobileView, setMobileView] = useState<'control' | 'shots' | 'review' | 'settings'>('control');
  const [controlNotice, setControlNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [isSavingShot, setIsSavingShot] = useState(false);
  const shotPendingRef = useRef(false);
  const timerPendingRef = useRef(false);
  const lanePendingRef = useRef(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [isAttachingStream, setIsAttachingStream] = useState(false);
  const [isStoppingStream, setIsStoppingStream] = useState(false);
  const [isClearingHls, setIsClearingHls] = useState(false);
  const [isResettingPossession, setIsResettingPossession] = useState(false);
  const [isResettingEvents, setIsResettingEvents] = useState(false);
  const [isExportingMatchData, setIsExportingMatchData] = useState(false);
  const [secondHalfStartAbsMs, setSecondHalfStartAbsMs] = useState<number | null>(null);
  const [thirdHalfStartAbsMs, setThirdHalfStartAbsMs] = useState<number | null>(null);
  const [fourthHalfStartAbsMs, setFourthHalfStartAbsMs] = useState<number | null>(null);
  const [clockSpeed, setClockSpeed] = useState<ClockSpeed>(1);

  const perfRef = useRef<number | null>(null);
  const baseRef = useRef<number>(0);
  const clockRef = useRef<number>(0);
  const clockSpeedRef = useRef<ClockSpeed>(1);
  const runningRef = useRef<boolean>(false);
  const initializedRef = useRef<boolean>(false);
  const lastPossessionLogSecondRef = useRef<number>(-1);
  const fetchSeqRef = useRef<number>(0);

  const lineups = (match?.metadata?.lineups?.teams || {}) as Partial<Record<Team, LineupPlayer[]>>;
  const hasLineupPlayers = Boolean((lineups.HOME || []).length || (lineups.AWAY || []).length);
  const isFutsal = match?.sport === 'FUTSAL';
  const xgPlayerOptions = useMemo(() => lineups[xgTeam] || [], [lineups, xgTeam]);
  const selectedXgPlayer = useMemo(
    () => xgPlayerOptions.find((player) => `${player.number}|${player.name}` === xgPlayerKey) || null,
    [xgPlayerOptions, xgPlayerKey]
  );

  const displayClockLabel = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const firstHalfMin = regulationHalfMinutes(match?.competition_class, match?.first_half_minutes);
    const secondHalfMin = Number(match?.second_half_minutes) > 0 ? Number(match?.second_half_minutes) : firstHalfMin;
    const extraFirstHalfMin = Number(match?.extra_first_half_minutes) > 0 ? Number(match?.extra_first_half_minutes) : 15;
    const base2Sec = firstHalfMin * 60; // 2H display base (e.g. 45:00)
    const base3Sec = (firstHalfMin + secondHalfMin) * 60; // 3H display base (e.g. 90:00)
    const base4Sec = (firstHalfMin + secondHalfMin + extraFirstHalfMin) * 60; // 4H display base (e.g. 105:00)
    if (fourthHalfStartAbsMs != null && ms >= fourthHalfStartAbsMs) {
      const sec = Math.max(0, Math.floor((ms - fourthHalfStartAbsMs) / 1000));
      return fmt((base4Sec + sec) * 1000);
    }
    if (thirdHalfStartAbsMs != null && ms >= thirdHalfStartAbsMs) {
      const sec = Math.max(0, Math.floor((ms - thirdHalfStartAbsMs) / 1000));
      return fmt((base3Sec + sec) * 1000);
    }
    if (secondHalfStartAbsMs != null && ms >= secondHalfStartAbsMs) {
      const sec2h = Math.max(0, Math.floor((ms - secondHalfStartAbsMs) / 1000));
      return fmt((base2Sec + sec2h) * 1000);
    }
    if (totalSec > base2Sec) {
      const etSec = totalSec - base2Sec;
      const etMin = Math.floor(etSec / 60);
      const etRem = String(etSec % 60).padStart(2, '0');
      return `1H ${firstHalfMin}+${etMin}:${etRem}`;
    }
    return fmt(ms);
  };

  const getShotCoordinates = () => {
    if (!shotPoint) return null;
    if (isFutsal) {
      return {
        shot_x: Number((FUTSAL_HALF_PITCH_LENGTH + shotPoint.x).toFixed(2)),
        shot_y: Number(shotPoint.y.toFixed(2)),
      };
    }
    return {
      shot_x: Number((HALF_PITCH_LENGTH + XG_VISIBLE_OFFSET + shotPoint.x).toFixed(2)),
      shot_y: shotPoint.y,
    };
  };

  const getGoalmouthCoordinates = () => {
    if (!goalmouthPoint) return null;
    return {
      goalmouth_x: Number(goalmouthPoint.x.toFixed(3)),
      goalmouth_y: Number(goalmouthPoint.y.toFixed(3)),
    };
  };

  const dominanceHalfNominalMinutes = (): Record<number, number> => {
    const firstHalfMin = regulationHalfMinutes(match?.competition_class, match?.first_half_minutes);
    const secondHalfMin = Number(match?.second_half_minutes) > 0 ? Number(match?.second_half_minutes) : firstHalfMin;
    const extraFirstHalfMin = Number(match?.extra_first_half_minutes) > 0 ? Number(match?.extra_first_half_minutes) : 15;
    const extraSecondHalfMin = Number(match?.extra_second_half_minutes) > 0 ? Number(match?.extra_second_half_minutes) : 15;
    return { 1: firstHalfMin, 2: secondHalfMin, 3: extraFirstHalfMin, 4: extraSecondHalfMin };
  };

  // Lay each period end-to-end on the chart axis (with a gap between periods),
  // so ticks/labels work for 1H/2H and, when marked, 3H/4H.
  const buildDominancePeriodLayout = () => {
    if (!dominanceMeta?.split_halves) return null;
    const halves = (dominanceMeta.halves || []) as Array<{ period: number; duration_ms: number }>;
    const gap = Number(dominanceMeta.half_gap_ms || 0);
    const nominal = dominanceHalfNominalMinutes();
    let cursor = 0;
    const layout: Array<{ period: number; chartStartMs: number; durationMs: number; nominalMin: number }> = [];
    halves.forEach((half, index) => {
      const durationMs = Number(half.duration_ms || 0);
      layout.push({ period: half.period, chartStartMs: cursor, durationMs, nominalMin: nominal[half.period] || 0 });
      cursor += durationMs;
      if (index < halves.length - 1) cursor += gap;
    });
    return layout;
  };

  const formatDominanceTick = (minuteVal: number) => {
    const ms = Math.round(Number(minuteVal) * 60000);
    const layout = buildDominancePeriodLayout();
    if (layout) {
      for (const seg of layout) {
        if (ms >= seg.chartStartMs && ms <= seg.chartStartMs + seg.durationMs) {
          const rel = ms - seg.chartStartMs;
          if (seg.durationMs > 0 && rel === seg.durationMs) {
            const extraMinutes = Math.round((seg.durationMs - seg.nominalMin * 60000) / 60000);
            return extraMinutes > 0 ? `${seg.nominalMin}+${extraMinutes}` : String(seg.nominalMin);
          }
          return String(Math.floor(rel / 60000));
        }
      }
      return String(Math.floor(ms / 60000));
    }
    const baseHalfMinutes = regulationHalfMinutes(match?.competition_class, match?.first_half_minutes);
    const baseHalfMs = baseHalfMinutes * 60000;
    if (dominanceSecondHalfStartMs != null && ms >= dominanceSecondHalfStartMs) {
      const sec2h = Math.max(0, Math.floor((ms - dominanceSecondHalfStartMs) / 1000));
      return String(Math.floor(sec2h / 60));
    }
    const sec = Math.floor(ms / 1000);
    if (sec > baseHalfMs / 1000) {
      const etMin = Math.floor((sec - baseHalfMs / 1000) / 60);
      return `${baseHalfMinutes}+${etMin}`;
    }
    return String(Math.floor(sec / 60));
  };

  useEffect(() => {
    clockRef.current = clockMs;
  }, [clockMs]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    clockSpeedRef.current = clockSpeed;
  }, [clockSpeed]);

  useEffect(() => {
    if (!id) return;
    const raw = window.localStorage.getItem(`clockSpeed:${id}`);
    if (raw === '2') {
      setClockSpeed(2);
      clockSpeedRef.current = 2;
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    window.localStorage.setItem(`clockSpeed:${id}`, String(clockSpeed));
  }, [id, clockSpeed]);

  useEffect(() => {
    if (!id) return;
    const raw = window.localStorage.getItem(`secondHalfStartAbsMs:${id}`);
    if (!raw) return;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      setSecondHalfStartAbsMs(n);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const key = `secondHalfStartAbsMs:${id}`;
    if (secondHalfStartAbsMs == null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, String(secondHalfStartAbsMs));
  }, [id, secondHalfStartAbsMs]);

  useEffect(() => {
    if (!id) return;
    const raw3 = window.localStorage.getItem(`thirdHalfStartAbsMs:${id}`);
    if (raw3) {
      const n = Number(raw3);
      if (Number.isFinite(n) && n >= 0) setThirdHalfStartAbsMs(n);
    }
    const raw4 = window.localStorage.getItem(`fourthHalfStartAbsMs:${id}`);
    if (raw4) {
      const n = Number(raw4);
      if (Number.isFinite(n) && n >= 0) setFourthHalfStartAbsMs(n);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const key = `thirdHalfStartAbsMs:${id}`;
    if (thirdHalfStartAbsMs == null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, String(thirdHalfStartAbsMs));
  }, [id, thirdHalfStartAbsMs]);

  useEffect(() => {
    if (!id) return;
    const key = `fourthHalfStartAbsMs:${id}`;
    if (fourthHalfStartAbsMs == null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, String(fourthHalfStartAbsMs));
  }, [id, fourthHalfStartAbsMs]);

  useEffect(() => {
    if (possessionTeam === 'HOME' || possessionTeam === 'AWAY') {
      setSelectedTeam(possessionTeam);
      setXgTeam(possessionTeam);
    }
  }, [possessionTeam]);

  useEffect(() => {
    setXgPlayerKey('');
  }, [xgTeam, match?.metadata?.lineup_pdf_uploaded_at, match?.metadata?.lineup_record_sheet_uploaded_at, match?.metadata?.lineup_manual_updated_at]);

  useEffect(() => {
    if (isGoalShot && !isOnTargetShot) {
      setIsOnTargetShot(true);
    }
  }, [isGoalShot, isOnTargetShot]);

  // Own goal is not a shot by the crediting team: clear shot-specific toggles
  // so only the pitch location and the scoring team matter.
  useEffect(() => {
    if (isOwnGoal) {
      setIsGoalShot(false);
      setIsOnTargetShot(false);
      setIsHeaderShot(false);
      setIsUnderPressureShot(false);
      setIsOneOnOneShot(false);
    }
  }, [isOwnGoal]);

  useEffect(() => {
    if (!isOnTargetShot) {
      setGoalmouthPoint(null);
      setXgotValue('0.000');
      setXgotEstimateMeta('');
    }
  }, [isOnTargetShot]);

  useEffect(() => {
    apiJson<SessionUser>('/session/me')
      .then(setSessionUser)
      .catch(() => setSessionUser(null));
  }, []);

  const userId = sessionUser?.id || '';
  const isArchived = Boolean(match?.archived);
  const isSuperuser = sessionUser?.role === 'SUPERADMIN';
  const isManualMatch = match?.metadata?.stream_mode === 'MANUAL';
  const canUseX2 = isSuperuser && isManualMatch;
  const isOperator = useMemo(
    () => !isArchived && (isSuperuser || Boolean(match?.operator_id && match.operator_id === userId)),
    [isArchived, isSuperuser, match, userId]
  );
  const canWrite = useMemo(
    () => !isArchived && Boolean(userId) && (isSuperuser || !match?.operator_id || match.operator_id === userId),
    [isArchived, isSuperuser, match, userId]
  );

  const getCurrentClockMs = () => {
    if (!runningRef.current || perfRef.current == null) {
      return clockRef.current;
    }
    return Math.floor(baseRef.current + (performance.now() - perfRef.current) * clockSpeedRef.current);
  };

  // Switching speed mid-run must not rescale already-elapsed time: freeze the
  // current clock as the new base, then let the new speed apply from now on.
  const changeClockSpeed = (nextSpeed: ClockSpeed) => {
    if (!canWrite || nextSpeed === clockSpeed) return;
    if (nextSpeed === 2 && !canUseX2) return;
    if (runningRef.current && perfRef.current != null) {
      const frozen = getCurrentClockMs();
      baseRef.current = frozen;
      perfRef.current = performance.now();
      setClockMs(frozen);
    }
    setClockSpeed(nextSpeed);
    clockSpeedRef.current = nextSpeed;
  };

  // X2 mode is superadmin-only and manual-match-only: if a session lands on a
  // match it can't use 2x on but localStorage still says 2x (set earlier by an
  // admin on a manual match on this browser), freeze the clock at its current
  // value and drop back to 1x. Wait until both session and match are loaded so
  // an eligible match isn't reset before metadata arrives.
  useEffect(() => {
    if (!sessionUser || !match || canUseX2 || clockSpeedRef.current !== 2) return;
    if (runningRef.current && perfRef.current != null) {
      const frozen = getCurrentClockMs();
      baseRef.current = frozen;
      perfRef.current = performance.now();
      setClockMs(frozen);
    }
    setClockSpeed(1);
    clockSpeedRef.current = 1;
  }, [sessionUser, match, canUseX2, clockSpeed]);

  const saveState = async (
    next?: Partial<{clockMs:number; running:boolean; possessionTeam:PossessionTeam; selectedTeam:Team; attackLR:AttackLR; allowClockRewind:boolean;}>
  ) => {
    const effectiveClockMs = next?.clockMs ?? getCurrentClockMs();
    const payload = {
      state_id: makeId(),
      clock_ms: effectiveClockMs,
      running: next?.running ?? running,
      possession_team: next?.possessionTeam ?? possessionTeam,
      selected_team: next?.selectedTeam ?? selectedTeam,
      attack_lr: next?.attackLR ?? attackLR,
      allow_clock_rewind: Boolean(next?.allowClockRewind),
    };
    await apiJson(`/matches/${id}/state`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  };

  const fetchAll = async () => {
    const seq = ++fetchSeqRef.current;
    const [m, s, d] = await Promise.all([
      apiJson<any>(`/matches/${id}`),
      apiJson<any>(`/matches/${id}/summary`),
      apiJson<any>(`/matches/${id}/dominance?bin_seconds=180&split_halves=true`),
    ]);
    if (seq !== fetchSeqRef.current) return;
    setLoadError('');
    setMatch(m);
    setSummary(s);
    setDominance(d.bins || []);
    setDominanceMeta(d);

    if (s?.state && !initializedRef.current) {
      initializedRef.current = true;
      setClockMs(s.state.clock_ms || 0);
      setRunning(Boolean(s.state.running));
      setPossessionTeam(s.state.possession_team || 'NONE');
      setSelectedTeam(s.state.selected_team || 'HOME');
      setXgTeam(s.state.selected_team || 'HOME');
      setAttackLR((s.state.attack_lr || 'L2R') as AttackLR);
      baseRef.current = s.state.clock_ms || 0;
      perfRef.current = s.state.running ? performance.now() : null;
    }
  };

  const fetchOutbox = async () => {
    const data = await apiJson<any[]>(`/outbox`);
    setOutbox(data || []);
  };

  useEffect(() => {
    const refresh = () => fetchAll().catch(() => setLoadError('경기 데이터를 불러오지 못했습니다. 연결을 확인해 주세요.'));
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    fetchOutbox().catch(() => undefined);
    const t = setInterval(() => {
      fetchOutbox().catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    const s = summary?.state;
    const p = summary?.possession;
    if (!s || !p) return;
    if (!s.running) return;

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
    const line = `${displayClockLabel(second * 1000)} | ${teamLabel} | ${homePct} : ${awayPct}`;

    setPossessionLogs((prev) => [line, ...prev].slice(0, 120));
  }, [summary]);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const loop = () => {
      if (perfRef.current != null) {
        const delta = (performance.now() - perfRef.current) * clockSpeedRef.current;
        setClockMs(Math.floor(baseRef.current + delta));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  useEffect(() => {
    const t = setInterval(() => {
      if (canWrite && runningRef.current) {
        saveState({ clockMs: clockRef.current }).catch(() => undefined);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [running, possessionTeam, selectedTeam, attackLR, canWrite]);

  const toggleRun = async () => {
    if (!canWrite || timerPendingRef.current) return;
    timerPendingRef.current = true;
    const wasRunning = runningRef.current;
    const frozen = getCurrentClockMs();
    try {
      await saveState({clockMs: frozen, running: !wasRunning});
      baseRef.current = frozen;
      perfRef.current = wasRunning ? null : performance.now();
      setClockMs(frozen);
      setRunning(!wasRunning);
      runningRef.current = !wasRunning;
    } catch { setControlNotice('시간 변경을 저장하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.'); }
    finally { timerPendingRef.current = false; }
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

  const exportMatchData = async () => {
    if (isExportingMatchData) return;
    setIsExportingMatchData(true);
    try {
      const res = await apiFetch(`/matches/${id}/export.csv`, {
        method: 'GET',
        headers: {},
      });
      if (!res.ok) {
        setCopyMessage(`Match export failed (${res.status})`);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const disposition = res.headers.get('content-disposition') || '';
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
      a.href = url;
      a.download = fileNameMatch?.[1] || `match_export_${id}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setCopyMessage('Match data exported');
    } catch {
      setCopyMessage('Match export failed');
    } finally {
      setIsExportingMatchData(false);
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  const resetPossessionLogView = () => {
    if (!window.confirm('Possession Timeline Log 표시 기록을 비울까요?')) return;
    setPossessionLogs([]);
    lastPossessionLogSecondRef.current = -1;
  };

  const resetClock = async () => {
    if (!canWrite) return;
    if (!window.confirm('타이머를 00:00으로 초기화할까요?')) return;
    setClockMs(0);
    baseRef.current = 0;
    perfRef.current = null;
    setRunning(false);
    setSecondHalfStartAbsMs(null);
    setThirdHalfStartAbsMs(null);
    setFourthHalfStartAbsMs(null);
    await saveState({ clockMs: 0, running: false, allowClockRewind: true, possessionTeam: 'NONE' });
  };

  const startFirstHalf = async () => {
    if (!canWrite) return;
    if (!window.confirm('타이머를 1H 00:00으로 설정할까요?')) return;
    setClockMs(0);
    baseRef.current = 0;
    perfRef.current = null;
    setRunning(false);
    setSecondHalfStartAbsMs(null);
    setThirdHalfStartAbsMs(null);
    setFourthHalfStartAbsMs(null);
    setPossessionTeam('NONE');
    await saveState({
      clockMs: 0,
      running: false,
      possessionTeam: 'NONE',
      allowClockRewind: true,
    });
    await fetchAll();
  };

  const markSecondHalfStart = async () => {
    if (!canWrite) return;
    const baseHalfMinutes = regulationHalfMinutes(match?.competition_class, match?.first_half_minutes);
    if (!window.confirm(`지금 시점을 2H 시작(표시 ${baseHalfMinutes}:00)으로 설정할까요?`)) return;
    const now = clockRef.current;
    setSecondHalfStartAbsMs(now);
    setRunning(false);
    perfRef.current = null;
    await apiFetch(`/matches/${id}/markers`, {
      method: 'POST',
      body: JSON.stringify({ marker_type: 'HALFTIME_START', clock_ms: now }),
    });
    await saveState({ running: false, possessionTeam: 'NONE' });
    await fetchAll();
  };

  const extraHalfBaseMinutes = (period: 3 | 4) => {
    const firstHalfMin = regulationHalfMinutes(match?.competition_class, match?.first_half_minutes);
    const secondHalfMin = Number(match?.second_half_minutes) > 0 ? Number(match?.second_half_minutes) : firstHalfMin;
    const extraFirstHalfMin = Number(match?.extra_first_half_minutes) > 0 ? Number(match?.extra_first_half_minutes) : 15;
    return period === 3 ? firstHalfMin + secondHalfMin : firstHalfMin + secondHalfMin + extraFirstHalfMin;
  };

  const markThirdHalfStart = async () => {
    if (!canWrite) return;
    const baseMin = extraHalfBaseMinutes(3);
    if (!window.confirm(`지금 시점을 연장 전반(3H) 시작(표시 ${baseMin}:00)으로 설정할까요?`)) return;
    const now = clockRef.current;
    setThirdHalfStartAbsMs(now);
    setFourthHalfStartAbsMs(null);
    setRunning(false);
    perfRef.current = null;
    await apiFetch(`/matches/${id}/markers`, {
      method: 'POST',
      body: JSON.stringify({ marker_type: 'EXTRA_TIME_1_START', clock_ms: now }),
    });
    await saveState({ running: false, possessionTeam: 'NONE' });
    await fetchAll();
  };

  const markFourthHalfStart = async () => {
    if (!canWrite) return;
    const baseMin = extraHalfBaseMinutes(4);
    if (!window.confirm(`지금 시점을 연장 후반(4H) 시작(표시 ${baseMin}:00)으로 설정할까요?`)) return;
    const now = clockRef.current;
    setFourthHalfStartAbsMs(now);
    setRunning(false);
    perfRef.current = null;
    await apiFetch(`/matches/${id}/markers`, {
      method: 'POST',
      body: JSON.stringify({ marker_type: 'EXTRA_TIME_2_START', clock_ms: now }),
    });
    await saveState({ running: false, possessionTeam: 'NONE' });
    await fetchAll();
  };

  const changePossession = async (team: PossessionTeam) => {
    if (!canWrite) return;
    try {
      await saveState(team === 'NONE' ? {possessionTeam: team} : {possessionTeam: team, selectedTeam: team});
      setPossessionTeam(team);
      if (team !== 'NONE') { setSelectedTeam(team); setXgTeam(team); }
    } catch { setControlNotice('점유 팀을 저장하지 못했습니다. 다시 시도해 주세요.'); }
  };

  const selectEventTeam = async (team: Team) => {
    setSelectedTeam(team);
    setXgTeam(team);
    if (canWrite) {
      await saveState({ selectedTeam: team });
    }
  };

  const changeAttackDirection = async (direction: AttackLR) => {
    if (!canWrite) return;
    setAttackLR(direction);
    await saveState({ attackLR: direction });
  };

  const resetPossession = async () => {
    if (!canWrite || isResettingPossession) return;
    if (!window.confirm('점유율 집계를 0:0으로 초기화할까요?')) return;
    setIsResettingPossession(true);
    try {
      let res = await apiFetch(`/matches/${id}/possession/reset`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        const detail = await res.text();
        const confirmLive = window.confirm(`${detail}\n\n계속 초기화할까요?`);
        if (!confirmLive) return;
        res = await apiFetch(`/matches/${id}/possession/reset?confirm_live_action=true`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
      }
      if (!res.ok) {
        setCopyMessage('Possession reset failed');
      } else {
        setPossessionLogs([]);
        lastPossessionLogSecondRef.current = -1;
        setPossessionTeam('NONE');
        await saveState({ possessionTeam: 'NONE' });
        setCopyMessage('Possession reset');
        await fetchAll();
      }
    } catch {
      setCopyMessage('Possession reset failed');
    } finally {
      setIsResettingPossession(false);
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  const resetEvents = async () => {
    if (!canWrite || isResettingEvents) return;
    if (!window.confirm('공격방향/xG 이벤트를 모두 초기화할까요?')) return;
    setIsResettingEvents(true);
    try {
      let res = await apiFetch(`/matches/${id}/events/reset`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        const detail = await res.text();
        const confirmLive = window.confirm(`${detail}\n\n계속 초기화할까요?`);
        if (!confirmLive) return;
        res = await apiFetch(`/matches/${id}/events/reset?confirm_live_action=true`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
      }
      if (!res.ok) {
        setCopyMessage('Event reset failed');
      } else {
        setCopyMessage('Events reset');
        await fetchAll();
      }
    } catch {
      setCopyMessage('Event reset failed');
    } finally {
      setIsResettingEvents(false);
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  const sendLane = async (lane: Lane) => {
    if (!canWrite || lanePendingRef.current) return;
    lanePendingRef.current = true;
    try {
      await apiJson(`/matches/${id}/events/attack_lane`, {
        method: 'POST', body: JSON.stringify({ event_id: makeId(), team: selectedTeam, lane, clock_ms: clockMs }),
      });
      setControlNotice(`${selectedTeam === 'HOME' ? '홈' : '어웨이'} · ${{LEFT:'왼쪽',CENTER:'중앙',RIGHT:'오른쪽'}[lane]} 공격을 기록했습니다.`);
      await fetchAll();
    } catch { setControlNotice('공격 기록을 저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { lanePendingRef.current = false; }
  };

  const uploadLineupPdf = async (file: File | null) => {
    if (!file || !canWrite || isUploadingLineup) return;
    setIsUploadingLineup(true);
    setCopyMessage('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('first_team_side', lineupFirstSide);
      const response = await fetch(`${API_BASE}/matches/${id}/lineup/pdf`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        throw new Error(typeof problem.detail === 'string' ? problem.detail : 'PDF 명단을 읽지 못했습니다.');
      }
      const data = await response.json();
      setMatch(data.match);
      const homeCount = data.lineups?.teams?.HOME?.length || 0;
      const awayCount = data.lineups?.teams?.AWAY?.length || 0;
      setCopyMessage(`PDF 명단 반영: 홈 ${homeCount}명 · 어웨이 ${awayCount}명. 아래 유니폼 정보와 팀 방향을 확인하세요.`);
    } catch (error) {
      setCopyMessage(error instanceof Error ? error.message : 'Lineup upload failed');
    } finally {
      setIsUploadingLineup(false);
      if (lineupInputRef.current) lineupInputRef.current.value = '';
      setTimeout(() => setCopyMessage(''), 2500);
    }
  };

  const uploadLineupRecordSheet = async (file: File | null) => {
    if (!file || !canWrite || isUploadingRecordSheet) return;
    setIsUploadingRecordSheet(true);
    setCopyMessage('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('first_team_side', lineupFirstSide === 'AUTO' ? 'HOME' : lineupFirstSide);
      const response = await fetch(`${API_BASE}/matches/${id}/lineup/record-sheet`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!response.ok) {
        throw new Error((await response.text()) || 'Excel lineup upload failed');
      }
      const data = await response.json();
      setMatch(data.match);
      const homeCount = data.lineups?.teams?.HOME?.length || 0;
      const awayCount = data.lineups?.teams?.AWAY?.length || 0;
      setCopyMessage(`엑셀 명단 반영: 홈 ${homeCount}명 / 원정 ${awayCount}명`);
    } catch (error) {
      setCopyMessage(error instanceof Error ? error.message : 'Excel lineup upload failed');
    } finally {
      setIsUploadingRecordSheet(false);
      if (recordSheetInputRef.current) recordSheetInputRef.current.value = '';
      setTimeout(() => setCopyMessage(''), 3000);
    }
  };

  const swapLineupSides = async () => {
    if (!canWrite || isSwappingLineup || !hasLineupPlayers) return;
    setIsSwappingLineup(true);
    setCopyMessage('');
    try {
      const response = await apiFetch(`/matches/${id}/lineup/swap`, { method: 'POST' });
      if (!response.ok) {
        throw new Error((await response.text()) || 'Lineup swap failed');
      }
      const data = await response.json();
      setMatch(data.match);
      const homeCount = data.lineups?.teams?.HOME?.length || 0;
      const awayCount = data.lineups?.teams?.AWAY?.length || 0;
      setCopyMessage(`Lineup swapped: HOME ${homeCount}, AWAY ${awayCount}`);
    } catch (error) {
      setCopyMessage(error instanceof Error ? error.message : 'Lineup swap failed');
    } finally {
      setIsSwappingLineup(false);
      setTimeout(() => setCopyMessage(''), 2500);
    }
  };

  const saveManualLineupPlayer = async () => {
    if (!canWrite || isSavingManualLineup) return;
    const number = manualLineupNumber.trim();
    const name = manualLineupName.trim();
    if (!number || !name) {
      setCopyMessage('Manual lineup needs number and name');
      setTimeout(() => setCopyMessage(''), 2000);
      return;
    }
    setIsSavingManualLineup(true);
    setCopyMessage('');
    try {
      const response = await apiFetch(`/matches/${id}/lineup/manual/player`, {
        method: 'POST',
        body: JSON.stringify({
          side: manualLineupSide,
          number,
          position: manualLineupPosition || null,
          name,
        }),
      });
      if (!response.ok) {
        throw new Error((await response.text()) || 'Manual lineup save failed');
      }
      const data = await response.json();
      setMatch(data.match);
      setManualLineupNumber('');
      setManualLineupName('');
      setCopyMessage(`Manual player saved: ${manualLineupSide} No.${number} ${name}`);
    } catch (error) {
      setCopyMessage(error instanceof Error ? error.message : 'Manual lineup save failed');
    } finally {
      setIsSavingManualLineup(false);
      setTimeout(() => setCopyMessage(''), 2500);
    }
  };

  const deleteManualLineupPlayer = async (side: Team, number: string) => {
    if (!canWrite || isSavingManualLineup) return;
    setIsSavingManualLineup(true);
    setCopyMessage('');
    try {
      const response = await apiFetch(`/matches/${id}/lineup/manual/player/delete`, {
        method: 'POST',
        body: JSON.stringify({ side, number }),
      });
      if (!response.ok) {
        throw new Error((await response.text()) || 'Manual lineup delete failed');
      }
      const data = await response.json();
      setMatch(data.match);
      setCopyMessage(`Manual player removed: ${side} No.${number}`);
    } catch (error) {
      setCopyMessage(error instanceof Error ? error.message : 'Manual lineup delete failed');
    } finally {
      setIsSavingManualLineup(false);
      setTimeout(() => setCopyMessage(''), 2500);
    }
  };

  const submitXgInternal = async () => {
    if (!canWrite) return;
    const shotCoordinates = getShotCoordinates();

    // Own goal: counts as a goal for the selected (crediting) team, but carries
    // no xG/xGOT and no shot attributes. Team follows the same convention as a
    // normal goal — whichever side's score should go up.
    if (isOwnGoal) {
      if (!shotCoordinates) {
        setXgEstimateMeta('Click the pitch to set the own-goal location');
        return;
      }
      await apiJson(`/matches/${id}/events/xg`, {
        method: 'POST',
        body: JSON.stringify({
          event_id: makeId(),
          team: xgTeam,
          xg: 0,
          player_name: null,
          player_number: null,
          is_goal: true,
          is_own_goal: true,
          is_on_target: false,
          clock_ms: clockMs,
          shot_x: shotCoordinates.shot_x,
          shot_y: shotCoordinates.shot_y,
          goalmouth_x: null,
          goalmouth_y: null,
          is_header: false,
          is_weak_foot: false,
          under_pressure: false,
          one_on_one: false,
          shot_pace_band: 'MID',
        }),
      });
      setShotPoint(null);
      setIsOwnGoal(false);
      setXgEstimateMeta(`Own goal recorded → ${xgTeam}`);
      setXgotEstimateMeta('');
      await fetchAll();
      return;
    }

    const xg = Number(xgValue);
    if (!Number.isFinite(xg) || xg < 0 || xg > 1) { setXgEstimateMeta('xG는 0~1 사이의 숫자로 입력해 주세요.'); return; }
    const goalmouthCoordinates = getGoalmouthCoordinates();
    if (isOnTargetShot && !goalmouthCoordinates) {
      setXgotEstimateMeta('Click the goalmouth map for an on-target shot');
      return;
    }
    const res = await apiFetch(`/matches/${id}/events/xg`, {
      method: 'POST',
      body: JSON.stringify({
        event_id: makeId(),
        team: xgTeam,
        xg,
        player_name: selectedXgPlayer?.name || null,
        player_number: selectedXgPlayer?.number || null,
        is_goal: isGoalShot,
        is_on_target: isOnTargetShot,
        clock_ms: clockMs,
        shot_x: shotCoordinates?.shot_x ?? null,
        shot_y: shotCoordinates?.shot_y ?? null,
        goalmouth_x: goalmouthCoordinates?.goalmouth_x ?? null,
        goalmouth_y: goalmouthCoordinates?.goalmouth_y ?? null,
        is_header: isHeaderShot,
        is_weak_foot: false,
        under_pressure: isUnderPressureShot,
        one_on_one: isOneOnOneShot,
        shot_pace_band: 'MID',
      }),
    });
    if (!res.ok) throw new Error('Shot save failed');
    const data = await res.json().catch(() => null);
    setXgValue('0.10');
    setXgPlayerKey('');
    setXgotValue(data?.xgot_meta ? Number(data.xgot_meta.xgot).toFixed(3) : '0.000');
    setShotPoint(null);
    setIsOnTargetShot(false);
    setGoalmouthPoint(null);
    setIsHeaderShot(false);
    setIsGoalShot(false);
    setIsOwnGoal(false);
    setIsUnderPressureShot(false);
    setIsOneOnOneShot(false);
    setXgEstimateMeta('');
    setXgotEstimateMeta(
      data?.xgot_meta
        ? `xGOT=${data.xgot_meta.xgot} | delta=${data.xgot_meta.delta >= 0 ? '+' : ''}${data.xgot_meta.delta} | ${data.xgot_meta.label}`
        : ''
    );
    setControlNotice('슈팅을 기록했습니다. 기록 탭에서 확인할 수 있습니다.');
    await fetchAll();
  };

  const submitXg = async () => {
    if (shotPendingRef.current || !canWrite) return;
    shotPendingRef.current = true;
    setIsSavingShot(true);
    try { await submitXgInternal(); }
    catch { setControlNotice('슈팅 기록을 저장하지 못했습니다. 입력은 유지됩니다. 다시 시도해 주세요.'); }
    finally { shotPendingRef.current = false; setIsSavingShot(false); }
  };

  const attachRtmp = async () => {
    if (!canWrite || isAttachingStream) return;
    setIsAttachingStream(true);
    try {
      const res = await apiFetch(`/matches/${id}/stream`, {
        method: 'POST',
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
      const res = await apiFetch(`/matches/${id}/stream/stop`, { method: 'POST' });
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
      const res = await apiFetch(`/matches/${id}/stream/clear`, { method: 'POST' });
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
    // In both layouts top is the attacking goal. Queen Cup uses a 20 × 20 m
    // attacking half, while football keeps the existing 40 × 68 m zone.
    const y = (px / rect.width) * (isFutsal ? FUTSAL_PITCH_WIDTH : PITCH_WIDTH);
    const x = (1 - py / rect.height) * (isFutsal ? FUTSAL_HALF_PITCH_LENGTH : XG_VISIBLE_LENGTH);
    setShotPoint({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
    setXgEstimateMeta('');
  };

  const onGoalmouthClick = (e: { currentTarget: HTMLDivElement; clientX: number; clientY: number }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const x = Math.max(0, Math.min(1, px / rect.width));
    const y = Math.max(0, Math.min(1, 1 - py / rect.height));
    setGoalmouthPoint({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
    setXgotEstimateMeta('');
  };

  const estimateXgFromPitch = async () => {
    const shotCoordinates = getShotCoordinates();
    if (!shotPoint || !shotCoordinates) {
      setXgEstimateMeta('Click on the pitch first');
      return;
    }
    if (isFutsal) {
      const threat = futsalShotThreat(shotCoordinates.shot_x, shotCoordinates.shot_y);
      setXgValue(threat.toFixed(3));
      setXgEstimateMeta(`Shot Threat=${threat.toFixed(3)} / 0.800 · 골문 거리·각도 기반`);
      return;
    }
    const res = await apiFetch('/xg/estimate', {
      method: 'POST',
      body: JSON.stringify({
        // Fixed half-pitch mode: coordinates are already normalized toward the attacking goal.
        team: 'HOME',
        attack_lr: 'L2R',
        start_x: shotCoordinates.shot_x,
        start_y: shotCoordinates.shot_y,
        is_header: isHeaderShot,
        is_weak_foot: false,
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

  const estimateXgotFromGoalmouth = async () => {
    const xg = Number(xgValue);
    const goalmouthCoordinates = getGoalmouthCoordinates();
    if (!Number.isFinite(xg) || xg < 0) {
      setXgotEstimateMeta('Enter a valid xG first');
      return;
    }
    if (!isOnTargetShot) {
      setXgotEstimateMeta('Turn on On Target first');
      return;
    }
    if (!goalmouthCoordinates) {
      setXgotEstimateMeta('Click the goalmouth map first');
      return;
    }
    const res = await apiFetch('/xgot/estimate', {
      method: 'POST',
      body: JSON.stringify({
        xg,
        is_on_target: isOnTargetShot,
        goalmouth_x: goalmouthCoordinates.goalmouth_x,
        goalmouth_y: goalmouthCoordinates.goalmouth_y,
        is_goal: isGoalShot,
        is_header: isHeaderShot,
        is_weak_foot: false,
        under_pressure: isUnderPressureShot,
        one_on_one: isOneOnOneShot,
        shot_pace_band: 'MID',
      }),
    });
    if (!res.ok) {
      setXgotEstimateMeta(`Estimate failed (${res.status})`);
      return;
    }
    const data = await res.json();
    setXgotValue(Number(data.xgot).toFixed(3));
    setXgotEstimateMeta(
      `xGOT=${data.xgot} | delta=${data.delta >= 0 ? '+' : ''}${data.delta} | ${data.label}`
    );
  };

  const acquire = async () => {
    if (isArchived) return;
    const response = await apiFetch(`/matches/${id}/lock/acquire`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      setCopyMessage('Lock acquire failed');
      setTimeout(() => setCopyMessage(''), 1500);
      return;
    }
    await fetchAll();
  };

  const release = async () => {
    if (isArchived) return;
    const response = await apiFetch(`/matches/${id}/lock/release`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      setCopyMessage('Lock release failed');
      setTimeout(() => setCopyMessage(''), 1500);
      return;
    }
    await fetchAll();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A' || (e.target as HTMLElement)?.isContentEditable) return;

      // Space 로 경기 시계를 켜고 끄던 단축키는 뺐다 (2026-08-14).
      // 방송 중 오타 한 번에 시계가 멈추는데, 그게 일어난 걸 화면 보기 전엔 모른다.
      // 나머지 단축키(점유 Q/W/E · 레인 A/S/D · Enter)는 잘못 눌러도 되돌리기 쉬워 남긴다.
      // 시계는 Timer 패널의 Start/Pause 버튼으로만 조작한다.
      if (e.code === 'KeyQ') {
        changePossession('HOME');
      } else if (e.code === 'KeyW') {
        changePossession('AWAY');
      } else if (e.code === 'KeyE') {
        changePossession('NONE');
      } else if (e.code === 'KeyA') {
        setPendingLane('LEFT');
      } else if (e.code === 'KeyS') {
        setPendingLane('CENTER');
      } else if (e.code === 'KeyD') {
        setPendingLane('RIGHT');
      } else if (e.key === 'Enter') {
        sendLane(pendingLane);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, canWrite, possessionTeam, pendingLane]);

  const hlsSrc = match?.hls_url || DEFAULT_HLS;
  const streamMode = match?.metadata?.stream_mode === 'MANUAL' ? 'MANUAL' : 'STREAM';
  const hasStreamPlayer = streamMode === 'STREAM' && Boolean(hlsSrc);
  const rtmpServer = match?.metadata?.rtmp?.server_url || '';
  const streamKey = streamMode === 'MANUAL' ? '' : match?.metadata?.rtmp?.stream_key || id;
  const pushUrl = streamMode === 'MANUAL' ? '' : match?.metadata?.rtmp?.push_url || (rtmpServer && streamKey ? `${rtmpServer}/${streamKey}` : '');
  const possessionLabel =
    possessionTeam === 'HOME' ? 'Home' : possessionTeam === 'AWAY' ? 'Away' : 'Loose Ball';
  const matchTeams = useMemo(() => resolveMatchTeams((match?.name || '').replace(/^\[[^\]]+\]\s*/, '')), [match?.name]);
  const dominanceBaseData = useMemo(
    () =>
      dominance.map((d) => ({
        startMs: Number(d.start_ms || 0),
        minuteVal: Number((d.chart_start_ms ?? d.start_ms) || 0) / 60000,
        endMinuteVal: Number((d.chart_end_ms ?? d.end_ms) || 0) / 60000,
        dominance: Number(d.dominance || 0),
        midpointMinuteVal: Number((d.chart_midpoint_ms ?? ((d.start_ms + d.end_ms) / 2)) || 0) / 60000,
        annotations: d.annotations,
      })),
    [dominance]
  );
  const dominanceXAxisTicks = useMemo(
    () => {
      const ticks = dominanceBaseData.map((d) => d.minuteVal);
      if (!dominanceMeta?.split_halves) return ticks;
      const layout = buildDominancePeriodLayout();
      (layout || []).forEach((seg) => {
        if (seg.durationMs > 0) ticks.push((seg.chartStartMs + seg.durationMs) / 60000);
      });
      return Array.from(new Set(ticks)).sort((a, b) => a - b);
    },
    [dominanceBaseData, dominanceMeta]
  );
  const dominanceChartData = useMemo(() => {
    const lastIndex = dominanceBaseData.length - 1;
    return dominanceBaseData.map((d, index) => ({
      startMs: d.startMs,
      minuteVal: index === lastIndex && d.endMinuteVal > d.minuteVal ? d.endMinuteVal : d.minuteVal,
      endMinuteVal: d.endMinuteVal,
      dominance: d.dominance,
      midpointMinuteVal: d.midpointMinuteVal,
      annotations: d.annotations,
    }));
  }, [dominanceBaseData]);
  const dominanceSeriesData = useMemo(() => {
    const points: Array<{
      minuteVal: number;
      dominance: number;
      positiveDominance: number | null;
      negativeDominance: number | null;
    }> = [];
    dominanceChartData.forEach((point, index) => {
      if (index > 0) {
        const prev = dominanceChartData[index - 1];
        if ((prev.dominance < 0 && point.dominance > 0) || (prev.dominance > 0 && point.dominance < 0)) {
          const ratio = (0 - prev.dominance) / (point.dominance - prev.dominance);
          const crossMinuteVal = prev.minuteVal + (point.minuteVal - prev.minuteVal) * ratio;
          points.push({
            minuteVal: crossMinuteVal,
            dominance: 0,
            positiveDominance: 0,
            negativeDominance: 0,
          });
        }
      }
      points.push({
        minuteVal: point.minuteVal,
        dominance: point.dominance,
        positiveDominance: point.dominance > 0 ? point.dominance : point.dominance === 0 ? 0 : null,
        negativeDominance: point.dominance < 0 ? point.dominance : point.dominance === 0 ? 0 : null,
      });
    });
    return points;
  }, [dominanceChartData]);
  const dominanceSecondHalfStartMs = useMemo(() => {
    const htBin = dominance.find((bin) => Array.isArray(bin.annotations?.markers) && bin.annotations.markers.includes('HT'));
    if (htBin?.start_ms != null) {
      return Number(htBin.start_ms);
    }
    return secondHalfStartAbsMs;
  }, [dominance, secondHalfStartAbsMs]);

  return (
    <main className="page-stack fla-match" data-mobile-view={mobileView}>
      <header className="fla-match-heading">
        <div><div className="row fla-match-context"><Link className="button-link button-compact btn-secondary fla-back-link" href="/admin/dashboard">← 대시보드</Link><span className="status-pill">{match?.competition_class || 'FLA'}</span>{match?.metadata?.design_preview ? <span className="status-pill tech">로컬 예시 경기</span> : null}<span className="muted">{isArchived ? '보관 경기 · 읽기 전용' : canWrite ? '기록 가능' : '읽기 전용'}</span></div><h2>{matchTeams ? `${matchTeams.homeTeam} vs ${matchTeams.awayTeam}` : match?.name || '경기 불러오는 중…'}</h2></div>
      </header>
          <details ref={setupRef} className="card fla-setup" id="match-setup"><summary>명단 · 운영권 · 데이터 내보내기</summary>
      <div className="row fla-setup-content" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="grid" style={{ gap: 6 }}>
          <div className="match-meta-group">

            <span className={`meta-chip ${streamMode === 'STREAM' ? 'tech' : 'warning'}`}>
              mode: {streamMode === 'MANUAL' ? 'Manual Field Mode' : 'Stream + HLS'}
            </span>
            {streamMode === 'STREAM' ? <>
            <span className={`meta-chip ${streamMode === 'STREAM' ? 'tech' : ''}`}>
              RTMP 서버: {rtmpServer || '미설정'}
            </span>
            <span className={`meta-chip ${streamMode === 'STREAM' ? 'tech' : ''}`}>
              스트림 키: {streamKey || '미설정'}
            </span>
            </> : null}
          </div>
          {streamMode === 'STREAM' ? (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-secondary" onClick={() => copyText(rtmpServer, 'Server URL')} disabled={!rtmpServer}>Copy Server</button>
            <button className="btn-secondary" onClick={() => copyText(streamKey, 'Stream key')} disabled={!streamKey}>Copy Key</button>
            <button className="btn-secondary" onClick={() => copyText(pushUrl, 'Push URL')} disabled={!pushUrl}>Copy Full URL</button>
          </div>
          ) : null}
          {copyMessage ? <div className="muted">{copyMessage}</div> : null}
        </div>
        <div className="match-hero-actions">
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn-success" onClick={exportMatchData} disabled={isExportingMatchData}>
              {isExportingMatchData ? '내보내는 중…' : '경기 데이터 내보내기'}
            </button>
            {!isOperator
              ? <button className="btn-secondary" onClick={acquire} disabled={isArchived}>운영권 가져오기</button>
              : <button className="btn-danger" onClick={release} disabled={isArchived}>운영권 해제</button>}
            <span className="muted">
              operator: {match?.operator_id || 'none'} / me: {isArchived ? 'archived-read-only' : canWrite ? 'write' : 'read-only'}
            </span>
          </div>
          <div className="match-lineup-actions">
            <div className="match-lineup-action-row">
              <label className="muted" htmlFor="lineup-direction">명단 방향</label>
              <select id="lineup-direction" value={lineupFirstSide} onChange={(event) => setLineupFirstSide(event.target.value as Team | 'AUTO')} disabled={!canWrite || isUploadingLineup || isUploadingRecordSheet}>
                <option value="AUTO">자동 인식</option>
                <option value="HOME">왼쪽·첫 팀 → 홈</option>
                <option value="AWAY">왼쪽·첫 팀 → 어웨이</option>
              </select>
              <button className="btn-secondary" onClick={() => lineupInputRef.current?.click()} disabled={!canWrite || isUploadingLineup}>
                {isUploadingLineup ? '분석 중…' : 'PDF 명단 업로드'}
              </button>
              <input
                ref={lineupInputRef}
                type="file"
                accept="application/pdf,.pdf"
                style={{ display: 'none' }}
                onChange={(event) => uploadLineupPdf(event.target.files?.[0] || null)}
              />
              <button className="btn-secondary" onClick={() => recordSheetInputRef.current?.click()} disabled={!canWrite || isUploadingRecordSheet}>
                {isUploadingRecordSheet ? '반영 중…' : '815 엑셀 명단 업로드'}
              </button>
              <input
                ref={recordSheetInputRef}
                type="file"
                accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12"
                style={{ display: 'none' }}
                onChange={(event) => uploadLineupRecordSheet(event.target.files?.[0] || null)}
              />
            </div>
            <div className="match-lineup-action-row">
              <span className="muted">
                명단 · 홈 {(lineups.HOME || []).length}명 / 어웨이 {(lineups.AWAY || []).length}명
              </span>
              <button className="btn-secondary" onClick={swapLineupSides} disabled={!canWrite || isSwappingLineup || !hasLineupPlayers}>
                {isSwappingLineup ? '변경 중…' : '홈·어웨이 바꾸기'}
              </button>
              <button className="btn-secondary" onClick={() => setIsManualLineupOpen(true)} disabled={!canWrite}>
                명단 직접 입력
              </button>
            </div>
            <p className="muted">PDF는 팀명과 좌우 배치를 기준으로 자동 인식합니다. 엑셀은 자동 선택 시 첫 팀을 홈으로 적용합니다.</p>
          </div>
        </div>
      </div>
      <LineupUniforms lineup={match?.metadata?.lineups} />

          </details>
      {loadError ? <div className="fla-feedback" role="alert">{loadError}</div> : null}
      {controlNotice ? <div className="fla-feedback" role="status"><span>{controlNotice}</span><button aria-label="알림 닫기" onClick={() => setControlNotice('')}>×</button></div> : null}
      <section className="card fla-clock" aria-label="경기 타이머">
        <div className="fla-clock-main"><div><span className="muted">{running ? '진행 중' : '일시정지'}</span><strong className="fla-clock-value">{displayClockLabel(clockMs)}{clockSpeed === 2 ? ' ×2' : ''}</strong></div>
          <div className="fla-period-controls" role="group" aria-label="전후반 선택">
            <button className="btn-secondary" onClick={startFirstHalf} disabled={!canWrite}>전반 00:00</button>
            <button className="btn-secondary" onClick={markSecondHalfStart} disabled={!canWrite}>후반 시작</button>
          </div>
          <button className={running ? 'btn-secondary' : 'btn-primary'} onClick={(e) => { e.currentTarget.blur(); toggleRun(); }} disabled={!canWrite}>{running ? '일시정지' : '경기 시작'}</button>
        </div>
        <details className="fla-clock-settings"><summary>시간 보정 · 연장 설정</summary><div className="grid">
            {canUseX2 ? (
              <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
                <button className={clockSpeed === 1 ? 'btn-active' : 'btn-secondary'} onClick={() => changeClockSpeed(1)} disabled={!canWrite}>
                  LIVE 1×
                </button>
                <button className={clockSpeed === 2 ? 'btn-active' : 'btn-secondary'} onClick={() => changeClockSpeed(2)} disabled={!canWrite}>
                  X2 MODE (녹화 2배속)
                </button>
                {clockSpeed === 2 ? (
                  <span className="muted" style={{ color: '#ff7900' }}>
                    타이머가 실시간의 2배로 흐릅니다 — 영상도 2배속인지 확인하세요
                  </span>
                ) : null}
              </div>
            ) : null}
          <div className="row">
            <button className="btn-secondary" onClick={markThirdHalfStart} disabled={!canWrite}>연장 전반</button>
            <button className="btn-secondary" onClick={markFourthHalfStart} disabled={!canWrite}>연장 후반</button>
            <button className="btn-danger" onClick={resetClock} disabled={!canWrite}>타이머 초기화</button>
          </div>
        </div></details>
      </section>
      <nav className="fla-mobile-nav" aria-label="경기 작업 선택">
        {([{id:'control',label:'경기 제어'},{id:'shots',label:'슈팅'},{id:'review',label:'기록'},{id:'settings',label:'설정'}] as const).map((tab) => <button key={tab.id} aria-pressed={mobileView === tab.id} className={mobileView === tab.id ? 'btn-active' : ''} onClick={() => {
          setMobileView(tab.id);
          if (tab.id === 'settings' && setupRef.current) {
            setupRef.current.open = true;
            setupRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }}>{tab.label}</button>)}
      </nav>
      <div className="fla-workspace">
        <section className="fla-controls grid" aria-label="점유와 공격 입력">
          {streamMode === 'STREAM' ? (
            <details className="card fla-stream"><summary>중계 영상 · 송출 제어</summary><div className="grid">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>HLS Stream</h3>
                <div className="row">
                  <button className="btn-secondary" onClick={attachRtmp} disabled={!canWrite || isAttachingStream}>
                    {isAttachingStream ? 'Attaching...' : 'Attach RTMP'}
                  </button>
                  <button className="btn-danger" onClick={stopStream} disabled={!canWrite || isStoppingStream}>
                    {isStoppingStream ? 'Stopping...' : 'Stop Stream'}
                  </button>
                  <button className="btn-secondary" onClick={clearHls} disabled={!canWrite || isClearingHls}>
                    {isClearingHls ? 'Clearing...' : 'Clear HLS'}
                  </button>
                </div>
              </div>
              {hasStreamPlayer ? <HlsPlayer src={hlsSrc} /> : <div className="muted">No HLS URL configured</div>}
            </div></details>
          ) : null}


            <div className="card card-panel grid" style={{ minHeight: 180, gap: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>점유 팀</h3>
                <button className="btn-danger" onClick={resetPossession} disabled={!canWrite || isResettingPossession}>
                  {isResettingPossession ? '초기화 중…' : '초기화'}
                </button>
              </div>
              <div className="row">
                <span>현재: {possessionTeam === 'HOME' ? matchTeams?.homeTeam || '홈' : possessionTeam === 'AWAY' ? matchTeams?.awayTeam || '어웨이' : '루즈볼'}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>Home</span>
                <strong>{summary?.possession?.home_pct?.toFixed(2) || '0.00'}% : {summary?.possession?.away_pct?.toFixed(2) || '0.00'}%</strong>
                <span>Away</span>
              </div>
              <div className="fla-possession-buttons">
                <button className={`fla-home ${possessionTeam === 'HOME' ? 'selected' : ''}`} aria-pressed={possessionTeam === 'HOME'} onClick={() => changePossession('HOME')} disabled={!canWrite}>{matchTeams?.homeTeam || '홈'} <span className="kbd">Q</span></button>
                <button className={`fla-away ${possessionTeam === 'AWAY' ? 'selected' : ''}`} aria-pressed={possessionTeam === 'AWAY'} onClick={() => changePossession('AWAY')} disabled={!canWrite}>{matchTeams?.awayTeam || '어웨이'} <span className="kbd">W</span></button>
                <button className={possessionTeam === 'NONE' ? 'btn-active' : ''} aria-pressed={possessionTeam === 'NONE'} onClick={() => changePossession('NONE')} disabled={!canWrite}>루즈볼 <span className="kbd">E</span></button>
              </div>
            </div>

            <div className="card card-panel grid fla-attack-card" role="group" aria-label="공격 방향 기록">
              <h3>공격 방향 기록</h3>
              <div className="fla-attack-layout">
              <div className="fla-attack-controls">
              <div className="row">
                <span className="fla-control-label">홈 공격 방향</span>
                <button className={attackLR === 'L2R' ? 'btn-active' : ''} aria-pressed={attackLR === 'L2R'} onClick={() => changeAttackDirection('L2R')} disabled={!canWrite}>오른쪽 →</button>
                <button className={attackLR === 'R2L' ? 'btn-active' : ''} aria-pressed={attackLR === 'R2L'} onClick={() => changeAttackDirection('R2L')} disabled={!canWrite}>← 왼쪽</button>
              </div>
              <div className="row">
                <span className="fla-control-label">기록 팀</span>
                <button className={selectedTeam === 'HOME' ? 'btn-active' : ''} aria-pressed={selectedTeam === 'HOME'} onClick={() => selectEventTeam('HOME')} disabled={!canWrite}>{matchTeams?.homeTeam || '홈'}</button>
                <button className={selectedTeam === 'AWAY' ? 'btn-active' : ''} aria-pressed={selectedTeam === 'AWAY'} onClick={() => selectEventTeam('AWAY')} disabled={!canWrite}>{matchTeams?.awayTeam || '어웨이'}</button>

              </div>
              <div className="row">
                <span className="fla-control-label">공격 위치</span>
                <button className={pendingLane === 'LEFT' ? 'btn-active' : ''} aria-pressed={pendingLane === 'LEFT'} onClick={() => setPendingLane('LEFT')} disabled={!canWrite}>왼쪽 <span className="kbd">A</span></button>
                <button className={pendingLane === 'CENTER' ? 'btn-active' : ''} aria-pressed={pendingLane === 'CENTER'} onClick={() => setPendingLane('CENTER')} disabled={!canWrite}>중앙 <span className="kbd">S</span></button>
                <button className={pendingLane === 'RIGHT' ? 'btn-active' : ''} aria-pressed={pendingLane === 'RIGHT'} onClick={() => setPendingLane('RIGHT')} disabled={!canWrite}>오른쪽 <span className="kbd">D</span></button>

              </div>
              <div className="row">
                <button className="btn-primary" onClick={() => sendLane(pendingLane)} disabled={!canWrite}>공격 기록 <span className="kbd">Enter</span></button>
              </div>
              </div>
              <AttackDirectionPitch homeDirection={attackLR} team={selectedTeam} lane={pendingLane} teamName={selectedTeam === 'HOME' ? matchTeams?.homeTeam || '홈' : matchTeams?.awayTeam || '어웨이'} />
              </div>
              <details className="fla-lane-stats"><summary>공격 방향별 통계</summary><div className="muted">
                HOME Lane(events): L {summary?.lanes?.home?.left_pct?.toFixed(1) || '0'}% / C {summary?.lanes?.home?.center_pct?.toFixed(1) || '0'}% / R {summary?.lanes?.home?.right_pct?.toFixed(1) || '0'}% (n={summary?.lanes?.home?.total_count || 0})
                <br />
                AWAY Lane(events): L {summary?.lanes?.away?.left_pct?.toFixed(1) || '0'}% / C {summary?.lanes?.away?.center_pct?.toFixed(1) || '0'}% / R {summary?.lanes?.away?.right_pct?.toFixed(1) || '0'}% (n={summary?.lanes?.away?.total_count || 0})
              </div></details>
            </div>
        </section>
        <section className="fla-shots" aria-label="슈팅 입력">
          <div className="card card-panel grid fla-shot-card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>{isFutsal ? '슈팅 위협도 기록' : '슈팅 기록'}</h3>
                <select aria-label="슈팅 팀" value={xgTeam} onChange={(e) => setXgTeam(e.target.value as Team)}>
                  <option value="HOME">HOME</option>
                  <option value="AWAY">AWAY</option>
                </select>
                <select aria-label="슈팅 선수" value={xgPlayerKey} onChange={(e) => setXgPlayerKey(e.target.value)} disabled={!xgPlayerOptions.length}>
                  <option value="">{xgPlayerOptions.length ? '선수 선택 (선택)' : '등록된 선수 없음'}</option>
                  {xgPlayerOptions.map((player) => (
                    <option key={`${player.number}|${player.name}`} value={`${player.number}|${player.name}`}>
                      No.{player.number} {player.name}
                    </option>
                  ))}
                </select>

              </div>
            </div>
            <div className="row fla-shot-flags" style={{ gap: 10, flexWrap: 'wrap' }}>
              {!isFutsal ? <button className={isOnTargetShot ? 'btn-active' : ''} onClick={() => setIsOnTargetShot((prev) => !prev)} disabled={!canWrite}>유효슈팅</button> : null}
              <button className={isGoalShot ? 'btn-active' : ''} onClick={() => setIsGoalShot((prev) => !prev)} disabled={!canWrite}>골</button>
              {!isFutsal ? <button className={isHeaderShot ? 'btn-active' : ''} onClick={() => setIsHeaderShot((prev) => !prev)} disabled={!canWrite}>헤더</button> : null}
              <button
                className={isOwnGoal ? 'btn-active' : ''}
                onClick={() => setIsOwnGoal((prev) => !prev)}
                disabled={!canWrite}
                title="Own goal — counts on the scoreboard for the selected team"
              >
                OG
              </button>
              <span className="muted">
                {isOwnGoal
                  ? `Own goal → ${xgTeam} scores. Click pitch, then Record OG.`
                  : shotPoint
                  ? `shot=(${shotPoint.x}, ${shotPoint.y})`
                  : '피치에서 슈팅 위치를 선택하세요'}
              </span>
            </div>
            <div className="fla-shot-toolbar">
            <div className={`fla-shot-values ${isFutsal ? 'fla-shot-values-futsal' : ''}`}>
              <div className="fla-shot-value-row">
                <label htmlFor="fla-xg-value">{isFutsal ? 'Shot Threat' : 'xG'}</label>
                <input id="fla-xg-value" aria-label="xG 값" inputMode="decimal" value={xgValue} onChange={(e) => setXgValue(e.target.value)} placeholder={isFutsal ? '0.000–0.800' : 'xG'} />
                  <button className="btn-secondary" onClick={estimateXgFromPitch} disabled={!canWrite}>{isFutsal ? '위협도 추정' : 'xG 계산'}</button>
              </div>
              {!isFutsal ? <div className="fla-shot-value-row">
                <label htmlFor="fla-xgot-value">xGOT</label>
                <input id="fla-xgot-value" aria-label="xGOT 값" value={xgotValue} readOnly placeholder="xGOT" />
                <button className="btn-secondary" onClick={estimateXgotFromGoalmouth} disabled={!canWrite}>xGOT 계산</button>
              </div> : null}
            </div>
            <button className="btn-primary fla-shot-submit" onClick={submitXg} disabled={!canWrite || isSavingShot}>{isSavingShot ? '저장 중…' : isOwnGoal ? '자책골 기록' : '슈팅 기록'}</button>
            </div>
            <div
              style={{
                position: 'relative',
                width: '100%',
                maxWidth: 520,
                justifySelf: 'center',
                marginTop: isOnTargetShot ? 132 : 4,
              }}
            >
              {isOnTargetShot && !isFutsal ? (
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: -128,
                    transform: 'translateX(-50%)',
                    width: '100%',
                    maxWidth: 520,
                    zIndex: 2,
                  }}
                >
                  <div className="fla-goalmouth-row" style={{ position: 'relative', width: '100%', minHeight: 108 }}>
                    <div
                      onClick={onGoalmouthClick}
                      style={{
                        position: 'relative',
                        width: 300,
                        maxWidth: '100%',
                        aspectRatio: '3.2 / 1.15',
                        cursor: 'crosshair',
                        margin: '0 auto',
                      }}
                    >
                      {goalmouthPoint ? (
                        <div
                          className="muted"
                          style={{
                            position: 'absolute',
                            left: 10,
                            bottom: 8,
                            fontSize: 11,
                            whiteSpace: 'nowrap',
                            zIndex: 5,
                          }}
                        >
                          goalmouth=({goalmouthPoint.x.toFixed(3)}, {goalmouthPoint.y.toFixed(3)})
                        </div>
                      ) : null}
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          border: '4px solid rgba(255,255,255,0.95)',
                          borderBottomWidth: 2,
                          borderRadius: '8px 8px 0 0',
                          background:
                            'linear-gradient(180deg, rgba(20,52,109,0.72) 0%, rgba(20,52,109,0.3) 44%, rgba(255,255,255,0.03) 100%)',
                          boxShadow: '0 10px 28px rgba(15,23,42,0.32)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            backgroundImage:
                              'linear-gradient(rgba(255,255,255,0.58) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
                            backgroundSize: '8.5% 16%',
                            transform: 'perspective(260px) rotateX(14deg) scaleY(1.04)',
                            transformOrigin: 'top center',
                            opacity: 0.9,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: '-6%',
                            top: '5%',
                            bottom: '11%',
                            width: '9%',
                            borderLeft: '4px solid rgba(255,255,255,0.95)',
                            borderTop: '4px solid rgba(255,255,255,0.75)',
                            borderBottom: '2px solid rgba(255,255,255,0.16)',
                            transform: 'skewY(14deg)',
                            opacity: 0.92,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            right: '-6%',
                            top: '5%',
                            bottom: '11%',
                            width: '9%',
                            borderRight: '4px solid rgba(255,255,255,0.95)',
                            borderTop: '4px solid rgba(255,255,255,0.75)',
                            borderBottom: '2px solid rgba(255,255,255,0.16)',
                            transform: 'skewY(-14deg)',
                            opacity: 0.92,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: '33.33%',
                            top: 0,
                            bottom: 0,
                            borderLeft: '1px dashed rgba(255,255,255,0.42)',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: '66.66%',
                            top: 0,
                            bottom: 0,
                            borderLeft: '1px dashed rgba(255,255,255,0.42)',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: '50%',
                            borderTop: '1px dashed rgba(255,255,255,0.42)',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            height: '15%',
                            background: 'linear-gradient(180deg, rgba(101,163,13,0.14), rgba(101,163,13,0.38))',
                          }}
                        />
                        {goalmouthPoint ? (
                          <div
                            style={{
                              position: 'absolute',
                              left: `${goalmouthPoint.x * 100}%`,
                              top: `${(1 - goalmouthPoint.y) * 100}%`,
                              width: 14,
                              height: 14,
                              borderRadius: '50%',
                              background: '#f97316',
                              border: '2px solid white',
                              transform: 'translate(-50%, -50%)',
                              boxShadow: '0 0 0 5px rgba(249,115,22,0.18)',
                              zIndex: 4,
                            }}
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
              {isFutsal ? <FutsalShotPitch shotPoint={shotPoint} onClick={onPitchClick} isOnTarget={isOnTargetShot} /> : <>
              <div
                className="fla-shot-pitch" aria-label="슈팅 위치 선택"
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
                  overflow: 'visible',
                }}
              >
              <div style={{ position: 'absolute', inset: 0, border: '2px solid rgba(255,255,255,0.9)', borderRadius: 8 }} />
              <div
                style={{
                  position: 'absolute',
                  left: '44.62%',
                  top: -12,
                  width: '10.76%',
                  height: 12,
                  border: '2px solid rgba(255,255,255,0.95)',
                  borderBottom: 'none',
                  borderRadius: '6px 6px 0 0',
                  background: 'rgba(255,255,255,0.05)',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                }}
              />
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
              <div style={{ position: 'absolute', left: 8, top: 6, color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: 600 }}>상대 골문</div>
              <div style={{ position: 'absolute', right: 8, top: 6, color: 'rgba(255,255,255,0.7)', fontSize: 10 }}>
                {isOnTargetShot ? '골문에서 도착 위치를 선택하세요' : '피치에서 슈팅 위치를 선택하세요'}
              </div>
              <div style={{ position: 'absolute', left: 8, bottom: 6, color: 'rgba(255,255,255,0.75)', fontSize: 10 }}>68m x 40m (rotated)</div>
            </div>
              </>}
            </div>

            <div className="muted">{isFutsal ? '풋살 20 × 20m 공격 하프의 골문 거리·각도로 Shot Threat(최대 0.800)를 추정합니다.' : '위치를 선택한 뒤 xG를 계산하거나 직접 입력하고 기록하세요.'}</div>
            {xgEstimateMeta ? <div className="muted">{xgEstimateMeta}</div> : null}
            {xgotEstimateMeta ? <div className="muted">{xgotEstimateMeta}</div> : null}

          </div>


        </section>
        <section className="fla-review grid" aria-label="경기 기록">
          <div className="card card-utility grid" style={{ minHeight: 280 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>최근 기록</h3>
              <button className="btn-danger" onClick={resetEvents} disabled={!canWrite || isResettingEvents}>
                {isResettingEvents ? '초기화 중…' : '기록 초기화'}
              </button>
            </div>
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
                  <span>
                    {e.type} {e.team}{' '}
                    {e.is_own_goal ? <strong style={{ color: '#f97316' }}>OG⚽</strong> : e.is_goal ? <strong style={{ color: '#22c55e' }}>GOAL⚽</strong> : ''}{' '}
                    @ {displayClockLabel(e.clock_ms)} {e.lane ? `lane=${e.lane}` : ''}{' '}
                    {e.is_own_goal ? '' : typeof e.xg === 'number' ? `xg=${e.xg}` : ''}{' '}
                    {e.is_own_goal ? '' : typeof e.xgot === 'number' ? `xgot=${e.xgot}` : ''}{' '}
                    {e.player_name ? `No.${e.player_number || '-'} ${e.player_name}` : ''}{' '}
                    {e.is_own_goal ? '' : e.is_on_target ? 'on-target' : ''}
                  </span>
                  <span className="muted">{formatCreatedAtKst(e.created_at)}</span>
                </div>
              ))}
            </div>
          </div>

            <div className="card card-utility grid" style={{ minHeight: 180, gap: 8 }}>
              <h3>점유 타임라인</h3>
              <div className="row" style={{ marginBottom: 8 }}>
                <button className="btn-success" onClick={downloadPossessionCsv} disabled={possessionLogs.length === 0}>CSV 다운로드</button>
                <button className="btn-secondary" onClick={resetPossessionLogView} disabled={possessionLogs.length === 0}>표시 기록 비우기</button>
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
                  <span className="muted">아직 기록이 없습니다</span>
                ) : (
                  possessionLogs.map((line, idx) => (
                    <span key={`${idx}-${line}`} className="muted">{line}</span>
                  ))
                )}
              </div>
            </div>
      <div className="card card-utility">
        <h3>경기 흐름 · 3분 단위</h3>
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <ComposedChart data={dominanceChartData}>
              <defs>
                <linearGradient id="dominanceFillSingle" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#f97316" stopOpacity={0.42} />
                  <stop offset="100%" stopColor="#f97316" stopOpacity={0.18} />
                </linearGradient>
                <linearGradient id="dominanceFillSingleAway" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#2563eb" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#2563eb" stopOpacity={0.42} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.10)" />
              <XAxis
                type="number"
                dataKey="minuteVal"
                ticks={dominanceXAxisTicks}
                tickFormatter={formatDominanceTick}
                domain={['dataMin', 'dataMax']}
              />
              <YAxis domain={[-1.2, 1.2]} ticks={[-1, -0.5, 0, 0.5, 1]} />
              <Tooltip />
              {dominanceMeta?.split_halves
                ? (
                    (dominanceMeta.breaks && dominanceMeta.breaks.length
                      ? dominanceMeta.breaks
                      : dominanceMeta.ht_chart_ms != null
                      ? [{ chart_ms: dominanceMeta.ht_chart_ms, label: 'HT' }]
                      : []) as Array<{ chart_ms: number; label: string }>
                  ).map((brk, brkIndex) => (
                    <ReferenceLine
                      key={`dominance-break-${brkIndex}-${brk.chart_ms}`}
                      x={Number(brk.chart_ms) / 60000}
                      stroke="#fbbf24"
                      strokeDasharray="6 4"
                      label={{ value: brk.label || 'HT', position: 'top', fill: '#fbbf24', fontSize: 12 }}
                    />
                  ))
                : null}
              {dominanceChartData.map((bin) => {
                const goalSummary = bin.annotations?.goal_summary;
                const hasHt = !dominanceMeta?.split_halves && Boolean(bin.annotations?.markers?.includes('HT'));
                const homeGoalLabel = goalSummary?.home ? `⚽ HOME${goalSummary.home > 1 ? ` x${goalSummary.home}` : ''}` : '';
                const awayGoalLabel = goalSummary?.away ? `⚽ AWAY${goalSummary.away > 1 ? ` x${goalSummary.away}` : ''}` : '';
                const homeGoalX = bin.minuteVal - (goalSummary?.home && goalSummary?.away ? 0.08 : 0);
                const awayGoalX = bin.minuteVal + (goalSummary?.home && goalSummary?.away ? 0.08 : 0);
                return (
                  <Fragment key={`dominance-annotation-${bin.minuteVal}`}>
                    {hasHt ? (
                      <ReferenceLine
                        x={bin.midpointMinuteVal}
                        stroke="#fbbf24"
                        strokeDasharray="6 4"
                        label={{ value: 'HT', position: 'top', fill: '#fbbf24', fontSize: 12 }}
                      />
                    ) : null}
                    {homeGoalLabel ? (
                      <>
                        <ReferenceLine
                          segment={[
                            { x: homeGoalX, y: 1 },
                            { x: homeGoalX, y: 0 },
                          ]}
                          stroke="#f97316"
                          strokeDasharray="4 4"
                          ifOverflow="extendDomain"
                        />
                        <ReferenceDot
                          x={homeGoalX}
                          y={1}
                          r={0}
                          fill="transparent"
                          stroke="transparent"
                          ifOverflow="extendDomain"
                          label={{
                            value: homeGoalLabel,
                            position: 'top',
                            fill: '#f97316',
                            fontSize: 12,
                            offset: hasHt ? 18 : 6,
                          }}
                        />
                      </>
                    ) : null}
                    {awayGoalLabel ? (
                      <>
                        <ReferenceLine
                          segment={[
                            { x: awayGoalX, y: 0 },
                            { x: awayGoalX, y: -1 },
                          ]}
                          stroke="#2563eb"
                          strokeDasharray="4 4"
                          ifOverflow="extendDomain"
                        />
                        <ReferenceDot
                          x={awayGoalX}
                          y={-1}
                          r={0}
                          fill="transparent"
                          stroke="transparent"
                          ifOverflow="extendDomain"
                          label={{
                            value: awayGoalLabel,
                            position: 'bottom',
                            fill: '#60a5fa',
                            fontSize: 12,
                            offset: 6,
                          }}
                        />
                      </>
                    ) : null}
                  </Fragment>
                );
              })}
              <Area type="monotone" data={dominanceSeriesData} dataKey="positiveDominance" baseValue={0} stroke="none" fill="url(#dominanceFillSingle)" connectNulls />
              <Area type="monotone" data={dominanceSeriesData} dataKey="negativeDominance" baseValue={0} stroke="none" fill="url(#dominanceFillSingleAway)" connectNulls />
              <Line type="monotone" data={dominanceSeriesData} dataKey="positiveDominance" stroke="#f97316" strokeWidth={3} dot={false} connectNulls />
              <Line type="monotone" data={dominanceSeriesData} dataKey="negativeDominance" stroke="#2563eb" strokeWidth={3} dot={false} connectNulls />
              <ReferenceLine y={0} stroke="#ffffff" strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>


        </section>
        <section className="fla-settings grid" aria-label="경기 설정">

      <div className="card card-utility">
        <h3>데이터 전송 상태</h3>
        <div className="grid">
          {outbox.slice(0, 20).map((o) => (
            <div key={o.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{o.kind} attempts={o.attempts}</span>
              <span className="muted">{o.last_error || 'pending/scheduled'}</span>
            </div>
          ))}
        </div>
      </div>
        </section>
      </div>
      {isManualLineupOpen ? (
        <div className="fcm-modal-backdrop" role="presentation" onClick={() => setIsManualLineupOpen(false)}>
          <div
            aria-modal="true"
            className="card card-panel fcm-modal lineup-modal"
            role="dialog"
            aria-label="Manual lineup"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">Lineup Fallback</div>
                <h3>Manual Lineup</h3>
              </div>
              <button className="button-compact btn-secondary" onClick={() => setIsManualLineupOpen(false)}>Close</button>
            </div>

            <div className="lineup-entry-row">
              <select value={manualLineupSide} onChange={(event) => setManualLineupSide(event.target.value as Team)} disabled={!canWrite || isSavingManualLineup}>
                <option value="HOME">HOME</option>
                <option value="AWAY">AWAY</option>
              </select>
              <input
                value={manualLineupNumber}
                onChange={(event) => setManualLineupNumber(event.target.value.replace(/\D/g, '').slice(0, 3))}
                placeholder="No."
                inputMode="numeric"
                disabled={!canWrite || isSavingManualLineup}
              />
              <select value={manualLineupPosition} onChange={(event) => setManualLineupPosition(event.target.value)} disabled={!canWrite || isSavingManualLineup}>
                <option value="">POS</option>
                <option value="GK">GK</option>
                <option value="DF">DF</option>
                <option value="MF">MF</option>
                <option value="FW">FW</option>
              </select>
              <input
                value={manualLineupName}
                onChange={(event) => setManualLineupName(event.target.value)}
                placeholder="Player name"
                disabled={!canWrite || isSavingManualLineup}
              />
              <button className="btn-secondary" onClick={saveManualLineupPlayer} disabled={!canWrite || isSavingManualLineup}>
                {isSavingManualLineup ? 'Saving...' : 'Add Player'}
              </button>
            </div>

            <div className="lineup-table-grid">
              {(['HOME', 'AWAY'] as Team[]).map((side) => (
                <div className="lineup-table-panel" key={side}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>{side}</strong>
                    <span className="muted">{(lineups[side] || []).length} players</span>
                  </div>
                  <div className="fcm-guide-table-wrap lineup-table-wrap">
                    <table className="fcm-guide-table lineup-table">
                      <thead>
                        <tr>
                          <th>No.</th>
                          <th>POS</th>
                          <th>Name</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(lineups[side] || []).length ? (
                          (lineups[side] || []).map((player) => (
                            <tr key={`${side}-${player.number}-${player.name}`}>
                              <td>{player.number}</td>
                              <td>{player.position || '-'}</td>
                              <td>{player.name}</td>
                              <td>
                                <button
                                  className="button-compact btn-danger"
                                  onClick={() => deleteManualLineupPlayer(side, player.number)}
                                  disabled={!canWrite || isSavingManualLineup}
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={4} className="muted">No players yet</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

    </main>
  );
}
