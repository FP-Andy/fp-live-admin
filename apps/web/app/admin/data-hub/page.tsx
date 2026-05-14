'use client';

import { useEffect, useState } from 'react';
import { API_BASE, apiJson } from '../../../lib/api';

type HubMatch = {
  id: string;
  name: string;
  competition_class: string;
  round_number: number;
  archived: boolean;
  created_at: string;
  has_fla_data: boolean;
  has_fpa_logs: boolean;
};

export default function DataHubPage() {
  const [matches, setMatches] = useState<HubMatch[]>([]);
  const [status, setStatus] = useState('Loading data hub');

  const load = async () => {
    try {
      const data = await apiJson<HubMatch[]>('/data-hub/matches');
      setMatches(Array.isArray(data) ? data : []);
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Data hub unavailable');
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <main className="page-stack">
      <section className="card card-hero page-hero">
        <div>
          <div className="sidebar-eyebrow">Shared Match Data</div>
          <h1>Data Hub</h1>
          <p>FLA 경기 데이터와 저장된 FPA 분석 데이터를 같은 match 기준으로 내려받습니다.</p>
        </div>
      </section>

      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Downloads</div>
            <h3>경기별 데이터</h3>
          </div>
          <button className="button-compact btn-secondary" onClick={load}>새로고침</button>
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
              {matches.map((match) => (
                <tr key={match.id}>
                  <td>{match.competition_class}</td>
                  <td>{match.name}</td>
                  <td>{match.archived ? 'Archived' : 'Active'}</td>
                  <td>
                    <a className="button-link button-compact btn-success" href={`${API_BASE}/matches/${match.id}/export.csv`}>
                      Download
                    </a>
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
              {!matches.length && !status ? (
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
