import type { CSSProperties } from 'react';
import Link from 'next/link';
import { BroadcastAssetLayers, type BroadcastCaptureGraphic } from './live-coder/BroadcastAssetLayers';
import type { BroadcastSnapshot } from './live-coder/types';

type Team = 'HOME' | 'AWAY';
type DemoShot = NonNullable<BroadcastSnapshot['analysis']['xg']>[number] & { id: string; minute: number };

const DEMO_MATCH_ID = '00000000-0000-4000-8000-000000000090';
const HOME_TEAM = '데모 홈';
const AWAY_TEAM = '데모 어웨이';
const ARCHIVE_MINUTES = [15, 30, 45, 60, 75, 90];

// 30 three-minute bins form a completed 90-minute match.  The values are
// intentionally mixed: HOME controls more total xT, while AWAY converts more
// of its chances into goals.  This makes both the graph and the xT split easy
// to check at a glance.
const DOMINANCE_BINS = [
  .58, .71, .64, .77, .52, .48, .62, .68, .54, .41,
  .59, .37, .44, .33, -.25, .21, .16, -.08, -.18, -.32,
  -.45, -.59, -.71, -.64, -.48, -.39, -.28, -.18, -.12, -.09,
];

const POSSESSION_BY_MINUTE: Record<number, number> = {
  15: 56,
  30: 58,
  45: 55,
  60: 53,
  75: 51,
  90: 52,
};

const ATTACKS: Array<{ minute: number; team: Team; lane: 'left' | 'center' | 'right' }> = [
  { minute: 2, team: 'HOME', lane: 'left' }, { minute: 5, team: 'HOME', lane: 'center' },
  { minute: 8, team: 'AWAY', lane: 'right' }, { minute: 11, team: 'HOME', lane: 'center' },
  { minute: 14, team: 'HOME', lane: 'right' }, { minute: 17, team: 'AWAY', lane: 'left' },
  { minute: 20, team: 'HOME', lane: 'center' }, { minute: 23, team: 'HOME', lane: 'left' },
  { minute: 26, team: 'AWAY', lane: 'right' }, { minute: 29, team: 'HOME', lane: 'center' },
  { minute: 32, team: 'HOME', lane: 'right' }, { minute: 35, team: 'AWAY', lane: 'center' },
  { minute: 38, team: 'AWAY', lane: 'left' }, { minute: 41, team: 'HOME', lane: 'center' },
  { minute: 44, team: 'AWAY', lane: 'right' }, { minute: 48, team: 'HOME', lane: 'left' },
  { minute: 51, team: 'AWAY', lane: 'center' }, { minute: 54, team: 'HOME', lane: 'center' },
  { minute: 57, team: 'AWAY', lane: 'right' }, { minute: 60, team: 'AWAY', lane: 'left' },
  { minute: 63, team: 'AWAY', lane: 'center' }, { minute: 66, team: 'HOME', lane: 'right' },
  { minute: 69, team: 'AWAY', lane: 'right' }, { minute: 72, team: 'AWAY', lane: 'center' },
  { minute: 75, team: 'HOME', lane: 'left' }, { minute: 78, team: 'AWAY', lane: 'right' },
  { minute: 81, team: 'HOME', lane: 'center' }, { minute: 84, team: 'AWAY', lane: 'left' },
  { minute: 87, team: 'HOME', lane: 'right' }, { minute: 89, team: 'AWAY', lane: 'center' },
];

