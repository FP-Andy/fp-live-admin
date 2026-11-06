'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { API_BASE, apiFetch, apiJson } from '../lib/api';
import ErrorNotice, { ErrorFold } from './ErrorNotice';
import { errorFromResponse, errorMessage, responseMessage } from '../lib/error-messages';

/** 이 화면에 맞춘 서버 detail 문장(변환표보다 우선). 원문은 '자세히'에 남는다. */
const SUBMIT_OVERRIDES: Record<string, string> = {
  'FCM submissions are available for archived matches only': '보관된 경기만 제출할 수 있습니다. 운영 현황에서 경기를 먼저 보관하세요.',
  'At least one stat must be selected': '스탯을 1개 이상 고르세요.',
  'You can submit at most 5 stats': '스탯은 5개까지 고를 수 있습니다.',
};
const SUBMIT_FAILED = '제출을 저장하지 못했습니다. 다시 시도해 주세요.';
const SAVED_LOG_FAILED = '저장된 FPA 기록을 반영하지 못했습니다. 다시 시도해 주세요.';
const SAVED_LOG_OVERRIDES: Record<string, string> = {
  'No saved FPA logs for this match': '이 경기에 저장된 FPA 기록이 없습니다. FPA에서 기록을 저장하거나 엑셀 파일을 올려 주세요.',
};

type Match = {
  id: string;
  name: string;
  competition_class?: string | null;
  round_number?: number | null;
  archived: boolean;
  archived_at?: string | null;
  operator_id?: string | null;
  metadata?: {
    home_team?: string;
    away_team?: string;
  } | null;
};

type UploadState = {
  workbook: File | null;
};

type AnalyzedPlayer = {
  player_id: string;
  player_name?: string;
  team: string;
  ranking_score: number;
  candidates: string[];
  // 서버가 분석관 스탯 가이드 규칙으로 고른 기본 5줄(없으면 candidates 앞 5개).
  selected_stats?: string[];
  is_goalkeeper?: boolean;
  position?: string;
  position_source?: string;
  stat_case?: string;
  team_side?: string;
};

type AnalyzeResponse = {
  players: AnalyzedPlayer[];
  recommended_player_id: string | null;
};

type FcmSubmission = {
  id: string;
  match_id: string;
  competition_class: string;
  round_number: number;
  team_side: 'HOME' | 'AWAY';
  team_name: string;
  player_id: string;
  player_name: string;
  selected_stats: string[];
  card_type: 'PLAYER' | 'GOALKEEPER';
  penalty_shootout: ('O' | 'X')[];
  submitted_by?: string | null;
  submitted_by_name?: string | null;
  created_at: string;
  updated_at: string;
};

type TeamSide = 'HOME' | 'AWAY';
type CardType = 'PLAYER' | 'GOALKEEPER';

const POSITION_SOURCE_LABEL: Record<string, string> = {
  lineup: '경기 명단',
  fineplay_lineup: '신청 라인업',
  fpa_events: 'FPA 위치로 추정',
};

const STAT_CASE_LABEL: Record<string, string> = {
  GOAL: '골 기준',
  ASSIST: '어시스트 기준',
  POSITION: '포지션 기준',
};

const defaultStatsFor = (player?: AnalyzedPlayer | null) =>
  (player?.selected_stats?.length ? player.selected_stats : player?.candidates || []).slice(0, 5);

// FPA 로그의 Team 은 home/away 이고 옛 엑셀은 팀명이다. 서버가 맞춘 team_side 를 먼저 보고,
// 없으면 팀명·마커로 찾는다. 예전에는 팀명만 비교해서 FPA 로그 반영 때 양 팀 선수가
// 한 목록에 섞이고 상대 팀 선수가 추천되기도 했다.
const teamPoolFor = (players: AnalyzedPlayer[], side: TeamSide, teamName: string) => {
  const bySide = players.filter((player) => (player.team_side || '').toUpperCase() === side);
  if (bySide.length) return bySide;
  const byName = players.filter((player) => (player.team || '').trim() === teamName.trim());
  if (byName.length) return byName;
  const byMarker = players.filter((player) => (player.team || '').trim().toUpperCase() === side);
  return byMarker.length ? byMarker : players;
};

// 선수 한 명이 어느 팀인지. 모르면 null(옛 엑셀에서 팀명이 경기 정보와 다른 경우).
const sideOf = (player: AnalyzedPlayer, homeName: string, awayName: string): TeamSide | null => {
  const side = (player.team_side || '').toUpperCase();
  if (side === 'HOME' || side === 'AWAY') return side;
  const team = (player.team || '').trim();
  if (team && team === homeName.trim()) return 'HOME';
  if (team && team === awayName.trim()) return 'AWAY';
  if (team.toUpperCase() === 'HOME' || team.toUpperCase() === 'AWAY') return team.toUpperCase() as TeamSide;
  return null;
};

// 양 팀이 같은 등번호를 쓰므로 선택 값은 팀까지 붙인다.
const playerKey = (side: TeamSide | null, playerId: string) => `${side || 'UNKNOWN'}:${playerId}`;

