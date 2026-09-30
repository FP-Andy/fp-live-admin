'use client';

/**
 * 템플릿 에디터 — 배경을 올리고 항목 자리를 정해 카드·점수판 세트를 만든다.
 *
 * 두 길이 있다:
 *   · 그냥 배경 이미지를 올리면 → 팔레트에서 항목(팀 로고·대회명·팀명…)을 추가해
 *     **배경 위에서 직접 끌어 놓는다.** 값은 어차피 쓸 때 넣으니 만들 때는 자리만 정한다.
 *   · 레이어가 살아 있는 PSD 를 올리면 → 서버가 글자·로고·팀색 후보를 읽어 주고,
 *     역할만 고르면 된다(자리·크기·자간·색을 시안에서 그대로 가져온다).
 *
 * 어느 길이든 역할을 바꾸면 **저장 전에** 초안이 다시 그려진다 — 합치기가 쓰는
 * 렌더러 그대로라 결과와 어긋나지 않는다.
 */

import { useEffect, useRef, useState } from 'react';
import { API_BASE, apiJson } from '../../../../lib/api';

type Analyzed = {
  token: string;
  kind: 'psd' | 'image';
  design: [number, number];
  texts: { layer: number; content: string; box: number[]; size: number;
           tracking: number; color: string }[];
  objects: { layer: number; name: string; box: number[]; sample_color: string }[];
  note?: string;
};

type TemplateRow = {
  id: string; name: string; custom?: boolean;
  has_board?: boolean; has_half_videos?: boolean;
};

/** 손으로 놓은 항목 하나. box 는 시안 좌표(px). */
type ManualField = {
  uid: number;
  role: string;            // round_label · home_name · … · free · home_color(영역)
  kind: 'text' | 'logo' | 'zone';
  label: string;
  box: [number, number, number, number];
  size: number;            // 글자 크기(글자만)
  color: string;           // 글자 색(글자만)
  source: string;          // 바탕에 구워진 색(영역만)
};

const TEXT_ROLES_START = [
  ['', '사용 안 함'], ['round_label', '대회·라운드'], ['home_name', '홈 팀명'],
  ['away_name', '어웨이 팀명'], ['free', '자유 글자'],
] as const;
const TEXT_ROLES_BOARD = [
  ['', '사용 안 함'], ['round_label', '대회·라운드'], ['home_name', '홈 팀명'],
  ['away_name', '어웨이 팀명'], ['home_score', '홈 점수'], ['away_score', '어웨이 점수'],
  ['free', '자유 글자'],
] as const;
const OBJ_ROLES_START = [
  ['keep', '배경에 남김'], ['home_logo', '홈 로고 자리'], ['away_logo', '어웨이 로고 자리'],
  ['hide', '지움(팀 로고류)'],
] as const;
const OBJ_ROLES_BOARD = [
  ['keep', '배경에 남김'], ['home_color', '홈 팀 색'], ['away_color', '어웨이 팀 색'],
  ['hide', '지움'],
] as const;

/** 팔레트 — 손으로 추가할 수 있는 항목. once=true 는 하나만. */
const PALETTE_START = [
  { role: 'round_label', label: '대회·라운드', kind: 'text', once: true },
  { role: 'home_name', label: '홈 팀명', kind: 'text', once: true },
  { role: 'away_name', label: '어웨이 팀명', kind: 'text', once: true },
  { role: 'home_logo', label: '홈 로고', kind: 'logo', once: true },
  { role: 'away_logo', label: '어웨이 로고', kind: 'logo', once: true },
  { role: 'free', label: '자유 글자', kind: 'text', once: false },
] as const;
const PALETTE_BOARD = [
  { role: 'round_label', label: '대회·라운드', kind: 'text', once: true },
  { role: 'home_name', label: '홈 팀명', kind: 'text', once: true },
  { role: 'away_name', label: '어웨이 팀명', kind: 'text', once: true },
  { role: 'home_score', label: '홈 점수', kind: 'text', once: true },
  { role: 'away_score', label: '어웨이 점수', kind: 'text', once: true },
  { role: 'home_color', label: '홈 팀 색', kind: 'zone', once: true },
  { role: 'away_color', label: '어웨이 팀 색', kind: 'zone', once: true },
  { role: 'free', label: '자유 글자', kind: 'text', once: false },
] as const;

