'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { scheduleItems } from './schedule-data';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '/api';

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

export default function Dashboard() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [runningMatchIds, setRunningMatchIds] = useState<string[]>([]);
  const [name, setName] = useState('');
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
      const [matchesRes, streamStatusRes] = await Promise.all([
        fetch(`${API_BASE}/matches`, { cache: 'no-store' }),
        fetch(`${API_BASE}/admin/streams/status`, { cache: 'no-store' }),
      ]);

      if (!matchesRes.ok) {
        setMatches([]);
        setRunningMatchIds([]);
        setError(`API unavailable (${matchesRes.status}). Run API server or infra/app compose stack.`);
        return;
      }

      const data = await matchesRes.json();
      setMatches(Array.isArray(data) ? data : []);
      if (streamStatusRes.ok) {
        const statusData = await streamStatusRes.json();
        setRunningMatchIds(Array.isArray(statusData.running_match_ids) ? statusData.running_match_ids : []);
      } else {
        setRunningMatchIds([]);
      }
      setError('');
    } catch {
      setMatches([]);
      setRunningMatchIds([]);
      setError('API unavailable. Run API server or infra/app compose stack.');
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, []);

  const createMatch = async () => {
    if (!name.trim()) return;
    setError('');
    const res = await fetch(`${API_BASE}/matches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        ingest_protocol: ingestProtocol,
        ingest_url: ingestUrl || null,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      setError(txt || 'Failed to create match');
      return;
    }
    setName('');
    setIngestUrl('');
    await load();
  };

  const deleteMatch = async (matchId: string, matchName: string) => {
    const ok = window.confirm(`Delete match '${matchName}'? This removes states/events/dominance data.`);
    if (!ok) return;

    setError('');
    const res = await fetch(`${API_BASE}/matches/${matchId}?stop_stream=true`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const txt = await res.text();
      setError(txt || 'Failed to delete match');
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
  const attachedMatches = matches.filter((m) => runningMatchIds.includes(m.id));

  const dayCells: Array<number | null> = [];
  for (let i = 0; i < startWeekday; i += 1) dayCells.push(null);
  for (let day = 1; day <= dayCount; day += 1) dayCells.push(day);
  while (dayCells.length % 7 !== 0) dayCells.push(null);

  return (
    <>
      <main className="container grid">
        <h1 style={{ margin: 0 }}>Live Match Admin</h1>
        <div className="card">
          <h2>Dashboard</h2>
          <div className="row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Match name" />
            <select value={ingestProtocol} onChange={(e) => setIngestProtocol(e.target.value as 'SRT' | 'RTMP')}>
              <option value="SRT">SRT</option>
              <option value="RTMP">RTMP</option>
            </select>
            <input
              value={ingestUrl}
              onChange={(e) => setIngestUrl(e.target.value)}
              placeholder={
                ingestProtocol === 'RTMP'
                  ? 'RTMP source URL (optional: empty => use match stream key)'
                  : 'SRT URL (optional)'
              }
              style={{ minWidth: 360 }}
            />
            <button className="btn-primary" onClick={createMatch}>Create Match</button>
          </div>
          {error ? <p className="muted" style={{ color: '#fca5a5' }}>{error}</p> : null}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))',
            gap: 12,
            alignItems: 'start',
          }}
        >
          <div className="card">
            <h3>Matches</h3>
            <div className="grid">
              {matches.map((m, idx) => {
                const isRunning = runningMatchIds.includes(m.id);
                return (
                  <div
                    key={m.id}
                    className="row"
                    style={{
                      justifyContent: 'space-between',
                      borderTop: idx === 0 ? 'none' : '1px dashed rgba(148,163,184,0.45)',
                      marginTop: idx === 0 ? 0 : 10,
                      paddingTop: idx === 0 ? 0 : 10,
                    }}
                  >
                    <div>
                      <div className="row" style={{ gap: 10 }}>
                        <div style={{ fontSize: 18, fontWeight: 700 }}>{m.name}</div>
                        <span
                          style={{
                            fontSize: 12,
                            padding: '2px 8px',
                            borderRadius: 999,
                            border: `1px solid ${isRunning ? '#22c55e' : '#475569'}`,
                            color: isRunning ? '#86efac' : '#cbd5e1',
                            background: isRunning ? 'rgba(20,83,45,0.45)' : 'rgba(51,65,85,0.45)',
                          }}
                        >
                          {isRunning ? 'RUNNING' : 'STOPPED'}
                        </span>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 400, color: '#7dd3fc', marginTop: 6 }}>
                        operator: {m.operator_id || 'none'}
                      </div>
                    </div>
                    <div className="row">
                      <Link href={`/admin/match/${m.id}`}>Open</Link>
                      <button className="btn-danger" onClick={() => deleteMatch(m.id, m.name)}>Delete</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>Match Calendar</h3>
              <div className="row">
                <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>
                  Prev
                </button>
                <div style={{ minWidth: 90, textAlign: 'center', fontWeight: 700 }}>{monthLabel}</div>
                <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>
                  Next
                </button>
              </div>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
                gap: 8,
                marginTop: 12,
              }}
            >
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => (
                <div key={w} className="muted" style={{ textAlign: 'center', fontWeight: 700 }}>{w}</div>
              ))}
              {dayCells.map((day, idx) => {
                if (!day) return <div key={`empty-${idx}`} />;
                const dateKey = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const count = countByDate[dateKey] || 0;
                const isSelected = selectedDate === dateKey;
                return (
                  <button
                    key={dateKey}
                    onClick={() => setSelectedDate(dateKey)}
                    style={{
                      width: '100%',
                      minHeight: 56,
                      border: isSelected ? '1px solid #38bdf8' : '1px solid #334155',
                      background: isSelected ? '#0b3a57' : '#0f172a',
                      borderRadius: 8,
                      textAlign: 'left',
                      padding: 8,
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>{day}</div>
                    <div className="muted" style={{ color: count > 0 ? '#7dd3fc' : undefined }}>
                      {count > 0 ? `${count} match${count > 1 ? 'es' : ''}` : '-'}
                    </div>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Fixtures on {selectedDate}</div>
              {selectedMatches.length === 0 ? (
                <div className="muted">No fixtures</div>
              ) : (
                <div className="grid">
                  {selectedMatches.map((item, idx) => (
                    <div
                      key={item.id}
                      style={{
                        borderTop: idx === 0 ? 'none' : '1px dashed rgba(148,163,184,0.45)',
                        marginTop: idx === 0 ? 0 : 8,
                        paddingTop: idx === 0 ? 0 : 8,
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{item.homeTeam} vs {item.awayTeam}</div>
                      <div className="muted">{item.time} | {item.venue}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>Attached Matches</h3>
            <div className="muted">{attachedMatches.length} attached</div>
          </div>
          {attachedMatches.length === 0 ? (
            <div className="muted" style={{ marginTop: 8 }}>No attached matches</div>
          ) : (
            <div className="grid" style={{ marginTop: 8 }}>
              {attachedMatches.map((m, idx) => (
                <div
                  key={m.id}
                  className="row"
                  style={{
                    justifyContent: 'space-between',
                    borderTop: idx === 0 ? 'none' : '1px dashed rgba(148,163,184,0.45)',
                    marginTop: idx === 0 ? 0 : 8,
                    paddingTop: idx === 0 ? 0 : 8,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700 }}>{m.name}</div>
                    <div className="muted">{m.id}</div>
                  </div>
                  <Link href={`/admin/match/${m.id}`}>Open</Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
      <footer
        style={{
          marginTop: 24,
          backgroundColor: '#1f2937',
          color: '#e5e7eb',
          padding: '20px 24px',
          lineHeight: 1.7,
          fontSize: 14,
        }}
      >
        <div>(주)파인루터스</div>
        <div>대표이사 : 이용근</div>
        <div>사업자등록번호 : 804-59-00695</div>
        <div>연락처 : 010-6343-1823</div>
        <div>이메일 : official@fineplay.kr</div>
        <div>카피라이트 파인루터스</div>
      </footer>
    </>
  );
}
