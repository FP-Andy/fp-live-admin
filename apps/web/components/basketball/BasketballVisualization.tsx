'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ZONES, type ZoneId } from './BasketballMatchControl';
import { apiJson } from '../../lib/api';

type Team = 'HOME' | 'AWAY';

type GameEvent = {
  id: string;
  type: 'SHOT' | 'REBOUND';
  team: Team;
  period: number;
  clock: string;
  timestamp: number;
  zoneId?: ZoneId;
  shotResult?: 'MADE' | 'MISSED';
  points?: 1 | 2 | 3;
  reboundType?: 'AR' | 'DR';
  reboundAllowedTeam?: Team;
  homeScoreAfter: number;
  awayScoreAfter: number;
  marginAfter: number;
};

type BasketballMatch = {
  id: string;
  name: string;
  archived: boolean;
  created_at: string;
  metadata?: {
    home_team?: string;
    away_team?: string;
    period_count?: number;
    period_minutes?: number;
  } | null;
};

type BasketballState = {
  events?: GameEvent[];
  timer?: {
    period?: number;
    clock?: string;
    running?: boolean;
  } | null;
  updated_at?: string | null;
};

type ZoneSummary = { attempts: number; made: number; points: number };
type ReboundStats = Record<Team, { ar: number; dr: number; ra: number }>;

const COURT_WIDTH = 722;
const COURT_HEIGHT = 678;
const HOME_COLOR = '#ff7900';
const AWAY_COLOR = '#1e63dc';


function parseClockSeconds(clock: string | undefined) {
  const [minutesRaw, secondsRaw = '0'] = String(clock || '0:00').split(':');
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return 0;
  return Math.max(0, minutes * 60 + seconds);
}

function zoneFill(points: number) {
  if (points >= 10) return '#177c40';
  if (points > 0) return '#9d7d09';
  return '#94272b';
}

function percentage(value: number, total: number) {
  if (!total) return '0.0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function teamName(match: BasketballMatch | null, team: Team) {
  const fallback = team === 'HOME' ? 'HOME' : 'AWAY';
  return team === 'HOME' ? match?.metadata?.home_team || fallback : match?.metadata?.away_team || fallback;
}

function getScore(events: GameEvent[]) {
  return events.reduce(
    (score, event) => ({ home: event.homeScoreAfter ?? score.home, away: event.awayScoreAfter ?? score.away }),
    { home: 0, away: 0 }
  );
}

function getZoneStats(events: GameEvent[], team: Team) {
  const stats = new Map<ZoneId, ZoneSummary>();
  ZONES.forEach((zone) => stats.set(zone.id, { attempts: 0, made: 0, points: 0 }));
  events.forEach((event) => {
    if (event.type !== 'SHOT' || event.team !== team || !event.zoneId) return;
    const current = stats.get(event.zoneId);
    if (!current) return;
    current.attempts += 1;
    if (event.shotResult === 'MADE') {
      current.made += 1;
      current.points += Number(event.points || 0);
    }
  });
  return stats;
}

function getRebounds(events: GameEvent[]): ReboundStats {
  const stats: ReboundStats = {
    HOME: { ar: 0, dr: 0, ra: 0 },
    AWAY: { ar: 0, dr: 0, ra: 0 },
  };
  events.forEach((event) => {
    if (event.type !== 'REBOUND') return;
    if (event.reboundType === 'AR') stats[event.team].ar += 1;
    if (event.reboundType === 'DR') stats[event.team].dr += 1;
    if (event.reboundAllowedTeam === 'HOME' || event.reboundAllowedTeam === 'AWAY') stats[event.reboundAllowedTeam].ra += 1;
  });
  return stats;
}

function elapsedSeconds(event: GameEvent, periodMinutes: number, periodCount: number) {
  const periodSeconds = periodMinutes * 60;
  const period = Math.min(Math.max(Number(event.period) || 1, 1), periodCount);
  return Math.min(periodCount * periodSeconds, (period - 1) * periodSeconds + Math.max(0, periodSeconds - parseClockSeconds(event.clock)));
}

