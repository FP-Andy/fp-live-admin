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
  playerNumber?: string;
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
type Insight = { lead: string; items: string[]; tone: 'home' | 'away' | 'neutral' };

const COURT_WIDTH = 722;
const COURT_HEIGHT = 678;
const HOME_COLOR = '#ff7900';
const AWAY_COLOR = '#1e63dc';
const PAINT_ZONE_IDS = new Set<ZoneId>(['RESTRICTED_AREA', 'PAINT', 'LEFT_PAINT', 'RIGHT_PAINT']);
const THREE_POINT_ZONE_IDS = new Set<ZoneId>(ZONES.filter((zone) => zone.points === 3).map((zone) => zone.id));


function parseClockSeconds(clock: string | undefined) {
  const [minutesRaw, secondsRaw = '0'] = String(clock || '0:00').split(':');
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return 0;
  return Math.max(0, minutes * 60 + seconds);
}

function zoneFill(points: number) {
  if (points >= 5) return '#177c40';
  if (points > 0) return '#9d7d09';
  return '#94272b';
}

function percentage(value: number, total: number) {
  if (!total) return '0.0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function rate(value: { made: number; attempts: number }) {
  return value.attempts ? value.made / value.attempts : 0;
}

function formatRate(value: { made: number; attempts: number }) {
  return percentage(value.made, value.attempts);
}

function winnerFromDifference(home: number, away: number, threshold = 0): Team | null {
  if (Math.abs(home - away) <= threshold) return null;
  return home > away ? 'HOME' : 'AWAY';
}

