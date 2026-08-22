import type { CSSProperties, ReactNode } from 'react';
import type { BroadcastSnapshot } from './types';

export type BroadcastCaptureGraphic =
  | 'ATTACK_DIRECTION_HOME'
  | 'ATTACK_DIRECTION_AWAY'
  | 'POSSESSION'
  | 'SHOTS_COMPARISON'
  | 'SHOT_XG'
  | 'XG_COMPARISON'
  | 'MATCH_DOMINANCE';

const fallbackColors = { HOME: '#ff7900', AWAY: '#1e27ff' } as const;
const contrastFallbackColor = '#101318';

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function pct(value: number | undefined) {
  return `${Math.round(Number(value || 0))}%`;
}

function comparisonColor(color: string) {
  const value = color.trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return color;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  // White/near-white team colours disappear on the comparison cards' white
  // surface. Use the same automatic dark fallback for every foreground bar
  // and metric, while keeping the stored team colour unchanged elsewhere.
  return luminance >= .76 ? contrastFallbackColor : color;
}

function team(snapshot: BroadcastSnapshot, side: 'HOME' | 'AWAY') {
  const state = snapshot.broadcast_state;
  const matchTeam = side === 'HOME' ? snapshot.match.home : snapshot.match.away;
  const color = side === 'HOME' ? state.home_color : state.away_color;
  const logoUrl = side === 'HOME' ? state.home_logo_url : state.away_logo_url;
  const label = side === 'HOME' ? state.home_label : state.away_label;
  return {
    // The graphics are delivered to broadcasters, so a generic Home/Away
    // placeholder must never replace the actual team name.
    name: matchTeam.name || label || side,
    color: color || fallbackColors[side],
    logoUrl: logoUrl || '',
    score: Number(matchTeam.score || 0),
  };
}

function initials(name: string) {
  return (name || '?').replace(/\[[^\]]+\]/g, '').trim().slice(0, 2).toUpperCase();
}

function TeamLogo({ url, name, className = '' }: { url?: string; name: string; className?: string }) {
  return url ? <img data-broadcast-logo="true" className={className} src={url} alt={`${name} 로고`} /> : <span className={`${className} bc-logo-fallback`}>{initials(name)}</span>;
}

function Template({ src, className }: { src: string; className: string }) {
  return <img data-broadcast-template="true" className={`bc-template ${className}`} src={src} alt="" aria-hidden="true" />;
}

