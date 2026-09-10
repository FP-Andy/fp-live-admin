'use client';

/** 하이라이트에 새기는 오버레이 — 점수판과 우리 로고.
 *
 * 수동 태깅과 FinePlay 작업이 **같은 그림을 같은 자리에** 그려야 한다. 두 벌로 두면
 * 언젠가 어긋나므로 여기 한 곳에 모으고 양쪽 화면이 가져다 쓴다.
 *
 * 좌표 계산은 서버(app/scoreboard.py 의 board_placement, app/watermark.py 의
 * mark_placement)와 같은 식이다 — 그래야 화면에서 본 자리가 결과물의 자리가 된다.
 */


import React, { useRef } from 'react';

const numInput: React.CSSProperties = {
  background: 'var(--surface-input, #16161a)',
  border: '1px solid var(--border-ghost, #3a3a42)',
  borderRadius: 6,
  color: 'var(--text, #eee)',
  padding: '4px 8px',
  fontSize: 12,
};

/** 하이라이트 위에 새길 점수판 설정. 합칠 때 서버로 한 번 보낸다. */
export type Scoreboard = {
  enabled: boolean;
  homeName: string;
  awayName: string;
  homeColor: string;
  awayColor: string;
  startHome: number;
  startAway: number;
  sizePct: number;
  /** 여백을 뺀 놓을 수 있는 범위 안에서의 비율(0~100). (0,0) 왼쪽 위 · (100,100) 오른쪽 아래. */
  posX: number;
  posY: number;
  /** 대회 로고(dataURL). 비어 있으면 로고 없이 판만 그린다. */
  logoUrl: string;
};

export const DEFAULT_SCOREBOARD: Scoreboard = {
  enabled: false,
  homeName: '',
  awayName: '',
  homeColor: '#FF7400',
  awayColor: '#0000FF',
  startHome: 0,
  startAway: 0,
  sizePct: 24.33,
  // 좌상단에서 살짝 안쪽 — 실제로 쓰는 자리(2026-09-09).
  //
  // 이 값은 '여백을 뺀 놓을 수 있는 범위' 안에서의 비율이라 숫자가 눈에 안 들어온다.
  // 1920x1080 · 크기 24.33% 에서 화면 좌표 **(70, 80)px** 이 되는 값이다
  // (판 467x95 · 여백 40 · 여유 1373x905 → (70−40)/1373, (80−40)/905).
  //
  // ⚠️ 저장이 비율이라 **영상 규격이 다르면 px 자리가 달라진다.** SUFA 원본은 전부
  // 1920x1080 이라 실질적인 문제는 없지만, 파노라마(3840x800) 같은 걸 넣으면 밀린다.
  posX: 2.18,
  posY: 4.42,
  logoUrl: '',
};

/** 위치 프리셋 3x3. 값은 posX/posY 비율이다. */
export const POS_PRESETS: { x: number; y: number; label: string }[] = [
  { x: 0, y: 0, label: '왼쪽 위' }, { x: 50, y: 0, label: '가운데 위' }, { x: 100, y: 0, label: '오른쪽 위' },
  { x: 0, y: 50, label: '왼쪽 중간' }, { x: 50, y: 50, label: '정중앙' }, { x: 100, y: 50, label: '오른쪽 중간' },
  { x: 0, y: 100, label: '왼쪽 아래' }, { x: 50, y: 100, label: '가운데 아래' }, { x: 100, y: 100, label: '오른쪽 아래' },
];

// 점수판 판때기 비율(디자인 828.46 x 157.76). 서버 렌더러와 같은 값이어야 한다.
// 서버 렌더(scoreboard.py)와 같은 값이어야 미리보기가 결과물과 일치한다.
// Figma 가 준 928.75x182 는 기울어진 도형의 **바운딩**이라, 실제 화면 비율은
// 시안 스크린샷 실측값(257px : 52px)을 쓴다.
export const BOARD_ASPECT = 4.94;
export const SKEW = Math.tan((12 * Math.PI) / 180);   // 12°
export const BAR_W_RATIO = 0.0623;                    // 컬러바 수평 두께 비율(실측)

/** 점수판 크기·자리 계산 — 서버(app/scoreboard.py 의 board_placement)와 같아야 한다.
 *  좌표는 전부 '영상 픽셀' 기준이고, 미리보기는 이 값을 비율로 줄여 그린다. */
