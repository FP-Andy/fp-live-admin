'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import HighlightSubTabs from '../HighlightSubTabs';
import { apiJson } from '../../../../lib/api';
import { ProgressBar, LeaveBadge } from '../../../../components/HlProgress';

// FinePlay 연동 태깅: claim 한 작업의 원본을 S3 스트리밍으로 재생하며 태깅하고,
// 구간을 서버로 보내면 서버가 클립 렌더 → S3 업로드 → 결과 콜백까지 처리한다.
// 원본을 내려받지도, 브라우저에서 자르지도 않는다.

type FpJob = {
  id: string;
  status: string;
  original_filename: string;
  display_name?: string | null;
  error_message?: string | null;
  created_at: string;
  job_metadata?: {
    display_name?: string | null;
    analysis_request_id?: number | string;
    manifest?: { videos?: { durationSeconds?: number }[] } | null;
    clips?: { start: number; end: number }[];
    progress?: { detail?: string } | null;
    result_payload?: { clips?: unknown[] } | null;
    callback_status?: string;
    standalone?: boolean;
    source_deleted?: boolean;
    clip_archived?: boolean;
    fpa_link?: { match_id: string; our_side: 'home' | 'away' } | null;
    fpa_enrich_status?: string;
  } | null;
};

// team: 태깅 시점에 확정하는 클립 귀속 팀 (A=홈 / D=어웨이).
type Tag = { id: string; t: number; team: 'home' | 'away' };

type FpaMatch = {
  id: string;
  name: string;
  competition_class: string;
  metadata?: { home_team?: string; away_team?: string } | null;
};

function fpaMatchTeams(match: FpaMatch) {
  const home = match.metadata?.home_team?.trim();
  const away = match.metadata?.away_team?.trim();
  if (home && away) return { home, away };
  const cleaned = match.name.replace(/^\[[^\]]+\]\s*/, '');
  const [h, a] = cleaned.split(/\s+vs\s+/i).map((part) => part.trim());
  return { home: h || 'Home', away: a || 'Away' };
}

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

const SPEEDS = [1, 1.5, 2, 3, 4];

