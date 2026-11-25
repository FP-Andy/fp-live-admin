'use client';

// FinePlay 신청 골라 가져오기 · 매니페스트 다시 받기 전 비교 (2026-11-25, T4)
//
// 예전 [새 작업 가져오기]는 대기열을 받자마자 전부 claim 했다 — FinePlay 에서는 그 순간 '분석 중'이 되고
// 팀에 알림이 간다. 지금 손대지 않을 신청까지 '분석 중'이 됐다. 이제는 claim 없는 미리보기를 먼저 보고
// 고른 것만 가져온다. 안 고른 신청은 FinePlay 에서 '분석 대기' 그대로다.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/error-messages';

type LineupRow = { jerseyNumber?: number | string | null; name?: string | null; positionSlot?: string | null; isSubstitute?: boolean };
type Uniform = { kind?: string | null; primaryArgb?: number | null; secondaryArgb?: number | null; imageUrl?: string | null } | null;

export type QueueRow = {
  analysisRequestId: number;
  state: 'new' | 'imported' | 'taken';
  existing?: { job_id: string; status: string; archived: boolean; name?: string | null } | null;
  claimedBy?: string | null;
  submittedAt?: string | null;
  teamName?: string | null;
  tier?: string | null;
  matchKind?: string | null;
  matchDate?: string | null;
  placeName?: string | null;
  opponentName?: string | null;
  score?: [number | null, number | null];
  uniform?: Uniform;
  opponentUniform?: Uniform;
  formation?: string | null;
  lineup?: LineupRow[];
  opponentFormation?: string | null;
  opponentLineup?: LineupRow[] | null;
  competition?: { name?: string | null; side?: string | null } | null;
  videos: { count: number; totalSeconds: number; sources: string[] };
  fhl?: { clips: number; exportDuration?: number | null; ourSide?: string | null } | null;
};

