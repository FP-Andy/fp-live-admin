'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { scheduleItems } from './schedule-data';
import { apiFetch, apiJson } from '../../../lib/api';

type Match = {
  id: string;
  name: string;
  competition_class: string;
  round_number: number;
  archived: boolean;
  archived_at?: string | null;
  created_at: string;
  hls_url?: string;
  metadata?: {
    stream_mode?: 'STREAM' | 'MANUAL';
    ingest_protocol?: 'SRT' | 'RTMP';
    ingest_url?: string;
    rtmp?: {
      server_url?: string;
      stream_key?: string;
      push_url?: string;
      pull_url?: string;
    };
  } | null;
  operator_id?: string | null;
};

type StreamStatus = {
  running_match_ids?: string[];
};

export default function Dashboard() {
  const PAGE_SIZE = 7;
  const [matches, setMatches] = useState<Match[]>([]);
  const [runningMatchIds, setRunningMatchIds] = useState<string[]>([]);
  const [homeTeam, setHomeTeam] = useState('');
  const [awayTeam, setAwayTeam] = useState('');
  const [competitionClass, setCompetitionClass] = useState('K3');
  const [roundNumber, setRoundNumber] = useState(1);
  const [streamMode, setStreamMode] = useState<'STREAM' | 'MANUAL'>('STREAM');
  const [assignOperator, setAssignOperator] = useState(true);
  const [ingestProtocol, setIngestProtocol] = useState<'SRT' | 'RTMP'>('RTMP');
  const [error, setError] = useState('');
  const [listMode, setListMode] = useState<'active' | 'archived'>('active');
  const [classFilter, setClassFilter] = useState('ALL');
  const [activePage, setActivePage] = useState(1);
  const [archivedPage, setArchivedPage] = useState(1);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  });

  const load = async () => {
    try {
      const [matchesData, streamStatusData] = await Promise.all([
        apiJson<Match[]>('/matches'),
        apiJson<StreamStatus>('/admin/streams/status').catch(() => ({ running_match_ids: [] })),
      ]);
      setMatches(Array.isArray(matchesData) ? matchesData : []);
      setRunningMatchIds(Array.isArray(streamStatusData.running_match_ids) ? streamStatusData.running_match_ids : []);
      setError('');
    } catch (loadError) {
      setMatches([]);
      setRunningMatchIds([]);
      setError(loadError instanceof Error ? loadError.message : 'API unavailable. Run API server or infra/app compose stack.');
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  const generatedMatchName = useMemo(() => {
    const home = homeTeam.trim();
    const away = awayTeam.trim();
    if (!home || !away) return '';
    return `[${competitionClass} | ${roundNumber}R] ${home} vs ${away}`;
  }, [competitionClass, roundNumber, homeTeam, awayTeam]);

  const createMatch = async () => {
    if (!homeTeam.trim() || !awayTeam.trim()) {
      setError('홈팀과 어웨이팀을 모두 입력하세요.');
      return;
    }
    setError('');

    const response = await apiFetch('/matches', {
      method: 'POST',
      body: JSON.stringify({
        name: generatedMatchName,
        competition_class: competitionClass,
        round_number: roundNumber,
        stream_mode: streamMode,
        assign_operator: assignOperator,
        ingest_protocol: streamMode === 'STREAM' ? ingestProtocol : null,
      }),
    });

    if (!response.ok) {
      setError((await response.text()) || 'Failed to create match');
      return;
    }

    setHomeTeam('');
    setAwayTeam('');
    setCompetitionClass('K3');
    setRoundNumber(1);
    setStreamMode('STREAM');
    setAssignOperator(true);
    setIngestProtocol('RTMP');
    await load();
  };

  const deleteMatch = async (matchId: string, matchName: string) => {
    const ok = window.confirm(`Delete match '${matchName}'? This removes states/events/dominance data.`);
    if (!ok) return;

    setError('');
    let response = await apiFetch(`/matches/${matchId}?stop_stream=true`, {
      method: 'DELETE',
    });

    if (response.status === 409) {
      const detail = await response.text();
      const confirmLive = window.confirm(`${detail}\n\n계속 삭제할까요?`);
      if (!confirmLive) return;
      response = await apiFetch(`/matches/${matchId}?stop_stream=true&confirm_live_action=true`, {
        method: 'DELETE',
      });
    }

    if (!response.ok) {
      setError((await response.text()) || 'Failed to delete match');
      return;
    }

    await load();
  };

  const setArchived = async (matchId: string, archived: boolean) => {
    const prompt = archived
      ? '이 경기를 보관할까요? 보관 후에는 상세 페이지가 read-only가 됩니다.'
      : '이 경기를 다시 운영 목록으로 복원할까요?';
    if (!window.confirm(prompt)) return;

    setError('');
    let response = await apiFetch(`/matches/${matchId}/archive`, {
      method: 'POST',
      body: JSON.stringify({
        archived,
        stop_stream: archived,
      }),
    });

    if (response.status === 409) {
      const detail = await response.text();
      const confirmLive = window.confirm(`${detail}\n\n계속 진행할까요?`);
      if (!confirmLive) return;
      response = await apiFetch(`/matches/${matchId}/archive?confirm_live_action=true`, {
        method: 'POST',
        body: JSON.stringify({
          archived,
          stop_stream: archived,
        }),
      });
    }

    if (!response.ok) {
      setError((await response.text()) || (archived ? 'Failed to archive match' : 'Failed to restore match'));
      return;
    }

    await load();
  };

  const exportMatch = async (matchId: string) => {
    setError('');
    try {
      const res = await apiFetch(`/matches/${matchId}/export.csv`, {
        method: 'GET',
        headers: {},
      });
      if (!res.ok) {
        setError((await res.text()) || 'Failed to export match');
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const disposition = res.headers.get('content-disposition') || '';
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
      a.href = url;
      a.download = fileNameMatch?.[1] || `match_export_${matchId}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setError('Failed to export match');
    }
  };

  const monthLabel = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`;
  const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const lastDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0);
  const startWeekday = firstDay.getDay();
  const dayCount = lastDay.getDate();

  const countByDate = scheduleItems.reduce<Record<string, number>>((acc, item) => {
    if (!item.date) return acc;
    acc[item.date] = (acc[item.date] || 0) + 1;
    return acc;
  }, {});

  const selectedMatches = scheduleItems
    .filter((item) => item.date === selectedDate)
    .sort((a, b) => a.time.localeCompare(b.time));

  const dayCells: Array<number | null> = [];
  for (let i = 0; i < startWeekday; i += 1) dayCells.push(null);
  for (let day = 1; day <= dayCount; day += 1) dayCells.push(day);
  while (dayCells.length % 7 !== 0) dayCells.push(null);

  const liveCount = runningMatchIds.length;
  const assignedCount = useMemo(() => matches.filter((match) => !match.archived && match.operator_id).length, [matches]);
  const rtmpCount = useMemo(
    () => matches.filter((match) => !match.archived && match.metadata?.ingest_protocol === 'RTMP').length,
    [matches]
  );
  const activeMatches = useMemo(
    () => matches.filter((match) => !match.archived),
    [matches]
  );
  const archivedMatches = useMemo(
    () => matches.filter((match) => match.archived),
    [matches]
  );
  const availableClasses = useMemo(() => {
    const classes = new Set(matches.map((match) => (match.competition_class || 'K3').toUpperCase()));
    return ['ALL', ...Array.from(classes).sort()];
  }, [matches]);
  const filteredActiveMatches = useMemo(
    () =>
      activeMatches.filter((match) => classFilter === 'ALL' || (match.competition_class || 'K3').toUpperCase() === classFilter),
    [activeMatches, classFilter]
  );
  const filteredArchivedMatches = useMemo(
    () =>
      archivedMatches.filter((match) => classFilter === 'ALL' || (match.competition_class || 'K3').toUpperCase() === classFilter),
    [archivedMatches, classFilter]
  );
  const pagedActiveMatches = useMemo(
    () => filteredActiveMatches.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
    [filteredActiveMatches, activePage]
  );
  const pagedArchivedMatches = useMemo(
    () => filteredArchivedMatches.slice((archivedPage - 1) * PAGE_SIZE, archivedPage * PAGE_SIZE),
    [filteredArchivedMatches, archivedPage]
  );
  const activePageCount = Math.max(1, Math.ceil(filteredActiveMatches.length / PAGE_SIZE));
  const archivedPageCount = Math.max(1, Math.ceil(filteredArchivedMatches.length / PAGE_SIZE));

  useEffect(() => {
    setActivePage(1);
    setArchivedPage(1);
  }, [classFilter, listMode]);

  useEffect(() => {
    if (activePage > activePageCount) setActivePage(activePageCount);
  }, [activePage, activePageCount]);

  useEffect(() => {
    if (archivedPage > archivedPageCount) setArchivedPage(archivedPageCount);
  }, [archivedPage, archivedPageCount]);

  const visibleMatches = listMode === 'active' ? pagedActiveMatches : pagedArchivedMatches;
  const currentPage = listMode === 'active' ? activePage : archivedPage;
  const currentPageCount = listMode === 'active' ? activePageCount : archivedPageCount;
  const setCurrentPage = (nextPage: number) => {
    if (listMode === 'active') {
      setActivePage(nextPage);
      return;
    }
    setArchivedPage(nextPage);
  };

  return (
    <>
      <main className="page-stack">
        <section className="page-hero">
          <div className="hero-grid">
            <div className="card card-hero grid hero-card-compact">
              <div className="section-heading">
                <div>
                  <div className="sidebar-eyebrow">Overview</div>
                  <h2>운영 대시보드</h2>
                </div>
                <span className="status-pill running">Live {liveCount}</span>
              </div>
              <div className="metric-strip metric-strip-overview">
                <div className="metric-tile success">
                  <span className="muted">Total Matches</span>
                  <strong>{matches.length}</strong>
                </div>
                <div className="metric-tile tech">
                  <span className="muted">Archived</span>
                  <strong>{archivedMatches.length}</strong>
                </div>
                <div className="metric-tile">
                  <span className="muted">Assigned</span>
                  <strong>{assignedCount}</strong>
                </div>
                <div className="metric-tile">
                  <span className="muted">RTMP Pipelines</span>
                  <strong>{rtmpCount}</strong>
                </div>
              </div>
            </div>

            <div className="card card-panel grid hero-card-wide">
              <div className="section-heading">
                <div>
                  <div className="sidebar-eyebrow">Create Match</div>
                  <h3>새 경기 등록</h3>
                </div>
              </div>
              <div className="hero-form-grid compact">
                <div className="field-stack field-stack-short">
                  <div className="field-label">대회</div>
                  <select value={competitionClass} onChange={(e) => setCompetitionClass(e.target.value)}>
                    <option value="K3">K3</option>
                    <option value="WK">WK</option>
                    <option value="CUSTOM">CUSTOM</option>
                    <option value="SUFA-S">SUFA-S</option>
                    <option value="SUFA-A">SUFA-A</option>
                    <option value="SUFA-B">SUFA-B</option>
                    <option value="SUFA-L">SUFA-L</option>
                  </select>
                </div>

                <div className="field-stack field-stack-round">
                  <div className="field-label">라운드</div>
                  <input
                    min={1}
                    step={1}
                    type="number"
                    value={roundNumber}
                    onChange={(e) => setRoundNumber(Math.max(1, Number(e.target.value) || 1))}
                  />
                </div>

                <div className="field-stack field-stack-wide">
                  <div className="field-label">홈</div>
                  <input value={homeTeam} onChange={(e) => setHomeTeam(e.target.value)} placeholder="예: 당진" />
                </div>

                <div className="field-stack field-stack-wide">
                  <div className="field-label">어웨이</div>
                  <input value={awayTeam} onChange={(e) => setAwayTeam(e.target.value)} placeholder="예: 경주" />
                </div>

                <div className="field-stack field-stack-short">
                  <div className="field-label">운영모드</div>
                  <select value={streamMode} onChange={(e) => setStreamMode(e.target.value as 'STREAM' | 'MANUAL')}>
                    <option value="STREAM">STREAM</option>
                    <option value="MANUAL">MANUAL</option>
                  </select>
                </div>

                <div className="field-stack field-stack-short">
                  <div className="field-label">프로토콜</div>
                  <select value={ingestProtocol} onChange={(e) => setIngestProtocol(e.target.value as 'SRT' | 'RTMP')} disabled={streamMode !== 'STREAM'}>
                    <option value="RTMP">RTMP</option>
                    <option value="SRT">SRT</option>
                  </select>
                </div>

                <div className="field-stack">
                  <div className="field-label">operator 상속</div>
                  <label className="row operator-toggle-inline">
                    <input
                      type="checkbox"
                      checked={assignOperator}
                      onChange={(e) => setAssignOperator(e.target.checked)}
                      style={{ minHeight: 'auto', width: 18, height: 18 }}
                    />
                    <span>현재 계정 사용</span>
                  </label>
                </div>

                <div className="field-stack">
                  <div className="field-label">생성이름</div>
                  <div className="kbd dashboard-generated-name">
                    {generatedMatchName || `[${competitionClass} | ${roundNumber}R] 홈팀 vs 어웨이팀`}
                  </div>
                </div>
              </div>
              <div className="row hero-actions-compact">
                <button className="btn-primary" onClick={createMatch}>Create Match</button>
              </div>
              {error ? <p className="form-error" style={{ margin: 0 }}>{error}</p> : null}
            </div>
          </div>
        </section>

        <section className="dashboard-grid">
          <div className="card card-panel">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">Match List</div>
                <h3>{listMode === 'active' ? '운영 중인 매치' : '보관 매치'}</h3>
              </div>
            </div>

            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 16 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className={listMode === 'active' ? 'btn-active' : ''} onClick={() => setListMode('active')}>Active</button>
                <button className={listMode === 'archived' ? 'btn-active' : ''} onClick={() => setListMode('archived')}>Archived</button>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {availableClasses.map((itemClass) => (
                  <button
                    key={itemClass}
                    className={classFilter === itemClass ? 'btn-active' : ''}
                    onClick={() => setClassFilter(itemClass)}
                  >
                    {itemClass}
                  </button>
                ))}
              </div>
            </div>

            <div className="match-list">
              {visibleMatches.map((match) => {
                const isRunning = runningMatchIds.includes(match.id);
                return (
                  <div key={match.id} className="match-item">
                    <div className="grid match-item-main" style={{ gap: 8 }}>
                      <div className="row" style={{ flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 18 }}>{match.name}</strong>
                        <span className="status-pill">{match.competition_class || 'K3'}</span>
                        <span className="status-pill warning">R{match.round_number || 1}</span>
                        <span className={`status-pill ${match.archived ? 'archived' : isRunning ? 'running' : 'stopped'}`}>
                          {match.archived ? 'ARCHIVED' : isRunning ? 'RUNNING' : 'STOPPED'}
                        </span>
                      </div>
                      <div className="muted">operator: {match.operator_id || 'unassigned'}</div>
                      <div className="match-meta-group">
                        <span className={`meta-chip ${match.metadata?.stream_mode === 'MANUAL' ? 'warning' : ''}`}>
                          mode: {match.metadata?.stream_mode === 'MANUAL' ? 'manual field' : 'stream'}
                        </span>
                        <span className={`meta-chip ${match.metadata?.ingest_protocol ? 'tech' : ''}`}>
                          protocol: {match.metadata?.ingest_protocol || 'not set'}
                        </span>
                        <span className={`meta-chip ${
                          match.metadata?.stream_mode === 'MANUAL'
                            ? ''
                            : match.hls_url
                              ? 'success'
                              : 'warning'
                        }`}>
                          {match.metadata?.stream_mode === 'MANUAL'
                            ? 'no hls'
                            : match.hls_url
                              ? 'hls ready'
                              : 'hls pending'}
                        </span>
                      </div>
                      <div className="muted">
                        created: {new Date(match.created_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
                        {match.archived_at
                          ? ` / archived: ${new Date(match.archived_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}`
                          : ''}
                      </div>
                    </div>
                    <div className="match-actions">
                      <Link className="button-link button-compact btn-primary" href={`/admin/match/${match.id}`}>
                        {match.archived ? 'Open Read-Only' : 'Open'}
                      </Link>
                      {match.archived ? (
                        <Link className="button-link button-compact btn-secondary" href={`/admin/match/${match.id}/edit`}>
                          Edit Events
                        </Link>
                      ) : null}
                      <button className="button-compact btn-success" onClick={() => exportMatch(match.id)}>Export CSV</button>
                      {match.archived ? (
                        <button className="button-compact btn-secondary" onClick={() => setArchived(match.id, false)}>Restore</button>
                      ) : (
                        <>
                          <button className="button-compact btn-secondary" onClick={() => setArchived(match.id, true)}>Archive</button>
                          <button className="btn-danger button-compact" onClick={() => deleteMatch(match.id, match.name)}>Delete</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {(listMode === 'active' ? filteredActiveMatches.length : filteredArchivedMatches.length) === 0 ? (
                <div className="muted">
                  {listMode === 'active' ? 'No active matches for this class.' : 'No archived matches for this class.'}
                </div>
              ) : null}
            </div>

            {currentPageCount > 1 ? (
              <div className="pagination-bar">
                <button onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1}>
                  {'<'}
                </button>
                <div className="pagination-pages">
                  {Array.from({ length: currentPageCount }, (_, index) => {
                    const page = index + 1;
                    return (
                      <button
                        key={page}
                        className={page === currentPage ? 'btn-active' : ''}
                        onClick={() => setCurrentPage(page)}
                      >
                        {page}
                      </button>
                    );
                  })}
                </div>
                <button onClick={() => setCurrentPage(Math.min(currentPageCount, currentPage + 1))} disabled={currentPage === currentPageCount}>
                  {'>'}
                </button>
              </div>
            ) : null}
          </div>

          <div className="card card-utility">
            <div className="section-heading">
              <h3>Match Calendar</h3>
              <div className="row">
                <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>
                  Prev
                </button>
                <strong style={{ minWidth: 90, textAlign: 'center' }}>{monthLabel}</strong>
                <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>
                  Next
                </button>
              </div>
            </div>

            <div className="calendar-grid">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((weekday) => (
                <div key={weekday} className="muted" style={{ textAlign: 'center', fontWeight: 700 }}>{weekday}</div>
              ))}

              {dayCells.map((day, index) => {
                if (!day) return <div key={`empty-${index}`} />;

                const dateKey = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const count = countByDate[dateKey] || 0;
                const isSelected = selectedDate === dateKey;

                return (
                  <button
                    key={dateKey}
                    className={`day-cell ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedDate(dateKey)}
                  >
                    <div style={{ fontWeight: 700 }}>{day}</div>
                    <div className="muted" style={{ color: count > 0 ? 'var(--accent)' : undefined }}>
                      {count > 0 ? `${count} match${count > 1 ? 'es' : ''}` : '-'}
                    </div>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Fixtures on {selectedDate}</div>
              {selectedMatches.length === 0 ? (
                <div className="muted">No fixtures</div>
              ) : (
                <div className="grid">
                  {selectedMatches.map((item, index) => (
                    <div
                      key={item.id}
                      style={{
                        borderTop: index === 0 ? 'none' : '1px dashed var(--line-strong)',
                        marginTop: index === 0 ? 0 : 8,
                        paddingTop: index === 0 ? 0 : 8,
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{item.homeTeam} vs {item.awayTeam}</div>
                      <div className="muted">홈 : {item.homeTeam}</div>
                      <div className="muted">어웨이 : {item.awayTeam}</div>
                      <div className="muted">{item.time} | {item.venue}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
