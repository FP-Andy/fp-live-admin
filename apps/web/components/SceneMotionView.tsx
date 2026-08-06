'use client';

/**
 * FINEPLAY · 씬모션 네이티브 뷰 (콘솔)
 *
 * 앱이 sceneData 로 네이티브 렌더하는 그 화면을 콘솔에서도 그대로 그린다.
 * 정본은 디자이너 핸드오프(`씬모션ui_handoff/lib/scene_view.dart` + HANDOFF.md)이고,
 * 앱(xfp_scene_view.dart)도 같은 문서에서 이식됐다. 여기서 규칙을 바꾸면 앱과 갈라지므로
 * 좌표 변환·크기·색은 핸드오프 숫자를 그대로 쓴다.
 *
 * mp4(scene_motion.py)는 폴백 겸 검수용으로 계속 나가는데, 콘솔이 mp4 만 보여주면
 * 앱 화면과 다른 걸 검수하게 된다. 그래서 이 뷰가 기본이고 mp4 는 토글로 남긴다.
 *
 * 애니메이션 타이밍·이징은 mp4 렌더러와 맞춘다(scene_motion.py:38 FPS 이하).
 */

import { useEffect, useRef, useState } from 'react';

// ── 좌표계 ────────────────────────────────────────────────────
// x 0~100(좌→우) · y 0~68(하→상) · (0,0)=경기장 좌하단(흰 라인 기준).
// 원점은 이미지 가장자리가 아니라 흰 라인이라 inset 을 뺀다(피치 원본 2562×1659 기준).
const INSET_L = 14 / 2562;
const INSET_R = 12 / 2562;
const INSET_T = 42 / 1659;
const INSET_B = 41 / 1659;
export const PITCH_ASPECT = 2562 / 1659; // 1.5443

// ── @1x 표시 크기 (핸드오프 SceneSpec) ────────────────────────
// 핸드오프 예시가 W=320 기준이라, 다른 폭에서도 같은 비율로 보이도록 width/320 로 스케일한다.
// (Dart 원본은 고정 px 라 폭이 커지면 마커가 상대적으로 작아진다 — 콘솔은 카드 폭이 제각각이라 스케일이 맞다.)
const REF_WIDTH = 320;
const SIZE_HOME = 24;
const SIZE_AWAY = 20;
const SIZE_BALL = 14;
const ARROW_LEN = 40; // 핸드오프는 20 이나 앱 실기기 검증에서 40 으로 굳었다
const ARROW_RATIO = 32 / 59; // viewBox 59×32(글로우 포함)
const NUMBER_SIZE = 7.5; // Giants Bold, 검정, 헥사곤 중앙
const PASS_SUCCESS = '#04FF04';
const PASS_FAIL = '#FF0C04';

// ── 애니메이션 (scene_motion.py 와 동일) ──────────────────────
const HOLD_BEFORE = 0.4;
const MOVE = 3.0;
const HOLD_AFTER = 0.8;
// 슛 장면 전용 — 피치 모션이 끝나고 공이 골라인에 닿은 뒤에 골대가 들어온다.
// 패널이 처음부터 떠 있으면 어디서 공이 오는지 안 보여서, 등장을 뒤로 미뤘다.
const PANEL_IN = 0.5; // 반대편 하프에서 스윽 밀려 들어오는 시간
const SHOT = 1.0; // 골대 안으로 아크 궤적이 그려지는 시간
/** 콘솔 replay 의 cubic-bezier(0.22,0.84,0.28,1) 근사 — 강한 ease-out. */
const ease = (t: number) => 1 - (1 - t) ** 3;

// ── sceneData 형태 (apps/api/app/scene_motion.py: build_scene_data) ──
export type ScenePlayer = {
  team: 'home' | 'away';
  x: number; y: number;
  toX?: number; toY?: number;
  number?: string | number;
  gk?: boolean;
};
export type ScenePass = { kind?: 'pass' | 'defense'; x1: number; y1: number; x2: number; y2: number };
export type SceneMove = { type: 'dribble' | 'penetrate'; x: number; y: number; deg: number };
export type SceneShot = { gx: number; gy: number; dir?: 'left' | 'right'; start?: 'left' | 'center' | 'right' };
export type SceneData = {
  v?: number;
  ours?: 'home' | 'away';
  players?: ScenePlayer[];
  passes?: ScenePass[];
  moves?: SceneMove[];
  ball?: { path?: { x: number; y: number }[] };
  shot?: SceneShot;
  caption?: string;
};

