'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiFetch, apiJson, type SessionUser } from '../../../../../lib/api';

const HALF_PITCH_LENGTH = 52.5;
const XG_VISIBLE_LENGTH = 40;
const XG_VISIBLE_OFFSET = HALF_PITCH_LENGTH - XG_VISIBLE_LENGTH;
const PITCH_WIDTH = 68;

function regulationHalfMinutes(competitionClass?: string | null, firstHalfMinutes?: number | null) {
  if (Number.isFinite(Number(firstHalfMinutes)) && Number(firstHalfMinutes) > 0) {
    return Number(firstHalfMinutes);
  }
  const normalized = (competitionClass || '').trim().toUpperCase();
  if (normalized.includes('SUFA')) return 20;
  return 45;
}
type Team = 'HOME' | 'AWAY';
type ShotPaceBand = 'LOW' | 'MID' | 'HIGH';

const SHOT_PACE_LABEL: Record<ShotPaceBand, string> = {
  LOW: 'S',
  MID: 'N',
  HIGH: 'F',
};

const SHOT_PACE_LONG_LABEL: Record<ShotPaceBand, string> = {
  LOW: 'Slow',
  MID: 'Normal',
  HIGH: 'Fast',
};

type MatchInfo = {
  id: string;
  name: string;
  archived: boolean;
  archived_at?: string | null;
  competition_class?: string;
  first_half_minutes?: number;
  second_half_minutes?: number;
};

type TimelineItem = {
  item_id: string;
  kind: 'EVENT' | 'MARKER';
  type: 'ATTACK_LANE' | 'XG' | 'HALFTIME_START';
  clock_ms: number;
  team: 'HOME' | 'AWAY' | null;
  lane: 'LEFT' | 'CENTER' | 'RIGHT' | null;
  xg: number | null;
  xgot: number | null;
  is_goal: boolean;
  is_on_target: boolean;
  shot_x: number | null;
  shot_y: number | null;
  goalmouth_x: number | null;
  goalmouth_y: number | null;
  is_header: boolean;
  is_weak_foot: boolean;
  under_pressure: boolean;
  one_on_one: boolean;
  shot_pace_band: 'LOW' | 'MID' | 'HIGH' | null;
  created_at: string;
};

type TimelineResponse = {
  items: TimelineItem[];
  total: number;
  limit: number;
  offset: number;
};

type DominanceBin = {
  k: number;
  period?: number;
  start_ms: number;
  end_ms: number;
  display_start_ms?: number;
  display_end_ms?: number;
  chart_start_ms?: number;
  chart_end_ms?: number;
  chart_midpoint_ms?: number;
  home_poss_ms: number;
  away_poss_ms: number;
  home_xg: number;
  away_xg: number;
  home_attack_score: number;
  away_attack_score: number;
  dominance: number;
  annotations?: {
    goal_summary?: { home: number; away: number; total: number };
    markers?: string[];
  };
};

type DominanceResponse = {
  bin_seconds: number;
  split_halves?: boolean;
  half_gap_ms?: number;
  ht_chart_ms?: number;
  halves?: Array<{ period: number; duration_ms: number }>;
  bins: DominanceBin[];
};

type EditorForm = {
  kind: 'EVENT' | 'MARKER';
  type: 'ATTACK_LANE' | 'XG' | 'HALFTIME_START';
  clock_ms: string;
  team: Team;
  lane: 'LEFT' | 'CENTER' | 'RIGHT';
  xg: string;
  is_goal: boolean;
  is_on_target: boolean;
  shot_x: string;
  shot_y: string;
  goalmouth_x: string;
  goalmouth_y: string;
  is_header: boolean;
  is_weak_foot: boolean;
  under_pressure: boolean;
  one_on_one: boolean;
  shot_pace_band: ShotPaceBand;
};

const EMPTY_FORM: EditorForm = {
  kind: 'EVENT',
  type: 'ATTACK_LANE',
  clock_ms: '00:00',
  team: 'HOME',
  lane: 'CENTER',
  xg: '0.10',
  is_goal: false,
  is_on_target: false,
  shot_x: '',
  shot_y: '',
  goalmouth_x: '',
  goalmouth_y: '',
  is_header: false,
  is_weak_foot: false,
  under_pressure: false,
  one_on_one: false,
  shot_pace_band: 'MID',
};

function fmtClock(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function snapToSecond(ms: number) {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms / 1000) * 1000);
}

function parseClockInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) {
    return snapToSecond(Number(trimmed) * 1000);
  }
  const parts = trimmed.split(':').map((part) => part.trim());
  if (parts.length !== 2) return 0;
  const mm = Number(parts[0]);
  const ss = Number(parts[1]);
  if (!Number.isFinite(mm) || !Number.isFinite(ss) || mm < 0 || ss < 0) return 0;
  return snapToSecond((mm * 60 + ss) * 1000);
}

function shiftClockInput(value: string, deltaSeconds: number) {
  const nextMs = Math.max(0, parseClockInput(value) + deltaSeconds * 1000);
  return fmtClock(nextMs);
}

