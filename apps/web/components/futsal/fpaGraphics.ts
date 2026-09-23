import { escapeXml, type Match, type Options } from './graphics';
export type SavedFpa = {
    logs: string[];
    rows: Record<string, string>[];
    updated_at?: string | null;
};
export type Point = {
    x: number;
    y: number;
};
export type FpaEvent = {
    index: number;
    team: string;
    player: string;
    receiver: string;
    action: string;
    tags: string[];
    time: string;
    half: string;
    direction: string;
    points: Point[];
    goal: boolean;
    outcome: 'success' | 'fail' | 'unknown';
};
export type MapMode = 'pass' | 'kickin' | 'defense' | 'event' | 'shot' | 'sequence';
export const mapNames: Record<MapMode, string> = { pass: '패스맵', kickin: '킥인 맵', defense: '수비맵', event: '이벤트맵', shot: '샷맵', sequence: '시퀀스맵' };
const labels: Record<string, string> = { Pass: '패스', 'Kick-in': '킥인', Cross: '크로스', Shot: '슈팅', Goal: '골', 'Shot On Target': '유효슈팅', 'Blocked Shot': '블록된 슈팅', Dribble: '드리블', Breakthrough: '돌파', Intercept: '인터셉트', Acquisition: '볼 획득', Block: '블록', Save: '선방', Tackle: '태클', Cutout: '차단', Duel: '경합', Foul: '파울', Clear: '클리어', Press: '압박', Catching: '캐칭', Punching: '펀칭', Gain: '볼 획득(이전 기록)' };
export const actionName = (action: string) => labels[action] || action;
const number = (value: unknown) => typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
function point(x: unknown, y: unknown): Point | null { const a = number(x), b = number(y); return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && a <= 40 && b >= 0 && b <= 20 ? { x: a, y: b } : null; }
function positions(text: string) { return [...text.matchAll(/Pos\(\s*([^,()]+),\s*([^()]+)\)/g)].map(m => point(m[1], m[2])); }
export function parseFpa(saved: SavedFpa): FpaEvent[] {
    return Array.from({ length: Math.max(saved.logs?.length || 0, saved.rows?.length || 0) }, (_, index) => {
        const row = saved.rows?.[index] || {}, log = saved.logs?.[index] || '', parts = log.split(/\s*\|\s*/);
        const action = parts[5]?.match(/^(\S+)\s+(.+?)(?:\s+to\s+(\S+))?$/);
        const team = (row.Team || parts[1] || 'unknown').toLowerCase();
        const tags = (row.Tags || parts.find(p => p.startsWith('Tags:'))?.slice(5) || '').split(',').map(t => t.trim()).filter(Boolean);
        const starts = positions(row.Coord || parts[4] || '');
        const start = starts[0] || (row.StartX !== undefined ? point(row.StartX, row.StartY) : null);
        const end = row.EndX?.trim() ? point(row.EndX, row.EndY) : positions(parts[6] || '')[0];
        const pathText = row.PathPoints || parts.find(p => p.startsWith('Path('))?.slice(5, -1) || '';
        const path = pathText ? pathText.split(';').map(p => { const [x, y] = p.split(','); return point(x, y); }) : [];
        // Invalid intermediate positions must not be bridged into invented routes.
        const points = path.length > 1 && path.every(p => p !== null) ? path as Point[] : start ? [start, ...(!path.length && end ? [end] : [])] : [];
        const eventAction = row.Action || action?.[2] || '기타';
        return { index, team, player: row.Player || action?.[1] || '', receiver: row.Receiver || action?.[3] || '', action: eventAction, tags, time: row.Time || parts[3] || '', half: row.Half || parts[0] || '', direction: row.Direction || parts[2] || '', points, goal: tags.includes('Goal') || eventAction === 'Goal', outcome: tags.includes('Fail') ? 'fail' : tags.includes('Success') ? 'success' : 'unknown' };
    });
}
export const isPass = (e: FpaEvent) => /^(pass|cross|throw-in)$/i.test(e.action);
export const isShot = (e: FpaEvent) => /^(shot|shot on target|blocked shot|goal)$/i.test(e.action);
export const defenseActions = ['Tackle','Intercept','Cutout','Clear','Block','Press','Acquisition','Gain','Duel','Save','Catching','Punching','Foul'];
export const isKickIn = (e: FpaEvent) => /^kick-in$/i.test(e.action);
export const isDefense = (e: FpaEvent) => defenseActions.some(a => a.toLowerCase() === e.action.toLowerCase());
export type MapFilters = { outcome: 'all'|'success'|'fail'|'unknown'; distance: 'all'|'short'|'medium'|'long'|'unknown'; shortMax: number; longMin: number; actions: string[]; tags: string[] };
export const defaultMapFilters: MapFilters = {outcome:'all',distance:'all',shortMax:20,longMin:40,actions:[],tags:[]};
export function passDistance(e: FpaEvent): number | null {
    if (e.points.length < 2) return null;
    const first=e.points[0], last=e.points[e.points.length-1];
    return Math.hypot(last.x-first.x,last.y-first.y);
}
export function distanceBand(e: FpaEvent, shortMax: number, longMin: number): MapFilters['distance'] {
    const distance=passDistance(e);
    return distance === null ? 'unknown' : distance < shortMax ? 'short' : distance < longMin ? 'medium' : 'long';
}
export function filteredMapEvents(events: FpaEvent[], mode: MapMode, selected: Set<number>, filters: MapFilters) {
    return mapEvents(events,mode,selected).filter(e =>
        (filters.outcome === 'all' || e.outcome === filters.outcome) &&
        (!['pass','kickin'].includes(mode) || filters.distance === 'all' || distanceBand(e,filters.shortMax,filters.longMin) === filters.distance) &&
        (mode !== 'defense' || ((!filters.actions.length || filters.actions.includes(e.action)) && (!filters.tags.length || filters.tags.some(tag => e.tags.includes(tag))))));
}
export const tagName = (tag:string) => ({Catch:'잡음',Punch:'쳐냄',Aerial:'공중볼',Foot:'발',Header:'헤더','Possession Retained':'소유권 유지','Possession Lost':'소유권 상실',Retained:'유지',Lost:'상실','In-box':'박스 안','Out-box':'박스 밖'} as Record<string,string>)[tag] || tag;
export function filterLabel(mode:MapMode,filters:MapFilters) {
    const labels=[{all:'전체 결과',success:'성공',fail:'실패',unknown:'결과 미기록'}[filters.outcome]];
    if(mode==='pass'||mode==='kickin') labels.push({all:'전체 거리',short:`단거리 <${filters.shortMax}m`,medium:`중거리 ${filters.shortMax}–${filters.longMin}m 미만`,long:`장거리 ≥${filters.longMin}m`,unknown:'거리 미기록'}[filters.distance]);
    if(mode==='defense') {labels.push(filters.actions.length?filters.actions.map(actionName).join('/'):'전체 수비');if(filters.tags.length)labels.push(filters.tags.map(tagName).join('/'));}
    return labels.join(' · ');
}
export function filterEvents(events: FpaEvent[], start: number, end: number, team: string, player: string) {
    return events.filter(e => e.index >= start && e.index <= end && (team === 'all' || e.team === team) && (player === 'all' || `${e.team}:${e.player}` === player));
}
export function mapEvents(events: FpaEvent[], mode: MapMode, selected: Set<number>) {
    return events.filter(e => mode === 'pass' ? isPass(e) : mode === 'kickin' ? isKickIn(e) : mode === 'defense' ? isDefense(e) : mode === 'shot' ? isShot(e) : mode === 'sequence' ? selected.has(e.index) : true);
}
export function displayPoint(p: Point, direction: string, normalize: boolean): Point {
    const q = normalize && direction === 'left' ? { x: 40 - p.x, y: 20 - p.y } : p;
    return { x: 160 + q.x * 32, y: 250 + (20 - q.y) * 32 };
}
// Stable identities across filtered maps and exports; Gain is the legacy Acquisition name.
const defenseStyles: Record<string, { color: string; light: string; shape: string }> = {
    Tackle: { color: '#59a7ff', light: '#155bc0', shape: 'diamond' },
    Intercept: { color: '#3ed6cf', light: '#007b78', shape: 'triangle' },
    Cutout: { color: '#c69bff', light: '#7841b5', shape: 'square' },
    Clear: { color: '#ffb75b', light: '#9b5700', shape: 'up' },
    Block: { color: '#ff7da5', light: '#b3295c', shape: 'hexagon' },
    Press: { color: '#d0df63', light: '#637400', shape: 'plus' },
    Acquisition: { color: '#58df9a', light: '#097b43', shape: 'circle' },
    Duel: { color: '#c6ad8e', light: '#80603b', shape: 'bowtie' },
    Save: { color: '#ffd35b', light: '#987000', shape: 'star' },
    Catching: { color: '#86c6ff', light: '#276c9e', shape: 'ring' },
    Punching: { color: '#ff9b6b', light: '#b34c1b', shape: 'pentagon' },
    Foul: { color: '#ff6666', light: '#c32828', shape: 'cross' },
};
export function defenseStyle(action: string, light = false) {
    const key = action.toLowerCase() === 'gain' ? 'Acquisition' : Object.keys(defenseStyles).find(k => k.toLowerCase() === action.toLowerCase());
    const style = key ? defenseStyles[key] : null;
    return style ? { color: light ? style.light : style.color, shape: style.shape } : null;
}
function defenseMarker(action: string, x: number, y: number, size: number, ink: string, light: boolean) {
    const style = defenseStyle(action, light);
    if (!style) return '';
    const shapes: Record<string, string> = {
        diamond: '<path d="M0 -1L1 0L0 1L-1 0Z"/>',
        triangle: '<path d="M0 -1L1 .85L-1 .85Z"/>',
        square: '<rect x="-.85" y="-.85" width="1.7" height="1.7"/>',
        up: '<path d="M-1 -.85L1 -.85L0 1Z"/>',
        hexagon: '<path d="M-.5 -1L.5 -1L1 0L.5 1L-.5 1L-1 0Z"/>',
        plus: '<path d="M-.3 -1H.3V-.3H1V.3H.3V1H-.3V.3H-1V-.3H-.3Z"/>',
        circle: '<circle r=".9"/>',
        bowtie: '<path d="M-1 -1L1 1V-1L-1 1Z"/>',
        star: '<path d="M0 -1L.3 -.32L1 -.3L.48 .2L.62 .95L0 .55L-.62 .95L-.48 .2L-1 -.3L-.3 -.32Z"/>',
        ring: '<path fill-rule="evenodd" d="M1 0A1 1 0 1 0 -1 0A1 1 0 1 0 1 0M.45 0A.45 .45 0 1 1 -.45 0A.45 .45 0 1 1 .45 0"/>',
        pentagon: '<path d="M0 -1L.95 -.31L.59 .81L-.59 .81L-.95 -.31Z"/>',
        cross: '<path d="M-.7 -1L0 -.3L.7 -1L1 -.7L.3 0L1 .7L.7 1L0 .3L-.7 1L-1 .7L-.3 0L-1 -.7Z"/>',
    };
    return `<g data-defense="${escapeXml(action)}" data-shape="${style.shape}" transform="translate(${x} ${y}) scale(${size})" fill="${style.color}" stroke="${ink}" stroke-width=".12" stroke-linejoin="round">${shapes[style.shape]}</g>`;
}
function eventColor(e: FpaEvent) { if (isShot(e))
    return '#ff7400'; if (isPass(e) || isKickIn(e))
    return '#3c8cff'; if (/dribble|breakthrough/i.test(e.action))
    return '#20bd92'; if (isDefense(e))
    return '#b58bff'; return '#a5acb8'; }