/** 경기장 좌표 → 피치 로컬 px (도형 '중심' 기준). 해상도 독립. */
function toLocal(x: number, y: number, w: number, h: number) {
  const left = w * INSET_L;
  const right = w * (1 - INSET_R);
  const top = h * INSET_T;
  const bottom = h * (1 - INSET_B);
  return { px: left + (x / 100) * (right - left), py: bottom - (y / 68) * (bottom - top) };
}

/** 공 경로를 진행률 0~1 로 따라간 지점 — 구간 길이에 비례해 시간 배분. */
function pointOnPath(path: { x: number; y: number }[], t: number) {
  if (path.length === 0) return null;
  if (path.length === 1) return path[0];
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    segs.push(d);
    total += d;
  }
  if (total <= 0) return path[0];
  let want = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < segs.length; i += 1) {
    if (want <= segs[i] || i === segs.length - 1) {
      const u = segs[i] > 0 ? want / segs[i] : 1;
      return {
        x: path[i].x + (path[i + 1].x - path[i].x) * u,
        y: path[i].y + (path[i + 1].y - path[i].y) * u,
      };
    }
    want -= segs[i];
  }
  return path[path.length - 1];
}

type Props = {
  data: SceneData;
  /** 피치 표시 폭(px). 높이는 비율로 정해진다. */
  width: number;
  /** false 면 after 상태로 정지(썸네일 용도). */
  animate?: boolean;
};