const ROLE_COLORS: Record<string, string> = {
  round_label: '#4ade80', home_name: '#4ade80', away_name: '#4ade80',
  home_score: '#4ade80', away_score: '#4ade80', free: '#4ade80',
  home_logo: '#60a5fa', away_logo: '#60a5fa',
  home_color: '#fb923c', away_color: '#fb923c',
  hide: '#f87171',
};

// 초안에 넣을 표본 값 — 자리를 눈으로 확인하는 용도라 그럴듯한 글이면 된다.
const SAMPLE: Record<string, string> = {
  round_label: '2026 SAMPLE LEAGUE 1R', home_name: '홈팀', away_name: '어웨이팀',
  home_score: '0', away_score: '0',
};

const box: React.CSSProperties = {
  border: '1px solid var(--border-ghost, #2c2c32)', borderRadius: 10,
  padding: 14, marginBottom: 14, background: 'var(--surface, #101014)',
};
const btn: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 7, fontSize: 13, cursor: 'pointer',
  border: '1px solid var(--border-ghost, #3c3c42)', background: 'var(--bg, #0b0b0e)',
  color: 'inherit',
};
const sel: React.CSSProperties = { ...btn, padding: '3px 6px', fontSize: 12 };
const numIn: React.CSSProperties = { ...btn, width: 64, padding: '3px 6px', fontSize: 12 };

/** 역할 지정(자동 후보 + 손 배치)을 서버 명세로. 만들기와 초안이 같은 것을 쓴다. */
function sideSpec(a: Analyzed, roles: Record<number, string>,
                  objs: Record<number, string>, manual: ManualField[], isBoard: boolean) {
  const fields: Record<string, unknown>[] = [];
  let freeSeq = 0;
  for (const t of a.texts) {
    const role = roles[t.layer] || '';
    if (!role) continue;
    const id = role === 'free' ? `free_${freeSeq++}` : role;
    fields.push({ id, label: role === 'free' ? (t.content || '자유 글자') : undefined,
                  kind: 'text', box: t.box, size: t.size, tracking: t.tracking,
                  color: t.color, placeholder: t.content,
                  default: role === 'round_label' ? t.content : '' });
  }
  const hide: number[] = [];
  const zones: Record<string, unknown>[] = [];
  for (const o of a.objects) {
    const role = objs[o.layer] || 'keep';
    if (role === 'hide') hide.push(o.layer);
    else if (role === 'home_logo' || role === 'away_logo') {
      hide.push(o.layer);
      fields.push({ id: role, label: role === 'home_logo' ? '홈 로고' : '어웨이 로고',
                    kind: 'logo', box: o.box, empty: 'mark' });
    } else if (role === 'home_color' || role === 'away_color') {
      zones.push({ id: role, label: role === 'home_color' ? '홈 팀 색' : '어웨이 팀 색',
                   box: o.box, source: o.sample_color });
    }
  }
  for (const m of manual) {
    if (m.kind === 'zone') {
      zones.push({ id: m.role, label: m.label, box: m.box, source: m.source });
      continue;
    }
    const id = m.role === 'free' ? `free_${freeSeq++}` : m.role;
    if (m.kind === 'logo') {
      fields.push({ id, label: m.label, kind: 'logo', box: m.box, empty: 'mark' });
    } else {
      fields.push({ id, label: m.role === 'free' ? m.label : undefined, kind: 'text',
                    box: m.box, size: m.size, color: m.color,
                    placeholder: SAMPLE[m.role] ?? m.label,
                    default: m.role === 'round_label' ? SAMPLE.round_label : '' });
    }
  }
  return { token: a.token, hide_layers: hide, fields, ...(isBoard ? { zones } : {}) };
}

/** 초안에 넣을 값 — 자동 후보는 시안 문구, 손 배치는 표본 문구. */
function sampleValues(a: Analyzed, roles: Record<number, string>, manual: ManualField[]) {
  const values: Record<string, string> = {};
  let freeSeq = 0;
  for (const t of a.texts) {
    const role = roles[t.layer] || '';
    if (!role) continue;
    const id = role === 'free' ? `free_${freeSeq++}` : role;
    values[id] = t.content || SAMPLE[role] || '';
  }
  for (const m of manual) {
    if (m.kind !== 'text') continue;
    const id = m.role === 'free' ? `free_${freeSeq++}` : m.role;
    values[id] = SAMPLE[m.role] ?? m.label;
  }
  return values;
}

