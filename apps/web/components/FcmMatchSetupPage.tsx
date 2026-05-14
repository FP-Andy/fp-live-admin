'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { API_BASE, apiJson } from '../lib/api';

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
  team: string;
  ranking_score: number;
  candidates: string[];
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
  submitted_by?: string | null;
  created_at: string;
  updated_at: string;
};

type TeamSide = 'HOME' | 'AWAY';

export default function FcmMatchSetupPage({ matchId }: { matchId: string }) {
  const [match, setMatch] = useState<Match | null>(null);
  const [error, setError] = useState('');
  const [uploads, setUploads] = useState<UploadState>({ workbook: null });
  const [analyzedPlayers, setAnalyzedPlayers] = useState<AnalyzedPlayer[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [selectedStats, setSelectedStats] = useState<string[]>([]);
  const [customStat, setCustomStat] = useState('');
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
        setError(matchResult.reason instanceof Error ? matchResult.reason.message : '경기 정보를 불러오지 못했습니다.');
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

  const selectedPlayer = useMemo(
    () => analyzedPlayers.find((player) => player.player_id === selectedPlayerId) || null,
    [analyzedPlayers, selectedPlayerId],
  );
  const savedSubmission = useMemo(
    () => savedSubmissions.find((submission) => submission.team_side === teamSide) || null,
    [savedSubmissions, teamSide],
  );
  const currentTeamName = teamSide === 'HOME' ? (match?.metadata?.home_team || '홈팀') : (match?.metadata?.away_team || '어웨이팀');

  const statCandidates = selectedPlayer?.candidates || [];

  const canSubmit = Boolean(selectedPlayerId) && Boolean(playerName.trim()) && selectedStats.length > 0 && selectedStats.length <= 5;
  const submittedSlots = useMemo(
    () => Array.from({ length: 5 }, (_, index) => selectedStats[index] || '선택 대기'),
    [selectedStats],
  );

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
    if (selectedStats.length >= 5) {
      setStatus('주요스탯은 최대 5개까지 선택할 수 있습니다.');
      return;
    }
    setSelectedStats((prev) => [...prev, nextStat]);
    setCustomStat('');
    setStatus('커스텀 스탯이 추가되었습니다.');
  };

  const applyAnalyzeResult = (data: AnalyzeResponse, statusPrefix = '분석') => {
      const players = data.players || [];
      const teamPlayers = players.filter((player) => (player.team || '').trim() === currentTeamName.trim());
      const candidatePool = teamPlayers.length ? teamPlayers : players;
      const fallbackPlayerId = savedSubmission?.player_id || data.recommended_player_id || candidatePool[0]?.player_id || '';
      const recommendedPlayer = candidatePool.find((player) => player.player_id === fallbackPlayerId) || candidatePool[0];
      const recommendedPlayerId = recommendedPlayer?.player_id || fallbackPlayerId;

      setAnalyzedPlayers(candidatePool);
      setSelectedPlayerId(recommendedPlayerId);
      setPlayerName(savedSubmission?.player_name || '');
      setSelectedStats(
        savedSubmission?.selected_stats?.length
          ? savedSubmission.selected_stats.slice(0, 5)
          : (recommendedPlayer?.candidates || []).slice(0, 5),
      );
      setStatus(players.length ? `${statusPrefix}: 선수 ${players.length}명 분석 완료` : '분석 결과가 없습니다.');
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
        setStatus((await response.text()) || '매치 분석 실패');
        return;
      }

      applyAnalyzeResult(await response.json() as AnalyzeResponse, '파일 분석');
    } catch (loadError) {
      setStatus(loadError instanceof Error ? loadError.message : '매치 분석 실패');
    } finally {
      setBusy(false);
    }
  };

  const analyzeSavedFpaLogs = async () => {
    setBusy(true);
    setStatus('저장된 FPA 로그 반영 중');
    try {
      const response = await apiJson<AnalyzeResponse>(`/fcm/matches/${matchId}/analyze-fpa-logs`, {
        method: 'POST',
      });
      applyAnalyzeResult(response, 'FPA 로그 반영');
    } catch (loadError) {
      setStatus(loadError instanceof Error ? loadError.message : '저장된 FPA 로그 반영 실패');
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
      const response = await apiJson<FcmSubmission>(`/fcm/matches/${matchId}/submission`, {
        method: 'POST',
        body: JSON.stringify({
          team_side: teamSide,
          player_id: selectedPlayerId,
          player_name: playerName.trim(),
          team_name: currentTeamName,
          selected_stats: selectedStats,
        }),
      });
      setSavedSubmissions((prev) => {
        const next = prev.filter((item) => item.team_side !== response.team_side);
        next.push(response);
        return next;
      });
      setStatus('제출이 저장되었습니다.');
      setShowSubmitSuccess(true);
    } catch (loadError) {
      setStatus(loadError instanceof Error ? loadError.message : '제출 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack">
      {showSubmitSuccess ? (
        <div className="fcm-modal-backdrop" role="presentation">
          <div aria-modal="true" className="card card-panel fcm-modal" role="dialog">
            <div className="sidebar-eyebrow">제출 완료</div>
            <h3 style={{ margin: '6px 0 0' }}>{currentTeamName} 주요스탯이 저장되었습니다.</h3>
            <p className="field-help" style={{ margin: 0 }}>
              선택한 5개 스탯이 정상적으로 저장되었습니다.
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn-primary" onClick={() => setShowSubmitSuccess(false)} type="button">
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <p className="field-help" style={{ color: '#ff9c8f' }}>{error}</p> : null}

      <section className="card card-panel fcm-submit-hero">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">제출 슬롯</div>
            <h3 style={{ margin: '6px 0 0' }}>{currentTeamName} 주요스탯 5개</h3>
          </div>
          <button className="btn-primary" disabled={!canSubmit || busy} onClick={submitSelection} type="button">
            5개 스탯 제출
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
                <strong>{slot}</strong>
              </div>
            );
          })}
        </div>
        {savedSubmission ? (
          <p className="field-help" style={{ margin: 0 }}>
            마지막 저장: {savedSubmission.submitted_by || 'unknown'} / {new Date(savedSubmission.updated_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
          </p>
        ) : null}
      </section>

      <section className="fcm-detail-grid">
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
                onClick={() => {
                  setTeamSide('HOME');
                  const next = savedSubmissions.find((item) => item.team_side === 'HOME');
                  setSelectedPlayerId(next?.player_id || '');
                  setPlayerName(next?.player_name || '');
                  setSelectedStats(next?.selected_stats || []);
                  setCustomStat('');
                  setStatus('');
                }}
                type="button"
              >
                {match?.metadata?.home_team || '홈팀'}
              </button>
              <button
                className={teamSide === 'AWAY' ? 'btn-active' : 'btn-ghost'}
                onClick={() => {
                  setTeamSide('AWAY');
                  const next = savedSubmissions.find((item) => item.team_side === 'AWAY');
                  setSelectedPlayerId(next?.player_id || '');
                  setPlayerName(next?.player_name || '');
                  setSelectedStats(next?.selected_stats || []);
                  setCustomStat('');
                  setStatus('');
                }}
                type="button"
              >
                {match?.metadata?.away_team || '어웨이팀'}
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
          </div>
        </aside>

        <div className="page-stack">
          <section className="card card-panel">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">자동 산출 후보</div>
                <h3 style={{ margin: '6px 0 0' }}>주요스탯 선택</h3>
              </div>
              <span className="status-pill warning">{selectedStats.length}/5 selected</span>
            </div>

            <label className="field-stack">
              <span className="field-label">선수 선택</span>
              <select
                disabled={!analyzedPlayers.length}
                value={selectedPlayerId}
                onChange={(event) => {
                  const nextPlayerId = event.target.value;
                  const nextPlayer = analyzedPlayers.find((player) => player.player_id === nextPlayerId);
                  setSelectedPlayerId(nextPlayerId);
                  setSelectedStats((nextPlayer?.candidates || []).slice(0, 5));
                  setCustomStat('');
                }}
              >
                {analyzedPlayers.length === 0 ? <option value="">분석 후 선수 선택</option> : null}
                {analyzedPlayers.map((player) => (
                  <option key={player.player_id} value={player.player_id}>
                    {player.team ? `${player.team} · ` : ''}NO.{player.player_id}
                  </option>
                ))}
              </select>
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
              {statCandidates.map((candidate) => {
                const active = selectedStats.includes(candidate);
                return (
                  <button
                    className={`fcm-stat-option ${active ? 'active' : ''}`}
                    key={candidate}
                    onClick={() => toggleStat(candidate)}
                    type="button"
                  >
                    <span>{candidate}</span>
                    <span>{active ? '선택됨' : '선택'}</span>
                  </button>
                );
              })}
            </div>
            {statCandidates.length === 0 ? <p className="field-help">매치 분석 후 후보가 표시됩니다.</p> : null}

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
              <button
                className="btn-secondary"
                disabled={!customStat.trim() || selectedStats.length >= 5}
                onClick={addCustomStat}
                type="button"
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
