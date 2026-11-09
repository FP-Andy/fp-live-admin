'use client';

import { futsalPitchPoint } from '../../../../lib/futsal-pitch';
import { futsalShotThreat } from '../../../../components/fla/FutsalShotPitch';
import LineupUniforms from '../../../../components/LineupUniforms';
import ConfirmDialog from '../../../../components/ConfirmDialog';
import {MatchPossessionCard, MatchAttackCard, MatchShotCard, MatchRecentRecords, MatchPossessionTimeline, MatchFlowCard} from '../../../../components/fla/MatchControlCards';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import HlsPlayer from '../../../../components/HlsPlayer';
import AgentEditNotice from '../../../../components/fla/AgentEditNotice';
import { API_BASE, apiFetch, apiJson, type SessionUser } from '../../../../lib/api';
import { elapsedMatchMs, restoredMatchMs, matchControlJson } from '../../../../lib/match-control';
import { useFlaOutbox, outboxRecordRow, type FlaOutboxItem } from '../../../../lib/fla-input-outbox';
import { registerWorkspaceLeave } from '../../../../lib/workspace-leave';
import { useMatchHighlights } from '../../../../lib/use-match-highlights';
import { useWidthFlags } from '../../../../lib/width-flags';
import { errorDetail, errorFromResponse, errorMessage, lookupErrorInfo, responseMessage, warnRaw } from '../../../../lib/error-messages';
import { ErrorFold } from '../../../../components/ErrorNotice';
import BroadcastPreviewPanel from '../../../../components/fla/BroadcastPreviewPanel';
import { resolveMatchTeams } from '../../dashboard/schedule-data';

const DEFAULT_HLS = process.env.NEXT_PUBLIC_DEFAULT_HLS_URL || '';
const HALF_PITCH_LENGTH = 52.5;
const XG_VISIBLE_LENGTH = 40;
const XG_VISIBLE_OFFSET = HALF_PITCH_LENGTH - XG_VISIBLE_LENGTH;
const PITCH_WIDTH = 68;
const FUTSAL_HALF_PITCH_LENGTH = 20;
const FUTSAL_PITCH_WIDTH = 20;

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
  return <MatchControlPage key={params.id} />;
}

