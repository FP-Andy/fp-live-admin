'use client';

import Link from 'next/link';
import { FcmWorkflow, ConsoleToolbar, ConsoleEmpty } from './ConsoleTools';
import { useEffect, useMemo, useState } from 'react';
import { API_BASE, apiJson } from '../lib/api';
import { RawMatchRecord, getEligibleFcmMatches } from '../lib/fcm';
import ErrorNotice from './ErrorNotice';
import { errorDetail, errorFromResponse, errorMessage } from '../lib/error-messages';

const CARD_FAILED = '카드를 만들지 못했습니다';
const CARD_RETRY = `${CARD_FAILED}. 다시 시도해 주세요.`;
/**
 * 카드 생성 실패 — 앞머리를 '카드를 만들지 못했습니다'로 맞춘다.
 * 409 '생성 가능한 카드가 없습니다.'는 변환표가 이미 팀별 사유까지 붙여 주므로 그대로 쓴다(서버 원문 detail 로 판정).
 */
function cardErrorMessage(error: unknown): string {
  if (errorDetail(error).startsWith('생성 가능한 카드가 없습니다.')) return errorMessage(error, CARD_RETRY);
  return errorMessage(error, CARD_RETRY, { action: CARD_FAILED });
}

type CompetitionClass = {
  code: string;
  name: string;
  first_half_minutes: number;
  second_half_minutes: number;
  created_at: string;
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
  submitted_by?: string | null;
  submitted_by_name?: string | null;
  created_at: string;
  updated_at: string;
};

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ko-KR', {
    hour12: false,
    timeZone: 'Asia/Seoul',
  });
}