export function boardPlacement(
  videoW: number, videoH: number, sizePct: number, posX: number, posY: number,
  withLogo = false,
) {
  const pct = Math.max(10, Math.min(60, sizePct)) / 100;
  const w = Math.max(160, Math.round(Math.min(videoW * pct, videoH * 0.18 * BOARD_ASPECT)));
  const plateH = Math.max(30, Math.round(w / BOARD_ASPECT));
  // 로고는 판 위로 튀어나오므로 차지하는 높이가 더 크다(서버 board_placement 와 동일).
  const h = plateH + (withLogo ? Math.round(plateH * (61.01 / 182)) : 0);
  const margin = Math.max(16, Math.round(videoW * 0.021));
  const freeX = Math.max(0, videoW - w - 2 * margin);
  const freeY = Math.max(0, videoH - h - 2 * margin);
  const clamp = (v: number) => Math.max(0, Math.min(100, v)) / 100;
  return {
    w, h, plateH, margin,
    x: margin + Math.round(freeX * clamp(posX)),
    y: margin + Math.round(freeY * clamp(posY)),
    freeX, freeY,
  };
}

/** 결과물에 새겨질 점수판 미리보기. 서버 렌더러(app/scoreboard.py)와 같은 디자인·비율이다. */
/** 점수판 미리보기 — 서버 렌더(scoreboard.py)와 같은 기하로 그린다.
 *
 * 판·컬러바는 12° 기울어진 평행사변형이다. clip-path 로 잘라 만든다 — skew 변환을
 * 쓰면 안쪽 글자까지 같이 기울어진다. 로고는 판 위쪽 가운데에 절반 걸친다.
 * 시간 표시는 없다(디자인에서 뺐다).
 */
export function ScoreboardPreview(
  { config, home, away, width = 420 }:
  { config: Scoreboard; home: number; away: number; width?: number },
) {
  const W = width;
  const H = Math.round(W / BOARD_ASPECT);
  const off = H * SKEW;                       // 기울기로 밀리는 가로량
  const rise = config.logoUrl ? H * (61.01 / 182) : 0;
  const barW = W * BAR_W_RATIO;
  // 위쪽 변이 오른쪽으로 off 만큼 밀린 평행사변형.
  const slant = (x0: number, w: number) =>
    `polygon(${x0 + off}px 0, ${x0 + off + w}px 0, ${x0 + w}px 100%, ${x0}px 100%)`;
  const nameStyle: React.CSSProperties = {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)',
    fontSize: `${H * 0.38}px`, fontWeight: 800, whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: `${W * 0.26}px`,
    fontFamily: 'Paperlogy, sans-serif',
  };
  const scoreStyle: React.CSSProperties = {
    position: 'absolute', top: '50%', transform: 'translate(-50%, -50%)',
    fontSize: `${H * 0.38}px`, fontWeight: 800, fontFamily: 'Paperlogy, sans-serif',
  };
  return (
    <div style={{ position: 'relative', width: W, height: H + rise, color: '#fff' }}>
      {/* 판 */}
      <div
        style={{
          position: 'absolute', left: 0, top: rise, width: W, height: H,
          background: 'linear-gradient(90deg, #1B2B3F 0%, rgba(27, 43, 63, 0.7) 100%)',
          clipPath: slant(0, W - off),
        }}
      />
      {/* 컬러바 — 판과 같은 기울기 */}
      <div
        style={{
          position: 'absolute', left: 0, top: rise, width: W, height: H,
          background: config.homeColor, clipPath: slant(0, barW),
        }}
      />
      <div
        style={{
          position: 'absolute', left: 0, top: rise, width: W, height: H,
          background: config.awayColor, clipPath: slant(W - off - barW, barW),
        }}
      />
      {/* 팀명 — 컬러바 안쪽으로 */}
      <div style={{ position: 'absolute', left: 0, top: rise, width: W, height: H }}>
        <span style={{ ...nameStyle, left: `${barW + off * 0.5 + W * 0.026}px` }}>
          {config.homeName || 'HOME'}
        </span>
        <span
          style={{
            ...nameStyle,
            right: `${barW + off * 0.5 + W * 0.026}px`, textAlign: 'right',
          }}
        >
          {config.awayName || 'AWAY'}
        </span>
        {/* 점수 — 원본 기준 가로 39.8% / 56.0% 자리 */}
        <span style={{ ...scoreStyle, left: `${W * 0.398}px` }}>{home}</span>
        <span style={{ ...scoreStyle, left: `${W * 0.560}px` }}>{away}</span>
      </div>
      {/* 대회 로고 — 판 위쪽 가운데, 절반 걸침. 없으면 안 그린다 */}
      {config.logoUrl ? (
        <img
          src={config.logoUrl}
          alt=""
          style={{
            position: 'absolute', top: 0, left: `${W * 0.478}px`,
            width: `${H * (122.02 / 182)}px`, height: `${H * (122.02 / 182)}px`,
            transform: 'translateX(-50%)', objectFit: 'contain',
          }}
        />
      ) : null}
    </div>
  );
}

