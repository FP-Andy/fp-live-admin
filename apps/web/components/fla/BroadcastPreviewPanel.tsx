'use client';

import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE } from '../../lib/api';
import { errorFromResponse, FpcError, type ErrorInfo } from '../../lib/error-messages';
import ErrorNotice from '../ErrorNotice';
import { brandingSources, checkBranding, matchTeamNames, SOURCE_LABELS, type BrandingKey, type BrandingSource, type PublicBranding, type Side } from './broadcast-preview-data';
import './broadcast-preview.css';

/**
 * 매치 컨트롤 · 중계 데이터 미리보기 — 쇼룸(broadcast.fineludens.kr)과 중계업체가 받는 정보(경기·팀·로고·색)와
 * 그림을 그대로 보여 준다. 팀·브랜딩 점검은 broadcast-preview-data.ts.
 *
 * 주 기능이 아니라서 서버에 짐이 되지 않게 한다(이사67, 2026-11-04).
 * - 접혀 있으면 요청 0건. 펼쳤고 탭이 보일 때만 60초(= 서버 BROADCAST_ASSET_REFRESH_SECONDS)마다 공개 JSON 1건.
 *   실패하면 간격을 두 배씩(최대 10분) 늘리고, 성공하면 60초로 돌아온다.
 * - 새 렌더·캡처·refresh 호출은 하지 않는다. 이미 있는 공개 GET /api/broadcast/v1/matches/{id} 의 manifest 만 읽는다.
 * - 그림 주소는 ?v=(생성 시각) 가 그대로면 같은 문자열을 유지해 다시 받지 않는다.
 *   배경 층은 정적 템플릿이라 ?v= 가 매분 바뀌어도 내용이 같다 → 같은 경로면 처음 받은 주소를 계속 쓴다
 *   (템플릿을 바꿀 땐 파일 이름 background-vN 을 올리므로 경로가 바뀌어 새로 받는다).
 * - 보관본·득점·우세도는 개수만 보이고, 그림은 마우스를 올렸을 때만 받는다.
 * - 보관된 경기는 그림이 더 바뀌지 않으므로 처음 한 번만 읽는다.
 * - 팀 로고도 응답 주소 그대로 쓰므로 같은 주소면 다시 받지 않는다. 접힌 줄의 요약은 마지막으로 펼쳤을 때 값
 *   (없으면 매치 컨트롤이 가진 경기 정보)이라 접힌 동안 요청이 없다.
 */

const REFRESH_MS = 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const STALE_MS = 3 * 60_000;
const OPEN_KEY = 'fpc.match.broadcastPreview.open';
const SUMMARY_KEY = 'fpc.match.broadcastPreview.summary';
const DISABLED_DETAIL = 'Broadcast graphics are disabled for this match';

type AssetPair = { background_url: string; asset_url: string; generated_at?: string };
type PublicMatch = {
  match_id: string;
  name?: string;
  home_team?: string;
  away_team?: string;
  competition_class?: string;
  round_number?: number;
  branding?: PublicBranding;
  status: 'LIVE' | 'OPEN' | 'ARCHIVED';
  clock_ms: number;
  archived: boolean;
  generated_at?: string | null;
  assets: {
    live?: Record<string, AssetPair>;
    archive?: Record<string, Record<string, AssetPair>>;
    xg_goals?: Record<string, AssetPair & { event_clock?: string; event_clock_ms?: number }>;
    dominance?: Record<string, AssetPair>;
    last_generated_at?: string | null;
  };
};

const LIVE_ITEMS: [string, string][] = [
  ['attack-direction-home', '공격 방향 HOME'],
  ['attack-direction-away', '공격 방향 AWAY'],
  ['possession', '점유율'],
  ['shots-comparison', '슈팅 비교'],
  ['xg-comparison', 'xG 비교'],
];
const DOMINANCE_ITEMS: [string, string][] = [['halftime', '전반'], ['fulltime', '경기']];
const STATUS_LABELS: Record<PublicMatch['status'], string> = { LIVE: '시계 진행 중', OPEN: '시계 멈춤', ARCHIVED: '보관됨' };

