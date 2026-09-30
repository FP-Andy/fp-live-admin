'use client';

/**
 * 템플릿 에디터 — PSD/이미지를 올려 카드·점수판 세트를 만든다.
 *
 * PSD 는 서버가 글자·로고·팀색 레이어를 읽어 후보를 만들어 준다. 어느 후보가
 * 팀명이고 점수인지는 **여기서 사람이 정한다** — 레이어 이름은 파일마다 제각각이라
 * 완전 자동은 믿을 수 없다(SUFA 를 들일 때 실제로 틀렸다). 일반 이미지는 배경으로만
 * 쓰이고 항목 후보가 없다.
 */

import { useEffect, useState } from 'react';
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

// 글자 후보에 매길 수 있는 역할. '사용 안 함' 은 배경에서 지워지기만 한다(글자는
// 어차피 전부 숨긴다 — 우리가 다시 그릴 자리다).
const TEXT_ROLES_START = [
  ['', '사용 안 함'], ['round_label', '대회·라운드'], ['home_name', '홈 팀명'],
  ['away_name', '어웨이 팀명'], ['free', '자유 글자'],
] as const;
const TEXT_ROLES_BOARD = [
  ['', '사용 안 함'], ['round_label', '대회·라운드'], ['home_name', '홈 팀명'],
  ['away_name', '어웨이 팀명'], ['home_score', '홈 점수'], ['away_score', '어웨이 점수'],
  ['free', '자유 글자'],
] as const;
// 오브젝트(도형·스마트오브젝트) 후보의 역할.
const OBJ_ROLES_START = [
  ['keep', '배경에 남김'], ['home_logo', '홈 로고 자리'], ['away_logo', '어웨이 로고 자리'],
  ['hide', '지움(팀 로고류)'],
] as const;
const OBJ_ROLES_BOARD = [
  ['keep', '배경에 남김'], ['home_color', '홈 팀 색'], ['away_color', '어웨이 팀 색'],
  ['hide', '지움'],
] as const;

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