/** 우리 로고(브랜드 마크) 설정 — 영상 내내 같은 자리에 얹히는 한 장. */
export type Watermark = {
  enabled: boolean;
  sizePct: number;
  opacity: number;
  posX: number;
  posY: number;
};

// 로고 원본 비율(세로/가로). assets/brand/fineplay-mark.png 과 같은 값이라야
// 미리보기와 결과물이 같은 크기로 나온다.
export const MARK_RATIO = 1024 / 974;
export const MARK_SRC = '/brand/fineplay-mark.png';

export const DEFAULT_WATERMARK: Watermark = {
  enabled: true,
  // 중계 화면의 방송사 로고가 보통 이 정도다 — 경기를 가리지 않으면서 눈에는 들어오는 선.
  sizePct: 5,
  opacity: 0.55,
  posX: 100,   // 우상단
  posY: 0,
};

/** 로고 크기·자리. 서버(watermark.mark_placement)와 같은 식이라 여기 보이는 자리가 결과물의 자리다. */
export function markPlacement(videoW: number, videoH: number, sizePct: number, posX: number, posY: number) {
  const pct = Math.max(1, Math.min(25, sizePct)) / 100;
  let raw = videoW * pct;
  // 파노라마(3840x800)처럼 납작한 원본에서 세로를 다 먹지 않게 한 번 더 묶는다.
  if (raw * MARK_RATIO > videoH * 0.2) raw = (videoH * 0.2) / MARK_RATIO;
  const w = Math.max(24, Math.round(raw));
  const h = Math.max(24, Math.round(w * MARK_RATIO));
  const margin = Math.max(16, Math.round(videoW * 0.021));
  const freeX = Math.max(0, videoW - w - 2 * margin);
  const freeY = Math.max(0, videoH - h - 2 * margin);
  const clamp = (v: number) => Math.max(0, Math.min(100, v)) / 100;
  return {
    w, h, margin, freeX, freeY,
    x: margin + Math.round(freeX * clamp(posX)),
    y: margin + Math.round(freeY * clamp(posY)),
  };
}

/** 배치기가 다루는 오버레이 한 장. 점수판이든 로고든 이 모양이면 똑같이 끌 수 있다. */
export type PlacedItem = {
  key: 'board' | 'mark';
  label: string;
  /** 지금 크기·자리 */
  place: { w: number; h: number; x: number; y: number; margin: number; freeX: number; freeY: number };
  /** 크기를 바꿔 봤을 때의 자리(고정 모서리 계산용) */
  recompute: (sizePct: number) => { w: number; h: number; margin: number; freeX: number; freeY: number };
  sizePct: number;
  sizeRange: [number, number];
  onMove: (posX: number, posY: number) => void;
  onResize: (sizePct: number, posX: number, posY: number) => void;
  render: (width: number) => React.ReactNode;
};

/** 영상 화면 비율 박스 위에서 오버레이들을 끌어 옮긴다.
 *
 *  좌표 계산은 서버(board_placement / mark_placement)와 같은 식이라, 여기서 보이는 자리가
 *  결과물의 자리다. 여러 장을 얹으므로 '고른 것' 만 끌리고 크기 핸들이 붙는다 —
 *  전부 동시에 잡히면 서로 겹칠 때 원하는 걸 집을 수 없다. */
