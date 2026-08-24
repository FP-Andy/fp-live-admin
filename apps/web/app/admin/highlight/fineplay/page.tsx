'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import HighlightSubTabs from '../HighlightSubTabs';
import { API_BASE, apiJson } from '../../../../lib/api';
import { ProgressBar, LeaveBadge } from '../../../../components/HlProgress';

// FinePlay 연동 태깅: claim 한 작업의 원본을 S3 스트리밍으로 재생하며 태깅하고,
// 구간을 서버로 보내면 서버가 클립 렌더 → S3 업로드 → 결과 콜백까지 처리한다.
// 원본을 내려받지도, 브라우저에서 자르지도 않는다.

// 산출 지시 — 신청 옵션(BASIC_HIGHLIGHT / FREE_XFP_TOKEN / XFP_SINGLE / FULL_REPORT)
// 으로 서버가 판정한다. basic 이면 FPA dual 태깅 없이 구간만 잘라 보내면 된다.
type PlanTier = 'xfp' | 'basic';
type JobPlan = { tier: PlanTier; options?: string[]; source?: string };

// 화면에서 가르는 구분. tier 는 "전송에 분석을 싣느냐" 만 답하므로 사전 작업이
// xfp 로 뭉뚱그려진다 — 실제로는 아직 신청이 안 붙어 산출 범위가 미정인 상태라
// 운영자 입장에선 셋째 갈래다. 의미(tier)는 건드리지 않고 표시만 한 겹 나눈다.
type PlanView = PlanTier | 'standalone';

type FpJob = {
  id: string;
  status: string;
  plan?: JobPlan | null;
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
    // 사전 작업 신청 연결 — 한 태깅본을 홈/어웨이 두 신청으로 내보낸다.
    links?: Partial<Record<'home' | 'away', {
      analysis_request_id?: string;
      team_id?: string | null;
      team_name?: string | null;
      callback_status?: string | null;
      plan?: JobPlan | null;
      plan_tier?: PlanTier;
      player_match?: string;
    }>> | null;
  } | null;
};

const XFP_OPTION_TYPES = ['FREE_XFP_TOKEN', 'XFP_SINGLE', 'FULL_REPORT'];

function planTier(job: FpJob): PlanTier {
  return job.plan?.tier === 'basic' ? 'basic' : 'xfp';
}

// 사전 작업을 먼저 걸러낸다 — tier 는 xfp 지만 그건 "태깅은 xFP 기준으로 한다" 는
// 작업 지시일 뿐이고, 전송 범위는 연결된 신청의 옵션이 정한다.
function planView(job: FpJob): PlanView {
  if (job.plan?.source === 'standalone') return 'standalone';
  return planTier(job);
}

// 배지 문구 — 옵션명을 그대로 보여줘야 운영자가 "왜 이렇게 판정됐는지" 안다.
function planBadge(job: FpJob): { label: string; color: string; bg: string; title: string } {
  const plan = job.plan;
  const opts = (plan?.options || []).filter((o) => XFP_OPTION_TYPES.includes(o));
  if (plan?.source === 'standalone') {
    return {
      label: '🔵 사전작업 (옵션 대기)',
      color: '#a78bfa',
      bg: 'rgba(167,139,250,.16)',
      title: '사전 작업 — 태깅은 xFP 기준으로 하고, 전송 범위는 연결된 신청의 옵션으로 정해진다',
    };
  }
  if (plan?.tier === 'basic') {
    return {
      label: '⚪ 하이라이트만',
      color: '#9ca3af',
      bg: 'rgba(156,163,175,.16)',
      title: plan?.source === 'none'
        ? '신청 옵션 정보가 없어 하이라이트만으로 판정 (안전 폴백)'
        : 'BASIC_HIGHLIGHT 단독 신청 — FPA dual 태깅 불필요, 클립 영상만 전송된다',
    };
  }
  return {
    label: `🟣 xFP 분석${opts.length ? ` · ${opts.join(', ')}` : ''}`,
    color: '#c084fc',
    bg: 'rgba(192,132,252,.16)',
    title: 'xFP 산출 신청 — FPA dual 태깅까지 하고 채점·씬모션이 함께 전송된다',
  };
}

const badgeStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 5, whiteSpace: 'nowrap',
};

// team: 태깅 시점에 확정하는 클립 귀속 팀 (A=홈 / D=어웨이).
// padBefore/padAfter: 태그별 앞/뒤 초 오버라이드 — 없으면 전역 기본값을 쓴다.
// videoIdx/videoId: 다중 영상 신청에서 태그가 찍힌 원본(탭). clampEnd: 그 영상 길이(끝 넘김 방지).
type Tag = {
  id: string; t: number; team: 'home' | 'away';
  padBefore?: number; padAfter?: number;
  videoIdx: number; videoId?: string; clampEnd?: number;
};

// 신청 원본 영상 하나 — 앱이 보낸 순서(videos[] index)가 곧 경기 순서(전반/후반 등).
type SourceVideo = { videoId?: string; url: string; durationSeconds?: number | null };

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

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// --- 사전 작업 원본 업로드 ---
// 단일 PUT 은 TCP 연결 하나라, 회선을 다른 트래픽(드라이브 동기화 등)과 나눠 쓰면
// 그대로 주저앉는다. 큰 파일은 멀티파트로 쪼개 파트를 동시에 올린다. 5GB 한도도 사라진다.
const MB = 1024 * 1024;
const MULTIPART_MIN = 64 * MB; // 이보다 작으면 단일 PUT (파트 왕복이 더 비싸다)
const PART_SIZE_MIN = 32 * MB; // S3 최소 5MB. 32MB면 10GB=320파트로 상한(10000) 여유.
const UPLOAD_CONCURRENCY = 4;
const PART_RETRY = 4;
// 업링크가 다른 트래픽에 굶으면 전송이 에러 없이 그냥 멈춘 채로 남는다(진행률 정지).
// 일정 시간 진척이 없으면 그 파트를 끊고 다시 올린다.
const PART_STALL_MS = 60_000;

function partSizeFor(fileSize: number): number {
  // 파트 수 상한 10000 — 초대형 파일이면 파트를 키운다.
  return Math.max(PART_SIZE_MIN, Math.ceil(fileSize / 10000 / MB) * MB);
}