export default function SceneMotionView({ data, width, animate = true }: Props) {
  const height = width / PITCH_ASPECT;
  const k = width / REF_WIDTH; // 마커 스케일
  const hasShot = Boolean(data.shot);
  // 슛이면 피치 모션 → 골대 등장 → 아크 순으로 이어 붙인다.
  const cycle = HOLD_BEFORE + MOVE + (hasShot ? PANEL_IN + SHOT : 0) + HOLD_AFTER;

  // 한 덩어리로 들고 있다가 값이 실제로 바뀔 때만 리렌더한다.
  // 사이클의 1.2초가 정지 구간이라, 프레임마다 setState 하면 그동안 헛돈다
  // (클립 하나에 장면 카드가 여러 개 붙는 화면이다).
  type Anim = { phase: number; panelIn: number; shotT: number; armed: boolean };
  const [anim, setAnim] = useState<Anim>(
    animate ? { phase: 0, panelIn: hasShot ? 0 : 1, shotT: 0, armed: false }
            : { phase: 1, panelIn: 1, shotT: 1, armed: true },
  );
  const last = useRef<Anim | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (!animate) { setAnim({ phase: 1, panelIn: 1, shotT: 1, armed: true }); return; }
    const start = performance.now();
    const tick = (now: number) => {
      const t = ((now - start) / 1000) % cycle;
      let next: Anim;
      if (t < HOLD_BEFORE) {
        next = { phase: 0, panelIn: hasShot ? 0 : 1, shotT: 0, armed: t >= HOLD_BEFORE * 0.5 };
      } else if (t < HOLD_BEFORE + MOVE) {
        next = { phase: ease((t - HOLD_BEFORE) / MOVE), panelIn: hasShot ? 0 : 1, shotT: 0, armed: true };
      } else if (hasShot && t < HOLD_BEFORE + MOVE + PANEL_IN) {
        // 공이 골라인에 닿은 순간 — 골대가 반대편 하프에서 밀려 들어온다.
        next = { phase: 1, panelIn: ease((t - HOLD_BEFORE - MOVE) / PANEL_IN), shotT: 0, armed: true };
      } else if (hasShot && t < HOLD_BEFORE + MOVE + PANEL_IN + SHOT) {
        next = { phase: 1, panelIn: 1, shotT: ease((t - HOLD_BEFORE - MOVE - PANEL_IN) / SHOT), armed: true };
      } else {
        next = { phase: 1, panelIn: 1, shotT: 1, armed: true };
      }
      const p = last.current;
      const moved = !p
        || p.armed !== next.armed
        || Math.abs(p.phase - next.phase) > 0.002
        || Math.abs(p.panelIn - next.panelIn) > 0.002
        || Math.abs(p.shotT - next.shotT) > 0.002;
      if (moved) { last.current = next; setAnim(next); }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current !== null) cancelAnimationFrame(raf.current); };
  }, [animate, data, cycle, hasShot]);

  const { phase, panelIn, shotT, armed } = anim;

  const players = data.players || [];
  const passes = data.passes || [];
  const moves = data.moves || [];
  const ballPath = data.ball?.path || [];
  // 헥사곤+등번호 = 이 장면을 태깅할 때 선택한 팀. 홈 고정이 아니다.
  const ours = data.ours || 'home';

  const ballPt = pointOnPath(ballPath, phase);
  const ball = ballPt ? toLocal(ballPt.x, ballPt.y, width, height) : null;

  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      {/* 1) 피치 */}
      <img
        src="/scene/pitch.png" alt=""
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />

      {/* 2) 패스선 (마커 아래) — 이동과 함께 그려진다 */}
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        {passes.map((p, i) => {
          const a = toLocal(p.x1, p.y1, width, height);
          const b = toLocal(p.x2, p.y2, width, height);
          // 진행률만큼 뻗어나가게 — 핸드오프 주석의 'draw 효과'.
          const ex = a.px + (b.px - a.px) * phase;
          const ey = a.py + (b.py - a.py) * phase;
          const color = p.kind === 'defense' ? PASS_FAIL : PASS_SUCCESS;
          const ang = Math.atan2(ey - a.py, ex - a.px);
          const len = 5 * k;
          const spread = 0.5;
          const head = phase > 0.02
            ? `${ex},${ey} ${ex - len * Math.cos(ang - spread)},${ey - len * Math.sin(ang - spread)} ${ex - len * Math.cos(ang + spread)},${ey - len * Math.sin(ang + spread)}`
            : '';
          return (
            <g key={`p${i}`}>
              <line x1={a.px} y1={a.py} x2={ex} y2={ey} stroke={color} strokeWidth={2 * k} strokeLinecap="round" />
              {head ? <polygon points={head} fill={color} /> : null}
            </g>
          );
        })}
      </svg>

      {/* 3) 이동 셰브론 — 방향으로 회전, 이동보다 먼저 등장 */}
      {moves.map((m, i) => {
        const c = toLocal(m.x, m.y, width, height);
        const w = ARROW_LEN * k;
        const h = w * ARROW_RATIO;
        return (
          <img
            key={`m${i}`}
            src={m.type === 'dribble' ? '/scene/arrow_move_dribble.svg' : '/scene/arrow_move_penetrate.svg'}
            alt=""
            style={{
              position: 'absolute', left: c.px - w / 2, top: c.py - h / 2, width: w, height: h,
              transform: `rotate(${m.deg}deg)`, opacity: armed ? 0.9 : 0,
              transition: 'opacity 200ms linear', pointerEvents: 'none',
            }}
          />
        );
      })}

      {/* 4) 선수 마커 — 상대(원) 먼저, 우리(헥사곤)를 그 위에 */}
      {[...players]
        .map((p, i) => ({ p, i }))
        .sort((a, b) => Number(a.p.team === ours) - Number(b.p.team === ours))
        .map(({ p, i }) => {
          const x = p.x + ((p.toX ?? p.x) - p.x) * phase;
          const y = p.y + ((p.toY ?? p.y) - p.y) * phase;
          const c = toLocal(x, y, width, height);
          const isOurs = p.team === ours;
          const s = (isOurs ? SIZE_HOME : SIZE_AWAY) * k;
          return (
            <div
              key={`pl${i}`}
              style={{ position: 'absolute', left: c.px - s / 2, top: c.py - s / 2, width: s, height: s }}
            >
              <img
                src={isOurs ? '/scene/player_home_hexagon.svg' : '/scene/player_away_circle.svg'}
                alt="" style={{ width: '100%', height: '100%', display: 'block' }}
              />
              {isOurs && p.number != null && p.number !== '' ? (
                // 넘버 = 헥사곤 중심 = 좌표점(셋이 한 점). 항상 최상단.
                <span style={{
                  position: 'absolute', inset: 0, display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'Giants, sans-serif', fontWeight: 700,
                  fontSize: NUMBER_SIZE * k, lineHeight: 1, color: '#000',
                }}>{p.number}</span>
              ) : null}
            </div>
          );
        })}

      {/* 5) 볼 (최상단) */}
      {ball ? (
        <img
          src="/scene/ball.svg" alt=""
          style={{
            position: 'absolute', left: ball.px - (SIZE_BALL * k) / 2, top: ball.py - (SIZE_BALL * k) / 2,
            width: SIZE_BALL * k, height: SIZE_BALL * k,
          }}
        />
      ) : null}

      {/* 6) 슛이면 공격 반대편 하프를 대형 정면 골대 패널로 덮는다 (피치 모션 뒤에 등장) */}
      {data.shot ? (
        <GoalPanel shot={data.shot} width={width} height={height} panelIn={panelIn} shotT={shotT} />
      ) : null}

      {/* 7) 자막 */}
      {data.caption ? (
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 8 * k, textAlign: 'center',
          fontSize: 15 * k, fontWeight: 800, color: '#fff',
          textShadow: '0 2px 6px rgba(0,0,0,.85)', pointerEvents: 'none',
        }}>{data.caption}</div>
      ) : null}
    </div>
  );
}

