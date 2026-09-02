'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import HighlightSubTabs from '../HighlightSubTabs';
import SceneMotionView, { type SceneData } from '../../../../components/SceneMotionView';
import { apiJson, type SessionUser } from '../../../../lib/api';

// 클립 결과: match → clip → action 3계층 열람/편집.
// 클립 상세에서 [FPA dual] 새 창으로 씬을 찍어 클립에 귀속시키고,
// 액션별 클립 내 구간(초)을 다듬은 뒤 매치 단위로 FinePlay에 재전송한다.

type MatchRow = {
  match_id: string | null;
  job_id: string;
  // 산출 지시 — basic(하이라이트만) 이면 전송에 채점·액션이 실리지 않는다.
  plan?: { tier: 'xfp' | 'basic'; options?: string[]; source?: string } | null;
  name: string;
  home_team: string;
  away_team: string;
  clip_count: number;
  callback_status?: string | null;
  analysis_request_id?: number | string;
  // 아카이브된 잡은 기본 목록에서 빠진다 — '아카이브 포함' 토글이나 아카이브 룸 딥링크로만 보인다.
  archived?: boolean;
  archived_at?: string | null;
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
  // 운영자가 지정한 제목(오버라이드). null 이면 FPA 대표 액션 자동 제목이 나간다.
  title?: string | null;
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
  // 정본 v0.1 Action xFP — 유효 Effect Action 만 값이 있다. 콘솔 표시 = 앱 전송값.
  xfpScore?: number | null;
  xfpPercentile?: number | null;
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

function ArchivedBadge() {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 5,
      background: 'rgba(148,163,184,.18)', color: '#94a3b8',
    }}>
      아카이브됨
    </span>
  );
}