export function fpaGraphic(match: Match, events: FpaEvent[], mode: MapMode, options: Options, normalize: boolean, scope: string) {
    const ink = options.background === 'light' ? '#172536' : '#f5f7fc', muted = options.background === 'light' ? '#546476' : '#a6b3c9';
    const text = (x: number, y: number, value: string, size = 24, color = ink, anchor = 'start') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
    let defs = '', marks = '';
    events.forEach((e, i) => {
        if (!e.points.length)
            return;
        const pts = e.points.map(p => displayPoint(p, e.direction, normalize));
        const color = (mode === 'pass' || mode === 'kickin') ? (e.outcome === 'fail' ? '#ee6161' : e.outcome === 'success' ? '#3c8cff' : '#a5acb8') : mode === 'shot' ? (e.goal ? '#ff7400' : e.tags.includes('On Target') ? '#20bd92' : '#a5acb8') : defenseStyle(e.action, options.background === 'light')?.color || eventColor(e);
        const id = `fpa-${e.index}`, start = pts[0];
        defs += `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="3.5" markerHeight="3.5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="${color}"/></marker>`;
        if (pts.length > 1 && mode !== 'shot')
            marks += `<path data-event="${e.index + 1}" d="${pts.map((p, j) => `${j ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${mode === 'sequence' ? 4 : 2.8}" stroke-opacity="${mode === 'sequence' ? 1 : .7}" ${e.outcome === 'fail' ? 'stroke-dasharray="8 6"' : ''} marker-end="url(#${id})"/>`;
        const radius = mode === 'shot' ? (e.goal ? 12 : 8) : 5;
        marks += isDefense(e) ? defenseMarker(e.action, start.x, start.y, 10, ink, options.background === 'light') : `<circle cx="${start.x}" cy="${start.y}" r="${radius}" fill="${color}" fill-opacity="${e.goal ? 1 : .85}" stroke="${ink}" stroke-width="${e.goal ? 2 : 1}"/>`;
        if (mode === 'sequence') {
            const ly = start.y + (i % 2 ? -20 : 25), lx = Math.min(1430, Math.max(170, start.x + 16));
            marks += `<rect x="${lx - 3}" y="${ly - 19}" width="${String(e.index + 1).length * 12 + 16}" height="26" rx="6" fill="${options.background === 'light' ? '#ffffff' : '#101723'}" stroke="${color}"/>` + text(lx + 4, ly, `${e.index + 1}`, 19, color);
        }
    });
    const legends = (mode === 'pass' || mode === 'kickin') ? '파랑: 성공 · 빨강 점선: 실패 · 회색: 결과 미기록' : mode === 'shot' ? '주황: 골 · 초록: 유효슈팅 · 회색: 기타 슈팅' : mode === 'defense' ? '수비 종류별 색·모양: 하단 범례 · 이동 경로의 점선: 실패' : mode === 'sequence' ? '번호: 원본 이벤트 순서 · 각 이벤트의 실제 경로만 표시' : '파랑: 패스 · 주황: 슈팅 · 초록: 운반 · 수비: 하단 범례 · 회색: 기타';
    const lines = `<g fill="none" stroke="${muted}" stroke-width="2" opacity=".65"><rect x="160" y="250" width="1280" height="640"/><path d="M800 250V890M160 522H128V618H160M1440 522H1472V618H1440M160 330A192 192 0 0 1 352 522V618A192 192 0 0 1 160 810M1440 330A192 192 0 0 0 1248 522V618A192 192 0 0 0 1440 810"/><circle cx="800" cy="570" r="96"/><circle cx="352" cy="570" r="3"/><circle cx="1248" cy="570" r="3"/><circle cx="800" cy="570" r="3"/></g>`;
    const shownDefense = defenseActions.filter(action => events.some(e => e.action.toLowerCase() === action.toLowerCase()));
    const defenseLegend = shownDefense.map((action, index) => {
        const x = 76 + (index % 7) * 212, y = 918 + Math.floor(index / 7) * 29;
        return defenseMarker(action, x, y, 9, ink, options.background === 'light') + text(x + 20, y + 6, actionName(action), 18, muted);
    }).join('');
    const missing = events.filter(e => !e.points.length).length;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><defs>${defs}</defs><g font-family="Arial, 'Noto Sans KR', sans-serif" font-weight="600">${options.background === 'transparent' ? '' : `<rect width="1600" height="1000" fill="${options.background === 'light' ? '#f5f7fa' : '#101723'}"/>`}${text(64, 58, 'FINE PLAY / FUTSAL FPA', 21, muted)}${text(64, 117, mapNames[mode], 40)}${text(64, 160, match.name, 25, muted)}${text(64, 196, scope.split('\n')[0], 21) + text(64, 222, scope.split('\n')[1] || '', 17, muted)}${text(64, 244, legends, 16, muted)}<rect x="160" y="250" width="1280" height="640" fill="${options.background === 'light' ? '#e3ebe9' : '#173239'}"/>${lines}${marks}${events.length ? '' : text(800, 580, mode === 'sequence' ? '아래 목록에서 이벤트를 선택하세요' : '이 범위에 해당하는 기록이 없습니다', 30, muted, 'middle')}${defenseLegend}${text(64, shownDefense.length ? 983 : 947, `${events.length}개 이벤트 · 좌표 없는 기록 ${missing}개 제외 · ${normalize ? '공격방향 오른쪽으로 정렬' : '기록된 실제 좌표'} · 40 × 20m`, 21, muted)}</g></svg>`;
}
