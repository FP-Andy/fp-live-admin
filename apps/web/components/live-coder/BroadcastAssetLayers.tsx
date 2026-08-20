import type { CSSProperties } from 'react';
import type { BroadcastSnapshot } from './types';

export type BroadcastCaptureGraphic =
  | 'ATTACK_DIRECTION_HOME'
  | 'ATTACK_DIRECTION_AWAY'
  | 'POSSESSION'
  | 'SHOTS_COMPARISON'
  | 'SHOT_XG'
  | 'XG_COMPARISON'
  | 'MATCH_DOMINANCE';

const fallbackColors = { HOME: '#f36b21', AWAY: '#1687d4' } as const;

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
    name: label || matchTeam.name || side,
    color: color || fallbackColors[side],
    logoUrl: logoUrl || '',
    score: Number(matchTeam.score || 0),
  };
}

function initials(name: string) {
  return (name || '?').replace(/\[[^\]]+\]/g, '').trim().slice(0, 2).toUpperCase();
}

function TeamLogo({ url, name, className = '' }: { url?: string; name: string; className?: string }) {
  return url ? <img className={className} src={url} alt={`${name} 로고`} /> : <span className={`${className} bc-logo-fallback`}>{initials(name)}</span>;
}

function Template({ src, className }: { src: string; className: string }) {
  return <img className={`bc-template ${className}`} src={src} alt="" aria-hidden="true" />;
}

