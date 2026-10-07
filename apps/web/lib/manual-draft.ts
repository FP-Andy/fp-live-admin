import type { Scoreboard, Watermark } from '../components/HighlightOverlay';

export type TagKind = 'home_goal' | 'home' | 'away' | 'away_goal' | 'substitution'
  // 장면은 넣지 않고 점수판만 올리는 골. 신청팀 하이라이트에서 상대 골이 이것이다.
  | 'home_goal_only' | 'away_goal_only'
  // 농구 — 한 번에 1·2·3점이 오른다. 축구의 '골' 은 늘 1점이라 구분이 없었다.
  | 'bb_home_1' | 'bb_home_2' | 'bb_home_3'
  | 'bb_away_1' | 'bb_away_2' | 'bb_away_3'
  // 클립 없이 점수판만 올린다. 경기 내내 점수를 따라가되 하이라이트로는 안 쓰는 득점.
  | 'bb_home_1_only' | 'bb_home_2_only' | 'bb_home_3_only'
  | 'bb_away_1_only' | 'bb_away_2_only' | 'bb_away_3_only'
  // 구간 경계. 클립을 만들지 않고, 합본에서 그 자리에 전체화면 카드를 세운다.
  | 'section';

// before/after 는 이 태그만의 개별 앞/뒤 초. 없으면(undefined) 전역 padBefore/padAfter 를 따른다.
export type Tag = {
  id: string; t: number; before?: number; after?: number; kind?: TagKind;
  /** 구간 태그일 때 카드에 찍힐 이름. 비어 있으면 순서대로 붙는 기본 이름을 쓴다. */
  label?: string;
};


export type CardSettings = {
  enabled: boolean;
  /** 고른 템플릿. 대회마다 시안이 달라 여러 벌 중에서 고른다. */
  template: string;
  /** 시작 카드가 머무는 시간(초). */
  introDurationSec: number;
  /** 구간 카드가 머무는 시간(초). 읽을 거리가 달라 따로 잡는다. */
  sectionDurationSec: number;
  /** 템플릿별로 따로 보관한다 — 템플릿을 바꿨다 돌아와도 적어둔 게 남아 있어야 하고,
   *  항목 id 가 겹쳐도 서로 섞이면 안 된다. {템플릿id: {항목id: 값}} */
  values: Record<string, Record<string, string>>;
  /** 항목을 옮긴 자리와 크기. 값과 같은 이유로 템플릿별로 나눠 둔다.
   *  {템플릿id: {항목id: {x, y, scale}}} — x·y 는 시안 좌표, scale 은 % 다.
   *  안 건드린 항목은 아예 없다. */
  boxes: Record<string, Record<string, { x: number; y: number; scale?: number }>>;
  /** 배경 색(#RRGGBB). 비우면 시안 색 그대로. 템플릿별로 따로 둔다 —
   *  시안이 다르면 어울리는 색도 다르다. {템플릿id: 색} */
  colors: Record<string, string>;
  /** 자동으로 서는 첫 구간 카드의 이름. 비우면 종목 기본값(1쿼터·전반전). */
  firstSectionLabel: string;
  /** 합본 맨 끝에 파인플레이 로고 영상을 붙인다. 내장 자산이라 켜고 끄기만 한다. */
  outro: boolean;
};


export type SavedWork = {
  tags: Tag[]; padBefore: number; padAfter: number;
  scoreboard?: Scoreboard; cards?: CardSettings; watermark?: Watermark;
  introDuration?: number; musicVolume?: number; originalVolume?: number;
  /** 클립↔클립 전환(디졸브) 켬/끔. 없으면 켬으로 본다. */
  clipTransition?: boolean;
};

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
function fields(value: unknown, strings: string[], numbers: string[], booleans: string[], nullable: string[] = []) {
  if (!object(value)) return false;
  return Object.entries(value).every(([key, val]) =>
    strings.includes(key) ? typeof val === 'string' : numbers.includes(key) ? finite(val)
      : booleans.includes(key) ? typeof val === 'boolean' : nullable.includes(key) ? val === null || finite(val) : true);
}

