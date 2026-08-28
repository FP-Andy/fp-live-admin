'use client';

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '../../../../lib/api';

type OverlayMatch = {
  id: string;
  name: string;
  competition_class: string;
  round_number: number;
  first_half_minutes: number;
  second_half_minutes: number;
  archived: boolean;
  home_team: string;
  away_team: string;
  latest_fla_clock_ms: number;
};

type GraphicOption = { value: string; label: string; default_duration_seconds: number };
type GoalShotMap = {
  event_id: string;
  clock_ms: number;
  clock: string;
  team: 'HOME' | 'AWAY';
  team_name: string;
  player_name: string;
  player_number: string;
  xg: number | null;
  label: string;
  default_duration_seconds: number;
};
type OverlayOptions = { match: OverlayMatch; asset_types: GraphicOption[]; goal_shot_maps: GoalShotMap[] };
type OverlayItem = {
  id: string;
  asset_type: string;
  label: string;
  start_sec: number;
  end_sec: number;
  fla_clock_ms: number;
  goal_event_id?: string;
  goal_label?: string;
  background_url?: string;
  asset_url?: string;
  width?: number;
  height?: number;
  rendered_fla_clock_ms?: number;
};
type RenderedBroadcastAsset = {
  item_id: string;
  asset_type: string;
  label: string;
  background_url: string;
  asset_url: string;
  width: number;
  height: number;
  rendered_fla_clock_ms: number;
  goal_event_id?: string | null;
};
type OverlayProject = {
  id: string;
  match_id: string;
  name: string;
  source_filename: string;
  source_duration_seconds: number | null;
  first_half_video_start_sec: number | null;
  first_half_video_end_sec: number | null;
  second_half_video_start_sec: number | null;
  second_half_video_end_sec: number | null;
  overlay_items: OverlayItem[];
};