const SHOTS: DemoShot[] = [
  { id: 'demo-shot-12', minute: 12, team: 'HOME', xg: .13, xgot: .18, player_name: '김도윤', event_clock_ms: 12 * 60_000, event_clock: '12:00', is_goal: false, event_id: 'demo-shot-12', shot_x: 86, shot_y: 16, goalmouth_x: .28, goalmouth_y: .62 },
  { id: 'demo-shot-18', minute: 18, team: 'AWAY', xg: .08, xgot: 0, player_name: '이현우', event_clock_ms: 18 * 60_000, event_clock: '18:00', is_goal: false, event_id: 'demo-shot-18', shot_x: 80, shot_y: 53, goalmouth_x: .72, goalmouth_y: .44 },
  { id: 'demo-goal-23', minute: 23, team: 'HOME', xg: .41, xgot: .79, player_name: '박준서', event_clock_ms: 23 * 60_000, event_clock: '23:00', is_goal: true, event_id: 'demo-goal-23', shot_x: 90, shot_y: 27, goalmouth_x: .62, goalmouth_y: .76 },
  { id: 'demo-shot-31', minute: 31, team: 'HOME', xg: .18, xgot: .26, player_name: '김도윤', event_clock_ms: 31 * 60_000, event_clock: '31:00', is_goal: false, event_id: 'demo-shot-31', shot_x: 84, shot_y: 43, goalmouth_x: .44, goalmouth_y: .31 },
  { id: 'demo-goal-38', minute: 38, team: 'AWAY', xg: .57, xgot: .92, player_name: '최민재', event_clock_ms: 38 * 60_000, event_clock: '38:00', is_goal: true, event_id: 'demo-goal-38', shot_x: 94, shot_y: 46, goalmouth_x: .36, goalmouth_y: .72 },
  { id: 'demo-shot-49', minute: 49, team: 'HOME', xg: .07, xgot: 0, player_name: '정우진', event_clock_ms: 49 * 60_000, event_clock: '49:00', is_goal: false, event_id: 'demo-shot-49', shot_x: 77, shot_y: 21, goalmouth_x: .56, goalmouth_y: .25 },
  { id: 'demo-shot-63', minute: 63, team: 'AWAY', xg: .19, xgot: .32, player_name: '이현우', event_clock_ms: 63 * 60_000, event_clock: '63:00', is_goal: false, event_id: 'demo-shot-63', shot_x: 88, shot_y: 55, goalmouth_x: .75, goalmouth_y: .57 },
  { id: 'demo-goal-71', minute: 71, team: 'AWAY', xg: .26, xgot: .83, player_name: '한지훈', event_clock_ms: 71 * 60_000, event_clock: '71:00', is_goal: true, event_id: 'demo-goal-71', shot_x: 91, shot_y: 38, goalmouth_x: .49, goalmouth_y: .69 },
  { id: 'demo-shot-82', minute: 82, team: 'HOME', xg: .53, xgot: .58, player_name: '박준서', event_clock_ms: 82 * 60_000, event_clock: '82:00', is_goal: false, event_id: 'demo-shot-82', shot_x: 95, shot_y: 29, goalmouth_x: .58, goalmouth_y: .39 },
  { id: 'demo-shot-88', minute: 88, team: 'AWAY', xg: .15, xgot: 0, player_name: '최민재', event_clock_ms: 88 * 60_000, event_clock: '88:00', is_goal: false, event_id: 'demo-shot-88', shot_x: 83, shot_y: 14, goalmouth_x: .19, goalmouth_y: .33 },
];

const LIVE_GRAPHICS: Array<{ label: string; graphic: BroadcastCaptureGraphic }> = [
  { label: '공격 방향 · 홈', graphic: 'ATTACK_DIRECTION_HOME' },
  { label: '공격 방향 · 어웨이', graphic: 'ATTACK_DIRECTION_AWAY' },
  { label: '점유율', graphic: 'POSSESSION' },
  { label: '슈팅 비교', graphic: 'SHOTS_COMPARISON' },
  { label: 'xG 비교', graphic: 'XG_COMPARISON' },
];

function minuteClock(minute: number) {
  return `${String(minute).padStart(2, '0')}:00`;
}

function possessionAt(minute: number) {
  const key = [...ARCHIVE_MINUTES].reverse().find((value) => value <= minute) || 15;
  return POSSESSION_BY_MINUTE[key];
}

function directionRatio(side: Team, minute: number) {
  const rows = ATTACKS.filter((row) => row.team === side && row.minute <= minute);
  const count = (lane: 'left' | 'center' | 'right') => rows.filter((row) => row.lane === lane).length;
  const left = count('left');
  const center = count('center');
  const right = count('right');
  const total = Math.max(1, rows.length);
  return {
    left_pct: left / total * 100,
    center_pct: center / total * 100,
    right_pct: right / total * 100,
    left_count: left,
    center_count: center,
    right_count: right,
    total_count: rows.length,
  };
}

function scoreAt(minute: number) {
  return SHOTS.filter((shot) => shot.is_goal && shot.minute <= minute).reduce((score, shot) => {
    score[shot.team] += 1;
    return score;
  }, { HOME: 0, AWAY: 0 });
}

