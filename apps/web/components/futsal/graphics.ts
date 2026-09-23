export type Team = 'HOME' | 'AWAY';
export type Shot = {
    id: string;
    type: string;
    team: Team;
    is_goal: boolean;
    shot_x: number | null;
    shot_y: number | null;
    xg: number | null;
    player_number?: string | null;
    player_name?: string | null;
};
export type Match = {
    id: string;
    name: string;
    archived: boolean;
    metadata?: {
        home_team?: string;
        away_team?: string;
        period_mode?: string;
    } | null;
};
export type Lanes = {
    left_count: number;
    center_count: number;
    right_count: number;
    total_count: number;
};
export type Summary = {
    possession: {
        home_pct: number;
        away_pct: number;
        home_ms: number;
        away_ms: number;
    };
    lanes: {
        home: Lanes;
        away: Lanes;
    };
};
export type Dominance = {
    bins: {
        period?: number;
        start_ms: number;
        end_ms: number;
        chart_start_ms?: number;
        chart_end_ms?: number;
        display_end_ms?: number;
        dominance: number;
        annotations?: {
            goal_summary?: {
                home: number;
                away: number;
            };
        };
    }[];
    breaks?: {
        chart_ms: number;
        label: string;
    }[];
};
export type Graphic = {
    key: string;
    title: string;
    svg: string;
};
export type Options = {
    home: string;
    away: string;
    background: 'dark' | 'light' | 'transparent';
};
export const escapeXml = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'futsal';
export function teamName(match: Match, team: Team) {
    const parts = match.name.replace(/^\[[^\]]*\]\s*/, '').split(/\s+vs\.?\s+/i);
    return (team === 'HOME' ? match.metadata?.home_team || parts[0] : match.metadata?.away_team || parts[1]) || team;
}
export function shotPosition(shot: Shot): {
    x: number;
    y: number;
} | null {
    if (shot.shot_x == null || shot.shot_y == null || !Number.isFinite(shot.shot_x) || !Number.isFinite(shot.shot_y) || shot.shot_x < 20 || shot.shot_x > 40 || shot.shot_y < 0 || shot.shot_y > 20)
        return null;
    return { x: shot.shot_y, y: 40 - shot.shot_x };
}
export function graphics(match: Match, events: Shot[], summary: Summary, dominance: Dominance, options: Options): Graphic[] {
    const ink = options.background === 'light' ? '#142031' : '#f5f7fc', muted = options.background === 'light' ? '#526175' : '#a6b3c9';
    const colors = { HOME: options.home, AWAY: options.away };
    const names = { HOME: teamName(match, 'HOME'), AWAY: teamName(match, 'AWAY') };
    const txt = (x: number, y: number, text: string | number, size = 24, fill = ink, anchor = 'start') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${escapeXml(String(text))}</text>`;
    const frame = (title: string, content: string, footer: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><g font-family="Arial, 'Noto Sans KR', sans-serif" font-weight="600">${options.background === 'transparent' ? '' : `<rect width="1600" height="1000" fill="${options.background === 'light' ? '#f5f7fa' : '#101723'}"/>`}${txt(64, 64, 'FINE PLAY  /  FUTSAL', 21, muted)}${txt(64, 126, title, 44)}${txt(64, 174, match.name, 26, muted)}<path d="M64 204H1536" stroke="${muted}" opacity=".25"/>${content}${txt(64, 956, footer, 20, muted)}</g></svg>`;
    const pitch = (x: number, y: number, scale: number, content: string) => `<g transform="translate(${x} ${y}) scale(${scale})"><rect width="20" height="20" rx=".15" fill="${options.background === 'light' ? '#e3ebe9' : '#1b3438'}"/><g fill="none" stroke="${muted}" stroke-width=".07"><rect width="20" height="20"/><path d="M8.5 0V-1.2H11.5V0M2.5 0A6 6 0 0 0 8.5 6H11.5A6 6 0 0 0 17.5 0M7 20A3 3 0 0 1 13 20"/><circle cx="10" cy="6" r=".09"/><circle cx="10" cy="10" r=".09"/></g>${content}</g>`;
    const shots = events.filter(e => e.type === 'XG');
    const shotCard = (team: Team, subset: Shot[], label: string, key: string): Graphic => {
        const positioned = subset.filter(s => shotPosition(s));
        const dots = positioned.map(s => { const p = shotPosition(s)!; const r = .19 + Math.sqrt(Math.max(0, Math.min(1, s.xg || 0))) * .65; return `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${colors[team]}" fill-opacity="${s.is_goal ? 1 : .5}" stroke="${s.is_goal ? ink : colors[team]}" stroke-width="${s.is_goal ? .11 : .05}"/>`; }).join('');
        return { key, title: label, svg: frame(label, pitch(480, 280, 28, dots) + txt(80, 330, names[team], 36, colors[team]) + txt(80, 410, `${subset.length} 기록`, 28) + txt(80, 460, `${subset.filter(s => s.is_goal).length} 골`, 28) + txt(80, 515, `Shot Threat ${subset.reduce((n, s) => n + (s.xg || 0), 0).toFixed(2)}`, 23) + txt(80, 600, '● 골  /  ○ 슈팅', 22, muted) + txt(80, 642, '원 크기: Shot Threat', 20, muted) + txt(760, 884, '상대 골문 ↑', 22, muted, 'middle'), `공격 하프 20 × 20m · 양 팀 모두 위쪽으로 공격 · 위치 없는 기록 ${subset.length - positioned.length}건은 코트에서 제외`) };
    };
    const result: Graphic[] = (['HOME', 'AWAY'] as Team[]).map(t => shotCard(t, shots.filter(s => s.team === t), `${names[t]} · 샷맵`, `${names[t]}-shotmap`));
    const bins = dominance.bins, start = (b: Dominance['bins'][number]) => b.chart_start_ms ?? b.start_ms, end = (b: Dominance['bins'][number]) => b.chart_end_ms ?? b.end_ms;
    const max = Math.max(60000, ...bins.map(end));
    const x = (ms: number) => 100 + ms / max * 1400;
    let chart = [-1, -.5, 0, .5, 1].map(v => `<path d="M100 ${545 - v * 235}H1500" stroke="${muted}" opacity="${v === 0 ? .6 : .15}"/>` + txt(80, 553 - v * 235, Math.abs(v).toFixed(1), 18, muted, 'end')).join('');
    bins.forEach((b, i) => {
        const value = Math.max(-1, Math.min(1, b.dominance || 0)), w = Math.max(1, x(end(b)) - x(start(b)) - 4), bx = x(start(b)) + 2;
        chart += `<rect x="${bx}" y="${value >= 0 ? 545 - value * 235 : 545}" width="${w}" height="${Math.max(1, Math.abs(value) * 235)}" rx="3" fill="${value >= 0 ? colors.HOME : colors.AWAY}" fill-opacity=".7"/>`;
        const g = b.annotations?.goal_summary;
        if (g?.home)
            chart += txt(bx + w / 2, 290, `●${g.home > 1 ? g.home : ''}`, 19, colors.HOME, 'middle');
        if (g?.away)
            chart += txt(bx + w / 2, 817, `●${g.away > 1 ? g.away : ''}`, 19, colors.AWAY, 'middle');
        const last = i === bins.length - 1;
        const finalCenter = bins.length ? (x(start(bins[bins.length - 1])) + x(end(bins[bins.length - 1]))) / 2 : 1500;
        const seconds = Math.floor((b.display_end_ms ?? b.end_ms) / 1000);
        const label = seconds % 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `${seconds / 60}′`;
        if (last || (i % Math.max(1, Math.ceil(bins.length / 18)) === 0 && finalCenter - (bx + w / 2) > 85))
            chart += txt(bx + w / 2, 855, label, 18, muted, 'middle');
    });
    chart += (dominance.breaks || []).map(b => `<path d="M${x(b.chart_ms)} 305V790" stroke="${muted}" stroke-dasharray="5 8"/>` + txt(x(b.chart_ms), 884, b.label, 18, muted, 'middle')).join('');
    result.push({ key: 'match-dominance', title: '매치 도미넌스', svg: frame('MATCH DOMINANCE', txt(100, 250, `↑ ${names.HOME}`, 27, colors.HOME) + txt(1500, 250, `${names.AWAY} ↓`, 27, colors.AWAY, 'end') + chart + (bins.length ? '' : txt(800, 530, '기록이 없습니다', 32, muted, 'middle')), '1분 단위 · 점유율, Shot Threat, 공격방향 기록 기반 · ● 득점이 기록된 구간') });
    let lanes = '';
    (['HOME', 'AWAY'] as Team[]).forEach((t, teamIndex) => {
        const l = summary.lanes[t === 'HOME' ? 'home' : 'away'];
        const counts = [l.left_count, l.center_count, l.right_count];
        const px = 160 + teamIndex * 780;
        lanes += txt(px + 250, 258, names[t], 30, colors[t], 'middle');
        lanes += pitch(px, 325, 25, counts.map((count, i) => { const pct = l.total_count ? count / l.total_count * 100 : 0; return `<rect x="${i * 20 / 3}" width="${20 / 3}" height="20" fill="${colors[t]}" fill-opacity="${l.total_count ? .12 + .65 * pct / 100 : 0}"/><path d="M${(i + .5) * 20 / 3} 13V6M${(i + .5) * 20 / 3 - 1} 7L${(i + .5) * 20 / 3} 6L${(i + .5) * 20 / 3 + 1} 7" stroke="${ink}" stroke-width=".12" fill="none"/>` + txt((i + .5) * 20 / 3, 15.5, `${pct.toFixed(1)}%`, .95, ink, 'middle') + txt((i + .5) * 20 / 3, 17, `${count}회`, .65, ink, 'middle'); }).join(''));
        lanes += txt(px + 250, 870, `왼쪽 / 중앙 / 오른쪽 · 총 ${l.total_count}회`, 22, muted, 'middle');
    });
    result.push({ key: 'attack-direction', title: '공격방향', svg: frame('ATTACK DIRECTION', lanes, '공격방향 입력 기록의 비율 · 양 팀 모두 상대 골문을 위로 정렬') });
    const p = summary.possession, total = p.home_ms + p.away_ms, hp = total ? p.home_ms / total * 100 : 0, ap = total ? 100 - hp : 0;
    result.push({ key: 'possession', title: '점유율', svg: frame('POSSESSION', txt(100, 370, names.HOME, 36, colors.HOME) + txt(1500, 370, names.AWAY, 36, colors.AWAY, 'end') + txt(100, 495, `${hp.toFixed(1)}%`, 90, colors.HOME) + txt(1500, 495, `${ap.toFixed(1)}%`, 90, colors.AWAY, 'end') + `<rect x="100" y="565" width="1400" height="80" rx="8" fill="${muted}" opacity=".2"/>${total ? `<rect x="100" y="565" width="${14 * hp}" height="80" fill="${colors.HOME}"/><rect x="${100 + 14 * hp}" y="565" width="${14 * ap}" height="80" fill="${colors.AWAY}"/>` : ''}` + txt(100, 715, `점유 ${Math.floor(p.home_ms / 60000)}분 ${Math.floor(p.home_ms / 1000) % 60}초`, 26, muted) + txt(1500, 715, `점유 ${Math.floor(p.away_ms / 60000)}분 ${Math.floor(p.away_ms / 1000) % 60}초`, 26, muted, 'end'), '실제 점유가 기록된 시간 기준 · 미기록 시간 제외') });
    return result;
}
export async function svgPng(source: string): Promise<Blob> {
    await document.fonts.ready;
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 1600;
        canvas.height = 1000;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('이미지를 만들 수 없습니다.');
        ctx.drawImage(image, 0, 0);
        return await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG 생성 실패')), 'image/png'));
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
export function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