function toInputNumber(value: string) {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formFromItem(item: TimelineItem): EditorForm {
  return {
    kind: item.kind,
    type: item.type,
    clock_ms: fmtClock(item.clock_ms ?? 0),
    team: item.team || 'HOME',
    lane: item.lane || 'CENTER',
    xg: item.xg != null ? String(item.xg) : '0.10',
    is_goal: Boolean(item.is_goal),
    is_on_target: Boolean(item.is_on_target),
    shot_x: item.shot_x != null ? String(item.shot_x) : '',
    shot_y: item.shot_y != null ? String(item.shot_y) : '',
    goalmouth_x: item.goalmouth_x != null ? String(item.goalmouth_x) : '',
    goalmouth_y: item.goalmouth_y != null ? String(item.goalmouth_y) : '',
    is_header: Boolean(item.is_header),
    is_weak_foot: Boolean(item.is_weak_foot),
    under_pressure: Boolean(item.under_pressure),
    one_on_one: Boolean(item.one_on_one),
    shot_pace_band: item.shot_pace_band || 'MID',
  };
}

function pointFromShotForm(shotX: string, shotY: string) {
  const x = Number(shotX);
  const y = Number(shotY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Number((x - HALF_PITCH_LENGTH - XG_VISIBLE_OFFSET).toFixed(2)),
    y: Number(y.toFixed(2)),
  };
}

function pointFromGoalmouthForm(goalmouthX: string, goalmouthY: string) {
  const x = Number(goalmouthX);
  const y = Number(goalmouthY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Number(x.toFixed(3)),
    y: Number(y.toFixed(3)),
  };
}

export default function MatchEventEditorPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [dominanceBins, setDominanceBins] = useState<DominanceBin[]>([]);
  const [dominanceMeta, setDominanceMeta] = useState<DominanceResponse | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [matchNameDraft, setMatchNameDraft] = useState('');
  const [matchNameSaving, setMatchNameSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<'ALL' | 'ATTACK_LANE' | 'XG' | 'HALFTIME_START'>('ALL');
  const [filterTeam, setFilterTeam] = useState<'ALL' | 'HOME' | 'AWAY'>('ALL');
  const [form, setForm] = useState<EditorForm>(EMPTY_FORM);
  const [shotPoint, setShotPoint] = useState<{ x: number; y: number } | null>(null);
  const [goalmouthPoint, setGoalmouthPoint] = useState<{ x: number; y: number } | null>(null);
  const [xgotValue, setXgotValue] = useState('0.000');
  const [xgEstimateMeta, setXgEstimateMeta] = useState('');
  const [xgotEstimateMeta, setXgotEstimateMeta] = useState('');
  const [clockHint, setClockHint] = useState('');
  const [shotPaceMenuOpen, setShotPaceMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'EVENTS' | 'DOMINANCE'>('EVENTS');

  const selectedItem = useMemo(
    () => items.find((item) => item.item_id === selectedId) || null,
    [items, selectedId]
  );

  const canEdit = sessionUser?.role === 'SUPERADMIN' && Boolean(match?.archived);

  const dominanceChartData = useMemo(
    () => {
      const lastIndex = dominanceBins.length - 1;
      return dominanceBins.map((bin, index) => ({
        ...bin,
        minuteVal:
          index === lastIndex && Number((bin.chart_end_ms ?? bin.end_ms) || 0) > Number((bin.chart_start_ms ?? bin.start_ms) || 0)
            ? Number((bin.chart_end_ms ?? bin.end_ms) || 0) / 60000
            : Number((bin.chart_start_ms ?? bin.start_ms) || 0) / 60000,
        endMinuteVal: Number((bin.chart_end_ms ?? bin.end_ms) || 0) / 60000,
        midpointMinuteVal: Number((bin.chart_midpoint_ms ?? ((bin.start_ms + bin.end_ms) / 2)) || 0) / 60000,
        dominanceValue: Number(bin.dominance || 0),
      }));
    },
    [dominanceBins]
  );
  const dominanceSeriesData = useMemo(() => {
    const points: Array<{
      minuteVal: number;
      dominanceValue: number;
      positiveDominance: number | null;
      negativeDominance: number | null;
    }> = [];
    dominanceChartData.forEach((point, index) => {
      if (index > 0) {
        const prev = dominanceChartData[index - 1];
        if ((prev.dominanceValue < 0 && point.dominanceValue > 0) || (prev.dominanceValue > 0 && point.dominanceValue < 0)) {
          const ratio = (0 - prev.dominanceValue) / (point.dominanceValue - prev.dominanceValue);
          const crossMinuteVal = prev.minuteVal + (point.minuteVal - prev.minuteVal) * ratio;
          points.push({
            minuteVal: crossMinuteVal,
            dominanceValue: 0,
            positiveDominance: 0,
            negativeDominance: 0,
          });
        }
      }
      points.push({
        minuteVal: point.minuteVal,
        dominanceValue: point.dominanceValue,
        positiveDominance: point.dominanceValue > 0 ? point.dominanceValue : point.dominanceValue === 0 ? 0 : null,
        negativeDominance: point.dominanceValue < 0 ? point.dominanceValue : point.dominanceValue === 0 ? 0 : null,
      });
    });
    return points;
  }, [dominanceChartData]);

  const dominanceXAxisTicks = useMemo(
    () => {
      const ticks = dominanceChartData.map((bin) => bin.minuteVal);
      if (!dominanceMeta?.split_halves) return ticks;
      const halfGapMs = Number(dominanceMeta.half_gap_ms || 0);
      const firstHalfDurationMs = Number((dominanceMeta.halves || []).find((half) => half.period === 1)?.duration_ms || 0);
      const secondHalfDurationMs = Number((dominanceMeta.halves || []).find((half) => half.period === 2)?.duration_ms || 0);
      if (firstHalfDurationMs > 0) ticks.push(firstHalfDurationMs / 60000);
      if (secondHalfDurationMs > 0) {
        ticks.push((firstHalfDurationMs + halfGapMs + secondHalfDurationMs) / 60000);
      }
      return Array.from(new Set(ticks)).sort((a, b) => a - b);
    },
    [dominanceChartData, dominanceMeta]
  );

  const fmtMinuteTick = (minuteVal: number) => {
    const ms = Math.round(Number(minuteVal) * 60000);
    const baseHalfMinutes = regulationHalfMinutes(match?.competition_class, match?.first_half_minutes);
    const baseHalfMs = baseHalfMinutes * 60000;
    if (dominanceMeta?.split_halves) {
      const halfGapMs = Number(dominanceMeta.half_gap_ms || 0);
      const firstHalfDurationMs = Number((dominanceMeta.halves || []).find((half) => half.period === 1)?.duration_ms || 0);
      const secondHalfDurationMs = Number((dominanceMeta.halves || []).find((half) => half.period === 2)?.duration_ms || 0);
      if (firstHalfDurationMs > 0 && ms === firstHalfDurationMs) {
        const extraMinutes = Math.round((firstHalfDurationMs - baseHalfMs) / 60000);
        return extraMinutes > 0 ? `${baseHalfMinutes}+${extraMinutes}` : String(baseHalfMinutes);
      }
      if (ms >= firstHalfDurationMs + halfGapMs) {
        const secondHalfMs = ms - firstHalfDurationMs - halfGapMs;
        if (secondHalfDurationMs > 0 && secondHalfMs === secondHalfDurationMs) {
          const extraMinutes = Math.round((secondHalfDurationMs - baseHalfMs) / 60000);
          return extraMinutes > 0 ? `${baseHalfMinutes}+${extraMinutes}` : String(baseHalfMinutes);
        }
        return String(Math.floor(secondHalfMs / 60000));
      }
      return String(Math.floor(ms / 60000));
    }
    return String(Math.floor(ms / 60000));
  };

  const getShotCoordinates = () => {
    if (!shotPoint) return null;
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

  const load = async () => {
    const [user, matchData] = await Promise.all([
      apiJson<SessionUser>('/session/me'),
      apiJson<MatchInfo>(`/matches/${id}`),
    ]);
    setSessionUser(user);
    setMatch(matchData);
    setMatchNameDraft(matchData.name || '');
    if (user.role !== 'SUPERADMIN' || !matchData.archived) {
      setItems([]);
      setDominanceBins([]);
      setDominanceMeta(null);
      setTotal(0);
      return;
    }

    const query = new URLSearchParams();
    if (filterType !== 'ALL') query.set('type', filterType);
    if (filterTeam !== 'ALL') query.set('team', filterTeam);
    const [timelineData, dominanceData] = await Promise.all([
      apiJson<TimelineResponse>(`/admin/matches/${id}/timeline-items${query.size ? `?${query.toString()}` : ''}`),
      apiJson<DominanceResponse>(`/matches/${id}/dominance?bin_seconds=180&split_halves=true`),
    ]);
    setItems(timelineData.items || []);
    setTotal(timelineData.total || 0);
    setDominanceBins(dominanceData.bins || []);
    setDominanceMeta(dominanceData);
  };

  useEffect(() => {
    load()
      .then(() => setError(''))
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load event editor');
      });
  }, [id, filterType, filterTeam]);

  useEffect(() => {
    if (selectedItem) {
      setForm(formFromItem(selectedItem));
      setXgotValue(selectedItem.type === 'XG' && selectedItem.xgot != null ? Number(selectedItem.xgot).toFixed(3) : '0.000');
      setXgEstimateMeta('');
      setXgotEstimateMeta('');
      setClockHint('');
    }
  }, [selectedItem]);

  useEffect(() => {
    if (selectedItem?.type === 'XG') {
      setShotPoint(pointFromShotForm(String(selectedItem.shot_x ?? ''), String(selectedItem.shot_y ?? '')));
      setGoalmouthPoint(pointFromGoalmouthForm(String(selectedItem.goalmouth_x ?? ''), String(selectedItem.goalmouth_y ?? '')));
      return;
    }
    if (!selectedItem) {
      setShotPoint(null);
      setGoalmouthPoint(null);
      setXgotValue('0.000');
    }
  }, [selectedItem]);

  useEffect(() => {
    if (form.is_goal && !form.is_on_target) {
      setForm((prev) => ({ ...prev, is_on_target: true }));
    }
  }, [form.is_goal, form.is_on_target]);

  useEffect(() => {
    if (!form.is_on_target) {
      setGoalmouthPoint(null);
      setShotPaceMenuOpen(false);
      setForm((prev) => ({ ...prev, goalmouth_x: '', goalmouth_y: '' }));
      setXgotValue('0.000');
      setXgotEstimateMeta('');
    }
  }, [form.is_on_target]);

  const startCreate = (type: EditorForm['type']) => {
    let nextClockMs = 0;
    let nextClockHint = '';
    const selectedIndex = selectedId ? items.findIndex((item) => item.item_id === selectedId) : -1;
    if (selectedIndex >= 0) {
      const currentItem = items[selectedIndex];
      const nextItem = items[selectedIndex + 1] || null;
      if (nextItem) {
        nextClockMs = snapToSecond((currentItem.clock_ms + nextItem.clock_ms) / 2);
        nextClockHint = `선택 행 기준 ${fmtClock(currentItem.clock_ms)} 와 ${fmtClock(nextItem.clock_ms)} 사이 중앙값으로 설정`;
      } else {
        nextClockMs = snapToSecond(currentItem.clock_ms);
        nextClockHint = `다음 행이 없어 선택 행 시간 ${fmtClock(currentItem.clock_ms)} 기준으로 설정`;
      }
    }
    setSelectedId(null);
    setShotPoint(null);
    setGoalmouthPoint(null);
    setXgotValue('0.000');
    setXgEstimateMeta('');
    setXgotEstimateMeta('');
    setClockHint(nextClockHint);
    setShotPaceMenuOpen(false);
    setForm({
      ...EMPTY_FORM,
      kind: type === 'HALFTIME_START' ? 'MARKER' : 'EVENT',
      type,
      clock_ms: fmtClock(nextClockMs),
    });
  };

  const onPitchClick = (e: { currentTarget: HTMLDivElement; clientX: number; clientY: number }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const y = (px / rect.width) * PITCH_WIDTH;
    const x = (1 - py / rect.height) * XG_VISIBLE_LENGTH;
    const nextPoint = { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
    setShotPoint(nextPoint);
    setXgEstimateMeta('');
    setForm((prev) => ({
      ...prev,
      shot_x: String(Number((HALF_PITCH_LENGTH + XG_VISIBLE_OFFSET + nextPoint.x).toFixed(2))),
      shot_y: String(nextPoint.y),
    }));
  };

  const onGoalmouthClick = (e: { currentTarget: HTMLDivElement; clientX: number; clientY: number }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const x = Math.max(0, Math.min(1, px / rect.width));
    const y = Math.max(0, Math.min(1, 1 - py / rect.height));
    const nextPoint = { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) };
    setGoalmouthPoint(nextPoint);
    setXgotEstimateMeta('');
    setForm((prev) => ({
      ...prev,
      goalmouth_x: String(nextPoint.x),
      goalmouth_y: String(nextPoint.y),
    }));
  };

  const buildPayload = () => ({
    kind: form.kind,
    type: form.type,
    clock_ms: parseClockInput(form.clock_ms),
    team: form.kind === 'EVENT' ? form.team : null,
    lane: form.type === 'ATTACK_LANE' ? form.lane : null,
    xg: form.type === 'XG' ? Number(form.xg || 0) : null,
    is_goal: form.type === 'XG' ? form.is_goal : false,
    is_on_target: form.type === 'XG' ? form.is_on_target : false,
    shot_x: form.type === 'XG' ? toInputNumber(form.shot_x) : null,
    shot_y: form.type === 'XG' ? toInputNumber(form.shot_y) : null,
    goalmouth_x: form.type === 'XG' ? toInputNumber(form.goalmouth_x) : null,
    goalmouth_y: form.type === 'XG' ? toInputNumber(form.goalmouth_y) : null,
    is_header: form.type === 'XG' ? form.is_header : false,
    is_weak_foot: form.type === 'XG' ? form.is_weak_foot : false,
    under_pressure: form.type === 'XG' ? form.under_pressure : false,
    one_on_one: form.type === 'XG' ? form.one_on_one : false,
    shot_pace_band: form.type === 'XG' ? form.shot_pace_band : 'MID',
  });

  const estimateXgFromPitch = async () => {
    const shotCoordinates = getShotCoordinates();
    if (!shotPoint || !shotCoordinates) {
      setXgEstimateMeta('Click on the pitch first');
      return;
    }
    const res = await apiFetch('/xg/estimate', {
      method: 'POST',
      body: JSON.stringify({
        team: 'HOME',
        attack_lr: 'L2R',
        start_x: shotCoordinates.shot_x,
        start_y: shotCoordinates.shot_y,
        is_header: form.is_header,
        is_weak_foot: form.is_weak_foot,
      }),
    });
    if (!res.ok) {
      setXgEstimateMeta(`Estimate failed (${res.status})`);
      return;
    }
    const data = await res.json();
    setForm((prev) => ({ ...prev, xg: String(data.xg) }));
    setXgEstimateMeta(`xG=${data.xg} | dist=${data.distance}m | ${data.is_in_box ? 'in-box' : 'out-box'}`);
  };

  const estimateXgotFromGoalmouth = async () => {
    const xg = Number(form.xg);
    const goalmouthCoordinates = getGoalmouthCoordinates();
    if (!Number.isFinite(xg) || xg < 0) {
      setXgotEstimateMeta('Enter a valid xG first');
      return;
    }
    if (!form.is_on_target) {
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
        is_on_target: form.is_on_target,
        goalmouth_x: goalmouthCoordinates.goalmouth_x,
        goalmouth_y: goalmouthCoordinates.goalmouth_y,
        is_goal: form.is_goal,
        is_header: form.is_header,
        is_weak_foot: form.is_weak_foot,
        under_pressure: form.under_pressure,
        one_on_one: form.one_on_one,
        shot_pace_band: form.shot_pace_band,
      }),
    });
    if (!res.ok) {
      setXgotEstimateMeta(`Estimate failed (${res.status})`);
      return;
    }
    const data = await res.json();
    setXgotValue(Number(data.xgot).toFixed(3));
    setXgotEstimateMeta(`xGOT=${data.xgot} | delta=${data.delta >= 0 ? '+' : ''}${data.delta} | ${data.label}`);
  };

  const save = async () => {
    if (!canEdit || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const payload = buildPayload();
      const response = selectedItem
        ? await apiFetch(`/admin/matches/${id}/timeline-items/${selectedItem.kind}/${selectedItem.item_id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await apiFetch(`/admin/matches/${id}/timeline-items`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
      if (!response.ok) {
        setError((await response.text()) || 'Save failed');
        return;
      }
      await load();
      setClockHint('');
      setMessage(selectedItem ? 'Item updated' : 'Item created');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const saveMatchName = async () => {
    if (!canEdit || matchNameSaving) return;
    const nextName = matchNameDraft.trim();
    if (!nextName) {
      setError('Match name is required');
      return;
    }
    setMatchNameSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await apiFetch(`/admin/matches/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName }),
      });
      if (!response.ok) {
        setError((await response.text()) || 'Match name update failed');
        return;
      }
      const nextMatch = await response.json() as MatchInfo;
      setMatch(nextMatch);
      setMatchNameDraft(nextMatch.name || nextName);
      setMessage('Match name updated');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Match name update failed');
    } finally {
      setMatchNameSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedItem || !canEdit || busy) return;
    if (!window.confirm('이 항목을 삭제할까요?')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await apiFetch(`/admin/matches/${id}/timeline-items/${selectedItem.kind}/${selectedItem.item_id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        setError((await response.text()) || 'Delete failed');
        return;
      }
      setSelectedId(null);
      setForm(EMPTY_FORM);
      setClockHint('');
      setShotPaceMenuOpen(false);
      await load();
      setMessage('Item deleted');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page-stack">
      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Archived Match Editor</div>
            <h2 style={{ margin: 0 }}>Event Editor</h2>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Link className="button-link button-compact btn-secondary" href={`/admin/match/${id}`}>
              Back To Match
            </Link>
          </div>
        </div>
        <div className="muted">
          {match?.name || 'Loading match...'} {match?.archived_at ? `· archived ${new Date(match.archived_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}` : ''}
        </div>
        <div className="archived-match-title-editor">
          <label className="grid" style={{ gap: 4 }}>
            <span className="muted">Match Title</span>
            <input
              disabled={!canEdit || matchNameSaving}
              onChange={(event) => setMatchNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveMatchName();
                }
              }}
              placeholder="[K3 | 1R] HOME vs AWAY"
              value={matchNameDraft}
            />
          </label>
          <button
            className="btn-primary"
            disabled={!canEdit || matchNameSaving || matchNameDraft.trim() === (match?.name || '').trim()}
            onClick={saveMatchName}
            type="button"
          >
            {matchNameSaving ? 'Saving' : 'Save Title'}
          </button>
        </div>
        {!canEdit && !error ? (
          <div className="form-error">Archived matches can be edited by admin only.</div>
        ) : null}
        {error ? <div className="form-error">{error}</div> : null}
        {message ? <div className="muted">{message}</div> : null}
      </section>

      <section className="card card-utility grid">
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginRight: 8 }}>
            <button className={activeTab === 'EVENTS' ? 'btn-active' : 'btn-secondary'} onClick={() => setActiveTab('EVENTS')}>
              Events
            </button>
            <button className={activeTab === 'DOMINANCE' ? 'btn-active' : 'btn-secondary'} onClick={() => setActiveTab('DOMINANCE')}>
              Dominance
            </button>
          </div>
          <label className="grid" style={{ gap: 4 }}>
            <span className="muted">Type</span>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value as typeof filterType)}>
              <option value="ALL">All</option>
              <option value="ATTACK_LANE">Lane</option>
              <option value="XG">xG</option>
              <option value="HALFTIME_START">Marker</option>
            </select>
          </label>
          <label className="grid" style={{ gap: 4 }}>
            <span className="muted">Team</span>
            <select value={filterTeam} onChange={(e) => setFilterTeam(e.target.value as typeof filterTeam)}>
              <option value="ALL">All</option>
              <option value="HOME">HOME</option>
              <option value="AWAY">AWAY</option>
            </select>
          </label>
          <div className="row" style={{ gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={() => startCreate('ATTACK_LANE')} disabled={!canEdit || busy}>Add Lane</button>
            <button className="btn-primary" onClick={() => startCreate('XG')} disabled={!canEdit || busy}>Add xG</button>
            <button className="btn-primary" onClick={() => startCreate('HALFTIME_START')} disabled={!canEdit || busy}>Add Marker</button>
          </div>
          <div className="muted" style={{ marginLeft: 'auto' }}>Total: {total}</div>
        </div>
      </section>

      {activeTab === 'EVENTS' ? (
      <section className="grid" style={{ gap: 16, gridTemplateColumns: 'minmax(0, 1.6fr) minmax(340px, 0.9fr)', alignItems: 'stretch' }}>
        <div className="card card-panel grid" style={{ gap: 12, minHeight: '72vh', alignContent: 'start' }}>
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Timeline</div>
              <h3 style={{ margin: 0 }}>Event Table</h3>
            </div>
          </div>
          <div style={{ maxHeight: '72vh', overflow: 'auto', border: '1px solid var(--border-soft)', borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '10px 8px' }}>Clock</th>
                <th style={{ textAlign: 'left', padding: '10px 8px' }}>Type</th>
                <th style={{ textAlign: 'left', padding: '10px 8px' }}>Team</th>
                <th style={{ textAlign: 'left', padding: '10px 8px' }}>Value</th>
                <th style={{ textAlign: 'left', padding: '10px 8px' }}>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={`${item.kind}-${item.item_id}`}
                  onClick={() => setSelectedId(item.item_id)}
                  style={{
                    cursor: 'pointer',
                    background: selectedId === item.item_id ? 'rgba(255,255,255,0.05)' : 'transparent',
                    borderTop: '1px solid var(--border-soft)',
                  }}
                >
                  <td style={{ padding: '10px 8px' }}>{fmtClock(item.clock_ms)}</td>
                  <td style={{ padding: '10px 8px' }}>{item.type}</td>
                  <td style={{ padding: '10px 8px' }}>{item.team || '-'}</td>
                  <td style={{ padding: '10px 8px' }}>
                    {item.type === 'ATTACK_LANE'
                      ? item.lane
                      : item.type === 'XG'
                        ? `xG ${item.xg ?? '-'} / xGOT ${item.xgot ?? '-'}`
                        : 'HALFTIME_START'}
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    {new Date(item.created_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: '16px 8px' }} className="muted">No timeline items for this filter.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </div>
        </div>

        <div
          className="card card-utility grid"
          style={{ gap: 12, position: 'sticky', top: 24, alignSelf: 'start', minHeight: '72vh', alignContent: 'start' }}
        >
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">{selectedItem ? 'Edit Item' : 'Create Item'}</div>
              <h3 style={{ margin: 0 }}>{selectedItem ? `${selectedItem.type} Editor` : 'New Timeline Item'}</h3>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: form.kind === 'EVENT' ? 'minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 0.8fr)' : 'minmax(0, 1fr) minmax(0, 1fr)',
              gap: 8,
              alignItems: 'end',
            }}
          >
            <label className="grid" style={{ gap: 4, minWidth: 0 }}>
              <span className="muted">Type</span>
              <select
                value={form.type}
                onChange={(e) => {
                  const nextType = e.target.value as EditorForm['type'];
                  setForm((prev) => ({ ...prev, kind: nextType === 'HALFTIME_START' ? 'MARKER' : 'EVENT', type: nextType }));
                }}
                disabled={Boolean(selectedItem)}
                style={{ width: '100%', minWidth: 0 }}
              >
                <option value="ATTACK_LANE">ATTACK_LANE</option>
                <option value="XG">XG</option>
                <option value="HALFTIME_START">HALFTIME_START</option>
              </select>
            </label>

            <label className="grid" style={{ gap: 4, minWidth: 0 }}>
              <span className="muted">Clock (mm:ss)</span>
              <div className="row" style={{ gap: 6, minWidth: 0 }}>
                <input
                  value={form.clock_ms}
                  onChange={(e) => setForm((prev) => ({ ...prev, clock_ms: e.target.value }))}
                  style={{ width: '100%', minWidth: 0, maxWidth: 88 }}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setForm((prev) => ({ ...prev, clock_ms: shiftClockInput(prev.clock_ms, -1) }))}
                  disabled={!canEdit || busy}
                  style={{ paddingInline: 8, minWidth: 0, whiteSpace: 'nowrap' }}
                >
                  -1
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setForm((prev) => ({ ...prev, clock_ms: shiftClockInput(prev.clock_ms, 1) }))}
                  disabled={!canEdit || busy}
                  style={{ paddingInline: 8, minWidth: 0, whiteSpace: 'nowrap' }}
                >
                  +1
                </button>
              </div>
            </label>

            {form.kind === 'EVENT' ? (
              <label className="grid" style={{ gap: 4, minWidth: 0 }}>
                <span className="muted">Team</span>
                <select value={form.team} onChange={(e) => setForm((prev) => ({ ...prev, team: e.target.value as Team }))} style={{ width: '100%', minWidth: 0 }}>
                  <option value="HOME">HOME</option>
                  <option value="AWAY">AWAY</option>
                </select>
              </label>
            ) : null}
          </div>

          {form.kind === 'EVENT' ? (
            <>
              {clockHint ? <div className="muted">{clockHint}</div> : null}

              {form.type === 'ATTACK_LANE' ? (
                <div className="grid" style={{ gap: 10 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                    <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <h4 style={{ margin: 0 }}>Attack Lane</h4>
                      <span className="muted">selected={form.lane}</span>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className={form.lane === 'LEFT' ? 'btn-active' : ''}
                      onClick={() => setForm((prev) => ({ ...prev, lane: 'LEFT' }))}
                      disabled={!canEdit || busy}
                    >
                      LEFT
                    </button>
                    <button
                      className={form.lane === 'CENTER' ? 'btn-active' : ''}
                      onClick={() => setForm((prev) => ({ ...prev, lane: 'CENTER' }))}
                      disabled={!canEdit || busy}
                    >
                      CENTER
                    </button>
                    <button
                      className={form.lane === 'RIGHT' ? 'btn-active' : ''}
                      onClick={() => setForm((prev) => ({ ...prev, lane: 'RIGHT' }))}
                      disabled={!canEdit || busy}
                    >
                      RIGHT
                    </button>
                  </div>
                </div>
              ) : null}

              {form.type === 'XG' ? (
                <>
                  <div className="grid" style={{ gap: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '78px minmax(0, 1fr) auto', gap: 10, alignItems: 'center' }}>
                      <span style={{ width: 78, fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>xG</span>
                      <input
                        value={form.xg}
                        onChange={(e) => setForm((prev) => ({ ...prev, xg: e.target.value }))}
                        placeholder="xG"
                        style={{ width: '100%', minWidth: 0, maxWidth: 420 }}
                      />
                      <button
                        className="btn-secondary"
                        onClick={estimateXgFromPitch}
                        disabled={!canEdit || busy}
                        style={{ width: 232, justifyContent: 'center' }}
                      >
                        Estimate xG
                      </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '78px minmax(0, 1fr) auto', gap: 10, alignItems: 'center' }}>
                      <span style={{ width: 78, fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>xGOT</span>
                      <input
                        value={xgotValue}
                        readOnly
                        placeholder="xGOT"
                        style={{ width: '100%', minWidth: 0, maxWidth: 420, opacity: 0.95 }}
                      />
                      <button
                        className="btn-secondary"
                        onClick={estimateXgotFromGoalmouth}
                        disabled={!canEdit || busy}
                        style={{ width: 232, justifyContent: 'center' }}
                      >
                        Estimate xGOT
                      </button>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button className={form.is_goal ? 'btn-active' : ''} onClick={() => setForm((prev) => ({ ...prev, is_goal: !prev.is_goal }))}>Goal</button>
                    <button className={form.is_on_target ? 'btn-active' : ''} onClick={() => setForm((prev) => ({ ...prev, is_on_target: !prev.is_on_target }))}>On Target</button>
                    <button className={form.is_header ? 'btn-active' : ''} onClick={() => setForm((prev) => ({ ...prev, is_header: !prev.is_header }))}>Header</button>
                    <button className={form.is_weak_foot ? 'btn-active' : ''} onClick={() => setForm((prev) => ({ ...prev, is_weak_foot: !prev.is_weak_foot }))}>Difficult</button>
                  </div>
                  <div
                    style={{
                      position: 'relative',
                      width: '100%',
                      maxWidth: 520,
                      justifySelf: 'center',
                      marginTop: form.is_on_target ? 132 : 4,
                    }}
                  >
                    {form.is_on_target ? (
                      <div
                        style={{
                          position: 'absolute',
                          left: '50%',
                          top: -128,
                          transform: 'translateX(-50%)',
                          width: 520,
                          maxWidth: 'min(520px, 96vw)',
                          zIndex: 2,
                        }}
                      >
                        <div style={{ position: 'relative', width: '100%', minHeight: 108 }}>
                          <div
                            className="grid"
                            style={{
                              gap: 6,
                              alignContent: 'end',
                              position: 'absolute',
                              left: 42,
                              bottom: 0,
                              width: 56,
                            }}
                          >
                            <span className="muted" style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.05 }}>
                              Shot
                              <br />
                              Speed
                            </span>
                            <div style={{ position: 'relative' }}>
                              <button
                                type="button"
                                className={shotPaceMenuOpen ? 'btn-active' : 'btn-secondary'}
                                onClick={() => setShotPaceMenuOpen((prev) => !prev)}
                                disabled={!canEdit || busy}
                                title={SHOT_PACE_LONG_LABEL[form.shot_pace_band]}
                                aria-label={SHOT_PACE_LONG_LABEL[form.shot_pace_band]}
                                style={{ minWidth: 0, width: 40, paddingInline: 0 }}
                              >
                                {SHOT_PACE_LABEL[form.shot_pace_band]}
                              </button>
                              {shotPaceMenuOpen ? (
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: 0,
                                    top: 'calc(100% + 6px)',
                                    display: 'grid',
                                    gap: 4,
                                    minWidth: 92,
                                    padding: 6,
                                    borderRadius: 10,
                                    background: 'rgba(47, 50, 56, 0.98)',
                                    border: '1px solid var(--border-soft)',
                                    boxShadow: 'var(--shadow-floating)',
                                    zIndex: 6,
                                  }}
                                >
                                  {(['HIGH', 'MID', 'LOW'] as ShotPaceBand[]).map((pace) => (
                                    <button
                                      key={pace}
                                      type="button"
                                      className={form.shot_pace_band === pace ? 'btn-active' : 'btn-secondary'}
                                      onClick={() => {
                                        setForm((prev) => ({ ...prev, shot_pace_band: pace }));
                                        setShotPaceMenuOpen(false);
                                      }}
                                      disabled={!canEdit || busy}
                                      style={{ justifyContent: 'flex-start', paddingInline: 10 }}
                                    >
                                      {SHOT_PACE_LONG_LABEL[pace]}
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </div>
                          <div
                            onClick={onGoalmouthClick}
                            style={{
                              position: 'relative',
                              width: 300,
                              maxWidth: 'min(300px, 58vw)',
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
                              <div style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, borderLeft: '1px dashed rgba(255,255,255,0.42)' }} />
                              <div style={{ position: 'absolute', left: '66.66%', top: 0, bottom: 0, borderLeft: '1px dashed rgba(255,255,255,0.42)' }} />
                              <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', borderTop: '1px dashed rgba(255,255,255,0.42)' }} />
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
                        background: 'repeating-linear-gradient(0deg, #3f7f3f 0 10%, #3a733a 10% 20%)',
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
                      <div style={{ position: 'absolute', left: 8, top: 6, color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: 600 }}>Goal Side</div>
                      <div style={{ position: 'absolute', right: 8, top: 6, color: 'rgba(255,255,255,0.7)', fontSize: 10 }}>
                        {form.is_on_target ? 'Goalmouth zoom active' : 'Turn on On Target to place shot'}
                      </div>
                      <div style={{ position: 'absolute', left: 8, bottom: 6, color: 'rgba(255,255,255,0.75)', fontSize: 10 }}>68m x 40m (rotated)</div>
                    </div>
                  </div>
                  <div className="muted">
                    {shotPoint ? `shot=(${shotPoint.x}, ${shotPoint.y})` : 'Click pitch to set shot location'}
                  </div>
                  <div className="muted">Half-pitch clicks are evaluated in attacking-half coordinates so the same UI works for both teams.</div>
                  {xgEstimateMeta ? <div className="muted">{xgEstimateMeta}</div> : null}
                  {xgotEstimateMeta ? <div className="muted">{xgotEstimateMeta}</div> : null}
                </>
              ) : null}
            </>
          ) : (
            <div className="muted">Marker items currently support `HALFTIME_START` only.</div>
          )}

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={save} disabled={!canEdit || busy}>
              {selectedItem ? 'Save Changes' : 'Create Item'}
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                setSelectedId(null);
                setShotPoint(null);
                setGoalmouthPoint(null);
                setXgotValue('0.000');
                setXgEstimateMeta('');
                setXgotEstimateMeta('');
                setClockHint('');
                setForm(EMPTY_FORM);
              }}
              disabled={busy}
            >
              Reset Form
            </button>
            {selectedItem ? (
              <button className="btn-danger" onClick={remove} disabled={!canEdit || busy}>
                Delete
              </button>
            ) : null}
          </div>
        </div>
      </section>
      ) : (
      <section className="grid" style={{ gap: 16 }}>
        <div className="card card-panel grid" style={{ gap: 12, alignContent: 'start' }}>
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Match Dominance</div>
              <h3 style={{ margin: 0 }}>Dominance Timeline</h3>
            </div>
          </div>
          <div style={{ width: '100%', height: 340 }}>
            <ResponsiveContainer>
              <ComposedChart data={dominanceChartData} margin={{ top: 28, right: 18, left: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="dominanceFillEditor" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#f97316" stopOpacity={0.42} />
                    <stop offset="100%" stopColor="#f97316" stopOpacity={0.18} />
                  </linearGradient>
                  <linearGradient id="dominanceFillEditorAway" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#2563eb" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#2563eb" stopOpacity={0.42} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.12)" />
                <XAxis
                  type="number"
                  dataKey="minuteVal"
                  ticks={dominanceXAxisTicks}
                  tickFormatter={fmtMinuteTick}
                  domain={['dataMin', 'dataMax']}
                />
                <YAxis domain={[-1.2, 1.2]} ticks={[-1, -0.5, 0, 0.5, 1]} />
                <Tooltip
                  formatter={(value: number) => Number(value).toFixed(3)}
                  labelFormatter={(value) => `Minute ${fmtMinuteTick(Number(value))}`}
                />
                {dominanceMeta?.split_halves && dominanceMeta?.ht_chart_ms != null ? (
                  <ReferenceLine
                    x={Number(dominanceMeta.ht_chart_ms) / 60000}
                    stroke="#fbbf24"
                    strokeDasharray="6 4"
                    label={{ value: 'HT', position: 'top', fill: '#fbbf24', fontSize: 12 }}
                  />
                ) : null}
                {dominanceChartData.map((bin) => {
                  const goalSummary = bin.annotations?.goal_summary;
                  const hasGoal = Boolean(goalSummary?.total);
                  const hasHt = !dominanceMeta?.split_halves && Boolean(bin.annotations?.markers?.includes('HT'));
                  const homeGoalLabel = goalSummary?.home ? `⚽ HOME${goalSummary.home > 1 ? ` x${goalSummary.home}` : ''}` : '';
                  const awayGoalLabel = goalSummary?.away ? `⚽ AWAY${goalSummary.away > 1 ? ` x${goalSummary.away}` : ''}` : '';
                  const homeGoalX = bin.minuteVal - (goalSummary?.home && goalSummary?.away ? 0.08 : 0);
                  const awayGoalX = bin.minuteVal + (goalSummary?.home && goalSummary?.away ? 0.08 : 0);
                  return (
                    <Fragment key={`annotations-${bin.k}`}>
                      {hasHt ? (
                        <ReferenceLine
                          x={bin.midpointMinuteVal}
                          stroke="#fbbf24"
                          strokeDasharray="6 4"
                          label={{ value: 'HT', position: 'top', fill: '#fbbf24', fontSize: 12 }}
                        />
                      ) : null}
                      {hasGoal ? (
                        <>
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
                        </>
                      ) : null}
                    </Fragment>
                  );
                })}
                <Area type="monotone" data={dominanceSeriesData} dataKey="positiveDominance" baseValue={0} stroke="none" fill="url(#dominanceFillEditor)" connectNulls />
                <Area type="monotone" data={dominanceSeriesData} dataKey="negativeDominance" baseValue={0} stroke="none" fill="url(#dominanceFillEditorAway)" connectNulls />
                <Line type="monotone" data={dominanceSeriesData} dataKey="positiveDominance" stroke="#f97316" strokeWidth={3} dot={false} connectNulls />
                <Line type="monotone" data={dominanceSeriesData} dataKey="negativeDominance" stroke="#2563eb" strokeWidth={3} dot={false} connectNulls />
                <ReferenceLine y={0} stroke="#ffffff" strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="muted">Goal bins are marked with a ball icon. HT bins are marked with a full-height divider.</div>
        </div>

        <div className="card card-utility grid" style={{ gap: 12, alignContent: 'start' }}>
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Bin Breakdown</div>
              <h3 style={{ margin: 0 }}>3-Minute Bins</h3>
            </div>
          </div>
          <div style={{ overflow: 'auto', border: '1px solid var(--border-soft)', borderRadius: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '10px 8px' }}>Bin</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px' }}>Poss</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px' }}>xG</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px' }}>Attack</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px' }}>Dominance</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px' }}>Meta</th>
                </tr>
              </thead>
              <tbody>
                {dominanceBins.map((bin) => (
                  <tr key={bin.k} style={{ borderTop: '1px solid var(--border-soft)' }}>
                    <td style={{ padding: '10px 8px' }}>{fmtClock(bin.start_ms)} - {fmtClock(bin.end_ms)}</td>
                    <td style={{ padding: '10px 8px' }}>{Math.round(bin.home_poss_ms / 1000)}s / {Math.round(bin.away_poss_ms / 1000)}s</td>
                    <td style={{ padding: '10px 8px' }}>{bin.home_xg.toFixed(2)} / {bin.away_xg.toFixed(2)}</td>
                    <td style={{ padding: '10px 8px' }}>{bin.home_attack_score.toFixed(1)} / {bin.away_attack_score.toFixed(1)}</td>
                    <td style={{ padding: '10px 8px' }}>{bin.dominance.toFixed(3)}</td>
                    <td style={{ padding: '10px 8px' }}>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {bin.annotations?.goal_summary?.home ? <span className="status-pill">⚽ HOME{bin.annotations.goal_summary.home > 1 ? ` x${bin.annotations.goal_summary.home}` : ''}</span> : null}
                        {bin.annotations?.goal_summary?.away ? <span className="status-pill">⚽ AWAY{bin.annotations.goal_summary.away > 1 ? ` x${bin.annotations.goal_summary.away}` : ''}</span> : null}
                        {bin.annotations?.markers?.includes('HT') ? <span className="status-pill archived">HT</span> : null}
                        {!bin.annotations?.goal_summary?.total && !bin.annotations?.markers?.length ? <span className="muted">-</span> : null}
                      </div>
                    </td>
                  </tr>
                ))}
                {dominanceBins.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: '16px 8px' }} className="muted">No dominance bins yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      )}
    </main>
  );
}