function Slot({ title, hint, analyzed, roles, objRoles, onFile, roleOf, setRole,
                objRoleOf, setObjRole }: {
  title: string; hint: string;
  analyzed: Analyzed | null;
  roles: readonly (readonly [string, string])[];
  objRoles: readonly (readonly [string, string])[];
  onFile: (f: File) => void;
  roleOf: (layer: number) => string; setRole: (layer: number, role: string) => void;
  objRoleOf: (layer: number) => string; setObjRole: (layer: number, role: string) => void;
}) {
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
        <div style={{ marginTop: 10 }}>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted, #999)' }}>
            규격 {analyzed.design[0]}×{analyzed.design[1]}
            {analyzed.kind === 'image' ? ` — ${analyzed.note ?? ''}` : ''}
          </p>
          {analyzed.texts.length ? (
            <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ color: 'var(--muted, #999)', textAlign: 'left' }}>
                  <th style={{ padding: 4 }}>글자 레이어</th><th>크기</th><th>색</th><th>역할</th>
                </tr>
              </thead>
              <tbody>
                {analyzed.texts.map((t) => (
                  <tr key={t.layer} style={{ borderTop: '1px solid var(--border-ghost, #222)' }}>
                    <td style={{ padding: 4, maxWidth: 320, overflow: 'hidden',
                                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.content || '(빈 글자)'}</td>
                    <td>{t.size}pt{t.tracking ? ` · 자간${t.tracking}` : ''}</td>
                    <td><span style={{ display: 'inline-block', width: 12, height: 12,
                                       background: t.color, border: '1px solid #555',
                                       verticalAlign: 'middle' }} /> {t.color}</td>
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
                  <th style={{ padding: 4 }}>도형·오브젝트 레이어</th><th>자리</th><th>색</th><th>처리</th>
                </tr>
              </thead>
              <tbody>
                {analyzed.objects.map((o) => (
                  <tr key={o.layer} style={{ borderTop: '1px solid var(--border-ghost, #222)' }}>
                    <td style={{ padding: 4 }}>{o.name}</td>
                    <td>{Math.round(o.box[0])},{Math.round(o.box[1])} · {Math.round(o.box[2])}×{Math.round(o.box[3])}</td>
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
  // 역할 지정 — {레이어번호: 역할}. 면(시작/점수판)마다 따로다.
  const [startRoles, setStartRoles] = useState<Record<number, string>>({});
  const [startObj, setStartObj] = useState<Record<number, string>>({});
  const [boardRoles, setBoardRoles] = useState<Record<number, string>>({});
  const [boardObj, setBoardObj] = useState<Record<number, string>>({});
  const [videos, setVideos] = useState<{ first?: File; second?: File; outro?: File }>({});
  const [previewUrl, setPreviewUrl] = useState('');

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
      if (side === 'start') { setStart(data); setStartRoles({}); setStartObj({}); }
      else { setBoard(data); setBoardRoles({}); setBoardObj({}); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const create = async () => {
    if (!name.trim()) { setError('템플릿 이름을 적어 주세요.'); return; }
    if (!start) { setError('시작 카드는 필수입니다.'); return; }
    setBusy('템플릿 만드는 중…');
    setError('');
    try {
      // 역할 지정을 서버 명세로 옮긴다. 글자는 역할이 있으면 항목이 되고, 로고로
      // 지정한 오브젝트는 배경에서 숨겨지고 그 자리가 로고 칸이 된다.
      const sideSpec = (a: Analyzed, roles: Record<number, string>,
                        objs: Record<number, string>, isBoard: boolean) => {
        const fields: unknown[] = [];
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
        const zones: unknown[] = [];
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
        return { token: a.token, hide_layers: hide, fields,
                 ...(isBoard ? { zones } : {}) };
      };

      const spec: Record<string, unknown> = {
        outro_default: Boolean(videos.outro),
        start: sideSpec(start, startRoles, startObj, false),
      };
      if (board) spec.board = sideSpec(board, boardRoles, boardObj, true);

      const form = new FormData();
      form.append('name', name.trim());
      form.append('spec', JSON.stringify(spec));
      if (videos.first) form.append('first_half', videos.first);
      if (videos.second) form.append('second_half', videos.second);
      if (videos.outro) form.append('outro', videos.outro);
      const res = await fetch(`${API_BASE}/highlight/card-templates/custom`, {
        method: 'POST', credentials: 'include', body: form,
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setMade(data.id);
      // 방금 만든 세트의 시작 카드를 바로 보여 준다 — 결과를 확인해야 믿는다.
      const pv = await fetch(`${API_BASE}/highlight/card-preview`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: data.id, kind: 'start', width: 760 }),
      });
      if (pv.ok) {
        const url = URL.createObjectURL(await pv.blob());
        setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      }
      setStart(null); setBoard(null); setVideos({}); setName('');
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
    <div style={{ maxWidth: 980 }}>
      <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>템플릿 에디터</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted, #999)' }}>
        PSD 를 올리면 글자·로고·팀 색 레이어를 서버가 읽어 후보를 만들어 줍니다. 어느
        후보가 팀명이고 점수인지 역할을 정해 저장하면, 수동 태깅의 템플릿 드롭다운에
        바로 뜹니다. 일반 이미지는 배경으로만 쓰입니다(항목 자동 인식 불가).
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
      />
      <Slot
        title="② 점수판 (선택)" hint="영상에 얹는 오버레이 — 안 올리면 기본 점수판을 씁니다"
        analyzed={board} roles={TEXT_ROLES_BOARD} objRoles={OBJ_ROLES_BOARD}
        onFile={(f) => void analyze(f, 'board')}
        roleOf={(l) => boardRoles[l] || ''} setRole={(l, r) => setBoardRoles((p) => ({ ...p, [l]: r }))}
        objRoleOf={(l) => boardObj[l] || 'keep'} setObjRole={(l, r) => setBoardObj((p) => ({ ...p, [l]: r }))}
      />

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