function Layer({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bc-asset-layer ${className}`}>{children}</div>;
}

function DesignArtboard({ className, children }: { className: string; children: ReactNode }) {
  return <div className={`bc-design-artboard ${className}`}>{children}</div>;
}

function roundLabel(snapshot: BroadcastSnapshot) {
  const header = snapshot.match.name.match(/\[([^\]]+)\]/)?.[1] || '';
  const round = header.match(/(\d+)\s*R/i)?.[1];
  return round ? `${round} ROUND` : 'ROUND';
}

function AttackDirection({ snapshot, side }: { snapshot: BroadcastSnapshot; side: 'HOME' | 'AWAY' }) {
  const currentTeam = team(snapshot, side);
  const row = snapshot.analysis.attack_direction?.find((item) => item.team === side);
  const ratio = row?.direction_ratio || {};
  const lanes = [
    { key: 'left', value: Number(ratio.left_pct || 0), count: Number(ratio.left_count || 0), x: 51 },
    { key: 'center', value: Number(ratio.center_pct || 0), count: Number(ratio.center_count || 0), x: 119 },
    { key: 'right', value: Number(ratio.right_pct || 0), count: Number(ratio.right_count || 0), x: 187 },
  ];
  const ranked = new Map([...lanes].sort((a, b) => b.value - a.value).map((lane, index) => [lane.key, index]));
  const style = { '--team-color': currentTeam.color } as CSSProperties;
  return (
    <section className="bc-frame bc-attack" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/attack-direction/background.svg" className="bc-attack-template" /></div>
      <Layer>
        <DesignArtboard className="bc-attack-artboard">
          <strong className="bc-attack-team-name">{currentTeam.name}</strong>
          <div className="bc-attack-copy">공격 방향 · 비율 · 전개 횟수</div>
          <svg className="bc-attack-arrows" viewBox="0 0 238 415" aria-label="공격 방향">
            <defs>
              {lanes.map((lane) => <linearGradient id={`bc-attack-gradient-${lane.key}`} key={lane.key} x1="0" y1="1" x2="0" y2="0">
                <stop offset="0" stopColor="var(--team-color)" stopOpacity="0" />
                <stop offset=".42" stopColor="var(--team-color)" stopOpacity={0.36 + Number(ranked.get(lane.key) || 0) * 0.08} />
                <stop offset="1" stopColor="var(--team-color)" stopOpacity="1" />
              </linearGradient>)}
            </defs>
            {lanes.map((lane) => {
              const laneRank = Number(ranked.get(lane.key) || 0);
              const height = 40 + clamp(lane.value, 0, 100) * 2.48;
              const top = 342 - height;
              // Keep the designer's arrowhead proportions.  Only the stem
              // is widened so the direction cue stays sharp at HD scale.
              const headShaft = 5.5 + clamp(lane.value, 0, 100) * 0.075;
              const shaft = headShaft * 2;
              const headWidth = headShaft * 2.7;
              const headHeight = headShaft * 2.25;
              return (
                <g className="bc-attack-arrow" key={lane.key} opacity={1 - laneRank * 0.13}>
                  <rect x={lane.x - shaft / 2} y={top + headHeight * .7} width={shaft} height={342 - top} fill={`url(#bc-attack-gradient-${lane.key})`} />
                  <path d={`M ${lane.x} ${top} L ${lane.x - headWidth} ${top + headHeight} L ${lane.x - headShaft / 2} ${top + headHeight} L ${lane.x - headShaft / 2} ${top + headHeight * 1.42} L ${lane.x + headShaft / 2} ${top + headHeight * 1.42} L ${lane.x + headShaft / 2} ${top + headHeight} L ${lane.x + headWidth} ${top + headHeight} Z`} fill="var(--team-color)" />
                </g>
              );
            })}
          </svg>
          <div className="bc-attack-values">
            {lanes.map((lane) => <div key={lane.key}><strong>{pct(lane.value)}</strong><span>{lane.count}회</span></div>)}
          </div>
        </DesignArtboard>
      </Layer>
    </section>
  );
}