/**
 * 정면 골대 패널 — scene_motion.py `_draw_goal_panel` 을 비율 그대로 옮겼다.
 * 패널은 공격 **반대편**(비어 있는) 하프를 덮고, 슛 궤적은 아크로 그린다.
 */
function GoalPanel({
  shot, width, height, panelIn, shotT,
}: { shot: SceneShot; width: number; height: number; panelIn: number; shotT: number }) {
  const margin = (14 / 1050) * width;
  // shot.dir = 공격해 들어가는 골대 쪽. 패널은 그 **반대편**(비어 있는) 하프를 덮는다
  // (scene_motion.py:565 — shot_target.x==0 이면 dir='left' 이고 panel_side='right').
  const side = shot.dir === 'left' ? 'right' : 'left';
  const x0 = side === 'left' ? margin : width / 2 + (8 / 1050) * width;
  const x1 = side === 'left' ? width / 2 - (8 / 1050) * width : width - margin;
  const y0 = margin;
  const y1 = height - margin;

  const pw = x1 - x0;
  const goalW = pw * 0.8;
  const goalH = goalW / 3.0; // 7.32:2.44 실제 비율
  const floorY = y0 + (y1 - y0) * 0.5;
  const gx0 = x0 + (pw - goalW) / 2;
  const gx1 = gx0 + goalW;
  const gy0 = floorY - goalH;
  const cx = (gx0 + gx1) / 2;
  const ghw = goalW / 2;
  const u = width / 1050; // 선 굵기 스케일

  // 도착점(골대 클릭 좌표) — 범위 밖(빗나감)도 패널 안에서 골대 밖으로 표현된다.
  const endX = gx0 + Math.min(Math.max(shot.gx, -0.35), 1.35) * goalW;
  const endY = floorY - Math.min(Math.max(shot.gy, 0), 1.6) * goalH;
  // 출발점 가로 = 슈터 방향만 3단계 (정확 좌표는 패널 밖으로 나갈 수 있다)
  const startX = shot.start === 'left' ? x0 + pw * 0.22 : shot.start === 'right' ? x0 + pw * 0.78 : x0 + pw * 0.5;
  const startY = y1 - 22 * u;
  const ctrlX = (startX + endX) / 2;
  const ctrlY = Math.min(startY, endY) - Math.max(28 * u, Math.abs(startX - endX) * 0.1);

  // 아크 위 공 위치 (2차 베지어)
  const bez = (u: number) => {
    const v = 1 - u;
    return {
      x: v * v * startX + 2 * v * u * ctrlX + u * u * endX,
      y: v * v * startY + 2 * v * u * ctrlY + u * u * endY,
    };
  };
  const ball = bez(shotT);
  // 궤적도 공을 따라 그려진다 — 미리 다 그려두면 결과가 먼저 보인다.
  const arc = Array.from({ length: 25 }, (_, i) => bez((i / 24) * shotT))
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
    .join(' ');

  // 패널은 자기 하프 바깥에서 스윽 밀려 들어온다.
  const slide = (1 - panelIn) * (pw + margin) * (side === 'left' ? -1 : 1);

  // 골대 안 공 — 피치의 공과 같은 크기(사용자 지정). 확대해서 키우지 않는다.
  const ballSize = SIZE_BALL * (width / REF_WIDTH);

  const box = '#6e7a74';
  return (
    <svg
      width={width} height={height}
      style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        transform: `translateX(${slide}px)`, opacity: panelIn,
      }}
    >
      <rect x={x0} y={y0} width={pw} height={y1 - y0} rx={14 * u} fill="#0a0e0c" stroke="#606c66" strokeWidth={2 * u} />
      {/* 바닥선 */}
      <line x1={x0 + 16 * u} y1={floorY} x2={x1 - 16 * u} y2={floorY} stroke="#969ca0" strokeWidth={3 * u} />
      {/* 약식 페널티 박스 — 정면 원근에서 보이는 부분만 */}
      <line x1={cx - ghw * 1.12} y1={floorY} x2={cx - Math.min(ghw * 1.24, pw / 2 - 14 * u)} y2={floorY + goalH * 0.5} stroke={box} strokeWidth={2 * u} />
      <line x1={cx + ghw * 1.12} y1={floorY} x2={cx + Math.min(ghw * 1.24, pw / 2 - 14 * u)} y2={floorY + goalH * 0.5} stroke={box} strokeWidth={2 * u} />
      <line x1={cx - Math.min(ghw * 1.24, pw / 2 - 14 * u)} y1={floorY + goalH * 0.5} x2={cx + Math.min(ghw * 1.24, pw / 2 - 14 * u)} y2={floorY + goalH * 0.5} stroke={box} strokeWidth={2 * u} />
      <line x1={x0 + 14 * u} y1={floorY + goalH * 1.35} x2={x1 - 14 * u} y2={floorY + goalH * 1.35} stroke={box} strokeWidth={2 * u} />
      <circle cx={cx} cy={floorY + goalH} r={4 * u} fill={box} />
      {/* 네트 */}
      {[1, 2, 3, 4, 5, 6, 7].map((i) => (
        <line key={`nv${i}`} x1={gx0 + (goalW * i) / 8} y1={gy0} x2={gx0 + (goalW * i) / 8} y2={floorY} stroke="#343c38" strokeWidth={2 * u} />
      ))}
      {[1, 2, 3].map((i) => (
        <line key={`nh${i}`} x1={gx0} y1={gy0 + (goalH * i) / 4} x2={gx1} y2={gy0 + (goalH * i) / 4} stroke="#343c38" strokeWidth={2 * u} />
      ))}
      {/* 골대 프레임 */}
      <line x1={gx0} y1={floorY} x2={gx0} y2={gy0} stroke="#f0f5f2" strokeWidth={6 * u} />
      <line x1={gx1} y1={floorY} x2={gx1} y2={gy0} stroke="#f0f5f2" strokeWidth={6 * u} />
      <line x1={gx0 - 3 * u} y1={gy0} x2={gx1 + 3 * u} y2={gy0} stroke="#f0f5f2" strokeWidth={6 * u} />
      {/* 궤적 + 공 — 공이 지나간 만큼만 그린다 */}
      {shotT > 0.01 ? (
        <path d={arc} fill="none" stroke="#ffb56d" strokeWidth={2 * u} strokeDasharray={`${5 * u} ${5 * u}`} opacity={0.7} />
      ) : null}
      {/* 골대 안 공은 피치와 같은 ball.svg · 같은 크기 */}
      <image
        href="/scene/ball.svg"
        x={ball.x - ballSize / 2} y={ball.y - ballSize / 2}
        width={ballSize} height={ballSize}
      />
    </svg>
  );
}
