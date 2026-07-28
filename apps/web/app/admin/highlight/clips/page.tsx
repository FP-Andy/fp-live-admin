'use client';

import { useCallback, useEffect, useState } from 'react';
import HighlightSubTabs from '../HighlightSubTabs';
import { apiJson } from '../../../../lib/api';

// 클립 결과: match → clip → action 3계층 열람/편집.
// 클립 상세에서 [FPA dual] 새 창으로 씬을 찍어 클립에 귀속시키고,
// 액션별 클립 내 구간(초)을 다듬은 뒤 매치 단위로 FinePlay에 재전송한다.

type MatchRow = {
  match_id: string | null;
  job_id: string;
  name: string;
  home_team: string;
  away_team: string;
  clip_count: number;
  callback_status?: string | null;
  analysis_request_id?: number | string;
  updated_at?: string | null;
};

type ClipRow = {
  id: string;
  order_index: number;
  team_side?: string | null;
  start_sec: number;
  end_sec: number;
  duration_seconds?: number | null;
  main_action?: string | null;
  action_count: number;
  thumbnail_url?: string;
};

type ActionRow = {
  id?: number;
  seq: number;
  action: string;
  actionLabel: string;
  teamSide?: string | null;
  jersey?: string | null;
  playerId?: string | null;
  playerName?: string | null;
  xg?: number | null;
  xgot?: number | null;
  epv?: number | null;
  pc?: number | null;
  startOffset?: number | null;
  endOffset?: number | null;
  extra?: { isPrimary?: boolean } | null;
  // 24코드 표준 액션 ID(G1~S14) — 서버가 전송 규칙과 같은 로직으로 주석해 준다(검수용).
  actionCode?: string | null;
};

type ClipDetail = ClipRow & {
  job_id: string;
  match_id: string | null;
  our_side: string;
  team_labels: { home?: string; away?: string };
  video_url?: string;
  actions: ActionRow[];
};

const card: React.CSSProperties = {
  background: 'var(--surface-card, #1b1b1f)',
  border: '1px solid var(--border-ghost, #2c2c32)',
  borderRadius: 'var(--radius-card, 10px)',
  padding: 16,
  marginBottom: 16,
};
const btn: React.CSSProperties = {
  fontSize: 13,
  padding: '8px 16px',
  background: 'var(--button-dark, #2a2a30)',
  border: '1px solid var(--border-ghost, #3a3a42)',
  borderRadius: 8,
  cursor: 'pointer',
  color: 'var(--text, #eee)',
};
const smallBtn: React.CSSProperties = { ...btn, padding: '4px 10px', fontSize: 12 };
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--accent, #3b82f6)', borderColor: 'transparent' };
const numInput: React.CSSProperties = {
  width: 64,
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--border-ghost, #3a3a42)',
  background: 'var(--surface-input, #1b1b1f)',
  color: 'var(--text, #eee)',
  fontSize: 12,
};

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function TeamBadge({ side, labels }: { side?: string | null; labels?: { home?: string; away?: string } }) {
  if (side !== 'home' && side !== 'away') {
    return <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>팀 미지정</span>;
  }
  const label = side === 'home' ? (labels?.home || '홈') : (labels?.away || '어웨이');
  return (
    <span style={{
      fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 6, color: '#fff',
      background: side === 'home' ? 'var(--accent, #3b82f6)' : '#7c3aed',
    }}>
      {side === 'home' ? '홈' : '어웨이'} · {label}
    </span>
  );
}