export default function FvcWorkspacePage() {
  const [readiness, setReadiness] = useState('ALL');
  const [league, setLeague] = useState('K3');
  const [round, setRound] = useState<number>(1);
  const [matches, setMatches] = useState<RawMatchRecord[]>([]);
  const [competitionClasses, setCompetitionClasses] = useState<CompetitionClass[]>([]);
  const [submissions, setSubmissions] = useState<FcmSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatingCardKey, setGeneratingCardKey] = useState<string | null>(null);
  // 체크한 팀(경기ID:HOME|AWAY). 대회·라운드를 바꾸면 비운다.
  const [selectedCards, setSelectedCards] = useState<Set<string>>(() => new Set());
  const [generatingSelected, setGeneratingSelected] = useState(false);
  useEffect(() => { setSelectedCards(new Set()); }, [league, round]);

  useEffect(() => {
    let active = true;

    Promise.all([
      apiJson<RawMatchRecord[]>('/matches'),
      apiJson<CompetitionClass[]>('/competition-classes').catch(() => []),
      apiJson<FcmSubmission[]>('/fcm/submissions').catch(() => []),
    ])
      .then(([matchData, classData, submissionData]) => {
        if (!active) return;
        setMatches(Array.isArray(matchData) ? matchData : []);
        setCompetitionClasses(Array.isArray(classData) ? classData : []);
        setSubmissions(Array.isArray(submissionData) ? submissionData : []);
        setError('');
      })
      .catch((loadError) => {
        if (!active) return;
        setMatches([]);
        setSubmissions([]);
        setError(errorMessage(loadError, '카드 만들 목록을 불러오지 못했습니다. 새로고침해 주세요.', { fixed: true }));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const eligibleMatches = useMemo(() => getEligibleFcmMatches(matches), [matches]);
  const leagueOptions = useMemo(() => {
    const codes = new Set([
      ...competitionClasses.map((item) => item.code),
      ...eligibleMatches.map((match) => match.competitionClass),
    ]);
    return Array.from(codes).sort();
  }, [competitionClasses, eligibleMatches]);

  const roundsByLeague = useMemo(() => {
    const base: Record<string, number[]> = {};
    eligibleMatches.forEach((match) => {
      if (!base[match.competitionClass]) base[match.competitionClass] = [];
      base[match.competitionClass].push(match.roundNumber);
    });
    return Object.fromEntries(
      Object.entries(base).map(([key, values]) => [key, Array.from(new Set(values)).sort((a, b) => b - a)]),
    );
  }, [eligibleMatches]);

  const rounds = roundsByLeague[league] || [];

  useEffect(() => {
    if (leagueOptions.length > 0 && !leagueOptions.includes(league)) {
      setLeague(leagueOptions[0]);
    }
  }, [league, leagueOptions]);

  useEffect(() => {
    if (rounds.length === 0) {
      setRound(1);
      return;
    }
    if (!rounds.includes(round)) {
      setRound(rounds[0]);
    }
  }, [league, round, rounds]);

  const queueRows = useMemo(
    () =>
      eligibleMatches.filter((match) => match.competitionClass === league && match.roundNumber === round),
    [eligibleMatches, league, round],
  );

  const submissionMap = useMemo(
    () => new Map(submissions.map((submission) => [`${submission.match_id}:${submission.team_side}`, submission])),
    [submissions],
  );

  const summary = useMemo(() => {
    const leagueMatches = eligibleMatches.filter((match) => match.competitionClass === league);
    const ready = queueRows.reduce((count, match) => {
      const homeReady = submissionMap.has(`${match.id}:HOME`);
      const awayReady = submissionMap.has(`${match.id}:AWAY`);
      return count + Number(homeReady) + Number(awayReady);
    }, 0);
    return {
      total: leagueMatches.length * 2,
      rounds: rounds.length,
      currentRound: queueRows.length,
      ready,
    };
  }, [eligibleMatches, league, queueRows, rounds.length, submissionMap]);

  const visibleQueueRows = queueRows.filter(match => ['HOME', 'AWAY'].some(side => readiness === 'ALL' || (readiness === 'READY') === submissionMap.has(`${match.id}:${side}`)));

  const handleGenerate = async () => {
    setGenerating(true);
    setError('');
    try {
      const response = await fetch(
        `${API_BASE}/fcm/generate?league=${encodeURIComponent(league)}&round=${round}`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        throw await errorFromResponse(response, CARD_RETRY);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${league}-${round}R_cards.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (loadError) {
      setError(cardErrorMessage(loadError));
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateSingle = async (submission: FcmSubmission) => {
    const cardKey = `${submission.match_id}:${submission.team_side}`;
    setGeneratingCardKey(cardKey);
    setError('');
    try {
      const params = new URLSearchParams({
        league,
        round: String(round),
        match_id: submission.match_id,
        team_side: submission.team_side,
      });
      const response = await fetch(`${API_BASE}/fcm/generate?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) {
        throw await errorFromResponse(response, CARD_RETRY);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${league}-${round}R-${submission.team_name}-${submission.player_id}-${submission.player_name}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (loadError) {
      setError(cardErrorMessage(loadError));
    } finally {
      setGeneratingCardKey(null);
    }
  };

  // 제출이 남아 있는 체크만 센다(제출을 지웠거나 다른 라운드 값이면 빠진다).
  const selectedReady = [...selectedCards].filter(key => submissionMap.has(key));
  const readyKeysInView = visibleQueueRows.flatMap(match => (['HOME', 'AWAY'] as const)
    .map(side => `${match.id}:${side}`)
    .filter(key => submissionMap.has(key) && (readiness === 'ALL' || readiness === 'READY')));
  const busy = generating || generatingSelected || generatingCardKey !== null;
  const toggleCard = (key: string, checked: boolean) => setSelectedCards(prev => {
    const next = new Set(prev);
    if (checked) next.add(key); else next.delete(key);
    return next;
  });
  const setCards = (keys: string[], checked: boolean) => setSelectedCards(prev => {
    const next = new Set(prev);
    keys.forEach(key => (checked ? next.add(key) : next.delete(key)));
    return next;
  });

  const handleGenerateSelected = async () => {
    if (selectedReady.length === 0) return;
    if (selectedReady.length === 1) {
      const only = submissionMap.get(selectedReady[0]);
      if (only) await handleGenerateSingle(only);
      return;
    }
    setGeneratingSelected(true);
    setError('');
    try {
      const params = new URLSearchParams({ league, round: String(round), targets: selectedReady.join(',') });
      const response = await fetch(`${API_BASE}/fcm/generate?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) {
        throw await errorFromResponse(response, CARD_RETRY);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${league}-${round}R_selected_cards.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (loadError) {
      setError(cardErrorMessage(loadError));
    } finally {
      setGeneratingSelected(false);
    }
  };

  return (
    <div className="page-stack console-page fcm-workspace-page console-flat">
      <FcmWorkflow current="workspace" />
      <section className="fvc-workspace">
        <aside className="fvc-sidebar card card-panel">
          <div className="sidebar-eyebrow">Card Builder</div>

          <div className="fvc-sidebar-section">
            <label className="field-stack">
              <span className="field-label">대회 선택</span>
              <select
                value={leagueOptions.includes(league) ? league : ''}
                onChange={(event) => setLeague(event.target.value)}
              >
                {leagueOptions.length === 0 ? <option value="">선택 가능한 대회 없음</option> : null}
                {leagueOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="fvc-sidebar-section">
            <label className="field-stack">
              <span className="field-label">라운드 선택</span>
              <select
                disabled={rounds.length === 0}
                value={rounds.includes(round) ? round : ''}
                onChange={(event) => setRound(Number(event.target.value))}
              >
                {rounds.length === 0 ? <option value="">선택 가능한 라운드 없음</option> : null}
                {rounds.map((option) => (
                  <option key={option} value={option}>
                    {option}라운드
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="fvc-sidebar-section">
            <button
              className="btn-primary"
              disabled={queueRows.length === 0 || summary.ready === 0 || busy}
              onClick={handleGenerate}
              type="button"
            >
              {generating ? '생성 준비 중' : `준비된 ${summary.ready}팀 일괄 다운로드`}
            </button>
            <button
              className="btn-secondary"
              disabled={selectedReady.length === 0 || busy}
              onClick={handleGenerateSelected}
              title={selectedReady.length === 0 ? '아래 목록에서 받을 팀을 체크하세요' : '체크한 팀 카드만 받습니다'}
              type="button"
            >
              {generatingSelected ? '생성 준비 중' : `체크한 ${selectedReady.length}팀 다운로드`}
            </button>
          </div>
        </aside>

        <div className="fvc-main">
          <section className="card card-panel">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">현황</div>
                <h3 style={{ margin: '6px 0 0' }}>생성 준비 상태</h3>
              </div>
            </div>

            <div className="fvc-summary-grid">
              <div className="metric-tile">
                <div className="sidebar-eyebrow">리그 전체 팀</div>
                <strong>{summary.total}</strong>
              </div>
              <div className="metric-tile tech">
                <div className="sidebar-eyebrow">라운드 수</div>
                <strong>{summary.rounds}</strong>
              </div>
              <div className="metric-tile success">
                <div className="sidebar-eyebrow">현재 라운드 경기</div>
                <strong>{summary.currentRound}</strong>
              </div>
              <div className="metric-tile">
                <div className="sidebar-eyebrow">데이터 제출 완료</div>
                <strong>{summary.ready}</strong>
              </div>
            </div>
          </section>

          <section className="card card-panel">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">작업 목록</div>
                <h3 style={{ margin: '6px 0 0' }}>카드 생성 대상 경기</h3>
              </div>
              <span className="status-pill warning chip-tag">{league} {round}R</span>
            </div>

            {loading ? <p className="field-help">경기 목록을 불러오는 중입니다.</p> : null}
            <ErrorNotice message={error} className="field-help" style={{ color: '#ff9c8f' }} />

            <ConsoleToolbar><label className="field-stack"><span className="field-label">제출 상태</span><select value={readiness} onChange={event => setReadiness(event.target.value)}><option value="ALL">전체 팀</option><option value="READY">제출 완료</option><option value="PENDING">미제출</option></select></label><p className="field-help">미제출 팀은 경기 상세에서 선수와 스탯을 먼저 제출하세요. 생성 전 템플릿도 확인하세요.</p><div className="fvc-select-bar"><span className="field-help">{selectedReady.length}팀 체크됨</span><button className="button-compact" disabled={readyKeysInView.length === 0 || busy} onClick={() => setCards(readyKeysInView, true)} type="button">보이는 제출 완료 팀 모두 체크</button><button className="button-compact" disabled={selectedCards.size === 0 || busy} onClick={() => setSelectedCards(new Set())} type="button">체크 해제</button><button className="btn-success button-compact" disabled={selectedReady.length === 0 || busy} onClick={handleGenerateSelected} type="button">{generatingSelected ? '생성 준비 중' : `체크한 ${selectedReady.length}팀 다운로드`}</button></div></ConsoleToolbar>
            <div className="fvc-table-scroll">
              <div className="fvc-table">
                {visibleQueueRows.map((match, index) => {
                  const homeSubmission = submissionMap.get(`${match.id}:HOME`);
                  const awaySubmission = submissionMap.get(`${match.id}:AWAY`);
                  const matchKeys = (['HOME', 'AWAY'] as const).map(side => `${match.id}:${side}`).filter(key => submissionMap.has(key));
                  const matchAllChecked = matchKeys.length > 0 && matchKeys.every(key => selectedCards.has(key));

                  return (
                    <div className="fvc-match-group" key={match.id}>
                      <div className="fvc-match-group-head">
                        <label className="fvc-check" title={matchKeys.length === 0 ? '제출 완료 팀이 없습니다' : '이 경기의 제출 완료 팀 모두 체크'}>
                          <input type="checkbox" aria-label={`${match.homeTeam} vs ${match.awayTeam} 모두 체크`} checked={matchAllChecked} disabled={matchKeys.length === 0 || busy} onChange={event => setCards(matchKeys, event.target.checked)} />
                        </label>
                        <span className="status-pill warning chip-tag">경기 {index + 1}</span>
                        <strong>{match.homeTeam} vs {match.awayTeam}</strong>
                        <span className="field-help">{formatDateTime(match.archivedAt)}</span>
                      </div>

                      <div className="fvc-table-row fvc-table-head">
                        <span aria-hidden="true" />
                        <span>팀</span>
                        <span>선수</span>
                        <span>주요스탯</span>
                        <span>제출자</span>
                        <span>상세</span>
                        <span>상태</span>
                        <span>생성</span>
                      </div>

                      {[
                        { side: 'HOME' as const, teamName: match.homeTeam, submission: homeSubmission },
                        { side: 'AWAY' as const, teamName: match.awayTeam, submission: awaySubmission },
                      ].filter(row => readiness === 'ALL' || (readiness === 'READY') === Boolean(row.submission)).map((row) => (
                        <div className={`fvc-table-row${selectedCards.has(`${match.id}:${row.side}`) && row.submission ? ' fvc-row-checked' : ''}`} key={`${match.id}-${row.side}`}>
                          <span className="fvc-check-cell">
                            <label className="fvc-check" title={!row.submission ? '선수와 스탯을 먼저 제출하세요' : '체크하면 "체크한 팀 다운로드"에 들어갑니다'}>
                              <input type="checkbox" aria-label={`${row.side} ${row.teamName} 체크`} checked={Boolean(row.submission) && selectedCards.has(`${match.id}:${row.side}`)} disabled={!row.submission || busy} onChange={event => toggleCard(`${match.id}:${row.side}`, event.target.checked)} />
                            </label>
                          </span>
                          <span data-label="팀">{row.teamName}</span>
                          <span data-label="선수">{row.submission ? `NO.${row.submission.player_id} ${row.submission.player_name || ''}`.trim() : '-'}</span>
                          <span data-label="주요 스탯">{row.submission?.selected_stats?.[0] || '-'}</span>
                          <span data-label="제출자" title={row.submission?.submitted_by || undefined}>{row.submission ? (row.submission.submitted_by_name || '알 수 없는 사용자') : '미지정'}</span>
                          <span>
                            <Link className="button-link button-compact" href={`/admin/fcm/match-status/${match.id}`}>
                              {row.submission ? '제출 내용 수정' : '데이터 제출'}
                            </Link>
                          </span>
                          <span>
                            <span className={`status-pill ${row.submission ? 'running' : 'warning'}`}>
                              {row.submission ? '제출 완료' : '미제출'}
                            </span>
                          </span>
                          <span>
                            <button
                              className="btn-success button-compact"
                              disabled={!row.submission || busy}
                              title={!row.submission ? '선수와 스탯을 먼저 제출하세요' : '이 팀의 카드 다운로드'}
                              onClick={() => {
                                if (row.submission) handleGenerateSingle(row.submission);
                              }}
                              type="button"
                            >
                              {generatingCardKey === `${match.id}:${row.side}` ? '생성 중' : '생성'}
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>

            {!loading && !error && visibleQueueRows.length === 0 ? (
              <ConsoleEmpty title="조건에 맞는 팀이 없습니다.">{readiness !== 'ALL' ? <button onClick={() => setReadiness('ALL')} type="button">전체 상태 보기</button> : '대회와 라운드를 확인하세요.'}</ConsoleEmpty>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
