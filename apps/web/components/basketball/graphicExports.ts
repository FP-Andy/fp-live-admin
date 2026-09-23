import { ZONES } from './BasketballMatchControl';

type Team = 'HOME' | 'AWAY';
export type GraphicEvent = {
  id: string; type: 'SHOT' | 'REBOUND'; team: Team; playerNumber?: string;
  zoneId?: string; shotResult?: string; points?: number; period: number; clock: string;
  timestamp: number; marginAfter: number;
};
export type GraphicPlayer = { number: string; name: string };
export const GRAPHIC_SIZES = { player: [1017, 936], teams: [1721, 857], margin: [1921, 1139], rebound: [886, 815] } as const;
export function safeFilename(value: string) {
  return value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim() || '이름없음';
}
export function playersForExport(lineups: Partial<Record<Team, GraphicPlayer[]>>, events: GraphicEvent[]) {
  return (['HOME', 'AWAY'] as Team[]).flatMap(team => {
    const players = new Map<string, GraphicPlayer>();
    for (const [index, p] of (lineups[team] || []).entries()) {
      const number = String(p.number ?? '').trim();
      if (number || p.name?.trim()) players.set(number || `unnumbered-${index}`, { number, name: p.name?.trim() || '이름없음' });
    }
    for (const e of events) {
      const number = String(e.playerNumber ?? '').trim();
      if (e.team === team && number && !players.has(number)) players.set(number, { number, name: '이름없음' });
    }
    return [...players.values()].map(p => ({ ...p, team }));
  });
}
const svg = (width: number, height: number, content: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`;
function court(events: GraphicEvent[], team: Team) {
  return ZONES.map(zone => {
    const shots = events.filter(e => e.type === 'SHOT' && e.team === team && e.zoneId === zone.id);
    const points = shots.reduce((s, e) => s + (e.shotResult === 'MADE' ? Number(e.points || 0) : 0), 0);
    // Preserve the template's points thresholds; distinguish unattempted zones.
    const color = !shots.length ? '#e7e7ed' : points >= 5 ? '#20c35b' : points > 0 ? '#facc15' : '#ef4043';
    return `<path d="${zone.d}" fill="${color}" fill-opacity="0.5" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>`;
  }).join('');
}
export function shotGraphic(events: GraphicEvent[], team?: Team) {
  if (team) return svg(1017, 936, `<svg x="80" y="76" width="856" height="804" viewBox="0 0 722 678">${court(events, team)}</svg>`);
  return svg(1721, 857, `<svg x="20" y="68" width="784" height="736" viewBox="0 0 722 678">${court(events, 'HOME')}</svg><svg x="899" y="68" width="784" height="736" viewBox="0 0 722 678">${court(events, 'AWAY')}</svg>`);
}
export function marginGraphic(events: GraphicEvent[], periodMinutes: number, periodCount: number) {
  const scoring = events.filter(e => e.type === 'SHOT' && e.shotResult === 'MADE').map(e => {
    const [m, s] = e.clock.split(':').map(Number);
    return { ...e, elapsed: (Math.max(1, e.period) - 1) * periodMinutes * 60 + Math.max(0, periodMinutes * 60 - ((m || 0) * 60 + (s || 0))) };
  }).sort((a, b) => a.elapsed - b.elapsed || a.timestamp - b.timestamp);
  const total = Math.max(1, periodMinutes * 60 * periodCount);
  const max = Math.max(1, ...scoring.map(e => Math.abs(e.marginAfter)));
  const zero = 570, x = (v: number) => 170 + Math.min(1, v / total) * 1600, y = (v: number) => zero - v / max * 440;
  let last = zero;
  const line = [`170,${zero}`];
  for (const e of scoring) { line.push(`${x(e.elapsed)},${last}`, `${x(e.elapsed)},${y(e.marginAfter)}`); last = y(e.marginAfter); }
  line.push(`1770,${last}`);
  const points = line.join(' '), area = `${points} 1770,${zero} 170,${zero}`;
  return svg(1921, 1139, `<defs><clipPath id="pos"><rect width="1921" height="${zero}"/></clipPath><clipPath id="neg"><rect y="${zero}" width="1921" height="1139"/></clipPath></defs><polygon points="${area}" fill="#ff7400" fill-opacity="0.5" clip-path="url(#pos)"/><polygon points="${area}" fill="#2158e8" fill-opacity="0.5" clip-path="url(#neg)"/><polyline points="${points}" fill="none" stroke="white" stroke-width="8"/>${scoring.map(e => `<circle cx="${x(e.elapsed)}" cy="${y(e.marginAfter)}" r="14" fill="${e.team === 'HOME' ? '#ff7400' : '#2158e8'}" stroke="white" stroke-width="3"/>`).join('')}`);
}
export function reboundGraphic(data: { ar: number; dr: number; ra: number }) {
  const values = [data.ar, data.dr, data.ra], colors = ['#ff7400', '#2158e8', '#d94043'];
  const total = values.reduce((a, b) => a + b, 0), circumference = 2 * Math.PI * 300;
  let offset = 0;
  const segments = values.map((v, i) => {
    if (!v || !total) return '';
    const length = v / total * circumference;
    const angle = (offset + length / 2) / circumference * 2 * Math.PI - Math.PI / 2;
    const labelX = 443 + Math.cos(angle) * 340, labelY = 408 + Math.sin(angle) * 340;
    const result = `<circle cx="443" cy="408" r="300" fill="none" stroke="${colors[i]}" stroke-width="126" stroke-dasharray="${Math.max(0, length - (v === total ? 0 : 4))} ${circumference - Math.max(0, length - (v === total ? 0 : 4))}" stroke-dashoffset="${-offset}" transform="rotate(-90 443 408)"/><text x="${labelX}" y="${labelY - 8}" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-weight="900" font-size="72">${v}</text><text x="${labelX}" y="${labelY + 42}" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-weight="900" font-size="40">${(v / total * 100).toFixed(1)}%</text>`;
    offset += length; return result;
  });
  // Draw all labels over all segments so later arcs cannot cover the text.
  const arcs = segments.map(s => s.split('<text')[0]).join('');
  const labels = segments.map(s => s.includes('<text') ? '<text' + s.split('<text').slice(1).join('<text') : '').join('');
  return svg(886, 815, `${total ? '' : '<circle cx="443" cy="408" r="300" fill="none" stroke="#e7e7ed" stroke-width="126"/>'}${arcs}${labels}<text x="443" y="435" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-weight="900" font-size="92">${total}</text>`);
}
export async function svgPng(source: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); if (!context) throw new Error('이미지 생성에 실패했습니다.');
    context.drawImage(image, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG 생성 실패')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