/** Read old tag arrays and current drafts without trusting imported structure. */
export function parseManualWork(raw: string, allowedKinds: string[]): SavedWork {
  const parsed: unknown = JSON.parse(raw);
  const value = Array.isArray(parsed) ? { tags: parsed, padBefore: 10, padAfter: 2 } : parsed;
  if (!object(value) || !Array.isArray(value.tags)) throw new Error('태그가 있는 복구 파일이 아닙니다.');
  const ids = new Set<string>();
  for (const tag of value.tags) {
    if (!object(tag) || typeof tag.id !== 'string' || !tag.id || ids.has(tag.id)
      || !finite(tag.t) || tag.t < 0 || (tag.kind !== undefined && !allowedKinds.includes(tag.kind))
      || (tag.label !== undefined && typeof tag.label !== 'string')
      || ['before', 'after'].some((key) => tag[key] !== undefined && (!finite(tag[key]) || tag[key] < 0))) {
      throw new Error('태그의 시각·종류·식별자를 확인하세요.');
    }
    ids.add(tag.id);
  }
  const work = {
    ...value, padBefore: value.padBefore ?? 10, padAfter: value.padAfter ?? 3,
    clipTransition: typeof value.clipTransition === 'boolean' ? value.clipTransition : true,
  };
  if (![work.padBefore, work.padAfter].every((n) => finite(n) && n >= 0)) throw new Error('패딩 값이 올바르지 않습니다.');
  for (const key of ['introDuration', 'musicVolume', 'originalVolume']) {
    if (value[key] !== undefined && (!finite(value[key]) || value[key] < 0 || value[key] > (key === 'introDuration' ? 15 : 200))) {
      throw new Error('인트로 길이 또는 음악 볼륨을 확인하세요.');
    }
  }
  if (value.scoreboard !== undefined && !fields(value.scoreboard,
    ['homeName', 'awayName', 'homeColor', 'awayColor', 'logoUrl', 'roundLabel', 'template'],
    ['startHome', 'startAway', 'sizePct', 'posX', 'posY', 'logoSizePct', 'nameSizePct'], ['enabled'], ['posPxX', 'posPxY'])) {
    throw new Error('점수판 설정이 올바르지 않습니다.');
  }
  if (value.watermark !== undefined && !fields(value.watermark, [], ['sizePct', 'opacity', 'posX', 'posY'], ['enabled'], ['posPxX', 'posPxY'])) {
    throw new Error('워터마크 설정이 올바르지 않습니다.');
  }
  if (value.cards !== undefined) {
    const cards = value.cards;
    if (!fields(cards, ['template', 'firstSectionLabel'], ['introDurationSec', 'sectionDurationSec'], ['enabled', 'outro'])) {
      throw new Error('카드 설정이 올바르지 않습니다.');
    }
    for (const key of ['values', 'boxes', 'colors']) {
      if (cards[key] === undefined) continue;
      if (!object(cards[key])) throw new Error('카드 항목이 올바르지 않습니다.');
      for (const item of Object.values(cards[key])) {
        if (key === 'colors') {
          if (typeof item !== 'string') throw new Error('카드 색이 올바르지 않습니다.');
        } else {
          if (!object(item)) throw new Error('카드 항목이 올바르지 않습니다.');
          if (key === 'values' && !Object.values(item).every((v) => typeof v === 'string')) throw new Error('카드 내용이 올바르지 않습니다.');
          if (key === 'boxes' && !Object.values(item).every((v) => object(v) && finite(v.x) && finite(v.y) && (v.scale === undefined || finite(v.scale)))) {
            throw new Error('카드 위치가 올바르지 않습니다.');
          }
        }
      }
    }
  }
  return work as SavedWork;
}

export type ManualSaveState = 'saved' | 'partial' | 'failed';

export function storeManualWork(storage: Pick<Storage, 'setItem'>, key: string, work: SavedWork): ManualSaveState {
  try { storage.setItem(key, JSON.stringify(work)); return 'saved'; } catch { /* Retry without images. */ }
  const lean: SavedWork = {
    ...work,
    scoreboard: work.scoreboard ? { ...work.scoreboard, logoUrl: '' } : undefined,
    cards: work.cards ? {
      ...work.cards,
      values: Object.fromEntries(Object.entries(work.cards.values).map(([template, values]) => [
        template, Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value.startsWith('data:') ? '' : value])),
      ])),
    } : undefined,
  };
  try { storage.setItem(key, JSON.stringify(lean)); return 'partial'; } catch { return 'failed'; }
}
