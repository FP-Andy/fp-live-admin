'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import HighlightSubTabs from '../HighlightSubTabs';
import { apiJson } from '../../../../lib/api';

// 아카이브: 클립 결과 작업이 끝난 매치들의 보관함 (사전·일반 모두).
// '열어서 수정'으로 클립 결과에 들어가 FPA·구간·대표액션을 계속 고칠 수 있고,
// 사전 매치는 런칭 후 신청 연결·전송이 이 룸에서 진행될 예정이다.

type ArchiveRow = {
  job_id: string;
  match_id: string | null;
  name: string;
  status: string;
  standalone: boolean;
  analysis_request_id?: number | string | null;
  clip_count: number;
  clips_with_actions: number;
  action_count: number;
  scene_count: number;
  source_deleted: boolean;
  callback_status?: string | null;
  created_at?: string | null;
};

type ArchiveFilter = 'all' | 'pre' | 'normal';

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

const FILTERS: { key: ArchiveFilter; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'pre', label: '사전' },
  { key: 'normal', label: '일반' },
];

export default function ClipArchivePage() {
  const router = useRouter();
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [filter, setFilter] = useState<ArchiveFilter>('all');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ jobs: ArchiveRow[] }>('/highlight/archive-jobs');
      setRows(res.jobs);
      setMsg('');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const unarchive = async (row: ArchiveRow) => {
    try {
      await apiJson(`/highlight/fineplay-jobs/${row.job_id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived: false }),
      });
      setMsg(`아카이브 해제 — ${row.name}. FinePlay 작업·클립 결과 목록으로 돌아갔습니다.`);
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const visible = rows.filter((row) => (
    filter === 'all' || (filter === 'pre' ? row.standalone : !row.standalone)
  ));

  return (
    <div style={{ width: '100%' }}>
      <HighlightSubTabs />

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>아카이브</h2>
          <span style={{ display: 'inline-flex', gap: 4 }}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                style={{
                  ...smallBtn,
                  background: filter === f.key ? 'var(--accent, #3b82f6)' : 'var(--button-dark, #2a2a30)',
                  borderColor: filter === f.key ? 'transparent' : 'var(--border-ghost, #3a3a42)',
                }}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </span>
          <button style={{ ...btn, marginLeft: 'auto' }} onClick={() => void load()}>새로고침</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: '6px 0 0' }}>
          클립 결과 작업이 끝난 매치 보관함 — FinePlay 작업·클립 결과 목록에서는 빠지고 여기로 모입니다.
          데이터는 그대로라 열어서 언제든 수정할 수 있고, 해제하면 양쪽 목록으로 되돌아갑니다.
          사전 매치는 런칭 후 신청 연결·전송이 여기서 진행됩니다.
        </p>
        {msg ? <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '8px 0 0' }}>{msg}</p> : null}
      </div>

      <div style={card}>
        {visible.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
            {rows.length === 0
              ? '아카이브된 작업이 없습니다. FinePlay 작업 탭에서 완료된 작업의 📦 아카이브 버튼으로 보관하세요.'
              : '필터에 해당하는 작업이 없습니다.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {visible.map((row) => (
              <div key={row.job_id} style={{
                display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexWrap: 'wrap',
                padding: '8px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
              }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 5,
                  background: row.standalone ? 'rgba(245,158,11,.18)' : 'rgba(59,130,246,.18)',
                  color: row.standalone ? '#f59e0b' : '#60a5fa',
                }}>
                  {row.standalone ? '사전' : '일반'}
                </span>
                <span style={{ fontWeight: 600 }}>{row.name}</span>
                {!row.standalone && row.analysis_request_id != null ? (
                  <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>#{row.analysis_request_id}</span>
                ) : null}
                <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                  클립 {row.clip_count}개 · FPA {row.clips_with_actions}/{row.clip_count}클립
                  · 장면 {row.scene_count}개 · 액션 {row.action_count}개
                </span>
                {row.standalone ? (
                  <span style={{ fontSize: 12, color: row.source_deleted ? 'var(--muted, #777)' : '#f59e0b' }}>
                    {row.source_deleted ? '원본 삭제됨' : '원본 보유 중'}
                  </span>
                ) : null}
                {row.callback_status ? (
                  <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>콜백 {row.callback_status}</span>
                ) : null}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                  <button
                    style={{ ...smallBtn, background: 'var(--accent, #3b82f6)', borderColor: 'transparent' }}
                    disabled={!row.match_id}
                    title="클립 결과에서 열기 — FPA·구간·대표액션 수정 가능"
                    onClick={() => row.match_id && router.push(`/admin/highlight/clips?matchId=${row.match_id}`)}
                  >
                    열어서 수정
                  </button>
                  <button style={smallBtn} onClick={() => void unarchive(row)}>아카이브 해제</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
