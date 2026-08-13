'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type AssetPair = { png_url: string; webp_url: string; generated_at?: string };
type AssetManifest = {
  live?: Record<string, AssetPair>;
  archive?: Record<string, Record<string, AssetPair>>;
  dominance?: Record<string, AssetPair>;
  last_generated_at?: string | null;
};

type BroadcastMatch = {
  match_id: string;
  name: string;
  home_team: string;
  away_team: string;
  competition_class: string;
  round_number: number;
  status: 'LIVE' | 'OPEN';
  clock_ms: number;
  assets: AssetManifest;
  generated_at?: string | null;
};

const LIVE_LABELS: Record<string, string> = {
  'attack-direction-home': '공격 방향 · 홈',
  'attack-direction-away': '공격 방향 · 어웨이',
  possession: '점유율',
  'xg-shot-map': 'xG 샷 맵',
};

const minuteLabel = (value: string) => `${value}분`;

function formatTime(value?: string | null) {
  if (!value) return '아직 생성되지 않음';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
}

function AssetCard({ title, asset }: { title: string; asset?: AssetPair }) {
  const [format, setFormat] = useState<'webp' | 'png'>('webp');
  if (!asset) {
    return (
      <article className="broadcast-asset-card broadcast-asset-pending">
        <p>{title}</p>
        <strong>생성 대기</strong>
      </article>
    );
  }
  const url = format === 'webp' ? asset.webp_url : asset.png_url;
  return (
    <article className="broadcast-asset-card">
      <header>
        <strong>{title}</strong>
        <div className="broadcast-format-toggle" aria-label={`${title} format`}>
          <button className={format === 'webp' ? 'selected' : ''} onClick={() => setFormat('webp')}>WebP</button>
          <button className={format === 'png' ? 'selected' : ''} onClick={() => setFormat('png')}>PNG</button>
        </div>
      </header>
      <a href={url} target="_blank" rel="noreferrer" title="원본 자산 열기">
        <img src={url} alt={`${title} ${format.toUpperCase()}`} />
      </a>
      <footer>{formatTime(asset.generated_at)}</footer>
    </article>
  );
}

function AssetUrlLinks({ title, asset }: { title: string; asset?: AssetPair }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!asset) return null;
  const copy = async (format: 'PNG' | 'WebP', url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(format);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };
  return (
    <div className="broadcast-asset-urls">
      <strong>{title}</strong>
      {([['PNG', asset.png_url], ['WebP', asset.webp_url]] as const).map(([format, url]) => (
        <div className="broadcast-asset-url" key={format}>
          <span>{format}</span>
          <a href={url} target="_blank" rel="noreferrer" title={url}>{url}</a>
          <button type="button" onClick={() => copy(format, url)}>{copied === format ? '복사됨' : '복사'}</button>
        </div>
      ))}
    </div>
  );
}

function useBroadcastResource<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json() as T;
        if (alive) {
          setData(next);
          setError(null);
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : '데이터를 불러오지 못했습니다.');
      }
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [url]);

  return { data, error };
}

export function BroadcastShowroomIndex() {
  const { data, error } = useBroadcastResource<{ generated_at: string; matches: BroadcastMatch[] }>('/api/broadcast/v1/live-matches');
  const matches = data?.matches || [];
  return (
    <main className="broadcast-showroom">
      <section className="broadcast-hero">
        <span>FINEPLAY BROADCAST</span>
        <h1>라이브 그래픽 쇼룸</h1>
        <p>매분 업데이트되는 PNG와 Animated WebP를 중계 오버레이 또는 웹에서 바로 사용합니다.</p>
        <small>마지막 목록 갱신: {formatTime(data?.generated_at)}</small>
      </section>
      {error ? <p className="broadcast-error">목록을 불러오지 못했습니다: {error}</p> : null}
      <section className="broadcast-match-grid">
        {matches.map((match) => (
          <Link className="broadcast-match-card" href={`/matches/${match.match_id}`} key={match.match_id}>
            <div className="broadcast-match-top"><span className={match.status === 'LIVE' ? 'live' : 'open'}>{match.status}</span><small>{match.competition_class} · R{match.round_number}</small></div>
            <strong>{match.home_team} <i>vs</i> {match.away_team}</strong>
            <p>{match.name}</p>
            <footer>{match.assets.live && Object.keys(match.assets.live).length ? '최신 그래픽 준비됨' : '그래픽 생성 대기'}</footer>
          </Link>
        ))}
        {!error && data && !matches.length ? <p className="broadcast-empty">현재 쇼룸에 표시할 미아카이브 경기가 없습니다.</p> : null}
      </section>
    </main>
  );
}

export function BroadcastShowroomMatch({ matchId }: { matchId: string }) {
  const { data: match, error } = useBroadcastResource<BroadcastMatch>(`/api/broadcast/v1/matches/${matchId}`);
  const archiveMinutes = useMemo(() => Object.keys(match?.assets.archive || {}).sort((a, b) => Number(a) - Number(b)), [match]);
  if (error) return <main className="broadcast-showroom"><p className="broadcast-error">경기를 불러오지 못했습니다: {error}</p></main>;
  if (!match) return <main className="broadcast-showroom"><p className="broadcast-loading">그래픽을 불러오는 중입니다.</p></main>;
  return (
    <main className="broadcast-showroom">
      <Link href="/" className="broadcast-back">← 경기 목록</Link>
      <section className="broadcast-hero broadcast-match-hero">
        <span>{match.status} · {match.competition_class} R{match.round_number}</span>
        <h1>{match.home_team} <i>vs</i> {match.away_team}</h1>
        <p>{match.name} · 마지막 생성 {formatTime(match.generated_at)}</p>
        <div className="broadcast-live-url-list" aria-label="실시간 에셋 URL">
          {Object.entries(LIVE_LABELS).map(([type, label]) => <AssetUrlLinks key={type} title={label} asset={match.assets.live?.[type]} />)}
        </div>
      </section>

      <section className="broadcast-section">
        <div className="broadcast-section-heading"><h2>실시간 그래픽</h2><p>중계 오버레이에는 Animated WebP, 호환용으로 PNG URL을 제공합니다.</p></div>
        <div className="broadcast-assets-grid">
          {Object.entries(LIVE_LABELS).map(([type, label]) => <AssetCard key={type} title={label} asset={match.assets.live?.[type]} />)}
        </div>
      </section>

      <section className="broadcast-section">
        <div className="broadcast-section-heading"><h2>15분 아카이브</h2><p>15·30·45·60·75·90분의 라이브 그래픽 24장을 고정 보관합니다.</p></div>
        {archiveMinutes.map((minute) => (
          <div className="broadcast-archive-row" key={minute}>
            <h3>{minuteLabel(minute)}</h3>
            <div className="broadcast-assets-grid">
              {Object.entries(LIVE_LABELS).map(([type, label]) => <AssetCard key={type} title={label} asset={match.assets.archive?.[minute]?.[type]} />)}
            </div>
          </div>
        ))}
        {!archiveMinutes.length ? <p className="broadcast-empty">첫 15분 아카이브가 생성되면 이곳에 추가됩니다.</p> : null}
      </section>

      <section className="broadcast-section">
        <div className="broadcast-section-heading"><h2>매치 도미넌스</h2><p>전반 종료와 경기 종료 시점, 총 2장을 보관합니다.</p></div>
        <div className="broadcast-assets-grid">
          <AssetCard title="전반 종료" asset={match.assets.dominance?.halftime} />
          <AssetCard title="경기 종료" asset={match.assets.dominance?.fulltime} />
        </div>
      </section>
    </main>
  );
}
