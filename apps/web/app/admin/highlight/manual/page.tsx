'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HighlightSubTabs from '../HighlightSubTabs';
import { API_BASE, apiJson } from '../../../../lib/api';
import type { CutClip, CutProgress } from '../../../../lib/localCut';
import { ProgressBar, LeaveBadge } from '../../../../components/HlProgress';

type JobStatus = {
  id: string;
  status: string;
  error_message?: string | null;
  job_metadata?: { progress?: { detail?: string } | null } | null;
};

// 로컬 우선 태깅: 원본을 서버에 올리지 않고 브라우저에서 바로 재생하며 하이라이트 지점을 찍는다.
// 태그는 타임코드(초)일 뿐이라 용량이 없다시피 하고, 클립 추출은 이후 단계에서 붙는다.

type Tag = { id: string; t: number };
type SavedWork = { tags: Tag[]; padBefore: number; padAfter: number };

const SPEEDS = [1, 1.5, 2, 3, 4];
const SEEK_STEP = 5;
const AUTOSAVE_PREFIX = 'fhl.manual.tags.';

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
  width: 60,
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--border-ghost, #3a3a42)',
  background: 'var(--surface-input, #1b1b1f)',
  color: 'var(--text, #eee)',
  fontSize: 13,
};
const stageBox: React.CSSProperties = {
  marginTop: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 8,
  background: 'var(--surface-input, #16161a)',
  border: '1px solid var(--border-ghost, #2c2c32)',
};
const stageHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
const stageCount: React.CSSProperties = { fontSize: 12, color: 'var(--muted, #999)', marginLeft: 'auto' };
const stageNote: React.CSSProperties = { fontSize: 12, color: 'var(--muted, #999)', margin: 0 };

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const fmtBytes = (bytes: number) => {
  const mb = bytes / (1024 * 1024);
  return mb < 1024 ? `${mb.toFixed(0)} MB` : `${(mb / 1024).toFixed(2)} GB`;
};

