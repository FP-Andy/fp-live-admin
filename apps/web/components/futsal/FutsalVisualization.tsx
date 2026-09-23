'use client';
import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../lib/api';
import { pngArchive } from '../../lib/pngArchive';
import { download, graphics, safeName, svgPng, type Match, type Shot, type Summary, type Dominance, type Options, type Graphic } from './graphics';
export default function FutsalVisualization() {
    const [matches, setMatches] = useState<Match[]>([]), [selected, setSelected] = useState('');
    const [data, setData] = useState<{
        id: string;
        events: Shot[];
        summary: Summary;
        dominance: Dominance;
    } | null>(null);
    const [error, setError] = useState(''), [loading, setLoading] = useState(true), [exporting, setExporting] = useState(false), [revision, setRevision] = useState(0);
    const [options, setOptions] = useState<Options>({ home: '#ff7400', away: '#2158e8', background: 'dark' });
    useEffect(() => {
        let active = true;
        (async () => {
            const all: Match[] = [];
            let total = 1;
            while (all.length < total) {
                const page = await apiJson<{
                    items: Match[];
                    total: number;
                }>(`/matches/page?sport=FUTSAL&limit=100&offset=${all.length}&compact=false`);
                if (!active)
                    return;
                all.push(...page.items);
                total = page.total;
                if (!page.items.length)
                    break;
            }
            setMatches(all);
            const requested = new URLSearchParams(window.location.search).get('match');
            setSelected(all.find(m => m.id === requested)?.id || all[0]?.id || '');
            if (!all.length)
                setLoading(false);
        })().catch(() => { if (active) {
            setError('경기 목록을 불러오지 못했습니다. 새로고침해 주세요.');
            setLoading(false);
        } });
        return () => { active = false; };
    }, []);
    useEffect(() => {
        if (!selected)
            return;
        let active = true;
        setLoading(true);
        setError('');
        setData(null);
        Promise.all([apiJson<{
                events: Shot[];
            }>(`/matches/${selected}/events`), apiJson<Summary>(`/matches/${selected}/summary`), apiJson<Dominance>(`/matches/${selected}/dominance?bin_seconds=60&split_halves=true`)]).then(([events, summary, dominance]) => { if (active)
            setData({ id: selected, events: events.events, summary, dominance }); }).catch(() => { if (active)
            setError('경기 기록을 불러오지 못했습니다. 다시 시도해 주세요.'); }).finally(() => { if (active)
            setLoading(false); });
        return () => { active = false; };
    }, [selected, revision]);
    const match = matches.find(m => m.id === selected);
    const cards = useMemo(() => match && data?.id === match.id ? graphics(match, data.events, data.summary, data.dominance, options) : [], [match, data, options]);
    async function save(card?: Graphic) {
        if (!match || loading || exporting || !cards.length)
            return;
        setExporting(true);
        setError('');
        try {
            if (card)
                download(await svgPng(card.svg), `${safeName(match.name)}-${safeName(card.key)}.png`);
            else {
                const files = [];
                for (const c of cards)
                    files.push({ name: `${safeName(c.key)}.png`, blob: await svgPng(c.svg) });
                download(await pngArchive(files), `${safeName(match.name)}-visualization.zip`);
            }
        }
        catch {
            setError('이미지 다운로드에 실패했습니다. 다시 시도해 주세요.');
        }
        finally {
            setExporting(false);
        }
    }
    return <div className="futsal-viz">
    <header className="futsal-viz-header"><div><small>FUTSAL · MATCH GRAPHICS</small><h1>Visualization</h1><p>경기 기록을 샷맵, 흐름, 공격방향 이미지로 다운로드하세요.</p></div><button className="btn btn-primary" disabled={loading || exporting || !cards.length} onClick={() => save()}>{exporting ? '이미지 만드는 중…' : '전체 PNG 다운로드 · ZIP'}</button></header>
    <section className="futsal-viz-toolbar" aria-label="시각화 설정">
      <label className="futsal-viz-match">경기<select value={selected} disabled={exporting || !matches.length} onChange={e => setSelected(e.target.value)}>{!matches.length && <option value="">경기 없음</option>}{matches.map(m => <option key={m.id} value={m.id}>{m.name}{m.archived ? ' · 종료' : ' · 진행 중'}</option>)}</select></label>
      <label>배경<select value={options.background} disabled={exporting} onChange={e => setOptions({ ...options, background: e.target.value as Options['background'] })}><option value="dark">다크</option><option value="light">화이트</option><option value="transparent">투명</option></select></label>
      <label>홈 색상<input aria-label="홈 색상" type="color" value={options.home} disabled={exporting} onChange={e => setOptions({ ...options, home: e.target.value })}/></label>
      <label>어웨이 색상<input aria-label="어웨이 색상" type="color" value={options.away} disabled={exporting} onChange={e => setOptions({ ...options, away: e.target.value })}/></label>
      <button className="btn" disabled={loading || exporting || !selected} onClick={() => setRevision(r => r + 1)}>기록 새로고침</button>
    </section>
    <p className="futsal-viz-note">PNG 1600 × 1000 · 매치 도미넌스 1분 단위 · 다운로드 시점에 불러온 기록 기준</p>
    {error && <p role="alert" className="futsal-viz-error">{error}</p>}
    {loading ? <p role="status">경기 기록을 불러오는 중…</p> : !matches.length ? <p>등록된 풋살 경기가 없습니다.</p> : <div className="futsal-viz-grid">{cards.map(card => <article key={card.key} className="futsal-viz-card"><div className="futsal-viz-card-heading"><h2>{card.title}</h2><button className="btn" disabled={exporting} onClick={() => save(card)}>PNG 다운로드</button></div><img alt={card.title} width={1600} height={1000} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(card.svg)}`}/></article>)}</div>}
  </div>;
}