function ShotMap({ team, events }: { team: Team; events: GameEvent[] }) {
  const stats = useMemo(() => getZoneStats(events, team), [events, team]);
  const totals = useMemo(() => {
    return Array.from(stats.values()).reduce(
      (result, zone) => ({ attempts: result.attempts + zone.attempts, made: result.made + zone.made, points: result.points + zone.points }),
      { attempts: 0, made: 0, points: 0 }
    );
  }, [stats]);

  return (
    <article className={`basketball-viz-shot-map ${team.toLowerCase()}`}>
      <div className="basketball-viz-map-heading">
        <div>
          <span>{team === 'HOME' ? 'HOME' : 'AWAY'} SHOT MAP</span>
          <strong>{team === 'HOME' ? '홈팀 구역별 득점' : '원정팀 구역별 득점'}</strong>
        </div>
        <div className="basketball-viz-map-total">
          <b>{totals.points}</b>
          <span>PTS · {totals.made}/{totals.attempts}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${COURT_WIDTH} ${COURT_HEIGHT}`} className="basketball-viz-court" role="img" aria-label={`${team === 'HOME' ? '홈팀' : '원정팀'} 구역별 샷맵`}>
        <rect x="0" y="0" width={COURT_WIDTH} height={COURT_HEIGHT} fill="#323232" />
        {ZONES.map((zone) => {
          const summary = stats.get(zone.id) || { attempts: 0, made: 0, points: 0 };
          return (
            <g key={zone.id}>
              <path d={zone.d} fill={zoneFill(summary.points)} className="basketball-viz-zone" />
              <text x={zone.textX} y={zone.textY - 5} className="basketball-viz-zone-points" textAnchor="middle">{summary.points}</text>
              <text x={zone.textX} y={zone.textY + 14} className="basketball-viz-zone-detail" textAnchor="middle">{summary.made}/{summary.attempts}</text>
            </g>
          );
        })}
        <image href="/basketball-shot-zones.png" x="0" y="0" width={COURT_WIDTH} height={COURT_HEIGHT} preserveAspectRatio="none" className="basketball-viz-court-lines" />
      </svg>
      <div className="basketball-viz-map-note">숫자: 득점 · 하단: 성공/시도</div>
    </article>
  );
}

function MarginFlow({ events, periodMinutes, periodCount }: { events: GameEvent[]; periodMinutes: number; periodCount: number }) {
  const scoringEvents = useMemo(() => events
    .filter((event) => event.type === 'SHOT' && event.shotResult === 'MADE')
    .slice()
    .sort((left, right) => elapsedSeconds(left, periodMinutes, periodCount) - elapsedSeconds(right, periodMinutes, periodCount) || left.timestamp - right.timestamp), [events, periodMinutes, periodCount]);
  const totalSeconds = Math.max(1, periodMinutes * 60 * periodCount);
  const maxMargin = Math.max(8, ...scoringEvents.map((event) => Math.abs(event.marginAfter || 0)));
  const scale = Math.ceil(maxMargin / 4) * 4;
  const zeroY = 120;
  const x = (seconds: number) => (seconds / totalSeconds) * 960;
  const y = (margin: number) => zeroY - (margin / scale) * 94;
  const segments = [`0,${zeroY}`];
  let previousY = zeroY;
  scoringEvents.forEach((event) => {
    const eventX = x(elapsedSeconds(event, periodMinutes, periodCount));
    const eventY = y(event.marginAfter || 0);
    segments.push(`${eventX},${previousY}`, `${eventX},${eventY}`);
    previousY = eventY;
  });
  segments.push(`960,${previousY}`);
  const stepLine = segments.join(' ');
  const area = `${stepLine} 960,${zeroY} 0,${zeroY}`;

  return (
    <article className="basketball-viz-margin-panel">
      <div className="basketball-viz-panel-heading">
        <div>
          <span>MARGIN FLOW</span>
          <strong>득점 마진 플로우</strong>
        </div>
        <p><i className="home" /> 홈팀 우세 <i className="away" /> 원정팀 우세</p>
      </div>
      <svg viewBox="-38 0 1036 280" className="basketball-viz-margin-chart" role="img" aria-label="득점 마진 플로우">
        <defs>
          <clipPath id="basketball-viz-positive"><rect x="0" y="0" width="960" height={zeroY} /></clipPath>
          <clipPath id="basketball-viz-negative"><rect x="0" y={zeroY} width="960" height="240" /></clipPath>
        </defs>
        <g className="basketball-viz-margin-grid">
          {[-scale, -scale / 2, 0, scale / 2, scale].map((value) => (
            <g key={value}>
              <line x1="0" x2="960" y1={y(value)} y2={y(value)} />
              <text x="-12" y={y(value) + 4} textAnchor="end">{value > 0 ? `+${value}` : value}</text>
            </g>
          ))}
          {Array.from({ length: periodCount + 1 }, (_, index) => index).map((index) => {
            const markerX = (index / periodCount) * 960;
            return <line key={index} x1={markerX} x2={markerX} y1="14" y2="230" />;
          })}
        </g>
        <polygon points={area} className="basketball-viz-margin-home-fill" clipPath="url(#basketball-viz-positive)" />
        <polygon points={area} className="basketball-viz-margin-away-fill" clipPath="url(#basketball-viz-negative)" />
        <line x1="0" x2="960" y1={zeroY} y2={zeroY} className="basketball-viz-zero-line" />
        {Array.from({ length: Math.max(0, periodCount - 1) }, (_, index) => {
          const markerX = ((index + 1) / periodCount) * 960;
          return (
            <g className="basketball-viz-quarter" key={index}>
              <line x1={markerX} x2={markerX} y1="12" y2="232" />
              <text x={markerX + 8} y="28">{index + 2}Q</text>
            </g>
          );
        })}
        <polyline points={stepLine} className="basketball-viz-margin-line" />
        {scoringEvents.map((event) => {
          const eventX = x(elapsedSeconds(event, periodMinutes, periodCount));
          const eventY = y(event.marginAfter || 0);
          return (
            <g key={event.id}>
              <title>{`${event.period}Q ${event.clock} · ${event.homeScoreAfter}-${event.awayScoreAfter}`}</title>
              <circle cx={eventX} cy={eventY} r="7" className="basketball-viz-margin-dot-outline" />
              <circle cx={eventX} cy={eventY} r="4.5" fill={event.team === 'HOME' ? HOME_COLOR : AWAY_COLOR} />
            </g>
          );
        })}
        <g className="basketball-viz-time-axis">
          {Array.from({ length: periodCount + 1 }, (_, index) => {
            const markerX = (index / periodCount) * 960;
            return <text key={index} x={markerX} y="258" textAnchor={index === 0 ? 'start' : index === periodCount ? 'end' : 'middle'}>{index === 0 ? 'START' : `${index}Q END`}</text>;
          })}
        </g>
      </svg>
    </article>
  );
}

function ReboundDonut({ team, name, data }: { team: Team; name: string; data: { ar: number; dr: number; ra: number } }) {
  const values = [
    { label: '공격 리바운드', short: '공리', value: data.ar, color: '#ff6d00' },
    { label: '수비 리바운드', short: '수리', value: data.dr, color: '#1e63dc' },
    { label: '리바운드 허용', short: '허용', value: data.ra, color: '#e54545' },
  ];
  const total = values.reduce((sum, item) => sum + item.value, 0);
  const circumference = 2 * Math.PI * 54;
  let offset = 0;

  return (
    <article className={`basketball-viz-rebound-card ${team.toLowerCase()}`}>
      <div className="basketball-viz-rebound-title">
        <span>{team}</span>
        <strong>{name}</strong>
      </div>
      <div className="basketball-viz-donut-wrap">
        <svg viewBox="0 0 160 160" className="basketball-viz-donut" role="img" aria-label={`${name} 리바운드 구성`}>
          <circle cx="80" cy="80" r="54" className="basketball-viz-donut-track" />
          {values.map((item) => {
            const dash = total ? Math.max(0, (item.value / total) * circumference - 3) : 0;
            const segment = (
              <circle
                key={item.short}
                cx="80"
                cy="80"
                r="54"
                fill="none"
                stroke={item.color}
                strokeWidth="26"
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 80 80)"
                className="basketball-viz-donut-segment"
              />
            );
            offset += total ? (item.value / total) * circumference : 0;
            return segment;
          })}
          <text x="80" y="75" className="basketball-viz-donut-total" textAnchor="middle">{total}</text>
          <text x="80" y="96" className="basketball-viz-donut-caption" textAnchor="middle">REBOUNDS</text>
        </svg>
        <div className="basketball-viz-donut-legend">
          {values.map((item) => (
            <div key={item.short}>
              <span style={{ backgroundColor: item.color }} />
              <b>{item.short}</b>
              <em>{item.value}</em>
              <small>{percentage(item.value, total)}</small>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export default function BasketballVisualization() {
  const [matches, setMatches] = useState<BasketballMatch[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [state, setState] = useState<BasketballState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    apiJson<BasketballMatch[]>('/matches?sport=BASKETBALL')
      .then((rows) => {
        if (!mounted) return;
        setMatches(rows);
        setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id || '');
      })
      .catch(() => mounted && setError('농구 경기 목록을 불러오지 못했습니다.'))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setState(null);
      return;
    }
    let mounted = true;
    const loadState = () => apiJson<BasketballState>(`/matches/${selectedId}/basketball-state`)
      .then((next) => mounted && setState(next))
      .catch(() => mounted && setError('경기 시각화 데이터를 불러오지 못했습니다.'));
    loadState();
    const timer = window.setInterval(loadState, 4000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [selectedId]);

  const selectedMatch = matches.find((match) => match.id === selectedId) || null;
  const events = state?.events || [];
  const score = useMemo(() => getScore(events), [events]);
  const rebounds = useMemo(() => getRebounds(events), [events]);
  const periodMinutes = selectedMatch?.metadata?.period_minutes || 10;
  const periodCount = selectedMatch?.metadata?.period_count || 4;

  if (loading) {
    return <main className="page-stack"><section className="card card-panel"><p className="muted">농구 시각화를 준비하고 있습니다.</p></section></main>;
  }

  return (
    <main className="page-stack basketball-viz-page">
      <section className="basketball-viz-toolbar">
        <div>
          <div className="sidebar-eyebrow">Basketball FLA</div>
          <h3>Visualization</h3>
        </div>
        <label>
          <span>경기 선택</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={matches.length === 0}>
            {matches.length === 0 ? <option>등록된 농구 경기가 없습니다</option> : null}
            {matches.map((match) => <option key={match.id} value={match.id}>{match.name}{match.archived ? ' · ARCHIVED' : ''}</option>)}
          </select>
        </label>
        {selectedMatch ? <Link className="button-link button-compact btn-secondary" href={`/admin/basketball/match/${selectedMatch.id}`}>FLA 기록 열기</Link> : null}
      </section>

      {error ? <p className="basketball-viz-error">{error}</p> : null}
      {!selectedMatch ? <section className="card card-panel"><p className="muted">시각화할 농구 경기를 먼저 생성해주세요.</p></section> : null}
      {selectedMatch ? (
        <section className="basketball-viz-frame">
          <header className="basketball-viz-brandbar">
            <img src="/live-coder/fineplay-logo.png" alt="FinePlay" />
            <div className="basketball-viz-brand-copy">
              <span>LIVE ANALYTICS</span>
              <strong>{selectedMatch.name}</strong>
            </div>
            <div className="basketball-viz-scoreline">
              <span>{teamName(selectedMatch, 'HOME')}</span>
              <b>{score.home}</b>
              <i>:</i>
              <b>{score.away}</b>
              <span>{teamName(selectedMatch, 'AWAY')}</span>
            </div>
          </header>

          <section className="basketball-viz-shotmaps">
            <div className="basketball-viz-section-title">
              <div><span>SHOT ZONE VISUALIZATION</span><strong>홈/어웨이 샷맵</strong></div>
              <div className="basketball-viz-zone-legend"><i className="zero" /> 0점 <i className="low" /> 1–9점 <i className="high" /> 10점 이상</div>
            </div>
            <div className="basketball-viz-map-grid">
              <ShotMap team="HOME" events={events} />
              <ShotMap team="AWAY" events={events} />
            </div>
          </section>

          <MarginFlow events={events} periodMinutes={periodMinutes} periodCount={periodCount} />

          <section className="basketball-viz-rebounds-panel">
            <div className="basketball-viz-section-title"><div><span>REBOUND DISTRIBUTION</span><strong>리바운드 구성</strong></div><p>공격 리바운드 · 수비 리바운드 · 리바운드 허용</p></div>
            <div className="basketball-viz-rebound-grid">
              <ReboundDonut team="HOME" name={teamName(selectedMatch, 'HOME')} data={rebounds.HOME} />
              <ReboundDonut team="AWAY" name={teamName(selectedMatch, 'AWAY')} data={rebounds.AWAY} />
            </div>
          </section>
        </section>
      ) : null}
    </main>
  );
}