function snapshotAt(minute: number, selectedGoalId?: string): BroadcastSnapshot {
  const score = scoreAt(minute);
  const clockMs = minute * 60_000;
  const items = DOMINANCE_BINS.slice(0, Math.ceil(minute / 3)).map((dominance, index) => ({
    base_time_ms: index * 3 * 60_000,
    base_time: minuteClock(index * 3),
    dominance,
  }));
  return {
    match: {
      id: DEMO_MATCH_ID,
      name: '[DEMO | 90M] 데모 홈 vs 데모 어웨이',
      sport: 'FOOTBALL',
      home: { name: HOME_TEAM, score: score.HOME },
      away: { name: AWAY_TEAM, score: score.AWAY },
      clock: minuteClock(minute),
      clock_ms: clockMs,
      fla_clock: minuteClock(minute),
      fla_clock_ms: clockMs,
      running: false,
    },
    broadcast_state: {
      match_id: DEMO_MATCH_ID,
      sport: 'FOOTBALL',
      scoreboard_visible: true,
      possession_visible: true,
      active_graphic: null,
      selected_xg_event_id: selectedGoalId || null,
      event_graphic: null,
      fullscreen_graphic: null,
      theme_id: 'broadcast-demo',
      home_label: HOME_TEAM,
      away_label: AWAY_TEAM,
      home_color: '',
      away_color: '',
      home_logo_url: null,
      away_logo_url: null,
      home_score: score.HOME,
      away_score: score.AWAY,
      clock_ms: clockMs,
      clock_running: false,
      sequence: minute,
      updated_at: '2026-08-21T12:00:00.000Z',
    },
    analysis: {
      possession: { home_pct: possessionAt(minute), away_pct: 100 - possessionAt(minute) },
      attack_direction: [
        { team: 'HOME', direction_ratio: directionRatio('HOME', minute) },
        { team: 'AWAY', direction_ratio: directionRatio('AWAY', minute) },
      ],
      xg: SHOTS.filter((shot) => shot.minute <= minute),
      match_dominance: { items },
    },
    updated_at: '2026-08-21T12:00:00.000Z',
  };
}

function xTSummary(snapshot: BroadcastSnapshot) {
  const values = snapshot.analysis.match_dominance?.items || [];
  const split = values.reduce((total, item) => {
    const value = Math.max(-1, Math.min(1, Number(item.dominance || 0)));
    if (value >= 0) total.home += value;
    else total.away += Math.abs(value);
    return total;
  }, { home: 0, away: 0 });
  const total = split.home + split.away;
  return {
    ...split,
    total,
    homeShare: total ? split.home / total * 100 : 50,
    awayShare: total ? split.away / total * 100 : 50,
    bins: values.length,
  };
}

function DemoGraphicCard({ title, graphic, snapshot, scale = .25, meta }: { title: string; graphic: BroadcastCaptureGraphic; snapshot: BroadcastSnapshot; scale?: number; meta: string }) {
  const previewStyle = {
    width: `${1920 * scale}px`,
    height: `${1080 * scale}px`,
    '--demo-scale': String(scale),
  } as CSSProperties;
  return (
    <article className="broadcast-asset-card broadcast-demo-asset-card">
      <header><strong>{title}</strong><span className="broadcast-png-badge">목 데이터 · HD 레이어</span></header>
      <div className="broadcast-demo-graphic-stage">
        <div className="broadcast-demo-graphic-scale" style={previewStyle}>
          <div className="broadcast-demo-graphic-canvas"><div className="bc-capture-root"><BroadcastAssetLayers snapshot={snapshot} graphic={graphic} /></div></div>
        </div>
      </div>
      <footer>{meta}</footer>
    </article>
  );
}