export function OverlayPlacer({
  items, videoW, videoH, frameUrl, selected, onSelect,
}: {
  items: PlacedItem[];
  videoW: number;
  videoH: number;
  frameUrl: string;
  selected: 'board' | 'mark';
  onSelect: (key: 'board' | 'mark') => void;
}) {
  const PREVIEW_W = 440;
  const scale = PREVIEW_W / Math.max(1, videoW);
  const previewH = Math.max(80, Math.round(videoH * scale));

  const boxRef = useRef<HTMLDivElement | null>(null);
  // 집은 지점(왼쪽 위에서의 거리). 집은 곳이 아니라 모서리를 기준으로 옮겨야 커서에서 튀지 않는다.
  const grabRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeRef = useRef<{ ax: number; ay: number; corner: string } | null>(null);

  const frac = (v: number) => Math.round(Math.max(0, Math.min(100, v)) * 100) / 100;
  const active = items.find((i) => i.key === selected) || items[0];

  const moveTo = (clientX: number, clientY: number, item: PlacedItem) => {
    const box = boxRef.current;
    const grab = grabRef.current;
    if (!box || !grab) return;
    const rect = box.getBoundingClientRect();
    // 화면 좌표 → 영상 픽셀 좌표 → 여백을 뺀 범위 안에서의 비율
    const x = (clientX - rect.left - grab.dx) / scale - item.place.margin;
    const y = (clientY - rect.top - grab.dy) / scale - item.place.margin;
    // 자동 흡착은 뺐다 — 흡착 범위가 1920px 영상에서 65px 라 그 안에서 미세 조정이 안 됐다.
    // 소수 둘째 자리까지 남긴다. 정수 %로 반올림하면 한 칸이 13px 이라 뚝뚝 끊긴다.
    item.onMove(
      frac(item.place.freeX > 0 ? (x / item.place.freeX) * 100 : 0),
      frac(item.place.freeY > 0 ? (y / item.place.freeY) * 100 : 0),
    );
  };

  /** 최종 영상 기준 픽셀 좌표로 직접 옮긴다 — 드래그만으로는 정확한 값을 못 맞춘다. */
  const setPx = (item: PlacedItem, nextX: number, nextY: number) => {
    const cx = Math.max(item.place.margin, Math.min(item.place.margin + item.place.freeX, nextX));
    const cy = Math.max(item.place.margin, Math.min(item.place.margin + item.place.freeY, nextY));
    item.onMove(
      frac(item.place.freeX > 0 ? ((cx - item.place.margin) / item.place.freeX) * 100 : 0),
      frac(item.place.freeY > 0 ? ((cy - item.place.margin) / item.place.freeY) * 100 : 0),
    );
  };

  // 네 모서리 핸들을 끌어 크기를 바꾼다. 잡은 반대편 모서리가 고정돼 선택 상자를 다루는
  // 감각 그대로다. 비율이 고정이라 가로 이동량만 본다.
  const applyResize = (pointerX: number, item: PlacedItem) => {
    const box = boxRef.current;
    const grab = resizeRef.current;
    if (!box || !grab) return;
    const rect = box.getBoundingClientRect();
    const vx = (pointerX - rect.left) / scale;
    const wantW = Math.abs(vx - grab.ax);
    const [lo, hi] = item.sizeRange;
    const nextPct = Math.max(lo, Math.min(hi, (wantW / Math.max(1, videoW)) * 100));
    // 새 크기로 다시 계산해야 고정 모서리가 실제로 안 움직인다(폭에 하한·상한이 걸린다).
    const next = item.recompute(nextPct);
    const originX = grab.corner.includes('w') ? grab.ax - next.w : grab.ax;
    const originY = grab.corner.includes('n') ? grab.ay - next.h : grab.ay;
    const cx = Math.max(next.margin, Math.min(next.margin + next.freeX, originX));
    const cy = Math.max(next.margin, Math.min(next.margin + next.freeY, originY));
    item.onResize(
      Math.round(nextPct * 100) / 100,
      frac(next.freeX > 0 ? ((cx - next.margin) / next.freeX) * 100 : 0),
      frac(next.freeY > 0 ? ((cy - next.margin) / next.freeY) * 100 : 0),
    );
  };

  const handleStyle = (corner: string, w: number, h: number): React.CSSProperties => {
    const size = 10;
    const half = size / 2;
    return {
      position: 'absolute',
      width: size, height: size,
      left: (corner.includes('w') ? 0 : w) - half,
      top: (corner.includes('n') ? 0 : h) - half,
      background: '#fff',
      border: '1px solid #1B2B3F',
      borderRadius: 2,
      cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
      touchAction: 'none',
    };
  };

  return (
    <div style={{ width: PREVIEW_W }}>
      <div
        ref={boxRef}
        style={{
          position: 'relative', width: PREVIEW_W, height: previewH,
          borderRadius: 8, overflow: 'hidden', userSelect: 'none',
          border: '1px solid var(--border-ghost, #3a3a42)',
          background: frameUrl ? `center/cover no-repeat url(${frameUrl})` : '#20321f',
        }}
      >
        {!frameUrl ? (
          <span style={{ position: 'absolute', left: 10, top: 8, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
            영상 화면 비율 {videoW}×{videoH}
          </span>
        ) : null}

        {items.map((item) => {
          const isActive = item.key === selected;
          const w = item.place.w * scale;
          const h = item.place.h * scale;
          return (
            <div
              key={item.key}
              role="button"
              tabIndex={0}
              title={isActive ? '끌어서 옮기세요' : `${item.label} 고르기`}
              onPointerDown={(e) => {
                if (!isActive) { onSelect(item.key); return; }
                const r = e.currentTarget.getBoundingClientRect();
                grabRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (isActive && grabRef.current) moveTo(e.clientX, e.clientY, item);
              }}
              onPointerUp={(e) => {
                grabRef.current = null;
                try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 이미 놓였음 */ }
              }}
              // 방향키는 **영상 픽셀 1px** 씩(Shift 10px). % 로 움직이면 영상 크기에 따라
              // 한 칸이 10px 을 넘어 미세 조정이 안 된다.
              onKeyDown={(e) => {
                if (!isActive) return;
                const step = e.shiftKey ? 10 : 1;
                const move = {
                  ArrowLeft: [-step, 0], ArrowRight: [step, 0],
                  ArrowUp: [0, -step], ArrowDown: [0, step],
                }[e.key];
                if (!move) return;
                e.preventDefault();
                e.stopPropagation();
                setPx(item, item.place.x + move[0], item.place.y + move[1]);
              }}
              style={{
                position: 'absolute',
                left: item.place.x * scale,
                top: item.place.y * scale,
                cursor: isActive ? 'grab' : 'pointer',
                touchAction: 'none',
                outline: isActive ? '1px dashed rgba(255,255,255,0.55)' : 'none',
                outlineOffset: 2,
              }}
            >
              {item.render(w)}
              {isActive ? (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                <div
                  key={corner}
                  style={handleStyle(corner, w, h)}
                  title="끌어서 크기 조절"
                  onPointerDown={(e) => {
                    e.stopPropagation();   // 이동으로 번지지 않게
                    resizeRef.current = {
                      ax: corner.includes('w') ? item.place.x + item.place.w : item.place.x,
                      ay: corner.includes('n') ? item.place.y + item.place.h : item.place.y,
                      corner,
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!resizeRef.current) return;
                    e.stopPropagation();
                    applyResize(e.clientX, item);
                  }}
                  onPointerUp={(e) => {
                    resizeRef.current = null;
                    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 이미 놓였음 */ }
                  }}
                />
              )) : null}
            </div>
          );
        })}
      </div>

      {/* 최종 영상 기준 좌표. 눈으로 확인하고 숫자로도 고칠 수 있게 한다. */}
      {active ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap', fontSize: 12 }}>
          <span style={{ color: 'var(--muted, #999)' }}>{active.label} 위치(px)</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            X
            <input
              type="number"
              step={1}
              value={active.place.x}
              onChange={(e) => setPx(active, Number(e.target.value), active.place.y)}
              style={{ ...numInput, width: 64 }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Y
            <input
              type="number"
              step={1}
              value={active.place.y}
              onChange={(e) => setPx(active, active.place.x, Number(e.target.value))}
              style={{ ...numInput, width: 64 }}
            />
          </label>
          <span style={{ color: 'var(--muted, #666)' }}>
            / {active.place.w}×{active.place.h} · 영상 {videoW}×{videoH}
          </span>
          <span style={{ color: 'var(--muted, #666)' }}>
            가능 범위 X {active.place.margin}~{active.place.margin + active.place.freeX}
            {' · '}Y {active.place.margin}~{active.place.margin + active.place.freeY}
          </span>
        </div>
      ) : null}
    </div>
  );
}
