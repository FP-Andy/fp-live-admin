// FPA Live Logger "기록된 로그" 그 자리 수정 — 행 ↔ 입력값 변환만 한다.
//
// 액션 이름·태그·xG/EPV/PC 를 정하는 규칙은 여기 없다. 고친 값은 라이브 입력과 똑같이
// 코드(stat_input) + 좌표로 다시 묶어 서버 /fpa/logs/generate 에 보내고, 서버가 만든
// 행으로 바꾼다. 그래서 새로 찍은 로그와 고친 로그가 같은 규칙을 탄다.

export type FpaEditPoint = { x: number; y: number };

export type FpaLogEditDraft = {
  half: string;
  time: string;
  team: 'home' | 'away';
  direction: 'left' | 'right';
  player: string;
  action: string; // 액션 코드(ss·dd·r …). 비우면 번호만 = 터치
  receiver: string;
  tags: string; // 태그 코드(h.up …). 서버가 붙이는 Success·Progressive 같은 태그는 넣지 않는다
  pos: FpaEditPoint | null;
  recv: FpaEditPoint | null;
  // 드리블 경로의 가운데 점들(처음·끝은 pos·recv). 경로가 없으면 빈 배열
  via: FpaEditPoint[];
};

type RowLike = {
  Time?: string;
  Team?: string;
  Half?: string;
  Direction?: string;
  Coord?: string;
  StatInput?: string;
  PathPoints?: string;
};

const POS_RE = /Pos\(([-+\d.eE]+),\s*([-+\d.eE]+)\)/g;

function point(x: string | number, y: string | number): FpaEditPoint | null {
  const px = Number(x);
  const py = Number(y);
  return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : null;
}

export function parseStatCode(code: string | undefined | null) {
  const text = (code || '').trim().toLowerCase();
  if (!text) return null;
  const [base, ...tagParts] = text.split('.');
  const tags = tagParts.filter(Boolean).join('.');
  if (/^\d+$/.test(base)) return { player: base, action: '', receiver: '', tags };
  const match = base.match(/^(\d*)([a-z]+)(\d*)$/);
  if (!match) return null;
  return { player: match[1], action: match[2], receiver: match[3], tags };
}

export function composeStatCode(draft: Pick<FpaLogEditDraft, 'player' | 'action' | 'receiver' | 'tags'>) {
  const clean = (value: string) => value.trim().toLowerCase();
  const tags = clean(draft.tags).split(/[\s.,]+/).filter(Boolean);
  const action = clean(draft.action);
  const base = `${clean(draft.player)}${action}${action ? clean(draft.receiver) : ''}`;
  return base + tags.map((tag) => `.${tag}`).join('');
}

// 로그 글에 찍힌 좌표. 첫 Pos = 위치, 둘째 이후 마지막 Pos = 받은 위치. 드리블은 PathPoints 가 전체 경로다.
export function positionsFromLog(row: RowLike, logText: string | undefined) {
  const found = Array.from((logText || '').matchAll(POS_RE)).map((m) => point(m[1], m[2])).filter(Boolean) as FpaEditPoint[];
  const coord = Array.from((row.Coord || '').matchAll(POS_RE)).map((m) => point(m[1], m[2])).filter(Boolean) as FpaEditPoint[];
  const path = (row.PathPoints || '')
    .split(';')
    .map((raw) => raw.split(','))
    .map((parts) => (parts.length === 2 ? point(parts[0], parts[1]) : null))
    .filter(Boolean) as FpaEditPoint[];
  const pos = path[0] || coord[0] || found[0] || null;
  const recv = path.length >= 2 ? path[path.length - 1] : found.length >= 2 ? found[found.length - 1] : null;
  return { pos, recv, via: path.length > 2 ? path.slice(1, -1) : [] };
}

export function draftFromRow(row: RowLike, logText: string | undefined, statInput: string): FpaLogEditDraft | null {
  const code = parseStatCode(statInput);
  if (!code) return null;
  const parts = (logText || '').split(' | ');
  const team = (row.Team || parts[1]) === 'away' ? 'away' : 'home';
  const direction = (row.Direction || parts[2]) === 'left' ? 'left' : 'right';
  return {
    half: row.Half || (parts.length > 3 ? parts[0] : '') || '1H',
    time: row.Time || (parts.length > 3 ? parts[3] : '') || '00:00',
    team,
    direction,
    ...code,
    ...positionsFromLog(row, logText),
  };
}

export function draftDots(draft: FpaLogEditDraft) {
  if (!draft.pos) return [];
  return [draft.pos, ...draft.via, ...(draft.recv ? [draft.recv] : [])];
}

export function sameDraftShot(a: FpaLogEditDraft, b: FpaLogEditDraft) {
  const dots = (d: FpaLogEditDraft) => JSON.stringify(draftDots(d));
  return composeStatCode(a) === composeStatCode(b) && dots(a) === dots(b) && a.team === b.team && a.direction === b.direction;
}

export function roundMeter(value: number) {
  return Number(value.toFixed(2));
}

export function formatPoint(p: FpaEditPoint | null) {
  return p ? `${p.x}, ${p.y}` : '';
}