const STATUS_LABEL: Record<string, string> = {
  tagging: '태깅 대기',
  queued: '생성 대기',
  merging: '생성 중',
  done: '완료',
  error: '실패',
};

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function FineplayJobsPage() {
  const [jobs, setJobs] = useState<FpJob[]>([]);
  // 잡별 아카이브 준비상태 — 모든 클립에 FPA 데이터가 있어야 버튼 활성화.
  const [readiness, setReadiness] = useState<Record<string, { clip_count: number; clips_with_actions: number; ready: boolean }>>({});
  const [listError, setListError] = useState('');
  const [polling, setPolling] = useState(false);
  const [pollMsg, setPollMsg] = useState('');

  // 사전 작업(신청 없이) 생성 — 런칭 전 풀영상을 직접 올려 보관용 잡·매치를 만든다.
  const [preOpen, setPreOpen] = useState(false);
  const [preTeam, setPreTeam] = useState('');
  const [preOpp, setPreOpp] = useState('');
  const [preName, setPreName] = useState('');
  const [preFile, setPreFile] = useState<File | null>(null);
  const [preBusy, setPreBusy] = useState(false);
  const [preProgress, setPreProgress] = useState(0);
  const [preMsg, setPreMsg] = useState('');

  const [selected, setSelected] = useState<FpJob | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const [tags, setTags] = useState<Tag[]>([]);
  const [padBefore, setPadBefore] = useState(7);
  const [padAfter, setPadAfter] = useState(4);
  const [makeVertical, setMakeVertical] = useState(false);
  const [producing, setProducing] = useState(false);
  const [produceMsg, setProduceMsg] = useState('');
  const [produceError, setProduceError] = useState('');

  // FPA dual 연결 — 선택한 FPA 매치의 씬을 클립에 순서 매칭해 분석 데이터를 함께 보낸다.
  const [fpaPickerOpen, setFpaPickerOpen] = useState(false);
  const [fpaMatches, setFpaMatches] = useState<FpaMatch[]>([]);
  const [fpaMatchId, setFpaMatchId] = useState('');
  const [fpaMatchName, setFpaMatchName] = useState('');
  const [fpaTeams, setFpaTeams] = useState<{ home: string; away: string }>({ home: 'Home', away: 'Away' });
  const [fpaOurSide, setFpaOurSide] = useState<'home' | 'away'>('home');
  const [fpaSceneCount, setFpaSceneCount] = useState<number | null>(null);
  const [fpaMsg, setFpaMsg] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, sourceUrl]);

  const loadJobs = useCallback(async () => {
    try {
      const rows = await apiJson<FpJob[]>('/highlight/jobs?mode=fineplay&limit=100');
      // 아카이브된 작업은 '아카이브' 룸에서 관리 — 작업 목록에선 숨긴다.
      setJobs(rows.filter((j) => !j.job_metadata?.clip_archived));
      setListError('');
      try {
        const r = await apiJson<{ jobs: Record<string, { clip_count: number; clips_with_actions: number; ready: boolean }> }>(
          '/highlight/fineplay-jobs/archive-readiness',
        );
        setReadiness(r.jobs);
      } catch {
        // 준비상태 조회 실패는 목록을 막지 않는다 — 버튼은 비활성으로 남는다.
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const createStandalone = async () => {
    if (!preTeam.trim() || !preOpp.trim() || !preFile) {
      setPreMsg('팀명·상대팀명·영상 파일을 모두 입력하세요.');
      return;
    }
    setPreBusy(true);
    setPreMsg('');
    setPreProgress(0);
    try {
      const presign = await apiJson<{ upload_url: string; s3_key: string; content_type: string }>(
        '/highlight/fineplay-jobs/standalone/upload-url',
        { method: 'POST', body: JSON.stringify({ file_name: preFile.name }) },
      );
      // S3 직접 업로드 — 진행률 표시를 위해 XHR 사용 (presigned URL 이라 쿠키 불필요).
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', presign.upload_url);
        xhr.setRequestHeader('Content-Type', presign.content_type);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setPreProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`업로드 실패 (${xhr.status})`)));
        xhr.onerror = () => reject(new Error('업로드 네트워크 오류'));
        xhr.send(preFile);
      });
      const videoKey = presign.s3_key;
      const res = await apiJson<{ job_id: string; analysis_request_id: string }>(
        '/highlight/fineplay-jobs/standalone',
        {
          method: 'POST',
          body: JSON.stringify({
            team_name: preTeam.trim(),
            opponent_name: preOpp.trim(),
            match_name: preName.trim(),
            video_s3_key: videoKey,
          }),
        },
      );
      setPreMsg(`사전 작업 생성 완료 — ${res.job_id}. 목록에서 태깅을 시작하세요.`);
      setPreTeam('');
      setPreOpp('');
      setPreName('');
      setPreFile(null);
      await loadJobs();
    } catch (err) {
      setPreMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPreBusy(false);
    }
  };

  // 사전 작업 원본 삭제 — 보관비 정리. 클립·데이터는 그대로, 재제작만 불가.
  const deleteSource = async (job: FpJob) => {
    const ok = window.confirm(
      '원본 영상을 S3에서 삭제할까요?\n클립·FPA 데이터는 유지되지만, 원본 재생과 클립 재제작은 불가능해집니다.',
    );
    if (!ok) return;
    try {
      await apiJson(`/highlight/fineplay-jobs/${job.id}/delete-source`, { method: 'POST' });
      setPollMsg(`원본 삭제 완료 — ${job.id}`);
      await loadJobs();
    } catch (err) {
      setPollMsg(err instanceof Error ? err.message : String(err));
    }
  };

  // 작업이 끝난 잡을 아카이브 룸으로 보낸다 (데이터 그대로, 목록만 이동).
  const archiveJob = async (job: FpJob) => {
    try {
      await apiJson(`/highlight/fineplay-jobs/${job.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived: true }),
      });
      setPollMsg(`아카이브 완료 — ${job.id}. '아카이브' 탭에서 볼 수 있습니다.`);
      await loadJobs();
    } catch (err) {
      setPollMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const pollNew = async () => {
    setPolling(true);
    setPollMsg('');
    try {
      const res = await apiJson<{ claimed: string[]; skipped: number }>(
        '/highlight/fineplay-jobs/poll', { method: 'POST' },
      );
      setPollMsg(res.claimed.length ? `새 작업 ${res.claimed.length}건 가져옴` : '새 작업 없음');
      await loadJobs();
    } catch (err) {
      setPollMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPolling(false);
    }
  };

  // FPA 매치의 저장 로그를 읽어 씬 개수·팀 라벨을 채운다. name 이 없으면 라벨로 대체.
  const applyFpaMatch = async (matchId: string, name?: string) => {
    setFpaMatchId(matchId);
    setFpaMsg('');
    setFpaSceneCount(null);
    try {
      const saved = await apiJson<{ rows: { SceneIndex?: string }[]; teamid_h: string; teamid_a: string }>(
        `/fpa/matches/${matchId}/logs`,
      );
      const sceneIndexes = new Set(
        (saved.rows || []).map((r) => (r.SceneIndex || '').trim()).filter(Boolean),
      );
      setFpaSceneCount(sceneIndexes.size);
      const home = saved.teamid_h?.trim();
      const away = saved.teamid_a?.trim();
      setFpaTeams({ home: home || 'Home', away: away || 'Away' });
      setFpaMatchName(name || (home && away ? `${home} vs ${away}` : matchId.slice(0, 8)));
      if (!sceneIndexes.size) setFpaMsg('이 매치에는 저장된 dual 씬이 없습니다.');
    } catch (err) {
      setFpaMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const clearFpaLink = () => {
    setFpaMatchId('');
    setFpaMatchName('');
    setFpaSceneCount(null);
    setFpaMsg('');
  };

  const openFpaPicker = async () => {
    setFpaPickerOpen(true);
    try {
      const rows = await apiJson<FpaMatch[]>('/matches');
      // FPA 로거로 저장된 매치를 앞에, 나머지는 뒤에 (다른 클래스로 만든 매치도 선택 가능).
      const sorted = [...rows].sort((a, b) =>
        Number(b.competition_class === 'FPA') - Number(a.competition_class === 'FPA'));
      setFpaMatches(sorted);
    } catch (err) {
      setFpaMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const selectJob = async (job: FpJob) => {
    setSelected(job);
    setSourceUrl('');
    setSourceError('');
    setTags([]);
    setDuration(0);
    setCurrent(0);
    setPlaying(false);
    setProduceMsg('');
    setProduceError('');
    setFpaPickerOpen(false);
    const link = job.job_metadata?.fpa_link;
    if (link?.match_id) {
      setFpaOurSide(link.our_side === 'away' ? 'away' : 'home');
      void applyFpaMatch(link.match_id);
    } else {
      clearFpaLink();
      setFpaOurSide('home');
    }
    try {
      const res = await apiJson<{ url: string }>(`/highlight/fineplay-jobs/${job.id}/source-url`);
      setSourceUrl(res.url);
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : String(err));
    }
  };

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { void v.play(); } else { v.pause(); }
  }, []);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || t, t));
  }, []);

  const addTag = useCallback((team: 'home' | 'away') => {
    const v = videoRef.current;
    if (!v || !sourceUrl) return;
    const t = v.currentTime;
    setTags((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, t, team }]
      .sort((a, b) => a.t - b.t));
  }, [sourceUrl]);

  const toggleTagTeam = (id: string) => {
    setTags((prev) => prev.map((tag) =>
      tag.id === id ? { ...tag, team: tag.team === 'home' ? 'away' : 'home' } : tag));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!videoRef.current || !sourceUrl) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
      if (e.code === 'ArrowLeft') { e.preventDefault(); seekTo(videoRef.current.currentTime - 5); return; }
      if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(videoRef.current.currentTime + 5); return; }
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); addTag('home'); return; }
      if (e.key === 'd' || e.key === 'D') { e.preventDefault(); addTag('away'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekTo, addTag, sourceUrl]);

  // sendCallback=true 면 생성 직후 FinePlay 전송, false 면 생성만(클립 결과 탭에서 명시 전송).
  const produce = async (sendCallback: boolean) => {
    if (!selected || !tags.length || producing) return;
    setProducing(true);
    setProduceError('');
    try {
      const clips = tags.map((tag) => ({
        start: Math.max(0, tag.t - padBefore),
        end: Math.min(duration || tag.t + padAfter, tag.t + padAfter),
        team: tag.team,
        makeVertical,
      }));
      await apiJson(`/highlight/fineplay-jobs/${selected.id}/produce`, {
        method: 'POST',
        // fpaMatchId: '' 는 연결 해제 — 서버는 키가 있을 때만 링크를 갱신한다.
        body: JSON.stringify({ clips, fpaMatchId, fpaOurSide, sendCallback }),
      });
      setProduceMsg('서버에서 클립 만드는 중...');

      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const job = await apiJson<FpJob>(`/highlight/jobs/${selected.id}`);
        if (job.status === 'done') {
          const meta = job.job_metadata || {};
          const n = meta.result_payload?.clips?.length ?? tags.length;
          const fpaNote = meta.fpa_enrich_status ? `, FPA: ${meta.fpa_enrich_status}` : '';
          setProduceMsg(`완료 — 클립 ${n}개 업로드, 콜백: ${meta.callback_status || '-'}${fpaNote}`);
          break;
        }
        if (job.status === 'error') throw new Error(job.error_message || '생성 실패');
        setProduceMsg(job.job_metadata?.progress?.detail || '처리 중...');
      }
      await loadJobs();
    } catch (err) {
      setProduceError(err instanceof Error ? err.message : String(err));
      setProduceMsg('');
    } finally {
      setProducing(false);
    }
  };

  return (
    <div style={{ width: '100%' }}>
      <HighlightSubTabs />

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>FinePlay 분석 작업</h2>
          <button style={{ ...btn, marginLeft: 'auto' }} onClick={() => setPreOpen((v) => !v)}>
            {preOpen ? '－ 사전 작업 닫기' : '＋ 사전 작업 (신청 없이)'}
          </button>
          <button style={btn} onClick={pollNew} disabled={polling}>
            {polling ? '가져오는 중...' : '↺ 새 작업 가져오기'}
          </button>
          <button style={btn} onClick={() => void loadJobs()}>새로고침</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
          FinePlay 사용자가 신청한 분석 영상을 가져와(claim) 태깅하고, 서버가 클립을 만들어
          돌려보냅니다. 원본은 S3 스트리밍으로 재생되며 내려받지 않습니다.
        </p>
        {pollMsg ? <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '6px 0 0' }}>{pollMsg}</p> : null}
        {listError ? <p style={{ fontSize: 12, color: '#ef4444', margin: '6px 0 0' }}>{listError}</p> : null}
      </div>

      {preOpen ? (
        <div style={card}>
          <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>사전 작업 만들기</h3>
          <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '0 0 10px' }}>
            런칭 전 보관용 — 신청 없이 풀영상으로 하이라이트·FPA 작업을 해두면, 나중에 신청과
            연결해서 앱으로 전송합니다. 전송 전까지 콜백은 보류(held) 상태로 유지돼요.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              style={{ ...numInput, width: 160 }}
              placeholder="팀명 (우리 팀 = 홈)"
              value={preTeam}
              onChange={(e) => setPreTeam(e.target.value)}
              disabled={preBusy}
            />
            <input
              style={{ ...numInput, width: 160 }}
              placeholder="상대팀명"
              value={preOpp}
              onChange={(e) => setPreOpp(e.target.value)}
              disabled={preBusy}
            />
            <input
              style={{ ...numInput, width: 240 }}
              placeholder="매치명 (비우면 자동: [FPA | 사전] 팀 vs 상대)"
              value={preName}
              onChange={(e) => setPreName(e.target.value)}
              disabled={preBusy}
            />
            <input
              type="file"
              accept="video/mp4,video/*"
              style={{ fontSize: 12 }}
              onChange={(e) => setPreFile(e.target.files?.[0] || null)}
              disabled={preBusy}
            />
            <button style={primaryBtn} onClick={() => void createStandalone()} disabled={preBusy}>
              {preBusy ? `업로드 중 ${preProgress}%` : '생성'}
            </button>
          </div>
          {preMsg ? <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '8px 0 0' }}>{preMsg}</p> : null}
        </div>
      ) : null}

      {jobs.length === 0 ? (
        <div style={card}>
          <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
            가져온 작업이 없습니다. <strong>새 작업 가져오기</strong>로 FinePlay 대기열을 확인하세요.
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
                  {String(meta.analysis_request_id || '').startsWith('pre-') ? (
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 5,
                      background: 'rgba(245,158,11,.18)', color: '#f59e0b',
                    }}>
                      사전
                    </span>
                  ) : null}
                  <span style={{
                    fontSize: 12,
                    color: job.status === 'error' ? '#ef4444' : job.status === 'done' ? '#22c55e' : 'var(--muted, #999)',
                  }}>
                    {STATUS_LABEL[job.status] || job.status}
                  </span>
                  {meta.callback_status ? (
                    <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>· 콜백 {meta.callback_status}</span>
                  ) : null}
                  {meta.source_deleted ? (
                    <span style={{ fontSize: 12, color: 'var(--muted, #777)' }}>· 원본 삭제됨</span>
                  ) : null}
                  {job.status === 'done' ? (
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                      {meta.standalone && !meta.source_deleted ? (
                        <button
                          style={{ ...smallBtn, color: '#f87171' }}
                          title="S3 원본 삭제 (보관비 정리) — 클립·데이터는 유지, 재제작 불가"
                          onClick={() => void deleteSource(job)}
                        >
                          원본 삭제
                        </button>
                      ) : null}
                      <button
                        style={{ ...smallBtn, opacity: readiness[job.id]?.ready ? 1 : 0.45 }}
                        disabled={!readiness[job.id]?.ready}
                        title={readiness[job.id]?.ready
                          ? '아카이브 룸으로 이동 — 데이터는 그대로, 언제든 해제·수정 가능'
                          : `모든 클립에 FPA 데이터가 있어야 아카이브 가능 — 현재 ${readiness[job.id]?.clips_with_actions ?? 0}/${readiness[job.id]?.clip_count ?? '?'} 클립 완료`}
                        onClick={() => void archiveJob(job)}
                      >
                        📦 아카이브{readiness[job.id] && !readiness[job.id].ready
                          ? ` (${readiness[job.id].clips_with_actions}/${readiness[job.id].clip_count})`
                          : ''}
                      </button>
                    </span>
                  ) : null}
                  <button
                    style={{ ...smallBtn, marginLeft: job.status === 'done' ? 0 : 'auto' }}
                    onClick={() => void selectJob(job)}
                  >
                    {active ? '선택됨' : job.status === 'done' ? '다시 열기' : '태깅하기'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selected ? (
        <div style={card}>
          <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>
            태깅 — {selected.job_metadata?.display_name || selected.original_filename}
          </h3>
          {sourceError ? (
            <p style={{ fontSize: 13, color: '#ef4444' }}>원본 재생 실패: {sourceError}</p>
          ) : !sourceUrl ? (
            <p style={{ fontSize: 13, color: 'var(--muted, #999)' }}>원본 주소 가져오는 중...</p>
          ) : (
            <>
              <video
                ref={videoRef}
                src={sourceUrl}
                controls
                style={{ width: '100%', maxHeight: 480, background: '#000', borderRadius: 8 }}
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration || 0);
                  e.currentTarget.playbackRate = speed;
                }}
                onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                <button style={btn} onClick={togglePlay}>{playing ? '⏸ 정지' : '▶ 재생'}</button>
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
                <button style={primaryBtn} onClick={() => addTag('home')}>
                  ＋ 홈 {fpaTeams.home !== 'Home' ? fpaTeams.home : ''} 태깅 (A)
                </button>
                <button
                  style={{ ...btn, background: '#7c3aed', borderColor: 'transparent' }}
                  onClick={() => addTag('away')}
                >
                  ＋ 어웨이 {fpaTeams.away !== 'Away' ? fpaTeams.away : ''} 태깅 (D)
                </button>
                <span style={{ fontSize: 13, color: 'var(--muted, #999)' }}>
                  {fmt(current)} / {fmt(duration)}
                </span>
                <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                  앞 <input type="number" value={padBefore} min={0} max={60}
                    onChange={(e) => setPadBefore(Math.max(0, Number(e.target.value) || 0))} style={numInput} /> 초
                </label>
                <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  뒤 <input type="number" value={padAfter} min={1} max={60}
                    onChange={(e) => setPadAfter(Math.max(1, Number(e.target.value) || 1))} style={numInput} /> 초
                </label>
              </div>

              {tags.length ? (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {tags.map((tag, i) => (
                    <div key={tag.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                      padding: '6px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
                    }}>
                      <span style={{ color: 'var(--muted, #999)', width: 24 }}>{i + 1}</span>
                      <button
                        style={{
                          ...smallBtn,
                          background: tag.team === 'home' ? 'var(--accent, #3b82f6)' : '#7c3aed',
                          borderColor: 'transparent',
                        }}
                        title="클릭하면 홈/어웨이 전환"
                        onClick={() => toggleTagTeam(tag.id)}
                      >
                        {tag.team === 'home' ? '홈' : '어웨이'}
                      </button>
                      <button style={smallBtn} onClick={() => seekTo(tag.t)}>{fmt(tag.t)}</button>
                      <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                        클립 {fmt(Math.max(0, tag.t - padBefore))} ~ {fmt(tag.t + padAfter)}
                      </span>
                      <button
                        style={{ ...smallBtn, marginLeft: 'auto' }}
                        onClick={() => setTags((prev) => prev.filter((x) => x.id !== tag.id))}
                      >
                        삭제
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '10px 0 0' }}>
                  영상을 보며 <strong>A</strong>(홈팀) / <strong>D</strong>(어웨이팀) 키 또는
                  태깅 버튼으로 하이라이트 지점을 찍으세요.
                </p>
              )}

              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-ghost, #2c2c32)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>FPA dual 연결</span>
                  {fpaMatchId ? (
                    <>
                      <span style={{ fontSize: 13 }}>{fpaMatchName}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                        씬 {fpaSceneCount ?? '?'}개
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>우리 팀:</span>
                      {(['home', 'away'] as const).map((side) => (
                        <button
                          key={side}
                          style={fpaOurSide === side ? { ...smallBtn, background: 'var(--accent, #3b82f6)', borderColor: 'transparent' } : smallBtn}
                          onClick={() => setFpaOurSide(side)}
                        >
                          {fpaTeams[side]}
                        </button>
                      ))}
                      <button style={smallBtn} onClick={clearFpaLink}>해제</button>
                    </>
                  ) : (
                    <button style={smallBtn} onClick={() => void openFpaPicker()}>FPA 매치 연결</button>
                  )}
                </div>
                {fpaMatchId && fpaSceneCount !== null && tags.length > 0 && fpaSceneCount !== tags.length ? (
                  <p style={{ fontSize: 12, color: '#f59e0b', margin: '0 0 8px' }}>
                    클립 {tags.length}개 ↔ 씬 {fpaSceneCount}개 — 개수가 다르면 앞에서부터 순서대로만 매칭됩니다.
                  </p>
                ) : null}
                {fpaMsg ? (
                  <p style={{ fontSize: 12, color: '#f59e0b', margin: '0 0 8px' }}>{fpaMsg}</p>
                ) : null}
                {fpaPickerOpen && !fpaMatchId ? (
                  <div style={{
                    margin: '4px 0 10px', maxHeight: 220, overflowY: 'auto', borderRadius: 6,
                    border: '1px solid var(--border-ghost, #2c2c32)',
                  }}>
                    {fpaMatches.length === 0 ? (
                      <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: 0, padding: 10 }}>
                        매치 목록 불러오는 중이거나 저장된 매치가 없습니다.
                      </p>
                    ) : fpaMatches.map((m) => (
                      <div key={m.id} style={{
                        display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
                        padding: '6px 10px', borderBottom: '1px solid var(--border-ghost, #2c2c32)',
                      }}>
                        <span style={{ fontSize: 11, color: 'var(--muted, #999)', width: 46 }}>{m.competition_class}</span>
                        <span>{m.name}</span>
                        <button
                          style={{ ...smallBtn, marginLeft: 'auto' }}
                          onClick={() => { setFpaPickerOpen(false); void applyFpaMatch(m.id, fpaMatchTeams(m).home + ' vs ' + fpaMatchTeams(m).away); }}
                        >
                          선택
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button style={btn} onClick={() => void produce(false)} disabled={producing || !tags.length}>
                    {producing ? '처리 중...' : `🎬 클립 ${tags.length}개 생성만 (클립 결과에 보관)`}
                  </button>
                  {!selected?.job_metadata?.standalone ? (
                    <button style={primaryBtn} onClick={() => void produce(true)} disabled={producing || !tags.length}>
                      {producing ? '처리 중...' : '⬆ 생성 + FinePlay 전송'}
                    </button>
                  ) : null}
                  <label style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={makeVertical} onChange={(e) => setMakeVertical(e.target.checked)} />
                    세로(9:16)도 생성
                  </label>
                  {produceMsg ? (
                    <span style={{ fontSize: 13, color: producing ? 'var(--muted, #999)' : '#22c55e' }}>{produceMsg}</span>
                  ) : null}
                </div>
                {producing ? (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>서버에서 클립 렌더 · 업로드 중</span>
                      <LeaveBadge canLeave />
                    </div>
                    <ProgressBar indeterminate color="#22c55e" />
                    <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: 0 }}>
                      태깅한 구간만 서버로 보냈습니다. 렌더와 업로드는 서버가 하므로 탭을 닫아도 됩니다.
                    </p>
                  </div>
                ) : null}
                {produceError ? (
                  <div style={{
                    marginTop: 12, padding: 12, borderRadius: 8, fontSize: 13,
                    background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
                  }}>
                    실패: {produceError}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