const box: React.CSSProperties = {
  background: 'var(--surface-card, #1b1b1f)', border: '1px solid var(--border-ghost, #2c2c32)',
  borderRadius: 10, padding: 14, margin: '12px 0',
};
const btn: React.CSSProperties = {
  fontSize: 13, padding: '6px 14px', background: 'var(--button-dark, #2a2a30)',
  border: '1px solid var(--border-ghost, #3a3a42)', borderRadius: 8, cursor: 'pointer', color: 'var(--text, #eee)',
};
const primary: React.CSSProperties = { ...btn, background: 'var(--accent, #3b82f6)', borderColor: 'transparent' };
const muted: React.CSSProperties = { fontSize: 12, color: 'var(--muted, #999)' };
const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', fontSize: 12, color: 'var(--muted, #999)', fontWeight: 500, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '6px 8px', fontSize: 13, verticalAlign: 'top', borderTop: '1px solid var(--border-ghost, #2c2c32)' };

export function fmtLength(sec: number): string {
  if (!sec) return '길이 모름';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

function fmtDate(v?: string | null): string {
  if (!v) return '-';
  const d = v.replace('T', ' ');
  return d.slice(0, 16);
}

function chip(argb?: number | null) {
  if (typeof argb !== 'number') return null;
  const css = `#${(argb >>> 0).toString(16).padStart(8, '0').slice(2)}`;
  return (
    <span title={css} style={{
      display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: css,
      border: '1px solid rgba(255,255,255,0.3)', verticalAlign: 'middle', marginRight: 4,
    }} />
  );
}

const TIER: Record<string, string> = { basic: '하이라이트만', xfp: 'xFP' };

function lineupText(rows?: LineupRow[] | null): string {
  return (rows || [])
    .map((p) => `${p.jerseyNumber ?? '?'} ${p.name || ''}${p.isSubstitute ? '(교체)' : ''}`.trim())
    .join(', ');
}

function StateBadge({ row }: { row: QueueRow }) {
  if (row.state === 'imported') {
    return <span style={muted}>이미 가져옴{row.existing?.archived ? ' · 보관함' : ''}</span>;
  }
  if (row.state === 'taken') {
    return <span style={{ ...muted, color: '#f59e0b' }} title={`잡았던 워커: ${row.claimedBy}`}>다른 워커가 잡았던 건</span>;
  }
  return <span style={{ fontSize: 12, color: '#22c55e' }}>새 신청</span>;
}

export function ImportQueuePanel({ onClose, onImported }: {
  onClose: () => void;
  onImported: (msg: string) => void | Promise<void>;
}) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    setMsg('');
    setRows(null);
    try {
      const res = await apiJson<{ items: QueueRow[]; truncated: boolean }>('/highlight/fineplay-jobs/queue-preview');
      setRows(res.items);
      setTruncated(res.truncated);
      setPicked(new Set());
    } catch (err) {
      setRows([]);
      setMsg(errorMessage(err, 'FinePlay 대기열을 읽지 못했습니다. 다시 시도해 주세요.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const fresh = useMemo(() => (rows || []).filter((r) => r.state === 'new'), [rows]);

  const toggle = (id: number) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const run = async (all: boolean) => {
    const count = all ? fresh.length : picked.size;
    if (!count) return;
    if (!window.confirm(`${count}건을 가져올까요?\n\n가져오면 FinePlay 에서 '분석 중'으로 바뀌고 팀에 알림이 갑니다.`)) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await apiJson<{ claimed: string[]; skipped: { analysisRequestId: string | number; reason: string }[]; fhl_queued?: string[] }>(
        '/highlight/fineplay-jobs/import',
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(all ? { all: true } : { ids: Array.from(picked) }) },
      );
      const parts = [`${res.claimed.length}건 가져옴`];
      if (res.fhl_queued?.length) parts.push(`FHL 구간으로 클립 만드는 중 ${res.fhl_queued.length}건`);
      if (res.skipped.length) parts.push(`건너뜀 ${res.skipped.length}건`);
      const detail = res.skipped.map((s) => `#${s.analysisRequestId} ${s.reason}`).join('\n');
      const text = parts.join(' · ') + (detail ? `\n${detail}` : '');
      setMsg(text);
      await onImported(text);
      await load();
    } catch (err) {
      setMsg(errorMessage(err, '신청을 가져오지 못했습니다. 다시 시도해 주세요.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>FinePlay 대기열</strong>
        <span style={muted}>
          {rows === null ? '읽는 중…' : `${rows.length}건 · 새 신청 ${fresh.length}건`}
          {' '}— 고른 것만 가져옵니다. 안 고른 신청은 FinePlay 에서 그대로 기다립니다.
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button style={primary} disabled={busy || picked.size === 0} onClick={() => void run(false)}>
            고른 {picked.size}건 가져오기
          </button>
          <button style={btn} disabled={busy || fresh.length === 0} onClick={() => void run(true)}>
            모두 가져오기 ({fresh.length})
          </button>
          <button style={btn} disabled={busy} onClick={() => void load()}>새로고침</button>
          <button style={btn} disabled={busy} onClick={onClose}>닫기</button>
        </span>
      </div>
      {truncated ? <div style={{ ...muted, color: '#f59e0b', marginTop: 6 }}>대기열이 너무 길어 앞쪽 500건만 보입니다.</div> : null}
      {msg ? <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '8px 0 0' }}>{msg}</pre> : null}
      {rows && rows.length === 0 && !msg ? <div style={{ ...muted, marginTop: 8 }}>대기열이 비어 있습니다.</div> : null}
      {rows && rows.length > 0 ? (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>
                  <input type="checkbox" aria-label="새 신청 모두 고르기" disabled={busy || fresh.length === 0}
                         checked={fresh.length > 0 && fresh.every((r) => picked.has(r.analysisRequestId))}
                         onChange={(e) => setPicked(e.target.checked ? new Set(fresh.map((r) => r.analysisRequestId)) : new Set())} />
                </th>
                <th style={th}>신청</th><th style={th}>팀 · 종류</th><th style={th}>경기</th>
                <th style={th}>상대 · 스코어</th><th style={th}>유니폼</th><th style={th}>라인업</th>
                <th style={th}>영상</th><th style={th}>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const selectable = r.state === 'new';
                const [our, opp] = r.score || [null, null];
                return (
                  <tr key={r.analysisRequestId} style={{ opacity: selectable ? 1 : 0.55 }}>
                    <td style={td}>
                      <input type="checkbox" aria-label={`신청 ${r.analysisRequestId} 고르기`}
                             disabled={!selectable || busy} checked={picked.has(r.analysisRequestId)}
                             onChange={() => toggle(r.analysisRequestId)} />
                    </td>
                    <td style={td}>#{r.analysisRequestId}<div style={muted}>{fmtDate(r.submittedAt)} 신청</div></td>
                    <td style={td}>
                      {r.teamName || '-'}
                      <div style={muted}>
                        {TIER[String(r.tier)] || r.tier || '-'}{r.matchKind === 'SCRIMMAGE' ? ' · 자체전' : ''}
                      </div>
                    </td>
                    <td style={td}>
                      {fmtDate(r.matchDate)}
                      <div style={muted}>{r.placeName || '장소 없음'}</div>
                      {r.competition?.name ? <div style={muted}>🏆 {r.competition.name}</div> : null}
                    </td>
                    <td style={td}>
                      {r.opponentName || '-'}
                      <div style={muted}>{our ?? '-'} : {opp ?? '-'}</div>
                    </td>
                    <td style={td}>{chip(r.uniform?.primaryArgb)}{chip(r.uniform?.secondaryArgb)}
                      {r.opponentUniform ? <> vs {chip(r.opponentUniform?.primaryArgb)}</> : null}</td>
                    <td style={td}>
                      <button style={{ ...btn, padding: '2px 8px', fontSize: 12 }}
                              onClick={() => setOpen(open === r.analysisRequestId ? null : r.analysisRequestId)}>
                        {r.formation || '포메이션 없음'} · {(r.lineup || []).length}명
                      </button>
                      {open === r.analysisRequestId ? (
                        <div style={{ ...muted, marginTop: 4, maxWidth: 320 }}>
                          {lineupText(r.lineup) || '라인업 없음'}
                          {r.opponentLineup?.length ? <div style={{ marginTop: 4 }}>B팀 {r.opponentFormation || ''}: {lineupText(r.opponentLineup)}</div> : null}
                        </div>
                      ) : null}
                    </td>
                    <td style={td}>
                      영상 {r.videos.count}개 · {fmtLength(r.videos.totalSeconds)}
                      <div style={muted}>{r.videos.sources.map((s) => (s === 'YOUTUBE' ? '유튜브' : '업로드')).join('·')}</div>
                      {r.fhl ? <div style={{ fontSize: 12, color: '#22c55e' }}>FHL 클립 {r.fhl.clips}개 — 가져오면 바로 만듦</div> : null}
                    </td>
                    <td style={td}><StateBadge row={r} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

type LineupDiff = {
  added: LineupRow[];
  removed: (LineupRow & { manualAdded?: boolean })[];
  changed: { jerseyNumber?: number | string; name?: string; fields: Record<string, [unknown, unknown]> }[];
  same: number;
};

type RefreshPreview = {
  fields: { label: string; before: unknown; after: unknown }[];
  lineup: LineupDiff;
  opponentLineup?: LineupDiff;
  videos: { changed: boolean; before: { videoId: string; source: string; fhlClips: number }[]; after: { videoId: string; source: string; fhlClips: number }[] };
  keepManual: LineupRow[];
  missingVideos: string[];
  clipsKept: number;
  fhlAfter: boolean;
};

const FIELD_LABEL: Record<string, string> = { name: '이름', positionSlot: '자리', isSubstitute: '교체' };

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '없음';
  if (Array.isArray(v)) return v.map((x) => (x ?? '-')).join(' : ');
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  return String(v);
}

function LineupDiffView({ title, diff }: { title: string; diff: LineupDiff }) {
  const nothing = !diff.added.length && !diff.removed.length && !diff.changed.length;
  return (
    <div style={{ marginTop: 8 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <span style={muted}> · 그대로 {diff.same}명</span>
      {nothing ? <div style={muted}>바뀌는 선수가 없습니다.</div> : null}
      {diff.added.map((p) => (
        <div key={`a${p.jerseyNumber}`} style={{ fontSize: 13, color: '#22c55e' }}>+ {p.jerseyNumber} {p.name}{p.isSubstitute ? ' (교체)' : ''}</div>
      ))}
      {diff.removed.map((p) => (
        <div key={`r${p.jerseyNumber}`} style={{ fontSize: 13, color: '#ef4444' }}>
          − {p.jerseyNumber} {p.name}{p.manualAdded ? ' (FPC 에서 직접 넣은 선수)' : ''}
        </div>
      ))}
      {diff.changed.map((p) => (
        <div key={`c${p.jerseyNumber}`} style={{ fontSize: 13, color: '#f59e0b' }}>
          ~ {p.jerseyNumber} {p.name}: {Object.entries(p.fields).map(([k, [a, b]]) => `${FIELD_LABEL[k] || k} ${show(a)} → ${show(b)}`).join(', ')}
        </div>
      ))}
    </div>
  );
}

/** [원본 교체 반영](매니페스트 다시 받기) 전에 바뀌는 것을 보여 주고, 확인하면 적용한다. */
export function ManifestRefreshDialog({ jobId, onClose, onApplied }: {
  jobId: string;
  onClose: () => void;
  onApplied: (msg: string) => void | Promise<void>;
}) {
  const [data, setData] = useState<RefreshPreview | null>(null);
  const [err, setErr] = useState('');
  const [keepManual, setKeepManual] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    apiJson<RefreshPreview>(`/highlight/fineplay-jobs/${jobId}/refresh-manifest/preview`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(errorMessage(e, '새 정보를 받아 오지 못했습니다. 다시 시도해 주세요.')); });
    return () => { alive = false; };
  }, [jobId]);

  const apply = async () => {
    const force = !!data?.missingVideos.length;
    if (force && !window.confirm(`태깅이 가리키는 영상(${data?.missingVideos.join(', ')})이 새 정보에 없습니다.\n그대로 바꾸면 그 태깅으로는 클립을 만들 수 없습니다. 계속할까요?`)) return;
    setBusy(true);
    try {
      const qs = new URLSearchParams({ keep_manual: String(keepManual), ...(force ? { force: 'true' } : {}) });
      const res = await apiJson<{ clipsKept?: number; keptManual?: LineupRow[]; fhlQueued?: boolean }>(
        `/highlight/fineplay-jobs/${jobId}/refresh-manifest?${qs}`, { method: 'POST' });
      const parts = [`원본 교체 반영 완료 · 태깅 ${res.clipsKept ?? 0}건 보존`];
      if (res.keptManual?.length) parts.push(`직접 넣은 선수 ${res.keptManual.length}명 남김`);
      if (res.fhlQueued) parts.push('FHL 구간으로 클립 만드는 중');
      await onApplied(parts.join(' · '));
      onClose();
    } catch (e) {
      setErr(errorMessage(e, '원본 교체를 반영하지 못했습니다. 다시 시도해 주세요.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-label="원본 교체 반영 전 비교" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ ...box, width: 'min(640px, 92vw)', maxHeight: '86vh', overflowY: 'auto' }}>
        <strong>원본 교체 반영 — 바뀌는 것</strong>
        <div style={muted}>FinePlay 의 최신 신청 정보로 바꿉니다. 태깅(클립)은 그대로이고 신청자에게 알림은 가지 않습니다.</div>
        {err ? <div style={{ color: '#ef4444', fontSize: 13, marginTop: 8 }}>{err}</div> : null}
        {!data && !err ? <div style={{ ...muted, marginTop: 8 }}>새 정보를 받는 중…</div> : null}
        {data ? (
          <>
            <div style={{ marginTop: 8 }}>
              {data.fields.length === 0 ? <div style={muted}>경기 정보는 그대로입니다.</div> : data.fields.map((f) => (
                <div key={f.label} style={{ fontSize: 13 }}>{f.label}: {show(f.before)} → <strong>{show(f.after)}</strong></div>
              ))}
              {data.videos.changed ? (
                <div style={{ fontSize: 13 }}>
                  영상: {data.videos.before.length}개 → {data.videos.after.length}개
                  {data.videos.after.some((v) => v.fhlClips) ? ` (FHL 클립 ${data.videos.after.reduce((a, v) => a + v.fhlClips, 0)}개)` : ''}
                </div>
              ) : null}
            </div>
            <LineupDiffView title="라인업" diff={data.lineup} />
            {data.opponentLineup ? <LineupDiffView title="B팀 라인업" diff={data.opponentLineup} /> : null}
            {data.keepManual.length ? (
              <label style={{ display: 'block', fontSize: 13, marginTop: 10 }}>
                <input type="checkbox" checked={keepManual} onChange={(e) => setKeepManual(e.target.checked)} />{' '}
                FPC 에서 직접 넣은 선수 {data.keepManual.length}명은 남기기 ({lineupText(data.keepManual)})
              </label>
            ) : null}
            {data.missingVideos.length ? (
              <div style={{ fontSize: 13, color: '#ef4444', marginTop: 8 }}>
                태깅이 가리키는 영상이 새 정보에 없습니다: {data.missingVideos.join(', ')}
              </div>
            ) : null}
            {data.fhlAfter && !data.clipsKept ? (
              <div style={{ fontSize: 13, color: '#22c55e', marginTop: 8 }}>FHL 기록이 있어 반영하면 그 구간으로 클립을 바로 만듭니다.</div>
            ) : null}
          </>
        ) : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button style={btn} disabled={busy} onClick={onClose}>취소</button>
          <button style={primary} disabled={busy || !data} onClick={() => void apply()}>{busy ? '반영 중…' : '반영하기'}</button>
        </div>
      </div>
    </div>
  );
}
