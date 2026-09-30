'use client';

/**
 * 템플릿 에디터 — PSD/이미지를 올려 카드·점수판 세트를 만든다.
 *
 * PSD 는 서버가 글자·로고·팀색 레이어를 읽어 후보를 만들어 준다. 어느 후보가
 * 팀명이고 점수인지는 **여기서 사람이 정한다** — 레이어 이름은 파일마다 제각각이라
 * 완전 자동은 믿을 수 없다(SUFA 를 들일 때 실제로 틀렸다).
 *
 * 후보는 시안 그림 위에 상자로 겹쳐 보이고, 역할을 바꾸면 **저장하기 전에** 초안이
 * 다시 그려진다 — 합치기가 쓰는 렌더러 그대로라 결과와 어긋나지 않는다.
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

// 역할별 상자 색 — 시안 위에 겹쳐 그릴 때 한눈에 갈리게.
const ROLE_COLORS: Record<string, string> = {
  round_label: '#4ade80', home_name: '#4ade80', away_name: '#4ade80',
  home_score: '#4ade80', away_score: '#4ade80', free: '#4ade80',
  home_logo: '#60a5fa', away_logo: '#60a5fa',
  home_color: '#fb923c', away_color: '#fb923c',
  hide: '#f87171',
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
const numIn: React.CSSProperties = { ...btn, width: 70, padding: '3px 6px', fontSize: 12 };

/** 역할 지정을 서버 명세로. 만들기와 초안 미리보기가 같은 것을 쓴다 — 달라지면
 *  미리보기 따로 결과 따로가 된다. */
function sideSpec(a: Analyzed, roles: Record<number, string>,
                  objs: Record<number, string>, isBoard: boolean) {
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
  return { token: a.token, hide_layers: hide, fields, ...(isBoard ? { zones } : {}) };
}

/** 초안 렌더에 넣을 표본 값 — 시안에 적혀 있던 문구를 그대로 되살린다. */
function sampleValues(a: Analyzed, roles: Record<number, string>) {
  const values: Record<string, string> = {};
  let freeSeq = 0;
  for (const t of a.texts) {
    const role = roles[t.layer] || '';
    if (!role) continue;
    const id = role === 'free' ? `free_${freeSeq++}` : role;
    values[id] = t.content || (role.includes('score') ? '0' : '');
  }
  return values;
}