// 히트맵·패스맵 미리보기 — 서버가 카드뉴스와 같은 함수·같은 데이터 파일로 그린 원본 PNG.
type PlayerMapsSource = {
  kind: 'team' | 'shared';
  origin?: 'upload' | 'fpa_log' | null;
  filename?: string | null;
  written_at?: string | null;
  file_modified_at?: string | null;
};

type PlayerMapsResponse = {
  heatmap_png: string | null;
  passmap_png: string | null;
  heatmap_points: number;
  passes: number;
  key_passes: number;
  source: PlayerMapsSource | null;
  same_number_other_team: boolean;
  card_type_hint?: CardType | null;
  render_error?: string | null;
  team_side?: TeamSide;
  team_name?: string;
  player_id?: string;
};

const MAPS_FAILED = '미리보기를 그리지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

const kstStamp = (iso?: string | null, withDate = false) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
  const day = `${part('month')}-${part('day')}`;
  return withDate ? day : `${day} ${part('hour')}:${part('minute')}`;
};

// "사용한 데이터: …" — 메타가 없으면 예전에 저장된 파일이다.
const describeMapsSource = (source: PlayerMapsSource | null) => {
  if (!source) return '';
  const scope = source.kind === 'team' ? '이 팀 파일' : '공용 파일';
  if (source.origin === 'fpa_log') return `FPA 로그 반영(${kstStamp(source.written_at)}) · ${scope}`;
  if (source.origin === 'upload') {
    const stamp = kstStamp(source.written_at, true);
    return `${source.filename || '업로드 파일'}${stamp ? `(${stamp})` : ''} · ${scope}`;
  }
  const stamp = kstStamp(source.file_modified_at);
  return `이전에 저장된 파일${stamp ? `(${stamp})` : ''} · ${scope}`;
};

// 미리보기 한 칸 — 카드의 heatmap_box·passmap_box 와 같은 627:425 비율.
function FcmMapCell({ title, count, png, loading, emptyText }: {
  title: string;
  count: string;
  png: string | null | undefined;
  loading: boolean;
  emptyText: string;
}) {
  return (
    <figure className="fcm-map-cell">
      <figcaption>
        <strong>{title}</strong>
        {count ? <span>{count}</span> : null}
      </figcaption>
      <div className="fcm-map-frame">
        {png ? (
          <img alt={`${title} 미리보기`} src={`data:image/png;base64,${png}`} />
        ) : (
          <span className="fcm-map-empty">{loading ? '그리는 중…' : emptyText}</span>
        )}
      </div>
    </figure>
  );
}