function clockLabel(ms: number) {
  // 매치 컨트롤 시계와 같은 표기 — 분은 60을 넘어도 계속 센다.
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

type PreviewItem = { label: string; background: string; asset: string };
type Hover = { items: PreviewItem[]; title: string; rect: DOMRect };

function parseUtc(value?: string | null): number | null {
  if (!value) return null;
  // 서버는 UTC 를 시간대 표시 없이 준다(datetime.utcnow().isoformat()).
  const time = Date.parse(/Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(time) ? null : time;
}

function ago(value: string | null | undefined, now: number): string {
  const time = parseUtc(value);
  if (time == null) return '-';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return '방금';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return new Date(time).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function clockTime(value?: string | null): string {
  const time = parseUtc(value);
  return time == null ? '' : new Date(time).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Seoul' });
}

/** 앱 서버가 직접 내보내는 그림(/api/broadcast/assets/…)은 지금 화면과 같은 주소로 받는다.
 *  운영은 같은 서버라 결과가 같고, 로컬은 manifest 가 운영 도메인을 가리켜도 로컬 파일을 본다. CDN 주소는 그대로. */
function sameOriginAsset(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname.startsWith('/api/broadcast/assets/')) return `${parsed.pathname}${parsed.search}`;
  } catch {
    // 주소가 이상하면 받은 그대로 둔다.
  }
  return url;
}

function showroomUrl(matchId: string): string {
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('fineludens.kr')) return `https://broadcast.fineludens.kr/matches/${matchId}`;
  return `/broadcast/matches/${matchId}`;
}

