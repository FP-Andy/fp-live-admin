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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function pct(value: number | undefined) {
  return `${Math.round(Number(value || 0))}%`;
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
          <div className="bc-attack-copy"><span>공격 방향 · 비율</span><b>전개 횟수</b></div>
          <svg className="bc-attack-arrows" viewBox="0 0 238 415" aria-label="공격 방향">
            <defs>
              {lanes.map((lane) => <linearGradient id={`bc-attack-gradient-${lane.key}`} key={lane.key} x1="0" y1="1" x2="0" y2="0">
                <stop offset="0" stopColor="var(--team-color)" stopOpacity="0" />
                <stop offset=".42" stopColor="var(--team-color)" stopOpacity={0.36 + Number(ranked.get(lane.key) || 0) * 0.08} />
                <stop offset="1" stopColor="var(--team-color)" stopOpacity={1 - Number(ranked.get(lane.key) || 0) * 0.14} />
              </linearGradient>)}
            </defs>
            {lanes.map((lane) => {
              const laneRank = Number(ranked.get(lane.key) || 0);
              const height = 40 + clamp(lane.value, 0, 100) * 2.48;
              const top = 342 - height;
              const shaft = (5.5 + clamp(lane.value, 0, 100) * 0.075) * 2;
              const headWidth = shaft * 2.7;
              const headHeight = shaft * 2.25;
              return (
                <g className="bc-attack-arrow" key={lane.key} opacity={1 - laneRank * 0.13}>
                  <rect x={lane.x - shaft / 2} y={top + headHeight * .7} width={shaft} height={342 - top} fill={`url(#bc-attack-gradient-${lane.key})`} />
                  <path d={`M ${lane.x} ${top} L ${lane.x - headWidth} ${top + headHeight} L ${lane.x - shaft / 2} ${top + headHeight} L ${lane.x - shaft / 2} ${top + headHeight * 1.42} L ${lane.x + shaft / 2} ${top + headHeight * 1.42} L ${lane.x + shaft / 2} ${top + headHeight} L ${lane.x + headWidth} ${top + headHeight} Z`} fill="var(--team-color)" />
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
  const shots = snapshot.analysis.xg || [];
  const stats = (side: 'HOME' | 'AWAY') => {
    const rows = shots.filter((item) => item.team === side);
    return { shots: rows.length, onTarget: rows.filter((item) => Number(item.xgot || 0) > 0 || item.is_goal).length };
  };
  const homeStats = stats('HOME');
  const awayStats = stats('AWAY');
  const style = { '--home-color': home.color, '--away-color': away.color } as CSSProperties;
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

function starPoints(cx: number, cy: number, outer = 11, inner = 5) {
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    const radius = index % 2 ? inner : outer;
    return `${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius}`;
  }).join(' ');
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
  const style = { '--team-color': shotTeam.color } as CSSProperties;
  return (
    <section className="bc-frame bc-shot-xg" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/shot-xg/background.svg" className="bc-shot-xg-template" /><i className="bc-shot-xg-static-copy-mask" /></div>
      <Layer>
        <DesignArtboard className="bc-shot-xg-artboard">
          <svg className="bc-shot-xg-route" viewBox="0 0 362 447" aria-label="슈팅 궤적">
            <defs><linearGradient id="bc-shot-xg-gradient" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="var(--team-color)" stopOpacity=".25" /><stop offset="1" stopColor="var(--team-color)" /></linearGradient></defs>
            <circle className="bc-shot-xg-dot" cx={source.x} cy={source.y} r="8" />
            <line className="bc-shot-xg-line" x1={source.x} y1={source.y} x2={target.x} y2={target.y} />
            <polygon className="bc-shot-xg-star" points={starPoints(target.x, target.y)} />
          </svg>
          <TeamLogo url={shotTeam.logoUrl} name={shotTeam.name} className="bc-shot-xg-logo" />
          <div className="bc-shot-xg-player"><b>득점 {minute}'</b><strong>{row?.player_name || shotTeam.name}</strong></div>
          <div className="bc-shot-xg-value"><span>골 기대값</span><strong>{Number(row?.xg || 0).toFixed(2)}</strong></div>
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
  const shots = snapshot.analysis.xg || [];
  const homeXg = shots.filter((item) => item.team === 'HOME').reduce((sum, item) => sum + Number(item.xg || 0), 0);
  const awayXg = shots.filter((item) => item.team === 'AWAY').reduce((sum, item) => sum + Number(item.xg || 0), 0);
  const xgRatio = (xg: number, score: number) => score > 0 ? xg / score : (xg > 0 ? 1 : 0);
  const maxScore = Math.max(home.score, away.score, 1);
  return (
    <section className="bc-frame bc-xg-comparison" style={{ '--home-color': home.color, '--away-color': away.color } as CSSProperties}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/xg-comparison/background.svg" className="bc-xg-comparison-template" /></div>
      <Layer>
        <DesignArtboard className="bc-xg-comparison-artboard">
          <TeamLogo url={home.logoUrl} name={home.name} className="bc-xg-logo home" />
          <TeamLogo url={away.logoUrl} name={away.name} className="bc-xg-logo away" />
          <strong className="bc-xg-team-name home">{home.name}</strong>
          <strong className="bc-xg-team-name away">{away.name}</strong>
          <strong className="bc-xg-number home">{homeXg.toFixed(2)}</strong><strong className="bc-xg-number away">{awayXg.toFixed(2)}</strong>
          <ComparisonBars className="expected" homeRatio={xgRatio(homeXg, home.score)} awayRatio={xgRatio(awayXg, away.score)} />
          <strong className="bc-xg-score home">{home.score}</strong><strong className="bc-xg-score away">{away.score}</strong>
          <ComparisonBars className="score" homeRatio={home.score / maxScore} awayRatio={away.score / maxScore} />
        </DesignArtboard>
      </Layer>
    </section>
  );
}

type DominanceItem = NonNullable<NonNullable<BroadcastSnapshot['analysis']['match_dominance']>['items']>[number];

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

function Dominance({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const home = team(snapshot, 'HOME');
  const away = team(snapshot, 'AWAY');
  const items = snapshot.analysis.match_dominance?.items || [];
  const path = dominancePath(items);
  const area = path ? `${path} L 1867 633 L 505 633 Z` : '';
  const homeXg = (snapshot.analysis.xg || []).filter((row) => row.team === 'HOME').reduce((sum, row) => sum + Number(row.xg || 0), 0);
  const awayXg = (snapshot.analysis.xg || []).filter((row) => row.team === 'AWAY').reduce((sum, row) => sum + Number(row.xg || 0), 0);
  const firstHalf = Number(snapshot.match.clock_ms || 0) <= 45 * 60_000;
  const matchTitle = `${home.name} vs ${away.name}`;
  const style = { '--home-color': home.color, '--away-color': away.color } as CSSProperties;
  return (
    <section className="bc-frame bc-dominance" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/match-dominance/background.svg" className="bc-dominance-template" /><i className="bc-dominance-header-mask" /></div>
      <Layer>
        <div className="bc-dominance-round">{roundLabel(snapshot)}</div>
        <div className="bc-dominance-match-title">{matchTitle}</div>
        <div className="bc-dominance-period">{firstHalf ? '전반전' : '후반전'} 매치 도미넌스</div>
        <TeamLogo url={home.logoUrl} name={home.name} className="bc-dominance-logo home" />
        <TeamLogo url={away.logoUrl} name={away.name} className="bc-dominance-logo away" />
        <div className="bc-dominance-total home">{homeXg.toFixed(2)}</div>
        <div className="bc-dominance-total away">{awayXg.toFixed(2)}</div>
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
          {path ? <path d={path} className="bc-dominance-line" /> : null}
          <line className="bc-dominance-midline" x1="505" x2="1867" y1="633" y2="633" />
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
