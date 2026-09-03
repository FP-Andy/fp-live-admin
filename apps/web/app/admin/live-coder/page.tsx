'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../../lib/api';
import type { MatchListItem } from '../../../components/live-coder/types';

type MatchPage = { items: MatchListItem[]; total: number };

export default function LiveCoderPage() {
  const [matches, setMatches] = useState<MatchListItem[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await apiJson<MatchPage>('/matches/page?sport=FOOTBALL&archived=false&limit=100&compact=true');
        if (active) {
          setMatches(Array.isArray(data.items) ? data.items : []);
          setError('');
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Live Coder matches unavailable');
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const activeMatches = useMemo(() => matches, [matches]);

  return (
    <main className="page-stack live-coder-page">
      <section className="card card-hero">
        <div className="section-heading">
          <div>
            <span className="status-pill tech">FLA Broadcast</span>
            <h2>Live Coder</h2>
            <p className="muted">FLA 경기 데이터를 OBS Browser Source용 그래픽 상태로 송출합니다.</p>
          </div>
        </div>
      </section>

      {error ? <div className="card card-danger">{error}</div> : null}

      <section className="card card-panel">
        <div className="section-heading">
          <h3>Football Matches</h3>
          <span className="muted">{activeMatches.length} active</span>
        </div>
        <div className="match-list live-coder-match-list">
          {activeMatches.map((match) => {
            const broadcast = match.metadata?.broadcast;
            return (
              <div className="match-item" key={match.id}>
                <div className="match-item-main">
                  <div className="row">
                    <strong>{match.name}</strong>
                    <span className="status-pill">{match.competition_class} · {match.round_number}R</span>
                    <span className={`status-pill ${broadcast?.scoreboard_visible === false ? 'warning' : 'running'}`}>
                      scoreboard {broadcast?.scoreboard_visible === false ? 'off' : 'on'}
                    </span>
                  </div>
                  <div className="muted">
                    created: {new Date(match.created_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
                  </div>
                </div>
                <div className="match-actions">
                  <Link className="button-link button-compact btn-primary" href={`/admin/live-coder/match/${match.id}`}>
                    Open Live Coder
                  </Link>
                  <Link className="button-link button-compact btn-secondary" href={`/admin/match/${match.id}`}>
                    FLA Control
                  </Link>
                </div>
              </div>
            );
          })}
          {!activeMatches.length ? <div className="muted">No active football matches.</div> : null}
        </div>
      </section>
    </main>
  );
}