const card: React.CSSProperties = {
  background: 'var(--surface-card, #1b1b1f)',
  border: '1px solid var(--border-ghost, #2c2c32)',
  borderRadius: 'var(--radius-card, 10px)',
  padding: 16,
};
const button: React.CSSProperties = {
  fontSize: 13,
  padding: '8px 12px',
  background: 'var(--button-dark, #2a2a30)',
  border: '1px solid var(--border-ghost, #3a3a42)',
  borderRadius: 8,
  cursor: 'pointer',
  color: 'var(--text, #eee)',
  fontWeight: 600,
};
const primaryButton: React.CSSProperties = {
  ...button,
  background: '#f97316',
  borderColor: '#f97316',
  color: '#151515',
};
const label: React.CSSProperties = { fontSize: 12, color: 'var(--muted, #999)', fontWeight: 700, display: 'block', marginBottom: 6 };
const input: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--border-ghost, #3a3a42)',
  background: 'var(--surface-input, #16161a)',
  color: 'var(--text, #eee)',
  fontSize: 13,
};

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function fmtFla(ms: number): string {
  return fmt(ms / 1000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function makeId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function BroadcastOverlayPage() {
  const [matches, setMatches] = useState<OverlayMatch[]>([]);
  const [matchQuery, setMatchQuery] = useState('호각');
  const [selectedMatchId, setSelectedMatchId] = useState('');
  const [options, setOptions] = useState<OverlayOptions | null>(null);
  const [loadingMatches, setLoadingMatches] = useState(true);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [error, setError] = useState('');

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [firstHalfStart, setFirstHalfStart] = useState<number | null>(null);
  const [firstHalfEnd, setFirstHalfEnd] = useState<number | null>(null);
  const [secondHalfStart, setSecondHalfStart] = useState<number | null>(null);
  const [secondHalfEnd, setSecondHalfEnd] = useState<number | null>(null);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(8);
  const [selectedGraphic, setSelectedGraphic] = useState('');
  const [overlayItems, setOverlayItems] = useState<OverlayItem[]>([]);
  const [projectId, setProjectId] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [renderingGraphic, setRenderingGraphic] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const selectedMatch = options?.match || matches.find((row) => row.id === selectedMatchId) || null;
  const maxTimeline = duration || 1;
  const firstHalfDuration = (selectedMatch?.first_half_minutes || 45) * 60;
  const secondHalfDuration = (selectedMatch?.second_half_minutes || 45) * 60;
  const secondHalfBase = firstHalfDuration * 1000;

  const flaClockForVideo = useCallback((videoSec: number) => {
    if (!selectedMatch || firstHalfStart === null) return 0;
    if (firstHalfEnd !== null && videoSec <= firstHalfEnd) {
      const progress = clamp((videoSec - firstHalfStart) / Math.max(.001, firstHalfEnd - firstHalfStart), 0, 1);
      return Math.round(progress * secondHalfBase);
    }
    if (firstHalfEnd === null && (secondHalfStart === null || videoSec < secondHalfStart)) {
      return clamp(Math.round((videoSec - firstHalfStart) * 1000), 0, secondHalfBase);
    }
    if (secondHalfStart !== null && videoSec >= secondHalfStart) {
      if (secondHalfEnd !== null && videoSec <= secondHalfEnd) {
        const progress = clamp((videoSec - secondHalfStart) / Math.max(.001, secondHalfEnd - secondHalfStart), 0, 1);
        return Math.round(secondHalfBase + progress * secondHalfDuration * 1000);
      }
      return Math.max(secondHalfBase, Math.round(secondHalfBase + (videoSec - secondHalfStart) * 1000));
    }
    // 하프타임 구간에서는 전반 종료 프레임을 유지한다.
    return secondHalfBase;
  }, [firstHalfEnd, firstHalfStart, secondHalfBase, secondHalfDuration, secondHalfEnd, secondHalfStart, selectedMatch]);

  const videoTimeForFla = useCallback((clockMs: number) => {
    const flaSeconds = Math.max(0, clockMs) / 1000;
    if (!selectedMatch || firstHalfStart === null) return 0;
    if (flaSeconds <= firstHalfDuration) {
      if (firstHalfEnd !== null) {
        const progress = clamp(flaSeconds / Math.max(1, firstHalfDuration), 0, 1);
        return clamp(firstHalfStart + progress * (firstHalfEnd - firstHalfStart), 0, duration || Number.MAX_SAFE_INTEGER);
      }
      return clamp(firstHalfStart + flaSeconds, 0, duration || Number.MAX_SAFE_INTEGER);
    }
    if (secondHalfStart === null) return clamp(firstHalfEnd ?? firstHalfStart, 0, duration || Number.MAX_SAFE_INTEGER);
    const secondHalfSeconds = flaSeconds - firstHalfDuration;
    if (secondHalfEnd !== null) {
      const progress = clamp(secondHalfSeconds / Math.max(1, secondHalfDuration), 0, 1);
      return clamp(secondHalfStart + progress * (secondHalfEnd - secondHalfStart), 0, duration || Number.MAX_SAFE_INTEGER);
    }
    return clamp(secondHalfStart + secondHalfSeconds, 0, duration || Number.MAX_SAFE_INTEGER);
  }, [duration, firstHalfDuration, firstHalfEnd, firstHalfStart, secondHalfDuration, secondHalfEnd, secondHalfStart, selectedMatch]);

  const selectedFlaClock = flaClockForVideo(rangeStart);

  const loadMatches = useCallback(async () => {
    setLoadingMatches(true);
    setError('');
    try {
      const rows = await apiJson<OverlayMatch[]>(`/highlight/broadcast-overlay/matches?query=${encodeURIComponent(matchQuery.trim())}`);
      setMatches(rows);
      setSelectedMatchId((current) => current && rows.some((row) => row.id === current) ? current : (rows[0]?.id || ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMatches(false);
    }
  }, [matchQuery]);

  const loadOptions = useCallback(async (matchId: string) => {
    if (!matchId) {
      setOptions(null);
      return;
    }
    setLoadingOptions(true);
    setError('');
    try {
      const data = await apiJson<OverlayOptions>(`/highlight/broadcast-overlay/matches/${matchId}/options`);
      setOptions(data);
      setSelectedGraphic((current) => current || data.asset_types[0]?.value || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOptions(false);
    }
  }, []);

  useEffect(() => { void loadMatches(); }, [loadMatches]);
  useEffect(() => { void loadOptions(selectedMatchId); }, [loadOptions, selectedMatchId]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const onPickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] || null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(next);
    setPreviewUrl(next ? URL.createObjectURL(next) : '');
    setDuration(0);
    setCursor(0);
    setFirstHalfStart(null);
    setFirstHalfEnd(null);
    setSecondHalfStart(null);
    setSecondHalfEnd(null);
    setRangeStart(0);
    setRangeEnd(8);
    setProjectId('');
    setSaveMessage('');
  };

  const seek = (nextTime: number) => {
    const next = clamp(nextTime, 0, duration || Number.MAX_SAFE_INTEGER);
    setCursor(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  };

  const onTimelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const node = timelineRef.current;
    if (!node || !duration) return;
    const rect = node.getBoundingClientRect();
    const next = clamp(((event.clientX - rect.left) / rect.width) * duration, 0, duration);
    seek(next);
    // 시각화의 기본 구간도 타임라인에서 고른 영상 시점으로 함께 이동한다.
    setRangeStart(next);
    setRangeEnd(Math.min(duration, next + 8));
  };

  const selectedGraphicMeta = useMemo(() => {
    if (!options || !selectedGraphic) return null;
    if (selectedGraphic.startsWith('goal:')) {
      const goal = options.goal_shot_maps.find((row) => row.event_id === selectedGraphic.slice(5));
      return goal ? { kind: 'goal' as const, goal, label: `득점 xG 샷맵 · ${goal.label}`, duration: goal.default_duration_seconds } : null;
    }
    const graphic = options.asset_types.find((row) => row.value === selectedGraphic);
    return graphic ? { kind: 'graphic' as const, graphic, label: graphic.label, duration: graphic.default_duration_seconds } : null;
  }, [options, selectedGraphic]);

  // 득점 xG 샷맵은 드롭다운에서 장면을 고르는 즉시 해당 FLA 시간을 실제 영상
  // 타임라인 위치로 환산한다. 따라서 0초부터 다시 찾을 필요가 없다.
  useEffect(() => {
    if (!selectedGraphicMeta || selectedGraphicMeta.kind !== 'goal' || !duration) return;
    const start = videoTimeForFla(selectedGraphicMeta.goal.clock_ms);
    const end = Math.min(duration, start + selectedGraphicMeta.duration);
    setRangeStart(start);
    setRangeEnd(end);
    setCursor(start);
    if (videoRef.current) videoRef.current.currentTime = start;
  }, [duration, selectedGraphic, selectedGraphicMeta, videoTimeForFla]);

  const selectedRangeFlaClock = selectedGraphicMeta?.kind === 'goal'
    ? selectedGraphicMeta.goal.clock_ms
    : selectedFlaClock;
  const activeOverlayItem = useMemo(
    () => overlayItems.find((item) => cursor >= item.start_sec - .05 && cursor <= item.end_sec + .05) || null,
    [cursor, overlayItems],
  );
  const extractStart = firstHalfStart;
  const extractEnd = secondHalfEnd === null ? null : Math.min(duration || Number.MAX_SAFE_INTEGER, secondHalfEnd + 5);

  const addOverlayItem = async () => {
    if (!selectedGraphicMeta || !selectedMatch || !duration) {
      setSaveMessage('영상, FLA 경기, 삽입할 시각화를 먼저 선택하세요.');
      return;
    }
    const start = clamp(Math.min(rangeStart, rangeEnd), 0, duration);
    const end = clamp(Math.max(rangeStart, rangeEnd), 0, duration);
    if (end - start < 1) {
      setSaveMessage('그래픽은 최소 1초 이상 노출되도록 구간을 지정하세요.');
      return;
    }
    const item: OverlayItem = selectedGraphicMeta.kind === 'goal'
      ? {
        id: makeId(),
        // Broadcast renderer와 동일한 asset type을 저장한다. 과거 쇼룸 URL의
        // xg-shot-map 표기가 아니라 실제 Live Coder 렌더러의 shot-xg 키를 쓴다.
        asset_type: 'shot-xg',
        label: selectedGraphicMeta.label,
        start_sec: start,
        end_sec: end,
        fla_clock_ms: selectedGraphicMeta.goal.clock_ms,
        goal_event_id: selectedGraphicMeta.goal.event_id,
        goal_label: selectedGraphicMeta.goal.label,
      }
      : {
        id: makeId(),
        asset_type: selectedGraphicMeta.graphic.value,
        label: selectedGraphicMeta.graphic.label,
        start_sec: start,
        end_sec: end,
        fla_clock_ms: selectedFlaClock,
      };
    setRenderingGraphic(true);
    setSaveMessage('Broadcast 그래픽을 실제 PNG 레이어로 생성하는 중…');
    try {
      const rendered = await apiJson<RenderedBroadcastAsset>(
        `/highlight/broadcast-overlay/matches/${selectedMatch.id}/rendered-asset`,
        {
          method: 'POST',
          body: JSON.stringify({
            item_id: item.id,
            asset_type: item.asset_type,
            fla_clock_ms: item.fla_clock_ms,
            goal_event_id: item.goal_event_id,
          }),
        },
      );
      const broadcastItem: OverlayItem = {
        ...item,
        id: rendered.item_id,
        label: rendered.label,
        background_url: rendered.background_url,
        asset_url: rendered.asset_url,
        width: rendered.width,
        height: rendered.height,
        rendered_fla_clock_ms: rendered.rendered_fla_clock_ms,
        ...(rendered.goal_event_id ? { goal_event_id: rendered.goal_event_id } : {}),
      };
      setOverlayItems((rows) => [...rows, broadcastItem].sort((a, b) => a.start_sec - b.start_sec));
      // 삽입 직후 해당 영상 시점으로 이동해 실제 Broadcast PNG 레이어를 바로 보여 준다.
      seek(start);
      setSaveMessage(`${broadcastItem.label}을(를) Broadcast PNG로 ${fmt(start)}–${fmt(end)} 구간에 넣었습니다.`);
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRenderingGraphic(false);
    }
  };

  const removeItem = (id: string) => {
    setOverlayItems((rows) => rows.filter((row) => row.id !== id));
  };

  const updateItem = (id: string, patch: Partial<OverlayItem>) => {
    setOverlayItems((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  };

  const saveProject = async () => {
    if (!selectedMatch || !file || !duration) {
      setSaveMessage('영상과 FLA 경기를 선택한 후 저장할 수 있습니다.');
      return;
    }
    if (firstHalfStart === null || firstHalfEnd === null || secondHalfStart === null || secondHalfEnd === null) {
      setSaveMessage('영상에서 전반·후반 시작과 종료 지점을 모두 지정하세요.');
      return;
    }
    setSaving(true);
    setSaveMessage('편집안을 저장하는 중…');
    const body = {
      match_id: selectedMatch.id,
      name: `${selectedMatch.name} · 중계 오버레이`,
      source_filename: file.name,
      source_duration_seconds: duration,
      first_half_video_start_sec: firstHalfStart,
      first_half_video_end_sec: firstHalfEnd,
      second_half_video_start_sec: secondHalfStart,
      second_half_video_end_sec: secondHalfEnd,
      overlay_items: overlayItems,
    };
    try {
      const project = projectId
        ? await apiJson<OverlayProject>(`/highlight/broadcast-overlay/projects/${projectId}`, { method: 'PUT', body: JSON.stringify(body) })
        : await apiJson<OverlayProject>('/highlight/broadcast-overlay/projects', { method: 'POST', body: JSON.stringify(body) });
      setProjectId(project.id);
      setOverlayItems(project.overlay_items || []);
      setSaveMessage('저장 완료. 이제 이 편집안을 기준으로 영상 렌더링 작업을 등록할 수 있습니다.');
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const insertAtCursor = () => {
    const displayDuration = selectedGraphicMeta?.duration || 8;
    const start = cursor;
    const end = duration ? Math.min(duration, start + displayDuration) : start + displayDuration;
    setRangeStart(start);
    setRangeEnd(end);
  };

  const prepareFulltimeDominance = () => {
    if (secondHalfEnd === null || !duration) {
      setSaveMessage('먼저 후반 종료 지점을 지정하세요.');
      return;
    }
    const start = secondHalfEnd;
    setSelectedGraphic('match-dominance-fulltime');
    setRangeStart(start);
    setRangeEnd(Math.min(duration, start + 5));
    seek(start);
  };

  const markFirstHalfStart = () => {
    if (firstHalfEnd !== null && cursor >= firstHalfEnd) {
      setSaveMessage('전반 시작은 전반 종료보다 앞선 영상 시점으로 지정하세요.');
      return;
    }
    setFirstHalfStart(cursor);
  };
  const markFirstHalfEnd = () => {
    if (firstHalfStart === null || cursor <= firstHalfStart) {
      setSaveMessage('전반 시작 뒤의 영상 시점에서 전반 종료를 지정하세요.');
      return;
    }
    setFirstHalfEnd(cursor);
  };
  const markSecondHalfStart = () => {
    if (firstHalfEnd === null || cursor < firstHalfEnd) {
      setSaveMessage('전반 종료 뒤의 영상 시점에서 후반 시작을 지정하세요.');
      return;
    }
    setSecondHalfStart(cursor);
  };
  const markSecondHalfEnd = () => {
    if (secondHalfStart === null || cursor <= secondHalfStart) {
      setSaveMessage('후반 시작 뒤의 영상 시점에서 후반 종료를 지정하세요.');
      return;
    }
    setSecondHalfEnd(cursor);
  };

  const syncStatus = firstHalfStart !== null && firstHalfEnd !== null && secondHalfStart !== null && secondHalfEnd !== null
    ? `전반 ${fmt(firstHalfStart)}–${fmt(firstHalfEnd)} · 후반 ${fmt(secondHalfStart)}–${fmt(secondHalfEnd)} 기준으로 FLA 시간축이 연결되었습니다.`
    : '전·후반 시작과 종료 지점을 지정하면 FLA 시간축과 영상 구간이 정확히 연결됩니다.';

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <p style={{ margin: 0, color: '#f97316', fontWeight: 800, fontSize: 12, letterSpacing: '.08em' }}>FHL VIDEO OVERLAY</p>
            <h2 style={{ margin: '4px 0 0', fontSize: 21 }}>중계 오버레이 편집</h2>
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted, #999)' }}>원본 영상을 보며 그래픽 구간을 직접 배치합니다.</span>
        </div>
        <p style={{ margin: '10px 0 0', color: 'var(--muted, #999)', fontSize: 13, lineHeight: 1.5 }}>
          전·후반 시작점으로 FLA 시간과 녹화 시간을 맞춘 뒤, 타임라인에서 원하는 구간을 선택해 시각화를 삽입하세요.
          삽입 시 Live Coder가 생성하는 Broadcast용 배경 PNG와 투명 에셋 PNG를 그대로 사용합니다. 득점 xG 샷맵은 반드시 해당 득점 장면을 드롭다운에서 선택합니다.
        </p>
      </div>

      <div style={{ ...card, display: 'grid', gridTemplateColumns: 'minmax(260px, .8fr) minmax(320px, 1.2fr)', gap: 16, alignItems: 'end' }}>
        <div>
          <label style={label}>FLA 기록 경기</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input style={input} value={matchQuery} onChange={(event) => setMatchQuery(event.target.value)} placeholder="대회 또는 팀명 검색" />
            <button style={button} onClick={() => void loadMatches()} disabled={loadingMatches}>검색</button>
          </div>
          <select style={input} value={selectedMatchId} onChange={(event) => { setSelectedMatchId(event.target.value); setOverlayItems([]); setProjectId(''); }} disabled={loadingMatches}>
            <option value="">경기를 선택하세요</option>
            {matches.map((match) => <option key={match.id} value={match.id}>{match.name}</option>)}
          </select>
          {selectedMatch ? <p style={{ margin: '7px 0 0', fontSize: 12, color: '#a7f3d0' }}>FLA 기록 종료 {fmtFla(selectedMatch.latest_fla_clock_ms)} · {selectedMatch.home_team} vs {selectedMatch.away_team}</p> : null}
        </div>
        <div>
          <label style={label}>원본 녹화 영상 <span style={{ color: '#f97316' }}>로컬 미리보기</span></label>
          <input style={input} type="file" accept="video/mp4,video/quicktime,video/webm,video/*" onChange={onPickFile} />
          <p style={{ margin: '7px 0 0', fontSize: 12, color: 'var(--muted, #999)' }}>이 단계에서는 브라우저에서 영상과 타임라인을 맞춥니다. 최종 렌더 시 원본을 저장소에 업로드해 별도 작업 큐에서 처리합니다.</p>
        </div>
      </div>

      {error ? <div style={{ ...card, borderColor: '#ef4444', color: '#fecaca', fontSize: 13 }}>{error}</div> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 330px', gap: 16, alignItems: 'start' }}>
        <section style={card}>
          <div style={{ position: 'relative', background: '#08090b', aspectRatio: '16 / 9', borderRadius: 8, overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
            {previewUrl ? (
              <video
                ref={videoRef}
                src={previewUrl}
                controls
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                onLoadedMetadata={(event) => {
                  const nextDuration = event.currentTarget.duration;
                  event.currentTarget.currentTime = 0;
                  setDuration(nextDuration);
                  setCursor(0);
                  setRangeEnd(Math.min(8, nextDuration));
                }}
                onTimeUpdate={(event) => setCursor(event.currentTarget.currentTime)}
              />
            ) : <span style={{ color: '#737373', fontSize: 14 }}>원본 영상을 선택하면 여기에서 미리볼 수 있습니다.</span>}
            {activeOverlayItem ? (
              <BroadcastOverlayPreview item={activeOverlayItem} />
            ) : null}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
            <button style={{ ...button, borderColor: firstHalfStart === null ? '#52525b' : '#f97316' }} onClick={markFirstHalfStart} disabled={!duration}>현재 위치를 전반 시작으로 지정 {firstHalfStart !== null ? `· ${fmt(firstHalfStart)}` : ''}</button>
            <button style={{ ...button, borderColor: firstHalfEnd === null ? '#52525b' : '#f59e0b' }} onClick={markFirstHalfEnd} disabled={!duration}>현재 위치를 전반 종료로 지정 {firstHalfEnd !== null ? `· ${fmt(firstHalfEnd)}` : ''}</button>
            <button style={{ ...button, borderColor: secondHalfStart === null ? '#52525b' : '#3b82f6' }} onClick={markSecondHalfStart} disabled={!duration}>현재 위치를 후반 시작으로 지정 {secondHalfStart !== null ? `· ${fmt(secondHalfStart)}` : ''}</button>
            <button style={{ ...button, borderColor: secondHalfEnd === null ? '#52525b' : '#22c55e' }} onClick={markSecondHalfEnd} disabled={!duration}>현재 위치를 후반 종료로 지정 {secondHalfEnd !== null ? `· ${fmt(secondHalfEnd)}` : ''}</button>
          </div>
          <p style={{ fontSize: 12, color: firstHalfStart !== null && firstHalfEnd !== null && secondHalfStart !== null && secondHalfEnd !== null ? '#a7f3d0' : 'var(--muted, #999)', margin: '9px 0 0' }}>{syncStatus}</p>
          {extractStart !== null && extractEnd !== null ? <p style={{ fontSize: 12, color: '#fde68a', margin: '5px 0 0' }}>최종 영상 추출 범위: {fmt(extractStart)}–{fmt(extractEnd)} <span style={{ color: '#a1a1aa' }}>(후반 종료 뒤 5초 포함 · 경기 전체 도미넌스 노출)</span></p> : null}

          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <div>
                <strong style={{ fontSize: 14 }}>영상 타임라인</strong>
                <span style={{ color: 'var(--muted, #999)', fontSize: 12, marginLeft: 8 }}>커서 {fmt(cursor)} · FLA {firstHalfStart !== null ? fmtFla(flaClockForVideo(cursor)) : '--:--'}</span>
              </div>
              <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>{fmt(duration)}</span>
            </div>
            <div ref={timelineRef} onClick={onTimelineClick} style={{ position: 'relative', height: 92, borderRadius: 8, cursor: duration ? 'pointer' : 'default', background: 'linear-gradient(180deg, #101215, #17191d)', border: '1px solid #34363b', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', inset: '12px 14px 34px', borderBottom: '1px solid #575a61' }} />
              {firstHalfStart !== null ? <TimelinePin left={(firstHalfStart / maxTimeline) * 100} color="#f97316" label="전반 시작" /> : null}
              {firstHalfEnd !== null ? <TimelinePin left={(firstHalfEnd / maxTimeline) * 100} color="#f59e0b" label="전반 종료" /> : null}
              {secondHalfStart !== null ? <TimelinePin left={(secondHalfStart / maxTimeline) * 100} color="#3b82f6" label="후반 시작" /> : null}
              {secondHalfEnd !== null ? <TimelinePin left={(secondHalfEnd / maxTimeline) * 100} color="#22c55e" label="후반 종료" /> : null}
              {overlayItems.map((item, index) => <div key={item.id} title={`${item.label} · ${fmt(item.start_sec)}–${fmt(item.end_sec)}`} style={{ position: 'absolute', left: `${(item.start_sec / maxTimeline) * 100}%`, width: `${Math.max(1.2, ((item.end_sec - item.start_sec) / maxTimeline) * 100)}%`, top: 40 + (index % 2) * 17, height: 12, borderRadius: 5, background: item.asset_type === 'shot-xg' ? '#2dd4bf' : '#f97316', boxShadow: '0 0 0 1px rgba(0,0,0,.25)' }} />)}
              {duration ? <div style={{ position: 'absolute', top: 8, bottom: 26, left: `${(cursor / maxTimeline) * 100}%`, width: 2, background: '#fff', boxShadow: '0 0 6px rgba(255,255,255,.8)' }} /> : null}
              <div style={{ position: 'absolute', left: 14, bottom: 9, fontSize: 11, color: '#8f939b' }}>0:00</div>
              <div style={{ position: 'absolute', right: 14, bottom: 9, fontSize: 11, color: '#8f939b' }}>{fmt(duration)}</div>
            </div>
          </div>
        </section>

        <aside style={{ ...card, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <p style={{ margin: 0, color: '#f97316', fontSize: 12, fontWeight: 800, letterSpacing: '.06em' }}>INSERT GRAPHIC</p>
            <h3 style={{ margin: '5px 0 0', fontSize: 16 }}>선택 구간에 시각화 넣기</h3>
          </div>
          <div>
            <label style={label}>시각화 선택</label>
            <select style={input} value={selectedGraphic} onChange={(event) => setSelectedGraphic(event.target.value)} disabled={!options || loadingOptions}>
              <option value="">시각화를 선택하세요</option>
              <optgroup label="경기 시점 시각화">
                {options?.asset_types.map((graphic) => <option key={graphic.value} value={graphic.value}>{graphic.label}</option>)}
              </optgroup>
              <optgroup label="득점 장면 xG 샷맵">
                {options?.goal_shot_maps.length ? options.goal_shot_maps.map((goal) => <option key={goal.event_id} value={`goal:${goal.event_id}`}>{goal.label}</option>) : <option disabled>득점 기록이 없습니다</option>}
              </optgroup>
            </select>
            {selectedGraphicMeta?.kind === 'goal' ? <p style={{ fontSize: 12, color: '#99f6e4', margin: '7px 0 0', lineHeight: 1.45 }}>선택한 득점 장면의 FLA 시간 {selectedGraphicMeta.goal.clock}와 xG {selectedGraphicMeta.goal.xg?.toFixed(3) ?? '-'}을 사용하며, 전·후반 기준점에 맞춘 영상 위치로 구간이 자동 이동합니다.</p> : <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '7px 0 0', lineHeight: 1.45 }}>영상 타임라인을 클릭하면 선택 구간도 해당 영상 시점으로 이동합니다. 선택 구간의 시작점에 해당하는 FLA 데이터로 그래픽을 다시 만듭니다.</p>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={label}>영상 시작</label>
              <input style={input} type="number" min="0" max={duration || undefined} step="0.1" value={rangeStart.toFixed(1)} onChange={(event) => setRangeStart(Number(event.target.value))} />
            </div>
            <div>
              <label style={label}>영상 종료</label>
              <input style={input} type="number" min="0" max={duration || undefined} step="0.1" value={rangeEnd.toFixed(1)} onChange={(event) => setRangeEnd(Number(event.target.value))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...button, flex: 1 }} onClick={insertAtCursor} disabled={!duration}>커서부터 {selectedGraphicMeta?.duration || 8}초</button>
            <button style={{ ...primaryButton, flex: 1 }} onClick={() => void addOverlayItem()} disabled={!duration || !selectedGraphicMeta || renderingGraphic}>{renderingGraphic ? 'Broadcast PNG 생성 중…' : '타임라인에 삽입'}</button>
          </div>
          <button style={{ ...button, borderColor: '#22c55e', color: '#bbf7d0' }} onClick={prepareFulltimeDominance} disabled={!duration || secondHalfEnd === null}>후반 종료부터 경기 전체 도미넌스 5초로 설정</button>
          <div style={{ background: '#111317', border: '1px solid #303239', borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.5 }}>
            <strong style={{ color: '#e5e7eb' }}>현재 선택</strong><br />
            <span style={{ color: '#a1a1aa' }}>영상 {fmt(rangeStart)}–{fmt(rangeEnd)} · FLA {firstHalfStart !== null ? fmtFla(selectedRangeFlaClock) : '전반 기준점 필요'}</span>
          </div>
        </aside>
      </div>

      <section style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div>
            <p style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '.06em', color: '#f97316' }}>OVERLAY QUEUE</p>
            <h3 style={{ margin: '4px 0 0', fontSize: 16 }}>삽입된 그래픽 {overlayItems.length}개</h3>
          </div>
          <button style={{ ...primaryButton, marginLeft: 'auto' }} onClick={() => void saveProject()} disabled={saving || !file || !selectedMatch}>{saving ? '저장 중…' : '편집안 저장'}</button>
        </div>
        {overlayItems.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {overlayItems.map((item) => (
              <div key={item.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) 92px 92px 100px 56px', gap: 8, alignItems: 'center', background: '#15171b', border: '1px solid #303239', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
                <div><strong>{item.label}</strong><div style={{ color: '#a1a1aa', fontSize: 11, marginTop: 3 }}>FLA {fmtFla(item.fla_clock_ms)}{item.goal_label ? ` · ${item.goal_label}` : ''}{item.asset_url ? ' · Broadcast PNG 준비됨' : ''}</div></div>
                <input style={{ ...input, padding: '5px 7px' }} type="number" min="0" step="0.1" value={item.start_sec.toFixed(1)} onChange={(event) => updateItem(item.id, { start_sec: Number(event.target.value) })} />
                <input style={{ ...input, padding: '5px 7px' }} type="number" min="0" step="0.1" value={item.end_sec.toFixed(1)} onChange={(event) => updateItem(item.id, { end_sec: Number(event.target.value) })} />
                <span style={{ color: '#a1a1aa', fontSize: 12 }}>{fmt(item.start_sec)}–{fmt(item.end_sec)}</span>
                <button style={{ ...button, padding: '5px 8px', color: '#fca5a5' }} onClick={() => removeItem(item.id)}>삭제</button>
              </div>
            ))}
          </div>
        ) : <div style={{ padding: 24, border: '1px dashed #42444b', borderRadius: 8, color: '#8f939b', fontSize: 13, textAlign: 'center' }}>타임라인에서 구간을 정하고 시각화를 삽입하면 이곳에 쌓입니다.</div>}
        {saveMessage ? <p style={{ fontSize: 12, margin: '12px 0 0', color: saveMessage.includes('완료') ? '#a7f3d0' : '#c4b5fd' }}>{saveMessage}</p> : null}
      </section>
    </div>
  );
}

function TimelinePin({ left, color, label }: { left: number; color: string; label: string }) {
  return (
    <div style={{ position: 'absolute', left: `${left}%`, top: 10, bottom: 26, borderLeft: `2px dashed ${color}`, pointerEvents: 'none' }}>
      <span style={{ position: 'absolute', top: -1, left: 5, color, whiteSpace: 'nowrap', fontSize: 11, fontWeight: 700 }}>{label}</span>
    </div>
  );
}

function BroadcastOverlayPreview({ item }: { item: OverlayItem }) {
  const hasLayers = Boolean(item.background_url && item.asset_url);
  return (
    <div
      aria-label="Broadcast 그래픽 미리보기"
      style={{
        position: 'absolute',
        right: '3.5%',
        bottom: '5.5%',
        width: '48%',
        minWidth: 250,
        aspectRatio: '16 / 9',
        pointerEvents: 'none',
        overflow: 'hidden',
        background: '#101215',
        border: '1px solid rgba(255,255,255,.3)',
        boxShadow: '0 12px 28px rgba(0,0,0,.52)',
      }}
    >
      {hasLayers ? (
        <>
          <img src={item.background_url} alt="" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
          <img src={item.asset_url} alt={`${item.label} Broadcast 그래픽`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
          <span style={{ position: 'absolute', left: 8, top: 8, padding: '3px 6px', borderRadius: 4, background: 'rgba(0,0,0,.62)', color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: '.05em' }}>BROADCAST PNG</span>
        </>
      ) : (
        <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 18, color: '#d4d4d8', fontSize: 12, textAlign: 'center' }}>
          이전에 저장된 항목입니다. 다시 삽입하면 실제 Broadcast PNG 레이어로 교체됩니다.
        </div>
      )}
    </div>
  );
}