/** 배경 그림에서 상자 가운데 색을 뽑는다 — 손으로 놓은 팀 색 영역의 '원래 색'. */
function sampleColor(img: HTMLImageElement, design: [number, number],
                     fieldBox: [number, number, number, number]): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '#000000';
    ctx.drawImage(img, 0, 0);
    const sx = img.naturalWidth / design[0];
    const sy = img.naturalHeight / design[1];
    const x = Math.min(canvas.width - 1, Math.max(0, Math.round((fieldBox[0] + fieldBox[2] / 2) * sx)));
    const y = Math.min(canvas.height - 1, Math.max(0, Math.round((fieldBox[1] + fieldBox[3] / 2) * sy)));
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    const hex = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return '#000000';
  }
}

let manualSeq = 1;

function Slot({ title, hint, analyzed, roles, objRoles, palette, onFile,
                roleOf, setRole, objRoleOf, setObjRole,
                manual, setManual, draftUrl, draftBusy }: {
  title: string; hint: string;
  analyzed: Analyzed | null;
  roles: readonly (readonly [string, string])[];
  objRoles: readonly (readonly [string, string])[];
  palette: readonly { role: string; label: string; kind: string; once: boolean }[];
  onFile: (f: File) => void;
  roleOf: (layer: number) => string; setRole: (layer: number, role: string) => void;
  objRoleOf: (layer: number) => string; setObjRole: (layer: number, role: string) => void;
  manual: ManualField[]; setManual: (fn: (prev: ManualField[]) => ManualField[]) => void;
  draftUrl: string; draftBusy: boolean;
}) {
  const [hover, setHover] = useState<number | string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // 끌기 상태 — 리렌더를 피하려고 ref 에 든다. 놓을 때만 상태를 확정한다.
  const drag = useRef<{ uid: number; mode: 'move' | 'resize';
                        startX: number; startY: number;
                        box: [number, number, number, number] } | null>(null);

  const design = analyzed?.design ?? [1, 1];
  const pct = (v: number, axis: 0 | 1) => `${(v / design[axis]) * 100}%`;
  // '하나만' 인 항목의 중복을 막는다 — 자동 후보에 매긴 역할과 손 배치를 합쳐 본다.
  const usedRoles = new Set<string>([
    ...(analyzed?.texts.map((t) => roleOf(t.layer)).filter(Boolean) ?? []),
    ...(analyzed?.objects.map((o) => objRoleOf(o.layer)) ?? []),
    ...manual.map((m) => m.role),
  ]);

  const scale = () => {
    const w = wrapRef.current?.clientWidth || 1;
    return design[0] / w;   // 화면 px → 시안 px
  };

  const addManual = (p: { role: string; label: string; kind: string }) => {
    const isZone = p.kind === 'zone';
    const isLogo = p.kind === 'logo';
    const w = isLogo ? Math.round(design[0] * 0.2) : Math.round(design[0] * (isZone ? 0.04 : 0.4));
    const h = isLogo ? w : Math.round(design[1] * (isZone ? 0.1 : 0.06));
    const boxNew: [number, number, number, number] = [
      Math.round((design[0] - w) / 2), Math.round((design[1] - h) / 2), w, h];
    const field: ManualField = {
      uid: manualSeq++, role: p.role, kind: p.kind as ManualField['kind'],
      label: p.label, box: boxNew,
      size: Math.max(12, Math.round(h * 0.7)), color: '#FFFFFF',
      source: isZone && imgRef.current
        ? sampleColor(imgRef.current, design as [number, number], boxNew) : '#000000',
    };
    setManual((prev) => [...prev, field]);
  };

  const onPointerDown = (e: React.PointerEvent, uid: number, mode: 'move' | 'resize') => {
    const target = manual.find((m) => m.uid === uid);
    if (!target) return;
    drag.current = { uid, mode, startX: e.clientX, startY: e.clientY, box: [...target.box] };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const k = scale();
    const dx = (e.clientX - d.startX) * k;
    const dy = (e.clientY - d.startY) * k;
    setManual((prev) => prev.map((m) => {
      if (m.uid !== d.uid) return m;
      if (d.mode === 'move') {
        const l = Math.round(Math.min(design[0] - m.box[2], Math.max(0, d.box[0] + dx)));
        const t = Math.round(Math.min(design[1] - m.box[3], Math.max(0, d.box[1] + dy)));
        return { ...m, box: [l, t, m.box[2], m.box[3]] };
      }
      const w = Math.round(Math.max(16, d.box[2] + dx));
      const h = Math.round(Math.max(12, d.box[3] + dy));
      return { ...m, box: [m.box[0], m.box[1], w, h],
               size: m.kind === 'text' ? Math.max(12, Math.round(h * 0.7)) : m.size };
    }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // 영역(팀 색)은 놓은 자리에서 바탕색을 다시 뽑는다 — 자리가 색을 정한다.
    setManual((prev) => prev.map((m) => (
      m.uid === d.uid && m.kind === 'zone' && imgRef.current
        ? { ...m, source: sampleColor(imgRef.current, design as [number, number], m.box) }
        : m
    )));
  };

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>{hint}</span>
        <label style={{ ...btn, marginLeft: 'auto' }}>
          배경(PSD/이미지) 올리기
          <input type="file" accept=".psd,.psb,image/*" style={{ display: 'none' }}
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        </label>
      </div>

      {analyzed ? (
        <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 420px', minWidth: 340 }}>
            {/* 팔레트 — 배경 위에 항목을 추가해 끌어 놓는다 */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--muted, #999)', alignSelf: 'center' }}>
                항목 추가:
              </span>
              {palette.map((p) => {
                const disabled = p.once && usedRoles.has(p.role);
                return (
                  <button key={p.role} disabled={disabled}
                          style={{ ...btn, fontSize: 11, padding: '3px 8px',
                                   opacity: disabled ? 0.35 : 1,
                                   borderColor: ROLE_COLORS[p.role] ?? '#3c3c42' }}
                          onClick={() => addManual(p)}>
                    + {p.label}
                  </button>
                );
              })}
            </div>

            <div ref={wrapRef}
                 style={{ position: 'relative', background: '#222', borderRadius: 8,
                          overflow: 'hidden', border: '1px solid var(--border-ghost, #2c2c32)',
                          touchAction: 'none' }}
                 onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
              {/* eslint-disable-next-line @next/next/no-img-element -- 분석 직후 서버가 만든 그림 */}
              <img ref={imgRef} crossOrigin="use-credentials"
                   src={`${API_BASE}/highlight/card-templates/pending/${analyzed.token}`}
                   alt="시안" style={{ width: '100%', display: 'block' }} />
              {/* PSD 자동 후보 상자 */}
              {analyzed.texts.map((t) => {
                const role = roleOf(t.layer);
                const color = role ? (ROLE_COLORS[role] ?? '#4ade80') : '#9ca3af';
                return (
                  <div key={`t${t.layer}`} title={t.content}
                       style={{ position: 'absolute',
                                left: pct(t.box[0], 0), top: pct(t.box[1], 1),
                                width: pct(t.box[2], 0), height: pct(t.box[3], 1),
                                border: `2px ${role ? 'solid' : 'dashed'} ${color}`,
                                boxShadow: hover === t.layer ? `0 0 0 3px ${color}66` : undefined,
                                pointerEvents: 'none', borderRadius: 3 }} />
                );
              })}
              {analyzed.objects.map((o) => {
                const role = objRoleOf(o.layer);
                if (role === 'keep' && hover !== o.layer) return null;
                const color = ROLE_COLORS[role] ?? '#9ca3af';
                return (
                  <div key={`o${o.layer}`} title={o.name}
                       style={{ position: 'absolute',
                                left: pct(o.box[0], 0), top: pct(o.box[1], 1),
                                width: pct(o.box[2], 0), height: pct(o.box[3], 1),
                                border: `2px solid ${color}`,
                                boxShadow: hover === o.layer ? `0 0 0 3px ${color}66` : undefined,
                                pointerEvents: 'none', borderRadius: 3 }} />
                );
              })}
              {/* 손으로 놓은 상자 — 끌어서 옮기고, 오른쪽 아래 손잡이로 키운다 */}
              {manual.map((m) => {
                const color = ROLE_COLORS[m.role] ?? '#4ade80';
                return (
                  <div key={`m${m.uid}`}
                       onPointerDown={(e) => onPointerDown(e, m.uid, 'move')}
                       style={{ position: 'absolute',
                                left: pct(m.box[0], 0), top: pct(m.box[1], 1),
                                width: pct(m.box[2], 0), height: pct(m.box[3], 1),
                                border: `2px solid ${color}`, borderRadius: 3,
                                background: `${color}22`, cursor: 'move',
                                boxShadow: hover === `m${m.uid}` ? `0 0 0 3px ${color}66` : undefined }}>
                    <span style={{ position: 'absolute', top: -18, left: 0, fontSize: 10,
                                   color, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                      {m.label}
                    </span>
                    <span onPointerDown={(e) => onPointerDown(e, m.uid, 'resize')}
                          style={{ position: 'absolute', right: -6, bottom: -6, width: 12,
                                   height: 12, background: color, borderRadius: 3,
                                   cursor: 'nwse-resize' }} />
                  </div>
                );
              })}
            </div>

            {draftUrl || draftBusy ? (
              <div style={{ marginTop: 10 }}>
                <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--muted, #999)' }}>
                  초안 미리보기 (합칠 때와 같은 렌더러){draftBusy ? ' — 그리는 중…' : ''}
                </p>
                {draftUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 서버가 방금 그린 blob
                  <img src={draftUrl} alt="초안"
                       style={{ width: '100%', display: 'block', borderRadius: 8,
                                border: '1px solid var(--border-ghost, #2c2c32)',
                                opacity: draftBusy ? 0.6 : 1 }} />
                ) : null}
              </div>
            ) : null}
          </div>

          <div style={{ flex: '1 1 340px', minWidth: 300 }}>
            {/* 손으로 놓은 항목 목록 */}
            {manual.length ? (
              <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%',
                              marginBottom: 8 }}>
                <thead>
                  <tr style={{ color: 'var(--muted, #999)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>놓은 항목</th><th>설정</th><th />
                  </tr>
                </thead>
                <tbody>
                  {manual.map((m) => (
                    <tr key={m.uid}
                        onMouseEnter={() => setHover(`m${m.uid}`)} onMouseLeave={() => setHover(null)}
                        style={{ borderTop: '1px solid var(--border-ghost, #222)' }}>
                      <td style={{ padding: 4 }}>
                        <span style={{ display: 'inline-block', width: 10, height: 10, marginRight: 6,
                                       borderRadius: 2, verticalAlign: 'middle',
                                       background: ROLE_COLORS[m.role] ?? '#4ade80' }} />
                        {m.label}
                      </td>
                      <td>
                        {m.kind === 'text' ? (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <input type="number" style={numIn} value={m.size}
                                   onChange={(e) => setManual((prev) => prev.map((x) =>
                                     x.uid === m.uid ? { ...x, size: Number(e.target.value) || 12 } : x))} />pt
                            <input type="color" value={m.color}
                                   onChange={(e) => setManual((prev) => prev.map((x) =>
                                     x.uid === m.uid ? { ...x, color: e.target.value.toUpperCase() } : x))}
                                   style={{ width: 26, height: 22, padding: 0, border: 'none',
                                            background: 'transparent', cursor: 'pointer' }} />
                          </span>
                        ) : m.kind === 'zone' ? (
                          <span style={{ fontSize: 11 }}>
                            바탕색 <span style={{ display: 'inline-block', width: 12, height: 12,
                                             background: m.source, border: '1px solid #555',
                                             verticalAlign: 'middle' }} /> {m.source}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--muted, #999)' }}>
                            {m.box[2]}×{m.box[3]}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button style={{ ...btn, fontSize: 11, padding: '2px 7px', color: '#f87171' }}
                                onClick={() => setManual((prev) => prev.filter((x) => x.uid !== m.uid))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted, #999)' }}>
                {analyzed.kind === 'image'
                  ? '위 팔레트에서 항목을 추가해 배경 위에 끌어 놓으세요.'
                  : 'PSD 후보에 역할을 정하거나, 팔레트에서 직접 추가할 수도 있습니다.'}
              </p>
            )}

            {/* PSD 자동 후보 표 */}
            {analyzed.texts.length ? (
              <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr style={{ color: 'var(--muted, #999)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>글자 레이어</th><th>크기</th><th>역할</th>
                  </tr>
                </thead>
                <tbody>
                  {analyzed.texts.map((t) => (
                    <tr key={t.layer}
                        onMouseEnter={() => setHover(t.layer)} onMouseLeave={() => setHover(null)}
                        style={{ borderTop: '1px solid var(--border-ghost, #222)' }}>
                      <td style={{ padding: 4, maxWidth: 240, overflow: 'hidden',
                                   textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.content || '(빈 글자)'}
                      </td>
                      <td>{t.size}pt{t.tracking ? `·자간${t.tracking}` : ''}</td>
                      <td>
                        <select style={sel} value={roleOf(t.layer)}
                                onChange={(e) => setRole(t.layer, e.target.value)}>
                          {roles.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {analyzed.objects.length ? (
              <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%', marginTop: 8 }}>
                <thead>
                  <tr style={{ color: 'var(--muted, #999)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>도형·오브젝트</th><th>색</th><th>처리</th>
                  </tr>
                </thead>
                <tbody>
                  {analyzed.objects.map((o) => (
                    <tr key={o.layer}
                        onMouseEnter={() => setHover(o.layer)} onMouseLeave={() => setHover(null)}
                        style={{ borderTop: '1px solid var(--border-ghost, #222)' }}>
                      <td style={{ padding: 4 }}>{o.name}</td>
                      <td><span style={{ display: 'inline-block', width: 12, height: 12,
                                         background: o.sample_color, border: '1px solid #555',
                                         verticalAlign: 'middle' }} /> {o.sample_color}</td>
                      <td>
                        <select style={sel} value={objRoleOf(o.layer)}
                                onChange={(e) => setObjRole(o.layer, e.target.value)}>
                          {objRoles.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function TemplateEditorPage() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [made, setMade] = useState('');
  const [templates, setTemplates] = useState<TemplateRow[]>([]);

  const [start, setStart] = useState<Analyzed | null>(null);
  const [board, setBoard] = useState<Analyzed | null>(null);
  const [startRoles, setStartRoles] = useState<Record<number, string>>({});
  const [startObj, setStartObj] = useState<Record<number, string>>({});
  const [boardRoles, setBoardRoles] = useState<Record<number, string>>({});
  const [boardObj, setBoardObj] = useState<Record<number, string>>({});
  const [startManual, setStartManual] = useState<ManualField[]>([]);
  const [boardManual, setBoardManual] = useState<ManualField[]>([]);
  const [videos, setVideos] = useState<{ first?: File; second?: File; outro?: File }>({});
  const [backdrop, setBackdrop] = useState<File | null>(null);
  const [boardSize, setBoardSize] = useState(27);
  const [boardX, setBoardX] = useState(74);
  const [boardY, setBoardY] = useState(80);
  const [previewUrl, setPreviewUrl] = useState('');
  const [startDraft, setStartDraft] = useState('');
  const [boardDraft, setBoardDraft] = useState('');
  const [startDraftBusy, setStartDraftBusy] = useState(false);
  const [boardDraftBusy, setBoardDraftBusy] = useState(false);
  const draftSeq = useRef(0);

  const loadTemplates = () => {
    apiJson<{ templates: TemplateRow[] }>('/highlight/card-templates')
      .then((d) => setTemplates(d.templates))
      .catch(() => {});
  };
  useEffect(loadTemplates, []);

  const analyze = async (file: File, side: 'start' | 'board') => {
    setBusy(`${side === 'start' ? '시작 카드' : '점수판'} 분석 중…`);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/highlight/card-templates/analyze`, {
        method: 'POST', credentials: 'include', body: form,
      });
      if (!res.ok) throw new Error(await res.text());
      const data: Analyzed = await res.json();
      if (side === 'start') {
        setStart(data); setStartRoles({}); setStartObj({}); setStartManual([]); setStartDraft('');
      } else {
        setBoard(data); setBoardRoles({}); setBoardObj({}); setBoardManual([]); setBoardDraft('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  // 역할·배치가 바뀌면 초안을 다시 그린다 — 끌는 동안 매 픽셀 왕복하지 않게 잠깐 기다린다.
  useEffect(() => {
    if (!start) return undefined;
    const spec = sideSpec(start, startRoles, startObj, startManual, false);
    if (!spec.fields.length) { setStartDraft(''); return undefined; }
    const seq = ++draftSeq.current;
    const timer = setTimeout(async () => {
      setStartDraftBusy(true);
      try {
        const res = await fetch(`${API_BASE}/highlight/card-templates/preview-draft`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...spec, kind: 'start', width: 720,
                                 values: sampleValues(start, startRoles, startManual) }),
        });
        if (!res.ok) throw new Error(await res.text());
        const url = URL.createObjectURL(await res.blob());
        if (seq !== draftSeq.current) { URL.revokeObjectURL(url); return; }
        setStartDraft((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      } catch {
        /* 초안은 참고용 — 실패해도 흐름을 막지 않는다 */
      } finally {
        setStartDraftBusy(false);
      }
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, startRoles, startObj, startManual]);

  useEffect(() => {
    if (!board) return undefined;
    const spec = sideSpec(board, boardRoles, boardObj, boardManual, true);
    const zoneCount = (spec as { zones?: unknown[] }).zones?.length ?? 0;
    if (!spec.fields.length && !zoneCount) { setBoardDraft(''); return undefined; }
    const timer = setTimeout(async () => {
      setBoardDraftBusy(true);
      try {
        const res = await fetch(`${API_BASE}/highlight/card-templates/preview-draft`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...spec, kind: 'board', width: 720,
                                 values: sampleValues(board, boardRoles, boardManual) }),
        });
        if (!res.ok) throw new Error(await res.text());
        const url = URL.createObjectURL(await res.blob());
        setBoardDraft((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      } catch {
        /* 초안은 참고용 */
      } finally {
        setBoardDraftBusy(false);
      }
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, boardRoles, boardObj, boardManual]);

  const create = async () => {
    if (!name.trim()) { setError('템플릿 이름을 적어 주세요.'); return; }
    if (!start) { setError('시작 카드는 필수입니다.'); return; }
    setBusy('템플릿 만드는 중…');
    setError('');
    try {
      const spec: Record<string, unknown> = {
        outro_default: Boolean(videos.outro),
        start: sideSpec(start, startRoles, startObj, startManual, false),
      };
      if (board) {
        spec.board = {
          ...sideSpec(board, boardRoles, boardObj, boardManual, true),
          defaults: { size_pct: boardSize, pos_px_x: boardX, pos_px_y: boardY },
        };
      }
      const form = new FormData();
      form.append('name', name.trim());
      form.append('spec', JSON.stringify(spec));
      if (backdrop) form.append('backdrop', backdrop);
      if (videos.first) form.append('first_half', videos.first);
      if (videos.second) form.append('second_half', videos.second);
      if (videos.outro) form.append('outro', videos.outro);
      const res = await fetch(`${API_BASE}/highlight/card-templates/custom`, {
        method: 'POST', credentials: 'include', body: form,
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setMade(data.id);
      const pv = await fetch(`${API_BASE}/highlight/card-preview`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: data.id, kind: 'start', width: 760 }),
      });
      if (pv.ok) {
        const url = URL.createObjectURL(await pv.blob());
        setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      }
      setStart(null); setBoard(null); setVideos({}); setBackdrop(null); setName('');
      setStartManual([]); setBoardManual([]); setStartDraft(''); setBoardDraft('');
      loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string, label: string) => {
    if (!window.confirm(`템플릿 '${label}' 을 지울까요? 이걸 고른 저장본은 파인플레이 기본으로 떨어집니다.`)) return;
    try {
      await apiJson(`/highlight/card-templates/${id}`, { method: 'DELETE' });
      loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ maxWidth: 1080 }}>
      <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>템플릿 에디터</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted, #999)' }}>
        배경을 올리고, 팔레트에서 항목(팀 로고·대회명·팀명…)을 추가해 배경 위에 끌어
        놓으세요. 값은 쓸 때 넣으니 여기서는 <b>자리만</b> 정합니다. 레이어가 살아 있는
        PSD 를 올리면 글자·로고·팀 색 후보를 자동으로 읽어 역할만 고르면 됩니다.
      </p>

      <div style={box}>
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          템플릿 이름
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80}
                 placeholder="예: 한양대 리그" style={{ ...btn, width: 260, textAlign: 'left' }} />
        </label>
      </div>

      <Slot
        title="① 시작 카드 (필수)" hint="시작 전 팀 소개 배경 — 이미지면 직접 배치, PSD 면 자동 후보"
        analyzed={start} roles={TEXT_ROLES_START} objRoles={OBJ_ROLES_START}
        palette={PALETTE_START}
        onFile={(f) => void analyze(f, 'start')}
        roleOf={(l) => startRoles[l] || ''} setRole={(l, r) => setStartRoles((p) => ({ ...p, [l]: r }))}
        objRoleOf={(l) => startObj[l] || 'keep'} setObjRole={(l, r) => setStartObj((p) => ({ ...p, [l]: r }))}
        manual={startManual} setManual={setStartManual}
        draftUrl={startDraft} draftBusy={startDraftBusy}
      />

      <div style={box}>
        <strong style={{ fontSize: 14 }}>①-1 카드 뒤 배경 사진 (선택)</strong>
        <span style={{ fontSize: 12, color: 'var(--muted, #999)', marginLeft: 8 }}>
          시안 여백이 투명이면 흰 화면 대신 이 사진이 비칩니다 (SUFA 는 경기장 사진)
        </span>
        <label style={{ ...btn, marginLeft: 12, fontSize: 12 }}>
          {backdrop ? `✓ ${backdrop.name}` : '사진 올리기'}
          <input type="file" accept="image/*" style={{ display: 'none' }}
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) setBackdrop(f); }} />
        </label>
      </div>

      <Slot
        title="② 점수판 (선택)" hint="영상에 얹는 오버레이 — 안 올리면 기본 점수판을 씁니다"
        analyzed={board} roles={TEXT_ROLES_BOARD} objRoles={OBJ_ROLES_BOARD}
        palette={PALETTE_BOARD}
        onFile={(f) => void analyze(f, 'board')}
        roleOf={(l) => boardRoles[l] || ''} setRole={(l, r) => setBoardRoles((p) => ({ ...p, [l]: r }))}
        objRoleOf={(l) => boardObj[l] || 'keep'} setObjRole={(l, r) => setBoardObj((p) => ({ ...p, [l]: r }))}
        manual={boardManual} setManual={setBoardManual}
        draftUrl={boardDraft} draftBusy={boardDraftBusy}
      />
      {board ? (
        <div style={{ ...box, marginTop: -8 }}>
          <strong style={{ fontSize: 13 }}>②-1 점수판 기본 크기·자리</strong>
          <span style={{ fontSize: 12, color: 'var(--muted, #999)', marginLeft: 8 }}>
            세트를 고르는 순간 이 값으로 잡힙니다 — 그 뒤엔 자유롭게 옮길 수 있습니다
          </span>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center', fontSize: 12 }}>
            <label>크기 <input type="number" style={numIn} value={boardSize}
                              onChange={(e) => setBoardSize(Number(e.target.value) || 27)} /> %</label>
            <label>x <input type="number" style={numIn} value={boardX}
                            onChange={(e) => setBoardX(Number(e.target.value) || 0)} /> px</label>
            <label>y <input type="number" style={numIn} value={boardY}
                            onChange={(e) => setBoardY(Number(e.target.value) || 0)} /> px</label>
          </div>
        </div>
      ) : null}

      <div style={box}>
        <strong style={{ fontSize: 14 }}>③ 영상 (선택)</strong>
        <span style={{ fontSize: 12, color: 'var(--muted, #999)', marginLeft: 8 }}>
          전·후반 효과는 글자 없이 그대로 들어갑니다 — 전반은 시작 카드 뒤, 후반은 첫 T 자리
        </span>
        <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
          {([['first', '전반전 효과'], ['second', '후반전 효과'], ['outro', '마무리 영상']] as const)
            .map(([k, label]) => (
              <label key={k} style={{ ...btn, fontSize: 12 }}>
                {label}{videos[k] ? ` ✓ ${videos[k]!.name}` : ' (mp4)'}
                <input type="file" accept="video/mp4,video/quicktime,video/webm"
                       style={{ display: 'none' }}
                       onChange={(e) => {
                         const f = e.target.files?.[0];
                         if (f) setVideos((p) => ({ ...p, [k]: f }));
                       }} />
              </label>
            ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <button style={{ ...btn, fontWeight: 700, padding: '8px 18px' }}
                disabled={Boolean(busy)} onClick={() => void create()}>
          템플릿 만들기
        </button>
        {busy ? <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>{busy}</span> : null}
        {error ? <span style={{ fontSize: 12, color: '#f87171' }}>{error}</span> : null}
        {made && !busy ? <span style={{ fontSize: 12, color: '#4ade80' }}>만들었습니다 — 수동 태깅의 드롭다운에 떴습니다</span> : null}
      </div>
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- 방금 서버가 그린 blob
        <img src={previewUrl} alt="새 템플릿 시작 카드"
             style={{ maxWidth: 560, width: '100%', borderRadius: 8, marginBottom: 18,
                      border: '1px solid var(--border-ghost, #2c2c32)' }} />
      ) : null}

      <div style={box}>
        <strong style={{ fontSize: 14 }}>템플릿 목록</strong>
        <table style={{ fontSize: 13, borderCollapse: 'collapse', width: '100%', marginTop: 8 }}>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} style={{ borderTop: '1px solid var(--border-ghost, #222)' }}>
                <td style={{ padding: 6 }}>{t.name}</td>
                <td style={{ fontSize: 11, color: 'var(--muted, #999)' }}>
                  {t.custom ? '커스텀' : '내장'}
                  {t.has_board ? ' · 점수판' : ''}{t.has_half_videos ? ' · 전후반 영상' : ''}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {t.custom ? (
                    <button style={{ ...btn, fontSize: 11, color: '#f87171' }}
                            onClick={() => void remove(t.id, t.name)}>삭제</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
