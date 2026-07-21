'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import HighlightSubTabs from '../HighlightSubTabs';
import { apiJson } from '../../../../lib/api';
import { ProgressBar, LeaveBadge } from '../../../../components/HlProgress';

// 편집룸: 다 만들어 S3(highlights/)에 올라간 완성본 클립을 꺼내와 2차 검수하고,
// 필요하면 구간을 고쳐 다시 만든다. 같은 clipId 로 재렌더하므로 S3 파일과
// FinePlay 콜백 모두 덮어쓰기(멱등)로 처리돼 중복이 생기지 않는다.

type FpJob = {
  id: string;
  status: string;
  original_filename: string;
  error_message?: string | null;
  created_at: string;
  job_metadata?: {
    display_name?: string | null;
    analysis_request_id?: number | string;
    result_payload?: { clips?: unknown[] } | null;
    callback_status?: string;
    progress?: { detail?: string } | null;
  } | null;
};

type OutputClip = {
  clipId: string;
  start: number;
  end: number;
  mainAction?: string | null;
  durationSeconds?: number | null;
  url?: string;
  verticalUrl?: string;
  thumbnailUrl?: string;
};

// 편집 상태: 완성본에서 불러온 값 + 수정 가능한 구간
type EditClip = OutputClip & { editStart: number; editEnd: number; makeVertical: boolean };

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
  width: 76,
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--border-ghost, #3a3a42)',
  background: 'var(--surface-input, #1b1b1f)',
  color: 'var(--text, #eee)',
  fontSize: 13,
};

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function EditRoomPage() {
  const [jobs, setJobs] = useState<FpJob[]>([]);
  const [listError, setListError] = useState('');

  const [selected, setSelected] = useState<FpJob | null>(null);
  const [clips, setClips] = useState<EditClip[]>([]);
  const [callbackStatus, setCallbackStatus] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loadingClips, setLoadingClips] = useState(false);

  const [sourceUrl, setSourceUrl] = useState('');
  const [playingClip, setPlayingClip] = useState<{ id: string; vertical: boolean } | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveError, setSaveError] = useState('');
  const [resending, setResending] = useState(false);

  const sourceRef = useRef<HTMLVideoElement | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const rows = await apiJson<FpJob[]>('/highlight/jobs?mode=fineplay&limit=100');
      // 완성본이 있는 작업만 편집 대상이다.
      setJobs(rows.filter((j) => (j.job_metadata?.result_payload?.clips?.length ?? 0) > 0));
      setListError('');
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const loadOutputs = useCallback(async (jobId: string) => {
    setLoadingClips(true);
    setLoadError('');
    try {
      const res = await apiJson<{ clips: OutputClip[]; callbackStatus?: string }>(
        `/highlight/fineplay-jobs/${jobId}/outputs`,
      );
      setClips(res.clips.map((c) => ({
        ...c,
        editStart: c.start,
        editEnd: c.end,
        makeVertical: Boolean(c.verticalUrl),
      })));
      setCallbackStatus(res.callbackStatus || '');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingClips(false);
    }
  }, []);

  const selectJob = async (job: FpJob) => {
    setSelected(job);
    setClips([]);
    setSourceUrl('');
    setPlayingClip(null);
    setSaveMsg('');
    setSaveError('');
    await loadOutputs(job.id);
    // 원본은 구간 재조정 참고용 — 실패해도 편집룸 자체는 동작한다.
    try {
      const res = await apiJson<{ url: string }>(`/highlight/fineplay-jobs/${job.id}/source-url`);
      setSourceUrl(res.url);
    } catch {
      setSourceUrl('');
    }
  };

  const updateClip = (clipId: string, patch: Partial<EditClip>) => {
    setClips((prev) => prev.map((c) => (c.clipId === clipId ? { ...c, ...patch } : c)));
  };

  const seekSource = (t: number) => {
    const v = sourceRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, t);
    void v.play();
  };

  const dirty = clips.some((c) => c.editStart !== c.start || c.editEnd !== c.end);

  const save = async () => {
    if (!selected || !clips.length || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const body = {
        clips: clips.map((c) => ({
          clipId: c.clipId,
          start: c.editStart,
          end: c.editEnd,
          mainAction: c.mainAction,
          makeVertical: c.makeVertical,
        })),
      };
      await apiJson(`/highlight/fineplay-jobs/${selected.id}/produce`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setSaveMsg('서버에서 다시 만드는 중...');

      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const job = await apiJson<FpJob>(`/highlight/jobs/${selected.id}`);
        if (job.status === 'done') {
          setSaveMsg('수정 반영 완료 — 새 완성본을 불러옵니다.');
          break;
        }
        if (job.status === 'error') throw new Error(job.error_message || '재생성 실패');
        setSaveMsg(job.job_metadata?.progress?.detail || '처리 중...');
      }
      await loadOutputs(selected.id);
      await loadJobs();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaveMsg('');
    } finally {
      setSaving(false);
    }
  };

  const resendCallback = async () => {
    if (!selected || resending) return;
    setResending(true);
    try {
      await apiJson(`/highlight/fineplay-jobs/${selected.id}/resend-callback`, { method: 'POST' });
      setCallbackStatus('sent');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setResending(false);
    }
  };

  return (
    <div style={{ width: '100%' }}>
      <HighlightSubTabs />

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>편집룸</h2>
          <button style={{ ...btn, marginLeft: 'auto' }} onClick={() => void loadJobs()}>새로고침</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
          완성된 클립을 S3에서 꺼내와 2차 검수·편집합니다. 구간을 고쳐 다시 만들면
          같은 클립 ID로 덮어써 FinePlay 쪽에도 중복 없이 반영됩니다.
        </p>
        {listError ? <p style={{ fontSize: 12, color: '#ef4444', margin: '6px 0 0' }}>{listError}</p> : null}
      </div>

      {jobs.length === 0 ? (
        <div style={card}>
          <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
            완성본이 있는 작업이 없습니다. <strong>FinePlay 작업</strong> 탭에서 먼저 클립을 만드세요.
          </p>
        </div>
      ) : (
        <div style={card}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {jobs.map((job) => {
              const meta = job.job_metadata || {};
              const active = selected?.id === job.id;
              return (
                <div
                  key={job.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                    padding: '8px 10px', borderRadius: 6,
                    background: active ? 'var(--button-dark, #2a2a30)' : 'var(--surface-input, #16161a)',
                    border: active ? '1px solid var(--accent, #3b82f6)' : '1px solid transparent',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{meta.display_name || job.original_filename}</span>
                  <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>#{meta.analysis_request_id}</span>
                  <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                    클립 {meta.result_payload?.clips?.length ?? 0}개
                  </span>
                  {meta.callback_status ? (
                    <span style={{ fontSize: 12, color: meta.callback_status === 'sent' ? '#22c55e' : 'var(--muted, #999)' }}>
                      콜백 {meta.callback_status}
                    </span>
                  ) : null}
                  <button style={{ ...smallBtn, marginLeft: 'auto' }} onClick={() => void selectJob(job)}>
                    {active ? '선택됨' : '열기'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selected ? (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: 15, margin: 0 }}>
              완성본 — {selected.job_metadata?.display_name || selected.original_filename}
            </h3>
            <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
              콜백: {callbackStatus || '-'}
            </span>
            <button style={{ ...smallBtn, marginLeft: 'auto' }} onClick={resendCallback} disabled={resending}>
              {resending ? '전송 중...' : '콜백 재전송'}
            </button>
          </div>

          {sourceUrl ? (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ fontSize: 13, color: 'var(--muted, #999)', cursor: 'pointer' }}>
                원본 영상 (구간 재조정 참고용)
              </summary>
              <video
                ref={sourceRef}
                src={sourceUrl}
                controls
                style={{ width: '100%', maxHeight: 360, background: '#000', borderRadius: 8, marginTop: 8 }}
              />
            </details>
          ) : null}

          {loadError ? (
            <p style={{ fontSize: 13, color: '#ef4444' }}>완성본 불러오기 실패: {loadError}</p>
          ) : loadingClips ? (
            <p style={{ fontSize: 13, color: 'var(--muted, #999)' }}>완성본 불러오는 중...</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {clips.map((clip) => {
                const playing = playingClip?.id === clip.clipId;
                const edited = clip.editStart !== clip.start || clip.editEnd !== clip.end;
                return (
                  <div
                    key={clip.clipId}
                    style={{
                      padding: 10, borderRadius: 8, background: 'var(--surface-input, #16161a)',
                      border: edited ? '1px solid var(--accent, #3b82f6)' : '1px solid transparent',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      {clip.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={clip.thumbnailUrl}
                          alt={clip.clipId}
                          style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 6 }}
                        />
                      ) : null}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{clip.clipId}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                          {fmt(clip.start)} ~ {fmt(clip.end)}
                          {clip.durationSeconds ? ` · ${clip.durationSeconds.toFixed(1)}초` : ''}
                          {clip.mainAction ? ` · ${clip.mainAction}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
                        {sourceUrl ? (
                          <button style={smallBtn} onClick={() => seekSource(clip.editStart)}>원본에서 보기</button>
                        ) : null}
                        {clip.url ? (
                          <button
                            style={smallBtn}
                            onClick={() => setPlayingClip(playing && !playingClip?.vertical ? null : { id: clip.clipId, vertical: false })}
                          >
                            {playing && !playingClip?.vertical ? '닫기' : '▶ 재생'}
                          </button>
                        ) : null}
                        {clip.verticalUrl ? (
                          <button
                            style={smallBtn}
                            onClick={() => setPlayingClip(playing && playingClip?.vertical ? null : { id: clip.clipId, vertical: true })}
                          >
                            {playing && playingClip?.vertical ? '닫기' : '▶ 세로'}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                      <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        시작
                        <input
                          type="number" step={0.1} min={0} value={clip.editStart} style={numInput}
                          onChange={(e) => updateClip(clip.clipId, { editStart: Number(e.target.value) || 0 })}
                          disabled={saving}
                        />
                      </label>
                      <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        끝
                        <input
                          type="number" step={0.1} min={0} value={clip.editEnd} style={numInput}
                          onChange={(e) => updateClip(clip.clipId, { editEnd: Number(e.target.value) || 0 })}
                          disabled={saving}
                        />
                      </label>
                      <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="checkbox" checked={clip.makeVertical}
                          onChange={(e) => updateClip(clip.clipId, { makeVertical: e.target.checked })}
                          disabled={saving}
                        />
                        세로(9:16)
                      </label>
                      {edited ? (
                        <span style={{ fontSize: 12, color: 'var(--accent, #3b82f6)' }}>수정됨 — 반영 필요</span>
                      ) : null}
                    </div>

                    {playing ? (
                      <video
                        key={`${clip.clipId}-${playingClip?.vertical}`}
                        src={playingClip?.vertical ? clip.verticalUrl : clip.url}
                        controls
                        autoPlay
                        style={{
                          width: playingClip?.vertical ? 270 : '100%',
                          maxHeight: 480, background: '#000', borderRadius: 8, marginTop: 10,
                        }}
                      />
                    ) : null}
                  </div>
                );
              })}

              <div style={{ marginTop: 6, paddingTop: 14, borderTop: '1px solid var(--border-ghost, #2c2c32)' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button style={primaryBtn} onClick={save} disabled={saving || !clips.length}>
                    {saving ? '처리 중...' : dirty ? '⬆ 수정 반영 — 다시 만들어 업로드' : '⬆ 전체 다시 만들어 업로드'}
                  </button>
                  {saveMsg ? (
                    <span style={{ fontSize: 13, color: saving ? 'var(--muted, #999)' : '#22c55e' }}>{saveMsg}</span>
                  ) : null}
                </div>
                {saving ? (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>서버에서 재렌더 · 재업로드 중</span>
                      <LeaveBadge canLeave />
                    </div>
                    <ProgressBar indeterminate color="#22c55e" />
                  </div>
                ) : null}
                {saveError ? (
                  <div style={{
                    marginTop: 12, padding: 12, borderRadius: 8, fontSize: 13,
                    background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
                  }}>
                    실패: {saveError}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
