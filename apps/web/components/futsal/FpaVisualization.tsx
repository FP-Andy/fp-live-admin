'use client';
import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../lib/api';
import { pngArchive } from '../../lib/pngArchive';
import { download, safeName, svgPng, teamName, type Match, type Options } from './graphics';
import { actionName, filterEvents, fpaGraphic, mapEvents, mapNames, parseFpa, type MapMode, type SavedFpa } from './fpaGraphics';
export default function FpaVisualization({ match, options, revision }: {
    match: Match;
    options: Options;
    revision: number;
}) {
    const [saved, setSaved] = useState<SavedFpa | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
    const [mode, setMode] = useState<MapMode>('pass'), [team, setTeam] = useState('all'), [player, setPlayer] = useState('all'), [normalize, setNormalize] = useState(false);
    const [range, setRange] = useState<[
        number,
        number
    ]>([0, 0]), [selected, setSelected] = useState<Set<number>>(new Set());
    const [search, setSearch] = useState('');
    useEffect(() => {
        let active = true;
        setLoading(true);
        setError('');
        setSaved(null);
        setSelected(new Set());
        apiJson<SavedFpa>(`/fpa/matches/${match.id}/logs`).then(value => { if (!active)
            return; setSaved(value); setRange([0, Math.max(0, Math.max(value.logs.length, value.rows.length) - 1)]); setTeam('all'); setPlayer('all'); }).catch(() => { if (active)
            setError('FPA 기록을 불러오지 못했습니다. 상단 기록 새로고침으로 다시 시도해 주세요.'); }).finally(() => { if (active)
            setLoading(false); });
        return () => { active = false; };
    }, [match.id, revision]);
    const events = useMemo(() => saved ? parseFpa(saved) : [], [saved]);
    const teamLabel = (value: string) => value === 'home' ? teamName(match, 'HOME') : value === 'away' ? teamName(match, 'AWAY') : '팀 미기록';
    const players = useMemo(() => Array.from(new Set(events.filter(e => team === 'all' || e.team === team).map(e => `${e.team}:${e.player}`))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [events, team]);
    const filtered = useMemo(() => filterEvents(events, range[0], range[1], team, player), [events, range, team, player]);
    const visible = useMemo(() => mapEvents(filtered, mode, selected), [filtered, mode, selected]);
    const searchable = filtered.filter(e => `${e.index + 1} ${actionName(e.action)} ${e.player} ${e.receiver} ${e.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
    const scope = `${team === 'all' ? '전체 팀' : teamLabel(team)} · ${player === 'all' ? '전체 선수' : `#${player.split(':')[1] || '미기록'} (행위 선수)`} · 이벤트 ${range[0] + 1}–${range[1] + 1}`;
    const svg = useMemo(() => fpaGraphic(match, visible, mode, options, normalize, scope), [match, visible, mode, options, normalize, scope]);
    const noTimeline = events.length > 1 && new Set(events.map(e => `${e.half} ${e.time}`)).size === 1;
    function toggle(index: number) { setSelected(previous => { const next = new Set(previous); if (next.has(index))
        next.delete(index);
    else
        next.add(index); return next; }); }
    async function save(all = false) {
        if (busy || loading || !events.length)
            return;
        setBusy(true);
        setError('');
        try {
            const prefix = `${safeName(match.name)}-FPA-${safeName(scope)}`;
            if (!all)
                download(await svgPng(svg), `${prefix}-${mode}.png`);
            else {
                const files = [];
                for (const key of Object.keys(mapNames) as MapMode[]) {
                    if (key === 'sequence' && !filtered.some(e => selected.has(e.index)))
                        continue;
                    files.push({ name: `${key}.png`, blob: await svgPng(fpaGraphic(match, mapEvents(filtered, key, selected), key, options, normalize, scope)) });
                }
                download(await pngArchive(files), `${prefix}.zip`);
            }
        }
        catch {
            setError('FPA 이미지 다운로드에 실패했습니다. 다시 시도해 주세요.');
        }
        finally {
            setBusy(false);
        }
    }
    if (loading)
        return <p role="status">FPA 기록을 불러오는 중…</p>;
    if (!saved)
        return <p role="alert">{error}</p>;
    if (!events.length)
        return <section className="fpa-viz-empty"><h2>저장된 FPA 기록이 없습니다</h2><p>이 경기에서 FPA 기록을 저장한 뒤 ‘기록 새로고침’을 눌러 주세요.</p></section>;
    return <section className="fpa-viz" aria-label="FPA 시각화">
        <header className="futsal-viz-card-heading"><div><h2>FPA 이벤트 분석</h2><p>{events.length}개 이벤트 · {players.length}명{saved.updated_at ? ` · 저장 ${new Date(saved.updated_at).toLocaleString('ko-KR')}` : ''}</p></div><button className="btn" disabled={busy} onClick={() => save(true)}>{busy ? '이미지 만드는 중…' : 'FPA 맵 ZIP 다운로드'}</button></header>
        {error && <p role="alert">{error}</p>}
        {noTimeline && <p className="fpa-viz-notice">저장된 이벤트 시간이 모두 {events[0].time || '미기록'}입니다. 구간과 시퀀스는 원본 이벤트 순서를 기준으로 표시합니다.</p>}
        <div className="fpa-viz-controls">
            <label>팀<select value={team} disabled={busy} onChange={e => { setTeam(e.target.value); setPlayer('all'); }}><option value="all">전체 팀</option>{Array.from(new Set(events.map(e => e.team))).map(t => <option key={t} value={t}>{teamLabel(t)}</option>)}</select></label>
            <label>선수 범위<select value={player} disabled={busy} onChange={e => setPlayer(e.target.value)}><option value="all">전체 선수</option>{players.map(key => <option key={key} value={key}>{teamLabel(key.split(':')[0])} · #{key.split(':')[1] || '미기록'}</option>)}</select></label>
            <label>좌표 기준<select value={normalize ? 'normalized' : 'recorded'} disabled={busy} onChange={e => setNormalize(e.target.value === 'normalized')}><option value="recorded">실제 기록 위치</option><option value="normalized">공격방향 오른쪽 →</option></select></label>
            <button className="btn" disabled={busy} onClick={() => { setRange([0, events.length - 1]); setTeam('all'); setPlayer('all'); }}>전체 범위</button>
        </div>
        <div className="fpa-viz-range" aria-label="이벤트 구간 조절">
            <strong>이벤트 {range[0] + 1}–{range[1] + 1} <span>· 현재 범위 {filtered.length}개</span></strong>
            <label>시작<input aria-label="시작 이벤트" type="range" min={1} max={events.length} value={range[0] + 1} disabled={busy} onChange={e => setRange(([_, end]) => [Math.min(Number(e.target.value) - 1, end), end])}/><input aria-label="시작 이벤트 번호" type="number" min={1} max={range[1] + 1} value={range[0] + 1} disabled={busy} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n))
        setRange(([_, end]) => [Math.max(0, Math.min(n - 1, end)), end]); }}/><small>{events[range[0]]?.half} {events[range[0]]?.time}</small></label>
            <label>종료<input aria-label="종료 이벤트" type="range" min={1} max={events.length} value={range[1] + 1} disabled={busy} onChange={e => setRange(([start]) => [start, Math.max(start, Number(e.target.value) - 1)])}/><input aria-label="종료 이벤트 번호" type="number" min={range[0] + 1} max={events.length} value={range[1] + 1} disabled={busy} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n))
        setRange(([start]) => [start, Math.min(events.length - 1, Math.max(start, n - 1))]); }}/><small>{events[range[1]]?.half} {events[range[1]]?.time}</small></label>
        </div>
        <div className="fpa-viz-tabs" role="tablist" aria-label="FPA 맵 종류">{(Object.keys(mapNames) as MapMode[]).map(key => <button key={key} className={`btn ${mode === key ? 'btn-active' : ''}`} role="tab" aria-selected={mode === key} disabled={busy} onClick={() => setMode(key)}>{mapNames[key]}</button>)}</div>
        <article className="futsal-viz-card"><div className="futsal-viz-card-heading"><h3>{mapNames[mode]} · {visible.length}개 이벤트</h3><button className="btn btn-primary" disabled={busy || !visible.length} onClick={() => save()}>현재 맵 PNG 다운로드</button></div><img width={1600} height={1000} alt={`FPA ${mapNames[mode]}`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}/></article>
        <section className="fpa-viz-selection" aria-label="시퀀스 이벤트 선택">
            <div className="futsal-viz-card-heading"><div><h3>시퀀스 이벤트 선택</h3><p>선택 {selected.size}개 · 현재 필터에 포함 {filtered.filter(e => selected.has(e.index)).length}개. 선택 후 시퀀스맵에서 기록 순서대로 확인하세요.</p></div><button className="btn" onClick={() => setMode('sequence')}>시퀀스맵 보기</button></div>
            <div className="fpa-viz-selection-tools"><input aria-label="이벤트 검색" placeholder="이벤트 번호, 선수 번호, 액션 검색" value={search} onChange={e => setSearch(e.target.value)}/><button className="btn" disabled={busy || !searchable.length} onClick={() => setSelected(previous => new Set([...previous, ...searchable.map(e => e.index)]))}>현재 목록 모두 선택</button><button className="btn" disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>선택 해제</button></div>
            <div className="fpa-viz-table"><table><thead><tr><th>선택</th><th>순서</th><th>시간</th><th>팀 · 선수</th><th>이벤트</th><th>결과</th></tr></thead><tbody>{searchable.map(e => <tr key={e.index} data-selected={selected.has(e.index)}><td><input type="checkbox" aria-label={`이벤트 ${e.index + 1} 선택`} checked={selected.has(e.index)} disabled={busy} onChange={() => toggle(e.index)}/></td><td>{e.index + 1}</td><td>{e.half} {e.time}</td><td>{teamLabel(e.team)} · #{e.player || '미기록'}{e.receiver ? ` → #${e.receiver}` : ''}</td><td>{actionName(e.action)}{!e.points.length ? ' · 좌표 없음' : ''}</td><td>{e.goal ? '골' : e.outcome === 'success' ? '성공' : e.outcome === 'fail' ? '실패' : '미기록'}</td></tr>)}</tbody></table>{!searchable.length && <p>현재 필터에 해당하는 이벤트가 없습니다.</p>}</div>
            <p className="futsal-viz-note">선수 필터는 행위 선수를 기준으로 적용합니다. 필터 밖의 선택은 유지되지만 현재 맵과 다운로드에서는 제외됩니다. 이벤트 사이의 미기록 이동은 연결하지 않습니다.</p>
        </section>
    </section>;
}