function Slot({ title, hint, analyzed, roles, objRoles, onFile, roleOf, setRole,
                objRoleOf, setObjRole, draftUrl, draftBusy }: {
  title: string; hint: string;
  analyzed: Analyzed | null;
  roles: readonly (readonly [string, string])[];
  objRoles: readonly (readonly [string, string])[];
  onFile: (f: File) => void;
  roleOf: (layer: number) => string; setRole: (layer: number, role: string) => void;
  objRoleOf: (layer: number) => string; setObjRole: (layer: number, role: string) => void;
  draftUrl: string; draftBusy: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const design = analyzed?.design ?? [1, 1];
  // 시안 위 상자 — % 로 놓으면 이미지가 어떤 폭으로 그려져도 자리가 맞는다.
  const pct = (v: number, axis: 0 | 1) => `${(v / design[axis]) * 100}%`;

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>{hint}</span>
        <label style={{ ...btn, marginLeft: 'auto' }}>
          PSD/이미지 올리기
          <input type="file" accept=".psd,.psb,image/*" style={{ display: 'none' }}
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        </label>
      </div>

      {analyzed ? (
        <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
          {/* 왼쪽: 시안 + 후보 상자 오버레이 */}
          <div style={{ flex: '1 1 380px', minWidth: 320 }}>
            <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--muted, #999)' }}>
              시안 {analyzed.design[0]}×{analyzed.design[1]}
              {analyzed.kind === 'image' ? ` — ${analyzed.note ?? ''}` : ' — 상자에 역할을 정해 주세요'}
            </p>
            <div style={{ position: 'relative', background: '#222', borderRadius: 8,
                          overflow: 'hidden', border: '1px solid var(--border-ghost, #2c2c32)' }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- 분석 직후 서버가 만든 그림 */}
              <img src={`${API_BASE}/highlight/card-templates/pending/${analyzed.token}`}
                   alt="시안" style={{ width: '100%', display: 'block' }} />
              {analyzed.texts.map((t) => {
                const role = roleOf(t.layer);
                const color = role ? (ROLE_COLORS[role] ?? '#4ade80') : '#9ca3af';
                return (
                  <div key={`t${t.layer}`} title={t.content}
                       style={{
                         position: 'absolute',
                         left: pct(t.box[0], 0), top: pct(t.box[1], 1),
                         width: pct(t.box[2], 0), height: pct(t.box[3], 1),
                         border: `2px ${role ? 'solid' : 'dashed'} ${color}`,
                         boxShadow: hover === t.layer ? `0 0 0 3px ${color}66` : undefined,
                         pointerEvents: 'none', borderRadius: 3,
                       }} />
                );
              })}
              {analyzed.objects.map((o) => {
                const role = objRoleOf(o.layer);
                if (role === 'keep' && hover !== o.layer) return null;
                const color = ROLE_COLORS[role] ?? '#9ca3af';
                return (
                  <div key={`o${o.layer}`} title={o.name}
                       style={{
                         position: 'absolute',
                         left: pct(o.box[0], 0), top: pct(o.box[1], 1),
                         width: pct(o.box[2], 0), height: pct(o.box[3], 1),
                         border: `2px solid ${color}`,
                         boxShadow: hover === o.layer ? `0 0 0 3px ${color}66` : undefined,
                         pointerEvents: 'none', borderRadius: 3,
                       }} />
                );
              })}
            </div>

            {/* 초안 — 역할을 바꾸면 저장 전에 다시 그려진다 */}
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

          {/* 오른쪽: 역할 지정 표 */}
          <div style={{ flex: '1 1 340px', minWidth: 300 }}>
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
                        <span style={{ display: 'inline-block', width: 10, height: 10, marginRight: 6,
                                       borderRadius: 2, verticalAlign: 'middle',
                                       background: roleOf(t.layer) ? (ROLE_COLORS[roleOf(t.layer)] ?? '#4ade80') : '#9ca3af' }} />
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
  const [videos, setVideos] = useState<{ first?: File; second?: File; outro?: File }>({});
  const [backdrop, setBackdrop] = useState<File | null>(null);
  // 점수판 기본 크기·자리 — 세트를 고르는 순간 잡힐 값(픽셀 좌표).
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
      if (side === 'start') { setStart(data); setStartRoles({}); setStartObj({}); setStartDraft(''); }
      else { setBoard(data); setBoardRoles({}); setBoardObj({}); setBoardDraft(''); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  // 역할이 바뀌면 초안을 다시 그린다 — 조금 기다렸다가(타자마다 왕복하지 않게).
  useEffect(() => {
    if (!start) return undefined;
    const spec = sideSpec(start, startRoles, startObj, false);
    if (!spec.fields.length) { setStartDraft(''); return undefined; }
    const seq = ++draftSeq.current;
    const timer = setTimeout(async () => {
      setStartDraftBusy(true);
      try {
        const res = await fetch(`${API_BASE}/highlight/card-templates/preview-draft`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...spec, kind: 'start', width: 720,
                                 values: sampleValues(start, startRoles) }),
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
  }, [start, startRoles, startObj]);

  useEffect(() => {
    if (!board) return undefined;
    const spec = sideSpec(board, boardRoles, boardObj, true);
    if (!spec.fields.length && !(spec as { zones?: unknown[] }).zones?.length) {
      setBoardDraft('');
      return undefined;
    }
    const timer = setTimeout(async () => {
      setBoardDraftBusy(true);
      try {
        const res = await fetch(`${API_BASE}/highlight/card-templates/preview-draft`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...spec, kind: 'board', width: 720,
                                 values: sampleValues(board, boardRoles) }),
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
  }, [board, boardRoles, boardObj]);

  const create = async () => {
    if (!name.trim()) { setError('템플릿 이름을 적어 주세요.'); return; }
    if (!start) { setError('시작 카드는 필수입니다.'); return; }
    setBusy('템플릿 만드는 중…');
    setError('');
    try {
      const spec: Record<string, unknown> = {
        outro_default: Boolean(videos.outro),
        start: sideSpec(start, startRoles, startObj, false),
      };
      if (board) {
        spec.board = {
          ...sideSpec(board, boardRoles, boardObj, true),
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
      setStartDraft(''); setBoardDraft('');
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
        PSD 를 올리면 글자·로고·팀 색 레이어를 서버가 읽어 시안 위에 상자로 보여 줍니다.
        역할을 정하면 초안이 바로 다시 그려지고, 저장하면 수동 태깅의 드롭다운에 뜹니다.
        일반 이미지는 배경으로만 쓰입니다(항목 자동 인식 불가).
      </p>

      <div style={box}>
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          템플릿 이름
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80}
                 placeholder="예: 한양대 리그" style={{ ...btn, width: 260, textAlign: 'left' }} />
        </label>
      </div>

      <Slot
        title="① 시작 카드 (필수)" hint="시작 전 팀 소개 시안 — PSD 권장"
        analyzed={start} roles={TEXT_ROLES_START} objRoles={OBJ_ROLES_START}
        onFile={(f) => void analyze(f, 'start')}
        roleOf={(l) => startRoles[l] || ''} setRole={(l, r) => setStartRoles((p) => ({ ...p, [l]: r }))}
        objRoleOf={(l) => startObj[l] || 'keep'} setObjRole={(l, r) => setStartObj((p) => ({ ...p, [l]: r }))}
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
        onFile={(f) => void analyze(f, 'board')}
        roleOf={(l) => boardRoles[l] || ''} setRole={(l, r) => setBoardRoles((p) => ({ ...p, [l]: r }))}
        objRoleOf={(l) => boardObj[l] || 'keep'} setObjRole={(l, r) => setBoardObj((p) => ({ ...p, [l]: r }))}
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
