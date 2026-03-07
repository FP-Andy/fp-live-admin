'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

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
  const [name, setName] = useState('');
  const [ingestProtocol, setIngestProtocol] = useState<'SRT' | 'RTMP'>('SRT');
  const [ingestUrl, setIngestUrl] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await fetch(`${API_BASE}/matches`, { cache: 'no-store' });
      if (!res.ok) {
        setMatches([]);
        setError(`API unavailable (${res.status}). Run API server or infra/app compose stack.`);
        return;
      }
      const data = await res.json();
      setMatches(Array.isArray(data) ? data : []);
      setError('');
    } catch {
      setMatches([]);
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

  return (
    <main className="container grid">
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

      <div className="card">
        <h3>Matches</h3>
        <div className="grid">
          {matches.map((m) => (
            <div key={m.id} className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{m.name}</strong>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 6 }}>
                  operator: {m.operator_id || 'none'}
                </div>
              </div>
              <div className="row">
                <Link href={`/admin/match/${m.id}`}>Open</Link>
                <button className="btn-danger" onClick={() => deleteMatch(m.id, m.name)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
