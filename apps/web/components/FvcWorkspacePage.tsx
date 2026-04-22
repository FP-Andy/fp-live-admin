'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { API_BASE, apiJson } from '../lib/api';
import { FcmLeagueKey, RawMatchRecord, getEligibleFcmMatches } from '../lib/fcm';

const LEAGUES: FcmLeagueKey[] = ['K3', 'WK'];

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
  const [league, setLeague] = useState<FcmLeagueKey>('K3');
  const [round, setRound] = useState<number>(1);
  const [matches, setMatches] = useState<RawMatchRecord[]>([]);
  const [submissions, setSubmissions] = useState<FcmSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let active = true;

    Promise.all([
      apiJson<RawMatchRecord[]>('/matches'),
      apiJson<FcmSubmission[]>('/fcm/submissions').catch(() => []),
    ])
      .then(([matchData, submissionData]) => {
        if (!active) return;
        setMatches(Array.isArray(matchData) ? matchData : []);
        setSubmissions(Array.isArray(submissionData) ? submissionData : []);
        setError('');
      })
      .catch((loadError) => {
        if (!active) return;
        setMatches([]);
        setSubmissions([]);
        setError(loadError instanceof Error ? loadError.message : '카드 큐를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const eligibleMatches = useMemo(() => getEligibleFcmMatches(matches), [matches]);

  const roundsByLeague = useMemo(() => {
    const base = { K3: [] as number[], WK: [] as number[] };
    eligibleMatches.forEach((match) => {
      base[match.competitionClass].push(match.roundNumber);
    });
    return {
      K3: Array.from(new Set(base.K3)).sort((a, b) => b - a),
      WK: Array.from(new Set(base.WK)).sort((a, b) => b - a),
    };
  }, [eligibleMatches]);

  const rounds = roundsByLeague[league];

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

  const handleGenerate = async () => {
    setGenerating(true);
    setError('');
    try {
      const response = await fetch(
        `${API_BASE}/fcm/generate?league=${encodeURIComponent(league)}&round=${round}`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        throw new Error((await response.text()) || '카드 생성에 실패했습니다.');
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
      setError(loadError instanceof Error ? loadError.message : '카드 생성에 실패했습니다.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="fvc-workspace">
        <aside className="fvc-sidebar card card-panel">
          <div className="sidebar-eyebrow">Card Builder</div>

          <div className="fvc-sidebar-section">
            <div className="field-label">리그 선택</div>
            <div className="fvc-toggle-grid">
              {LEAGUES.map((item) => (
                <button
                  key={item}
                  className={league === item ? 'btn-active' : 'btn-ghost'}
                  onClick={() => setLeague(item)}
                  type="button"
                >
                  {item === 'K3' ? 'K3리그' : 'WK리그'}
                </button>
              ))}
            </div>
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
              disabled={queueRows.length === 0 || summary.ready === 0 || generating}
              onClick={handleGenerate}
              type="button"
            >
              {generating ? '생성 준비 중' : '카드 생성 + 다운로드'}
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
                <div className="sidebar-eyebrow">리그 전체 경기</div>
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
                <div className="sidebar-eyebrow">생성 가능</div>
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
              <span className="status-pill warning">{league} {round}R</span>
            </div>

            {loading ? <p className="field-help">경기 목록을 불러오는 중입니다.</p> : null}
            {error ? <p className="field-help" style={{ color: '#ff9c8f' }}>{error}</p> : null}

            <div className="fvc-table-scroll">
              <div className="fvc-table">
                {queueRows.map((match, index) => {
                  const homeSubmission = submissionMap.get(`${match.id}:HOME`);
                  const awaySubmission = submissionMap.get(`${match.id}:AWAY`);

                  return (
                    <div className="fvc-match-group" key={match.id}>
                      <div className="fvc-match-group-head">
                        <span className="status-pill warning">경기 {index + 1}</span>
                        <strong>{match.homeTeam} vs {match.awayTeam}</strong>
                        <span className="field-help">{formatDateTime(match.archivedAt)}</span>
                      </div>

                      <div className="fvc-table-row fvc-table-head">
                        <span>팀</span>
                        <span>선수</span>
                        <span>주요스탯</span>
                        <span>제출자</span>
                        <span>상세</span>
                        <span>상태</span>
                      </div>

                      {[
                        { side: 'HOME' as const, teamName: match.homeTeam, submission: homeSubmission },
                        { side: 'AWAY' as const, teamName: match.awayTeam, submission: awaySubmission },
                      ].map((row) => (
                        <div className="fvc-table-row" key={`${match.id}-${row.side}`}>
                          <span>{row.teamName}</span>
                          <span>{row.submission ? `NO.${row.submission.player_id} ${row.submission.player_name || ''}`.trim() : '-'}</span>
                          <span>{row.submission?.selected_stats?.[0] || '-'}</span>
                          <span>{row.submission?.submitted_by || match.operatorId || '미지정'}</span>
                          <span>
                            <Link className="button-link button-compact" href={`/admin/fcm/match-status/${match.id}`}>
                              열기
                            </Link>
                          </span>
                          <span>
                            <span className={`status-pill ${row.submission ? 'running' : 'warning'}`}>
                              {row.submission ? 'Ready' : 'Pending'}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>

            {!loading && !error && queueRows.length === 0 ? (
              <p className="field-help">선택한 리그/라운드에 연결된 archived match가 없습니다.</p>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