function Possession({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const home = team(snapshot, 'HOME');
  const away = team(snapshot, 'AWAY');
  const rawHome = Number(snapshot.analysis.possession?.home_pct || 0);
  const rawAway = Number(snapshot.analysis.possession?.away_pct || 0);
  const total = rawHome + rawAway;
  const homePct = total > 0 ? (rawHome / total) * 100 : 50;
  const awayPct = total > 0 ? (rawAway / total) * 100 : 50;
  const style = { '--home-color': home.color, '--away-color': away.color, '--home-pct': `${homePct}%`, '--away-pct': `${awayPct}%` } as CSSProperties;
  return (
    <section className="bc-frame bc-possession-frame" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/possession/background.svg" className="bc-possession-template" /></div>
      <Layer>
        <DesignArtboard className="bc-possession-artboard">
          <strong className="bc-possession-title">볼 점유율 <small>(%)</small></strong>
          <TeamLogo url={home.logoUrl} name={home.name} className="bc-possession-logo home" />
          <TeamLogo url={away.logoUrl} name={away.name} className="bc-possession-logo away" />
          <strong className="bc-possession-team-name home">{home.name}</strong>
          <strong className="bc-possession-team-name away">{away.name}</strong>
          <div className="bc-possession-value home">{pct(homePct)}</div>
          <div className="bc-possession-value away">{pct(awayPct)}</div>
          <div className="bc-possession-track"><i className="home" /><i className="away" /></div>
        </DesignArtboard>
      </Layer>
    </section>
  );
}

function ShotsComparison({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const home = team(snapshot, 'HOME');
  const away = team(snapshot, 'AWAY');
  const homeComparisonColor = comparisonColor(home.color);
  const awayComparisonColor = comparisonColor(away.color);
  const shots = snapshot.analysis.xg || [];
  const stats = (side: 'HOME' | 'AWAY') => {
    const rows = shots.filter((item) => item.team === side);
    return { shots: rows.length, onTarget: rows.filter((item) => Number(item.xgot || 0) > 0 || item.is_goal).length };
  };
  const homeStats = stats('HOME');
  const awayStats = stats('AWAY');
  const style = { '--home-color': homeComparisonColor, '--away-color': awayComparisonColor } as CSSProperties;
  return (
    <section className="bc-frame bc-shots" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/shots/background-v2.svg" className="bc-shots-template" /></div>
      <Layer>
        <DesignArtboard className="bc-shots-artboard">
          <TeamLogo url={home.logoUrl} name={home.name} className="bc-shots-logo home" />
          <TeamLogo url={away.logoUrl} name={away.name} className="bc-shots-logo away" />
          <strong className="bc-shots-team-name home">{home.name}</strong>
          <strong className="bc-shots-team-name away">{away.name}</strong>
          <div className="bc-shots-grid">
            <div className="bc-shots-value home">{homeStats.shots}</div><span>슈팅</span><div className="bc-shots-value away">{awayStats.shots}</div>
            <div className="bc-shots-value home">{homeStats.onTarget}</div><b>유효<br />슈팅</b><div className="bc-shots-value away">{awayStats.onTarget}</div>
          </div>
        </DesignArtboard>
      </Layer>
    </section>
  );
}

function selectedShot(snapshot: BroadcastSnapshot) {
  const rows = snapshot.analysis.xg || [];
  const selected = snapshot.broadcast_state.selected_xg_event_id;
  return rows.find((item) => item.event_id === selected) || rows[rows.length - 1] || null;
}

function shotRouteTransform(source: { x: number; y: number }, target: { x: number; y: number }) {
  // The supplied Shot xG SVG runs from its white ball (113.7, 184.7) to its
  // mint goal ball (12.7, 12.7). Map that authored route onto live event
  // coordinates so the original ball, arrow and trail stay together.
  const assetStart = { x: 113.737, y: 184.739 };
  const assetEnd = { x: 12.737, y: 12.739 };
  const dx = assetEnd.x - assetStart.x;
  const dy = assetEnd.y - assetStart.y;
  const vx = target.x - source.x;
  const vy = target.y - source.y;
  const lengthSq = dx * dx + dy * dy;
  const a = (vx * dx + vy * dy) / lengthSq;
  const b = (vy * dx - vx * dy) / lengthSq;
  const tx = source.x - (a * assetStart.x - b * assetStart.y);
  const ty = source.y - (b * assetStart.x + a * assetStart.y);
  return `matrix(${a} ${b} ${-b} ${a} ${tx} ${ty})`;
}

function ShotXg({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const row = selectedShot(snapshot);
  const shotTeam = row?.team === 'AWAY' ? team(snapshot, 'AWAY') : team(snapshot, 'HOME');
  const shotX = clamp(Number(row?.shot_x ?? 90), 70, 105);
  const shotY = clamp(Number(row?.shot_y ?? 34), 0, 68);
  const goalmouthX = clamp(Number(row?.goalmouth_x ?? .5), 0, 1);
  const goalmouthY = clamp(Number(row?.goalmouth_y ?? .5), 0, 1);
  const source = { x: 31 + (shotY / 68) * 300, y: 336 - ((shotX - 70) / 35) * 167 };
  const target = { x: 31 + goalmouthX * 300, y: 32 + (1 - goalmouthY) * 100 };
  const minute = Math.max(0, Math.round(Number(row?.event_clock_ms || 0) / 60_000));
  const routeTransform = shotRouteTransform(source, target);
  const style = { '--team-color': shotTeam.color } as CSSProperties;
  return (
    <section className="bc-frame bc-shot-xg" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/shot-xg/background.svg" className="bc-shot-xg-template" /><i className="bc-shot-xg-static-copy-mask" /></div>
      <Layer>
        <DesignArtboard className="bc-shot-xg-artboard">
          <svg className="bc-shot-xg-route" viewBox="0 0 362 447" aria-label="슈팅 궤적">
            <image href="/broadcast/templates/shot-xg/asset.svg" width="127" height="198" transform={routeTransform} />
          </svg>
          <TeamLogo url={shotTeam.logoUrl} name={shotTeam.name} className="bc-shot-xg-logo" />
          <div className="bc-shot-xg-player"><b><span>득점 {minute}'</span><em>{shotTeam.name}</em></b><strong>{row?.player_name || shotTeam.name}</strong></div>
          <i className="bc-shot-xg-divider" aria-hidden="true" />
          <div className="bc-shot-xg-value"><strong>{Number(row?.xg || 0).toFixed(2)}</strong><span>골 기대값</span></div>
        </DesignArtboard>
      </Layer>
    </section>
  );
}

function ComparisonBars({ homeRatio, awayRatio, className }: { homeRatio: number; awayRatio: number; className: string }) {
  return (
    <div className={`bc-xg-bars ${className}`}>
      <i className="home" style={{ width: `${clamp(homeRatio, 0, 1) * 50}%` }} />
      <i className="away" style={{ width: `${clamp(awayRatio, 0, 1) * 50}%` }} />
    </div>
  );
}

function XgComparison({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const home = team(snapshot, 'HOME');
  const away = team(snapshot, 'AWAY');
  const homeComparisonColor = comparisonColor(home.color);
  const awayComparisonColor = comparisonColor(away.color);
  const shots = snapshot.analysis.xg || [];
  const homeXg = shots.filter((item) => item.team === 'HOME').reduce((sum, item) => sum + Number(item.xg || 0), 0);
  const awayXg = shots.filter((item) => item.team === 'AWAY').reduce((sum, item) => sum + Number(item.xg || 0), 0);
  // Both rows use one shared scale. Comparing xG to a team's own goals made
  // a smaller xG value look full-width whenever it exceeded that score.
  const maxMetric = Math.max(homeXg, awayXg, home.score, away.score, 1);
  return (
    <section className="bc-frame bc-xg-comparison" style={{ '--home-color': homeComparisonColor, '--away-color': awayComparisonColor } as CSSProperties}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/xg-comparison/background.svg" className="bc-xg-comparison-template" /></div>
      <Layer>
        <DesignArtboard className="bc-xg-comparison-artboard">
          <TeamLogo url={home.logoUrl} name={home.name} className="bc-xg-logo home" />
          <TeamLogo url={away.logoUrl} name={away.name} className="bc-xg-logo away" />
          <strong className="bc-xg-team-name home">{home.name}</strong>
          <strong className="bc-xg-team-name away">{away.name}</strong>
          <strong className="bc-xg-number home">{homeXg.toFixed(2)}</strong><strong className="bc-xg-number away">{awayXg.toFixed(2)}</strong>
          <ComparisonBars className="expected" homeRatio={homeXg / maxMetric} awayRatio={awayXg / maxMetric} />
          <strong className="bc-xg-score home">{home.score}</strong><strong className="bc-xg-score away">{away.score}</strong>
          <ComparisonBars className="score" homeRatio={home.score / maxMetric} awayRatio={away.score / maxMetric} />
        </DesignArtboard>
      </Layer>
    </section>
  );
}

type DominanceItem = NonNullable<NonNullable<BroadcastSnapshot['analysis']['match_dominance']>['items']>[number];

function dominanceXt(items: DominanceItem[]) {
  return items.reduce((total, item) => {
    const value = clamp(Number(item.dominance || 0), -1, 1);
    if (value >= 0) total.home += value;
    else total.away += Math.abs(value);
    return total;
  }, { home: 0, away: 0 });
}

function dominancePath(items: DominanceItem[], startX = 505, width = 1362, midY = 633, amplitude = 222) {
  const points = items.map((item, index) => ({
    x: items.length <= 1 ? startX : startX + (index / (items.length - 1)) * width,
    y: midY - clamp(Number(item.dominance || 0), -1, 1) * amplitude,
  }));
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.reduce((path, point, index) => {
    if (!index) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1];
    const controlX = (previous.x + point.x) / 2;
    return `${path} C ${controlX} ${previous.y}, ${controlX} ${point.y}, ${point.x} ${point.y}`;
  }, '');
}

function dominanceGoalPoint(items: DominanceItem[], clockMs: number, startX = 505, width = 1362, midY = 633, amplitude = 222) {
  if (!items.length) return null;
  const binMs = 3 * 60_000;
  const endMs = Math.max(binMs, Number(items[items.length - 1].base_time_ms || 0) + binMs);
  const index = clamp(Math.floor(Math.max(0, clockMs) / binMs), 0, items.length - 1);
  const value = clamp(Number(items[index].dominance || 0), -1, 1);
  return {
    x: startX + clamp(clockMs / endMs, 0, 1) * width,
    y: midY - value * amplitude,
  };
}

function Dominance({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const home = team(snapshot, 'HOME');
  const away = team(snapshot, 'AWAY');
  const items = snapshot.analysis.match_dominance?.items || [];
  const path = dominancePath(items);
  const area = path ? `${path} L 1867 633 L 505 633 Z` : '';
  // xT is the accumulated absolute dominance contribution.  Positive bins
  // belong to HOME and negative bins to AWAY, so their split directly shows
  // which team controlled more of the three-minute match-flow intervals.
  const xT = dominanceXt(items);
  const currentClockMs = Number(snapshot.match.fla_clock_ms || snapshot.match.clock_ms || 0);
  const firstHalfMinutes = Math.max(1, Number(snapshot.match.first_half_minutes || 45));
  const secondHalfMinutes = Math.max(1, Number(snapshot.match.second_half_minutes || firstHalfMinutes));
  const fullMatchMinutes = firstHalfMinutes + secondHalfMinutes;
  const firstHalf = currentClockMs <= firstHalfMinutes * 60_000;
  const timelineDuration = firstHalf ? firstHalfMinutes : fullMatchMinutes;
  const timelineMinutes = Array.from(new Set([
    0,
    ...Array.from({ length: Math.floor(timelineDuration / 15) + 1 }, (_, index) => index * 15).filter((minute) => minute < timelineDuration),
    timelineDuration,
  ]));
  const halftimeDividerX = 505 + (firstHalfMinutes / fullMatchMinutes) * 1362;
  const matchTitle = `${home.name} vs ${away.name}`;
  const goalMarkers = (snapshot.analysis.xg || [])
    .filter((item) => item.is_goal && Number(item.event_clock_ms || 0) <= currentClockMs)
    .map((item) => ({
      side: item.team === 'AWAY' ? 'AWAY' as const : 'HOME' as const,
      point: dominanceGoalPoint(items, Number(item.event_clock_ms || 0)),
    }))
    .filter((item): item is { side: 'HOME' | 'AWAY'; point: NonNullable<ReturnType<typeof dominanceGoalPoint>> } => Boolean(item.point));
  const style = { '--home-color': home.color, '--away-color': away.color } as CSSProperties;
  return (
    <section className="bc-frame bc-dominance" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/match-dominance/background.svg" className="bc-dominance-template" /><i className="bc-dominance-header-mask" /></div>
      <Layer>
        <div className="bc-dominance-round">{roundLabel(snapshot)}</div>
        <div className="bc-dominance-match-title">{matchTitle}</div>
        <div className="bc-dominance-period">{firstHalf ? '전반전' : '경기'} 매치 도미넌스</div>
        <TeamLogo url={home.logoUrl} name={home.name} className="bc-dominance-logo home" />
        <TeamLogo url={away.logoUrl} name={away.name} className="bc-dominance-logo away" />
        <div className="bc-dominance-total home">{xT.home.toFixed(1)}</div>
        <div className="bc-dominance-total away">{xT.away.toFixed(1)}</div>
        <div className="bc-dominance-score"><strong>{home.score}</strong><strong>{away.score}</strong></div>
        <svg className="bc-dominance-plot" viewBox="0 0 1920 1080" aria-label="매치 도미넌스 그래프">
          <defs>
            <clipPath id="bc-dominance-top"><rect x="505" y="182" width="1362" height="451" /></clipPath>
            <clipPath id="bc-dominance-bottom"><rect x="505" y="633" width="1362" height="251" /></clipPath>
            <linearGradient id="bc-dominance-home-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={home.color} stopOpacity=".64" /><stop offset="1" stopColor={home.color} stopOpacity=".06" /></linearGradient>
            <linearGradient id="bc-dominance-away-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={away.color} stopOpacity=".06" /><stop offset="1" stopColor={away.color} stopOpacity=".64" /></linearGradient>
          </defs>
          {area ? <path d={area} className="bc-dominance-area home" clipPath="url(#bc-dominance-top)" /> : null}
          {area ? <path d={area} className="bc-dominance-area away" clipPath="url(#bc-dominance-bottom)" /> : null}
          {!firstHalf ? <line className="bc-dominance-halftime-divider" x1={halftimeDividerX} x2={halftimeDividerX} y1="182" y2="884" /> : null}
          {path ? <path d={path} className="bc-dominance-line" /> : null}
          <line className="bc-dominance-midline" x1="505" x2="1867" y1="633" y2="633" />
          <g className="bc-dominance-timeline" aria-label={`${firstHalf ? '전반전' : '전체 경기'} 시간축`}>
            <line className="bc-dominance-timeline-axis" x1="505" x2="1867" y1="922" y2="922" />
            {timelineMinutes.map((minute) => {
              const x = 505 + (minute / timelineDuration) * 1362;
              return (
                <g key={minute} transform={`translate(${x} 922)`}>
                  <line className="bc-dominance-timeline-tick" x1="0" x2="0" y1="0" y2="15" />
                  <text className="bc-dominance-timeline-label" x="0" y="50" textAnchor="middle">{minute}&apos;</text>
                </g>
              );
            })}
          </g>
          {goalMarkers.map(({ side, point }, index) => {
            const markerHeight = 315;
            const markerY = side === 'HOME'
              ? clamp(point.y - 22, 184, 633 - markerHeight)
              : clamp(point.y - markerHeight + 22, 633, 1080 - markerHeight);
            return (
              <image
                className={`bc-dominance-goal-marker ${side.toLowerCase()}`}
                href="/broadcast/templates/match-dominance/goal-marker.png"
                x={point.x - 20}
                y={markerY}
                width="40"
                height="315"
                transform={side === 'AWAY' ? `rotate(180 ${point.x} ${markerY + markerHeight / 2})` : undefined}
                key={`${side}-${point.x}-${index}`}
              />
            );
          })}
        </svg>
      </Layer>
    </section>
  );
}

export function BroadcastAssetLayers({ snapshot, graphic }: { snapshot: BroadcastSnapshot; graphic: BroadcastCaptureGraphic }) {
  if (graphic === 'ATTACK_DIRECTION_HOME') return <AttackDirection snapshot={snapshot} side="HOME" />;
  if (graphic === 'ATTACK_DIRECTION_AWAY') return <AttackDirection snapshot={snapshot} side="AWAY" />;
  if (graphic === 'POSSESSION') return <Possession snapshot={snapshot} />;
  if (graphic === 'SHOTS_COMPARISON') return <ShotsComparison snapshot={snapshot} />;
  if (graphic === 'SHOT_XG') return <ShotXg snapshot={snapshot} />;
  if (graphic === 'XG_COMPARISON') return <XgComparison snapshot={snapshot} />;
  return <Dominance snapshot={snapshot} />;
}