export default function FcmMatchSetupPage({ matchId }: { matchId: string }) {
  const [match, setMatch] = useState<Match | null>(null);
  const [error, setError] = useState('');
  const [uploads, setUploads] = useState<UploadState>({ workbook: null });
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [selectedStats, setSelectedStats] = useState<string[]>([]);
  const [cardType, setCardType] = useState<CardType>('PLAYER');
  const [penaltyShootout, setPenaltyShootout] = useState<('O' | 'X' | '')[]>([]);
  const [customStat, setCustomStat] = useState('');
  // 커스텀 스탯을 몇 번째에 넣을지(1~5). 0 = 맨 뒤(빈 자리).
  const [customStatRank, setCustomStatRank] = useState(0);
  // 제출 칸에서 연필로 고치는 중인 스탯(순위 index)과 입력값.
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
  const [teamSide, setTeamSide] = useState<TeamSide>('HOME');
  const [savedSubmissions, setSavedSubmissions] = useState<FcmSubmission[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSubmitSuccess, setShowSubmitSuccess] = useState(false);

  useEffect(() => {
    let active = true;

    Promise.allSettled([
      apiJson<Match>(`/matches/${matchId}`),
      apiJson<FcmSubmission[]>(`/fcm/matches/${matchId}/submissions`),
    ]).then((results) => {
      if (!active) return;

      const matchResult = results[0];
      if (matchResult.status === 'fulfilled') {
        setMatch(matchResult.value);
        setError('');
      } else {
        setMatch(null);
        setError(errorMessage(matchResult.reason, '경기 정보를 불러오지 못했습니다. 경기 목록에서 다시 열어 주세요.', { fixed: true }));
      }

      const submissionResult = results[1];
      if (submissionResult.status === 'fulfilled') {
        const submissions = submissionResult.value || [];
        setSavedSubmissions(submissions);
        const initialSubmission = submissions.find((item) => item.team_side === 'HOME') || null;
        if (initialSubmission) {
          setSelectedPlayerId(initialSubmission.player_id);
          setPlayerName(initialSubmission.player_name || '');
          setSelectedStats(initialSubmission.selected_stats || []);
          setCardType(initialSubmission.card_type || 'PLAYER');
          setPenaltyShootout(initialSubmission.penalty_shootout || []);
          setStatus('기존 제출 데이터를 불러왔습니다.');
        }
      } else {
        setSavedSubmissions([]);
      }
    });

    return () => {
      active = false;
    };
  }, [matchId]);

  const homeTeamName = match?.metadata?.home_team || '홈팀';
  const awayTeamName = match?.metadata?.away_team || '어웨이팀';
  const analyzedPlayers = useMemo(
    () => teamPoolFor(analysis?.players || [], teamSide, teamSide === 'HOME' ? homeTeamName : awayTeamName),
    [analysis, teamSide, homeTeamName, awayTeamName],
  );
  // 선수 선택 목록은 양 팀을 모두 보여 준다(HOME/AWAY로 나눠서). 팀을 바꾸면 그 팀 선수로,
  // 다른 팀 선수를 고르면 팀 선택이 그 팀으로 따라간다.
  const playerGroups = useMemo(() => {
    const groups: Record<'HOME' | 'AWAY' | 'UNKNOWN', AnalyzedPlayer[]> = { HOME: [], AWAY: [], UNKNOWN: [] };
    for (const player of analysis?.players || []) {
      groups[sideOf(player, homeTeamName, awayTeamName) || 'UNKNOWN'].push(player);
    }
    return groups;
  }, [analysis, homeTeamName, awayTeamName]);
  const allPlayerCount = (analysis?.players || []).length;
  const selectedPlayer = useMemo(
    () => analyzedPlayers.find((player) => player.player_id === selectedPlayerId)
      || (analysis?.players || []).find((player) => player.player_id === selectedPlayerId && !sideOf(player, homeTeamName, awayTeamName))
      || null,
    [analyzedPlayers, analysis, selectedPlayerId, homeTeamName, awayTeamName],
  );
  const selectedPlayerKey = selectedPlayer ? playerKey(sideOf(selectedPlayer, homeTeamName, awayTeamName), selectedPlayer.player_id) : '';
  const savedSubmission = useMemo(
    () => savedSubmissions.find((submission) => submission.team_side === teamSide) || null,
    [savedSubmissions, teamSide],
  );
  const currentTeamName = teamSide === 'HOME' ? homeTeamName : awayTeamName;

  const statCandidates = selectedPlayer?.candidates || [];
  const isGoalkeeper = cardType === 'GOALKEEPER';

  // 히트맵·패스맵 미리보기: 분석 결과가 있고 선수가 정해지면 그린다. 선수·팀이 바뀌면
  // 300ms 뒤 다시 요청하고, 그 전 요청은 취소한다(늦게 온 옛 응답이 새 선수 칸을 덮지 않게).
  const [maps, setMaps] = useState<PlayerMapsResponse | null>(null);
  const [mapsLoading, setMapsLoading] = useState(false);
  const [mapsError, setMapsError] = useState('');
  const mapsPlayerId = analysis && selectedPlayer ? selectedPlayer.player_id : '';
  useEffect(() => {
    if (!mapsPlayerId || isGoalkeeper) {
      setMaps(null);
      setMapsLoading(false);
      setMapsError('');
      return undefined;
    }
    const controller = new AbortController();
    setMaps(null);
    setMapsLoading(true);
    setMapsError('');
    const timer = window.setTimeout(() => {
      const query = `team_side=${teamSide}&player_id=${encodeURIComponent(mapsPlayerId)}`;
      apiJson<PlayerMapsResponse>(`/fcm/matches/${matchId}/player-maps?${query}`, { signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return;
          setMaps(data);
          setMapsLoading(false);
        })
        .catch((loadError) => {
          if (controller.signal.aborted) return;
          console.warn('[fcm] player-maps', loadError);
          setMapsError(errorMessage(loadError, MAPS_FAILED));
          setMapsLoading(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [matchId, teamSide, mapsPlayerId, isGoalkeeper, analysis]);

  const canSubmit = Boolean(selectedPlayerId) && Boolean(playerName.trim()) && selectedStats.length > 0 && selectedStats.length <= 5;
  const submittedSlots = useMemo(
    () => Array.from({ length: 5 }, (_, index) => selectedStats[index] || '선택 대기'),
    [selectedStats],
  );

  const updatePenaltyResult = (index: number, result: 'O' | 'X' | '') => {
    setPenaltyShootout((previous) => {
      const next = [...previous];
      while (next.length <= index) next.push('');
      next[index] = result;
      while (next.length && !next[next.length - 1]) next.pop();
      return next;
    });
  };

  const toggleStat = (candidate: string) => {
    setSelectedStats((prev) => {
      if (prev.includes(candidate)) {
        return prev.filter((item) => item !== candidate);
      }
      if (prev.length >= 5) return prev;
      return [...prev, candidate];
    });
  };

  const removeSelectedStat = (index: number) => {
    setSelectedStats((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
    setStatus('선택한 스탯을 제거했습니다.');
  };

  const startEditSlot = (index: number) => {
    setEditingSlot(index);
    setEditingText(selectedStats[index] || '');
  };
  const cancelEditSlot = () => {
    setEditingSlot(null);
    setEditingText('');
  };
  // 문구만 바꾸고 순위는 그대로 둔다. 고친 문구는 후보에 없으므로 목록에 '커스텀'으로 보인다.
  const saveEditSlot = () => {
    if (editingSlot === null) return;
    const next = editingText.trim();
    if (!next) {
      setStatus('빈 문구로는 바꿀 수 없습니다. 지우려면 × 를 누르세요.');
      return;
    }
    if (selectedStats.some((stat, index) => index !== editingSlot && stat === next)) {
      setStatus('같은 문구가 이미 다른 순위에 있습니다.');
      return;
    }
    setSelectedStats((prev) => prev.map((stat, index) => (index === editingSlot ? next : stat)));
    setStatus(`${editingSlot + 1}순위 문구를 고쳤습니다. 제출해야 저장됩니다.`);
    cancelEditSlot();
  };

  const moveSelectedStat = (index: number, delta: -1 | 1) => {
    setSelectedStats((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  // 커스텀 스탯은 고른 순위에 끼워 넣는다(11-04 승준). 5개가 다 차 있으면 맨 뒤 스탯이 빠진다.
  const addCustomStat = () => {
    const nextStat = customStat.trim();
    if (!nextStat) {
      setStatus('추가할 커스텀 스탯을 입력하세요.');
      return;
    }
    if (selectedStats.includes(nextStat)) {
      setStatus('이미 선택된 스탯입니다.');
      return;
    }
    const insertAt = customStatRank > 0 ? Math.min(customStatRank - 1, selectedStats.length) : Math.min(selectedStats.length, 4);
    const next = [...selectedStats];
    next.splice(insertAt, 0, nextStat);
    const dropped = next.length > 5 ? next.slice(5) : [];
    setSelectedStats(next.slice(0, 5));
    setCustomStat('');
    setCustomStatRank(0);
    setStatus(`커스텀 스탯을 ${insertAt + 1}순위에 넣었습니다.${dropped.length ? ` 5개가 넘어 '${dropped[0]}'는 빠졌습니다.` : ''}`);
  };

  const applyAnalyzeResult = (data: AnalyzeResponse, statusPrefix = '분석') => {
      const players = data.players || [];
      const candidatePool = teamPoolFor(players, teamSide, currentTeamName);
      // 이미 제출한 선수가 이번 분석에도 있으면 그 선수를 유지한다. 스탯은 방금 분석한 값으로
      // 다시 채운다 — 예전에는 저장된 옛 스탯이 그대로 남아 FPA 로그 반영이 안 된 것처럼 보였다.
      const keptPlayer = savedSubmission ? candidatePool.find((player) => player.player_id === savedSubmission.player_id) : undefined;
      const recommendedPlayer = keptPlayer || candidatePool[0];

      setAnalysis(data);
      setSelectedPlayerId(recommendedPlayer?.player_id || '');
      setPlayerName((keptPlayer && savedSubmission?.player_name) || recommendedPlayer?.player_name || '');
      setSelectedStats(defaultStatsFor(recommendedPlayer));
      setCardType((keptPlayer && savedSubmission?.card_type) || (recommendedPlayer?.is_goalkeeper ? 'GOALKEEPER' : 'PLAYER'));
      setPenaltyShootout((keptPlayer && savedSubmission?.penalty_shootout) || []);
      setCustomStat('');
      if (!players.length) {
        setStatus('분석 결과가 없습니다.');
      } else {
        const changedFromSaved = Boolean(savedSubmission)
          && JSON.stringify(savedSubmission?.selected_stats || []) !== JSON.stringify(defaultStatsFor(recommendedPlayer));
        setStatus(`${statusPrefix}: 선수 ${candidatePool.length}명 분석 완료${changedFromSaved ? ' · 저장된 스탯과 달라졌습니다. 제출해야 저장됩니다.' : ''}`);
      }
  };

  const switchTeam = (nextSide: TeamSide) => {
    setTeamSide(nextSide);
    const next = savedSubmissions.find((item) => item.team_side === nextSide);
    setCustomStat('');
    setStatus('');
    if (next) {
      setSelectedPlayerId(next.player_id || '');
      setPlayerName(next.player_name || '');
      setSelectedStats(next.selected_stats || []);
      setCardType(next.card_type || 'PLAYER');
      setPenaltyShootout(next.penalty_shootout || []);
      return;
    }
    // 저장된 제출이 없으면 이미 분석한 결과에서 그 팀 추천 선수를 바로 채운다.
    const pool = analysis ? teamPoolFor(analysis.players || [], nextSide, nextSide === 'HOME' ? homeTeamName : awayTeamName) : [];
    const recommended = pool[0];
    setSelectedPlayerId(recommended?.player_id || '');
    setPlayerName(recommended?.player_name || '');
    setSelectedStats(defaultStatsFor(recommended));
    setCardType(recommended?.is_goalkeeper ? 'GOALKEEPER' : 'PLAYER');
    setPenaltyShootout([]);
  };

  const analyzeMatch = async () => {
    if (!uploads.workbook) {
      setStatus('먼저 FPA 데이터를 업로드하세요.');
      return;
    }

    setBusy(true);
    setStatus('매치 분석 중');

    try {
      const formData = new FormData();
      formData.append('file', uploads.workbook);
      formData.append('match_id', matchId);
      formData.append('team_side', teamSide);

      const response = await fetch(`${API_BASE}/fcm/analyze`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!response.ok) {
        setStatus(await responseMessage(response, { action: '분석하지 못했습니다', fallback: '분석하지 못했습니다. 다시 시도해 주세요.' }));
        return;
      }

      applyAnalyzeResult(await response.json() as AnalyzeResponse, '파일 분석');
    } catch (loadError) {
      setStatus(errorMessage(loadError, '분석하지 못했습니다. 다시 시도해 주세요.'));
    } finally {
      setBusy(false);
    }
  };

  const analyzeSavedFpaLogs = async () => {
    setBusy(true);
    setStatus('저장된 FPA 로그 반영 중');
    try {
      // 선택한 팀을 같이 보낸다 — 서버가 공용 파일과 그 팀의 팀별 파일을 새 로그로 바꾼다
      // (예전 업로드로 남은 팀별 파일 때문에 카드가 옛 데이터로 그려지던 문제).
      const res = await apiFetch(`/fcm/matches/${matchId}/analyze-fpa-logs?team_side=${teamSide}`, {
        method: 'POST',
      });
      if (!res.ok) throw await errorFromResponse(res, { fallback: SAVED_LOG_FAILED, overrides: SAVED_LOG_OVERRIDES });
      const response = await res.json() as AnalyzeResponse;
      applyAnalyzeResult(response, 'FPA 로그 반영');
    } catch (loadError) {
      setStatus(errorMessage(loadError, SAVED_LOG_FAILED));
    } finally {
      setBusy(false);
    }
  };

  const submitSelection = async () => {
    if (!canSubmit || !selectedPlayerId) {
      setStatus('선수와 주요스탯을 먼저 선택하세요.');
      return;
    }

    setBusy(true);
    setStatus('제출 저장 중');

    try {
      const res = await apiFetch(`/fcm/matches/${matchId}/submission`, {
        method: 'POST',
        body: JSON.stringify({
          team_side: teamSide,
          player_id: selectedPlayerId,
          player_name: playerName.trim(),
          team_name: currentTeamName,
          selected_stats: selectedStats,
          card_type: cardType,
          penalty_shootout: penaltyShootout.filter((value): value is 'O' | 'X' => value === 'O' || value === 'X'),
        }),
      });
      if (!res.ok) throw await errorFromResponse(res, { fallback: SUBMIT_FAILED, overrides: SUBMIT_OVERRIDES });
      const response = await res.json() as FcmSubmission;
      setSavedSubmissions((prev) => {
        const next = prev.filter((item) => item.team_side !== response.team_side);
        next.push(response);
        return next;
      });
      setStatus('제출이 저장되었습니다.');
      setShowSubmitSuccess(true);
    } catch (loadError) {
      setStatus(errorMessage(loadError, SUBMIT_FAILED));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack console-flat">
      {showSubmitSuccess ? (
        <div className="fcm-modal-backdrop" role="presentation">
          <div aria-modal="true" className="card card-panel fcm-modal" role="dialog">
            <div className="sidebar-eyebrow">제출 완료</div>
            <h3 style={{ margin: '6px 0 0' }}>{currentTeamName} 주요스탯이 저장되었습니다.</h3>
            <p className="field-help" style={{ margin: 0 }}>
              {isGoalkeeper ? '골키퍼 카드 설정과 주요스탯이 정상적으로 저장되었습니다.' : '선택한 5개 스탯이 정상적으로 저장되었습니다.'}
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn-primary" onClick={() => setShowSubmitSuccess(false)} type="button">
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ErrorNotice message={error} className="field-help" style={{ color: '#ff9c8f' }} />

      <section className="card card-panel fcm-submit-hero">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">제출 슬롯</div>
            <h3 style={{ margin: '6px 0 0' }}>{currentTeamName} {isGoalkeeper ? '골키퍼' : '주요선수'} 스탯 5개</h3>
          </div>
          <button className="btn-primary" disabled={!canSubmit || busy} onClick={submitSelection} type="button">
            {isGoalkeeper ? '골키퍼 카드 제출' : '5개 스탯 제출'}
          </button>
        </div>

        <div className="fcm-selection-grid fcm-selection-grid-wide">
          {submittedSlots.map((slot, index) => {
            const hasSelectedStat = index < selectedStats.length;
            return (
              <div className={`fcm-selection-slot ${hasSelectedStat ? 'is-selected' : ''}`} key={`${slot}-${index}`}>
                {hasSelectedStat ? (
                  <button
                    aria-label={`STAT ${index + 1} 제거`}
                    className="fcm-selection-remove"
                    onClick={() => removeSelectedStat(index)}
                    type="button"
                  >
                    ×
                  </button>
                ) : null}
                <span className="sidebar-eyebrow">STAT {index + 1}</span>
                {hasSelectedStat && editingSlot !== index ? (
                  <span className="fcm-selection-move">
                    <button type="button" aria-label={`STAT ${index + 1} 문구 고치기`} title="문구 고치기" onClick={() => startEditSlot(index)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg></button>
                    {selectedStats.length > 1 ? <>
                      <button type="button" aria-label={`STAT ${index + 1} 앞으로`} title="앞 순위로" disabled={index === 0} onClick={() => moveSelectedStat(index, -1)}>←</button>
                      <button type="button" aria-label={`STAT ${index + 1} 뒤로`} title="뒤 순위로" disabled={index >= selectedStats.length - 1} onClick={() => moveSelectedStat(index, 1)}>→</button>
                    </> : null}
                  </span>
                ) : null}
                {editingSlot === index ? (
                  <div className="fcm-selection-edit">
                    <textarea
                      aria-label={`STAT ${index + 1} 문구`}
                      autoFocus
                      maxLength={80}
                      rows={2}
                      value={editingText}
                      onChange={(event) => setEditingText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); saveEditSlot(); }
                        if (event.key === 'Escape') { event.preventDefault(); cancelEditSlot(); }
                      }}
                    />
                    <div className="fcm-selection-edit-actions">
                      <button type="button" className="btn-secondary" onClick={cancelEditSlot}>취소</button>
                      <button type="button" className="btn-primary" onClick={saveEditSlot}>저장</button>
                    </div>
                  </div>
                ) : <strong>{slot}</strong>}
              </div>
            );
          })}
        </div>
        {savedSubmission ? (
          <p className="field-help" style={{ margin: 0 }}>
            마지막 저장: <span title={savedSubmission.submitted_by || undefined}>{savedSubmission.submitted_by_name || '알 수 없는 사용자'}</span> / {new Date(savedSubmission.updated_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
          </p>
        ) : null}
      </section>

      <section className="fcm-detail-grid">
        <div className="page-stack fcm-left-stack">
        <aside className="card card-panel">
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">기본 정보</div>
              <h3 style={{ margin: '6px 0 0' }}>Input Pipeline</h3>
            </div>
          </div>

          <div className="fcm-chip-list">
            <span className="fcm-chip">{(match?.competition_class || 'K3').toUpperCase()}</span>
            <span className="fcm-chip">operator {match?.operator_id || '미지정'}</span>
            <span className="fcm-chip">{currentTeamName}</span>
            <span className="fcm-chip">Data 시트</span>
            {selectedPlayer ? <span className="fcm-chip">NO.{selectedPlayer.player_id}</span> : null}
          </div>

          <div className="fvc-sidebar-section">
            <div className="field-label">팀 선택</div>
            <div className="fvc-toggle-grid">
              <button
                className={teamSide === 'HOME' ? 'btn-active' : 'btn-ghost'}
                onClick={() => switchTeam('HOME')}
                type="button"
              >
                {homeTeamName}
              </button>
              <button
                className={teamSide === 'AWAY' ? 'btn-active' : 'btn-ghost'}
                onClick={() => switchTeam('AWAY')}
                type="button"
              >
                {awayTeamName}
              </button>
            </div>
          </div>

          <label className="field-stack fvc-dropzone" htmlFor="fcm-workbook">
            <span className="field-label">FPA 데이터 업로드</span>
            <span className="fvc-dropzone-title">{uploads.workbook?.name || 'FPA 데이터 업로드'}</span>
            <input
              id="fcm-workbook"
              type="file"
              accept=".xlsx,.xls"
              onChange={(event) =>
                setUploads((prev) => ({ ...prev, workbook: event.target.files?.[0] || null }))
              }
            />
          </label>

          <div className="fvc-sidebar-section">
            <div className="fcm-inline-actions">
              <button className="btn-secondary" disabled={!uploads.workbook || busy} onClick={analyzeMatch} type="button">
                {busy ? '분석 중' : '매치 분석'}
              </button>
              <button className="btn-secondary" disabled={busy} onClick={analyzeSavedFpaLogs} type="button">
                FPA 로그 반영하기
              </button>
              <Link className="button-link button-compact" href="/admin/fcm/match-status">
                Match Status로 돌아가기
              </Link>
            </div>
            {status ? <span className="field-help">{status}</span> : null}
            <ErrorFold message={status} />
          </div>
        </aside>

        <section className="card card-panel fcm-map-preview" aria-busy={mapsLoading}>
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">미리보기</div>
              <h3 style={{ margin: '6px 0 0' }}>히트맵 · 패스맵</h3>
            </div>
          </div>
          {selectedPlayer ? (
            <p className="field-help fcm-map-subtitle">
              {teamSide} · {currentTeamName} · NO.{selectedPlayer.player_id} · 카드뉴스와 같은 그림
            </p>
          ) : null}
          {isGoalkeeper ? (
            <p className="field-help">골키퍼 카드는 히트맵·패스맵 대신 슈팅 위치 그림이 들어갑니다.</p>
          ) : !analysis || !selectedPlayer ? (
            <p className="field-help">FPA 로그 반영이나 매치 분석을 하고 선수를 고르면 카드에 들어갈 그림이 여기 나옵니다.</p>
          ) : mapsError ? (
            <ErrorNotice message={mapsError} className="field-help" role="status" />
          ) : maps && !maps.source ? (
            <p className="field-help">아직 저장된 데이터가 없습니다. FPA 로그 반영이나 파일 분석을 먼저 해 주세요.</p>
          ) : (
            <>
              <div className="fcm-map-stack">
                <FcmMapCell
                  count={maps ? `위치 기록 ${maps.heatmap_points}개` : ''}
                  emptyText={maps?.render_error ? '그림을 그리지 못했습니다.' : '위치 기록이 3개 미만이라 카드에 히트맵이 비어 나갑니다.'}
                  loading={mapsLoading || !maps}
                  png={maps?.heatmap_png}
                  title="히트맵"
                />
                <FcmMapCell
                  count={maps ? `패스·크로스 ${maps.passes}개 · 키패스 ${maps.key_passes}` : ''}
                  emptyText={maps?.render_error ? '그림을 그리지 못했습니다.' : '패스 기록이 없어 카드에 패스맵이 비어 나갑니다.'}
                  loading={mapsLoading || !maps}
                  png={maps?.passmap_png}
                  title="패스맵"
                />
              </div>
              {maps?.render_error ? (
                <ErrorNotice
                  className="field-help"
                  message="데이터 파일을 읽지 못해 카드에도 그림이 비어 나갑니다."
                  raw={maps.render_error}
                  role="status"
                />
              ) : null}
              {maps?.source ? (
                <p className="field-help fcm-map-meta" title={maps.source.filename || undefined}>
                  사용한 데이터: {describeMapsSource(maps.source)}
                </p>
              ) : null}
              {maps?.same_number_other_team ? (
                <p className="field-help fcm-map-warn">
                  다른 팀에도 NO.{selectedPlayer.player_id} 이 있습니다 — 이 그림은 {currentTeamName} 선수 기록만 썼습니다.
                </p>
              ) : null}
            </>
          )}
        </section>
        </div>

        <div className="page-stack">
          <section className="card card-panel">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">자동 산출 후보</div>
                <h3 style={{ margin: '6px 0 0' }}>주요스탯 선택</h3>
              </div>
              <span className="status-pill warning chip-tag">{selectedStats.length}/5 선택</span>
            </div>

            <label className="field-stack">
              <span className="field-label">선수 선택</span>
              <select
                disabled={!allPlayerCount}
                value={selectedPlayerKey}
                onChange={(event) => {
                  const [keySide, ...rest] = event.target.value.split(':');
                  const nextPlayerId = rest.join(':');
                  const nextSide = keySide === 'HOME' || keySide === 'AWAY' ? keySide : null;
                  const nextPlayer = (analysis?.players || []).find(
                    (player) => player.player_id === nextPlayerId && sideOf(player, homeTeamName, awayTeamName) === nextSide,
                  );
                  if (nextSide && nextSide !== teamSide) setTeamSide(nextSide);
                  setSelectedPlayerId(nextPlayerId);
                  setPlayerName(nextPlayer?.player_name || '');
                  setSelectedStats(defaultStatsFor(nextPlayer));
                  setCardType(nextPlayer?.is_goalkeeper ? 'GOALKEEPER' : 'PLAYER');
                  setPenaltyShootout([]);
                  setCustomStat('');
                }}
              >
                {allPlayerCount === 0 ? <option value="">분석 후 선수 선택</option> : null}
                {selectedPlayerKey === '' && allPlayerCount > 0 ? <option value="">선수를 고르세요</option> : null}
                {(['HOME', 'AWAY', 'UNKNOWN'] as const).map((group) => (playerGroups[group].length ? (
                  <optgroup
                    key={group}
                    label={group === 'HOME' ? `HOME · ${homeTeamName}` : group === 'AWAY' ? `AWAY · ${awayTeamName}` : '팀 미확인'}
                  >
                    {/* 닫힌 선택 칸에는 optgroup 이름이 안 보여서 옵션 앞에도 HOME/AWAY 를 붙인다. */}
                    {playerGroups[group].map((player) => (
                      <option key={playerKey(group === 'UNKNOWN' ? null : group, player.player_id)} value={playerKey(group === 'UNKNOWN' ? null : group, player.player_id)}>
                        {group === 'UNKNOWN' ? '' : `${group} · `}NO.{player.player_id}{player.player_name ? ` ${player.player_name}` : ''}{group === 'UNKNOWN' && player.team ? ` · ${player.team}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ) : null))}
              </select>
              {selectedPlayer && !selectedPlayer.is_goalkeeper ? (
                <span className="field-help">
                  {[
                    selectedPlayer.position ? `포지션 ${selectedPlayer.position}${selectedPlayer.position_source ? ` (${POSITION_SOURCE_LABEL[selectedPlayer.position_source] || selectedPlayer.position_source})` : ''}` : '',
                    selectedPlayer.stat_case ? STAT_CASE_LABEL[selectedPlayer.stat_case] || '' : '',
                  ].filter(Boolean).join(' · ')}
                </span>
              ) : null}
            </label>

            <label className="field-stack">
              <span className="field-label">카드 유형</span>
              <select value={cardType} onChange={(event) => setCardType(event.target.value as CardType)}>
                <option value="PLAYER">주요선수 카드</option>
                <option value="GOALKEEPER">골키퍼 카드</option>
              </select>
              {selectedPlayer?.is_goalkeeper ? <span className="field-help">FPA 골키퍼 액션(선방/캐칭/펀칭)을 감지했습니다.</span> : null}
            </label>

            <label className="field-stack">
              <span className="field-label">선수 이름</span>
              <input
                type="text"
                placeholder="예: 류연준"
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
              />
            </label>

            <div className="fcm-stat-list">
              {/* 커스텀 스탯(후보에 없는 선택 스탯)도 목록 맨 위에 보인다 — 순위 확인·선택 해제를 같은 자리에서(11-04 승준). */}
              {[...selectedStats.filter((stat) => !statCandidates.includes(stat)), ...statCandidates].map((candidate) => {
                const rank = selectedStats.indexOf(candidate) + 1;
                const isCustom = !statCandidates.includes(candidate);
                const active = rank > 0;
                const full = !active && selectedStats.length >= 5;
                return (
                  <button
                    className={`fcm-stat-option ${active ? 'active' : ''} ${full ? 'is-full' : ''}`}
                    key={candidate}
                    onClick={() => toggleStat(candidate)}
                    type="button"
                    aria-pressed={active}
                    title={full ? '5개를 다 골랐습니다. 하나를 빼면 고를 수 있습니다.' : undefined}
                  >
                    <span className="fcm-stat-rank" aria-hidden="true">{active ? rank : ''}</span>
                    <span className="fcm-stat-text">{candidate}{isCustom ? <span className="fcm-stat-custom">커스텀</span> : null}</span>
                    <span className="fcm-stat-state">{active ? `${rank}순위` : full ? '5개 다 고름' : '선택'}</span>
                  </button>
                );
              })}
            </div>
            {statCandidates.length === 0 && selectedStats.length === 0 ? <p className="field-help">매치 분석 후 후보가 표시됩니다.</p> : null}

            {isGoalkeeper ? (
              <section className="fcm-penalty-panel">
                <div className="section-heading">
                  <div>
                    <div className="sidebar-eyebrow">Penalty shootout</div>
                    <h4 style={{ margin: '6px 0 0' }}>승부차기 결과</h4>
                  </div>
                  <span className="status-pill tech chip-tag">최대 10회</span>
                </div>
                <p className="field-help" style={{ marginTop: 0 }}>각 키커의 결과를 O(선방) 또는 X(실점)로 입력하세요. 빈 칸은 카드에 노출되지 않습니다.</p>
                <div className="fcm-penalty-grid">
                  {Array.from({ length: 10 }, (_, index) => (
                    <div className="fcm-penalty-slot" key={`penalty-${index}`}>
                      <span>PK {index + 1}</span>
                      <div>
                        <button className={penaltyShootout[index] === 'O' ? 'fcm-penalty-choice success active' : 'fcm-penalty-choice success'} onClick={() => updatePenaltyResult(index, 'O')} type="button">O</button>
                        <button className={penaltyShootout[index] === 'X' ? 'fcm-penalty-choice danger active' : 'fcm-penalty-choice danger'} onClick={() => updatePenaltyResult(index, 'X')} type="button">X</button>
                        <button className="fcm-penalty-clear" onClick={() => updatePenaltyResult(index, '')} type="button">–</button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <div className="fcm-custom-stat">
              <label className="field-stack">
                <span className="field-label">커스텀 스탯</span>
                <input
                  maxLength={80}
                  onChange={(event) => setCustomStat(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addCustomStat();
                    }
                  }}
                  placeholder="예: 압박 회피 후 전진 패스 4회"
                  type="text"
                  value={customStat}
                />
              </label>
              <label className="field-stack fcm-custom-rank">
                <span className="field-label">넣을 순위</span>
                <select value={customStatRank} onChange={(event) => setCustomStatRank(Number(event.target.value))}>
                  <option value={0}>{selectedStats.length >= 5 ? '5순위 (맨 뒤)' : `${selectedStats.length + 1}순위 (빈 자리)`}</option>
                  {[1, 2, 3, 4].slice(0, Math.min(4, selectedStats.length)).map((rank) => (
                    <option key={rank} value={rank}>{rank}순위</option>
                  ))}
                </select>
              </label>
              <button
                className="btn-secondary"
                disabled={!customStat.trim()}
                onClick={addCustomStat}
                type="button"
                title={selectedStats.length >= 5 ? '5개가 다 차 있으면 맨 뒤 스탯이 빠집니다.' : undefined}
              >
                추가
              </button>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
