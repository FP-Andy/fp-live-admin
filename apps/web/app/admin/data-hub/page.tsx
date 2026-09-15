'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ConsoleToolbar } from '../../../components/ConsoleTools';
import { API_BASE, apiJson } from '../../../lib/api';
import { useSportContext } from '../../../components/SportContext';

type HubMatch = {
  id: string;
  name: string;
  sport?: 'FOOTBALL' | 'BASKETBALL' | 'FUTSAL';
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
  const [query, setQuery] = useState('');
  const [dataFilter, setDataFilter] = useState('ALL');
  const [competitionFilter, setCompetitionFilter] = useState('ALL');
  const [status, setStatus] = useState('Loading data hub');
  const loadRequestRef = useRef(0);

  const load = async () => {
    const requestId = ++loadRequestRef.current;
    setStatus('Loading data hub');
    try {
      const data = await apiJson<HubMatch[]>(`/data-hub/matches?sport=${sport}`);
      // SportContext는 클라이언트에서 복원된다. 초기 FOOTBALL 요청이 늦게
      // 끝나도 뒤이어 선택된 FUTSAL/BASKETBALL 목록을 덮어쓰면 안 된다.
      if (requestId !== loadRequestRef.current) return;
      setMatches(Array.isArray(data) ? data : []);
      setStatus('');
    } catch (error) {
      if (requestId !== loadRequestRef.current) return;
      setStatus(error instanceof Error ? error.message : 'Data hub unavailable');
    }
  };

  useEffect(() => {
    setCompetitionFilter('ALL');
    setDataFilter('ALL');
    load();
  }, [sport]);

  const competitionOptions = useMemo(() => [
    'ALL',
    ...Array.from(new Set(matches.map((match) => match.competition_class).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko-KR')),
  ], [matches]);
  const visibleMatches = matches.filter(match => (competitionFilter === 'ALL' || match.competition_class === competitionFilter)
    && match.name.toLowerCase().includes(query.trim().toLowerCase())
    && (dataFilter === 'ALL' || dataFilter === 'FLA' && match.has_fla_data || dataFilter === 'FPA' && match.has_fpa_logs));

  return (
    <main className="page-stack console-page data-hub-page">

      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Downloads</div>
            <h3>{sport === 'BASKETBALL' ? '농구 경기별 데이터' : sport === 'FUTSAL' ? '풋살 경기별 데이터' : '경기별 데이터'}</h3>
          </div>
          <div className="data-hub-header-actions">
            <label className="field-stack">
              <span className="field-label">대회 필터</span>
              <select value={competitionFilter} onChange={(event) => setCompetitionFilter(event.target.value)}>
                {competitionOptions.map((competitionClass) => (
                  <option key={competitionClass} value={competitionClass}>
                    {competitionClass === 'ALL' ? '전체' : competitionClass}
                  </option>
                ))}
              </select>
            </label>
            <button className="button-compact btn-secondary" disabled={status === 'Loading data hub'} onClick={load}>새로고침</button>
          </div>
        </div>
        <ConsoleToolbar><label className="field-stack console-search"><span className="field-label">경기 검색</span><input type="search" placeholder="팀명 또는 경기명" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="field-stack"><span className="field-label">보유 데이터</span><select value={dataFilter} onChange={e => setDataFilter(e.target.value)}><option value="ALL">전체</option><option value="FLA">FLA 데이터 있음</option><option value="FPA">FPA 기록 있음</option></select></label><span className="muted" role="status">{visibleMatches.length}개 경기</span><button onClick={() => { setQuery(''); setDataFilter('ALL'); setCompetitionFilter('ALL'); }}>초기화</button></ConsoleToolbar>
        {status ? <div className="panel-note">{status}</div> : null}
        <div className="fcm-guide-table-wrap">
          <table className="fcm-guide-table console-responsive-table">
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
                  <td data-label="대회">{match.competition_class}</td>
                  <td data-label="경기">{match.name}</td>
                  <td data-label="상태">{match.archived ? '보관' : '진행'}</td>
                  <td data-label="FLA">
                    {sport === 'FOOTBALL' && match.has_fla_data ? <a className="button-link button-compact btn-success" href={`${API_BASE}/matches/${match.id}/export.csv`}>
                      FLA CSV ↓
                    </a> : <span className="muted">{sport === 'FOOTBALL' ? 'FLA 데이터 없음' : '경기 화면에서 내보내기'}</span>}
                  </td>
                  <td data-label="FPA">
                    {match.has_fpa_logs ? (
                      <a className="button-link button-compact btn-success" href={`${API_BASE}/fpa/matches/${match.id}/logs/export.xlsx`}>
                        FPA Excel ↓
                      </a>
                    ) : (
                      <span className="muted">FPA 기록 없음</span>
                    )}
                  </td>
                </tr>
              ))}
              {!visibleMatches.length && !status ? (
                <tr>
                  <td colSpan={5} className="muted">조건에 맞는 경기가 없습니다</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