function MatchControlPage() {
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
  const [pendingLane, setPendingLaneState] = useState<Lane>('CENTER');
  // A→Enter 를 다시 그리기보다 빠르게 눌러도 방금 고른 위치로 기록되게 ref 에 바로 적는다.
  const pendingLaneRef = useRef<Lane>('CENTER');
  const setPendingLane = (lane: Lane) => { pendingLaneRef.current = lane; setPendingLaneState(lane); };
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
  // 시계 카드 배치는 카드 폭으로만 정한다(console-workspaces.css · lib/width-flags.ts).
  const clockCardRef = useRef<HTMLElement | null>(null);
  useWidthFlags(clockCardRef, { narrow: 800, tight: 900 });
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
  const [copyMessage, setCopyMessage] = useState('');
  // 원문이 기억된 오류는 "자세히"를 펼쳐 볼 수 있게 남기고, 그 밖의 안내만 잠시 뒤 지운다.
  const clearCopyMessageLater = (ms: number) => { setTimeout(() => setCopyMessage((current) => (lookupErrorInfo(current) ? current : '')), ms); };
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
  const wallRef = useRef(Date.now());
  const baseRef = useRef<number>(0);
  const clockRef = useRef<number>(0);
  const clockSpeedRef = useRef<ClockSpeed>(1);
  const runningRef = useRef<boolean>(false);
  const initializedRef = useRef<boolean>(false);
  const lastPossessionLogSecondRef = useRef<number>(-1);
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const lineups = (match?.metadata?.lineups?.teams || {}) as Partial<Record<Team, LineupPlayer[]>>;
  const hasLineupPlayers = Boolean((lineups.HOME || []).length || (lineups.AWAY || []).length);
  const isFutsal = match?.sport === 'FUTSAL';
  const isSinglePeriod = isFutsal && match?.metadata?.period_mode === 'SINGLE';
  const xgPlayerOptions = useMemo(() => lineups[xgTeam] || [], [lineups, xgTeam]);
  const selectedXgPlayer = useMemo(
    () => xgPlayerOptions.find((player) => `${player.number}|${player.name}` === xgPlayerKey) || null,
    [xgPlayerOptions, xgPlayerKey]
  );

  const displayClockLabel = (ms: number) => {
    if (isSinglePeriod) return fmt(ms);
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
    if (isSinglePeriod) return String(Math.floor(ms / 60000));
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
      // 다음 공격 기록은 화면에 보이는 팀으로 저장돼야 한다 — 보낼 값을 담는 ref 도 같이 맞춘다.
      controlsRef.current = { ...controlsRef.current, selected_team: possessionTeam };
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
  // 후반 시작을 깜빡한 경우 — 전반이 정규시간 + 15분을 넘겼는데 후반 표시가 없으면 작게 알린다.
  // 시계 카드의 "시간 보정" 줄 안에 띄워 카드 높이를 바꾸지 않는다.
  const forgotSecondHalf = !isSinglePeriod && !isArchived && secondHalfStartAbsMs == null
    && clockMs > (regulationHalfMinutes(match?.competition_class, match?.first_half_minutes) + 15) * 60000;
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
    return Math.floor(baseRef.current + elapsedMatchMs(perfRef.current, wallRef.current, performance.now(), Date.now()) * clockSpeedRef.current);
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
      wallRef.current = Date.now();
      setClockMs(frozen);
    }
    setClockSpeed(nextSpeed);
    clockSpeedRef.current = nextSpeed;
    saveState({ clockSpeed: nextSpeed });
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
      wallRef.current = Date.now();
      setClockMs(frozen);
    }
    setClockSpeed(1);
    clockSpeedRef.current = 1;
  }, [sessionUser, match, canUseX2, clockSpeed]);

  // 화면의 점유·기록 팀·공격 방향. 키보드 연타가 다시 그리기보다 빠를 수 있어 상태와 별도로 ref 에도 즉시 적는다.
  const controlsRef=useRef({possession_team:'NONE' as PossessionTeam,selected_team:'HOME' as Team,attack_lr:'L2R' as AttackLR});
  const setControls=(next:Partial<{possession_team:PossessionTeam;selected_team:Team;attack_lr:AttackLR}>)=>{
    controlsRef.current={...controlsRef.current,...next};
    if(next.possession_team)setPossessionTeam(next.possession_team);
    if(next.selected_team)setSelectedTeam(next.selected_team);
    if(next.attack_lr)setAttackLR(next.attack_lr);
  };
  const applyServerClock=(state:any,preserveRunningClock=false)=>{
    if(!state)return;
    const continuous=preserveRunningClock&&runningRef.current&&state.running;
    const restored=restoredMatchMs(state);
    const ms=continuous?Math.max(getCurrentClockMs(),restored):restored;
    baseRef.current=ms;clockRef.current=ms;wallRef.current=Date.now();
    perfRef.current=state.running?performance.now():null;
    runningRef.current=!!state.running;setRunning(!!state.running);setClockMs(ms);
    if(state.clock_speed===1||state.clock_speed===2){clockSpeedRef.current=state.clock_speed;setClockSpeed(state.clock_speed);}
    setControls({possession_team:state.possession_team||'NONE',selected_team:state.selected_team||'HOME',attack_lr:state.attack_lr||'L2R'});
  };

  // 저장이 확인됐지만 아직 폴링 목록에 안 들어온 기록. 보관함에서 빠진 순간 목록에서 사라졌다가
  // 3초 뒤 다시 나타나는 깜빡임(점수도 1 내려갔다 오름)을 막는다.
  const deliveredRef=useRef(new Map<string,{item:FlaOutboxItem;at:number}>());
  const [deliveredTick,setDeliveredTick]=useState(0);
  const lateStateRef=useRef(false);
  const inputs=useFlaOutbox(id,userId,canWrite,{
    onDelivered:(item)=>{
      if(item.kind==='lane'||item.kind==='shot'){deliveredRef.current.set(item.id,{item,at:Date.now()});setDeliveredTick(t=>t+1);}
      if(item.kind==='state'&&Date.now()-item.pressed_at>2000)lateStateRef.current=true;
    },
    onIdle:()=>{
      // 밀린 명령이 늦게 들어가면 서버 시계가 누른 시각에 머문다 — 그때만 바로 현재 시계를 한 번 알려
      // 중계 그래픽을 따라오게 한다. 제때 들어간 명령 뒤에도 보내면 누를 때마다 상태 행이 두 개씩 생긴다.
      if(lateStateRef.current&&canWriteRef.current&&runningRef.current)void inputsRef.current.sample(stateBody());
      lateStateRef.current=false;
      void fetchAll().catch(()=>undefined);
    },
    onServerState:(state,revision)=>adoptServerState(state,revision),
  });
  const inputsRef=useRef(inputs);inputsRef.current=inputs;
  const canWriteRef=useRef(canWrite);canWriteRef.current=canWrite;

  /** 다른 탭·기기가 시계·점유를 바꿨을 때만 서버 값을 따른다. 이 화면에 아직 안 보낸 시계·점유 입력이 있으면
   *  서버 값을 쓰지 않는다 — 운영자가 누른 값이 우선이고, 보낼 때 409 를 받아 최신 번호로 다시 보낸다. */
  const adoptServerState=(state:any,revision:number)=>{
    const outbox=inputsRef.current;
    if(outbox.hasPendingState())return;
    const known=outbox.getRevision();
    if(known!==null&&revision<=known)return;
    outbox.noteRevision(revision);
    if(!state)return;
    const c=controlsRef.current;
    const differs=!!state.running!==runningRef.current||(state.possession_team||'NONE')!==c.possession_team
      ||(state.selected_team||'HOME')!==c.selected_team||(state.attack_lr||'L2R')!==c.attack_lr
      ||Math.abs(restoredMatchMs(state)-getCurrentClockMs())>2000;
    // 내 명령인데 응답만 늦게 확인된 경우엔 값이 같다 — 그때 시계를 다시 맞추면 화면 시계가 튄다.
    if(differs)applyServerClock(state,true);
  };

  type StateInput=Partial<{clockMs:number; running:boolean; possessionTeam:PossessionTeam; selectedTeam:Team; attackLR:AttackLR; allowClockRewind:boolean; clockSpeed:ClockSpeed;}>;
  /** 누른 순간의 시계·제어값 전체. 늦게 보내져도 서버에는 이 값이 그대로 저장된다. */
  const stateBody=(next:StateInput={})=>({
    clock_ms:Math.max(0,Math.round(next.clockMs??getCurrentClockMs())),running:next.running??runningRef.current,
    clock_speed:next.clockSpeed??clockSpeedRef.current,
    possession_team:next.possessionTeam??controlsRef.current.possession_team,
    selected_team:next.selectedTeam??controlsRef.current.selected_team,
    attack_lr:next.attackLR??controlsRef.current.attack_lr,allow_clock_rewind:!!next.allowClockRewind,
  });
  // 화면은 호출하는 쪽에서 먼저 바꾼다. 여기서는 보관함에 넣기만 하고 서버를 기다리지 않는다.
  const saveState=(next:StateInput={})=>{
    if(!canWriteRef.current)return;
    const body=stateBody(next);
    inputsRef.current.enqueue('state',body,body.clock_ms);
  };

  const [serverReady,setServerReady]=useState(false);
  const fetchAll = (): Promise<void> => {
    if(refreshInFlight.current)return refreshInFlight.current;
    const request=(async()=>{
      const startedAt=Date.now();
      const [m,s]=await Promise.all([
        matchControlJson(`/matches/${id}`),
        matchControlJson(`/matches/${id}/summary${initializedRef.current?'':'?fresh=true'}`),
      ]);
      // 요약은 서버에서 최대 3초 캐시된다. 저장 확인 3.5초 뒤에 시작한 요청에도 없으면 그 기록은
      // 지워진 것(기록 전체 삭제 등)이니 이어 붙이기를 멈춘다.
      const serverIds=new Set<string>((s?.events||[]).map((e:any)=>String(e.id)));
      let pruned=false;
      deliveredRef.current.forEach((entry,key)=>{if(serverIds.has(key)||entry.at+3500<startedAt){deliveredRef.current.delete(key);pruned=true;}});
      if(pruned)setDeliveredTick(t=>t+1);
      setLoadError('');setMatch(m);setSummary(s);
      const revision=Number(s.command_revision??m.metadata?.fla_clock_revision??0);
      if(!initializedRef.current){
        initializedRef.current=true;
        inputsRef.current.noteRevision(revision);
        applyServerClock(m.archived&&s.state?{...s.state,running:false}:s.state);
        setXgTeam(s.state?.selected_team||'HOME');
        setServerReady(true);
      }else if(!m.archived)adoptServerState(s.state,revision);
      const d=await matchControlJson(`/matches/${id}/dominance?bin_seconds=${m.sport==='FUTSAL'?60:180}&split_halves=true`);
      setDominance(d.bins||[]);setDominanceMeta(d);
    })();
    refreshInFlight.current=request;
    void request.finally(()=>{if(refreshInFlight.current===request)refreshInFlight.current=null;}).catch(()=>{});
    return request;
  };

  // 새로고침 전에 누른 시계·점유가 아직 서버에 없다면 서버 값 대신 그 마지막 입력을 화면에 되살린다.
  // 보관함은 로그인 정보가 온 뒤에 열리므로 서버 첫 응답과 둘 다 준비됐을 때 한 번만 한다.
  const restoredLocalRef=useRef(false);
  useEffect(()=>{
    if(!serverReady||!inputs.loaded||restoredLocalRef.current)return;
    restoredLocalRef.current=true;
    const last=[...inputs.items].reverse().find(item=>item.kind==='state'&&!item.failed);
    if(!last||match?.archived)return;
    const b=last.body;
    const speed=b.clock_speed===2?2:1;
    const ms=b.running?b.clock_ms+Math.max(0,Date.now()-last.pressed_at)*speed:b.clock_ms;
    baseRef.current=ms;clockRef.current=ms;wallRef.current=Date.now();
    perfRef.current=b.running?performance.now():null;
    runningRef.current=!!b.running;setRunning(!!b.running);setClockMs(ms);
    clockSpeedRef.current=speed;setClockSpeed(speed);
    setControls({possession_team:b.possession_team||'NONE',selected_team:b.selected_team||'HOME',attack_lr:b.attack_lr||'L2R'});
  },[serverReady,inputs.loaded]);

  const fetchOutbox = async () => {
    const data = await apiJson<any[]>(`/outbox`);
    setOutbox(data || []);
  };

  useEffect(() => {
    const refresh = () => fetchAll().catch((e) => setLoadError(errorMessage(e, '경기 데이터를 불러오지 못했습니다. 연결을 확인해 주세요.', { fixed: true })));
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [id]);

  // 전송 대기열은 관리자만 본다 — 운영자 화면에서 5초마다 모든 경기 대기열을 부를 이유가 없다.
  useEffect(() => {
    if (!isSuperuser) return;
    fetchOutbox().catch(() => undefined);
    const t = setInterval(() => {
      fetchOutbox().catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [id, isSuperuser]);

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
    const update=()=>{
      const ms=getCurrentClockMs();
      // Display seconds only. Event timestamps still read the full precision clock.
      setClockMs(previous=>Math.floor(previous/1000)===Math.floor(ms/1000)?previous:ms);
    };
    const timer=setInterval(update,250);
    document.addEventListener('visibilitychange',update);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',update);};
  }, [running]);

  useEffect(() => {
    // 시계 저장(sample)은 보관함이 비어 있을 때만 나간다 — 밀린 입력보다 먼저 가면 누른 시각이 밀린다.
    const t = setInterval(() => {
      if (canWrite && runningRef.current) void inputsRef.current.sample(stateBody());
    }, 3000);
    return () => clearInterval(t);
  }, [canWrite]);

  // 시계를 누른 순간 값으로 세우거나 그 값부터 다시 돌린다. 서버 응답을 기다리지 않는다.
  const setLocalClock = (ms: number, nextRunning: boolean) => {
    baseRef.current=ms;clockRef.current=ms;wallRef.current=Date.now();
    perfRef.current=nextRunning?performance.now():null;
    runningRef.current=nextRunning;setRunning(nextRunning);setClockMs(ms);
  };

  // 잠금 없이 바로 바뀐다. 연달아 눌러도 누른 순서·시각대로 보관함에 쌓인다.
  const toggleRun = () => {
    if (!canWrite) return;
    const nextRunning = !runningRef.current;
    const frozen = getCurrentClockMs();
    setLocalClock(frozen, nextRunning);
    saveState({clockMs:frozen,running:nextRunning});
  };

  /* 경기 종료 — 경기가 완전히 끝났을 때 한 번에 마감한다(전·후반 종료 버튼이 아니다).
     순서: 시계 정지 → 남은 입력 전송 완료 대기 → 송출 중지 → HLS 정리 → 보관 → 대시보드.
     보관된 경기는 기록 쓰기·송출 정리가 막히므로(서버 _require_match_not_archived) 남은 입력을
     다 보내기 전에는 보관하지 않는다 — 보관을 먼저 하면 못 보낸 기록이 사라진다. */
  const [endMatchStep, setEndMatchStep] = useState<'' | 'confirm' | 'running'>('');
  const [endMatchNote, setEndMatchNote] = useState('');
  const pendingInputsRef = useRef({ pending: 0, failed: 0 });
  // 종료 대기 루프가 최신 남은 입력 수를 보도록 렌더마다 갱신한다(useFlaOutbox 결과는 위에서 이미 나왔다).
  pendingInputsRef.current = { pending: inputs.pendingCount, failed: inputs.failedCount };
  const confirmEndMatch = async () => {
    if (!canWrite || endMatchStep === 'running') return;
    setEndMatchStep('running');
    const problems: string[] = [];
    try {
      if (runningRef.current) {
        setEndMatchNote('시계를 멈추는 중…');
        toggleRun();
      }
      // 남은 입력이 다 저장될 때까지 기다린다(최대 60초). 못 보내면 종료하지 않는다.
      const until = Date.now() + 60000;
      while (pendingInputsRef.current.pending > 0 && Date.now() < until) {
        setEndMatchNote(`남은 기록 ${pendingInputsRef.current.pending}건 저장 중…`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (pendingInputsRef.current.pending > 0 || pendingInputsRef.current.failed > 0) {
        setEndMatchStep('');
        setEndMatchNote('');
        setControlNotice(`아직 저장되지 않은 기록이 있어 경기를 종료하지 않았습니다(대기 ${pendingInputsRef.current.pending}건 · 실패 ${pendingInputsRef.current.failed}건). 저장된 뒤 다시 눌러 주세요.`);
        return;
      }
      if (!isManualMatch) {
        setEndMatchNote('송출을 멈추고 HLS 영상을 정리하는 중…');
        const stopped = await apiFetch(`/matches/${id}/stream/stop`, { method: 'POST' }).catch(() => null);
        if (!stopped?.ok) problems.push('송출 중지');
        const cleared = await apiFetch(`/matches/${id}/stream/clear`, { method: 'POST' }).catch(() => null);
        if (!cleared?.ok) problems.push('HLS 정리');
      }
      setEndMatchNote('경기를 보관하는 중…');
      const body = JSON.stringify({ archived: true, stop_stream: !isManualMatch });
      let res = await apiFetch(`/matches/${id}/archive`, { method: 'POST', body });
      // 시계 정지가 서버에 늦게 닿아 '진행 중'으로 막히면, 종료를 이미 확인받았으므로 그대로 보관한다.
      if (res.status === 409) res = await apiFetch(`/matches/${id}/archive?confirm_live_action=true`, { method: 'POST', body });
      if (!res.ok) {
        setEndMatchStep('');
        setEndMatchNote('');
        // 함께 실패한 단계(송출 중지·HLS 정리)와 서버 원문은 자세히에 남긴다.
        setControlNotice((await errorFromResponse(res, {
          fixed: "경기 보관에 실패했습니다. 운영 현황에서 'Archive'를 눌러 주세요.",
          context: problems.length ? { '함께 실패한 단계': problems.join('·') } : undefined,
        })).message);
        return;
      }
      try {
        if (problems.length) window.sessionStorage.setItem('fla-end-match-notice', `경기를 보관했습니다. 다만 ${problems.join('·')}를 하지 못했습니다. Media 화면에서 확인해 주세요.`);
      } catch { /* 안내만 못 남길 뿐이다 */ }
      window.location.href = '/admin/dashboard';
    } catch {
      setEndMatchStep('');
      setEndMatchNote('');
      setControlNotice('경기 종료 중 연결이 끊겼습니다. 다시 눌러 주세요.');
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

  const resetClock = () => {
    if (!canWrite) return;
    if (!window.confirm('타이머를 00:00으로 초기화할까요?')) return;
    setLocalClock(0, false);
    setControls({ possession_team: 'NONE' });
    setSecondHalfStartAbsMs(null);
    setThirdHalfStartAbsMs(null);
    setFourthHalfStartAbsMs(null);
    saveState({ clockMs: 0, running: false, allowClockRewind: true, possessionTeam: 'NONE' });
  };

  const startFirstHalf = () => {
    if (!canWrite) return;
    if (!window.confirm(isSinglePeriod ? '경기 타이머를 00:00으로 설정할까요?' : '타이머를 1H 00:00으로 설정할까요?')) return;
    setLocalClock(0, false);
    setControls({ possession_team: 'NONE' });
    setSecondHalfStartAbsMs(null);
    setThirdHalfStartAbsMs(null);
    setFourthHalfStartAbsMs(null);
    saveState({
      clockMs: 0,
      running: false,
      possessionTeam: 'NONE',
      allowClockRewind: true,
    });
  };

  // 전후반·연장 경계: 마커와 정지 명령을 누른 순서대로 보관함에 넣는다. 마커는 종류당 한 줄을
  // 덮어쓰므로 다시 보내도 같은 값이 남는다.
  const markPeriodStart = (markerType: 'HALFTIME_START' | 'EXTRA_TIME_1_START' | 'EXTRA_TIME_2_START', now: number) => {
    setLocalClock(now, false);
    setControls({ possession_team: 'NONE' });
    inputsRef.current.enqueue('marker', { marker_type: markerType, clock_ms: now }, now);
    saveState({ clockMs: now, running: false, possessionTeam: 'NONE' });
  };

  const markSecondHalfStart = () => {
    if (!canWrite) return;
    const baseHalfMinutes = regulationHalfMinutes(match?.competition_class, match?.first_half_minutes);
    if (!window.confirm(`지금 시점을 2H 시작(표시 ${baseHalfMinutes}:00)으로 설정할까요?`)) return;
    const now = getCurrentClockMs();
    setSecondHalfStartAbsMs(now);
    markPeriodStart('HALFTIME_START', now);
  };

  // ── 하이라이트(HL) ─────────────────────────────────────────────────────
  // '지금 장면이 하이라이트다' 를 **경기 시계**로 남긴다. 나중에 로컬앱이 이 시계를
  // 영상 시간으로 옮겨(전·후반 앵커) 태그를 자동으로 찍는다.
  //
  // 마커와 다르다 — 마커는 타입당 한 줄이라 다시 찍으면 덮어쓰지만, 하이라이트는
  // 누를 때마다 쌓인다(models.MatchHighlight).
  const { highlights, pending: pendingHighlights, busy: highlightBusy, hlNotice,
    storageError: highlightStorageError, markHighlight, removeHighlight, retryHighlight, exportPending,
  } = useMatchHighlights(id, userId, canWrite, getCurrentClockMs);

  /** 로컬앱(FinePlay Highlight)이 읽는 로그 파일. 골·유효슛·슛·HL·하프타임 경계가
   *  경기 시계로 한 장에 담긴다 — 앱이 앵커 두 개로 영상 시간에 앉힌다. */
  const downloadHighlightLog = () => {
    window.open(`${API_BASE}/matches/${id}/highlight-log.json`, '_blank');
  };

  const extraHalfBaseMinutes = (period: 3 | 4) => {
    const firstHalfMin = regulationHalfMinutes(match?.competition_class, match?.first_half_minutes);
    const secondHalfMin = Number(match?.second_half_minutes) > 0 ? Number(match?.second_half_minutes) : firstHalfMin;
    const extraFirstHalfMin = Number(match?.extra_first_half_minutes) > 0 ? Number(match?.extra_first_half_minutes) : 15;
    return period === 3 ? firstHalfMin + secondHalfMin : firstHalfMin + secondHalfMin + extraFirstHalfMin;
  };

  const markThirdHalfStart = () => {
    if (!canWrite) return;
    const baseMin = extraHalfBaseMinutes(3);
    if (!window.confirm(`지금 시점을 연장 전반(3H) 시작(표시 ${baseMin}:00)으로 설정할까요?`)) return;
    const now = getCurrentClockMs();
    setThirdHalfStartAbsMs(now);
    setFourthHalfStartAbsMs(null);
    markPeriodStart('EXTRA_TIME_1_START', now);
  };

  const markFourthHalfStart = () => {
    if (!canWrite) return;
    const baseMin = extraHalfBaseMinutes(4);
    if (!window.confirm(`지금 시점을 연장 후반(4H) 시작(표시 ${baseMin}:00)으로 설정할까요?`)) return;
    const now = getCurrentClockMs();
    setFourthHalfStartAbsMs(now);
    markPeriodStart('EXTRA_TIME_2_START', now);
  };

  // 점유는 누르는 즉시 바뀐다(종전엔 서버 응답 뒤에 바뀌어 느린 순간 "안 눌린" 것처럼 보였다).
  const changePossession = (team: PossessionTeam) => {
    if (!canWrite) return;
    setControls(team === 'NONE' ? { possession_team: team } : { possession_team: team, selected_team: team });
    if (team !== 'NONE') setXgTeam(team);
    saveState(team === 'NONE' ? {possessionTeam: team} : {possessionTeam: team, selectedTeam: team});
  };

  const selectEventTeam = (team: Team) => {
    setControls({ selected_team: team });
    setXgTeam(team);
    if (canWrite) saveState({ selectedTeam: team });
  };

  const changeAttackDirection = (direction: AttackLR) => {
    if (!canWrite) return;
    setControls({ attack_lr: direction });
    saveState({ attackLR: direction });
  };

  const resetPossession = async () => {
    if (!canWrite || isResettingPossession) return;
    // 초기화 전에 누른 점유 입력이 초기화 뒤에 도착하면 지운 구간이 다시 생긴다 — 다 보낸 뒤에 한다.
    if (inputsRef.current.hasPendingState()) {
      setControlNotice('아직 저장 중인 점유 입력이 있습니다. 저장된 뒤 다시 눌러 주세요.');
      return;
    }
    setPossessionResetConfirm(true);
  };
  // 점유 초기화 확인 창 — 기록 전체 삭제와 같은 방식(작은 글씨 버튼 + 확인 창에서 "초기화").
  const [possessionResetConfirm, setPossessionResetConfirm] = useState(false);
  const confirmResetPossession = async () => {
    if (!canWrite || isResettingPossession) return;
    setPossessionResetConfirm(false);
    setIsResettingPossession(true);
    try {
      let res = await apiFetch(`/matches/${id}/possession/reset`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        // 확인 창엔 한국어만. 서버 원문은 콘솔로, 판정은 상태 코드(409)로 한다.
        const conflict = await errorFromResponse(res, {});
        warnRaw('점유 초기화 409 — 한 번 더 확인', conflict);
        const confirmLive = window.confirm(/blocked while match clock is running/.test(errorDetail(conflict))
          ? '경기 시계가 돌고 있습니다. 그래도 점유율을 초기화할까요?'
          : `${conflict.message}\n\n계속 초기화할까요?`);
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
        setControls({ possession_team: 'NONE' });
        saveState({ possessionTeam: 'NONE' });
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

  // 기록 전체 삭제 확인 창 — 한 번 묻고 "삭제"를 누르면 지운다. 시계가 돌고 있으면 서버가
  // 409 로 막으므로, 같은 창을 그 경고로 바꿔 한 번 더 누르게 한다(그때만 confirm_live_action).
  const [resetConfirm, setResetConfirm] = useState<{ live: boolean } | null>(null);
  const resetEvents = () => {
    if (!canWrite || isResettingEvents) return;
    setResetConfirm({ live: false });
  };
  const confirmResetEvents = async () => {
    if (!resetConfirm || !canWrite) return;
    setIsResettingEvents(true);
    try {
      const res = await apiFetch(`/matches/${id}/events/reset${resetConfirm.live ? '?confirm_live_action=true' : ''}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.status === 409 && !resetConfirm.live) {
        setResetConfirm({ live: true });
        return;
      }
      setResetConfirm(null);
      if (!res.ok) {
        setCopyMessage('Event reset failed');
      } else {
        // 아직 못 보낸 기록도 "모두 삭제"에 들어간다 — 남겨 두면 삭제 뒤에 도착해 다시 나타난다.
        inputsRef.current.discard((item) => item.kind === 'lane' || item.kind === 'shot');
        deliveredRef.current.clear();
        setDeliveredTick((t) => t + 1);
        setCopyMessage('Events reset');
        await fetchAll();
      }
    } catch {
      setResetConfirm(null);
      setCopyMessage('Event reset failed');
    } finally {
      setIsResettingEvents(false);
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  // 종전엔 앞 기록이 저장될 때까지 다음 클릭을 말없이 버렸다. 이제 누를 때마다 한 건씩 쌓이고 순서대로 보낸다.
  const sendLane = (lane: Lane) => {
    if (!canWrite) return;
    const team = controlsRef.current.selected_team;
    const clock = getCurrentClockMs();
    inputsRef.current.enqueue('lane', { team, lane, clock_ms: Math.max(0, Math.round(clock)) }, clock);
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
        throw await errorFromResponse(response, { action: 'PDF 명단을 읽지 못했습니다', fallback: 'PDF 명단을 읽지 못했습니다. PDF 파일인지 확인하세요.' });
      }
      const data = await response.json();
      setMatch(data.match);
      const homeCount = data.lineups?.teams?.HOME?.length || 0;
      const awayCount = data.lineups?.teams?.AWAY?.length || 0;
      setCopyMessage(`PDF 명단 반영: 홈 ${homeCount}명 · 어웨이 ${awayCount}명. 아래 유니폼 정보와 팀 방향을 확인하세요.`);
    } catch (error) {
      setCopyMessage(errorMessage(error, 'PDF 명단을 읽지 못했습니다. PDF 파일인지 확인하세요.'));
    } finally {
      setIsUploadingLineup(false);
      if (lineupInputRef.current) lineupInputRef.current.value = '';
      clearCopyMessageLater(2500);
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
        throw await errorFromResponse(response, { action: '엑셀 명단을 읽지 못했습니다', fallback: '엑셀 명단을 읽지 못했습니다. .xlsx 파일인지 확인하세요.' });
      }
      const data = await response.json();
      setMatch(data.match);
      const homeCount = data.lineups?.teams?.HOME?.length || 0;
      const awayCount = data.lineups?.teams?.AWAY?.length || 0;
      setCopyMessage(`엑셀 명단 반영: 홈 ${homeCount}명 / 원정 ${awayCount}명`);
    } catch (error) {
      setCopyMessage(errorMessage(error, '엑셀 명단을 읽지 못했습니다. .xlsx 파일인지 확인하세요.'));
    } finally {
      setIsUploadingRecordSheet(false);
      if (recordSheetInputRef.current) recordSheetInputRef.current.value = '';
      clearCopyMessageLater(3000);
    }
  };

  const swapLineupSides = async () => {
    if (!canWrite || isSwappingLineup || !hasLineupPlayers) return;
    setIsSwappingLineup(true);
    setCopyMessage('');
    try {
      const response = await apiFetch(`/matches/${id}/lineup/swap`, { method: 'POST' });
      if (!response.ok) {
        throw await errorFromResponse(response, 'Lineup swap failed');
      }
      const data = await response.json();
      setMatch(data.match);
      const homeCount = data.lineups?.teams?.HOME?.length || 0;
      const awayCount = data.lineups?.teams?.AWAY?.length || 0;
      setCopyMessage(`Lineup swapped: HOME ${homeCount}, AWAY ${awayCount}`);
    } catch (error) {
      setCopyMessage(errorMessage(error, 'Lineup swap failed'));
    } finally {
      setIsSwappingLineup(false);
      clearCopyMessageLater(2500);
    }
  };

  const saveManualLineupPlayer = async () => {
    if (!canWrite || isSavingManualLineup) return;
    const number = manualLineupNumber.trim();
    const name = manualLineupName.trim();
    if (!number || !name) {
      setCopyMessage('등번호와 이름을 입력하세요.');
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
        throw await errorFromResponse(response, { action: '선수를 저장하지 못했습니다', fallback: '선수를 저장하지 못했습니다.' });
      }
      const data = await response.json();
      setMatch(data.match);
      setManualLineupNumber('');
      setManualLineupName('');
      setCopyMessage(`Manual player saved: ${manualLineupSide} No.${number} ${name}`);
    } catch (error) {
      setCopyMessage(errorMessage(error, '선수를 저장하지 못했습니다.'));
    } finally {
      setIsSavingManualLineup(false);
      clearCopyMessageLater(2500);
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
        throw await errorFromResponse(response, { action: '선수를 빼지 못했습니다', fallback: '선수를 빼지 못했습니다.' });
      }
      const data = await response.json();
      setMatch(data.match);
      setCopyMessage(`Manual player removed: ${side} No.${number}`);
    } catch (error) {
      setCopyMessage(errorMessage(error, '선수를 빼지 못했습니다.'));
    } finally {
      setIsSavingManualLineup(false);
      clearCopyMessageLater(2500);
    }
  };

  const submitXg = () => {
    if (!canWrite) return;
    const shotCoordinates=getShotCoordinates();
    if(!shotCoordinates){setControlNotice('피치에서 슈팅 위치를 선택한 뒤 기록해 주세요.');return;}
    const xg=isOwnGoal?0:Number(xgValue);
    if(!Number.isFinite(xg)||xg<0||xg>1){setXgEstimateMeta('xG는 0~1 사이의 숫자로 입력해 주세요.');return;}
    const goalmouthCoordinates=getGoalmouthCoordinates();
    if(!isOwnGoal&&isOnTargetShot&&!goalmouthCoordinates){
      setXgotEstimateMeta('골문에서 슈팅 도착 위치를 선택해 주세요.');
      setControlNotice('골문에서 슈팅 도착 위치를 선택한 뒤 기록해 주세요.');return;
    }
    const clock=Math.max(0,Math.round(getCurrentClockMs()));
    const eventId=makeId();
    // 골 연속 입력이 막히지 않게 저장을 기다리지 않는다. 누른 순간 기록 목록·점수에 바로 들어간다.
    const submission=inputsRef.current.enqueue('shot',{
      event_id:eventId,clock_ms:clock,team:xgTeam,xg,
      player_name:isOwnGoal?null:selectedXgPlayer?.name||null,
      player_number:isOwnGoal?null:selectedXgPlayer?.number||null,
      is_goal:isOwnGoal||isGoalShot,is_own_goal:isOwnGoal,is_on_target:!isOwnGoal&&isOnTargetShot,
      shot_x:shotCoordinates.shot_x,shot_y:shotCoordinates.shot_y,
      goalmouth_x:isOwnGoal?null:goalmouthCoordinates?.goalmouth_x??null,
      goalmouth_y:isOwnGoal?null:goalmouthCoordinates?.goalmouth_y??null,
      is_header:!isOwnGoal&&isHeaderShot,is_weak_foot:false,
      under_pressure:!isOwnGoal&&isUnderPressureShot,one_on_one:!isOwnGoal&&isOneOnOneShot,shot_pace_band:'MID',
    },clock,eventId);
    if(!submission)return;
    // 보관함에 들어간 것은 누른 순간의 사본이다. 바로 비워 다음 슈팅을 이어서 입력하게 한다.
    setXgValue('0.10');setXgPlayerKey('');setXgotValue('0.000');setShotPoint(null);
    setIsOnTargetShot(false);setGoalmouthPoint(null);setIsHeaderShot(false);setIsGoalShot(false);
    setIsOwnGoal(false);setIsUnderPressureShot(false);setIsOneOnOneShot(false);
    setXgEstimateMeta('');setXgotEstimateMeta('');setControlNotice('');
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
    if (isFutsal) {
      const point = futsalPitchPoint(px / rect.width, py / rect.height);
      if (!point) return; // The red surround is outside the playing area.
      setShotPoint(point);
    } else {
      const y = (px / rect.width) * PITCH_WIDTH;
      const x = (1 - py / rect.height) * XG_VISIBLE_LENGTH;
      setShotPoint({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
    }
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
      setXgEstimateMeta('피치에서 슈팅 위치를 먼저 선택하세요.');
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
      setXgEstimateMeta(await responseMessage(res, { fixed: '계산하지 못했습니다. 다시 눌러 주세요.' }));
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
      setXgotEstimateMeta('xG 값을 먼저 입력하세요.');
      return;
    }
    if (!isOnTargetShot) {
      setXgotEstimateMeta('"유효슈팅"을 먼저 켜세요.');
      return;
    }
    if (!goalmouthCoordinates) {
      setXgotEstimateMeta('골문에서 슈팅 도착 위치를 먼저 선택하세요.');
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
      setXgotEstimateMeta(await responseMessage(res, { fixed: '계산하지 못했습니다. 다시 눌러 주세요.' }));
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
      setCopyMessage(await responseMessage(response, { fixed: '운영권을 가져오지 못했습니다. 다른 운영자가 쓰는 중인지 확인하세요.' }));
      clearCopyMessageLater(1500);
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
      setCopyMessage(await responseMessage(response, { fixed: '운영권을 해제하지 못했습니다.' }));
      clearCopyMessageLater(1500);
      return;
    }
    await fetchAll();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      // Keep letter shortcuts available after clicking recording controls.
      // Editing fields and modal dialogs retain their own keyboard behavior.
      if (target?.isContentEditable || target?.closest('input, textarea, select, [role="textbox"], [role="combobox"], [role="listbox"]')) return;
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) return;
      const isEnter = e.key === 'Enter';
      if (isEnter && target?.closest('button, summary, a, [role="button"]')) return;
      if (!canWrite || (!['KeyQ', 'KeyW', 'KeyE', 'KeyA', 'KeyS', 'KeyD'].includes(e.code) && !isEnter)) return;
      e.preventDefault();

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
        sendLane(pendingLaneRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, canWrite, possessionTeam, pendingLane, selectedTeam, clockMs]);

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

  // 운영자 화면에만 아직 안 보낸 기록을 얹는다(중계 오버레이·협업사 API 는 서버 확정 기록만 본다).
  // 서버 목록에 같은 id 가 들어오면 그쪽을 쓴다 — 같은 기록이 두 줄로 보이거나 점수가 두 번 오르지 않게.
  const displaySummary = useMemo(() => {
    if (!summary) return summary;
    const serverIds = new Set<string>((summary.events || []).map((e: any) => String(e.id)));
    const local = [
      ...inputs.items.filter((item) => item.kind === 'lane' || item.kind === 'shot')
        .map((item) => outboxRecordRow(item, item.failed ? '저장 실패' : '저장 중')),
      ...[...deliveredRef.current.values()].map(({ item }) => outboxRecordRow(item, '')),
    ].filter((row) => !serverIds.has(row.id)).sort((a, b) => b.seq - a.seq);
    if (!local.length) return summary;
    const score = summary.score ? { ...summary.score } : null;
    if (score) for (const row of local) if (row.type === 'XG' && row.is_goal) score[row.team === 'AWAY' ? 'away' : 'home'] += 1;
    return { ...summary, events: [...local, ...(summary.events || [])], score };
  }, [summary, inputs.items, deliveredTick]);
  const unsentCount = inputs.pendingCount + inputs.failedCount;
  const unsentRef = useRef(0);
  unsentRef.current = unsentCount;

  // 안 보낸 입력이 남은 채 나가려 하면 한 번 묻는다. 나가도 이 기기에 남아 있다가 경기를 다시 열면 보낸다.
  const router = useRouter();
  const [leaveAsk, setLeaveAsk] = useState<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    const leave = () => unsentRef.current === 0 ? true : new Promise<boolean>((resolve) => setLeaveAsk(() => resolve));
    const unregister = registerWorkspaceLeave(leave);
    const unload = (e: BeforeUnloadEvent) => { if (unsentRef.current) { e.preventDefault(); e.returnValue = ''; } };
    const navigate = (e: MouseEvent) => {
      const a = (e.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!unsentRef.current || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || !a || a.download || (a.target && a.target !== '_self') || a.origin !== location.origin || a.href === location.href) return;
      e.preventDefault(); e.stopImmediatePropagation();
      void Promise.resolve(leave()).then((ok) => { if (ok) router.push(a.pathname + a.search + a.hash); });
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true);
    return () => { unregister(); window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
  }, [router]);
  const answerLeave = (ok: boolean) => { leaveAsk?.(ok); setLeaveAsk(null); };
  const [discardFailedAsk, setDiscardFailedAsk] = useState(false);

  return (
    <main className="page-stack fla-match" data-mobile-view={mobileView}>
      {possessionResetConfirm ? (
        <ConfirmDialog
          title="점유율을 초기화할까요?"
          message={<p>홈·원정 점유 시간이 0:0 으로 돌아갑니다. 되돌릴 수 없습니다.</p>}
          confirmLabel="초기화"
          busy={isResettingPossession}
          onConfirm={() => void confirmResetPossession()}
          onCancel={() => setPossessionResetConfirm(false)}
        />
      ) : null}
      {endMatchStep ? (
        <ConfirmDialog
          title="경기를 종료할까요?"
          message={endMatchStep === 'running' ? <p>{endMatchNote || '경기를 마감하는 중…'}</p> : (
            <>
              <p><b>전반·후반 종료가 아니라, 경기가 완전히 끝났을 때 누르는 버튼입니다.</b></p>
              <p>시계를 멈추고 남은 기록을 모두 저장한 뒤{isManualMatch ? '' : ' 송출을 멈추고 HLS 영상을 정리하고'} 경기를 보관합니다. 보관 후에는 기록을 고칠 수 없습니다(관리자만 Event Editor 에서 가능).</p>
            </>
          )}
          confirmLabel="경기 종료"
          busy={endMatchStep === 'running'}
          onConfirm={() => void confirmEndMatch()}
          onCancel={() => { setEndMatchStep(''); setEndMatchNote(''); }}
        />
      ) : null}
      {leaveAsk ? (
        <ConfirmDialog
          title="저장 안 된 입력이 있습니다"
          message={<p>서버에 아직 못 보낸 입력이 {unsentCount}건 있습니다. 나가도 이 기기에 남아 있고, 이 경기를 다시 열면 이어서 보냅니다.</p>}
          confirmLabel="나가기"
          onConfirm={() => answerLeave(true)}
          onCancel={() => answerLeave(false)}
        />
      ) : null}
      {discardFailedAsk ? (
        <ConfirmDialog
          title="저장 실패한 입력을 지울까요?"
          message={<p>서버가 받지 않은 입력 {inputs.failedCount}건을 이 기기에서 지웁니다. 되돌릴 수 없습니다.</p>}
          confirmLabel="지우기"
          onConfirm={() => { inputs.discard((item) => !!item.failed); setDiscardFailedAsk(false); }}
          onCancel={() => setDiscardFailedAsk(false)}
        />
      ) : null}
      {resetConfirm ? (
        <ConfirmDialog
          title={resetConfirm.live ? '경기가 진행 중입니다' : '이 경기 기록을 모두 삭제할까요?'}
          message={<p>{resetConfirm.live
            ? '시계가 돌고 있습니다. 그래도 삭제하면 공격 방향·슈팅 기록이 모두 지워집니다. 되돌릴 수 없습니다.'
            : '공격 방향·슈팅 기록이 모두 지워집니다. 되돌릴 수 없습니다.'}{(() => {
              const n = inputs.items.filter((item) => item.kind === 'lane' || item.kind === 'shot').length;
              return n ? ` 아직 저장 중인 기록 ${n}건도 함께 지웁니다.` : '';
            })()}</p>}
          busy={isResettingEvents}
          onConfirm={() => void confirmResetEvents()}
          onCancel={() => setResetConfirm(null)}
        />
      ) : null}
      {/* 분석(경기 타이머) 진행 중 전체화면 네온 글로우 — 시작됐음을 시각적으로 알린다. */}
      {running ? <div className="live-neon-overlay" aria-hidden /> : null}
      <header className="fla-match-heading">
        <div><div className="row fla-match-context"><Link className="button-link button-compact btn-secondary fla-back-link" href="/admin/dashboard">← 운영 현황</Link><span className="status-pill chip-tag">{match?.competition_class || 'FLA'}</span>{match?.metadata?.design_preview ? <span className="status-pill tech chip-tag">로컬 예시 경기</span> : null}<span className="muted">{isArchived ? '보관 경기 · 읽기 전용' : canWrite ? '기록 가능' : '읽기 전용'}</span>{inputs.pendingCount ? <span className="muted fla-sync-count" role="status">저장 대기 {inputs.pendingCount}건</span> : null}{canWrite && !isArchived ? <button type="button" className="btn-danger fla-end-match" onClick={() => setEndMatchStep('confirm')}>경기 종료</button> : null}</div><h2>{matchTeams ? `${matchTeams.homeTeam} vs ${matchTeams.awayTeam}` : match?.name || '경기 불러오는 중…'}</h2></div>
      </header>
          <details ref={setupRef} className="card fla-setup" id="match-setup"><summary>명단 · 운영권 · 데이터 내보내기</summary>
      <div className="row fla-setup-content" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="grid" style={{ gap: 6 }}>
          <div className="match-meta-group">

            <span className={`meta-chip chip-tag ${streamMode === 'STREAM' ? 'tech' : 'warning'}`}>
              mode: {streamMode === 'MANUAL' ? 'Manual Field Mode' : 'Stream + HLS'}
            </span>
            {streamMode === 'STREAM' ? <>
            <span className={`meta-chip chip-tag ${streamMode === 'STREAM' ? 'tech' : ''}`}>
              RTMP 서버: {rtmpServer || '미설정'}
            </span>
            <span className={`meta-chip chip-tag ${streamMode === 'STREAM' ? 'tech' : ''}`}>
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
          {copyMessage ? <div className="muted">{copyMessage}<ErrorFold message={copyMessage} /></div> : null}
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
      {loadError ? <div className="fla-feedback" role="alert"><span>{loadError}<ErrorFold message={loadError} /></span></div> : null}
      {inputs.blocked ? <div className="fla-feedback" role="alert"><span>1분 넘게 서버에 저장하지 못했습니다. 입력은 이 기기에 남아 있고, 연결되면 자동으로 보냅니다.</span></div> : null}
      {inputs.failedCount ? <div className="fla-feedback" role="alert"><span>서버가 받지 않은 입력 {inputs.failedCount}건이 있습니다.</span><button className="btn-secondary button-compact" style={{ padding: '0 10px' }} onClick={inputs.retryFailed}>다시 보내기</button><button className="btn-secondary button-compact" style={{ padding: '0 10px' }} onClick={() => setDiscardFailedAsk(true)}>지우기</button></div> : null}
      {inputs.storageError ? <div className="fla-feedback" role="alert"><span>브라우저 저장소를 쓸 수 없습니다. 저장 대기가 0건이 될 때까지 이 화면을 닫지 마세요.</span></div> : null}
      {controlNotice ? <div className="fla-feedback" role="status"><span>{controlNotice}<ErrorFold message={controlNotice} /></span><button aria-label="알림 닫기" onClick={() => setControlNotice('')}>×</button></div> : null}
      <AgentEditNotice matchId={id} onChange={() => { void fetchAll().catch(() => {}); }} />
      <section ref={clockCardRef} className="card fla-clock" aria-label="경기 타이머">
        <div className="fla-clock-main"><div><span className="muted">{running ? '진행 중' : '일시정지'}</span><strong className="fla-clock-value">{displayClockLabel(clockMs)}{clockSpeed === 2 ? ' ×2' : ''}</strong></div>
          {displaySummary?.score ? (
            <div
              className="fla-scoreboard"
              aria-label={`현재 점수 ${matchTeams?.homeTeam || '홈'} ${displaySummary.score.home} 대 ${displaySummary.score.away} ${matchTeams?.awayTeam || '원정'}`}
              title={`${matchTeams?.homeTeam || '홈'} ${displaySummary.score.home} : ${displaySummary.score.away} ${matchTeams?.awayTeam || '원정'}`}
            >
              <span className="team">{matchTeams?.homeTeam || '홈'}</span>
              <strong className="home">{displaySummary.score.home}</strong><span className="sep">:</span><strong className="away">{displaySummary.score.away}</strong>
              <span className="team">{matchTeams?.awayTeam || '원정'}</span>
            </div>
          ) : null}
          <div className="fla-period-controls" role="group" aria-label={isSinglePeriod ? "단일 경기" : "전후반 선택"}>
            <button className="btn-secondary" onClick={startFirstHalf} disabled={!canWrite}>{isSinglePeriod ? '경기 00:00' : '전반 00:00'}</button>
            {!isSinglePeriod ? <button className="btn-secondary" onClick={markSecondHalfStart} disabled={!canWrite}>후반 시작</button> : <span className="muted">전후반 없음 · {match?.first_half_minutes}분</span>}
          </div>
          <button className={running ? 'btn-secondary' : 'btn-primary'} onClick={(e) => { e.currentTarget.blur(); toggleRun(); }} disabled={!canWrite}>{running ? '일시정지' : '경기 시작'}</button>
        </div>
        <details className="fla-clock-settings"><summary>{isSinglePeriod ? '시간 보정' : '시간 보정 · 연장 설정'}{forgotSecondHalf ? <span className="fla-half-hint" role="status">후반 시작을 누르셨나요?</span> : null}</summary><div className="grid">
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
            {!isSinglePeriod ? <><button className="btn-secondary" onClick={markThirdHalfStart} disabled={!canWrite}>연장 전반</button>
            <button className="btn-secondary" onClick={markFourthHalfStart} disabled={!canWrite}>연장 후반</button></> : null}
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


          <MatchPossessionCard possessionTeam={possessionTeam} matchTeams={matchTeams} summary={summary} canWrite={canWrite} isResettingPossession={isResettingPossession} resetPossession={resetPossession} changePossession={changePossession} />
          <MatchAttackCard attackLR={attackLR} selectedTeam={selectedTeam} pendingLane={pendingLane} matchTeams={matchTeams} summary={summary} canWrite={canWrite} changeAttackDirection={changeAttackDirection} selectEventTeam={selectEventTeam} setPendingLane={setPendingLane} sendLane={sendLane} />
        </section>
        <section className="fla-shots" aria-label="슈팅 입력">
          <MatchShotCard isFutsal={isFutsal} xgTeam={xgTeam} setXgTeam={setXgTeam} xgPlayerKey={xgPlayerKey} setXgPlayerKey={setXgPlayerKey} xgPlayerOptions={xgPlayerOptions} isOnTargetShot={isOnTargetShot} setIsOnTargetShot={setIsOnTargetShot} isGoalShot={isGoalShot} setIsGoalShot={setIsGoalShot} isHeaderShot={isHeaderShot} setIsHeaderShot={setIsHeaderShot} isOwnGoal={isOwnGoal} setIsOwnGoal={setIsOwnGoal} shotPoint={shotPoint} goalmouthPoint={goalmouthPoint} canWrite={canWrite} canRecord={canWrite && !!shotPoint && (isOwnGoal || !isOnTargetShot || !!goalmouthPoint)} xgValue={xgValue} setXgValue={setXgValue} xgotValue={xgotValue} estimateXgFromPitch={estimateXgFromPitch} estimateXgotFromGoalmouth={estimateXgotFromGoalmouth} submitXg={submitXg} isSavingShot={false} onGoalmouthClick={onGoalmouthClick} onPitchClick={onPitchClick} xgEstimateMeta={xgEstimateMeta} xgotEstimateMeta={xgotEstimateMeta} />


        </section>
        <section className="fla-review grid" aria-label="경기 기록">
          <MatchRecentRecords summary={displaySummary} canWrite={canWrite} isResettingEvents={isResettingEvents} resetEvents={resetEvents} displayClockLabel={displayClockLabel} />
          <MatchPossessionTimeline possessionLogs={possessionLogs} downloadPossessionCsv={downloadPossessionCsv} resetPossessionLogView={resetPossessionLogView} />
            {/* 하이라이트 — 점유 타임라인 옆. 운영자 전원에게 열지 않고 SUPERADMIN 에게만
                보인다: 이 기록은 하이라이트 제작으로 곧장 이어지는 것이라, 경기 입력과
                책임이 다르다. */}
            {isSuperuser ? (
              <div className="card card-utility grid" style={{ minHeight: 180, gap: 8 }}>
                <h3>하이라이트</h3>
                <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn-primary"
                    onClick={() => void markHighlight()}
                    disabled={!canWrite}
                    title="지금 장면을 하이라이트로 남긴다 — 경기 시계가 기록된다"
                  >
                    ⭐ 지금 하이라이트
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={downloadHighlightLog}
                    title="로컬앱(FinePlay Highlight)에 넣을 로그 파일 — 골·유효슛·슛·HL·하프타임이 경기 시계로 담긴다"
                  >
                    로그 저장 (.json)
                  </button>
                </div>
                {hlNotice ? <span role="status" className="muted">{hlNotice}<ErrorFold message={hlNotice} /></span> : null}
                {pendingHighlights.length ? (
                  <div role="alert" className="grid" style={{ gap: 6 }}>
                    <strong>저장 미확인 {pendingHighlights.length}개</strong>
                    {pendingHighlights.map((item) => (
                      <div className="row" key={item.request_id}>
                        <span>원래 시각 {fmt(item.clock_ms)}</span>
                        <button className="btn-secondary" disabled={!canWrite || highlightBusy.includes(item.request_id)} onClick={() => void retryHighlight(item)}>
                          {highlightBusy.includes(item.request_id) ? '저장 확인 중…' : '같은 시각으로 다시 요청'}
                        </button>
                      </div>
                    ))}
                    {highlightStorageError ? <span>브라우저에도 보관하지 못했습니다. 이동 전에 복구 파일을 저장하세요.</span> : <span className="muted">이 탭에서 다시 열면 미확인 요청을 복원합니다.</span>}
                    <button className="btn-secondary" onClick={exportPending}>미확인 시각 복구 파일</button>
                  </div>
                ) : null}
                <div
                  className="grid"
                  style={{ height: 105, overflowY: 'auto', paddingRight: 4 }}
                >
                  {highlights.length === 0 ? (
                    <span className="muted">아직 찍은 하이라이트가 없습니다</span>
                  ) : (
                    highlights.map((h) => (
                      <div
                        key={h.id}
                        className="row"
                        style={{ justifyContent: 'space-between', alignItems: 'center' }}
                      >
                        <span>⭐ {fmt(h.clock_ms)}</span>
                        <button
                          className="btn-secondary"
                          style={{ padding: '1px 8px', fontSize: 12 }}
                          onClick={() => void removeHighlight(h.id)}
                          disabled={!canWrite}
                          title="잘못 찍은 하이라이트 지우기"
                        >
                          지우기
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          <MatchFlowCard isFutsal={isFutsal} dominanceChartData={dominanceChartData} dominanceXAxisTicks={dominanceXAxisTicks} formatDominanceTick={formatDominanceTick} dominanceMeta={dominanceMeta} dominanceSeriesData={dominanceSeriesData} />



        </section>
        <section className="fla-settings grid" aria-label="경기 설정">
          {/* 중계 데이터 미리보기 — 축구만(중계 그래픽은 축구 경기에서만 만든다). 접혀 있으면 요청 0건. */}
          {match && (match.sport || 'FOOTBALL') === 'FOOTBALL' ? <BroadcastPreviewPanel matchId={id} match={match} /> : null}

      {isSuperuser ? (() => {
        // 협업사 전송(웹훅) 상태 — 이 경기 것만, 접어서 둔다. 오류 원문은 펼쳤을 때만 보인다.
        const rows = outbox.filter((o) => !o.match_id || o.match_id === id);
        const failed = rows.filter((o) => o.last_error).length;
        return (
          <details className="card card-utility fla-delivery">
            <summary>데이터 전송 상태 · 대기 {rows.length - failed}건 · 실패 {failed}건</summary>
            <div className="grid">
              {rows.length ? rows.slice(0, 20).map((o) => (
                <div key={o.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{o.kind === 'EVENT' ? '기록' : o.kind === 'STATE' ? '시계·점유' : o.kind} · {o.attempts}회 시도</span>
                  <span className="muted">{o.last_error ? <>전송 실패 · 자동으로 다시 보냅니다<ErrorFold info={{ message: '', raw: o.last_error, context: { '전송 ID': o.id } }} /></> : '전송 대기'}</span>
                </div>
              )) : <span className="muted">이 경기에서 보낼 것이 없습니다</span>}
            </div>
          </details>
        );
      })() : null}
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