export default function ManualHighlightPage() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tags, setTags] = useState<Tag[]>([]);
  const [padBefore, setPadBefore] = useState(7);
  const [padAfter, setPadAfter] = useState(4);
  const [status, setStatus] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [cutProgress, setCutProgress] = useState<CutProgress | null>(null);
  const [clips, setClips] = useState<CutClip[]>([]);
  const [cutError, setCutError] = useState('');
  const [previewBusy, setPreviewBusy] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState('');
  const [publishError, setPublishError] = useState('');
  const [doneJobId, setDoneJobId] = useState('');
  // 업로드는 브라우저(탭 유지 필요), 합치기는 서버(탭 닫아도 됨) — 단계를 나눠 바/배지에 쓴다.
  const [publishPhase, setPublishPhase] = useState<'idle' | 'uploading' | 'merging' | 'done'>('idle');
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [introFile, setIntroFile] = useState<File | null>(null);
  const [introUrl, setIntroUrl] = useState('');
  const [introDuration, setIntroDuration] = useState(1.8);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const urlRef = useRef<string>('');

  // 자동저장 키는 파일을 특정할 수 있는 최소 정보로 만든다 (이름+크기).
  const storageKey = useMemo(
    () => (file ? `${AUTOSAVE_PREFIX}${file.name}:${file.size}` : ''),
    [file],
  );

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = '';
    }
  }, []);

  useEffect(() => revoke, [revoke]);

  const pickFile = (f: File | null) => {
    revoke();
    setTags([]);
    setDuration(0);
    setCurrent(0);
    setPlaying(false);
    setUnsupported(false);
    setStatus('');
    setClips([]);
    setCutError('');
    setCutProgress(null);
    setFile(f);
    if (!f) {
      setVideoUrl('');
      return;
    }
    const url = URL.createObjectURL(f);
    urlRef.current = url;
    setVideoUrl(url);
  };

  // 인트로 사진 미리보기용 objectURL 을 갈아끼울 때마다 이전 것을 해제한다.
  const introUrlRef = useRef<string>('');
  const pickIntro = useCallback((f: File | null) => {
    if (introUrlRef.current) {
      URL.revokeObjectURL(introUrlRef.current);
      introUrlRef.current = '';
    }
    setIntroFile(f);
    if (!f) {
      setIntroUrl('');
      return;
    }
    const url = URL.createObjectURL(f);
    introUrlRef.current = url;
    setIntroUrl(url);
  }, []);

  useEffect(() => () => {
    if (introUrlRef.current) URL.revokeObjectURL(introUrlRef.current);
  }, []);

  // 이전에 태깅하던 파일이면 저장해둔 작업을 되살린다.
  // 패딩도 함께 복원해야 한다. 태그만 돌아오고 패딩이 기본값으로 리셋되면
  // 같은 태그인데 클립 구간이 조용히 달라진다.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Tag[] | SavedWork;
      const saved: SavedWork = Array.isArray(parsed)
        ? { tags: parsed, padBefore: 7, padAfter: 4 } // 패딩을 저장하기 전 형식
        : parsed;
      if (!saved?.tags?.length) return;
      setTags(saved.tags);
      setPadBefore(saved.padBefore ?? 7);
      setPadAfter(saved.padAfter ?? 4);
      setStatus(
        `이전 작업 복원 — 태그 ${saved.tags.length}개, 앞 ${saved.padBefore ?? 7}초 / 뒤 ${saved.padAfter ?? 4}초`,
      );
    } catch {
      /* 손상된 저장값은 무시하고 새로 시작한다 */
    }
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    if (tags.length) {
      localStorage.setItem(storageKey, JSON.stringify({ tags, padBefore, padAfter } satisfies SavedWork));
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [tags, padBefore, padAfter, storageKey]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, videoUrl]);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, t));
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const addTag = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const t = v.currentTime;
    setTags((prev) => {
      // 같은 지점을 두 번 찍는 실수를 막는다 (1초 이내면 무시).
      if (prev.some((p) => Math.abs(p.t - t) < 1)) return prev;
      const next = [...prev, { id: `${t.toFixed(3)}-${Math.random().toString(36).slice(2, 7)}`, t }];
      next.sort((a, b) => a.t - b.t);
      return next;
    });
  }, []);

  const removeTag = (id: string) => setTags((prev) => prev.filter((p) => p.id !== id));

  // 단축키. 입력창에 포커스가 있을 때는 동작하지 않아야 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      if (!videoRef.current) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
      if (e.code === 'ArrowLeft') { e.preventDefault(); seekTo(videoRef.current.currentTime - SEEK_STEP); return; }
      if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(videoRef.current.currentTime + SEEK_STEP); return; }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); addTag(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekTo, addTag]);

  // 추출이나 업로드 도중에 창을 닫으면 작업이 끊기고, 업로드 중이었다면 서버에
  // 클립이 일부만 올라간 잡이 남는다. 최소한 경고는 띄운다.
  useEffect(() => {
    if (!cutting && !publishing) return undefined;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [cutting, publishing]);

  const totalClipSeconds = tags.length * (padBefore + padAfter);

  // 태그가 바뀌면 이미 뽑아둔 클립은 더 이상 맞지 않는다.
  useEffect(() => { setClips([]); setCutError(''); }, [tags, padBefore, padAfter]);

  const runCut = async () => {
    if (!file || !tags.length || cutting) return;
    setCutting(true);
    setCutError('');
    setClips([]);
    try {
      // ffmpeg 코어는 처음 쓸 때만 받는다(31MB). 초기 번들에는 넣지 않는다.
      const { cutClipsLocally } = await import('../../../../lib/localCut');
      const requests = tags.map((tag) => ({
        start: Math.max(0, tag.t - padBefore),
        end: Math.min(duration || tag.t + padAfter, tag.t + padAfter),
      }));
      const made = await cutClipsLocally(file, requests, setCutProgress);
      setClips(made);
    } catch (err) {
      setCutError(err instanceof Error ? err.message : String(err));
    } finally {
      setCutting(false);
    }
  };

  const clipsTotalBytes = clips.reduce((sum, c) => sum + c.blob.size, 0);

  // 클립을 서버로 보내고 합치기까지 맡긴다. 원본은 올라가지 않는다.
  const publish = async () => {
    if (!file || !clips.length || publishing) return;
    setPublishing(true);
    setPublishError('');
    setDoneJobId('');
    setPublishPhase('uploading');
    setUploadProgress({ done: 0, total: clips.length });
    try {
      const { job_id: jobId } = await apiJson<{ job_id: string }>('/highlight/manual-jobs', {
        method: 'POST',
        body: JSON.stringify({ source_filename: file.name }),
      });

      for (let i = 0; i < clips.length; i += 1) {
        const clip = clips[i];
        setPublishMsg(`클립 업로드 ${i + 1} / ${clips.length}`);
        const form = new FormData();
        form.append('clip', clip.blob, `clip_${String(clip.index).padStart(3, '0')}.mp4`);
        form.append('requested_start', String(clip.requestedStart));
        form.append('requested_end', String(clip.requestedEnd));
        const res = await fetch(`${API_BASE}/highlight/manual-jobs/${jobId}/clips`, {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
        if (!res.ok) throw new Error(await res.text() || `클립 ${i + 1} 업로드 실패`);
        setUploadProgress({ done: i + 1, total: clips.length });
      }

      // 인트로 사진이 있으면 클립을 다 올린 뒤, 합치기 직전에 보낸다.
      if (introFile) {
        setPublishMsg('인트로 사진 업로드 중...');
        const introForm = new FormData();
        introForm.append('image', introFile, introFile.name);
        introForm.append('duration', String(introDuration));
        const introRes = await fetch(`${API_BASE}/highlight/manual-jobs/${jobId}/intro`, {
          method: 'POST',
          credentials: 'include',
          body: introForm,
        });
        if (!introRes.ok) throw new Error(await introRes.text() || '인트로 사진 업로드 실패');
      }

      // 여기서부터는 서버 몫 — 탭을 닫아도 합치기는 끝나고 "수동 결과물"에 뜬다.
      setPublishPhase('merging');
      setPublishMsg('서버에서 다듬고 합치는 중...');
      await apiJson(`/highlight/manual-jobs/${jobId}/merge`, { method: 'POST' });

      // 합치기는 재인코딩이라 몇 초 걸린다. 끝날 때까지 상태를 확인한다.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const job = await apiJson<JobStatus>(`/highlight/jobs/${jobId}`);
        if (job.status === 'done') {
          setDoneJobId(jobId);
          setPublishPhase('done');
          setPublishMsg('완료되었습니다.');
          break;
        }
        if (job.status === 'error') throw new Error(job.error_message || '합치기 실패');
        setPublishMsg(job.job_metadata?.progress?.detail || '처리 중...');
      }
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err));
      setPublishMsg('');
      setPublishPhase('idle');
    } finally {
      setPublishing(false);
    }
  };

  // 렌더 중에 createObjectURL 을 부르면 재생 중 timeupdate 마다 수 MB짜리 URL이 새로 생겨 샌다.
  // 클릭한 순간에만 만들고 해제한다.
  const downloadClip = async (clip: CutClip) => {
    if (previewBusy !== null) return;
    setPreviewBusy(clip.index);
    setCutError('');
    try {
      const { normalizeForPreview } = await import('../../../../lib/localCut');
      const normalized = await normalizeForPreview(clip.blob);
      const url = URL.createObjectURL(normalized);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clip_${String(clip.index).padStart(3, '0')}.mp4`;
      a.click();
      // 브라우저가 저장을 시작할 여유를 준 뒤 해제한다.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) {
      setCutError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewBusy(null);
    }
  };

  return (
    <div style={{ width: '100%' }}>
      <HighlightSubTabs />

      <div style={card}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 4 }}>수동 하이라이트 태깅</h2>
        <p style={{ fontSize: 13, color: 'var(--muted, #999)', marginTop: 0, marginBottom: 12 }}>
          영상을 업로드하지 않고 바로 재생합니다. 배속으로 넘겨보며 하이라이트 지점을 찍으면,
          이후 그 구간만 잘라 올립니다.
        </p>

        <input
          type="file"
          accept="video/*"
          onChange={(e) => pickFile(e.target.files?.[0] || null)}
          style={{ fontSize: 13 }}
        />
        {file ? (
          <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '8px 0 0' }}>
            {file.name} · {fmtBytes(file.size)}
            {duration ? ` · ${fmt(duration)}` : ''}
          </p>
        ) : null}

        {unsupported ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 8,
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.4)',
              fontSize: 13,
            }}
          >
            이 브라우저가 열 수 없는 코덱입니다 (HEVC 등으로 추정). 서버 변환이 필요하니
            <strong> Player Clips </strong> 탭의 기존 업로드 방식을 사용하세요.
          </div>
        ) : null}

        {status ? (
          <p style={{ fontSize: 12, color: 'var(--accent, #3b82f6)', margin: '8px 0 0' }}>{status}</p>
        ) : null}
      </div>

      {videoUrl && !unsupported ? (
        <>
          <div style={card}>
            <video
              ref={videoRef}
              src={videoUrl}
              style={{ width: '100%', maxHeight: '60vh', background: '#000', borderRadius: 8 }}
              onLoadedMetadata={(e) => {
                setDuration(e.currentTarget.duration || 0);
                e.currentTarget.playbackRate = speed;
              }}
              onError={() => setUnsupported(true)}
              onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              controls
            />

            {/* 타임라인 — 찍은 지점을 한눈에 보고 클릭해서 이동 */}
            <div
              style={{
                position: 'relative',
                height: 26,
                marginTop: 10,
                background: 'var(--border-ghost, #2c2c32)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
              onClick={(e) => {
                if (!duration) return;
                const rect = e.currentTarget.getBoundingClientRect();
                seekTo(((e.clientX - rect.left) / rect.width) * duration);
              }}
            >
              {duration ? (
                <div
                  style={{
                    position: 'absolute',
                    left: `${(current / duration) * 100}%`,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    background: 'var(--text, #eee)',
                  }}
                />
              ) : null}
              {duration
                ? tags.map((tag) => (
                    <div
                      key={tag.id}
                      title={fmt(tag.t)}
                      style={{
                        position: 'absolute',
                        left: `${(tag.t / duration) * 100}%`,
                        top: 3,
                        bottom: 3,
                        width: 3,
                        marginLeft: -1,
                        background: 'var(--accent, #3b82f6)',
                        borderRadius: 2,
                      }}
                    />
                  ))
                : null}
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
              <button style={btn} onClick={togglePlay}>{playing ? '⏸ 정지' : '▶ 재생'}</button>
              <button style={primaryBtn} onClick={addTag}>＋ 지금 지점 태깅 (S)</button>

              <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 6 }}>
                배속
                <select
                  value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  style={{ ...smallBtn, padding: '4px 6px' }}
                >
                  {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
                </select>
              </label>

              <span style={{ fontSize: 13, color: 'var(--muted, #999)', marginLeft: 'auto' }}>
                {fmt(current)} / {fmt(duration)}
              </span>
            </div>

            <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '10px 0 0' }}>
              단축키 — <strong>Space</strong> 재생·정지 · <strong>←/→</strong> {SEEK_STEP}초 이동 · <strong>S</strong> 태깅
            </p>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>태그 {tags.length}개</h3>
              <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 4 }}>
                앞
                <input
                  type="number" min={0} max={30} style={numInput}
                  value={padBefore}
                  onChange={(e) => setPadBefore(Math.max(0, Number(e.target.value) || 0))}
                />
                초
              </label>
              <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 4 }}>
                뒤
                <input
                  type="number" min={0} max={30} style={numInput}
                  value={padAfter}
                  onChange={(e) => setPadAfter(Math.max(0, Number(e.target.value) || 0))}
                />
                초
              </label>
              {tags.length ? (
                <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                  예상 합본 길이 약 {fmt(totalClipSeconds)}
                </span>
              ) : null}
              {tags.length ? (
                <button style={{ ...smallBtn, marginLeft: 'auto' }} onClick={() => setTags([])}>전체 삭제</button>
              ) : null}
            </div>

            {tags.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
                아직 태그가 없습니다. 재생하며 하이라이트 지점에서 <strong>S</strong>를 누르세요.
              </p>
            ) : (
              <>
              <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '0 0 10px' }}>
                태그와 패딩은 자동 저장됩니다. 다른 페이지에 다녀와도 같은 파일을 다시 고르면 복원되지만,
                추출해둔 클립은 남지 않아 다시 뽑아야 합니다.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {tags.map((tag, i) => (
                  <div
                    key={tag.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '6px 10px', borderRadius: 6,
                      background: 'var(--surface-input, #16161a)',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ color: 'var(--muted, #999)', width: 28 }}>{i + 1}</span>
                    <button style={smallBtn} onClick={() => seekTo(tag.t)}>{fmt(tag.t)}</button>
                    <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                      클립 {fmt(Math.max(0, tag.t - padBefore))} ~ {fmt(tag.t + padAfter)}
                    </span>
                    <button
                      style={{ ...smallBtn, marginLeft: 'auto' }}
                      onClick={() => removeTag(tag.id)}
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
              </>
            )}
          </div>

          {tags.length ? (
            <div style={card}>
              <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>클립 추출</h3>
              <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '0 0 12px' }}>
                재인코딩 없이 잘라내므로 빠릅니다. 키프레임 위치 때문에 클립이 요청 구간보다
                조금 길게 나오고, 정확한 다듬기는 서버가 합칠 때 처리합니다.
              </p>

              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button style={primaryBtn} onClick={runCut} disabled={cutting}>
                  {cutting ? '추출 중...' : `✂ 클립 ${tags.length}개 추출`}
                </button>
                {!cutting && clips.length ? (
                  <span style={{ fontSize: 13, color: '#22c55e' }}>
                    클립 {clips.length}개 · 총 {fmtBytes(clipsTotalBytes)} — 업로드 준비 완료
                  </span>
                ) : null}
              </div>

              {cutting && cutProgress ? (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>1. 클립 추출 (브라우저)</span>
                    <LeaveBadge canLeave={false} />
                    <span style={{ fontSize: 12, color: 'var(--muted, #999)', marginLeft: 'auto' }}>
                      {cutProgress.phase === 'loading'
                        ? 'ffmpeg 준비 중 (최초 1회 31MB)'
                        : `${cutProgress.done} / ${cutProgress.total}`}
                    </span>
                  </div>
                  <ProgressBar
                    percent={cutProgress.total ? (cutProgress.done / cutProgress.total) * 100 : 0}
                    indeterminate={cutProgress.phase === 'loading'}
                  />
                </div>
              ) : null}

              {cutError ? (
                <div
                  style={{
                    marginTop: 12, padding: 12, borderRadius: 8, fontSize: 13,
                    background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
                  }}
                >
                  추출 실패: {cutError}
                </div>
              ) : null}

              {clips.length ? (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {clips.map((clip) => (
                    <div
                      key={clip.index}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                        padding: '6px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
                      }}
                    >
                      <span style={{ color: 'var(--muted, #999)', width: 28 }}>{clip.index}</span>
                      <span>{fmt(clip.requestedStart)} ~ {fmt(clip.requestedEnd)}</span>
                      <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                        {fmtBytes(clip.blob.size)}
                      </span>
                      <button
                        style={{ ...smallBtn, marginLeft: 'auto' }}
                        onClick={() => downloadClip(clip)}
                        disabled={previewBusy !== null}
                      >
                        {previewBusy === clip.index ? '준비 중...' : '확인용 다운로드'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {clips.length ? (
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-ghost, #2c2c32)' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
                    {introUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={introUrl}
                        alt="인트로 미리보기"
                        style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border-ghost, #3a3a42)' }}
                      />
                    ) : null}
                    <label style={{ ...smallBtn, display: 'inline-flex', alignItems: 'center' }}>
                      {introFile ? '인트로 사진 변경' : '＋ 인트로 사진 (선택)'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        style={{ display: 'none' }}
                        onChange={(e) => pickIntro(e.target.files?.[0] ?? null)}
                        disabled={publishing}
                      />
                    </label>
                    {introFile ? (
                      <>
                        <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          표시 시간
                          <input
                            type="number"
                            step={0.1}
                            min={0.5}
                            max={5}
                            value={introDuration}
                            onChange={(e) => setIntroDuration(Math.max(0.5, Math.min(5, Number(e.target.value) || 1.8)))}
                            style={numInput}
                            disabled={publishing}
                          />
                          초
                        </label>
                        <button style={smallBtn} onClick={() => pickIntro(null)} disabled={publishing}>제거</button>
                      </>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                        하이라이트 맨 앞에 사진을 잠깐 보여줍니다.
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button style={primaryBtn} onClick={publish} disabled={publishing}>
                      {publishing ? '처리 중...' : `⬆ 업로드하고 하나로 합치기 (${fmtBytes(clipsTotalBytes)})`}
                    </button>
                    {publishPhase === 'done' && publishMsg ? (
                      <span style={{ fontSize: 13, color: '#22c55e' }}>{publishMsg}</span>
                    ) : null}
                  </div>

                  {publishPhase === 'uploading' ? (
                    <div style={stageBox}>
                      <div style={stageHead}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>2. 클립 업로드 (브라우저)</span>
                        <LeaveBadge canLeave={false} />
                        <span style={stageCount}>{uploadProgress.done} / {uploadProgress.total}</span>
                      </div>
                      <ProgressBar
                        percent={uploadProgress.total ? (uploadProgress.done / uploadProgress.total) * 100 : 0}
                      />
                      <p style={stageNote}>
                        업로드가 끝날 때까지 <strong>이 탭을 닫지 마세요.</strong> 다음 영상은 새 탭에서 준비하세요.
                      </p>
                    </div>
                  ) : null}

                  {publishPhase === 'merging' ? (
                    <div style={stageBox}>
                      <div style={stageHead}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>3. 서버에서 다듬고 합치는 중</span>
                        <LeaveBadge canLeave />
                        <span style={stageCount}>{publishMsg}</span>
                      </div>
                      <ProgressBar indeterminate color="#22c55e" />
                      <p style={stageNote}>
                        여기부턴 서버가 처리해요. <strong>탭을 닫아도 되고</strong>, 완료되면{' '}
                        <strong>수동 결과물</strong> 탭에 자동으로 나타납니다.
                      </p>
                    </div>
                  ) : null}

                  <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '8px 0 0' }}>
                    원본은 올라가지 않습니다. 잘린 클립만 보내고, 서버가 요청 구간에 맞춰
                    정확히 다듬어 하나로 이어붙입니다.
                  </p>

                  {publishError ? (
                    <div
                      style={{
                        marginTop: 12, padding: 12, borderRadius: 8, fontSize: 13,
                        background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
                      }}
                    >
                      실패: {publishError}
                    </div>
                  ) : null}

                  {doneJobId ? (
                    <div
                      style={{
                        marginTop: 12, padding: 12, borderRadius: 8, fontSize: 13,
                        background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)',
                        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                      }}
                    >
                      <span>하이라이트가 만들어졌습니다. 서버에 저장되어 언제든 다시 받을 수 있습니다.</span>
                      <a
                        href={`${API_BASE}/highlight/jobs/${doneJobId}/export/download`}
                        style={{ ...smallBtn, textDecoration: 'none' }}
                      >
                        합본 다운로드
                      </a>
                      <Link href="/admin/highlight/results" style={{ ...smallBtn, textDecoration: 'none' }}>
                        결과물 목록
                      </Link>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
