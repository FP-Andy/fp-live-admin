'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiJson } from '../../../../lib/api';

type JobMetadata = {
  clips?: string[];
  clip_timestamps?: Record<string, { start: number; end: number }>;
};

type HighlightJob = {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  original_filename: string;
  display_name?: string | null;
  job_metadata: JobMetadata;
  created_at: string;
};

type TimelineItem = { type: 'clip' | 'image'; name: string; duration?: number };

export default function HighlightEditorPage() {
  const [jobs, setJobs] = useState<HighlightJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<HighlightJob | null>(null);
  const [imageCards, setImageCards] = useState<string[]>([]);
  const [bgmList, setBgmList] = useState<string[]>([]);

  const [items, setItems] = useState<TimelineItem[]>([]);
  const [transitionSec, setTransitionSec] = useState(0.5);
  const [audioVolume, setAudioVolume] = useState(1.0);
  const [bgmName, setBgmName] = useState('');
  const [bgmVolume, setBgmVolume] = useState(0.3);
  const [exporting, setExporting] = useState(false);
  const [exportReady, setExportReady] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const imgInputRef = useRef<HTMLInputElement>(null);
  const dragIdx = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);

  useEffect(() => {
    apiJson<HighlightJob[]>('/highlight/jobs?limit=20')
      .then((d) => setJobs(d))
      .catch(() => {});
    apiJson<{ tracks: string[] }>('/highlight/bgm')
      .then((d) => setBgmList(d.tracks || []))
      .catch(() => {});
  }, []);

  const loadImageCards = useCallback(async (jobId: string) => {
    try {
      const d = await apiJson<{ cards: string[] }>(`/highlight/jobs/${jobId}/image-cards`);
      setImageCards(d.cards || []);
    } catch { setImageCards([]); }
  }, []);

  const selectJob = (job: HighlightJob) => {
    setSelectedJob(job);
    setItems([]);
    setExportReady(false);
    setStatusMsg('');
    if (job.status === 'done') loadImageCards(job.id);
    else setImageCards([]);
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedJob) return;
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      await fetch(`${API_BASE}/highlight/jobs/${selectedJob.id}/image-cards`, {
        method: 'POST', credentials: 'include', body: form,
      });
      await loadImageCards(selectedJob.id);
    } catch (err) { setStatusMsg(`업로드 실패: ${err}`); }
    e.target.value = '';
  };

  const addClip = (name: string) => setItems((p) => [...p, { type: 'clip', name }]);
  const addImage = (name: string) => setItems((p) => [...p, { type: 'image', name, duration: 3.0 }]);
  const removeItem = (idx: number) => setItems((p) => p.filter((_, i) => i !== idx));
  const updateDuration = (idx: number, val: number) =>
    setItems((p) => p.map((it, i) => i === idx ? { ...it, duration: val } : it));

  const handleDragStart = (idx: number) => { dragIdx.current = idx; };
  const handleDragEnter = (idx: number) => { dragOverIdx.current = idx; };
  const handleDragEnd = () => {
    if (dragIdx.current === null || dragOverIdx.current === null) return;
    const next = [...items];
    const [moved] = next.splice(dragIdx.current, 1);
    next.splice(dragOverIdx.current, 0, moved);
    setItems(next);
    dragIdx.current = null;
    dragOverIdx.current = null;
  };

  const handleExport = async () => {
    if (!selectedJob) return;
    if (!items.length) { setStatusMsg('타임라인이 비어 있습니다.'); return; }
    setExporting(true);
    setStatusMsg('합치는 중... 시간이 걸릴 수 있습니다.');
    setExportReady(false);
    try {
      await apiJson(`/highlight/jobs/${selectedJob.id}/export/timeline`, {
        method: 'POST',
        body: JSON.stringify({
          timeline: items.map((it) => ({ type: it.type, name: it.name, duration: it.duration ?? 3.0 })),
          transition_sec: transitionSec,
          audio_volume: audioVolume,
          bgm_name: bgmName,
          bgm_volume: bgmVolume,
        }),
      });
      setExportReady(true);
      setStatusMsg('완료!');
    } catch (err) { setStatusMsg(`오류: ${err}`); }
    finally { setExporting(false); }
  };

  const clips = selectedJob?.status === 'done' ? (selectedJob.job_metadata?.clips || []) : [];

  const sliderStyle = { width: 76, accentColor: 'var(--accent)' } as React.CSSProperties;
  const ctrlLabel = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' } as React.CSSProperties;
  const itemCardStyle = (type: string) => ({
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
    background: type === 'clip' ? 'rgba(255,116,0,0.08)' : 'rgba(72,187,120,0.08)',
    border: `1px solid ${type === 'clip' ? 'rgba(255,116,0,0.25)' : 'rgba(72,187,120,0.25)'}`,
    borderRadius: 8, cursor: 'grab', userSelect: 'none' as const,
  });

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>

      {/* ── Left: job picker + clip/image sources ── */}
      <div style={{ flex: '0 0 220px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* job list */}
        <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 14, border: '1px solid var(--border-ghost)' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 10 }}>RECENT JOBS</div>
          {jobs.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
              완료된 작업이 없습니다.{' '}
              <a href="/admin/highlight" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                Highlight 탭
              </a>
              에서 영상을 먼저 분석해주세요.
            </div>
          )}
          {jobs.map((job) => (
            <div
              key={job.id}
              onClick={() => selectJob(job)}
              style={{
                padding: '8px 10px', marginBottom: 6, borderRadius: 'var(--radius-control)',
                cursor: 'pointer', fontSize: 11,
                background: selectedJob?.id === job.id ? 'var(--accent-soft)' : 'var(--button-dark)',
                border: selectedJob?.id === job.id ? '1px solid var(--border-emphasis)' : '1px solid transparent',
              }}
            >
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(() => { const n = job.display_name || job.original_filename; return n.length > 24 ? n.slice(0, 22) + '…' : n; })()}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 2, display: 'flex', gap: 6 }}>
                <span style={{
                  padding: '1px 5px', borderRadius: 999, fontWeight: 700,
                  background: job.status === 'done' ? 'var(--success-soft)' : job.status === 'error' ? 'var(--danger-soft)' : 'var(--accent-soft)',
                  color: job.status === 'done' ? 'var(--success)' : job.status === 'error' ? 'var(--danger)' : 'var(--accent)',
                }}>
                  {job.status.toUpperCase()}
                </span>
                {new Date(job.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>

        {/* clip picker (only when done job selected) */}
        {selectedJob && clips.length > 0 && (
          <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 14, border: '1px solid var(--border-ghost)' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 10 }}>클립</div>
            {clips.map((c) => (
              <div key={c} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {c.replace(/\.mp4$/, '').slice(-22)}
                </span>
                <button onClick={() => addClip(c)}
                  style={{ background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, padding: '2px 8px', cursor: 'pointer', flexShrink: 0, marginLeft: 4 }}>
                  +
                </button>
              </div>
            ))}
          </div>
        )}

        {/* image cards */}
        {selectedJob && (
          <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 14, border: '1px solid var(--border-ghost)' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 10 }}>이미지 카드</div>
            <input ref={imgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
            <button onClick={() => imgInputRef.current?.click()}
              style={{ width: '100%', fontSize: 11, padding: '5px 0', background: 'var(--button-dark)', border: '1px solid var(--border-ghost)', borderRadius: 6, cursor: 'pointer', color: 'var(--text)', marginBottom: 8 }}>
              + 이미지 업로드
            </button>
            {imageCards.map((c) => (
              <div key={c} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{c}</span>
                <button onClick={() => addImage(c)}
                  style={{ background: 'rgba(72,187,120,0.7)', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, padding: '2px 8px', cursor: 'pointer', flexShrink: 0, marginLeft: 4 }}>
                  +
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Right: timeline + export ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>

        {!selectedJob && (
          <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 48, textAlign: 'center', border: '1px solid var(--border-ghost)' }}>
            <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.4 }}>✂</div>
            <div style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 8 }}>왼쪽에서 작업을 선택하세요</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              분석이 완료된 작업을 선택하면 클립을 타임라인에 추가할 수 있습니다.{' '}
              <a href="/admin/highlight" style={{ color: 'var(--accent)', textDecoration: 'none' }}>새 분석 시작 →</a>
            </div>
          </div>
        )}

        {selectedJob && (
          <>
            {/* export controls */}
            <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: '14px 20px', border: '1px solid var(--border-ghost)', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
              <label style={ctrlLabel}>
                전환
                <input type="range" min={0} max={1.5} step={0.1} value={transitionSec}
                  onChange={(e) => setTransitionSec(parseFloat(e.target.value))} style={sliderStyle} />
                <span style={{ minWidth: 30 }}>{transitionSec.toFixed(1)}s</span>
              </label>
              <label style={ctrlLabel}>
                중계음
                <input type="range" min={0} max={2} step={0.05} value={audioVolume}
                  onChange={(e) => setAudioVolume(parseFloat(e.target.value))} style={sliderStyle} />
                <span style={{ minWidth: 30 }}>{audioVolume.toFixed(2)}</span>
              </label>
              <label style={ctrlLabel}>
                BGM
                <select value={bgmName} onChange={(e) => setBgmName(e.target.value)}
                  style={{ background: 'var(--button-dark)', color: 'var(--text)', border: '1px solid var(--border-ghost)', borderRadius: 6, padding: '3px 8px', fontSize: 12 }}>
                  <option value="">없음</option>
                  {bgmList.map((t) => <option key={t} value={t}>{t.replace(/\.[^.]+$/, '')}</option>)}
                </select>
              </label>
              {bgmName && (
                <label style={ctrlLabel}>
                  BGM 볼륨
                  <input type="range" min={0} max={1} step={0.05} value={bgmVolume}
                    onChange={(e) => setBgmVolume(parseFloat(e.target.value))} style={sliderStyle} />
                  <span style={{ minWidth: 30 }}>{bgmVolume.toFixed(2)}</span>
                </label>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
                {statusMsg && (
                  <span style={{ fontSize: 11, color: exportReady ? 'var(--success)' : 'var(--muted)' }}>{statusMsg}</span>
                )}
                <button onClick={handleExport} disabled={exporting || !items.length}
                  style={{ fontSize: 12, padding: '8px 20px', fontWeight: 700, background: exporting || !items.length ? 'var(--button-dark)' : 'var(--accent)', color: exporting || !items.length ? 'var(--muted)' : '#fff', border: 'none', borderRadius: 'var(--radius-control)', cursor: exporting || !items.length ? 'not-allowed' : 'pointer' }}>
                  {exporting ? '합치는 중...' : '합치기'}
                </button>
                {exportReady && (
                  <a href={`${API_BASE}/highlight/jobs/${selectedJob.id}/export/download`} download
                    style={{ display: 'inline-flex', alignItems: 'center', fontSize: 12, padding: '8px 20px', fontWeight: 700, background: 'var(--success)', color: '#000', borderRadius: 'var(--radius-control)', textDecoration: 'none' }}>
                    ↓ 다운로드
                  </a>
                )}
              </div>
            </div>

            {/* timeline */}
            <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 16, border: '1px solid var(--border-ghost)', minHeight: 160 }}>
              <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 12 }}>
                TIMELINE — {items.length}개 항목 · 드래그로 순서 변경
              </div>
              {!items.length && (
                <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--muted)', fontSize: 13 }}>
                  왼쪽에서 클립이나 이미지를 추가하세요
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((item, idx) => (
                  <div key={`${item.name}-${idx}`} draggable
                    onDragStart={() => handleDragStart(idx)} onDragEnter={() => handleDragEnter(idx)}
                    onDragEnd={handleDragEnd} onDragOver={(e) => e.preventDefault()}
                    style={itemCardStyle(item.type)}>
                    <span style={{ fontSize: 11, fontWeight: 700, minWidth: 44, color: item.type === 'clip' ? 'var(--accent)' : 'var(--success)' }}>
                      {item.type === 'clip' ? '▶ 클립' : '🖼 이미지'}
                    </span>
                    <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </span>
                    {item.type === 'image' && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
                        표시
                        <input type="number" min={0.5} max={60} step={0.5} value={item.duration ?? 3.0}
                          onChange={(e) => updateDuration(idx, parseFloat(e.target.value) || 3.0)}
                          style={{ width: 50, fontSize: 11, padding: '2px 4px' }} />초
                      </label>
                    )}
                    <button onClick={() => removeItem(idx)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16, padding: '0 4px', flexShrink: 0 }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* clip preview strip */}
            {clips.length > 0 && (
              <div style={{ background: 'var(--surface-card)', borderRadius: 'var(--radius-card)', padding: 16, border: '1px solid var(--border-ghost)' }}>
                <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 12 }}>클립 미리보기</div>
                <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 }}>
                  {clips.map((c) => (
                    <div key={c} style={{ flexShrink: 0, width: 180 }}>
                      <video
                        src={`${API_BASE}/highlight/jobs/${selectedJob.id}/clips/${c}`}
                        controls preload="metadata"
                        style={{ width: '100%', borderRadius: 6, background: '#000', maxHeight: 110 }}
                      />
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.replace(/\.mp4$/, '')}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
