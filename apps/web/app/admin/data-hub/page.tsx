'use client';

import { useEffect, useMemo, useState } from 'react';
import { API_BASE, apiJson } from '../../../lib/api';
import { useSportContext } from '../../../components/SportContext';

type HubMatch = {
  id: string;
  name: string;
  sport?: 'FOOTBALL' | 'BASKETBALL';
  competition_class: string;
  round_number: number;
  archived: boolean;
  created_at: string;
  has_fla_data: boolean;
  has_fpa_logs: boolean;
};

export default function DataHubPage() {
  const { sport } = useSportContext();
  const [matches, setMatches] = useState<HubMatch[]>([]);
  const [competitionFilter, setCompetitionFilter] = useState('ALL');
  const [status, setStatus] = useState('Loading data hub');

  const load = async () => {
    try {
      const data = await apiJson<HubMatch[]>(`/data-hub/matches?sport=${sport}`);
      setMatches(Array.isArray(data) ? data : []);
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Data hub unavailable');
    }
  };

  useEffect(() => {
    setCompetitionFilter('ALL');
    load();
  }, [sport]);

  const competitionOptions = useMemo(() => [
    'ALL',
    ...Array.from(new Set(matches.map((match) => match.competition_class).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko-KR')),
  ], [matches]);
  const visibleMatches = competitionFilter === 'ALL'
    ? matches
    : matches.filter((match) => match.competition_class === competitionFilter);

  return (
    <main className="page-stack">
      <section className="card card-hero page-hero">
        <div>
          <div className="sidebar-eyebrow">Shared Match Data</div>
          <h1>Data Hub</h1>
          <p>{sport === 'BASKETBALL' ? '현재 Basketball 컨텍스트의 경기 데이터를 분리해서 봅니다.' : 'FLA 경기 데이터와 저장된 FPA 분석 데이터를 같은 match 기준으로 내려받습니다.'}</p>
        </div>
      </section>

      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Downloads</div>
            <h3>{sport === 'BASKETBALL' ? '농구 경기별 데이터' : '경기별 데이터'}</h3>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <label className="field-stack dashboard-filter-select">
              <span className="field-label">대회 필터</span>
              <select value={competitionFilter} onChange={(event) => setCompetitionFilter(event.target.value)}>
                {competitionOptions.map((competitionClass) => (
                  <option key={competitionClass} value={competitionClass}>
                    {competitionClass === 'ALL' ? '전체' : competitionClass}
                  </option>
                ))}
              </select>
            </label>
            <button className="button-compact btn-secondary" onClick={load}>새로고침</button>
          </div>
        </div>
        {status ? <div className="panel-note">{status}</div> : null}
        <div className="fcm-guide-table-wrap">
          <table className="fcm-guide-table">
            <thead>
              <tr>
                <th>대회</th>
                <th>경기</th>
                <th>상태</th>
                <th>FLA</th>
                <th>FPA</th>
              </tr>
            </thead>
            <tbody>
              {visibleMatches.map((match) => (
                <tr key={match.id}>
                  <td>{match.competition_class}</td>
                  <td>{match.name}</td>
                  <td>{match.archived ? 'Archived' : 'Active'}</td>
                  <td>
                    {sport === 'FOOTBALL' ? <a className="button-link button-compact btn-success" href={`${API_BASE}/matches/${match.id}/export.csv`}>
                      Download
                    </a> : <span className="muted">Local logger export</span>}
                  </td>
                  <td>
                    {match.has_fpa_logs ? (
                      <a className="button-link button-compact btn-success" href={`${API_BASE}/fpa/matches/${match.id}/logs/export.xlsx`}>
                        Download
                      </a>
                    ) : (
                      <span className="muted">No saved logs</span>
                    )}
                  </td>
                </tr>
              ))}
              {!visibleMatches.length && !status ? (
                <tr>
                  <td colSpan={5} className="muted">No matches</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
