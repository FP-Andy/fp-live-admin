'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE, apiJson } from '../../../../lib/api';

type HighlightJob = {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  original_filename: string;
  display_name?: string | null;
  export_path?: string | null;
  job_metadata: { clips?: string[] };
  created_at: string;
};

export default function HighlightFilesPage() {
  const [jobs, setJobs] = useState<HighlightJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<HighlightJob | null>(null);
  const [expandedClips, setExpandedClips] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const loadJobs = useCallback(async () => {
    try {
      const data = await apiJson<HighlightJob[]>('/highlight/jobs?limit=50');
      setJobs(data);
      if (selectedJob) {
        const updated = data.find((j) => j.id === selectedJob.id);
        if (updated) setSelectedJob(updated);
      }
    } catch { /* ignore */ }
  }, [selectedJob]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  const selectJob = (job: HighlightJob) => {
    setSelectedJob(job);
    setExpandedClips(false);
    setStatusMsg('');
    setRenaming(false);
    setRenameValue(job.display_name || '');
  };

  const handleRename = async () => {
    if (!selectedJob) return;
    try {
      await apiJson(`/highlight/jobs/${selectedJob.id}/display-name`, {
        method: 'PATCH',
        body: JSON.stringify({ display_name: renameValue }),
      });
      setRenaming(false);
      setStatusMsg('이름 변경됨');
      await loadJobs();
    } catch (err) { setStatusMsg(`오류: ${err}`); }
  };

  const handleDeleteClip = async (clipName: string) => {
    if (!selectedJob) return;
    if (!window.confirm(`"${clipName}" 클립을 삭제할까요?`)) return;
    try {
      await apiJson(`/highlight/jobs/${selectedJob.id}/clips/${encodeURIComponent(clipName)}`, { method: 'DELETE' });
      setStatusMsg(`${clipName} 삭제됨`);
      await loadJobs();
    } catch (err) { setStatusMsg(`오류: ${err}`); }
  };

  const handleDeleteExport = async () => {
    if (!selectedJob) return;
    if (!window.confirm('합쳐진 영상을 삭제할까요?')) return;
    try {
      await apiJson(`/highlight/jobs/${selectedJob.id}/export`, { method: 'DELETE' });
      setStatusMsg('합쳐진 영상 삭제됨');
      await loadJobs();
    } catch (err) { setStatusMsg(`오류: ${err}`); }
  };

  const handleDeleteJob = async () => {
    if (!selectedJob) return;
    if (!window.confirm(`"${selectedJob.original_filename}" 작업과 모든 파일을 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      await apiJson(`/highlight/jobs/${selectedJob.id}`, { method: 'DELETE' });
      setSelectedJob(null);
      setStatusMsg('');
      await loadJobs();
    } catch (err) { setStatusMsg(`오류: ${err}`); }
  };

  const clips = selectedJob?.job_metadata?.clips || [];
  const hasExport = !!selectedJob?.export_path;

  const fmtDate = (s: string) => new Date(s).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>

      {/* ── Left: job folder list ── */}
      <div style={{ flex: '0 0 240px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 14, border: '1px solid var(--border-ghost)' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 12 }}>JOB 폴더</div>
          {jobs.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>없음</div>}
          {jobs.map((job) => {
            const clipCount = job.job_metadata?.clips?.length ?? 0;
            const isSelected = selectedJob?.id === job.id;
            return (
              <div
                key={job.id}
                onClick={() => selectJob(job)}
                style={{
                  padding: '10px 12px', marginBottom: 6, borderRadius: 'var(--radius-control)',
                  cursor: 'pointer', border: isSelected ? '1px solid var(--border-emphasis)' : '1px solid transparent',
                  background: isSelected ? 'var(--accent-soft)' : 'var(--button-dark)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 13 }}>📁</span>
                  <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {(() => { const n = job.display_name || job.original_filename; return n.length > 22 ? n.slice(0, 20) + '…' : n; })()}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{
                    padding: '1px 5px', borderRadius: 999, fontWeight: 700,
                    background: job.status === 'done' ? 'var(--success-soft)' : job.status === 'error' ? 'var(--danger-soft)' : 'var(--accent-soft)',
                    color: job.status === 'done' ? 'var(--success)' : job.status === 'error' ? 'var(--danger)' : 'var(--accent)',
                  }}>
                    {job.status.toUpperCase()}
                  </span>
                  {job.status === 'done' && <span>{clipCount}개 클립</span>}
                  {job.export_path && <span style={{ color: 'var(--success)' }}>· 영상 있음</span>}
                </div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{fmtDate(job.created_at)}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Right: file contents ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>

        {!selectedJob && (
          <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 48, textAlign: 'center', border: '1px solid var(--border-ghost)' }}>
            <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.4 }}>📁</div>
            <div style={{ color: 'var(--muted)', fontSize: 14 }}>왼쪽에서 작업 폴더를 선택하세요</div>
          </div>
        )}

        {selectedJob && (
          <>
            {/* header */}
            <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: '14px 20px', border: '1px solid var(--border-ghost)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {renaming ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      autoFocus
                      type="text" value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(false); }}
                      placeholder={selectedJob.original_filename}
                      style={{ fontSize: 14, fontWeight: 700, flex: 1, minWidth: 0 }}
                    />
                    <button onClick={handleRename} style={{ fontSize: 12, padding: '5px 12px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>저장</button>
                    <button onClick={() => setRenaming(false)} style={{ fontSize: 12, padding: '5px 12px', background: 'var(--button-dark)', color: 'var(--muted)', border: '1px solid var(--border-ghost)', borderRadius: 6, cursor: 'pointer' }}>취소</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>
                      {selectedJob.display_name || selectedJob.original_filename}
                    </div>
                    <button onClick={() => { setRenaming(true); setRenameValue(selectedJob.display_name || ''); }}
                      style={{ fontSize: 11, padding: '2px 8px', background: 'var(--button-dark)', border: '1px solid var(--border-ghost)', borderRadius: 4, cursor: 'pointer', color: 'var(--muted)' }}>
                      이름 변경
                    </button>
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  {selectedJob.original_filename} · {fmtDate(selectedJob.created_at)} · {clips.length}개 클립{hasExport ? ' · 합쳐진 영상 있음' : ''}
                </div>
              </div>
              {statusMsg && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{statusMsg}</span>}
              <button
                onClick={handleDeleteJob}
                style={{ fontSize: 12, padding: '7px 16px', background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-control)', cursor: 'pointer', fontWeight: 600 }}
              >
                폴더 전체 삭제
              </button>
            </div>

            {/* merged export */}
            <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 16, border: '1px solid var(--border-ghost)' }}>
              <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 12 }}>합쳐진 영상</div>
              {!hasExport ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>없음 — Editor에서 합치기 후 생성됩니다.</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <video
                    src={`${API_BASE}/highlight/jobs/${selectedJob.id}/export/download`}
                    controls preload="metadata"
                    style={{ flex: 1, maxWidth: 400, borderRadius: 8, background: '#000', maxHeight: 200 }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <a
                      href={`${API_BASE}/highlight/jobs/${selectedJob.id}/export/download`}
                      download
                      style={{ fontSize: 12, padding: '8px 16px', fontWeight: 700, background: 'var(--success)', color: '#000', borderRadius: 'var(--radius-control)', textDecoration: 'none', textAlign: 'center' }}
                    >
                      ↓ 다운로드
                    </a>
                    <button
                      onClick={handleDeleteExport}
                      style={{ fontSize: 12, padding: '8px 16px', background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-control)', cursor: 'pointer' }}
                    >
                      삭제
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* clips */}
            {selectedJob.status === 'done' && (
              <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 16, border: '1px solid var(--border-ghost)' }}>
                <div
                  style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                  onClick={() => setExpandedClips((p) => !p)}
                >
                  <span>클립 ({clips.length}개)</span>
                  <span>{expandedClips ? '▲' : '▼'}</span>
                </div>
                {!expandedClips && clips.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>클릭해서 펼치기</div>
                )}
                {expandedClips && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
                    {clips.map((clip) => (
                      <div key={clip} style={{ background: 'var(--button-dark)', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-ghost)' }}>
                        <video
                          src={`${API_BASE}/highlight/jobs/${selectedJob.id}/clips/${clip}`}
                          controls preload="metadata"
                          style={{ width: '100%', display: 'block', background: '#000', maxHeight: 120 }}
                        />
                        <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                          <span style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {clip.replace(/\.mp4$/, '')}
                          </span>
                          <button
                            onClick={() => handleDeleteClip(clip)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: 13, padding: '2px 4px', flexShrink: 0 }}
                            title="클립 삭제"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
