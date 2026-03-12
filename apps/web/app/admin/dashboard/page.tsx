'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { scheduleItems } from './schedule-data';
import { apiFetch, apiJson } from '../../../lib/api';

type Match = {
  id: string;
  name: string;
  hls_url?: string;
  metadata?: {
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
  const [assignOperator, setAssignOperator] = useState(true);
  const [ingestProtocol, setIngestProtocol] = useState<'SRT' | 'RTMP'>('SRT');
  const [ingestUrl, setIngestUrl] = useState('');
  const [error, setError] = useState('');
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
        assign_operator: assignOperator,
        ingest_protocol: ingestProtocol,
        ingest_url: ingestUrl || null,
      }),
    });

    if (!response.ok) {
      setError((await response.text()) || 'Failed to create match');
      return;
    }

    setName('');
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
  const assignedCount = useMemo(() => matches.filter((match) => match.operator_id).length, [matches]);
  const rtmpCount = useMemo(
    () => matches.filter((match) => match.metadata?.ingest_protocol === 'RTMP').length,
    [matches]
  );

  return (
    <>
      <main className="page-stack">
        <section className="page-hero">
          <div className="hero-grid">
            <div className="card grid">
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
                  <span className="muted">Assigned</span>
                  <strong>{assignedCount}</strong>
                </div>
                <div className="metric-tile">
                  <span className="muted">RTMP Pipelines</span>
                  <strong>{rtmpCount}</strong>
                </div>
              </div>
            </div>

            <div className="card grid">
              <div className="section-heading">
                <div>
                  <div className="sidebar-eyebrow">Create Match</div>
                  <h3>새 경기 등록</h3>
                </div>
              </div>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Match name" />
              <select value={ingestProtocol} onChange={(e) => setIngestProtocol(e.target.value as 'SRT' | 'RTMP')}>
                <option value="SRT">SRT</option>
                <option value="RTMP">RTMP</option>
              </select>
              <label className="row" style={{ justifyContent: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={assignOperator}
                  onChange={(e) => setAssignOperator(e.target.checked)}
                  style={{ minHeight: 'auto', width: 18, height: 18 }}
                />
                <span>현재 로그인 계정을 operator로 지정</span>
              </label>
              <input
                value={ingestUrl}
                onChange={(e) => setIngestUrl(e.target.value)}
                placeholder={ingestProtocol === 'RTMP' ? 'RTMP source URL (optional)' : 'SRT URL (optional)'}
              />
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
                <h3>운영 중인 매치</h3>
              </div>
            </div>

            <div className="match-list">
              {matches.map((match) => {
                const isRunning = runningMatchIds.includes(match.id);
                return (
                  <div key={match.id} className="match-item">
                    <div className="grid" style={{ gap: 8 }}>
                      <div className="row">
                        <strong style={{ fontSize: 18 }}>{match.name}</strong>
                        <span className={`status-pill ${isRunning ? 'running' : 'stopped'}`}>
                          {isRunning ? 'RUNNING' : 'STOPPED'}
                        </span>
                      </div>
                      <div className="muted">operator: {match.operator_id || 'unassigned'}</div>
                      <div className="muted">
                        protocol: {match.metadata?.ingest_protocol || 'not set'}
                        {match.hls_url ? ' / hls ready' : ' / hls pending'}
                      </div>
                    </div>
                    <div className="row">
                      <Link href={`/admin/match/${match.id}`}>Open</Link>
                      <button className="btn-danger" onClick={() => deleteMatch(match.id, match.name)}>Delete</button>
                    </div>
                  </div>
                );
              })}
              {matches.length === 0 ? <div className="muted">No matches yet.</div> : null}
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
