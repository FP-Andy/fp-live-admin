'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { scheduleItems } from './schedule-data';
import { apiFetch, apiJson } from '../../../lib/api';

type Match = {
  id: string;
  name: string;
  competition_class: string;
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
  const [matches, setMatches] = useState<Match[]>([]);
  const [runningMatchIds, setRunningMatchIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [competitionClass, setCompetitionClass] = useState('K3');
  const [streamMode, setStreamMode] = useState<'STREAM' | 'MANUAL'>('STREAM');
  const [assignOperator, setAssignOperator] = useState(true);
  const [ingestProtocol, setIngestProtocol] = useState<'SRT' | 'RTMP'>('SRT');
  const [ingestUrl, setIngestUrl] = useState('');
  const [error, setError] = useState('');
  const [listMode, setListMode] = useState<'active' | 'archived'>('active');
  const [classFilter, setClassFilter] = useState('ALL');
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

  const createMatch = async () => {
    if (!name.trim()) return;
    setError('');

    const response = await apiFetch('/matches', {
      method: 'POST',
      body: JSON.stringify({
        name,
        competition_class: competitionClass,
        stream_mode: streamMode,
        assign_operator: assignOperator,
        ingest_protocol: streamMode === 'STREAM' ? ingestProtocol : null,
        ingest_url: streamMode === 'STREAM' ? (ingestUrl || null) : null,
      }),
    });

    if (!response.ok) {
      setError((await response.text()) || 'Failed to create match');
      return;
    }

    setName('');
    setCompetitionClass('K3');
    setStreamMode('STREAM');
    setAssignOperator(true);
    setIngestUrl('');
    await load();
  };

  const deleteMatch = async (matchId: string, matchName: string) => {
    const ok = window.confirm(`Delete match '${matchName}'? This removes states/events/dominance data.`);
    if (!ok) return;

    setError('');
    const response = await apiFetch(`/matches/${matchId}?stop_stream=true`, {
      method: 'DELETE',
    });

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
    const response = await apiFetch(`/matches/${matchId}/archive`, {
      method: 'POST',
      body: JSON.stringify({
        archived,
        stop_stream: archived,
      }),
    });

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

  return (
    <>
      <main className="page-stack">
        <section className="page-hero">
          <div className="hero-grid">
            <div className="card grid hero-card-compact">
              <div className="section-heading">
                <div>
                  <div className="sidebar-eyebrow">Overview</div>
                  <h2>운영 대시보드</h2>
                </div>
                <span className="status-pill running">Live {liveCount}</span>
              </div>
              <div className="metric-strip">
                <div className="metric-tile">
                  <span className="muted">Total Matches</span>
                  <strong>{matches.length}</strong>
                </div>
                <div className="metric-tile">
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

            <div className="card grid hero-card-wide">
              <div className="section-heading">
                <div>
                  <div className="sidebar-eyebrow">Create Match</div>
                  <h3>새 경기 등록</h3>
                </div>
              </div>
              <div className="form-stack">
                <div className="field-stack">
                  <div className="field-label">경기 이름</div>
                  <div className="field-help">운영 목록과 상세 화면에 표시될 매치 이름입니다.</div>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Match name" />
                </div>

                <div className="field-stack">
                  <div className="field-label">대회 클래스</div>
                  <div className="field-help">K3와 SUFA를 구분해 필터링할 때 사용합니다.</div>
                  <select value={competitionClass} onChange={(e) => setCompetitionClass(e.target.value)}>
                    <option value="K3">K3</option>
                    <option value="SUFA">SUFA</option>
                  </select>
                </div>

                <div className="field-stack">
                  <div className="field-label">운영 모드</div>
                  <div className="field-help">스트림과 HLS 플레이어가 필요한 매치인지, 현장 수기 운영용인지 선택합니다.</div>
                  <select value={streamMode} onChange={(e) => setStreamMode(e.target.value as 'STREAM' | 'MANUAL')}>
                    <option value="STREAM">Stream + HLS Player</option>
                    <option value="MANUAL">Manual Field Mode (No HLS)</option>
                  </select>
                </div>

                <div className="field-stack">
                  <div className="field-label">입력 프로토콜</div>
                  <div className="field-help">스트림 매치일 때 사용할 ingest 타입입니다.</div>
                  <select value={ingestProtocol} onChange={(e) => setIngestProtocol(e.target.value as 'SRT' | 'RTMP')} disabled={streamMode !== 'STREAM'}>
                    <option value="SRT">SRT</option>
                    <option value="RTMP">RTMP</option>
                  </select>
                </div>

                <div className="field-stack">
                  <div className="field-label">Operator 지정</div>
                  <div className="field-help">생성 직후 현재 로그인 계정을 작업 담당자로 잠글지 결정합니다.</div>
                  <label className="row" style={{ justifyContent: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={assignOperator}
                      onChange={(e) => setAssignOperator(e.target.checked)}
                      style={{ minHeight: 'auto', width: 18, height: 18 }}
                    />
                    <span>현재 로그인 계정을 operator로 지정</span>
                  </label>
                </div>

                <div className="field-stack">
                  <div className="field-label">입력 주소</div>
                  <div className="field-help">
                    {streamMode === 'STREAM'
                      ? '필요하면 SRT 또는 RTMP source URL을 바로 넣어 생성과 동시에 연결할 수 있습니다.'
                      : 'Manual Field Mode는 스트림 없이 생성되므로 입력 주소가 필요하지 않습니다.'}
                  </div>
                  {streamMode === 'STREAM' ? (
                    <input
                      value={ingestUrl}
                      onChange={(e) => setIngestUrl(e.target.value)}
                      placeholder={ingestProtocol === 'RTMP' ? 'RTMP source URL (optional)' : 'SRT URL (optional)'}
                    />
                  ) : (
                    <div className="muted">No ingest URL needed for manual matches.</div>
                  )}
                </div>
              </div>
              <button className="btn-primary" onClick={createMatch}>Create Match</button>
              {error ? <p className="form-error" style={{ margin: 0 }}>{error}</p> : null}
            </div>
          </div>
        </section>

        <section className="dashboard-grid">
          <div className="card">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">Match List</div>
                <h3>{listMode === 'active' ? '운영 중인 매치' : '보관 매치'}</h3>
              </div>
            </div>

            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
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
              {(listMode === 'active' ? filteredActiveMatches : filteredArchivedMatches).map((match) => {
                const isRunning = runningMatchIds.includes(match.id);
                return (
                  <div key={match.id} className="match-item">
                    <div className="grid match-item-main" style={{ gap: 8 }}>
                      <div className="row" style={{ flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 18 }}>{match.name}</strong>
                        <span className="status-pill">{match.competition_class || 'K3'}</span>
                        <span className={`status-pill ${isRunning ? 'running' : 'stopped'}`}>
                          {match.archived ? 'ARCHIVED' : isRunning ? 'RUNNING' : 'STOPPED'}
                        </span>
                      </div>
                      <div className="muted">operator: {match.operator_id || 'unassigned'}</div>
                      <div className="muted">
                        mode: {match.metadata?.stream_mode === 'MANUAL' ? 'manual field' : 'stream'}
                        {' / '}
                        protocol: {match.metadata?.ingest_protocol || 'not set'}
                        {match.metadata?.stream_mode === 'MANUAL'
                          ? ' / no hls'
                          : match.hls_url
                          ? ' / hls ready'
                          : ' / hls pending'}
                      </div>
                      <div className="muted">
                        created: {new Date(match.created_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
                        {match.archived_at
                          ? ` / archived: ${new Date(match.archived_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}`
                          : ''}
                      </div>
                    </div>
                    <div className="match-actions">
                      <Link className="button-link button-compact" href={`/admin/match/${match.id}`}>
                        {match.archived ? 'Open Read-Only' : 'Open'}
                      </Link>
                      <button className="button-compact" onClick={() => exportMatch(match.id)}>Export CSV</button>
                      {match.archived ? (
                        <button className="button-compact" onClick={() => setArchived(match.id, false)}>Restore</button>
                      ) : (
                        <>
                          <button className="button-compact" onClick={() => setArchived(match.id, true)}>Archive</button>
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
          </div>

          <div className="card">
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
                        borderTop: index === 0 ? 'none' : '1px dashed rgba(255,116,0,0.24)',
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
