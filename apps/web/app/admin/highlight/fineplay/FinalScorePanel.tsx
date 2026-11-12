'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/error-messages';

/** GET/PUT /highlight/fineplay-jobs/{id}/final-score — 점수는 콘솔 화면과 같이 [홈, 원정]. */
type FinalScoreView = {
  home: number | null;
  away: number | null;
  confirmedAt: string | null;
  confirmedBy: { id?: string | null; name?: string | null } | null;
  suggested: { home: number; away: number } | null;
  ourSide: 'home' | 'away' | null;
  sent: boolean;
  sentSides: string[];
  competitionSent: boolean;
  changed?: boolean;
  resent?: Record<string, string>;
};

const inputStyle: React.CSSProperties = {
  width: 52, padding: '4px 6px', fontSize: 14, fontWeight: 700, textAlign: 'center',
  background: 'var(--surface-input, #16161a)', color: 'inherit',
  border: '1px solid var(--border-ghost, #2c2c32)', borderRadius: 6,
};

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 분석관 "최종 점수" 칸 (FinePlay C-21 ②) — 확정한 점수만 FinePlay 결과에 실린다.
 *
 * 기본값은 확정값 → 지금 열린 태깅의 점수(골 태그로 센 값) → 마지막 클립 점수판 순. 점수판 점수는
 * 클립마다 그 순간 점수라, 클립을 안 만든 골이 맨 뒤에 있으면 경기 최종 점수와 다를 수 있다 —
 * 그래서 자동으로 보내지 않고 분석관이 확정한다. 이미 보낸 결과는 점수를 바꾸면 서버가 다시 보낸다.
 */
export default function FinalScorePanel({
  jobId, standalone, tagScore, labels, buttonStyle,
}: {
  jobId: string;
  standalone: boolean;
  /** 이 잡이 지금 열려 있으면 태그로 센 [홈, 원정]. 아니면 null */
  tagScore: [number, number] | null;
  labels: { home: string; away: string };
  buttonStyle: React.CSSProperties;
}) {
  const [view, setView] = useState<FinalScoreView | null>(null);
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const fill = useCallback((v: FinalScoreView) => {
    setView(v);
    const base: [number, number] | null = v.home !== null && v.away !== null
      ? [v.home, v.away]
      : tagScore ?? (v.suggested ? [v.suggested.home, v.suggested.away] : null);
    setHome(base ? String(base[0]) : '');
    setAway(base ? String(base[1]) : '');
  }, [tagScore]);

  useEffect(() => {
    let alive = true;
    setMsg('');
    setError('');
    apiJson<FinalScoreView>(`/highlight/fineplay-jobs/${jobId}/final-score`)
      .then((v) => { if (alive) fill(v); })
      .catch((err) => { if (alive) setError(errorMessage(err, '최종 점수를 불러오지 못했습니다.')); });
    return () => { alive = false; };
    // tagScore 가 바뀔 때마다 다시 읽지 않는다 — 입력 중인 값을 덮는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const confirmed = view?.home !== null && view?.home !== undefined;
  const dirty = !confirmed || String(view?.home) !== home || String(view?.away) !== away;
  const valid = /^\d{1,2}$/.test(home) && /^\d{1,2}$/.test(away);

  const save = async () => {
    setBusy(true);
    setMsg('');
    setError('');
    try {
      const v = await apiJson<FinalScoreView>(`/highlight/fineplay-jobs/${jobId}/final-score`, {
        method: 'PUT',
        body: JSON.stringify({ home: Number(home), away: Number(away) }),
      });
      fill(v);
      const resent = Object.entries(v.resent || {});
      if (!v.changed) setMsg('같은 점수라 바뀐 것이 없습니다.');
      else if (!resent.length) setMsg('확정했습니다. 다음 전송 때 같이 나갑니다.');
      else setMsg(`확정했습니다 · 다시 보냄: ${resent.map(([k, s]) => `${k === 'request' ? '신청' : k} ${s}`).join(', ')}`);
    } catch (err) {
      setError(errorMessage(err, '최종 점수를 저장하지 못했습니다.', { context: { '작업 ID': jobId } }));
    } finally {
      setBusy(false);
    }
  };

  const tagDiffers = tagScore && confirmed && (tagScore[0] !== view?.home || tagScore[1] !== view?.away);

  return (
    <div style={{
      margin: '4px 0 4px 12px', padding: '8px 12px', borderRadius: 6, fontSize: 13,
      background: 'var(--surface-input, #16161a)', border: '1px dashed var(--border-ghost, #2c2c32)',
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    }}>
      <span style={{ fontWeight: 700 }}>최종 점수</span>
      <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>{labels.home}</span>
      <input aria-label="홈 점수" style={inputStyle} inputMode="numeric" value={home}
        onChange={(e) => setHome(e.target.value.replace(/\D/g, '').slice(0, 2))} />
      <span>:</span>
      <input aria-label="원정 점수" style={inputStyle} inputMode="numeric" value={away}
        onChange={(e) => setAway(e.target.value.replace(/\D/g, '').slice(0, 2))} />
      <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>{labels.away}</span>
      <button style={{ ...buttonStyle, opacity: valid && dirty && !busy ? 1 : 0.45 }}
        disabled={!valid || !dirty || busy} onClick={() => void save()}
        title={view?.sent ? '이미 보낸 결과는 점수만 바꿔 다시 보냅니다' : '확정한 점수가 다음 전송 때 FinePlay 로 나갑니다'}>
        {busy ? '저장 중…' : confirmed ? '고치기' : '확정'}
      </button>
      <span style={{ fontSize: 12, color: confirmed ? '#22c55e' : 'var(--muted, #999)' }}>
        {confirmed
          ? `확정 ${fmtTime(view?.confirmedAt ?? null)}${view?.confirmedBy?.name ? ` · ${view.confirmedBy.name}` : ''}`
          : '확정 전 — 앱에는 신청자가 넣은 점수가 보입니다'}
      </span>
      {!standalone && view?.ourSide ? (
        <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
          · 신청팀 = {view.ourSide === 'home' ? labels.home : labels.away}
        </span>
      ) : null}
      {tagDiffers ? (
        <span style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b' }}
          title="지금 태깅의 골 태그로 센 점수가 확정값과 다릅니다">
          ⚠ 태깅은 {tagScore[0]} : {tagScore[1]}
        </span>
      ) : null}
      {view?.competitionSent ? (
        <span style={{ fontSize: 12, color: '#f59e0b' }}>· 대회 전송은 다시 눌러야 점수가 반영됩니다</span>
      ) : null}
      {msg ? <span style={{ fontSize: 12, color: 'var(--muted, #999)', width: '100%' }}>{msg}</span> : null}
      {error ? <span style={{ fontSize: 12, color: '#ef4444', width: '100%' }}>{error}</span> : null}
    </div>
  );
}
