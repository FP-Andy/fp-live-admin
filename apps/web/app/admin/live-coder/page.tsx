'use client';

import Link from 'next/link';
import { ConsoleToolbar, ConsoleEmpty } from '../../../components/ConsoleTools';
import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../../lib/api';
import type { MatchListItem } from '../../../components/live-coder/types';

type MatchPage = { items: MatchListItem[]; total: number };

export default function LiveCoderPage() {
  const [matches, setMatches] = useState<MatchListItem[]>([]);
  const [query, setQuery] = useState('');
  const [scoreboardFilter, setScoreboardFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
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
      } finally { if (active) setLoading(false); }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const activeMatches = useMemo(() => matches.filter(match => match.name.toLowerCase().includes(query.trim().toLowerCase()) && (scoreboardFilter === 'ALL' || (match.metadata?.broadcast?.scoreboard_visible === false ? 'OFF' : 'ON') === scoreboardFilter)), [matches, query, scoreboardFilter]);

  return (
    <main className="page-stack console-page live-coder-page">
      <p className="panel-note">경기를 선택해 OBS 중계 그래픽과 스코어보드를 제어하세요.</p>

      {error ? <div className="card card-danger">{error}</div> : null}

      <section className="card card-panel">
        <div className="section-heading">
          <h3>중계 그래픽 대상 경기</h3>
          <span className="muted">{activeMatches.length}개 경기</span>
        </div>
        <ConsoleToolbar><label className="field-stack console-search"><span className="field-label">경기 검색</span><input type="search" placeholder="팀명 또는 경기명" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="field-stack"><span className="field-label">스코어보드</span><select value={scoreboardFilter} onChange={e => setScoreboardFilter(e.target.value)}><option value="ALL">전체</option><option value="ON">표시 설정</option><option value="OFF">숨김 설정</option></select></label>{query || scoreboardFilter !== 'ALL' ? <button type="button" onClick={() => { setQuery(''); setScoreboardFilter('ALL'); }}>필터 초기화</button> : null}</ConsoleToolbar>
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
                      스코어보드 {broadcast?.scoreboard_visible === false ? '숨김' : '표시'}
                    </span>
                  </div>
                  <div className="muted">
                    created: {new Date(match.created_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
                  </div>
                </div>
                <div className="match-actions">
                  <Link className="button-link button-compact btn-primary" href={`/admin/live-coder/match/${match.id}`}>
                    그래픽 제어
                  </Link>
                  <Link className="button-link button-compact btn-secondary" href={`/admin/match/${match.id}`}>
                    경기 기록
                  </Link>
                </div>
              </div>
            );
          })}
          {!activeMatches.length ? <ConsoleEmpty title={loading ? "경기를 불러오는 중…" : "조건에 맞는 경기가 없습니다"}><Link href="/admin/dashboard">대시보드에서 경기 확인 →</Link></ConsoleEmpty> : null}
        </div>
      </section>
    </main>
  );
}
