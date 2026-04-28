'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../lib/api';
import { RawMatchRecord, getEligibleFcmMatches } from '../lib/fcm';

type CompetitionClass = {
  code: string;
  name: string;
  first_half_minutes: number;
  second_half_minutes: number;
  created_at: string;
};

function formatDateTime(value?: string | null) {
  if (!value) return '미보관';
  return new Date(value).toLocaleString('ko-KR', {
    hour12: false,
    timeZone: 'Asia/Seoul',
  });
}

export default function FcmMatchStatusPage() {
  const [matches, setMatches] = useState<RawMatchRecord[]>([]);
  const [competitionClasses, setCompetitionClasses] = useState<CompetitionClass[]>([]);
  const [classFilter, setClassFilter] = useState('ALL');
  const [roundFilter, setRoundFilter] = useState('ALL');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const [matchData, classData] = await Promise.all([
          apiJson<RawMatchRecord[]>('/matches'),
          apiJson<CompetitionClass[]>('/competition-classes').catch(() => []),
        ]);
        if (!active) return;
        setMatches(Array.isArray(matchData) ? matchData : []);
        setCompetitionClasses(Array.isArray(classData) ? classData : []);
        setError('');
      } catch (loadError) {
        if (!active) return;
        setMatches([]);
        setError(loadError instanceof Error ? loadError.message : '매치 상태를 불러오지 못했습니다.');
      } finally {
        if (active) setLoading(false);
      }
    };

    load();
    return () => {
      active = false;
    };
  }, []);

  const archivedMatches = useMemo(() => getEligibleFcmMatches(matches), [matches]);
  const classFilterOptions = useMemo(() => {
    const codes = new Set([
      ...competitionClasses.map((item) => item.code),
      ...archivedMatches.map((match) => match.competitionClass),
    ]);
    return ['ALL', ...Array.from(codes).sort()];
  }, [archivedMatches, competitionClasses]);
  const roundFilterOptions = useMemo(() => {
    const source = classFilter === 'ALL'
      ? archivedMatches
      : archivedMatches.filter((match) => match.competitionClass === classFilter);
    const rounds = Array.from(new Set(source.map((match) => match.roundNumber).filter((round) => Number.isFinite(round) && round > 0)))
      .sort((a, b) => b - a);
    return ['ALL', ...rounds.map((round) => String(round))];
  }, [archivedMatches, classFilter]);

  useEffect(() => {
    if (!roundFilterOptions.includes(roundFilter)) {
      setRoundFilter('ALL');
    }
  }, [roundFilter, roundFilterOptions]);

  const filteredMatches = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    return archivedMatches.filter((match) => {
      const className = match.competitionClass;
      const classOk = classFilter === 'ALL' || className === classFilter;
      const roundOk = roundFilter === 'ALL' || String(match.roundNumber) === roundFilter;
      const queryOk =
        !lowered ||
        match.name.toLowerCase().includes(lowered) ||
        className.toLowerCase().includes(lowered) ||
        String(match.roundNumber || '').includes(lowered) ||
        match.homeTeam.toLowerCase().includes(lowered) ||
        match.awayTeam.toLowerCase().includes(lowered) ||
        (match.operatorId || '').toLowerCase().includes(lowered);
      return classOk && roundOk && queryOk;
    });
  }, [archivedMatches, classFilter, query, roundFilter]);

  const summary = useMemo(() => {
    const classCount = new Set(archivedMatches.map((match) => match.competitionClass)).size;
    return {
      total: archivedMatches.length,
      classCount,
      ready: filteredMatches.length,
      selected: classFilter === 'ALL' ? archivedMatches.length : archivedMatches.filter((match) => match.competitionClass === classFilter).length,
    };
  }, [archivedMatches, classFilter, filteredMatches]);

  return (
    <div className="page-stack">
      <section className="grid" style={{ gridTemplateColumns: '1.05fr 1.95fr' }}>
        <aside className="card card-panel fcm-filter-panel">
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">필터</div>
              <h3 style={{ margin: '6px 0 0' }}>Archived Match Pool</h3>
            </div>
          </div>

          <label className="field-stack">
            <span className="field-label">매치 검색</span>
            <input
              placeholder="팀명, 리그, 작업자"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="fvc-sidebar-section">
            <label className="field-stack">
              <span className="field-label">대회 필터</span>
              <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)}>
                {classFilterOptions.map((filter) => (
                  <option key={filter} value={filter}>
                    {filter === 'ALL' ? '전체' : filter}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="fvc-sidebar-section">
            <label className="field-stack">
              <span className="field-label">라운드 필터</span>
              <select value={roundFilter} onChange={(event) => setRoundFilter(event.target.value)}>
                {roundFilterOptions.map((filter) => (
                  <option key={filter} value={filter}>
                    {filter === 'ALL' ? '전체 라운드' : `${filter}라운드`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </aside>

        <div className="page-stack">
          <section className="card card-panel">
            <div className="fvc-summary-grid">
              <div className="metric-tile">
                <div className="sidebar-eyebrow">전체 아카이브</div>
                <strong>{summary.total}</strong>
              </div>
              <div className="metric-tile tech">
                <div className="sidebar-eyebrow">대회 수</div>
                <strong>{summary.classCount}</strong>
              </div>
              <div className="metric-tile success">
                <div className="sidebar-eyebrow">선택 대회</div>
                <strong>{summary.selected}</strong>
              </div>
              <div className="metric-tile">
                <div className="sidebar-eyebrow">현재 필터 결과</div>
                <strong>{summary.ready}</strong>
              </div>
            </div>
          </section>

          <section className="card card-panel">
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">경기 목록</div>
                <h3 style={{ margin: '6px 0 0' }}>카드 제작 대상 경기</h3>
              </div>
            </div>

            {loading ? <p className="field-help">경기 목록을 불러오는 중입니다.</p> : null}
            {error ? <p className="field-help" style={{ color: '#ff9c8f' }}>{error}</p> : null}

            <div className="fcm-match-list">
              {filteredMatches.map((match) => (
                <Link className="fcm-match-card" href={`/admin/fcm/match-status/${match.id}`} key={match.id}>
                  <div className="section-heading">
                    <div>
                      <div className="sidebar-eyebrow">{match.competitionClass}</div>
                      <strong>{match.name}</strong>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="status-pill warning">R{match.roundNumber}</span>
                      <span className="status-pill archived">ARCHIVED</span>
                    </div>
                  </div>
                  <p className="field-help" style={{ margin: '10px 0 0' }}>
                    {match.homeTeam} vs {match.awayTeam}
                    {' / '}
                    archived {formatDateTime(match.archivedAt)}
                    {match.operatorId ? ` / operator ${match.operatorId}` : ''}
                  </p>
                  <div className="fcm-chip-list">
                    <span className="fcm-chip">엑셀 업로드</span>
                    <span className="fcm-chip">주요스탯 선택</span>
                    <span className="fcm-chip">시트 제출</span>
                  </div>
                </Link>
              ))}
            </div>

            {!loading && !error && filteredMatches.length === 0 ? (
              <p className="field-help">조건에 맞는 archived match가 없습니다.</p>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