export default function ClipResultsPage() {
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<MatchRow | null>(null);
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [detail, setDetail] = useState<ClipDetail | null>(null);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadMatches = useCallback(async () => {
    try {
      setMatches(await apiJson<MatchRow[]>('/highlight/clip-results/matches'));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void loadMatches(); }, [loadMatches]);

  const openMatch = async (m: MatchRow) => {
    if (!m.match_id) { setMsg('매치 연결이 없는 잡입니다.'); return; }
    setSelectedMatch(m);
    setDetail(null);
    setMsg('');
    try {
      const res = await apiJson<{ clips: ClipRow[] }>(`/highlight/clip-results/matches/${m.match_id}/clips`);
      setClips(res.clips);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const openClip = useCallback(async (clipId: string) => {
    setMsg('');
    try {
      const d = await apiJson<ClipDetail>(`/highlight/clip-results/clips/${clipId}`);
      setDetail(d);
      setActions(d.actions);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // dual 팝업에서 저장하고 돌아오면(창 포커스) 액션을 다시 읽는다.
  useEffect(() => {
    if (!detail) return;
    const onFocus = () => { void openClip(detail.id); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [detail, openClip]);

  // 분리 창의 FPA dual 에서 "클립에 저장" 시 postMessage 로 알려온다 — 액션 목록 즉시 갱신.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; clipId?: string };
      if (data?.type === 'fpa-clip-saved' && detail && data.clipId === detail.id) {
        void openClip(detail.id);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [detail, openClip]);

  // 대표 액션 지정/해제 — 저장 후 재전송하면 제목·mainAction 이 이 액션 기준이 된다.
  const setPrimaryAction = async (seq: number) => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await apiJson<{ primary_seq: number | null }>(
        `/highlight/clip-results/clips/${detail.id}/primary`,
        { method: 'POST', body: JSON.stringify({ seq }) },
      );
      setActions((prev) => prev.map((a) => ({
        ...a,
        extra: { ...(a.extra || {}), isPrimary: a.seq === res.primary_seq },
      })));
      setMsg(res.primary_seq == null
        ? '대표 지정 해제 — 자동 규칙(골>슈팅>… · 나중 액션 우선)으로 돌아갑니다. 재전송해야 반영됩니다.'
        : `액션 ${res.primary_seq} 를 대표로 지정했습니다. 재전송해야 반영됩니다.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const setOffset = (idx: number, key: 'startOffset' | 'endOffset', value: string) => {
    const num = value === '' ? null : Number(value);
    setActions((prev) => prev.map((a, i) => (i === idx ? { ...a, [key]: Number.isFinite(num as number) ? num : null } : a)));
  };

  const saveOffsets = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await apiJson<{ actions: ActionRow[] }>(
        `/highlight/clip-results/clips/${detail.id}/actions`,
        { method: 'PUT', body: JSON.stringify({ actions }) },
      );
      setActions(res.actions);
      setMsg('액션 저장 완료');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!selectedMatch?.match_id) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await apiJson<{ clips: number }>(
        `/highlight/clip-results/matches/${selectedMatch.match_id}/resend`,
        { method: 'POST' },
      );
      setMsg(`FinePlay 전송 완료 — 클립 ${res.clips}개`);
      await loadMatches();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ width: '100%' }}>
      <HighlightSubTabs />

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>클립 결과</h2>
          {selectedMatch ? (
            <>
              <span style={{ fontSize: 13, color: 'var(--muted, #999)' }}>›</span>
              <button style={smallBtn} onClick={() => { setSelectedMatch(null); setDetail(null); }}>매치 목록</button>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{selectedMatch.name}</span>
              <button style={{ ...primaryBtn, marginLeft: 'auto' }} onClick={resend} disabled={busy}>
                ⬆ FinePlay로 전송
              </button>
            </>
          ) : (
            <button style={{ ...btn, marginLeft: 'auto' }} onClick={() => void loadMatches()}>새로고침</button>
          )}
        </div>
        {msg ? <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '8px 0 0' }}>{msg}</p> : null}
      </div>

      {!selectedMatch ? (
        <div style={card}>
          {matches.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
              추출된 클립이 없습니다. FinePlay 작업 탭에서 클립을 생성하면 여기에 매치별로 쌓입니다.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {matches.map((m) => (
                <div key={m.job_id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                  padding: '8px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
                }}>
                  <span style={{ fontWeight: 600 }}>{m.name}</span>
                  <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>#{m.analysis_request_id}</span>
                  <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>클립 {m.clip_count}개</span>
                  {m.callback_status ? (
                    <span style={{ fontSize: 12, color: m.callback_status === 'sent' ? '#22c55e' : '#f59e0b' }}>
                      콜백 {m.callback_status}
                    </span>
                  ) : null}
                  <button style={{ ...smallBtn, marginLeft: 'auto' }} onClick={() => void openMatch(m)}>열기</button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {selectedMatch && !detail ? (
        <div style={card}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {clips.map((c) => (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                padding: '8px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
              }}>
                <span style={{ color: 'var(--muted, #999)', width: 24 }}>{c.order_index + 1}</span>
                {c.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.thumbnail_url} alt="" style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 4 }} />
                ) : null}
                <TeamBadge side={c.team_side} labels={{ home: selectedMatch.home_team, away: selectedMatch.away_team }} />
                <span>{c.main_action || '클립'}</span>
                <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                  {fmt(c.start_sec)}~{fmt(c.end_sec)}
                </span>
                <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>액션 {c.action_count}개</span>
                <button style={{ ...smallBtn, marginLeft: 'auto' }} onClick={() => void openClip(c.id)}>상세</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {detail ? (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <button style={smallBtn} onClick={() => setDetail(null)}>← 클립 목록</button>
            <span style={{ fontWeight: 600 }}>{detail.id}</span>
            <TeamBadge side={detail.team_side} labels={detail.team_labels} />
            <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
              {fmt(detail.start_sec)}~{fmt(detail.end_sec)} · {Math.round(detail.duration_seconds || 0)}초
            </span>
            <button
              style={{ ...primaryBtn, marginLeft: 'auto' }}
              onClick={() => {
                // OS 별도 창(dual 도구만) — 영상 옆·다른 모니터에 자유롭게 배치해 보면서 찍는다.
                window.open(
                  `/admin/fpa/live?clipId=${detail.id}&embed=1`,
                  `fpa-dual-${detail.id}`,
                  'width=900,height=950,popup=yes',
                );
              }}
            >
              🎯 FPA dual
            </button>
          </div>

          {detail.video_url ? (
            <video
              src={detail.video_url}
              controls
              style={{ width: '100%', maxHeight: 420, background: '#000', borderRadius: 8 }}
            />
          ) : (
            <p style={{ fontSize: 13, color: 'var(--muted, #999)' }}>영상 URL 을 불러올 수 없습니다 (S3 설정 확인).</p>
          )}

          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <h3 style={{ fontSize: 14, margin: 0 }}>액션 ({actions.length})</h3>
              <button style={smallBtn} onClick={() => void openClip(detail.id)}>새로고침</button>
              <button style={{ ...smallBtn, background: 'var(--accent, #3b82f6)', borderColor: 'transparent' }}
                onClick={saveOffsets} disabled={busy || !actions.length}>
                구간 저장
              </button>
              <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                구간은 클립 내 초 (0 ~ {Math.round(detail.duration_seconds || 0)}s). 비우면 균등 분할.
              </span>
            </div>
            {actions.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
                아직 액션이 없습니다. <strong>FPA dual</strong>에서 씬을 찍고 &quot;클립에 저장&quot;을 누르세요.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {actions.map((a, i) => (
                  <div key={`${a.seq}-${i}`} style={{
                    display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                    padding: '6px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
                  }}>
                    <button
                      title="대표 액션 지정 — 클립 제목·mainAction 기준. 다시 누르면 해제(자동 규칙)."
                      style={{
                        ...smallBtn, padding: '2px 6px', fontSize: 14, lineHeight: 1,
                        color: a.extra?.isPrimary ? '#facc15' : 'var(--muted, #666)',
                        background: 'transparent', borderColor: 'transparent',
                      }}
                      disabled={busy}
                      onClick={() => void setPrimaryAction(a.seq)}
                    >
                      {a.extra?.isPrimary ? '★' : '☆'}
                    </button>
                    <span style={{ color: 'var(--muted, #999)', width: 20 }}>{a.seq}</span>
                    {a.actionCode ? (
                      <span style={{
                        fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
                        padding: '1px 6px', borderRadius: 5, width: 34, textAlign: 'center',
                        background: a.actionCode.startsWith('G') ? 'rgba(239,68,68,.18)'
                          : a.actionCode.startsWith('P') ? 'rgba(59,130,246,.18)'
                          : 'rgba(34,197,94,.18)',
                        color: a.actionCode.startsWith('G') ? '#f87171'
                          : a.actionCode.startsWith('P') ? '#60a5fa'
                          : '#4ade80',
                      }}>
                        {a.actionCode}
                      </span>
                    ) : (
                      <span style={{ width: 34 }} />
                    )}
                    <span style={{ width: 72, fontWeight: 600 }}>{a.actionLabel}</span>
                    <TeamBadge side={a.teamSide} labels={detail.team_labels} />
                    <span style={{ width: 110 }}>
                      #{a.jersey || '-'}{a.playerName ? ` ${a.playerName}` : ''}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--muted, #999)', width: 210 }}>
                      {a.xg != null ? `xG ${a.xg} ` : ''}{a.xgot != null ? `xGOT ${a.xgot} ` : ''}
                      {a.epv != null ? `EPV ${a.epv} ` : ''}{a.pc != null ? `PC ${a.pc}` : ''}
                    </span>
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted, #999)' }}>
                      <input type="number" step="0.1" min={0} value={a.startOffset ?? ''} style={numInput}
                        onChange={(e) => setOffset(i, 'startOffset', e.target.value)} />
                      s ~
                      <input type="number" step="0.1" min={0} value={a.endOffset ?? ''} style={numInput}
                        onChange={(e) => setOffset(i, 'endOffset', e.target.value)} />
                      s
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

    </div>
  );
}