function Layer({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bc-asset-layer ${className}`}>{children}</div>;
}

function AttackDirection({ snapshot, side }: { snapshot: BroadcastSnapshot; side: 'HOME' | 'AWAY' }) {
  const currentTeam = team(snapshot, side);
  const row = snapshot.analysis.attack_direction?.find((item) => item.team === side);
  const ratio = row?.direction_ratio || {};
  const lanes = [
    { key: 'left', label: 'LEFT', value: Number(ratio.left_pct || 0), count: Number(ratio.left_count || 0), x: 130 },
    { key: 'center', label: 'CENTER', value: Number(ratio.center_pct || 0), count: Number(ratio.center_count || 0), x: 286 },
    { key: 'right', label: 'RIGHT', value: Number(ratio.right_pct || 0), count: Number(ratio.right_count || 0), x: 442 },
  ];
  const order = new Map([...lanes].sort((a, b) => b.value - a.value).map((item, index) => [item.key, index]));
  const style = { '--team-color': currentTeam.color } as CSSProperties;
  return (
    <section className="bc-frame bc-attack" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/attack-direction/background.svg" className="bc-attack-template" /></div>
      <Layer>
        <div className="bc-card-team bc-attack-team">
          <TeamLogo url={currentTeam.logoUrl} name={currentTeam.name} />
          <strong>{currentTeam.name}</strong>
        </div>
        <div className="bc-attack-copy"><span>공격 방향 · 비율</span><b>전개 횟수</b></div>
        <svg className="bc-attack-arrows" viewBox="0 0 572 996" aria-label="공격 방향">
          {lanes.map((lane) => {
            const height = 150 + clamp(lane.value, 0, 100) * 4.4;
            const top = 807 - height;
            const width = 17 + clamp(lane.value, 0, 100) * 0.38;
            return (
              <g className="bc-attack-arrow" key={lane.key} style={{ animationDelay: `${Number(order.get(lane.key) || 0)}s` }}>
                <line x1={lane.x} x2={lane.x} y1="807" y2={top + width} strokeWidth={width} />
                <path d={`M ${lane.x - width * 1.1} ${top + width * 2.2} L ${lane.x} ${top} L ${lane.x + width * 1.1} ${top + width * 2.2}`} strokeWidth={Math.max(10, width * 0.52)} />
              </g>
            );
          })}
        </svg>
        <div className="bc-attack-values">
          {lanes.map((lane) => <div key={lane.key}><strong>{pct(lane.value)}</strong><span>{lane.count}회</span></div>)}
        </div>
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
      <div className="bc-background-layer bc-possession-background"><div /><span>볼 점유율</span></div>
      <Layer>
        <div className="bc-possession-team home"><TeamLogo url={home.logoUrl} name={home.name} /><strong>{home.name}</strong><b>{pct(homePct)}</b></div>
        <div className="bc-possession-team away"><b>{pct(awayPct)}</b><strong>{away.name}</strong><TeamLogo url={away.logoUrl} name={away.name} /></div>
        <div className="bc-possession-track"><i className="home" /><i className="away" /></div>
      </Layer>
    </section>
  );
}

function ShotsComparison({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const home = team(snapshot, 'HOME');
  const away = team(snapshot, 'AWAY');
  const shots = snapshot.analysis.xg || [];
  const stats = (side: 'HOME' | 'AWAY') => {
    const items = shots.filter((item) => item.team === side);
    return { shots: items.length, onTarget: items.filter((item) => Number(item.xgot || 0) > 0 || item.is_goal).length };
  };
  const homeStats = stats('HOME');
  const awayStats = stats('AWAY');
  const style = { '--home-color': home.color, '--away-color': away.color } as CSSProperties;
  return (
    <section className="bc-frame bc-shots" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/shots/background.svg" className="bc-shots-template" /></div>
      <Layer>
        <div className="bc-shots-team home"><TeamLogo url={home.logoUrl} name={home.name} /><b>{home.name}</b></div>
        <div className="bc-shots-team away"><b>{away.name}</b><TeamLogo url={away.logoUrl} name={away.name} /></div>
        <div className="bc-shots-numbers home"><strong>{homeStats.shots}</strong><b>{homeStats.onTarget}</b></div>
        <div className="bc-shots-numbers away"><strong>{awayStats.shots}</strong><b>{awayStats.onTarget}</b></div>
        <div className="bc-shots-labels"><span>슈팅</span><b>유효 슈팅</b></div>
      </Layer>
    </section>
  );
}

function selectedShot(snapshot: BroadcastSnapshot) {
  const rows = snapshot.analysis.xg || [];
  const selected = snapshot.broadcast_state.selected_xg_event_id;
  return rows.find((item) => item.event_id === selected) || rows[rows.length - 1] || null;
}

function ShotXg({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const row = selectedShot(snapshot);
  const shotTeam = row?.team === 'AWAY' ? team(snapshot, 'AWAY') : team(snapshot, 'HOME');
  const shotX = clamp(Number(row?.shot_x ?? 90), 70, 105);
  const shotY = clamp(Number(row?.shot_y ?? 34), 0, 68);
  const goalmouthX = clamp(Number(row?.goalmouth_x ?? .5), 0, 1);
  const goalmouthY = clamp(Number(row?.goalmouth_y ?? .5), 0, 1);
  const source = { x: 155 + (shotY / 68) * 370, y: 657 - ((shotX - 70) / 35) * 300 };
  const target = { x: 205 + goalmouthX * 300, y: 170 + (1 - goalmouthY) * 100 };
  const star = Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    const radius = index % 2 ? 13 : 28;
    return `${target.x + Math.cos(angle) * radius},${target.y + Math.sin(angle) * radius}`;
  }).join(' ');
  const minute = Math.max(0, Math.round(Number(row?.event_clock_ms || 0) / 60_000));
  const style = { '--team-color': shotTeam.color } as CSSProperties;
  return (
    <section className="bc-frame bc-shot-xg" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/shot-xg/background.svg" className="bc-shot-xg-template" /><i className="bc-shot-xg-static-copy-mask" /></div>
      <Layer>
        <svg className="bc-shot-xg-route" viewBox="0 0 680 840">
          <circle className="bc-shot-xg-dot" cx={source.x} cy={source.y} r="24" />
          <line className="bc-shot-xg-line" x1={source.x} y1={source.y} x2={target.x} y2={target.y} />
          <polygon className="bc-shot-xg-star" points={star} />
        </svg>
        <div className="bc-shot-xg-player"><TeamLogo url={shotTeam.logoUrl} name={shotTeam.name} /><span>{row?.player_name || shotTeam.name}</span><b>{minute}'</b></div>
        <div className="bc-shot-xg-value"><span>xG</span><strong>{Number(row?.xg || 0).toFixed(2)}</strong></div>
      </Layer>
    </section>
  );
}

function XgComparison({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const home = team(snapshot, 'HOME');
  const away = team(snapshot, 'AWAY');
  const shots = snapshot.analysis.xg || [];
  const homeXg = shots.filter((item) => item.team === 'HOME').reduce((sum, item) => sum + Number(item.xg || 0), 0);
  const awayXg = shots.filter((item) => item.team === 'AWAY').reduce((sum, item) => sum + Number(item.xg || 0), 0);
  const total = Math.max(homeXg + awayXg, 0.01);
  const scoreTotal = Math.max(home.score + away.score, 1);
  const style = {
    '--home-color': home.color,
    '--away-color': away.color,
    '--home-xg': `${(homeXg / total) * 100}%`,
    '--away-xg': `${(awayXg / total) * 100}%`,
    '--home-score': `${(home.score / scoreTotal) * 100}%`,
    '--away-score': `${(away.score / scoreTotal) * 100}%`,
  } as CSSProperties;
  return (
    <section className="bc-frame bc-xg-comparison" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/xg-comparison/background.svg" className="bc-xg-comparison-template" /></div>
      <Layer>
        <div className="bc-xg-team home"><TeamLogo url={home.logoUrl} name={home.name} /><strong>{home.name}</strong></div>
        <div className="bc-xg-team away"><strong>{away.name}</strong><TeamLogo url={away.logoUrl} name={away.name} /></div>
        <div className="bc-xg-row expected"><b>{homeXg.toFixed(2)}</b><div><i className="home" /><i className="away" /></div><b>{awayXg.toFixed(2)}</b></div>
        <div className="bc-xg-row score"><b>{home.score}</b><div><i className="home" /><i className="away" /></div><b>{away.score}</b></div>
      </Layer>
    </section>
  );
}

function Dominance({ snapshot }: { snapshot: BroadcastSnapshot }) {
  const home = team(snapshot, 'HOME');
  const away = team(snapshot, 'AWAY');
  const items = snapshot.analysis.match_dominance?.items || [];
  const points = items.map((item, index) => {
    const x = items.length <= 1 ? 960 : 240 + (index / (items.length - 1)) * 1440;
    const y = 545 - clamp(Number(item.dominance || 0), -1, 1) * 275;
    return `${x},${y}`;
  }).join(' ');
  const style = { '--home-color': home.color, '--away-color': away.color } as CSSProperties;
  return (
    <section className="bc-frame bc-dominance" style={style}>
      <div className="bc-background-layer"><Template src="/broadcast/templates/match-dominance/background.svg" className="bc-dominance-template" /></div>
      <Layer>
        <div className="bc-dominance-team home"><TeamLogo url={home.logoUrl} name={home.name} /><strong>{home.name}</strong></div>
        <div className="bc-dominance-team away"><strong>{away.name}</strong><TeamLogo url={away.logoUrl} name={away.name} /></div>
        <svg className="bc-dominance-plot" viewBox="0 0 1920 1080">
          <defs>
            <linearGradient id="bc-dominance-team-gradient" x1="240" x2="1680" y1="0" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor={home.color} />
              <stop offset="1" stopColor={away.color} />
            </linearGradient>
          </defs>
          <line x1="240" x2="1680" y1="545" y2="545" />
          {points ? <polyline points={points} stroke="url(#bc-dominance-team-gradient)" /> : null}
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