// 파트 하나 PUT. ETag 를 돌려줘야 완료 요청에서 순서를 맞출 수 있다.
function putPart(url: string, blob: Blob, onLoaded: (bytes: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastTick = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastTick < PART_STALL_MS) return;
      clearInterval(watchdog);
      xhr.abort(); // onabort 가 reject → 상위에서 이 파트만 재시도
    }, 5_000);
    const settle = (fn: () => void) => { clearInterval(watchdog); fn(); };

    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      lastTick = Date.now();
      if (e.lengthComputable) onLoaded(e.loaded);
    };
    xhr.onload = () => settle(() => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`파트 업로드 실패 (${xhr.status})`));
        return;
      }
      const etag = xhr.getResponseHeader('ETag');
      if (!etag) {
        reject(new Error('파트 ETag 를 읽지 못했습니다 — 버킷 CORS 의 ExposeHeaders 에 ETag 를 추가하세요.'));
        return;
      }
      resolve(etag);
    });
    xhr.onerror = () => settle(() => reject(new Error('파트 네트워크 오류')));
    xhr.onabort = () => settle(() => reject(new Error(`${PART_STALL_MS / 1000}초간 전송 정체 — 파트 재시도`)));
    xhr.send(blob);
  });
}

// 업로드 전 로컬에서 영상 길이를 읽는다 — 매니페스트에 넣어두면 태깅 탭이
// 파일을 로드하기 전에도 길이를 보여준다. 실패해도 0 (선택 항목이라 무해).
function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    const done = (sec: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(sec) && sec > 0 ? sec : 0);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(0);
    el.src = url;
  });
}

// 기록지 한 파일(= 한 라운드) 을 사전 작업 여러 건에 한 번에 넣을 때의 시트별 결과.
type BulkSheetSide = { team: string; formation: string; count: number };
type BulkSheetResult = {
  sheet: string;
  matchNo?: string;
  status: 'matched' | 'applied' | 'unmatched' | 'skipped' | 'error';
  reason?: string;
  home?: BulkSheetSide;
  away?: BulkSheetSide;
  job_id?: string;
  job_name?: string;
  swap?: boolean;
  sides?: Record<string, { team: string; formation: string; starters: number; subs: number }>;
};
type BulkJobOption = { job_id: string; name: string; home_team: string; away_team: string };
type BulkResponse = {
  applied: boolean;
  filename: string;
  total: number;
  matched: number;
  unmatched: number;
  results: BulkSheetResult[];
  jobs: BulkJobOption[];
};

