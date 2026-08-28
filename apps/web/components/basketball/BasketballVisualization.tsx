'use client';

import Link from 'next/link';
import { toPng } from 'html-to-image';
import { useEffect, useMemo, useRef, useState } from 'react';
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
let transparentCourtLinesDataUrl: Promise<string> | null = null;


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

function subjectParticle(value: string) {
  const last = Array.from(value.trim()).at(-1);
  if (!last) return '이';
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? '가' : '이';
  return '이';
}

function withSubject(value: string) {
  return `${value}${subjectParticle(value)}`;
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

function getTransparentCourtLinesDataUrl() {
  if (transparentCourtLinesDataUrl) return transparentCourtLinesDataUrl;
  transparentCourtLinesDataUrl = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('코트 라인을 준비하지 못했습니다.'));
        return;
      }
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const brightness = Math.min(pixels.data[index], pixels.data[index + 1], pixels.data[index + 2]);
        if (brightness > 220) pixels.data[index + 3] = Math.round(pixels.data[index + 3] * ((255 - brightness) / 35));
      }
      context.putImageData(pixels, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('코트 라인을 불러오지 못했습니다.'));
    image.src = '/basketball-shot-zones.png';
  });
  return transparentCourtLinesDataUrl;
}

async function downloadElementAsPng(element: HTMLElement, filename: string) {
  const courtLines = Array.from(element.querySelectorAll<SVGImageElement>('.basketball-viz-court-lines'));
  const originalSources = courtLines.map((line) => line.getAttribute('href'));
  try {
    const transparentSource = courtLines.length ? await getTransparentCourtLinesDataUrl() : null;
    if (transparentSource) courtLines.forEach((line) => line.setAttribute('href', transparentSource));
    const source = await toPng(element, {
      backgroundColor: '#151719',
      cacheBust: true,
      pixelRatio: 2,
    });
    const link = document.createElement('a');
    link.href = source;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    courtLines.forEach((line, index) => {
      const original = originalSources[index];
      if (original) line.setAttribute('href', original);
      else line.removeAttribute('href');
    });
  }
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
      lead: '기록된 샷 이벤트가 없어 구역별 성공률과 득점 효율을 비교할 수 없습니다.',
      items: ['전체 성공률, 5점 이상 초록 구간, 3점 구간과 페인트존 효율을 기준으로 분석합니다.'],
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
    ? `${withSubject(teamLabel(labels, rateLeader))} 전체 성공률 ${formatRate(rateLeader === 'HOME' ? home : away)}로 ${rateGap.toFixed(1)}%p 앞섰습니다.`
    : `전체 성공률은 ${teamLabel(labels, 'HOME')} ${formatRate(home)}, ${teamLabel(labels, 'AWAY')} ${formatRate(away)}로 비슷합니다.`;

  return {
    lead: overallLeader
      ? `${withSubject(teamLabel(labels, overallLeader))} 구역 분포와 성공률을 종합했을 때 더 효율적인 샷 셀렉션을 보였습니다.`
      : '두 팀의 샷 효율이 비슷했던 경기였습니다.',
    items: [
      overallSentence,
      `초록 구간은 ${teamLabel(labels, 'HOME')} ${greenHome.zones}곳·${greenHome.points}점, ${teamLabel(labels, 'AWAY')} ${greenAway.zones}곳·${greenAway.points}점${greenLeader ? `으로 ${withSubject(teamLabel(labels, greenLeader))} 우세했습니다` : '으로 비슷했습니다'}. 노랑 구간은 ${teamLabel(labels, 'HOME')} ${yellowHome.zones}곳·${yellowHome.points}점, ${teamLabel(labels, 'AWAY')} ${yellowAway.zones}곳·${yellowAway.points}점${yellowLeader ? `으로 ${withSubject(teamLabel(labels, yellowLeader))} 우세했습니다` : '으로 균형이었습니다'}.`,
      `3점 구간은 ${teamLabel(labels, 'HOME')} ${homeThree.made}/${homeThree.attempts} (${formatRate(homeThree)}), ${teamLabel(labels, 'AWAY')} ${awayThree.made}/${awayThree.attempts} (${formatRate(awayThree)})${threeLeader ? `로 ${withSubject(teamLabel(labels, threeLeader))} 앞섰고` : '로 팽팽했고'}, 페인트존은 ${teamLabel(labels, 'HOME')} ${homePaint.made}/${homePaint.attempts} (${formatRate(homePaint)}), ${teamLabel(labels, 'AWAY')} ${awayPaint.made}/${awayPaint.attempts} (${formatRate(awayPaint)})${paintLeader ? `로 ${withSubject(teamLabel(labels, paintLeader))} 앞섰습니다` : '로 비슷했습니다'}.`,
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
      lead: '기록된 득점 이벤트가 없어 마진 흐름을 분석할 수 없습니다.',
      items: ['최대 점수 차, 리드 체인지, 격차가 크게 벌어진 구간을 기준으로 분석합니다.'],
      tone: 'neutral',
    };
  }

  const largest = scoringEvents.reduce((current, event) => Math.abs(event.marginAfter) > Math.abs(current.marginAfter) ? event : current);
  const largestIndex = scoringEvents.findIndex((event) => event.id === largest.id);
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
  const finalLeader = finalSign > 0 ? 'HOME' : finalSign < 0 ? 'AWAY' : null;

  // "승부가 갈린 지점"은 리드를 처음 잡은 시점이 아니라, 실제 점수 차가 경기 최대 격차에
  // 가까워지며 충분히 벌어진 첫 구간으로 정의한다.
  const largestGap = Math.abs(largest.marginAfter);
  const separationThreshold = largestGap >= 12 ? Math.ceil(largestGap * 0.65) : largestGap >= 8 ? 6 : Math.max(3, Math.ceil(largestGap * 0.6));
  const separation = scoringEvents.find((event) => (
    Math.sign(event.marginAfter) === Math.sign(largest.marginAfter)
    && Math.abs(event.marginAfter) >= separationThreshold
  )) || largest;
  const separationTeam: Team = separation.marginAfter >= 0 ? 'HOME' : 'AWAY';
  const separationPlayer = separation.playerNumber ? ` #${separation.playerNumber}` : '';

  // 최대 격차 뒤 상대가 다시 차이를 좁힌 구간이 충분히 있으면, 추격 흐름도 함께 설명한다.
  const rallyTeam: Team = largestTeam === 'HOME' ? 'AWAY' : 'HOME';
  const relativeMargin = (event: GameEvent, team: Team) => team === 'HOME' ? event.marginAfter : -event.marginAfter;
  const rallyStartRelative = relativeMargin(largest, rallyTeam);
  const rallyTarget = scoringEvents.slice(largestIndex + 1).reduce<GameEvent | null>((best, event) => {
    if (!best || relativeMargin(event, rallyTeam) > relativeMargin(best, rallyTeam)) return event;
    return best;
  }, null);
  const rallyImprovement = rallyTarget ? relativeMargin(rallyTarget, rallyTeam) - rallyStartRelative : 0;
  const rallyThreshold = Math.min(4, Math.max(3, Math.floor(largestGap / 2)));
  const rallySentence = rallyTarget && rallyImprovement >= rallyThreshold
    ? (() => {
      const endMargin = relativeMargin(rallyTarget, rallyTeam);
      const result = endMargin > 0
        ? `${endMargin}점 리드로 역전`
        : endMargin === 0
          ? '동점까지 추격'
          : `${Math.abs(endMargin)}점 차까지 추격`;
      return `${withSubject(teamLabel(labels, rallyTeam))} ${largest.period}Q ${largest.clock} 이후 ${largestGap}점 차를 ${result}하며 분발한 구간도 있었습니다 (${rallyTarget.period}Q ${rallyTarget.clock}).`;
    })()
    : null;

  return {
    lead: finalLeader
      ? `${withSubject(teamLabel(labels, finalLeader))} ${Math.abs(finalMargin)}점 차로 경기를 마쳤습니다. ${leadChanges >= 3 ? '여러 차례 흐름이 뒤집힌 접전이었습니다.' : '우세 흐름을 끝까지 지켰습니다.'}`
      : `경기는 동점으로 종료됐으며, 리드 체인지가 ${leadChanges}회 발생했습니다.`,
    items: [
      `경기 최대 격차는 ${teamLabel(labels, largestTeam)}의 ${Math.abs(largest.marginAfter)}점 리드입니다 (${largest.period}Q ${largest.clock}, ${largest.homeScoreAfter}-${largest.awayScoreAfter}).`,
      `리드 체인지는 ${leadChanges}회${leadChanges >= 3 ? '로 팽팽한 공방이 이어졌습니다' : '로 비교적 이른 시점에 우세 흐름이 형성됐습니다'}.`,
      `${separation.period}Q ${separation.clock}, ${teamLabel(labels, separationTeam)}${separationPlayer}의 ${describeShot(separation)}으로 ${separation.homeScoreAfter}-${separation.awayScoreAfter}를 만들며 ${separationThreshold}점 차 이상의 격차가 본격적으로 벌어진 구간이 됐습니다.`,
      ...(rallySentence ? [rallySentence] : []),
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
      lead: '기록된 리바운드 이벤트가 없어 리바운드 분포를 비교할 수 없습니다.',
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
      ? `${withSubject(teamLabel(labels, overallLeader))} 리바운드 싸움에서 더 많은 우세 지표를 확보했습니다.`
      : '리바운드 지표가 균형을 이뤘던 경기였습니다.',
    items: [
      `전체 리바운드는 ${teamLabel(labels, 'HOME')} ${homeTotal}개, ${teamLabel(labels, 'AWAY')} ${awayTotal}개${totalLeader ? `로 ${withSubject(teamLabel(labels, totalLeader))} 앞섰습니다` : '로 같았습니다'}.`,
      `공격 리바운드는 ${teamLabel(labels, 'HOME')} ${home.ar}개, ${teamLabel(labels, 'AWAY')} ${away.ar}개${offenseLeader ? `로 ${withSubject(teamLabel(labels, offenseLeader))} 세컨드 찬스를 더 만들었고` : '로 균형이었고'}, 수비 리바운드는 ${teamLabel(labels, 'HOME')} ${home.dr}개, ${teamLabel(labels, 'AWAY')} ${away.dr}개${defenseLeader ? `로 ${withSubject(teamLabel(labels, defenseLeader))} 우세했습니다` : '로 같았습니다'}.`,
      `리바운드 허용은 ${teamLabel(labels, 'HOME')} ${home.ra}개, ${teamLabel(labels, 'AWAY')} ${away.ra}개로 ${allowedLeader ? `${withSubject(teamLabel(labels, allowedLeader))} 상대 세컨드 찬스를 더 잘 차단했습니다` : '두 팀이 같은 수준으로 관리했습니다'}.`,
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
              <path d={zone.d} fill={zoneFill(summary.points)} stroke="rgba(255, 255, 255, 0.76)" strokeWidth="1.5" strokeLinejoin="round" className="basketball-viz-zone" />
            </g>
          );
        })}
        <image href="/basketball-shot-zones.png" x="0" y="0" width={COURT_WIDTH} height={COURT_HEIGHT} preserveAspectRatio="none" className="basketball-viz-court-lines" />
        {ZONES.map((zone) => {
          const summary = stats.get(zone.id) || { attempts: 0, made: 0, points: 0 };
          return (
            <g key={`${zone.id}-label`} className="basketball-viz-zone-label">
              <text x={zone.textX} y={zone.textY - 5} fill="#fff" stroke="rgba(0, 0, 0, 0.6)" strokeWidth="2" strokeLinejoin="round" paintOrder="stroke" fontSize="22" fontWeight="900" textAnchor="middle">{summary.points}</text>
              <text x={zone.textX} y={zone.textY + 14} fill="rgba(255, 255, 255, 0.83)" stroke="rgba(0, 0, 0, 0.6)" strokeWidth="2" strokeLinejoin="round" paintOrder="stroke" fontSize="13" fontWeight="700" textAnchor="middle">{summary.made}/{summary.attempts}</text>
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
              <line x1="0" x2="960" y1={y(value)} y2={y(value)} stroke="rgba(255, 255, 255, 0.12)" strokeDasharray="4 6" />
              <text x="-12" y={y(value) + 4} fill="rgba(255, 255, 255, 0.56)" fontSize="12" fontWeight="700" textAnchor="end">{value > 0 ? `+${value}` : value}</text>
            </g>
          ))}
          {Array.from({ length: periodCount + 1 }, (_, index) => index).map((index) => {
            const markerX = (index / periodCount) * 960;
            return <line key={index} x1={markerX} x2={markerX} y1="14" y2="230" stroke="rgba(255, 255, 255, 0.12)" strokeDasharray="4 6" />;
          })}
        </g>
        <polygon points={area} fill="rgba(255, 121, 0, 0.46)" className="basketball-viz-margin-home-fill" clipPath="url(#basketball-viz-positive)" />
        <polygon points={area} fill="rgba(30, 99, 220, 0.45)" className="basketball-viz-margin-away-fill" clipPath="url(#basketball-viz-negative)" />
        <line x1="0" x2="960" y1={zeroY} y2={zeroY} stroke="rgba(255, 255, 255, 0.94)" strokeWidth="1.4" className="basketball-viz-zero-line" />
        {Array.from({ length: Math.max(0, periodCount - 1) }, (_, index) => {
          const markerX = ((index + 1) / periodCount) * 960;
          return (
            <g className="basketball-viz-quarter" key={index}>
              <line x1={markerX} x2={markerX} y1="12" y2="232" stroke="rgba(255, 255, 255, 0.42)" strokeDasharray="7 5" />
              <text x={markerX + 8} y="28" fill="#fff" fontSize="12" fontWeight="900">{index + 2}Q</text>
            </g>
          );
        })}
        <polyline points={stepLine} fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" className="basketball-viz-margin-line" />
        {scoringEvents.map((event) => {
          const eventX = x(elapsedSeconds(event, periodMinutes, periodCount));
          const eventY = y(event.marginAfter || 0);
          return (
            <g key={event.id}>
              <title>{`${event.period}Q ${event.clock} · ${event.homeScoreAfter}-${event.awayScoreAfter}`}</title>
              <circle cx={eventX} cy={eventY} r="4" fill="#151719" stroke="#fff" strokeWidth="1.25" className="basketball-viz-margin-dot-outline" />
              <circle cx={eventX} cy={eventY} r="2.35" fill={event.team === 'HOME' ? HOME_COLOR : AWAY_COLOR} />
            </g>
          );
        })}
        <g className="basketball-viz-time-axis">
          {Array.from({ length: periodCount + 1 }, (_, index) => {
            const markerX = (index / periodCount) * 960;
            return <text key={index} x={markerX} y="258" fill="rgba(255, 255, 255, 0.56)" fontSize="12" fontWeight="700" textAnchor={index === 0 ? 'start' : index === periodCount ? 'end' : 'middle'}>{index === 0 ? 'START' : `${index}Q END`}</text>;
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
          <circle cx="80" cy="80" r="54" fill="none" stroke="rgba(255, 255, 255, 0.1)" strokeWidth="26" className="basketball-viz-donut-track" />
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
          <text x="80" y="78" fill="#fff" fontSize="30" fontWeight="900" textAnchor="middle">{total}</text>
          <text x="80" y="98" fill="rgba(255, 255, 255, 0.55)" fontSize="8" fontWeight="800" letterSpacing="0.14em" textAnchor="middle">TOTAL</text>
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
  const [exporting, setExporting] = useState<'shot-map' | 'margin-flow' | 'rebounds' | null>(null);
  const [exportError, setExportError] = useState('');
  const shotExportRef = useRef<HTMLElement | null>(null);
  const marginExportRef = useRef<HTMLDivElement | null>(null);
  const reboundExportRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let mounted = true;
    apiJson<BasketballMatch[]>('/matches?sport=BASKETBALL')
      .then((rows) => {
        if (!mounted) return;
        const archivedRows = rows.filter((row) => row.archived);
        setMatches(archivedRows);
        setSelectedId((current) => current && archivedRows.some((row) => row.id === current) ? current : archivedRows[0]?.id || '');
      })
      .catch(() => mounted && setError('완료된 농구 경기 목록을 불러오지 못했습니다.'))
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
    return () => {
      mounted = false;
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
  const downloadVisualization = async (kind: 'shot-map' | 'margin-flow' | 'rebounds') => {
    const element = kind === 'shot-map'
      ? shotExportRef.current
      : kind === 'margin-flow'
        ? marginExportRef.current
        : reboundExportRef.current;
    if (!element || !selectedMatch) return;
    setExportError('');
    setExporting(kind);
    try {
      await downloadElementAsPng(element, `fineplay-basketball-${selectedMatch.id}-${kind}.png`);
    } catch {
      setExportError('PNG 다운로드를 준비하지 못했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setExporting(null);
    }
  };

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
          <span>완료 경기 선택</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={matches.length === 0}>
            {matches.length === 0 ? <option>완료·아카이브된 농구 경기가 없습니다</option> : null}
            {matches.map((match) => <option key={match.id} value={match.id}>{match.name} · ARCHIVED</option>)}
          </select>
        </label>
        <div className="basketball-viz-export-actions" aria-label="시각화 PNG 다운로드">
          <span>PNG 다운로드</span>
          <button type="button" onClick={() => void downloadVisualization('shot-map')} disabled={!selectedMatch || exporting !== null}>{exporting === 'shot-map' ? '생성 중…' : '샷맵'}</button>
          <button type="button" onClick={() => void downloadVisualization('margin-flow')} disabled={!selectedMatch || exporting !== null}>{exporting === 'margin-flow' ? '생성 중…' : '마진 플로우'}</button>
          <button type="button" onClick={() => void downloadVisualization('rebounds')} disabled={!selectedMatch || exporting !== null}>{exporting === 'rebounds' ? '생성 중…' : '리바운드'}</button>
        </div>
        {selectedMatch ? <Link className="button-link button-compact btn-secondary" href={`/admin/basketball/match/${selectedMatch.id}`}>FLA 기록 열기</Link> : null}
      </section>

      {error ? <p className="basketball-viz-error">{error}</p> : null}
      {exportError ? <p className="basketball-viz-error">{exportError}</p> : null}
      {!selectedMatch ? <section className="card card-panel"><p className="muted">완료·아카이브된 농구 경기가 없습니다.</p></section> : null}
      {selectedMatch ? (
        <section className="basketball-viz-frame">
          <header className="basketball-viz-brandbar">
            <img src="/live-coder/fineplay-logo.png" alt="FinePlay" />
            <div className="basketball-viz-brand-copy">
              <span>POST GAME ANALYTICS</span>
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

          <section ref={shotExportRef} className="basketball-viz-shotmaps">
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

          <div ref={marginExportRef}>
            <MarginFlow events={events} periodMinutes={periodMinutes} periodCount={periodCount} labels={labels} />
          </div>

          <section ref={reboundExportRef} className="basketball-viz-rebounds-panel">
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