// 산출 지시 배지 — 작업 탭과 같은 세 갈래로 읽히게 맞춘다. 사전 작업은 tier 가
// xfp 지만 그건 태깅 기준일 뿐이라, 신청이 붙기 전까지 따로 세워야 운영자가
// "이건 아직 산출 범위가 안 정해진 건" 이라는 걸 안다.
function PlanBadge({ plan }: { plan?: MatchRow['plan'] }) {
  const view = plan?.source === 'standalone' ? 'standalone' : plan?.tier === 'basic' ? 'basic' : 'xfp';
  const { label, color, bg, title } = view === 'standalone'
    ? {
        label: '🔵 사전작업',
        color: '#a78bfa',
        bg: 'rgba(167,139,250,.16)',
        title: '사전 작업 — 태깅은 xFP 기준으로 하고, 전송 범위는 연결된 신청의 옵션이 정합니다',
      }
    : view === 'basic'
      ? {
          label: '⚪ 하이라이트만',
          color: '#9ca3af',
          bg: 'rgba(156,163,175,.16)',
          title: '하이라이트만 신청 — 전송에 액션·채점·씬모션이 실리지 않습니다',
        }
      : {
          label: '🟣 xFP',
          color: '#c084fc',
          bg: 'rgba(192,132,252,.16)',
          title: 'xFP 산출 신청 — 채점·씬모션까지 전송됩니다',
        };
  return (
    <span
      style={{
        fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 5, whiteSpace: 'nowrap',
        background: bg, color,
      }}
      title={title}
    >
      {label}
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
  const [motions, setMotions] = useState<{ seq: number; url: string | null; sceneData?: SceneData | null }[]>([]);
  const [motionMsg, setMotionMsg] = useState('');
  // 기본은 앱과 같은 네이티브 렌더. mp4 는 폴백으로 계속 나가는 산출물이라 토글로 남긴다.
  const [motionAsMp4, setMotionAsMp4] = useState(false);
  // 클립 팀(홈/어웨이) 수정 — 관리자 전용. 되돌리기 어려운 값이라 팝업으로 한 번 확인받는다.
  const [teamEdit, setTeamEdit] = useState<{ clip: ClipRow | ClipDetail; next: string | null } | null>(null);
  const [teamSaving, setTeamSaving] = useState(false);

  // FinePlay 전송은 SUPERADMIN 전용 — operator 에겐 버튼을 렌더하지 않는다 (서버 resend API 도 superadmin 게이트).
  const [role, setRole] = useState<SessionUser['role'] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // 대회 인입(competition-results) 전송 폼 — 사전 작업 매치를 신청 없이 앱으로 보낸다.
  const [compForm, setCompForm] = useState<
    { fpcCompetitionId: string; name: string; round: string; playedAt: string; venue: string } | null
  >(null);
  // 제목 편집 중인 클립. null 이면 편집 중 아님. 비워서 저장하면 오버라이드 해제.
  const [titleEdit, setTitleEdit] = useState<{ id: string; value: string } | null>(null);
  const [titleSaving, setTitleSaving] = useState(false);

  useEffect(() => {
    let active = true;
    apiJson<SessionUser>('/session/me')
      .then((data) => { if (active) setRole(data.role); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // 아카이브 룸 '열어서 수정' 등 ?matchId= 딥링크 진입 시 해당 매치를 바로 연다 (최초 1회).
  const deepLinkDone = useRef(false);

  const loadMatches = useCallback(async () => {
    // 딥링크 진입은 대상이 아카이브된 잡일 수 있으므로 항상 포함해서 받아온다 (표시는 아래에서 거른다).
    const target = deepLinkDone.current
      ? null
      : new URLSearchParams(window.location.search).get('matchId');
    const include = showArchived || !!target;
    try {
      const rows = await apiJson<MatchRow[]>(
        `/highlight/clip-results/matches${include ? '?include_archived=1' : ''}`,
      );
      setMatches(rows);
      if (!deepLinkDone.current) {
        deepLinkDone.current = true;
        const m = target ? rows.find((r) => r.match_id === target) : null;
        if (m) void openMatch(m);
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

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

  // 장면 모션은 서버가 렌더+S3 업로드까지 하므로(액션당 수 초) 클립 열 때·dual 저장 직후·수동 새로고침에만 부른다.
  const loadMotions = useCallback(async (clipId: string) => {
    setMotions([]);
    setMotionMsg('장면 모션 렌더 중…');
    try {
      const res = await apiJson<{
        motions: { seq: number; url: string | null; sceneData?: SceneData | null }[];
        warnings: string[];
      }>(
        `/highlight/clip-results/clips/${clipId}/scene-motions`,
      );
      setMotions(res.motions);
      setMotionMsg(res.motions.length === 0
        ? '장면 모션 없음 — FPA dual 로 찍어 저장한 액션만 모션이 생성됩니다.'
        : (res.warnings?.length ? `일부 실패: ${res.warnings.join(' / ')}` : ''));
    } catch (err) {
      setMotionMsg(err instanceof Error ? err.message : String(err));
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
        void loadMotions(detail.id);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [detail, openClip, loadMotions]);

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

  // 목록 제목은 Match.name → job display_name 순으로 정해진다.
  // 서버가 둘 다 갱신하므로 여기선 잡 기준으로만 보내면 된다.
  const renameMatch = async () => {
    if (!selectedMatch) return;
    const next = window.prompt('클립 결과 제목', selectedMatch.name || '');
    if (next === null) return;
    const name = next.trim();
    if (!name || name === selectedMatch.name) return;
    setBusy(true);
    setMsg('');
    try {
      await apiJson(`/highlight/clip-results/${selectedMatch.job_id}/name`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      setSelectedMatch({ ...selectedMatch, name });
      setMsg(`제목을 "${name}" 로 바꿨습니다.`);
      await loadMatches();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // 아카이브: 이 매치를 클립 결과·FinePlay 작업 목록에서 빼 '아카이브' 룸으로 보낸다 (데이터는 그대로).
  // 해제하면 양쪽 목록으로 돌아온다. 서버가 '모든 클립에 FPA 데이터' 조건을 검사한다.
  const toggleArchive = async (archived: boolean) => {
    if (!selectedMatch) return;
    setBusy(true);
    setMsg('');
    try {
      await apiJson(`/highlight/fineplay-jobs/${selectedMatch.job_id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived }),
      });
      setSelectedMatch({ ...selectedMatch, archived });
      setMsg(archived
        ? "아카이브 완료 — 클립 결과 목록에서 빠지고 '아카이브' 탭에서 관리합니다. 이 화면에선 계속 수정할 수 있습니다."
        : '아카이브 해제 — 클립 결과·FinePlay 작업 목록으로 돌아왔습니다.');
      await loadMatches();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // 클립 귀속 팀 변경. 이 값이 전송 대상 팀을 가르므로(사전 작업은 사이드별로 나눠 보낸다)
  // 태깅 때 잘못 고른 것을 여기서 바로잡는다. 서버가 잡 메타데이터까지 함께 고쳐
  // 클립을 다시 만들어도 되돌아가지 않는다.
  const saveTeam = async () => {
    if (!teamEdit || teamSaving) return;
    setTeamSaving(true);
    try {
      const res = await apiJson<{ clip_id: string; team_side: string | null; metadata_synced: boolean }>(
        `/highlight/clip-results/clips/${teamEdit.clip.id}/team`,
        { method: 'PATCH', body: JSON.stringify({ team_side: teamEdit.next }) },
      );
      setClips((prev) => prev.map((c) => (c.id === res.clip_id ? { ...c, team_side: res.team_side } : c)));
      setDetail((prev) => (prev && prev.id === res.clip_id ? { ...prev, team_side: res.team_side } : prev));
      setTeamEdit(null);
      setMsg(
        `클립 팀 변경 — ${res.team_side === 'home' ? '홈' : res.team_side === 'away' ? '어웨이' : '팀 미지정'}`
        + (res.metadata_synced ? '' : ' (⚠ 작업 메타데이터에서 이 클립을 못 찾아, 클립을 다시 만들면 되돌아갑니다)')
        + ' · 앱에 반영하려면 전송하세요.',
      );
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setTeamSaving(false);
    }
  };

  // 저장만 한다 — 앱에 반영하려면 위 'FinePlay로 전송' 을 눌러야 한다.
  // clipKey 가 멱등키라 재전송하면 제목만 바뀐 채로 덮어써진다.
  const saveTitle = async () => {
    if (!titleEdit || titleSaving) return;
    setTitleSaving(true);
    try {
      const res = await apiJson<{ clip_id: string; title: string | null }>(
        `/highlight/clip-results/clips/${titleEdit.id}/title`,
        { method: 'PATCH', body: JSON.stringify({ title: titleEdit.value.trim() }) },
      );
      setClips((prev) => prev.map((c) => (c.id === res.clip_id ? { ...c, title: res.title } : c)));
      // 목록·상세 어느 쪽에서 고쳤든 양쪽 다 맞춘다 — 상세에서 고치고 목록으로
      // 돌아갔을 때 옛 제목이 남아 있으면 저장이 안 된 줄 안다.
      setDetail((prev) => (prev && prev.id === res.clip_id ? { ...prev, title: res.title } : prev));
      setTitleEdit(null);
      setMsg(res.title ? '제목 저장 — 전송해야 앱에 반영됩니다.' : '제목 해제 — 자동 제목으로 돌아갑니다.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setTitleSaving(false);
    }
  };

  // 클립 목록과 상세에서 같은 편집기를 쓴다 — 어디서 열든 고치는 방법이 같아야 한다.
  const renderTitle = (c: { id: string; title?: string | null; main_action?: string | null }) =>
    (titleEdit?.id === c.id ? (
      <input
        autoFocus
        value={titleEdit.value}
        maxLength={60}
        placeholder={c.main_action || '클립 제목'}
        onChange={(e) => setTitleEdit({ id: c.id, value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void saveTitle();
          if (e.key === 'Escape') setTitleEdit(null);
        }}
        onBlur={() => void saveTitle()}
        disabled={titleSaving}
        style={{
          flex: 1, minWidth: 160, fontSize: 13, padding: '3px 6px', borderRadius: 4,
          background: 'var(--surface, #1e1e24)', color: 'inherit',
          border: '1px solid var(--accent, #3b82f6)',
        }}
      />
    ) : (
      // 고칠 수 있다는 걸 보이게 한다 — 점선 밑줄 + 연필. 그냥 텍스트로 두면
      // 눌러서 고치는 자리인 줄 아무도 모른다.
      // 사람이 붙인 제목은 굵게, 자동 제목은 흐리게 — 목록에서 바로 구분된다.
      <button
        type="button"
        onClick={() => setTitleEdit({ id: c.id, value: c.title || '' })}
        title={c.title
          ? `자동 제목: ${c.main_action || '-'} — 눌러서 수정, 비우고 저장하면 자동 제목으로 되돌아갑니다`
          : '눌러서 클립 제목 지정 (앱 카드에 이 제목이 뜹니다)'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          font: 'inherit', fontSize: 13, textAlign: 'left',
          color: c.title ? 'inherit' : 'var(--muted, #999)',
          fontWeight: c.title ? 600 : 400,
          borderBottom: '1px dashed var(--border-ghost, #3a3a42)',
        }}
      >
        {c.title || c.main_action || '제목 없음'}
        <span style={{ fontSize: 11, opacity: 0.55 }}>✎</span>
      </button>
    ));

  const resend = async () => {
    if (!selectedMatch?.match_id) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await apiJson<{ clips?: number; callback_status?: string | Record<string, string> }>(
        `/highlight/clip-results/matches/${selectedMatch.match_id}/resend`,
        { method: 'POST' },
      );
      // 사전 작업 매치는 연결된 신청(홈/어웨이)별로 나가고 사이드별 상태가 온다.
      if (res.callback_status && typeof res.callback_status === 'object') {
        const parts = Object.entries(res.callback_status)
          .map(([side, st]) => `${side === 'home' ? '홈' : '어웨이'}: ${st}`);
        setMsg(`FinePlay 팀별 전송 — ${parts.join(' · ')}`);
      } else {
        setMsg(`FinePlay 전송 완료 — 클립 ${res.clips}개`);
      }
      await loadMatches();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // 대회 인입 — 분석 신청 없이 사전 작업 매치를 앱으로 보낸다(수신부 competition-results).
  // 팀은 이름·선수는 등번호로 싣고 매칭은 FinePlay 스테이징에서 한다. fpcMatchId 로 멱등.
  const sendCompetition = async () => {
    if (!selectedMatch?.match_id || !compForm) return;
    if (!compForm.fpcCompetitionId.trim()) { setMsg('대회 ID(fpcCompetitionId)는 필수입니다.'); return; }
    setBusy(true);
    setMsg('');
    try {
      const match: Record<string, string> = {};
      if (compForm.playedAt.trim()) match.playedAt = compForm.playedAt.trim();
      if (compForm.venue.trim()) match.venue = compForm.venue.trim();
      const res = await apiJson<{
        callback_status?: string; http_status?: number; sent?: boolean;
        summary?: { teams_with_lineup?: number; players?: number; clips?: number; profiles?: number; warnings?: string[] };
      }>(
        `/highlight/clip-results/matches/${selectedMatch.match_id}/send-competition`,
        {
          method: 'POST',
          body: JSON.stringify({
            competition: {
              fpcCompetitionId: compForm.fpcCompetitionId.trim(),
              name: compForm.name.trim(),
              ...(compForm.round.trim() ? { round: compForm.round.trim() } : {}),
            },
            match,
          }),
        },
      );
      const s = res.summary;
      const summaryTxt = s
        ? ` (팀 ${s.teams_with_lineup ?? 0} · 선수 ${s.players ?? 0} · 클립 ${s.clips ?? 0} · 프로필 ${s.profiles ?? 0}${s.warnings?.length ? ` · ⚠ ${s.warnings.join(' / ')}` : ''})`
        : '';
      // 수신부가 아직 검증전용이면 sent=false·501("계약 통과·저장 대기")로 온다 — 실패 아님.
      const head = res.sent ? '대회 인입 전송 완료' : `대회 인입 — ${res.callback_status ?? ''}`;
      setMsg(`${head}${summaryTxt}`);
      setCompForm(null);
      await loadMatches();
    } catch (err) {
      // 수신부 400(계약 위반)은 errors 를 담아 던진다 — 본문을 그대로 보여준다.
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // 딥링크 진입 땐 아카이브 잡까지 받아오므로, 목록 표시는 토글 기준으로 다시 거른다.
  const visibleMatches = showArchived ? matches : matches.filter((m) => !m.archived);

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
              {selectedMatch.archived ? <ArchivedBadge /> : null}
              {role === 'SUPERADMIN' ? (
                <>
                  <button style={smallBtn} onClick={renameMatch} disabled={busy} title="클립 결과 제목 바꾸기">
                    ✎ 이름 수정
                  </button>
                  <button
                    style={{ ...smallBtn, marginLeft: 'auto' }}
                    onClick={() => void toggleArchive(!selectedMatch.archived)}
                    disabled={busy}
                    title={selectedMatch.archived
                      ? '아카이브 해제 — 클립 결과·FinePlay 작업 목록으로 되돌립니다'
                      : '아카이브로 이동 — 목록에서 빠지지만 데이터는 그대로, 언제든 해제 가능'}
                  >
                    {selectedMatch.archived ? '↩ 아카이브 해제' : '📦 아카이브'}
                  </button>
                  <button
                    style={primaryBtn}
                    onClick={resend}
                    disabled={busy}
                    title={selectedMatch.plan?.source === 'standalone'
                      ? '사전 작업 — 연결된 신청(홈/어웨이)마다 그 신청의 옵션대로 전송됩니다'
                      : selectedMatch.plan?.tier === 'basic'
                        ? '하이라이트만 신청 — 클립 영상·썸네일만 전송됩니다(액션·채점 미포함)'
                        : '클립 영상 + 액션·채점·씬모션을 전송합니다'}
                  >
                    ⬆ FinePlay로 전송{selectedMatch.plan?.tier === 'basic' ? ' (영상만)' : ''}
                  </button>
                  {selectedMatch.plan?.source === 'standalone' ? (
                    <button
                      style={primaryBtn}
                      onClick={() => setCompForm({ fpcCompetitionId: '', name: '', round: '', playedAt: '', venue: '' })}
                      disabled={busy}
                      title="분석 신청 없이 대회 클립으로 앱에 보냅니다 — 팀·선수 매칭은 FinePlay 스테이징에서 확정합니다"
                    >
                      🏆 대회 인입 전송
                    </button>
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <>
              <button
                style={{
                  ...smallBtn,
                  marginLeft: 'auto',
                  background: showArchived ? 'var(--accent, #3b82f6)' : 'var(--button-dark, #2a2a30)',
                  borderColor: showArchived ? 'transparent' : 'var(--border-ghost, #3a3a42)',
                }}
                onClick={() => setShowArchived((v) => !v)}
                title="아카이브된 매치까지 함께 보기"
              >
                {showArchived ? '아카이브 포함 ✓' : '아카이브 포함'}
              </button>
              <button style={btn} onClick={() => void loadMatches()}>새로고침</button>
            </>
          )}
        </div>
        {msg ? <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '8px 0 0' }}>{msg}</p> : null}
      </div>

      {compForm ? (
        <div
          onClick={() => { if (!busy) setCompForm(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 420, maxWidth: '92vw', marginBottom: 0 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>🏆 대회 인입 전송</h3>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted, #999)' }}>
              분석 신청 없이 이 사전 작업 매치를 앱으로 보냅니다. 팀·선수 매칭은 FinePlay 스테이징에서 확정합니다.
            </p>
            {([
              ['fpcCompetitionId', '대회 ID *', '예: cup-2026-fine', 'text'],
              ['name', '대회 이름', '예: 2026 파인컵', 'text'],
              ['round', '라운드', '예: 8강', 'text'],
              ['playedAt', '경기 일시', '', 'datetime-local'],
              ['venue', '장소', '예: 상암 보조구장', 'text'],
            ] as const).map(([key, label, ph, inputType]) => (
              <label key={key} style={{ display: 'block', marginBottom: 10 }}>
                <span style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--muted, #bbb)' }}>{label}</span>
                <input
                  type={inputType}
                  value={compForm[key]}
                  placeholder={ph}
                  onChange={(e) => setCompForm((f) => (f ? { ...f, [key]: e.target.value } : f))}
                  style={{
                    width: '100%', padding: '7px 9px', borderRadius: 6, boxSizing: 'border-box',
                    border: '1px solid var(--border-ghost, #3a3a42)',
                    background: 'var(--surface-input, #1b1b1f)', color: 'var(--text, #eee)',
                  }}
                />
              </label>
            ))}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button style={smallBtn} onClick={() => setCompForm(null)} disabled={busy}>취소</button>
              <button
                style={primaryBtn}
                onClick={() => void sendCompetition()}
                disabled={busy || !compForm.fpcCompetitionId.trim()}
              >
                {busy ? '전송 중…' : '전송'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!selectedMatch ? (
        <div style={card}>
          {visibleMatches.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
              {matches.length === 0
                ? '추출된 클립이 없습니다. FinePlay 작업 탭에서 클립을 생성하면 여기에 매치별로 쌓입니다.'
                : "진행 중인 작업이 없습니다 — 모두 아카이브됨. '아카이브 포함'을 켜거나 '아카이브' 탭에서 볼 수 있습니다."}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {visibleMatches.map((m) => (
                <div key={m.job_id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                  padding: '8px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
                }}>
                  <span style={{ fontWeight: 600 }}>{m.name}</span>
                  <PlanBadge plan={m.plan} />
                  {m.archived ? <ArchivedBadge /> : null}
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
          <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '0 0 10px' }}>
            제목(<span style={{ borderBottom: '1px dashed var(--border-ghost, #3a3a42)' }}>밑줄 ✎</span>)을 눌러
            클립 이름을 고칠 수 있습니다 — 앱 카드에 이 제목이 뜹니다. 비워서 저장하면 FPA 자동 제목으로 돌아갑니다.
            고친 뒤 <strong>FinePlay로 전송</strong>해야 앱에 반영됩니다.
          </p>
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
                {/* 목록에서 잘못된 태그가 눈에 띄면 열지 않고 바로 고친다 (관리자 전용). */}
                {role === 'SUPERADMIN' ? (
                  <button
                    style={{ ...smallBtn, padding: '1px 6px', fontSize: 10 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTeamEdit({ clip: c, next: c.team_side === 'home' ? 'away' : 'home' });
                    }}
                    title="이 클립의 홈/어웨이 귀속을 고칩니다"
                  >수정</button>
                ) : null}
                {renderTitle(c)}
                <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                  {fmt(c.start_sec)}~{fmt(c.end_sec)}
                </span>
                <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>액션 {c.action_count}개</span>
                <button style={{ ...smallBtn, marginLeft: 'auto' }} onClick={() => { void openClip(c.id); void loadMotions(c.id); }}>상세</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {detail ? (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <button style={smallBtn} onClick={() => setDetail(null)}>← 클립 목록</button>
            {/* 클립을 열어 보면서 바로 제목을 붙일 수 있어야 한다 — 목록으로
                되돌아가 고치게 만들면 검수 흐름이 끊긴다. */}
            {renderTitle(detail)}
            <span style={{ fontSize: 11, color: 'var(--muted, #666)' }}>{detail.id}</span>
            <TeamBadge side={detail.team_side} labels={detail.team_labels} />
            {/* 태깅 때 홈/어웨이를 잘못 고른 클립을 여기서 바로잡는다 (관리자 전용). */}
            {role === 'SUPERADMIN' ? (
              <button
                style={{ ...smallBtn, padding: '2px 8px', fontSize: 11 }}
                onClick={() => setTeamEdit({ clip: detail, next: detail.team_side === 'home' ? 'away' : 'home' })}
                title="이 클립의 홈/어웨이 귀속을 고칩니다 — 전송 대상 팀이 바뀝니다"
              >팀 수정</button>
            ) : null}
            <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
              {fmt(detail.start_sec)}~{fmt(detail.end_sec)} · {Math.round(detail.duration_seconds || 0)}초
            </span>
            {/* 클립 사이 이동 — 목록으로 나갔다 다시 들어오지 않고 검수를 이어서 한다.
                순서는 목록과 같다(order_index). 목록 클릭과 같은 동작이라 액션·모션을
                함께 다시 불러온다 — 모션은 detail 변경만으로는 안 갱신된다. */}
            {(() => {
              const index = clips.findIndex((c) => c.id === detail.id);
              const prev = index > 0 ? clips[index - 1] : null;
              const next = index >= 0 && index < clips.length - 1 ? clips[index + 1] : null;
              const go = (target: ClipRow | null) => {
                if (!target) return;
                void openClip(target.id);
                void loadMotions(target.id);
              };
              const navBtn = (enabled: boolean): React.CSSProperties => ({
                ...smallBtn,
                opacity: enabled ? 1 : 0.4,
                cursor: enabled ? 'pointer' : 'not-allowed',
              });
              return (
                <>
                  {index >= 0 ? (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted, #999)' }}>
                      {index + 1} / {clips.length}
                    </span>
                  ) : null}
                  <button
                    style={{ ...navBtn(!!prev), ...(index >= 0 ? null : { marginLeft: 'auto' }) }}
                    disabled={!prev}
                    onClick={() => go(prev)}
                    title={prev ? `이전 클립 (${prev.title || prev.id})` : '첫 클립입니다'}
                  >
                    ← 이전 클립
                  </button>
                  <button
                    style={navBtn(!!next)}
                    disabled={!next}
                    onClick={() => go(next)}
                    title={next ? `다음 클립 (${next.title || next.id})` : '마지막 클립입니다'}
                  >
                    다음 클립 →
                  </button>
                </>
              );
            })()}
            <button
              style={primaryBtn}
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
              // 고정 px 대신 화면 높이 비례 — 큰 모니터에서 그만큼 크게 보인다.
              // 아래 액션 목록이 바로 이어지므로 태깅 화면(68vh)보다 조금 낮게 잡는다.
              style={{ width: '100%', maxHeight: '62vh', minHeight: 320, background: '#000', borderRadius: 8 }}
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
                    {a.xfpScore != null ? (
                      <span
                        title={a.xfpPercentile != null ? `백분위 ${(a.xfpPercentile * 100).toFixed(1)}%` : undefined}
                        style={{
                          width: 58, fontSize: 12, fontWeight: 700,
                          color: a.xfpScore >= 95 ? '#facc15' : a.xfpScore >= 80 ? '#4ade80' : 'var(--text, #eee)',
                        }}
                      >
                        xFP {a.xfpScore}
                      </span>
                    ) : (
                      <span style={{ width: 58, fontSize: 12, color: 'var(--muted, #666)' }}>—</span>
                    )}
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

          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <h3 style={{ fontSize: 14, margin: 0 }}>장면 모션 ({motions.length})</h3>
              <button style={smallBtn} onClick={() => void loadMotions(detail.id)}>모션 새로고침</button>
              <button style={smallBtn} onClick={() => setMotionAsMp4((v) => !v)}>
                {motionAsMp4 ? '앱 화면으로' : 'mp4 로'}
              </button>
              <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                {motionAsMp4
                  ? 'mp4 = sceneData 를 못 읽는 구버전 앱용 폴백입니다.'
                  : '앱이 실제로 그리는 화면(sceneData 네이티브 렌더)입니다.'}
              </span>
            </div>
            {motionMsg ? (
              <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '0 0 8px' }}>{motionMsg}</p>
            ) : null}
            {motions.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {motions.map((m) => {
                  const a = actions.find((x) => x.seq === m.seq);
                  return (
                    <div key={m.seq} style={{
                      width: 300, borderRadius: 8, overflow: 'hidden',
                      background: 'var(--surface-input, #16161a)', border: '1px solid var(--border-ghost, #2c2c32)',
                    }}>
                      {!motionAsMp4 && m.sceneData ? (
                        <SceneMotionView data={m.sceneData} width={300} />
                      ) : m.url ? (
                        <video src={m.url} muted autoPlay loop playsInline style={{ width: '100%', display: 'block' }} />
                      ) : (
                        <div style={{
                          height: 194, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, color: 'var(--muted, #999)',
                        }}>
                          {motionAsMp4 ? 'mp4 없음' : 'sceneData 없음'}
                        </div>
                      )}
                      <div style={{ padding: '6px 10px', fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ color: 'var(--muted, #999)' }}>액션 {m.seq}</span>
                        <span style={{ fontWeight: 600 }}>{a?.actionLabel || ''}</span>
                        {a?.jersey ? <span style={{ color: 'var(--muted, #999)' }}>#{a.jersey}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 클립 팀 변경 확인 — 전송 대상 팀이 바뀌는 값이라 한 번 물어본다. */}
      {teamEdit ? ((() => {
        // 상세에서 열면 클립 응답의 라벨을, 목록에서 열면 매치의 팀명을 쓴다.
        const teamEditLabels = detail?.team_labels
          || (selectedMatch ? { home: selectedMatch.home_team, away: selectedMatch.away_team } : undefined);
        return (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center',
            background: 'rgba(8, 8, 10, 0.66)', padding: 20,
          }}
          onClick={() => { if (!teamSaving) setTeamEdit(null); }}
        >
          <div
            style={{
              width: 'min(440px, 96vw)', borderRadius: 12, padding: 16,
              background: 'var(--surface-card, #303030)', border: '1px solid var(--border-ghost, #444)',
              boxShadow: '0 20px 60px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', gap: 12,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 15, fontWeight: 700 }}>클립 팀 변경</div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--muted, #999)', width: 40 }}>클립</span>
              <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{teamEdit.clip.id}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--muted, #999)', width: 40 }}>지금</span>
              <TeamBadge side={teamEdit.clip.team_side} labels={teamEditLabels} />
              <span style={{ color: 'var(--muted, #999)' }}>→</span>
              <TeamBadge side={teamEdit.next} labels={teamEditLabels} />
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              {([['home', '홈'], ['away', '어웨이'], [null, '팀 미지정']] as const).map(([value, label]) => (
                <button
                  key={String(value)}
                  style={{
                    ...smallBtn, flex: 1,
                    borderColor: teamEdit.next === value ? 'var(--accent, #ff7a00)' : undefined,
                    color: teamEdit.next === value ? 'var(--accent, #ff7a00)' : undefined,
                    fontWeight: teamEdit.next === value ? 700 : 400,
                  }}
                  onClick={() => setTeamEdit((prev) => (prev ? { ...prev, next: value } : prev))}
                  disabled={teamSaving}
                >{label}</button>
              ))}
            </div>

            <div style={{
              fontSize: 11, lineHeight: 1.7, color: 'var(--muted, #999)',
              background: 'rgba(255,177,74,.08)', border: '1px solid rgba(255,177,74,.25)',
              borderRadius: 8, padding: '8px 10px',
            }}>
              · 이 값이 <b>전송 대상 팀</b>을 가릅니다 — 틀리면 반대 팀에게 클립이 갑니다.<br />
              · 이미 찍어둔 <b>액션의 팀은 바뀌지 않습니다</b> (수비 액션처럼 클립 팀과 달라야 정상인 행이 있습니다).<br />
              · 저장만 됩니다 — 앱에 반영하려면 <b>다시 전송</b>하세요.
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={smallBtn} onClick={() => setTeamEdit(null)} disabled={teamSaving}>취소</button>
              <button
                style={{ ...smallBtn, borderColor: 'var(--accent, #ff7a00)', color: 'var(--accent, #ff7a00)', fontWeight: 700 }}
                onClick={() => void saveTeam()}
                disabled={teamSaving || teamEdit.next === teamEdit.clip.team_side}
              >{teamSaving ? '저장 중…' : '변경'}</button>
            </div>
          </div>
        </div>
        );
      })()) : null}

    </div>
  );
}