export default function BroadcastPreviewPanel({ matchId, match }: { matchId: string; match: any }) {
  const graphicsOff = match?.metadata?.broadcast_enabled === false;
  const [open, setOpen] = useState(false);
  const [savedSummary, setSavedSummary] = useState('');
  const [failedLogos, setFailedLogos] = useState<string[]>([]);
  const [data, setData] = useState<PublicMatch | null>(null);
  const [serverOff, setServerOff] = useState(false);
  const [failure, setFailure] = useState<{ info: ErrorInfo; retryMs: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [hover, setHover] = useState<Hover | null>(null);
  const backgrounds = useRef(new Map<string, string>());
  const off = graphicsOff || serverOff;

  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(OPEN_KEY) === '1');
      const saved = JSON.parse(window.localStorage.getItem(SUMMARY_KEY) || 'null');
      if (saved && saved.matchId === matchId && typeof saved.text === 'string') setSavedSummary(saved.text);
    } catch { /* 저장소를 못 쓰면 접힌 채로 둔다. */ }
  }, []);

  useEffect(() => {
    if (!open || off) return undefined;
    let alive = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let delay = REFRESH_MS;
    let lastAt = 0;
    let stopped = false;
    const schedule = (ms: number) => { window.clearTimeout(timer); timer = window.setTimeout(load, ms); };
    async function load() {
      if (!alive || document.visibilityState !== 'visible') return;
      lastAt = Date.now();
      controller = new AbortController();
      try {
        const response = await fetch(`${API_BASE}/broadcast/v1/matches/${matchId}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!alive) return;
        if (!response.ok) {
          const error = await errorFromResponse(response, { fixed: '중계 데이터를 불러오지 못했습니다.' });
          if (response.status === 404 && error.detail === DISABLED_DETAIL) {
            // 꺼진 경기는 다시 물어도 같다 — 더 묻지 않는다.
            setServerOff(true);
            return;
          }
          throw error;
        }
        const next = await response.json() as PublicMatch;
        if (!alive) return;
        setData(next);
        setFailure(null);
        delay = REFRESH_MS;
        // 보관된 경기는 워커가 더 그리지 않는다 — 한 번만 읽고 멈춘다(다시 펼치면 다시 읽는다).
        if (next.archived) { stopped = true; return; }
      } catch (cause) {
        if (!alive || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        const message = '중계 데이터를 불러오지 못했습니다.';
        const info: ErrorInfo = cause instanceof FpcError ? { ...cause.info(), message } : { message, raw: String(cause) };
        setFailure({ info, retryMs: delay });
      } finally {
        setNow(Date.now());
      }
      if (alive) schedule(delay);
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') { window.clearTimeout(timer); return; }
      if (stopped) return;
      // 다시 보이면 남은 시간만 기다린다. 숨어 있던 동안 밀린 요청을 한꺼번에 보내지 않는다.
      schedule(Math.max(0, lastAt + delay - Date.now()));
    };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [open, off, matchId]);

  // "1분 전" 글자만 새로 쓴다 — 요청은 없다.
  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!hover) return undefined;
    const hide = () => setHover(null);
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', hide, { capture: true });
  }, [hover]);

  useEffect(() => { if (!open) setHover(null); }, [open]);

  const background = (url: string) => {
    const resolved = sameOriginAsset(url);
    const key = resolved.split('?')[0];
    if (!backgrounds.current.has(key)) backgrounds.current.set(key, resolved);
    return backgrounds.current.get(key) as string;
  };
  const item = (label: string, asset: AssetPair): PreviewItem => ({ label, background: background(asset.background_url), asset: sameOriginAsset(asset.asset_url) });
  const showHover = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>, title: string, items: PreviewItem[]) => {
    setHover({ title, items, rect: event.currentTarget.getBoundingClientRect() });
  };
  const hideHover = () => setHover(null);

  const assets = data?.assets;
  const live = assets?.live || {};
  const liveCount = LIVE_ITEMS.filter(([type]) => live[type]).length;
  const lastGenerated = assets?.last_generated_at || data?.generated_at || null;
  const lastTime = parseUtc(lastGenerated);
  const started = !!data && (data.clock_ms > 0 || data.status === 'LIVE');
  const inProgress = !!data && !data.archived && started;
  const stale = inProgress && liveCount > 0 && lastTime != null && now - lastTime > STALE_MS;
  const missingTooLong = inProgress && liveCount === 0 && data.clock_ms > STALE_MS;
  const archiveMinutes = Object.keys(assets?.archive || {}).sort((a, b) => Number(a) - Number(b));
  const goals = Object.values(assets?.xg_goals || {}).sort((a, b) => Number(a.event_clock_ms || 0) - Number(b.event_clock_ms || 0));
  const dominance = DOMINANCE_ITEMS.filter(([slot]) => assets?.dominance?.[slot]);
  const branding: PublicBranding = data?.branding || {};
  const check = data ? checkBranding({ matchName: data.name, homeTeam: data.home_team, awayTeam: data.away_team, branding, failedLogos: failedLogos as Side[] }) : null;
  const sources = data ? brandingSources(match?.metadata, branding) : null;
  const knownTeams = matchTeamNames(match);
  const liveSummary = data && check
    ? [`HOME ${data.home_team || '-'}`, `AWAY ${data.away_team || '-'}`, check.missingLogos.length ? `로고 없음 ${check.missingLogos.length}` : '', check.warnings.some((warning) => warning.startsWith('HOME·AWAY 색')) ? '색 확인' : ''].filter(Boolean).join(' · ')
    : '';
  const teamSummary = liveSummary || savedSummary || (match ? `HOME ${knownTeams.HOME} · AWAY ${knownTeams.AWAY}` : '');

  useEffect(() => {
    if (!liveSummary) return;
    try { window.localStorage.setItem(SUMMARY_KEY, JSON.stringify({ matchId, text: liveSummary })); } catch { /* 요약만 못 남길 뿐이다. */ }
  }, [liveSummary, matchId]);

  let summaryNote = '';
  if (off) summaryNote = '꺼짐';
  else if (open && stale) summaryNote = `${ago(lastGenerated, now)} 이후 안 바뀜`;
  else if (open && lastTime != null) summaryNote = `마지막 생성 ${ago(lastGenerated, now)}`;

  const renderBody = () => {
    if (off) return <p className="fpc-bp-note">중계 그래픽이 꺼진 경기입니다. 경기를 만들 때 ‘Broadcast 그래픽 생성’을 끄면 그림을 만들지 않습니다.</p>;
    if (!data) {
      if (failure) return null;
      return <p className="fpc-bp-note">불러오는 중…</p>;
    }
    return (
      <>
        {renderData(data)}
        {renderImages(data)}
      </>
    );
  };

  const teamCard = (side: Side, name: string | undefined) => {
    const lower = side.toLowerCase() as 'home' | 'away';
    const logoKey = `${lower}_logo_url` as BrandingKey;
    const colorKey = `${lower}_color` as BrandingKey;
    const logo = String(branding[logoKey as keyof PublicBranding] || '').trim();
    const color = String(branding[colorKey as keyof PublicBranding] || '');
    const sourceText = (key: BrandingKey, empty: string) => {
      const source: BrandingSource | null | undefined = sources?.[key];
      if (source === null) return '출처 확인 못 함';
      if (!source) return '';
      return source === 'default' ? empty : SOURCE_LABELS[source];
    };
    const logoFailed = failedLogos.includes(side);
    return (
      <div className="fpc-bp-team" key={side}>
        <span className="fpc-bp-team-side">{side}</span>
        <span className={`fpc-bp-logo${logo && !logoFailed ? '' : ' is-empty'}`}>
          {logo && !logoFailed
            ? <img src={sameOriginAsset(logo)} alt={`${name || side} 로고`} loading="lazy" decoding="async" onError={() => setFailedLogos((list) => (list.includes(side) ? list : [...list, side]))} />
            : <span>{logoFailed ? '못 불러옴' : '로고 없음'}</span>}
        </span>
        <span className="fpc-bp-team-text">
          <strong className="fpc-bp-team-name">{name || '-'}</strong>
          <span className="fpc-bp-team-meta">
            <span className="fpc-bp-swatch" style={{ backgroundColor: color }} aria-hidden />
            <span className="fpc-bp-mono">{color || '-'}</span>
            <span className="fpc-bp-source">색: {sourceText(colorKey, '기본값')}</span>
            <span className="fpc-bp-source" title={logo || undefined}>로고: {sourceText(logoKey, '없음')}</span>
          </span>
        </span>
      </div>
    );
  };

  const renderData = (current: PublicMatch) => (
    <div className="fpc-bp-data">
      <dl className="fpc-bp-facts">
        <div className="is-wide"><dt>경기</dt><dd>{current.name || '-'}</dd></div>
        <div><dt>대회</dt><dd>{current.competition_class || '-'} · {current.round_number || 1}R</dd></div>
        <div><dt>상태</dt><dd title={current.status}>{current.status} · {STATUS_LABELS[current.status] || ''}</dd></div>
        <div><dt>경기 시계</dt><dd className="fpc-bp-mono">{clockLabel(current.clock_ms || 0)}</dd></div>
        <div><dt>마지막 생성</dt><dd title={clockTime(lastGenerated)}>{lastTime == null ? '아직 없음' : `${ago(lastGenerated, now)} · ${clockTime(lastGenerated)}`}</dd></div>
      </dl>
      <div className="fpc-bp-teams">
        {teamCard('HOME', current.home_team)}
        {teamCard('AWAY', current.away_team)}
      </div>
      {check?.warnings.map((warning) => <p className="fpc-bp-warn" role="status" key={warning}>{warning}</p>)}
    </div>
  );

  const renderImages = (current: PublicMatch) => {
    const data = current;
    if (!liveCount) {
      if (missingTooLong) return <p className="fpc-bp-warn" role="status">경기가 3분 넘게 진행됐는데 그림이 없습니다. 중계 그래픽 생성이 멈췄는지 확인해 주세요.</p>;
      if (data.archived) return <p className="fpc-bp-note">이 경기는 만든 그림이 없습니다.</p>;
      if (!started) return <p className="fpc-bp-note">경기 시작 전입니다. 경기를 시작하면 1분 안에 그림이 나옵니다.</p>;
      return <p className="fpc-bp-note">아직 그림이 없습니다. 1분쯤 지나면 나옵니다.</p>;
    }
    return (
      <>
        {stale ? <p className="fpc-bp-warn" role="status">그림이 3분 넘게 안 바뀌었습니다. 마지막 생성 {ago(lastGenerated, now)} ({clockTime(lastGenerated)})</p> : null}
        <div className="fpc-bp-thumbs">
          {LIVE_ITEMS.map(([type, label]) => {
            const asset = live[type];
            if (!asset) return <div className="fpc-bp-thumb fpc-bp-thumb-empty" key={type}><span className="fpc-bp-frame"><span>아직 없음</span></span><span className="fpc-bp-label">{label}</span></div>;
            const preview = item(label, asset);
            return (
              <a
                className="fpc-bp-thumb"
                key={type}
                href={preview.asset}
                target="_blank"
                rel="noreferrer"
                title={`${label} · 새 탭에서 원본 PNG`}
                onMouseEnter={(event) => showHover(event, label, [preview])}
                onMouseLeave={hideHover}
                onFocus={(event) => showHover(event, label, [preview])}
                onBlur={hideHover}
              >
                <span className="fpc-bp-frame">
                  <img src={preview.background} alt="" loading="lazy" decoding="async" />
                  <img src={preview.asset} alt={label} loading="lazy" decoding="async" />
                </span>
                <span className="fpc-bp-label">{label}</span>
                <span className="fpc-bp-time" title={clockTime(asset.generated_at)}>{ago(asset.generated_at, now)}</span>
              </a>
            );
          })}
        </div>
        {archiveMinutes.length || goals.length || dominance.length ? (
          <div className="fpc-bp-extras">
            {archiveMinutes.length ? (
              <span className="fpc-bp-group">
                <span className="fpc-bp-group-name">보관본 {archiveMinutes.length}개</span>
                {archiveMinutes.map((minute) => {
                  const items = LIVE_ITEMS.flatMap(([type, label]) => {
                    const asset = assets?.archive?.[minute]?.[type];
                    return asset ? [item(label, asset)] : [];
                  });
                  return (
                    <a
                      key={minute}
                      className="fpc-bp-chip"
                      href={showroomUrl(matchId)}
                      target="_blank"
                      rel="noreferrer"
                      onMouseEnter={(event) => showHover(event, `${minute}분 보관본`, items)}
                      onMouseLeave={hideHover}
                      onFocus={(event) => showHover(event, `${minute}분 보관본`, items)}
                      onBlur={hideHover}
                    >{minute}분</a>
                  );
                })}
              </span>
            ) : null}
            {goals.length ? (
              <span className="fpc-bp-group">
                <span className="fpc-bp-group-name">득점 xG {goals.length}개</span>
                {goals.map((goal, index) => {
                  const label = `득점 ${index + 1}${goal.event_clock ? ` · ${goal.event_clock}` : ''}`;
                  const preview = item(label, goal);
                  return (
                    <a key={goal.asset_url} className="fpc-bp-chip" href={preview.asset} target="_blank" rel="noreferrer"
                      onMouseEnter={(event) => showHover(event, label, [preview])} onMouseLeave={hideHover}
                      onFocus={(event) => showHover(event, label, [preview])} onBlur={hideHover}
                    >{goal.event_clock || `${index + 1}`}</a>
                  );
                })}
              </span>
            ) : null}
            {dominance.length ? (
              <span className="fpc-bp-group">
                <span className="fpc-bp-group-name">우세도 {dominance.length}개</span>
                {dominance.map(([slot, name]) => {
                  const preview = item(`${name} 우세도`, assets?.dominance?.[slot] as AssetPair);
                  return (
                    <a key={slot} className="fpc-bp-chip" href={preview.asset} target="_blank" rel="noreferrer"
                      onMouseEnter={(event) => showHover(event, preview.label, [preview])} onMouseLeave={hideHover}
                      onFocus={(event) => showHover(event, preview.label, [preview])} onBlur={hideHover}
                    >{name}</a>
                  );
                })}
              </span>
            ) : null}
          </div>
        ) : null}
      </>
    );
  };

  return (
    <details
      className="card card-utility fpc-bp"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        try { window.localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* 기억만 못 할 뿐 동작은 같다. */ }
      }}
    >
      <summary>
        <span>중계 데이터 미리보기</span>
        {teamSummary ? <span className="fpc-bp-summary-note" title={liveSummary ? undefined : '마지막으로 펼쳤을 때 값'}>{teamSummary}</span> : null}
        {summaryNote ? <span className={`fpc-bp-summary-note${stale ? ' is-warn' : ''}`}>{summaryNote}</span> : null}
      </summary>
      {open ? (
        <div className="fpc-bp-body">
          {off ? null : (
            <div className="fpc-bp-head">
              <span className="fpc-bp-note">쇼룸·중계업체가 받는 정보와 그림입니다. 펼쳐 둔 동안 1분마다 확인합니다.</span>
              <a className="fpc-bp-link" href={showroomUrl(matchId)} target="_blank" rel="noreferrer">쇼룸에서 보기 ↗</a>
            </div>
          )}
          {failure ? (
            <ErrorNotice
              className="fpc-bp-error"
              info={failure.info}
              message={`${failure.info.message} ${Math.round(failure.retryMs / 60_000)}분 뒤 다시 확인합니다.`}
            />
          ) : null}
          {renderBody()}
        </div>
      ) : null}
      {/* .card 의 backdrop-filter 안에서는 position: fixed 가 카드 기준이 된다 — body 로 뺀다. */}
      {hover ? createPortal(<HoverPreview hover={hover} />, document.body) : null}
    </details>
  );
}

function HoverPreview({ hover }: { hover: Hover }) {
  const single = hover.items.length === 1;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(single ? 960 : 1080, viewportWidth * (single ? 0.6 : 0.72));
  const columns = single ? 1 : 3;
  const rows = Math.ceil(hover.items.length / columns);
  const frameHeight = (width / columns) * (9 / 16);
  const height = rows * frameHeight + 34 + (single ? 0 : rows * 22);
  const spaceAbove = hover.rect.top;
  const top = spaceAbove >= height + 12
    ? hover.rect.top - height - 8
    : Math.min(hover.rect.bottom + 8, Math.max(8, viewportHeight - height - 8));
  const left = Math.min(Math.max(8, hover.rect.left + hover.rect.width / 2 - width / 2), Math.max(8, viewportWidth - width - 8));
  return (
    <div className="fpc-bp-hover" style={{ top, left, width }} aria-hidden>
      <strong>{hover.title}</strong>
      <div className="fpc-bp-hover-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {hover.items.map((preview) => (
          <figure key={preview.asset}>
            <span className="fpc-bp-frame">
              <img src={preview.background} alt="" decoding="async" />
              <img src={preview.asset} alt="" decoding="async" />
            </span>
            {single ? null : <figcaption>{preview.label}</figcaption>}
          </figure>
        ))}
      </div>
    </div>
  );
}