function teamLabel(labels: Record<Team, string>, team: Team) {
  return labels[team];
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

function getShotAggregate(
  events: GameEvent[],
  team: Team,
  predicate: (event: GameEvent) => boolean = () => true
) {
  return events.reduce(
    (result, event) => {
      if (event.type !== 'SHOT' || event.team !== team || !predicate(event)) return result;
      result.attempts += 1;
      if (event.shotResult === 'MADE') {
        result.made += 1;
        result.points += Number(event.points || 0);
      }
      return result;
    },
    { attempts: 0, made: 0, points: 0 }
  );
}

function getZoneBandSummary(events: GameEvent[], team: Team, minimum: number, maximum: number) {
  const stats = getZoneStats(events, team);
  return Array.from(stats.values()).reduce(
    (result, zone) => {
      if (zone.points < minimum || zone.points > maximum) return result;
      result.zones += 1;
      result.points += zone.points;
      return result;
    },
    { zones: 0, points: 0 }
  );
}

function buildShotInsight(events: GameEvent[], labels: Record<Team, string>): Insight {
  const home = getShotAggregate(events, 'HOME');
  const away = getShotAggregate(events, 'AWAY');
  if (home.attempts + away.attempts === 0) {
    return {
      lead: '샷 이벤트가 누적되면 구역별 성공률과 득점 효율을 비교합니다.',
      items: ['전체 성공률', '5점 이상 초록 구간', '3점 구간과 페인트존 효율을 순서대로 분석합니다.'],
      tone: 'neutral',
    };
  }

  const homeRate = rate(home);
  const awayRate = rate(away);
  const rateLeader = winnerFromDifference(homeRate, awayRate, 0.04);
  const greenHome = getZoneBandSummary(events, 'HOME', 5, Number.POSITIVE_INFINITY);
  const greenAway = getZoneBandSummary(events, 'AWAY', 5, Number.POSITIVE_INFINITY);
  const yellowHome = getZoneBandSummary(events, 'HOME', 1, 4);
  const yellowAway = getZoneBandSummary(events, 'AWAY', 1, 4);
  const homeThree = getShotAggregate(events, 'HOME', (event) => Boolean(event.zoneId && THREE_POINT_ZONE_IDS.has(event.zoneId)));
  const awayThree = getShotAggregate(events, 'AWAY', (event) => Boolean(event.zoneId && THREE_POINT_ZONE_IDS.has(event.zoneId)));
  const homePaint = getShotAggregate(events, 'HOME', (event) => Boolean(event.zoneId && PAINT_ZONE_IDS.has(event.zoneId)));
  const awayPaint = getShotAggregate(events, 'AWAY', (event) => Boolean(event.zoneId && PAINT_ZONE_IDS.has(event.zoneId)));
  const greenLeader = winnerFromDifference(greenHome.points, greenAway.points);
  const yellowLeader = winnerFromDifference(yellowHome.points, yellowAway.points);
  const threeLeader = winnerFromDifference(rate(homeThree), rate(awayThree), 0.04);
  const paintLeader = winnerFromDifference(rate(homePaint), rate(awayPaint), 0.04);
  const homeEdges = [rateLeader, greenLeader, yellowLeader, threeLeader, paintLeader].filter((team) => team === 'HOME').length;
  const awayEdges = [rateLeader, greenLeader, yellowLeader, threeLeader, paintLeader].filter((team) => team === 'AWAY').length;
  const overallLeader = homeEdges === awayEdges ? rateLeader : homeEdges > awayEdges ? 'HOME' : 'AWAY';
  const rateGap = Math.abs(homeRate - awayRate) * 100;
  const overallSentence = rateLeader
    ? `${teamLabel(labels, rateLeader)}이 전체 성공률 ${formatRate(rateLeader === 'HOME' ? home : away)}로 ${rateGap.toFixed(1)}%p 앞섭니다.`
    : `전체 성공률은 ${teamLabel(labels, 'HOME')} ${formatRate(home)}, ${teamLabel(labels, 'AWAY')} ${formatRate(away)}로 비슷합니다.`;

  return {
    lead: overallLeader
      ? `${teamLabel(labels, overallLeader)}이 구역 분포와 성공률을 종합했을 때 더 효율적인 샷 셀렉션을 보이고 있습니다.`
      : '두 팀의 샷 효율이 비슷해 특정 구역의 추가 득점이 흐름을 바꿀 수 있습니다.',
    items: [
      overallSentence,
      `초록 구간은 ${teamLabel(labels, 'HOME')} ${greenHome.zones}곳·${greenHome.points}점, ${teamLabel(labels, 'AWAY')} ${greenAway.zones}곳·${greenAway.points}점${greenLeader ? `으로 ${teamLabel(labels, greenLeader)}이 우세` : '으로 비슷'}합니다. 노랑 구간은 ${teamLabel(labels, 'HOME')} ${yellowHome.zones}곳·${yellowHome.points}점, ${teamLabel(labels, 'AWAY')} ${yellowAway.zones}곳·${yellowAway.points}점${yellowLeader ? `입니다 (${teamLabel(labels, yellowLeader)} 우세)` : '으로 균형입니다'}.`,
      `3점 구간은 ${teamLabel(labels, 'HOME')} ${homeThree.made}/${homeThree.attempts} (${formatRate(homeThree)}), ${teamLabel(labels, 'AWAY')} ${awayThree.made}/${awayThree.attempts} (${formatRate(awayThree)})${threeLeader ? `로 ${teamLabel(labels, threeLeader)}이 앞서고` : '로 팽팽하고'}, 페인트존은 ${teamLabel(labels, 'HOME')} ${homePaint.made}/${homePaint.attempts} (${formatRate(homePaint)}), ${teamLabel(labels, 'AWAY')} ${awayPaint.made}/${awayPaint.attempts} (${formatRate(awayPaint)})${paintLeader ? `로 ${teamLabel(labels, paintLeader)}이 앞섭니다` : '로 비슷합니다'}.`,
    ],
    tone: overallLeader === 'HOME' ? 'home' : overallLeader === 'AWAY' ? 'away' : 'neutral',
  };
}

function getScoringEvents(events: GameEvent[], periodMinutes: number, periodCount: number) {
  return events
    .filter((event) => event.type === 'SHOT' && event.shotResult === 'MADE')
    .slice()
    .sort((left, right) => elapsedSeconds(left, periodMinutes, periodCount) - elapsedSeconds(right, periodMinutes, periodCount) || left.timestamp - right.timestamp);
}

function describeShot(event: GameEvent) {
  if (event.zoneId === 'FREE_THROW_ZONE') return '자유투 성공';
  const zone = ZONES.find((item) => item.id === event.zoneId);
  const prefix = zone ? `${zone.label} 구역 ` : '';
  return `${prefix}${Number(event.points || 0)}점슛 성공`;
}

function buildMarginInsight(events: GameEvent[], periodMinutes: number, periodCount: number, labels: Record<Team, string>): Insight {
  const scoringEvents = getScoringEvents(events, periodMinutes, periodCount);
  if (scoringEvents.length === 0) {
    return {
      lead: '득점 이벤트가 누적되면 최대 격차와 리드 체인지, 결정적 득점 시점을 분석합니다.',
      items: ['쿼터별 득점 변화와 리드 흐름을 실시간으로 반영합니다.'],
      tone: 'neutral',
    };
  }

  const largest = scoringEvents.reduce((current, event) => Math.abs(event.marginAfter) > Math.abs(current.marginAfter) ? event : current);
  const largestTeam: Team = largest.marginAfter >= 0 ? 'HOME' : 'AWAY';
  let previousLeader = 0;
  let leadChanges = 0;
  scoringEvents.forEach((event) => {
    const currentLeader = Math.sign(event.marginAfter);
    if (currentLeader && previousLeader && currentLeader !== previousLeader) leadChanges += 1;
    if (currentLeader) previousLeader = currentLeader;
  });
  const finalMargin = scoringEvents.at(-1)?.marginAfter || 0;
  const finalSign = Math.sign(finalMargin);
  const decisiveIndex = finalSign
    ? scoringEvents.findIndex((event, index) => (
      Math.sign(event.marginAfter) === finalSign
      && Math.abs(event.marginAfter) >= 2
      && scoringEvents.slice(index).every((next) => Math.sign(next.marginAfter) !== -finalSign)
    ))
    : -1;
  const decisive = decisiveIndex >= 0 ? scoringEvents[decisiveIndex] : largest;
  const decisiveTeam: Team = decisive.marginAfter >= 0 ? 'HOME' : 'AWAY';
  const player = decisive.playerNumber ? ` #${decisive.playerNumber}` : '';
  const finalLeader = finalSign > 0 ? 'HOME' : finalSign < 0 ? 'AWAY' : null;

  return {
    lead: finalLeader
      ? `${teamLabel(labels, finalLeader)}이 ${Math.abs(finalMargin)}점 리드로 마무리하고 있으며, ${leadChanges >= 3 ? '여러 차례 흐름이 뒤집힌 경기입니다.' : '리드를 관리하고 있습니다.'}`
      : `현재 동점 흐름이며, 리드 체인지가 ${leadChanges}회 발생했습니다.`,
    items: [
      `경기 최대 격차는 ${teamLabel(labels, largestTeam)}의 ${Math.abs(largest.marginAfter)}점 리드입니다 (${largest.period}Q ${largest.clock}, ${largest.homeScoreAfter}-${largest.awayScoreAfter}).`,
      `리드 체인지는 ${leadChanges}회${leadChanges >= 3 ? '로 팽팽한 공방이 이어졌습니다' : '로 비교적 일찍 우세 흐름이 형성됐습니다'}.`,
      `${decisive.period}Q ${decisive.clock}, ${teamLabel(labels, decisiveTeam)}${player}의 ${describeShot(decisive)}가 ${decisive.homeScoreAfter}-${decisive.awayScoreAfter}를 만들며 ${decisiveIndex >= 0 ? '승부가 기우는 분기점이 됐습니다' : '가장 큰 격차를 만든 장면입니다'}.`,
    ],
    tone: finalLeader === 'HOME' ? 'home' : finalLeader === 'AWAY' ? 'away' : 'neutral',
  };
}

function buildReboundInsight(stats: ReboundStats, labels: Record<Team, string>): Insight {
  const home = stats.HOME;
  const away = stats.AWAY;
  const homeTotal = home.ar + home.dr;
  const awayTotal = away.ar + away.dr;
  if (homeTotal + awayTotal === 0 && home.ra + away.ra === 0) {
    return {
      lead: '리바운드 이벤트가 누적되면 공격·수비 리바운드와 허용 리바운드를 비교합니다.',
      items: ['상대에게 허용한 공격 리바운드는 적을수록 긍정적으로 평가합니다.'],
      tone: 'neutral',
    };
  }

  const totalLeader = winnerFromDifference(homeTotal, awayTotal);
  const offenseLeader = winnerFromDifference(home.ar, away.ar);
  const defenseLeader = winnerFromDifference(home.dr, away.dr);
  const allowedLeader = winnerFromDifference(away.ra, home.ra);
  const homeEdges = [offenseLeader, defenseLeader, allowedLeader].filter((team) => team === 'HOME').length;
  const awayEdges = [offenseLeader, defenseLeader, allowedLeader].filter((team) => team === 'AWAY').length;
  const overallLeader = homeEdges === awayEdges ? totalLeader : homeEdges > awayEdges ? 'HOME' : 'AWAY';

  return {
    lead: overallLeader
      ? `${teamLabel(labels, overallLeader)}이 리바운드 싸움에서 더 많은 우세 지표를 확보했습니다.`
      : '리바운드 지표가 균형을 이루고 있어 다음 소유권 경쟁이 중요합니다.',
    items: [
      `전체 리바운드는 ${teamLabel(labels, 'HOME')} ${homeTotal}개, ${teamLabel(labels, 'AWAY')} ${awayTotal}개${totalLeader ? `로 ${teamLabel(labels, totalLeader)}이 앞섭니다` : '로 같습니다'}.`,
      `공격 리바운드는 ${teamLabel(labels, 'HOME')} ${home.ar}개, ${teamLabel(labels, 'AWAY')} ${away.ar}개${offenseLeader ? `로 ${teamLabel(labels, offenseLeader)}이 세컨드 찬스를 더 만들고` : '로 균형이고'}, 수비 리바운드는 ${teamLabel(labels, 'HOME')} ${home.dr}개, ${teamLabel(labels, 'AWAY')} ${away.dr}개${defenseLeader ? `로 ${teamLabel(labels, defenseLeader)}이 우세합니다` : '로 같습니다'}.`,
      `리바운드 허용은 ${teamLabel(labels, 'HOME')} ${home.ra}개, ${teamLabel(labels, 'AWAY')} ${away.ra}개로 ${allowedLeader ? `${teamLabel(labels, allowedLeader)}이 상대 세컨드 찬스를 더 잘 차단했습니다` : '두 팀이 같은 수준으로 관리하고 있습니다'}.`,
    ],
    tone: overallLeader === 'HOME' ? 'home' : overallLeader === 'AWAY' ? 'away' : 'neutral',
  };
}

function InsightCard({ title, insight }: { title: string; insight: Insight }) {
  return (
    <section className={`basketball-viz-insight ${insight.tone}`} aria-label={`${title} 분석 코멘트`}>
      <div className="basketball-viz-insight-heading"><span>FINEPLAY INSIGHT</span><strong>{title} 해설</strong></div>
      <p className="basketball-viz-insight-lead">{insight.lead}</p>
      <ul>{insight.items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  );
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
            </g>
          );
        })}
        <image href="/basketball-shot-zones.png" x="0" y="0" width={COURT_WIDTH} height={COURT_HEIGHT} preserveAspectRatio="none" className="basketball-viz-court-lines" />
        {ZONES.map((zone) => {
          const summary = stats.get(zone.id) || { attempts: 0, made: 0, points: 0 };
          return (
            <g key={`${zone.id}-label`} className="basketball-viz-zone-label">
              <text x={zone.textX} y={zone.textY - 5} className="basketball-viz-zone-points" textAnchor="middle">{summary.points}</text>
              <text x={zone.textX} y={zone.textY + 14} className="basketball-viz-zone-detail" textAnchor="middle">{summary.made}/{summary.attempts}</text>
            </g>
          );
        })}
      </svg>
      <div className="basketball-viz-map-note">숫자: 득점 · 하단: 성공/시도</div>
    </article>
  );
}