export function BroadcastCompletedDemoRoom() {
  const fulltime = snapshotAt(90);
  const fulltimeXt = xTSummary(fulltime);
  const halftime = snapshotAt(45);
  const halftimeXt = xTSummary(halftime);
  const goals = SHOTS.filter((shot) => shot.is_goal);
  return (
    <main className="broadcast-showroom broadcast-demo-room">
      <Link href="/" className="broadcast-back">← 경기 목록</Link>
      <section className="broadcast-hero broadcast-match-hero">
        <span>COMPLETED DEMO · 90:00</span>
        <h1>{HOME_TEAM} <i>vs</i> {AWAY_TEAM}</h1>
        <p>로고와 팀 컬러를 비워 둔 90분 완료 가상 경기입니다. 실제 수집 규칙과 같은 시간 구간별 스냅샷으로 아카이브 카드를 확인할 수 있습니다.</p>
        <div className="broadcast-demo-summary" aria-label="데모 생성 결과">
          <div><strong>6</strong><span>15분 아카이브 시점</span></div>
          <div><strong>{ARCHIVE_MINUTES.length * LIVE_GRAPHICS.length}</strong><span>비교 그래픽 카드</span></div>
          <div><strong>{goals.length}</strong><span>득점 Shot xG 카드</span></div>
          <div><strong>2</strong><span>매치 도미넌스 카드</span></div>
        </div>
      </section>

      <section className="broadcast-section">
        <div className="broadcast-section-heading"><h2>경기 종료 시점 · 실시간 그래픽</h2><p>90분 종료 데이터로 갱신된 현재 레이어입니다.</p></div>
        <div className="broadcast-demo-live-grid">
          {LIVE_GRAPHICS.map(({ label, graphic }) => <DemoGraphicCard key={graphic} title={label} graphic={graphic} snapshot={fulltime} scale={.3} meta="90:00 종료 데이터" />)}
        </div>
      </section>

      <section className="broadcast-section">
        <div className="broadcast-section-heading"><h2>15분 아카이브</h2><p>각 시점의 데이터 상태를 고정한 6개 장면입니다. 현재 등록된 비교 그래픽 5종 기준으로 총 30장을 확인합니다.</p></div>
        {ARCHIVE_MINUTES.map((minute) => {
          const snapshot = snapshotAt(minute);
          const score = scoreAt(minute);
          return (
            <div className="broadcast-archive-row broadcast-demo-archive-row" key={minute}>
              <h3>{minute}분 <small>· {HOME_TEAM} {score.HOME} : {score.AWAY} {AWAY_TEAM}</small></h3>
              <div className="broadcast-demo-archive-grid">
                {LIVE_GRAPHICS.map(({ label, graphic }) => <DemoGraphicCard key={graphic} title={label} graphic={graphic} snapshot={snapshot} meta={`${minute}:00 아카이브 고정`} />)}
              </div>
            </div>
          );
        })}
      </section>

      <section className="broadcast-section">
        <div className="broadcast-section-heading"><h2>Shot xG 득점 아카이브</h2><p>득점 이벤트가 들어온 순간마다 1장씩 보관됩니다. 이 데모에서는 3득점이므로 3장이 생성됩니다.</p></div>
        <div className="broadcast-demo-goal-grid">
          {goals.map((goal, index) => <DemoGraphicCard key={goal.id} title={`득점 ${index + 1} · ${goal.minute}분`} graphic="SHOT_XG" snapshot={snapshotAt(goal.minute, goal.id)} scale={.3} meta={`${goal.player_name || '선수'} · xG ${Number(goal.xg || 0).toFixed(2)} · ${goal.team === 'HOME' ? HOME_TEAM : AWAY_TEAM}`} />)}
        </div>
      </section>

      <section className="broadcast-section">
        <div className="broadcast-section-heading"><h2>매치 도미넌스 · xT</h2><p>3분 bin의 도미넌스 절대값을 팀별로 합산합니다. 양수는 홈, 음수는 어웨이 xT로 배분합니다.</p></div>
        <div className="broadcast-demo-xt-guide">
          <div><strong>전반 종료</strong><span>{halftimeXt.bins}개 bin · 총 xT {halftimeXt.total.toFixed(1)} / {halftimeXt.bins}</span><b>{HOME_TEAM} {halftimeXt.home.toFixed(1)} ({halftimeXt.homeShare.toFixed(0)}%)</b><b>{AWAY_TEAM} {halftimeXt.away.toFixed(1)} ({halftimeXt.awayShare.toFixed(0)}%)</b></div>
          <div><strong>경기 종료</strong><span>{fulltimeXt.bins}개 bin · 총 xT {fulltimeXt.total.toFixed(1)} / {fulltimeXt.bins}</span><b>{HOME_TEAM} {fulltimeXt.home.toFixed(1)} ({fulltimeXt.homeShare.toFixed(0)}%)</b><b>{AWAY_TEAM} {fulltimeXt.away.toFixed(1)} ({fulltimeXt.awayShare.toFixed(0)}%)</b></div>
        </div>
        <div className="broadcast-demo-dominance-grid">
          <DemoGraphicCard title="전반 종료 · 매치 도미넌스" graphic="MATCH_DOMINANCE" snapshot={halftime} scale={.3} meta={`45:00 고정 · xT ${halftimeXt.home.toFixed(1)} : ${halftimeXt.away.toFixed(1)}`} />
          <DemoGraphicCard title="경기 종료 · 매치 도미넌스" graphic="MATCH_DOMINANCE" snapshot={fulltime} scale={.3} meta={`90:00 고정 · xT ${fulltimeXt.home.toFixed(1)} : ${fulltimeXt.away.toFixed(1)}`} />
        </div>
      </section>
    </main>
  );
}