export default function FineplayJobsPage() {
  const [jobs, setJobs] = useState<FpJob[]>([]);
  // 산출 지시 필터 — 하이라이트만·xFP·사전 작업은 작업 내용이 서로 다르다. 룸을
  // 나누는 대신 한 목록에서 걸러 본다(잡의 tier 는 사전 작업 연결로 바뀔 수 있어서).
  const [tierFilter, setTierFilter] = useState<'all' | PlanView>('all');
  // 잡별 아카이브 준비상태 — 모든 클립에 FPA 데이터가 있어야 버튼 활성화.
  const [readiness, setReadiness] = useState<Record<string, { clip_count: number; clips_with_actions: number; ready: boolean; needs_fpa?: boolean }>>({});
  const [listError, setListError] = useState('');
  const [polling, setPolling] = useState(false);
  const [pollMsg, setPollMsg] = useState('');

  // 사전 작업(신청 없이) 생성 — 런칭 전 풀영상을 직접 올려 보관용 잡·매치를 만든다.
  const [preOpen, setPreOpen] = useState(false);
  const [preTeam, setPreTeam] = useState('');
  const [preOpp, setPreOpp] = useState('');
  const [preName, setPreName] = useState('');
  // 영상은 여러 개(전반/후반 분리 촬영 등) — 목록 순서가 곧 경기 순서이자 태깅 탭 순서.
  const [preFiles, setPreFiles] = useState<File[]>([]);
  const [preBusy, setPreBusy] = useState(false);
  const [preProgress, setPreProgress] = useState(0);
  const [preUploadIdx, setPreUploadIdx] = useState(0);
  const [preMsg, setPreMsg] = useState('');

  const [selected, setSelected] = useState<FpJob | null>(null);
  // 다중 영상 신청: 영상 탭으로 전환하며 태깅한다. sourceUrl 은 현재 탭에서 파생.
  const [sourceVideos, setSourceVideos] = useState<SourceVideo[]>([]);
  const [activeVideoIdx, setActiveVideoIdx] = useState(0);
  const sourceUrl = sourceVideos[activeVideoIdx]?.url || '';
  // 탭 전환 후 이어서 시킹할 시간(다른 영상의 태그 클릭) — 메타데이터 로드 시 적용.
  const pendingSeekRef = useRef<number | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const [tags, setTags] = useState<Tag[]>([]);
  const [padBefore, setPadBefore] = useState(9);
  const [padAfter, setPadAfter] = useState(2);
  // 전역 앞/뒤 초 기본값 유지 — 브라우저별 저장(서버 설정 아님), 태그별 오버라이드와 별개.
  // 키에 -v2 를 붙인 이유: 기본값을 7/4 → 9/2 로 바꿨는데, 옛 키를 그대로 두면
  // 이미 쓰던 브라우저는 저장된 7/4 를 계속 불러와 새 기본값이 적용되지 않는다.
  useEffect(() => {
    const rawB = localStorage.getItem('fp-clip-pad-before-v2');
    const rawA = localStorage.getItem('fp-clip-pad-after-v2');
    const b = Number(rawB);
    const a = Number(rawA);
    if (rawB !== null && Number.isFinite(b) && b >= 0) setPadBefore(b);
    if (rawA !== null && Number.isFinite(a) && a >= 1) setPadAfter(a);
  }, []);
  useEffect(() => { localStorage.setItem('fp-clip-pad-before-v2', String(padBefore)); }, [padBefore]);
  useEffect(() => { localStorage.setItem('fp-clip-pad-after-v2', String(padAfter)); }, [padAfter]);
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
      // brief=1: 목록은 result_payload(8~16KB)·clips 를 안 쓴다. 이걸 빼지 않으면
      // 태깅이 끝난 job 이 늘수록 목록 조회가 느려진다
      // (2026-08-05 실측: 31건에 13초, 응답 211KB → 41KB).
      // 상세는 아래 /highlight/jobs/{id} 폴링이 따로 가져오므로 화면 동작은 그대로다.
      const rows = await apiJson<FpJob[]>('/highlight/jobs?mode=fineplay&limit=100&brief=1');
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

  // 파일 하나를 presign 받아 S3 로 직접 올리고 키·길이를 돌려준다.
  // 진행률 표시를 위해 XHR 사용 (presigned URL 이라 쿠키 불필요).
  const uploadSinglePut = async (file: File) => {
    const presign = await apiJson<{ upload_url: string; s3_key: string; content_type: string }>(
      '/highlight/fineplay-jobs/standalone/upload-url',
      { method: 'POST', body: JSON.stringify({ file_name: file.name }) },
    );
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', presign.upload_url);
      xhr.setRequestHeader('Content-Type', presign.content_type);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setPreProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`업로드 실패 — ${file.name} (${xhr.status})`)));
      xhr.onerror = () => reject(new Error(`업로드 네트워크 오류 — ${file.name}`));
      xhr.send(file);
    });
    return presign.s3_key;
  };

  // 큰 파일: 파트를 UPLOAD_CONCURRENCY 개씩 동시에 올린다.
  const uploadMultipart = async (file: File) => {
    const partSize = partSizeFor(file.size);
    const partCount = Math.ceil(file.size / partSize);
    const start = await apiJson<{
      s3_key: string; upload_id: string; urls: { part_number: number; url: string }[];
    }>('/highlight/fineplay-jobs/standalone/multipart/start', {
      method: 'POST',
      body: JSON.stringify({ file_name: file.name, part_count: partCount }),
    });
    const urlOf = new Map(start.urls.map((u) => [u.part_number, u.url]));

    const loaded = new Array<number>(partCount).fill(0);
    const etags = new Array<string>(partCount);
    // 파트 4개가 각자 progress 를 쏘므로 퍼센트가 바뀔 때만 setState.
    let shown = -1;
    const report = () => {
      const sum = loaded.reduce((a, b) => a + b, 0);
      const pct = Math.min(99, Math.round((sum / file.size) * 100));
      if (pct !== shown) { shown = pct; setPreProgress(pct); }
    };

    let nextPart = 0;
    const worker = async () => {
      for (let i = nextPart++; i < partCount; i = nextPart++) {
        const blob = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
        const url = urlOf.get(i + 1);
        if (!url) throw new Error(`파트 URL 누락 (${i + 1})`);
        // 긴 업로드는 파트 하나쯤 끊기거나 멈춘다 — 그 파트만 다시 올린다(전체 재업로드 아님).
        for (let attempt = 1; ; attempt += 1) {
          try {
            etags[i] = await putPart(url, blob, (bytes) => { loaded[i] = bytes; report(); });
            loaded[i] = blob.size;
            report();
            break;
          } catch (err) {
            loaded[i] = 0;
            report();
            if (attempt >= PART_RETRY) throw err;
            // 진행률만 보면 멈춘 것처럼 보이므로 재시도 중임을 알린다.
            setPreMsg(`파트 ${i + 1}/${partCount} 재시도 ${attempt}/${PART_RETRY - 1} — ${
              err instanceof Error ? err.message : String(err)}`);
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, partCount) }, () => worker()),
      );
      await apiJson('/highlight/fineplay-jobs/standalone/multipart/complete', {
        method: 'POST',
        body: JSON.stringify({
          s3_key: start.s3_key,
          upload_id: start.upload_id,
          parts: etags.map((etag, i) => ({ part_number: i + 1, etag })),
        }),
      });
    } catch (err) {
      // 중단해두지 않으면 올라간 파트가 계속 보관비로 남는다.
      try {
        await apiJson('/highlight/fineplay-jobs/standalone/multipart/abort', {
          method: 'POST',
          body: JSON.stringify({ s3_key: start.s3_key, upload_id: start.upload_id }),
        });
      } catch {
        // 중단 실패는 원래 에러를 덮지 않는다 (버킷 수명주기 규칙으로도 정리된다).
      }
      throw err instanceof Error ? new Error(`${file.name}: ${err.message}`) : err;
    }
    setPreProgress(100);
    return start.s3_key;
  };

  const uploadPreFile = async (file: File) => {
    const s3_key = file.size > MULTIPART_MIN
      ? await uploadMultipart(file)
      : await uploadSinglePut(file);
    return { s3_key, duration_seconds: await readVideoDuration(file) };
  };

  const createStandalone = async () => {
    if (!preTeam.trim() || !preOpp.trim() || !preFiles.length) {
      setPreMsg('팀명·상대팀명·영상 파일을 모두 입력하세요.');
      return;
    }
    setPreBusy(true);
    setPreMsg('');
    setPreProgress(0);
    setPreUploadIdx(0);
    try {
      // 순차 업로드 — 동시에 올리면 진행률이 뒤섞이고 업링크만 나눠 먹는다.
      const videos: { s3_key: string; duration_seconds: number }[] = [];
      for (let i = 0; i < preFiles.length; i += 1) {
        setPreUploadIdx(i);
        setPreProgress(0);
        videos.push(await uploadPreFile(preFiles[i]));
      }
      const res = await apiJson<{ job_id: string; analysis_request_id: string }>(
        '/highlight/fineplay-jobs/standalone',
        {
          method: 'POST',
          body: JSON.stringify({
            team_name: preTeam.trim(),
            opponent_name: preOpp.trim(),
            match_name: preName.trim(),
            // 순서 = 경기 순서. 태깅 화면의 영상 탭도 이 순서를 따른다.
            videos,
          }),
        },
      );
      setPreMsg(
        `사전 작업 생성 완료 — ${res.job_id} (영상 ${videos.length}개). 목록에서 태깅을 시작하세요.`,
      );
      setPreTeam('');
      setPreOpp('');
      setPreName('');
      setPreFiles([]);
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

  // 작업이 끝난 잡을 아카이브 룸으로 보낸다 — 이 목록과 '클립 결과' 양쪽에서 빠진다 (데이터는 그대로).
  const archiveJob = async (job: FpJob) => {
    try {
      await apiJson(`/highlight/fineplay-jobs/${job.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived: true }),
      });
      setPollMsg(`아카이브 완료 — ${job.id}. 클립 결과 목록에서도 빠지고 '아카이브' 탭으로 이동합니다.`);
      await loadJobs();
    } catch (err) {
      setPollMsg(err instanceof Error ? err.message : String(err));
    }
  };

  // 경기기록지(xlsx)에서 라인업 채우기 — 신청이 없는 사전 작업은 라인업이 비어 있어
  // 태깅 등번호 검증이 돌지 않는다. 기록지 시트 하나가 경기 하나에 대응한다.
  type SheetRow = {
    sheet: string; matchNo?: string; usable?: boolean; error?: string;
    home?: { team: string; count: number }; away?: { team: string; count: number };
  };
  const [sheetFile, setSheetFile] = useState<File | null>(null);
  const [sheetRows, setSheetRows] = useState<SheetRow[]>([]);
  const [sheetSwap, setSheetSwap] = useState(false);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetMsg, setSheetMsg] = useState('');

  // sheet 를 비워 보내면 저장 없이 목록만 온다 — 어느 경기인지 고르게 하려고.
  const postSheet = async (job: FpJob, file: File, sheet: string) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('sheet', sheet);
    fd.append('swap', String(sheetSwap));
    const res = await fetch(
      `${API_BASE}/highlight/fineplay-jobs/${job.id}/lineup/from-record-sheet`,
      { method: 'POST', body: fd, credentials: 'include' },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || `업로드 실패 (${res.status})`);
    return data as { applied: boolean; sheets: SheetRow[]; sides?: Record<string, { team: string; count: number }> };
  };

  const loadSheets = async (job: FpJob, file: File) => {
    setSheetBusy(true); setSheetMsg(''); setSheetRows([]);
    try {
      const data = await postSheet(job, file, '');
      setSheetFile(file);
      setSheetRows(data.sheets || []);
      setSheetMsg(`시트 ${data.sheets?.length ?? 0}개 — 이 경기에 해당하는 시트를 고르세요.`);
    } catch (err) {
      setSheetMsg(err instanceof Error ? err.message : String(err));
    } finally { setSheetBusy(false); }
  };

  const applySheet = async (job: FpJob, sheet: string) => {
    if (!sheetFile) return;
    setSheetBusy(true); setSheetMsg('');
    try {
      const data = await postSheet(job, sheetFile, sheet);
      const parts = Object.entries(data.sides || {})
        .map(([s, v]) => `${s === 'home' ? '홈' : '어웨이'} ${v.team} ${v.count}명`);
      setSheetMsg(`${sheet} 적용 완료 — ${parts.join(' · ')}`);
      await loadJobs();
    } catch (err) {
      setSheetMsg(err instanceof Error ? err.message : String(err));
    } finally { setSheetBusy(false); }
  };

  // 사전 작업 신청 연결 — 사이드별(홈/어웨이)로 FinePlay 신청을 붙인다.
  const [linkJobId, setLinkJobId] = useState<string | null>(null);
  const [linkSide, setLinkSide] = useState<'home' | 'away'>('home');
  const [linkRid, setLinkRid] = useState('');
  const [linkTeamId, setLinkTeamId] = useState('');
  const [linkTeamName, setLinkTeamName] = useState('');
  const [linkManual, setLinkManual] = useState(false);
  // 수동 연결의 산출 지시 — claim 이 되면 매니페스트 옵션이 이겨서 이 값은 무시된다.
  // 끄면 그 사이드는 하이라이트만(채점·씬모션 미전송) 나간다.
  const [linkXfp, setLinkXfp] = useState(true);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMsg, setLinkMsg] = useState('');

  const saveLink = async (job: FpJob) => {
    if (!linkRid.trim()) {
      setLinkMsg('analysisRequestId 를 입력하세요.');
      return;
    }
    setLinkBusy(true);
    setLinkMsg('');
    try {
      await apiJson(`/highlight/fineplay-jobs/${job.id}/links/${linkSide}`, {
        method: 'PUT',
        body: JSON.stringify({
          analysisRequestId: linkRid.trim(),
          teamId: linkTeamId.trim(),
          teamName: linkTeamName.trim(),
          manual: linkManual,
          options: linkXfp
            ? [{ optionType: 'BASIC_HIGHLIGHT', selected: true }, { optionType: 'XFP_SINGLE', selected: true }]
            : [{ optionType: 'BASIC_HIGHLIGHT', selected: true }],
        }),
      });
      setLinkMsg(`${linkSide === 'home' ? '홈' : '어웨이'} 연결 완료`);
      setLinkRid('');
      setLinkTeamId('');
      setLinkTeamName('');
      await loadJobs();
    } catch (err) {
      setLinkMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkBusy(false);
    }
  };

  const removeLink = async (job: FpJob, side: 'home' | 'away') => {
    try {
      await apiJson(`/highlight/fineplay-jobs/${job.id}/links/${side}`, { method: 'DELETE' });
      await loadJobs();
    } catch (err) {
      setLinkMsg(err instanceof Error ? err.message : String(err));
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
    setSourceVideos([]);
    setActiveVideoIdx(0);
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
      const res = await apiJson<{ url: string; videoId?: string; videos?: SourceVideo[] }>(
        `/highlight/fineplay-jobs/${job.id}/source-url`,
      );
      setSourceVideos(res.videos?.length ? res.videos : [{ videoId: res.videoId, url: res.url }]);
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : String(err));
    }
  };

  // 영상 탭 전환 — 태그는 유지되고, 새로 찍는 태그만 이 영상에 귀속된다.
  const switchVideo = (idx: number, seekT?: number) => {
    if (idx === activeVideoIdx) {
      if (seekT !== undefined) seekTo(seekT);
      return;
    }
    pendingSeekRef.current = seekT ?? null;
    setActiveVideoIdx(idx);
    setDuration(sourceVideos[idx]?.durationSeconds || 0);
    setCurrent(seekT ?? 0);
    setPlaying(false);
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

  // 이 시각에 닿으면 자동으로 멈춘다. 클립 미리보기 중에만 값이 들어간다.
  const stopAtRef = useRef<number | null>(null);
  // 미리보기가 스스로 건 seek 인지 구분한다. 이게 없으면 미리보기 시작 시의 seek 이
  // 자기 자신의 정지 예약을 지워버린다.
  const autoSeekRef = useRef(false);

  // 태그 하나가 실제로 잘려나갈 구간. produce 로 보내는 계산과 반드시 같아야 해서
  // 여기 한 곳에서만 만든다 — 미리보기와 결과물이 어긋나면 태거가 헛것을 보게 된다.
  const clipRangeOf = useCallback((tag: Tag) => {
    const before = tag.padBefore ?? padBefore;
    const after = tag.padAfter ?? padAfter;
    const cap = tag.clampEnd || (tag.videoIdx === activeVideoIdx ? duration : 0);
    return {
      start: Math.max(0, tag.t - before),
      end: Math.min(cap || tag.t + after, tag.t + after),
    };
  }, [padBefore, padAfter, activeVideoIdx, duration]);

  // 태그를 누르면 태그 시각이 아니라 "클립 시작"으로 가서 끝까지 재생하고 멈춘다.
  const previewClip = (tag: Tag) => {
    const { start, end } = clipRangeOf(tag);
    autoSeekRef.current = true;
    stopAtRef.current = end;
    switchVideo(tag.videoIdx ?? 0, start);
    const v = videoRef.current;
    if (!v) return;
    // 태그 목록은 영상 아래에 있다. 목록을 내려보다 눌렀을 때
    // 영상이 화면 밖이면 재생돼도 못 보니 같이 올려준다.
    v.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if ((tag.videoIdx ?? 0) === activeVideoIdx) void v.play();
  };

  const addTag = useCallback((team: 'home' | 'away') => {
    const v = videoRef.current;
    if (!v || !sourceUrl) return;
    const t = v.currentTime;
    const tag: Tag = {
      id: `${Date.now()}-${Math.random()}`,
      t,
      team,
      videoIdx: activeVideoIdx,
      videoId: sourceVideos[activeVideoIdx]?.videoId,
      clampEnd: v.duration || sourceVideos[activeVideoIdx]?.durationSeconds || undefined,
    };
    // 전역 순서 = (영상 순서, 시간) — 영상별 타임라인이 각자 0부터라 시간만으론 섞인다.
    setTags((prev) => [...prev, tag]
      .sort((a, b) => (a.videoIdx - b.videoIdx) || (a.t - b.t)));
  }, [sourceUrl, activeVideoIdx, sourceVideos]);

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
      // 한글 자판이면 e.key 가 'ㅁ'·'ㅇ' 으로 오고, IME 상태에 따라 'Process' 로 오기도 한다.
      // e.code 는 자판 배열과 무관하게 물리 키 위치를 주므로 그걸 먼저 본다.
      if (e.code === 'KeyA' || e.key === 'a' || e.key === 'A' || e.key === 'ㅁ') {
        e.preventDefault();
        addTag('home');
        return;
      }
      if (e.code === 'KeyD' || e.key === 'd' || e.key === 'D' || e.key === 'ㅇ') {
        e.preventDefault();
        addTag('away');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekTo, addTag, sourceUrl]);

  // 생성만 한다. FinePlay 전송은 클립 결과 탭에서만 — 여기서 sendCallback 을
  // 켤 일이 없어 아예 상수로 굳힌다(전송 창구는 한 곳이어야 한다).
  const produce = async () => {
    const sendCallback = false;
    if (!selected || !tags.length || producing) return;
    setProducing(true);
    setProduceError('');
    try {
      const clips = tags.map((tag) => {
        // 화면에서 미리보기로 확인한 구간과 정확히 같은 값을 보낸다.
        const { start, end } = clipRangeOf(tag);
        return {
          start,
          end,
          team: tag.team,
          makeVertical,
          sourceVideoId: tag.videoId,
        };
      });
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

  // ── 기록지 일괄 등록 (사전 작업 전용) ──────────────────────────────────────
  // 한 라운드가 한 파일이고 시트 하나가 경기 하나라, 6경기를 한 번에 넣는다.
  // 먼저 미리보기(저장 없음)로 어느 시트가 어느 작업에 붙는지 확인한 뒤 적용한다.
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResponse | null>(null);
  const [bulkPicks, setBulkPicks] = useState<Record<string, string>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState('');

  const runBulkSheet = async (file: File, apply: boolean) => {
    setBulkBusy(true);
    setBulkMsg(apply ? '기록지 적용 중…' : '기록지 읽는 중…');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('apply', apply ? 'true' : 'false');
      // 자동 매칭이 실패했거나 잘못 붙은 시트만 수동 지정으로 덮어쓴다.
      const picks = Object.fromEntries(Object.entries(bulkPicks).filter(([, v]) => v));
      if (Object.keys(picks).length) form.append('assignments', JSON.stringify(picks));
      const res = await fetch(`${API_BASE}/highlight/record-sheet/lineup/bulk`, {
        method: 'POST', credentials: 'include', body: form,
      });
      if (!res.ok) {
        setBulkMsg((await res.text()) || '기록지 처리 실패');
        return;
      }
      const data = await res.json() as BulkResponse;
      setBulkResult(data);
      const applied = data.results.filter((r) => r.status === 'applied').length;
      setBulkMsg(apply
        ? `적용 완료 — 시트 ${data.total}장 중 ${applied}건 등록${data.unmatched ? ` · 미매칭 ${data.unmatched}건` : ''}`
        : `미리보기 — 시트 ${data.total}장 중 ${data.matched}건 자동 매칭${data.unmatched ? ` · ${data.unmatched}건은 작업을 직접 고르세요` : ''}`);
      if (apply) void loadJobs();
    } catch (err) {
      setBulkMsg(err instanceof Error ? err.message : '기록지 처리 실패');
    } finally {
      setBulkBusy(false);
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
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, border: '1px dashed var(--border-ghost, #2c2c32)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>📋 기록지 일괄 등록</span>
            <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>한 파일의 모든 시트를 사전 작업에 한 번에 — 시트 1장 = 경기 1건</span>
            <input
              type="file"
              accept=".xlsx,.xlsm"
              disabled={bulkBusy}
              style={{ fontSize: 12, marginLeft: 'auto' }}
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                setBulkFile(f);
                setBulkResult(null);
                setBulkPicks({});
                setBulkMsg('');
                if (f) void runBulkSheet(f, false);
              }}
            />
          </div>

          {bulkResult ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {bulkResult.results.map((r) => {
                const tone = r.status === 'applied' ? '#4ade80'
                  : r.status === 'matched' ? 'var(--muted, #999)'
                    : r.status === 'unmatched' ? '#fbbf24' : '#f87171';
                return (
                  <div key={r.sheet} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
                    <span style={{ width: 74, color: 'var(--muted, #999)' }}>{r.sheet}</span>
                    <span style={{ minWidth: 260, flex: 1 }}>
                      {r.home ? `${r.home.team} (${r.home.formation || '-'}) vs ${r.away?.team} (${r.away?.formation || '-'})` : r.reason}
                    </span>
                    {r.status === 'unmatched' ? (
                      <select
                        value={bulkPicks[r.sheet] || ''}
                        disabled={bulkBusy}
                        style={{ fontSize: 12, maxWidth: 260 }}
                        onChange={(e) => setBulkPicks((prev) => ({ ...prev, [r.sheet]: e.target.value }))}
                      >
                        <option value="">작업 직접 고르기…</option>
                        {bulkResult.jobs.map((j) => (
                          <option key={j.job_id} value={j.job_id}>{j.name}</option>
                        ))}
                      </select>
                    ) : (
                      <span style={{ color: tone }}>
                        {r.status === 'applied' ? '✓ 등록됨' : r.status === 'matched' ? '→ ' : ''}
                        {r.job_name || ''}{r.swap ? ' (홈/어웨이 뒤집어 적용)' : ''}
                      </span>
                    )}
                    {r.status === 'unmatched' ? (
                      <span style={{ color: tone }} title={r.reason}>⚠ {r.reason}</span>
                    ) : null}
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  style={smallBtn}
                  disabled={bulkBusy || !bulkFile}
                  onClick={() => bulkFile && void runBulkSheet(bulkFile, false)}
                >다시 미리보기</button>
                <button
                  style={smallBtn}
                  disabled={bulkBusy || !bulkFile || !bulkResult.results.some((r) => r.status === 'matched')}
                  onClick={() => bulkFile && void runBulkSheet(bulkFile, true)}
                  title="매칭된 시트의 라인업을 각 사전 작업에 저장합니다"
                >매칭된 것 모두 등록</button>
              </div>
            </div>
          ) : null}

          {bulkMsg ? <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: 0 }}>{bulkMsg}</p> : null}
          <p style={{ fontSize: 12, color: 'var(--muted, #777)', margin: 0 }}>
            홈/어웨이 팀명 두 개로 사전 작업을 찾습니다. 제목은 바뀔 수 있어 쓰지 않습니다.
            기록지의 포지션(LCB·RDM 등)이 그대로 저장돼 dual 태깅의 “before 에 배치”가 그 자리에 깝니다.
          </p>
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
              multiple
              // 여러 번 나눠 고를 수 있게 이어붙인다. 같은 파일을 다시 고르면
              // onChange 가 안 뜨므로 value 를 비워 재선택도 받는다.
              style={{ fontSize: 12 }}
              onChange={(e) => {
                const picked = Array.from(e.target.files || []);
                if (picked.length) setPreFiles((prev) => [...prev, ...picked]);
                e.target.value = '';
              }}
              disabled={preBusy}
            />
            <button style={primaryBtn} onClick={() => void createStandalone()} disabled={preBusy}>
              {preBusy
                ? `업로드 중 ${preUploadIdx + 1}/${preFiles.length} — ${preProgress}%`
                : '생성'}
            </button>
          </div>
          {preFiles.length ? (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                위에서부터 경기 순서 — 태깅 화면의 영상 탭 순서가 됩니다.
              </span>
              {preFiles.map((f, i) => (
                <div
                  key={`${f.name}-${f.size}-${i}`}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}
                >
                  <span style={{ color: 'var(--muted, #999)', minWidth: 46 }}>영상 {i + 1}</span>
                  <span style={{ flex: 1, wordBreak: 'break-all' }}>{f.name}</span>
                  <span style={{ color: 'var(--muted, #999)' }}>
                    {(f.size / 1024 / 1024).toFixed(0)}MB
                  </span>
                  <button
                    style={smallBtn}
                    disabled={preBusy || i === 0}
                    onClick={() => setPreFiles((prev) => moveItem(prev, i, i - 1))}
                  >
                    ↑
                  </button>
                  <button
                    style={smallBtn}
                    disabled={preBusy || i === preFiles.length - 1}
                    onClick={() => setPreFiles((prev) => moveItem(prev, i, i + 1))}
                  >
                    ↓
                  </button>
                  <button
                    style={smallBtn}
                    disabled={preBusy}
                    onClick={() => setPreFiles((prev) => prev.filter((_, j) => j !== i))}
                  >
                    삭제
                  </button>
                </div>
              ))}
            </div>
          ) : null}
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
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {([
              ['all', `전체 ${jobs.length}`],
              ['xfp', `🟣 xFP ${jobs.filter((j) => planView(j) === 'xfp').length}`],
              ['basic', `⚪ 하이라이트만 ${jobs.filter((j) => planView(j) === 'basic').length}`],
              ['standalone', `🔵 사전작업 ${jobs.filter((j) => planView(j) === 'standalone').length}`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                style={{
                  ...smallBtn,
                  background: tierFilter === key ? 'var(--button-dark, #2a2a30)' : 'transparent',
                  border: `1px solid ${tierFilter === key ? 'var(--accent, #3b82f6)' : 'var(--border-ghost, #2c2c32)'}`,
                }}
                onClick={() => setTierFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {jobs.filter((j) => tierFilter === 'all' || planView(j) === tierFilter).map((job) => {
              const meta = job.job_metadata || {};
              const active = selected?.id === job.id;
              const badge = planBadge(job);
              return (
                <div key={job.id}>
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                    padding: '8px 10px', borderRadius: 6,
                    background: active ? 'var(--button-dark, #2a2a30)' : 'var(--surface-input, #16161a)',
                    border: active ? '1px solid var(--accent, #3b82f6)' : '1px solid transparent',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{meta.display_name || job.original_filename}</span>
                  <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>#{meta.analysis_request_id}</span>
                  <span style={{ ...badgeStyle, background: badge.bg, color: badge.color }} title={badge.title}>
                    {badge.label}
                  </span>
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
                          ? '아카이브 룸으로 이동 — 이 목록과 클립 결과에서 빠집니다. 데이터는 그대로, 언제든 해제·수정 가능'
                          : `모든 클립에 FPA 데이터가 있어야 아카이브 가능 — 현재 ${readiness[job.id]?.clips_with_actions ?? 0}/${readiness[job.id]?.clip_count ?? '?'} 클립 완료 (하이라이트만 신청은 이 조건이 면제됩니다)`}
                        onClick={() => void archiveJob(job)}
                      >
                        📦 아카이브{readiness[job.id] && !readiness[job.id].ready
                          ? ` (${readiness[job.id].clips_with_actions}/${readiness[job.id].clip_count})`
                          : ''}
                      </button>
                    </span>
                  ) : null}
                  {meta.standalone ? (
                    <button
                      style={smallBtn}
                      title="FinePlay 신청을 홈/어웨이 사이드별로 연결 — 전송 시 각 팀 관점으로 나간다"
                      onClick={() => {
                        setLinkMsg('');
                        setLinkJobId((prev) => (prev === job.id ? null : job.id));
                      }}
                    >
                      🔗 신청 연결{meta.links ? ` (${Object.keys(meta.links).length}/2)` : ''}
                    </button>
                  ) : null}
                  <button
                    style={{ ...smallBtn, marginLeft: job.status === 'done' ? 0 : 'auto' }}
                    onClick={() => void selectJob(job)}
                  >
                    {active ? '선택됨' : job.status === 'done' ? '다시 열기' : '태깅하기'}
                  </button>
                </div>
                {meta.standalone && linkJobId === job.id ? (
                  <div style={{
                    margin: '4px 0 4px 12px', padding: '10px 12px', borderRadius: 6,
                    background: 'var(--surface-input, #16161a)', border: '1px dashed var(--border-ghost, #2c2c32)',
                    display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13,
                  }}>
                    {(['home', 'away'] as const).map((side) => {
                      const link = meta.links?.[side];
                      return (
                        <div key={side} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 44, fontWeight: 600 }}>{side === 'home' ? '홈' : '어웨이'}</span>
                          {link ? (
                            <>
                              <span>#{link.analysis_request_id}</span>
                              {link.team_name ? <span style={{ color: 'var(--muted, #999)' }}>{link.team_name}</span> : null}
                              <span style={{
                                ...badgeStyle,
                                background: (link.plan?.tier ?? link.plan_tier) === 'basic' ? 'rgba(156,163,175,.16)' : 'rgba(192,132,252,.16)',
                                color: (link.plan?.tier ?? link.plan_tier) === 'basic' ? '#9ca3af' : '#c084fc',
                              }}>
                                {(link.plan?.tier ?? link.plan_tier) === 'basic' ? '하이라이트만' : 'xFP'}
                              </span>
                              {link.player_match ? (
                                <span
                                  style={{ fontSize: 12, color: link.player_match.startsWith('0/') ? '#f59e0b' : 'var(--muted, #999)' }}
                                  title="전송 시 이 팀 라인업으로 재매칭된 액션 수 — 0 이면 등번호가 라인업과 안 맞는 것"
                                >
                                  · 선수매칭 {link.player_match}
                                </span>
                              ) : null}
                              {link.callback_status ? (
                                <span style={{ fontSize: 12, color: link.callback_status === 'sent' ? '#22c55e' : 'var(--muted, #999)' }}>
                                  · {link.callback_status}
                                </span>
                              ) : null}
                              <button style={{ ...smallBtn, color: '#f87171' }} onClick={() => void removeLink(job, side)}>해제</button>
                            </>
                          ) : (
                            <span style={{ color: 'var(--muted, #777)' }}>미연결</span>
                          )}
                        </div>
                      );
                    })}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <select
                        value={linkSide}
                        onChange={(e) => setLinkSide(e.target.value as 'home' | 'away')}
                        style={{ fontSize: 13, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-card, #1b1b1f)', color: 'inherit', border: '1px solid var(--border-ghost, #2c2c32)' }}
                        disabled={linkBusy}
                      >
                        <option value="home">홈</option>
                        <option value="away">어웨이</option>
                      </select>
                      <input
                        value={linkRid}
                        onChange={(e) => setLinkRid(e.target.value)}
                        placeholder="analysisRequestId"
                        style={{ fontSize: 13, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-card, #1b1b1f)', color: 'inherit', border: '1px solid var(--border-ghost, #2c2c32)', width: 160 }}
                        disabled={linkBusy}
                      />
                      <input
                        value={linkTeamId}
                        onChange={(e) => setLinkTeamId(e.target.value)}
                        placeholder="teamId (claim 실패 시 수동)"
                        style={{ fontSize: 13, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-card, #1b1b1f)', color: 'inherit', border: '1px solid var(--border-ghost, #2c2c32)', width: 170 }}
                        disabled={linkBusy}
                      />
                      <input
                        value={linkTeamName}
                        onChange={(e) => setLinkTeamName(e.target.value)}
                        placeholder="팀명 (수동)"
                        style={{ fontSize: 13, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-card, #1b1b1f)', color: 'inherit', border: '1px solid var(--border-ghost, #2c2c32)', width: 120 }}
                        disabled={linkBusy}
                      />
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted, #999)' }}>
                        <input type="checkbox" checked={linkManual} onChange={(e) => setLinkManual(e.target.checked)} disabled={linkBusy} />
                        수동 (claim 생략)
                      </label>
                      <label
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted, #999)' }}
                        title="이 사이드에 xFP(채점·씬모션)를 함께 보낼지 — claim 이 되면 신청 옵션이 우선한다. 끄면 클립 영상만 나간다"
                      >
                        <input type="checkbox" checked={linkXfp} onChange={(e) => setLinkXfp(e.target.checked)} disabled={linkBusy} />
                        xFP 산출
                      </label>
                      <button style={primaryBtn} onClick={() => void saveLink(job)} disabled={linkBusy}>
                        {linkBusy ? '연결 중…' : '연결'}
                      </button>
                    </div>
                    {linkMsg ? <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: 0 }}>{linkMsg}</p> : null}

                    <div style={{ borderTop: '1px dashed var(--border-ghost, #2c2c32)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600 }}>📋 경기기록지에서 라인업</span>
                        <input
                          type="file"
                          accept=".xlsx,.xlsm"
                          disabled={sheetBusy}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void loadSheets(job, f);
                          }}
                          style={{ fontSize: 12 }}
                        />
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted, #999)' }}>
                          <input type="checkbox" checked={sheetSwap} onChange={(e) => setSheetSwap(e.target.checked)} disabled={sheetBusy} />
                          홈/어웨이 뒤집기
                        </label>
                      </div>
                      {sheetRows.length ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {sheetRows.map((s) => (
                            <div key={s.sheet} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                              <span style={{ width: 74, color: 'var(--muted, #999)' }}>{s.sheet}</span>
                              {s.error ? (
                                <span style={{ color: '#f87171' }}>{s.error}</span>
                              ) : (
                                <>
                                  <span style={{ flex: 1 }}>
                                    {s.home?.team} ({s.home?.count}) vs {s.away?.team} ({s.away?.count})
                                  </span>
                                  <button
                                    style={smallBtn}
                                    disabled={sheetBusy || !s.usable}
                                    title={s.usable ? '이 시트의 라인업을 홈/어웨이에 넣는다' : '선수명단이 비어 있어 넣을 수 없습니다'}
                                    onClick={() => void applySheet(job, s.sheet)}
                                  >
                                    {s.usable ? '적용' : '명단 없음'}
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {sheetMsg ? <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: 0 }}>{sheetMsg}</p> : null}
                      <p style={{ fontSize: 12, color: 'var(--muted, #777)', margin: 0 }}>
                        신청이 없는 사전 작업은 라인업이 비어 태깅 등번호 검증이 돌지 않습니다. 기록지 시트 하나가 경기 하나입니다.
                      </p>
                    </div>

                    <p style={{ fontSize: 12, color: 'var(--muted, #777)', margin: 0 }}>
                      전송(클립 결과 탭)하면 연결된 사이드별로 각 팀 클립만, 그 팀 라인업으로 재매칭돼 나갑니다. 상대편 액션은 익명 처리됩니다.
                    </p>
                  </div>
                ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selected ? (
        <div style={card}>
          <h3 style={{ fontSize: 15, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>태깅 — {selected.job_metadata?.display_name || selected.original_filename}</span>
            <span
              style={{ ...badgeStyle, background: planBadge(selected).bg, color: planBadge(selected).color }}
              title={planBadge(selected).title}
            >
              {planBadge(selected).label}
            </span>
          </h3>
          {planTier(selected) === 'basic' ? (
            <p style={{
              fontSize: 12, color: '#9ca3af', margin: '0 0 10px', padding: '8px 10px', borderRadius: 6,
              background: 'rgba(156,163,175,.10)', border: '1px dashed var(--border-ghost, #2c2c32)',
            }}>
              하이라이트만 신청입니다 — 태깅·클립 생성은 똑같이 하고 <strong>클립 결과에 그대로 보관</strong>됩니다.
              다만 전송할 때 FPA 채점·씬모션이 실리지 않으니, <strong>FPA 를 찍지 않아도 됩니다</strong>(찍어두면
              나중에 유료 전환 시 재전송만으로 나갑니다).
            </p>
          ) : null}
          {sourceError ? (
            <p style={{ fontSize: 13, color: '#ef4444' }}>원본 재생 실패: {sourceError}</p>
          ) : !sourceUrl ? (
            <p style={{ fontSize: 13, color: 'var(--muted, #999)' }}>원본 주소 가져오는 중...</p>
          ) : (
            <>
              {sourceVideos.length > 1 ? (
                <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                  {sourceVideos.map((v, i) => (
                    <button
                      key={v.videoId || i}
                      style={{
                        ...smallBtn,
                        ...(i === activeVideoIdx
                          ? { background: 'var(--accent, #3b82f6)', borderColor: 'transparent' }
                          : {}),
                      }}
                      onClick={() => switchVideo(i)}
                    >
                      영상 {i + 1}
                      {v.durationSeconds ? ` (${fmt(v.durationSeconds)})` : ''}
                      {' · 태그 '}
                      {tags.filter((tag) => tag.videoIdx === i).length}
                    </button>
                  ))}
                  <span style={{ fontSize: 12, color: 'var(--muted, #999)', alignSelf: 'center' }}>
                    앱이 보낸 순서 = 경기 순서 — 클립 번호도 이 순서를 따릅니다
                  </span>
                </div>
              ) : null}
              <video
                ref={videoRef}
                src={sourceUrl}
                controls
                // 태깅은 화면을 오래 들여다보는 작업이라 영상을 최대한 크게 띄운다.
                // 고정 px 대신 화면 높이 비례 — 아래 태깅 버튼·타임라인이 잘리지 않는 선.
                style={{ width: '100%', maxHeight: '68vh', minHeight: 360, background: '#000', borderRadius: 8 }}
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration || 0);
                  e.currentTarget.playbackRate = speed;
                  if (pendingSeekRef.current !== null) {
                    e.currentTarget.currentTime = pendingSeekRef.current;
                    pendingSeekRef.current = null;
                  }
                }}
                onTimeUpdate={(e) => {
                  const v = e.currentTarget;
                  setCurrent(v.currentTime);
                  // 클립 미리보기 중이면 끝시간에서 멈춘다
                  const stop = stopAtRef.current;
                  if (stop !== null && v.currentTime >= stop) {
                    stopAtRef.current = null;
                    v.pause();
                    v.currentTime = stop;
                  }
                }}
                // 사용자가 직접 스크럽하면 미리보기 정지 예약을 푼다 —
                // 나중에 엉뚱한 지점에서 갑자기 멈추는 걸 막는다.
                // 미리보기가 스스로 건 seek 은 예외.
                onSeeking={() => {
                  if (autoSeekRef.current) { autoSeekRef.current = false; return; }
                  stopAtRef.current = null;
                }}
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
                  ＋ 홈 {fpaTeams.home !== 'Home' ? fpaTeams.home : ''} 태깅 (A / ㅁ)
                </button>
                <button
                  style={{ ...btn, background: '#7c3aed', borderColor: 'transparent' }}
                  onClick={() => addTag('away')}
                >
                  ＋ 어웨이 {fpaTeams.away !== 'Away' ? fpaTeams.away : ''} 태깅 (D / ㅇ)
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
                      {sourceVideos.length > 1 ? (
                        <span style={{ fontSize: 12, color: 'var(--muted, #999)', width: 40 }}>
                          영상{(tag.videoIdx ?? 0) + 1}
                        </span>
                      ) : null}
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
                      <button
                        style={smallBtn}
                        title="클립 시작으로 이동해 끝까지 재생 — 실제 잘릴 구간을 그대로 확인"
                        onClick={() => previewClip(tag)}
                      >
                        {fmt(clipRangeOf(tag).start)} → {fmt(clipRangeOf(tag).end)}
                      </button>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color: 'var(--muted, #999)' }}>
                        앞 <input
                          type="number" min={0} max={60}
                          value={tag.padBefore ?? ''}
                          placeholder={String(padBefore)}
                          title="이 클립만 앞 초 오버라이드 — 비우면 전역 기본값"
                          onChange={(e) => {
                            const v = e.target.value === '' ? undefined : Math.max(0, Number(e.target.value) || 0);
                            setTags((prev) => prev.map((x) => (x.id === tag.id ? { ...x, padBefore: v } : x)));
                          }}
                          style={numInput}
                        />
                      </label>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color: 'var(--muted, #999)' }}>
                        뒤 <input
                          type="number" min={1} max={60}
                          value={tag.padAfter ?? ''}
                          placeholder={String(padAfter)}
                          title="이 클립만 뒤 초 오버라이드 — 비우면 전역 기본값"
                          onChange={(e) => {
                            const v = e.target.value === '' ? undefined : Math.max(1, Number(e.target.value) || 1);
                            setTags((prev) => prev.map((x) => (x.id === tag.id ? { ...x, padAfter: v } : x)));
                          }}
                          style={numInput}
                        />
                      </label>
                      <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                        클립 {fmt(Math.max(0, tag.t - (tag.padBefore ?? padBefore)))} ~ {fmt(tag.t + (tag.padAfter ?? padAfter))}
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

              {/* 등급과 무관하게 태깅·클립 생성은 똑같이 한다 — 클립 결과에는 어느 쪽이든
                  그대로 보관되고, basic 은 '전송할 때 FPA 를 싣지 않는다' 는 차이뿐이다. */}
              <div style={{
                marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-ghost, #2c2c32)',
              }}>
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
                  {/* 전송 버튼은 두지 않는다 — FinePlay 전송은 클립 결과 탭 한 곳에서만
                      한다. 여기서 바로 보내면 구간을 다듬기 전에 나가고, 전송 창구가
                      둘로 갈려 무엇이 언제 나갔는지 한 곳에서 안 보인다. */}
                  <button style={primaryBtn} onClick={() => void produce()} disabled={producing || !tags.length}>
                    {producing ? '처리 중...' : `🎬 클립 ${tags.length}개 생성 (클립 결과에 보관)`}
                  </button>
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