function MarginFlow({ events, periodMinutes, periodCount, labels }: { events: GameEvent[]; periodMinutes: number; periodCount: number; labels: Record<Team, string> }) {
  const scoringEvents = useMemo(() => getScoringEvents(events, periodMinutes, periodCount), [events, periodMinutes, periodCount]);
  const insight = useMemo(() => buildMarginInsight(events, periodMinutes, periodCount, labels), [events, labels, periodMinutes, periodCount]);
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
              <circle cx={eventX} cy={eventY} r="4" className="basketball-viz-margin-dot-outline" />
              <circle cx={eventX} cy={eventY} r="2.35" fill={event.team === 'HOME' ? HOME_COLOR : AWAY_COLOR} />
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
      <InsightCard title="득점 마진 플로우" insight={insight} />
    </article>
  );
}

function ReboundDonut({ team, name, data }: { team: Team; name: string; data: { ar: number; dr: number; ra: number } }) {
  const values = [
    { label: '공격 리바운드', value: data.ar, color: '#ff6d00' },
    { label: '수비 리바운드', value: data.dr, color: '#1e63dc' },
    { label: '리바운드 허용', value: data.ra, color: '#e54545' },
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
                key={item.label}
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
          <text x="80" y="78" className="basketball-viz-donut-total" textAnchor="middle">{total}</text>
          <text x="80" y="98" className="basketball-viz-donut-caption" textAnchor="middle">TOTAL</text>
        </svg>
        <div className="basketball-viz-donut-legend">
          {values.map((item) => (
            <div key={item.label}>
              <span style={{ backgroundColor: item.color }} />
              <b>{item.label}</b>
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
  const labels: Record<Team, string> = {
    HOME: teamName(selectedMatch, 'HOME'),
    AWAY: teamName(selectedMatch, 'AWAY'),
  };
  const shotInsight = useMemo(() => buildShotInsight(events, labels), [events, labels]);
  const reboundInsight = useMemo(() => buildReboundInsight(rebounds, labels), [labels, rebounds]);

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
              <div className="basketball-viz-zone-legend"><i className="zero" /> 0점 <i className="low" /> 1–4점 <i className="high" /> 5점 이상</div>
            </div>
            <div className="basketball-viz-map-grid">
              <ShotMap team="HOME" events={events} />
              <ShotMap team="AWAY" events={events} />
            </div>
            <InsightCard title="샷맵" insight={shotInsight} />
          </section>

          <MarginFlow events={events} periodMinutes={periodMinutes} periodCount={periodCount} labels={labels} />

          <section className="basketball-viz-rebounds-panel">
            <div className="basketball-viz-section-title"><div><span>REBOUND DISTRIBUTION</span><strong>리바운드 구성</strong></div><p>공격 리바운드 · 수비 리바운드 · 리바운드 허용</p></div>
            <div className="basketball-viz-rebound-grid">
              <ReboundDonut team="HOME" name={teamName(selectedMatch, 'HOME')} data={rebounds.HOME} />
              <ReboundDonut team="AWAY" name={teamName(selectedMatch, 'AWAY')} data={rebounds.AWAY} />
            </div>
            <InsightCard title="리바운드" insight={reboundInsight} />
          </section>
        </section>
      ) : null}
    </main>
  );
}
