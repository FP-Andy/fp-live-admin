'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HighlightSubTabs from '../HighlightSubTabs';
import {
  BOARD_ASPECT, DEFAULT_SCOREBOARD, DEFAULT_WATERMARK, LOGO_SIZE_RANGE, MARK_RATIO, MARK_SRC,
  OverlayPlacer, POS_PRESETS, ScoreboardPreview, boardPlacement, markPlacement, readLogoDataUrl,
  type PlacedItem, type Scoreboard, type Watermark,
} from '../../../../components/HighlightOverlay';
import { API_BASE, apiJson } from '../../../../lib/api';
import type { CutClip, CutProgress } from '../../../../lib/localCut';
import { ProgressBar, LeaveBadge } from '../../../../components/HlProgress';
import { fitTagRange, parseClock } from '../../../../lib/tagRange';
import { useSportContext } from '../../../../components/SportContext';

type JobStatus = {
  id: string;
  status: string;
  error_message?: string | null;
  job_metadata?: { progress?: { detail?: string } | null } | null;
};

// 로컬 우선 태깅: 원본을 서버에 올리지 않고 브라우저에서 바로 재생하며 하이라이트 지점을 찍는다.
// 태그는 타임코드(초)일 뿐이라 용량이 없다시피 하고, 클립 추출은 이후 단계에서 붙는다.

// 태그 종류. 골이면 점수판 점수가 그 시점에 올라가고, 하이라이트면 점수는 그대로다.
// 없으면(undefined) 팀 구분 없는 일반 태그 — 점수판에는 영향을 주지 않는다.
type TagKind = 'home_goal' | 'home' | 'away' | 'away_goal'
  // 장면은 넣지 않고 점수판만 올리는 골. 신청팀 하이라이트에서 상대 골이 이것이다.
  | 'home_goal_only' | 'away_goal_only'
  // 농구 — 한 번에 1·2·3점이 오른다. 축구의 '골' 은 늘 1점이라 구분이 없었다.
  | 'bb_home_1' | 'bb_home_2' | 'bb_home_3'
  | 'bb_away_1' | 'bb_away_2' | 'bb_away_3'
  // 구간 경계. 클립을 만들지 않고, 합본에서 그 자리에 전체화면 카드를 세운다.
  | 'section';

// before/after 는 이 태그만의 개별 앞/뒤 초. 없으면(undefined) 전역 padBefore/padAfter 를 따른다.
type Tag = {
  id: string; t: number; before?: number; after?: number; kind?: TagKind;
  /** 구간 태그일 때 카드에 찍힐 이름. 비어 있으면 순서대로 붙는 기본 이름을 쓴다. */
  label?: string;
};

/** 합본 사이에 끼는 전체화면 카드. 시작 카드는 맨 앞, 구간 카드는 T 자리마다. */
/** 템플릿이 알려주는 '고칠 수 있는 항목' 하나. 좌표·글꼴은 서버만 알면 된다. */
type CardFieldSpec = {
  id: string;
  label: string;
  kind: 'text' | 'logo';
  placeholder: string;
  max_len: number;
  ui_width: number;
  /** 비었을 때 서버가 무엇으로 채우나 — '' / 'mark' / 'vs'. 안내에만 쓴다. */
  empty: string;
  /** 시안 좌표 [왼쪽, 위, 가로, 세로]. 위치 칸의 **기본값**이 된다. */
  box: [number, number, number, number];
  /** 크기까지 고칠 수 있는가 — 로고만이다(글자는 글꼴이 크기를 정한다). */
  scalable?: boolean;
};

type CardTemplateSpec = {
  id: string;
  name: string;
  note: string;
  /** 시안 규격 [가로, 세로]. 위치 값이 이 좌표계 안의 절대값이다. */
  design: [number, number];
  start_fields: CardFieldSpec[];
  section_fields: CardFieldSpec[];
};

type CardSettings = {
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
  /** 자동으로 서는 첫 구간 카드의 이름. 비우면 종목 기본값(1쿼터·전반전). */
  firstSectionLabel: string;
  /** 합본 맨 끝에 파인플레이 로고 영상을 붙인다. 내장 자산이라 켜고 끄기만 한다. */
  outro: boolean;
};

const CARD_SEC_DEFAULT = 3;

/** 자동으로 서는 첫 구간 카드의 자리표. 태그가 아니므로 tags 에는 없다. */
const AUTO_SECTION_ID = 'auto-first-section';

const DEFAULT_CARDS: CardSettings = {
  enabled: true,
  template: 'fineplay',
  introDurationSec: CARD_SEC_DEFAULT,
  sectionDurationSec: CARD_SEC_DEFAULT,
  values: {},
  boxes: {},
  firstSectionLabel: '',
  outro: true,
};

type SavedWork = {
  tags: Tag[]; padBefore: number; padAfter: number;
  scoreboard?: Scoreboard; cards?: CardSettings;
};

/** 이어붙일 원본 하나. 길이·해상도는 파일을 고른 직후 메타데이터에서 읽어 채운다. */
type Source = { file: File; url: string; duration: number; width: number; height: number };

// 태깅 단축키. code 는 물리 키라 한글 입력 상태와 무관하게 잡히고, hangul/letter 는
// code 가 오지 않는 브라우저를 위한 보루다.
type TagKindSpec = {
  key: TagKind; code: string; letter: string; hangul: string;
  label: string; badge: string; color: string; side: 'home' | 'away'; goal: boolean;
  /** 클립으로 만들지 여부. 생략하면 만든다. */
  clip?: boolean;
  /** 이 태그가 올리는 점수. 생략하면 1 — 축구의 골이 그렇다. */
  points?: number;
};

const FOOTBALL_TAG_KINDS: TagKindSpec[] = [
  { key: 'home_goal', code: 'KeyQ', letter: 'q', hangul: 'ㅂ', label: '홈 골', badge: '홈 골', color: '#2F6FED', side: 'home', goal: true },
  { key: 'home', code: 'KeyW', letter: 'w', hangul: 'ㅈ', label: '홈 장면', badge: '홈', color: '#2F6FED', side: 'home', goal: false },
  { key: 'away', code: 'KeyE', letter: 'e', hangul: 'ㄷ', label: '원정 장면', badge: '원정', color: '#E8452F', side: 'away', goal: false },
  { key: 'away_goal', code: 'KeyR', letter: 'r', hangul: 'ㄱ', label: '원정 골', badge: '원정 골', color: '#E8452F', side: 'away', goal: true },
  // 점수만 올리는 골 — 클립을 만들지 않는다. 신청팀 하이라이트에서 상대 골이 여기 해당한다.
  { key: 'home_goal_only', code: 'KeyD', letter: 'd', hangul: 'ㅇ', label: '홈 골(점수만)', badge: '홈 골·점수만', color: '#2F6FED', side: 'home', goal: true, clip: false },
  { key: 'away_goal_only', code: 'KeyF', letter: 'f', hangul: 'ㄹ', label: '원정 골(점수만)', badge: '원정 골·점수만', color: '#E8452F', side: 'away', goal: true, clip: false },
];

/** 농구 — 득점이 1·2·3점으로 갈린다. 찍는 순간 점수판이 그만큼 오른다.
 *
 *  홈 q·w·e / 어웨이 a·s·d 로 **손이 좌우로 갈린다**(2026-09-19 합의). 축구처럼
 *  q·w·e·r 한 줄로 두면 홈/어웨이를 헷갈린다.
 *
 *  장면(득점 없는 하이라이트)은 **z** 다. 축구의 s 자리를 여기서는 어웨이 2점이 쓴다.
 *  '점수만 반영'(클립 없이 점수판만)은 두지 않았다 — 필요해지면 그때 넣는다.
 */
const BASKETBALL_TAG_KINDS: TagKindSpec[] = [
  { key: 'bb_home_1', code: 'KeyQ', letter: 'q', hangul: 'ㅂ', label: '홈 1점', badge: '홈 +1', color: '#2F6FED', side: 'home', goal: true, points: 1 },
  { key: 'bb_home_2', code: 'KeyW', letter: 'w', hangul: 'ㅈ', label: '홈 2점', badge: '홈 +2', color: '#2F6FED', side: 'home', goal: true, points: 2 },
  { key: 'bb_home_3', code: 'KeyE', letter: 'e', hangul: 'ㄷ', label: '홈 3점', badge: '홈 +3', color: '#2F6FED', side: 'home', goal: true, points: 3 },
  { key: 'bb_away_1', code: 'KeyA', letter: 'a', hangul: 'ㅁ', label: '원정 1점', badge: '원정 +1', color: '#E8452F', side: 'away', goal: true, points: 1 },
  { key: 'bb_away_2', code: 'KeyS', letter: 's', hangul: 'ㄴ', label: '원정 2점', badge: '원정 +2', color: '#E8452F', side: 'away', goal: true, points: 2 },
  { key: 'bb_away_3', code: 'KeyD', letter: 'd', hangul: 'ㅇ', label: '원정 3점', badge: '원정 +3', color: '#E8452F', side: 'away', goal: true, points: 3 },
];

/** 종류 없는 일반 태그를 찍는 키. 농구는 s 를 어웨이 2점이 쓰므로 z 로 옮겼다. */
// 득점 없는 장면을 찍는 키. 안내 문구와 버튼 라벨이 여기서 나온다 — 한 곳만 고치면 된다.
// 농구가 S 를 못 쓰는 이유: 그 자리는 원정 2점이 쓴다.
const PLAIN_TAG_HOTKEY: Record<'FOOTBALL' | 'BASKETBALL',
  { code: string; letters: string[]; label: string; hangul: string }> = {
  FOOTBALL: { code: 'KeyS', letters: ['s', 'S', 'ㄴ'], label: 'S', hangul: 'ㄴ' },
  BASKETBALL: { code: 'KeyX', letters: ['x', 'X', 'ㅌ'], label: 'X', hangul: 'ㅌ' },
};

/** 구간 카드를 세우는 자리. 두 종목이 같은 키(T)를 쓴다 — 뜻이 같기 때문이다. */
const SECTION_TAG_KIND: TagKindSpec = {
  key: 'section', code: 'KeyT', letter: 't', hangul: 'ㅅ',
  label: '구간 시작', badge: '구간', color: '#FF7400',
  side: 'home', goal: false, clip: false,
};

/** N 번째 구간의 기본 이름. 그 뒤로는 연장으로 센다. 목록에서 고칠 수 있다. */
const SECTION_NAMES: Record<'FOOTBALL' | 'BASKETBALL', string[]> = {
  FOOTBALL: ['전반전', '후반전', '연장 전반', '연장 후반'],
  BASKETBALL: ['1쿼터', '2쿼터', '3쿼터', '4쿼터'],
};

const sectionNameAt = (sport: string, n: number): string => {
  const names = SECTION_NAMES[sport === 'BASKETBALL' ? 'BASKETBALL' : 'FOOTBALL'];
  return names[n] ?? `연장 ${n - names.length + 1}`;
};

const kindsForSport = (sport: string): TagKindSpec[] => [
  ...(sport === 'BASKETBALL' ? BASKETBALL_TAG_KINDS : FOOTBALL_TAG_KINDS),
  SECTION_TAG_KIND,
];

/** 모든 스포츠의 종류를 합친 조회표 — 저장된 옛 태그도 읽을 수 있어야 한다. */
const ALL_TAG_KINDS: TagKindSpec[] = [
  ...FOOTBALL_TAG_KINDS, ...BASKETBALL_TAG_KINDS, SECTION_TAG_KIND,
];

/** 그 종류가 클립으로 만들어지는가. 점수만 반영하는 골은 아니다. */
const makesClip = (kind?: TagKind) =>
  (ALL_TAG_KINDS.find((k) => k.key === kind)?.clip ?? true);
const KIND_BY_KEY = new Map(ALL_TAG_KINDS.map((k) => [k.key, k]));

/** 이 태그가 점수판을 몇 점 올리나. 득점 태그가 아니면 0. */
const pointsOf = (
  kind: TagKind | undefined,
  allowed: TagKindSpec[] = ALL_TAG_KINDS,
): { side: 'home' | 'away'; points: number } | null => {
  // **지금 스포츠의 종류만 점수를 올린다.** 옛 저장본이나 키가 섞인 경우에 다른
  // 스포츠의 태그가 들어와도 점수판을 흔들지 않는다 — 배지는 KIND_BY_KEY 로 그려
  // 주되(무엇이었는지 보여야 고칠 수 있다), 점수에는 안 넣는다.
  const spec = allowed.find((k) => k.key === kind);
  if (!spec?.goal) return null;
  return { side: spec.side, points: spec.points ?? 1 };
};


const SPEEDS = [1, 1.5, 2, 3, 4];
const SEEK_STEP = 5;
const AUTOSAVE_PREFIX = 'fhl.manual.tags.';

const card: React.CSSProperties = {
  background: 'var(--surface-card, #1b1b1f)',
  border: '1px solid var(--border-ghost, #2c2c32)',
  borderRadius: 'var(--radius-card, 10px)',
  padding: 16,
  marginBottom: 16,
};
const btn: React.CSSProperties = {
  fontSize: 13,
  padding: '8px 16px',
  background: 'var(--button-dark, #2a2a30)',
  border: '1px solid var(--border-ghost, #3a3a42)',
  borderRadius: 8,
  cursor: 'pointer',
  color: 'var(--text, #eee)',
};
const smallBtn: React.CSSProperties = { ...btn, padding: '4px 10px', fontSize: 12 };
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--accent, #3b82f6)', borderColor: 'transparent' };
const numInput: React.CSSProperties = {
  width: 60,
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--border-ghost, #3a3a42)',
  background: 'var(--surface-input, #1b1b1f)',
  color: 'var(--text, #eee)',
  fontSize: 13,
};
const stageBox: React.CSSProperties = {
  marginTop: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 8,
  background: 'var(--surface-input, #16161a)',
  border: '1px solid var(--border-ghost, #2c2c32)',
};
const stageHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
const stageCount: React.CSSProperties = { fontSize: 12, color: 'var(--muted, #999)', marginLeft: 'auto' };
const stageNote: React.CSSProperties = { fontSize: 12, color: 'var(--muted, #999)', margin: 0 };

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 재생하지 않고 길이·해상도만 읽는다.
 *  길이는 이어붙인 타임라인에, 해상도는 점수판 위치 미리보기에 쓴다. */
function probeMeta(url: string): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      const duration = probe.duration;
      const width = probe.videoWidth;
      const height = probe.videoHeight;
      probe.src = '';
      // 길이를 못 읽으면(Infinity·NaN) 이어붙인 좌표가 통째로 어긋나므로 실패로 본다.
      if (!Number.isFinite(duration) || duration <= 0) reject(new Error('영상 길이를 읽을 수 없습니다.'));
      // 해상도는 못 읽어도 태깅 자체는 되므로 16:9 로 가정하고 넘어간다.
      else resolve({ duration, width: width || 1920, height: height || 1080 });
    };
    probe.onerror = () => reject(new Error('영상을 열 수 없습니다.'));
    probe.src = url;
  });
}


const fmtBytes = (bytes: number) => {
  const mb = bytes / (1024 * 1024);
  return mb < 1024 ? `${mb.toFixed(0)} MB` : `${(mb / 1024).toFixed(2)} GB`;
};


export default function ManualHighlightPage() {
  // 원본을 여러 개 고르면 고른 순서대로 이어붙인 '하나의 타임라인' 처럼 다룬다.
  // 태그·클립 구간은 전부 이 이어붙인 좌표(글로벌 초)이고, 실제로 자를 때만 파일별 좌표로 되돌린다.
  const [sources, setSources] = useState<Source[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tags, setTags] = useState<Tag[]>([]);
  const [scoreboard, setScoreboard] = useState<Scoreboard>(DEFAULT_SCOREBOARD);
  const [cards, setCards] = useState<CardSettings>(DEFAULT_CARDS);
  // 미리보기로 보고 있는 카드. 'start' 이거나 구간 태그의 id.
  const [cardPreviewOf, setCardPreviewOf] = useState<string>('start');
  const [cardPreviewUrl, setCardPreviewUrl] = useState('');
  const [cardPreviewBusy, setCardPreviewBusy] = useState(false);
  const [cardPreviewError, setCardPreviewError] = useState('');
  const [cardTemplates, setCardTemplates] = useState<CardTemplateSpec[]>([]);

  // 고를 수 있는 템플릿과 각 템플릿의 항목. 설정 칸을 여기서 만든다 — 항목을 화면에
  // 박아 두면 템플릿을 하나 들일 때마다 화면을 고쳐야 한다.
  useEffect(() => {
    let alive = true;
    apiJson<{ templates: CardTemplateSpec[]; default: string }>('/highlight/card-templates')
      .then((data) => {
        if (!alive) return;
        setCardTemplates(data.templates);
        // 저장된 템플릿이 사라졌으면(코드에서 뺐으면) 기본으로 돌린다.
        setCards((prev) => (data.templates.some((t) => t.id === prev.template)
          ? prev
          : { ...prev, template: data.default || data.templates[0]?.id || prev.template }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const cardTemplate = cardTemplates.find((t) => t.id === cards.template) ?? null;
  const cardValues = cards.values[cards.template] ?? {};
  const setCardValue = (fieldId: string, value: string) => setCards((prev) => ({
    ...prev,
    values: {
      ...prev.values,
      [prev.template]: { ...(prev.values[prev.template] ?? {}), [fieldId]: value },
    },
  }));
  const cardBoxes = cards.boxes[cards.template] ?? {};
  /** 시안이 정한 자리. 옛 응답에 box 가 없어도 화면이 죽지 않게 받쳐 둔다. */
  const designBox = (spec: CardFieldSpec) => spec.box ?? [0, 0, 0, 0];
  /** 항목이 지금 놓인 자리. 안 건드렸으면 시안 그대로다 — 칸에 그 값이 뜬다. */
  const boxOf = (spec: CardFieldSpec) => {
    const moved = cardBoxes[spec.id];
    const [left, top] = designBox(spec);
    return { x: moved?.x ?? left, y: moved?.y ?? top };
  };
  const setCardBox = (spec: CardFieldSpec, axis: 'x' | 'y' | 'scale', value: number) => setCards((prev) => {
    const forTemplate = { ...(prev.boxes[prev.template] ?? {}) };
    const [left, top] = designBox(spec);
    const now = forTemplate[spec.id] ?? { x: left, y: top };
    forTemplate[spec.id] = { ...now, [axis]: value };
    return { ...prev, boxes: { ...prev.boxes, [prev.template]: forTemplate } };
  });
  /** 로고 크기(%). 안 건드렸으면 100 이다. */
  const scaleOf = (spec: CardFieldSpec) => cardBoxes[spec.id]?.scale ?? 100;
  /** 이 템플릿에서 옮긴 자리를 모두 시안으로 되돌린다. */
  const resetCardBoxes = () => setCards((prev) => {
    const next = { ...prev.boxes };
    delete next[prev.template];
    return { ...prev, boxes: next };
  });
  const cardBoxesMoved = Object.keys(cardBoxes).length > 0;

  const [watermark, setWatermark] = useState<Watermark>(DEFAULT_WATERMARK);
  // 배치 화면에서 지금 만지고 있는 오버레이. 겹칠 때 원하는 걸 집으려면 하나만 잡혀야 한다.
  const [activeOverlay, setActiveOverlay] = useState<'board' | 'mark'>('board');
  // 점수판 위치를 실제 장면 위에서 보려고 담아 둔 정지화면(dataURL).
  const [frameUrl, setFrameUrl] = useState('');
  // 기본 앞/뒤 패딩 — 태깅 화면 공통값(2026-09-16, 신청 태깅과 통일).
  // 지금 고른 스포츠. 태그 종류·단축키·점수 반영이 여기서 갈린다(FPA dual 과 같은 방식).
  const { sport } = useSportContext();
  const isBasketball = sport === 'BASKETBALL';
  const tagKinds = kindsForSport(sport);
  const plainHotkey = PLAIN_TAG_HOTKEY[isBasketball ? 'BASKETBALL' : 'FOOTBALL'];

  const [padBefore, setPadBefore] = useState(10);
  const [padAfter, setPadAfter] = useState(3);
  const [status, setStatus] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [cutProgress, setCutProgress] = useState<CutProgress | null>(null);
  const [clips, setClips] = useState<CutClip[]>([]);
  // 클립 n 번이 tags 의 몇 번째였는지. '점수만 반영' 태그를 건너뛰므로 둘이 어긋난다.
  const [clipTagIndex, setClipTagIndex] = useState<number[]>([]);
  const [cutError, setCutError] = useState('');
  // 구간 칸을 고치는 동안의 입력값. 글자마다 반영하면 태그가 재정렬돼 줄이 튀므로
  // 확정(Enter·포커스 아웃) 때만 적용한다.
  const [rangeDraft, setRangeDraft] = useState<{ key: string; text: string } | null>(null);
  // 눌러서 재생한 태그. 영상으로 시선을 옮겼다가 목록으로 돌아오면 무엇을 눌렀는지
  // 기억이 안 나서, 그 줄을 표시해 둔다.
  //
  // **재생이 끝나도 지우지 않는다.** 끝나는 순간 표시가 사라지면 정작 목록을 볼 때는
  // 없다. 다른 데로 옮길 때(seekTo)만 지운다 — 그때는 더 이상 그 구간이 아니다.
  const [previewTagId, setPreviewTagId] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState('');
  const [publishError, setPublishError] = useState('');
  const [doneJobId, setDoneJobId] = useState('');
  // 업로드는 브라우저(탭 유지 필요), 합치기는 서버(탭 닫아도 됨) — 단계를 나눠 바/배지에 쓴다.
  const [publishPhase, setPublishPhase] = useState<'idle' | 'uploading' | 'merging' | 'done'>('idle');
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [introFile, setIntroFile] = useState<File | null>(null);
  const [introUrl, setIntroUrl] = useState('');
  const [introDuration, setIntroDuration] = useState(1.8);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const urlsRef = useRef<string[]>([]);
  // 원본이 바뀐 뒤 옮겨갈 위치(그 원본 안의 초). 메타데이터가 온 다음에야 적용할 수 있다.
  const pendingSeekRef = useRef<number | null>(null);
  // 원본을 넘어갈 때 재생을 이어갈지.
  const resumeRef = useRef(false);
  // 태그를 눌러 '그 클립만' 재생 중일 때의 끝 지점(이어붙인 초). null 이면 그냥 재생.
  const previewEndRef = useRef<number | null>(null);

  // 각 원본이 이어붙인 타임라인에서 시작하는 지점.
  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const src of sources) {
      out.push(acc);
      acc += src.duration;
    }
    return out;
  }, [sources]);
  const duration = useMemo(() => sources.reduce((sum, src) => sum + src.duration, 0), [sources]);
  const videoUrl = sources[activeIndex]?.url || '';

  /** 이어붙인 좌표 t 가 몇 번째 원본의 몇 초인지. */
  const locate = useCallback((t: number) => {
    if (!sources.length) return { index: 0, local: 0 };
    let i = 0;
    while (i + 1 < sources.length && t >= offsets[i] + sources[i].duration) i += 1;
    return { index: i, local: Math.max(0, Math.min(sources[i].duration, t - offsets[i])) };
  }, [sources, offsets]);

  // 자동저장 키는 고른 원본 전체를 특정한다 (이름+크기, 순서 포함).
  // 순서가 다르면 태그 좌표의 의미가 달라지므로 다른 작업으로 봐야 한다.
  //
  // **스포츠도 키에 넣는다.** 같은 영상으로 축구와 농구를 오가면 태그가 섞인다 —
  // 농구로 찍은 3점 태그가 축구 화면에 남아 점수판이 한 번에 3점씩 오른다. 종류
  // 선택칸에는 없는 값이라 화면으로는 고칠 수도 없다. 키를 나누면 애초에 안 섞인다.
  const storageKey = useMemo(
    () => (sources.length
      ? `${AUTOSAVE_PREFIX}${sport}:${sources.map((src) => `${src.file.name}:${src.file.size}`).join('|')}`
      : ''),
    [sources, sport],
  );

  const revoke = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  useEffect(() => revoke, [revoke]);

  const pickFiles = async (list: FileList | null) => {
    revoke();
    setTags([]);
    setCurrent(0);
    setPlaying(false);
    setUnsupported(false);
    setStatus('');
    setClips([]);
    setCutError('');
    setCutProgress(null);
    setActiveIndex(0);
    setSources([]);
    const files = list ? Array.from(list) : [];
    if (!files.length) return;

    // 길이를 다 읽어야 이어붙인 좌표가 나온다. 하나라도 못 읽으면 태깅 자체가 어긋나므로 중단한다.
    setStatus('영상 길이를 읽는 중…');
    const made: Source[] = [];
    for (const f of files) {
      const url = URL.createObjectURL(f);
      urlsRef.current.push(url);
      try {
        made.push({ file: f, url, ...(await probeMeta(url)) });
      } catch {
        revoke();
        setUnsupported(true);
        setStatus('');
        return;
      }
    }
    setSources(made);
    setStatus(made.length > 1
      ? `${made.length}개를 고른 순서대로 이어 붙였습니다 — 총 ${fmt(made.reduce((sum, src) => sum + src.duration, 0))}`
      : '');
  };

  /** 원본 순서 바꾸기 — 태그 좌표가 통째로 어긋나므로 태그가 없을 때만 허용한다. */
  const moveSource = (index: number, delta: number) => {
    setSources((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    setActiveIndex(0);
    setCurrent(0);
    setClips([]);
  };

  // 인트로 사진 미리보기용 objectURL 을 갈아끼울 때마다 이전 것을 해제한다.
  const introUrlRef = useRef<string>('');
  const pickIntro = useCallback((f: File | null) => {
    if (introUrlRef.current) {
      URL.revokeObjectURL(introUrlRef.current);
      introUrlRef.current = '';
    }
    setIntroFile(f);
    if (!f) {
      setIntroUrl('');
      return;
    }
    const url = URL.createObjectURL(f);
    introUrlRef.current = url;
    setIntroUrl(url);
  }, []);

  useEffect(() => () => {
    if (introUrlRef.current) URL.revokeObjectURL(introUrlRef.current);
  }, []);

  // 이전에 태깅하던 파일이면 저장해둔 작업을 되살린다.
  // 패딩도 함께 복원해야 한다. 태그만 돌아오고 패딩이 기본값으로 리셋되면
  // 같은 태그인데 클립 구간이 조용히 달라진다.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Tag[] | SavedWork;
      const saved: SavedWork = Array.isArray(parsed)
        ? { tags: parsed, padBefore: 10, padAfter: 2 } // 패딩을 저장하기 전 형식
        : parsed;
      if (!saved?.tags?.length) return;
      setTags(saved.tags);
      setPadBefore(saved.padBefore ?? 10);
      setPadAfter(saved.padAfter ?? 3);
      // 팀명·색까지 같이 돌아와야 한다. 태그만 복원되고 점수판이 초기화되면
      // 같은 태그인데 결과물의 점수판이 조용히 달라진다.
      if (saved.scoreboard) setScoreboard({ ...DEFAULT_SCOREBOARD, ...saved.scoreboard });
      if (saved.cards) setCards({ ...DEFAULT_CARDS, ...saved.cards });
      setStatus(
        `이전 작업 복원 — 태그 ${saved.tags.length}개, 앞 ${saved.padBefore ?? 10}초 / 뒤 ${saved.padAfter ?? 3}초`,
      );
    } catch {
      /* 손상된 저장값은 무시하고 새로 시작한다 */
    }
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    if (!tags.length) { localStorage.removeItem(storageKey); return; }

    const work: SavedWork = { tags, padBefore, padAfter, scoreboard, cards };
    try {
      localStorage.setItem(storageKey, JSON.stringify(work));
      return;
    } catch {
      /* 저장 칸이 넘쳤다. 아래에서 그림만 빼고 다시 해 본다. */
    }
    // 브라우저 저장 칸은 5MB 남짓인데 로고는 dataURL 이라 한 장에 몇 MB 가 된다.
    // **여기서 터지면 화면이 통째로 죽는다** — 태깅한 것까지 날아간다.
    // 그림을 뺀 나머지(태그·구간·설정)라도 남기는 편이 훨씬 낫다.
    const drop = (value: string) => (String(value).startsWith('data:') ? '' : value);
    const lean: SavedWork = {
      ...work,
      scoreboard: { ...scoreboard, logoUrl: '' },
      cards: {
        ...cards,
        values: Object.fromEntries(Object.entries(cards.values).map(([tid, fields]) => [
          tid, Object.fromEntries(Object.entries(fields).map(([id, v]) => [id, drop(v)])),
        ])),
      },
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(lean));
      setStatus('로고가 커서 작업 저장에는 로고를 뺐습니다 — 새로 고치면 로고만 다시 넣으세요.');
    } catch {
      /* 그래도 안 들어가면 저장을 포기한다. 태깅은 계속할 수 있어야 한다. */
    }
  }, [tags, padBefore, padAfter, scoreboard, cards, storageKey]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, videoUrl]);

  const seekTo = useCallback((t: number, opts?: { play?: boolean }) => {
    if (!sources.length) return;
    // 다른 데로 옮기면 태그 미리보기는 취소한다 — 그 구간을 벗어나기 때문.
    previewEndRef.current = null;
    setPreviewTagId(null);
    const { index, local } = locate(Math.max(0, Math.min(duration, t)));
    if (index !== activeIndex) {
      // 다른 원본이면 src 가 바뀐 뒤에야 옮길 수 있다. 재생 중이었으면 이어서 재생한다.
      pendingSeekRef.current = local;
      resumeRef.current = opts?.play ?? !videoRef.current?.paused;
      setActiveIndex(index);
      setCurrent(offsets[index] + local);
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = local;
    if (opts?.play) void v.play();
  }, [sources, locate, duration, activeIndex, offsets]);

  /** 지금 보이는 화면을 정지화면으로 담아 점수판 위치 미리보기 배경으로 쓴다. */
  const captureFrame = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || v.readyState < 2) return;
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * 480));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    // 원본은 blob URL(같은 출처)이라 캔버스가 오염되지 않는다. 그래도 만약을 대비해 감싼다.
    try {
      setFrameUrl(canvas.toDataURL('image/jpeg', 0.7));
    } catch {
      /* 못 담으면 단색 배경으로 보여준다 */
    }
  }, []);

  // 점수판을 켤 때 한 번 담아 둔다 — 빈 상자보다 실제 장면 위가 훨씬 가늠하기 쉽다.
  useEffect(() => {
    if (scoreboard.enabled && !frameUrl) captureFrame();
  }, [scoreboard.enabled, frameUrl, captureFrame]);

  // 원본을 새로 고르면 이전 화면은 더 이상 맞지 않는다.
  useEffect(() => { setFrameUrl(''); }, [sources]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const addTag = useCallback((kind?: TagKind) => {
    const v = videoRef.current;
    if (!v) return;
    const t = (offsets[activeIndex] ?? 0) + v.currentTime;
    setTags((prev) => {
      // 같은 지점을 두 번 찍는 실수를 막는다 (1초 이내면 무시).
      if (prev.some((p) => Math.abs(p.t - t) < 1)) return prev;
      const next = [...prev, { id: `${t.toFixed(3)}-${Math.random().toString(36).slice(2, 7)}`, t, kind }];
      next.sort((a, b) => a.t - b.t);
      return next;
    });
  }, [offsets, activeIndex]);

  const removeTag = (id: string) => setTags((prev) => prev.filter((p) => p.id !== id));

  const globalNow = () => (offsets[activeIndex] ?? 0) + (videoRef.current?.currentTime ?? 0);

  const setTagKind = (id: string, kind?: TagKind) =>
    setTags((prev) => prev.map((p) => (p.id === id ? { ...p, kind } : p)));

  const setTagLabel = (id: string, label: string) =>
    setTags((prev) => prev.map((p) => (p.id === id ? { ...p, label } : p)));

  // 구간 태그마다 '몇 번째 구간인가'와 '어느 클립 앞에 서는가'를 미리 셈해 둔다.
  //
  // 서버에는 초가 아니라 **클립 순번**으로 보낸다. 원본이 여러 개면 파일이 바뀔 때
  // 초가 도로 작아져 초로는 자리를 못 정한다. 클립 번호는 업로드 때 시간순으로 1부터
  // 매겨지므로(publish 의 index), 그 앞에 클립이 몇 개 있었는지만 세면 된다.
  //
  // 첫 구간(1쿼터·전반전)은 **T 없이도 자동으로** 선다. 합본은 늘
  //
  //     [시작 카드] [1쿼터] 클립 클립 … [2쿼터] 클립 …
  //
  // 이 모양이라, 첫 구간 카드는 시작 카드 바로 뒤 자리가 이미 정해져 있다. 그 한 장을
  // 굳이 찍게 하면 빼먹었을 때 클립이 아무 구간에도 속하지 않은 채 시작된다.
  // 그래서 4쿼터 경기는 T 를 세 번(2·3·4쿼터)만 찍으면 된다.
  //
  // 다만 첫 클립보다 앞에 T 를 찍었다면 그게 첫 구간이다 — 자동으로 한 장 더 세우면
  // 같은 자리에 카드가 두 장 겹친다.
  const sectionPlan = useMemo(() => {
    const plan = new Map<string, { ordinal: number; label: string; beforeOrder: number }>();
    // 첫 클립보다 앞에 찍은 T 가 있는가.
    let taggedFirst = false;
    for (const tag of tags) {
      if (tag.kind === 'section') { taggedFirst = true; break; }
      if (makesClip(tag.kind)) break;
    }
    const auto = !taggedFirst && tags.some((tag) => makesClip(tag.kind));
    let clipsSoFar = 0;
    let ordinal = auto ? 1 : 0;
    if (auto) {
      plan.set(AUTO_SECTION_ID, {
        ordinal: 0,
        label: (cards.firstSectionLabel || '').trim() || sectionNameAt(sport, 0),
        beforeOrder: 1,
      });
    }
    for (const tag of tags) {
      if (tag.kind === 'section') {
        plan.set(tag.id, {
          ordinal,
          label: (tag.label || '').trim() || sectionNameAt(sport, ordinal),
          beforeOrder: clipsSoFar + 1,
        });
        ordinal += 1;
      } else if (makesClip(tag.kind)) {
        clipsSoFar += 1;
      }
    }
    return plan;
  }, [tags, sport, cards.firstSectionLabel]);

  // 카드 미리보기는 **서버가 그린다**. 브라우저에 같은 그림을 한 벌 더 두면 시안이
  // 바뀔 때 두 곳이 어긋나 '미리보기는 맞는데 결과물은 다른' 일이 생긴다. 합치기가
  // 쓰는 그 함수를 그대로 호출하므로 어긋날 수가 없다.
  //
  // 글자를 한 자 칠 때마다 왕복하지 않도록 조금 기다렸다 부른다.
  const previewLabel = cardPreviewOf === 'start'
    ? ''
    : (sectionPlan.get(cardPreviewOf)?.label ?? '');
  useEffect(() => {
    if (!cards.enabled) {
      setCardPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return ''; });
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      setCardPreviewBusy(true);
      try {
        const body = cardPreviewOf === 'start'
          ? { template: cards.template, kind: 'start', width: 960, values: cardValues, boxes: cardBoxes }
          : { template: cards.template, kind: 'section', width: 960, label: previewLabel };
        const res = await fetch(`${API_BASE}/highlight/card-preview`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text() || '미리보기 실패');
        const url = URL.createObjectURL(await res.blob());
        if (!alive) { URL.revokeObjectURL(url); return; }
        setCardPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
        setCardPreviewError('');
      } catch (err) {
        if (alive) setCardPreviewError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setCardPreviewBusy(false);
      }
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [cards, cardPreviewOf, previewLabel]);

  // 보고 있던 구간 태그가 지워지면 시작 카드로 돌아간다.
  useEffect(() => {
    if (cardPreviewOf !== 'start' && !sectionPlan.has(cardPreviewOf)) setCardPreviewOf('start');
  }, [sectionPlan, cardPreviewOf]);

  // 페이지를 떠날 때 마지막 그림을 놓아 준다.
  useEffect(() => () => { if (cardPreviewUrl) URL.revokeObjectURL(cardPreviewUrl); },
    [cardPreviewUrl]);

  // 태그마다 '그 클립이 끝난 시점'의 점수. 골 태그면 자기 자신을 포함해 올라간다 —
  // 서버가 새기는 점수와 같은 계산이라, 목록에서 미리 그대로 확인할 수 있다.
  // 실제로 클립이 되는 태그 수. '점수만 반영' 태그는 장면을 만들지 않으므로 빠진다.
  const clipTagCount = useMemo(() => tags.filter((t) => makesClip(t.kind)).length, [tags]);
  // 실제로 들어갈 구간 카드 수 — 자동으로 서는 첫 장까지 포함한다.
  const sectionCount = sectionPlan.size;

  const runningScores = useMemo(() => {
    let home = scoreboard.startHome;
    let away = scoreboard.startAway;
    return tags.map((tag) => {
      // 클립을 만들지 않는 골도 점수는 올린다 — 그게 이 태그의 존재 이유다.
      // 올리는 폭은 태그가 들고 있다(농구 1·2·3점). 축구의 골은 1 이다.
      const scored = pointsOf(tag.kind, tagKinds);
      if (scored?.side === 'home') home += scored.points;
      else if (scored?.side === 'away') away += scored.points;
      return [home, away] as [number, number];
    });
  }, [tags, scoreboard.startHome, scoreboard.startAway, tagKinds]);

  // 합치기는 '첫 클립'의 규격에 모든 조각을 맞춘다(highlight_jobs 의 norm_v). 첫 클립은
  // 가장 이른 태그가 있는 원본에서 나오므로, 미리보기도 그 원본의 해상도로 그려야 맞다.
  const boardVideo = useMemo(() => {
    const src = tags.length ? sources[locate(tags[0].t).index] : sources[0];
    return { w: src?.width || 1920, h: src?.height || 1080 };
  }, [tags, sources, locate]);

  const finalScore = runningScores.length
    ? runningScores[runningScores.length - 1]
    : ([scoreboard.startHome, scoreboard.startAway] as [number, number]);

  /** 이 태그로 만들어질 클립 구간 [시작, 끝] — 이어붙인 좌표. 원본 경계에서 잘린다. */
  const clipRange = (tag: Tag): [number, number] => {
    const { index } = locate(tag.t);
    const srcStart = offsets[index] ?? 0;
    const srcEnd = srcStart + (sources[index]?.duration ?? 0);
    return [
      Math.max(srcStart, tag.t - effBefore(tag)),
      Math.min(srcEnd, tag.t + effAfter(tag)),
    ];
  };

  /** 태그를 누르면 그 클립 구간만 재생하고 끝에서 멈춘다 — 실제로 어떤 클립이 나올지 확인용. */
  const playTagClip = (tag: Tag) => {
    const [start, end] = clipRange(tag);
    seekTo(start, { play: true });
    // seekTo 가 미리보기를 지우므로 그 뒤에 건다(표시도 마찬가지).
    previewEndRef.current = end;
    setPreviewTagId(tag.id);
    videoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // 태그의 개별 앞/뒤 초를 바꾼다. undefined 로 넘기면 오버라이드를 지우고 전역 기본값으로 되돌린다.
  const updateTagPad = (id: string, key: 'before' | 'after', value: number | undefined) => {
    setTags((prev) =>
      prev.map((tag) => (tag.id === id ? { ...tag, [key]: value } : tag)),
    );
  };

  // 이 태그에 실제로 적용되는 앞/뒤 초 (개별값 있으면 그것, 없으면 전역 기본값).
  const effBefore = (tag: Tag) => tag.before ?? padBefore;
  const effAfter = (tag: Tag) => tag.after ?? padAfter;

  /** 클립 구간을 직접 옮긴다 — 앞/뒤를 거치지 않고 시작·끝을 그대로 받는다.
   *
   *  태깅 시점(tag.t)은 **구간의 80% 자리**로 따라 움직인다(lib/tagRange.TAG_POINT_RATIO).
   *  구간을 2:32~2:43 으로 옮기면 태깅 시점은 11 초의 80% 인 2:40.8 로 간다.
   *
   *  시점을 그대로 두고 앞/뒤만 늘리는 방식(기존 앞·뒤 칸)과 다르다. 그쪽은 '언제
   *  일어났나' 가 고정이고, 이쪽은 '어디를 보여줄까' 가 고정이다. 둘 다 남긴다.
   */
  const setTagRange = (id: string, rawStart: number, rawEnd: number) => {
    setTags((prev) => {
      const tag = prev.find((p) => p.id === id);
      if (!tag) return prev;
      // 구간은 그 태그가 들어 있는 **원본 안**을 벗어날 수 없다 — 넘어가면 다른 파일의
      // 장면이 섞인다.
      const { index } = locate(tag.t);
      const srcStart = offsets[index] ?? 0;
      const fit = fitTagRange(
        rawStart, rawEnd,
        { srcStart, srcEnd: srcStart + (sources[index]?.duration ?? 0) },
      );
      if (!fit) return prev;

      const next = prev.map((p) => (
        p.id === id ? { ...p, t: fit.t, before: fit.before, after: fit.after } : p
      ));
      // t 가 바뀌었으니 순서를 다시 맞춘다(addTag 와 같은 규칙).
      next.sort((a, b) => a.t - b.t);
      return next;
    });
  };

  /** 구간 칸 확정. 못 읽는 값이면 아무것도 바꾸지 않는다. */
  const commitRange = (tag: Tag, field: 'start' | 'end') => {
    const draft = rangeDraft;
    setRangeDraft(null);
    if (!draft || draft.key !== `${tag.id}:${field}`) return;
    const sec = parseClock(draft.text);
    if (sec === null) return;
    const [cs, ce] = clipRange(tag);
    setTagRange(tag.id, field === 'start' ? sec : cs, field === 'end' ? sec : ce);
  };

  // 단축키. 입력창에 포커스가 있을 때는 동작하지 않아야 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      if (!videoRef.current) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
      // seekTo 는 이어붙인 좌표를 받는다. 재생기 시간은 현재 원본 안의 초라 오프셋을 더해야 한다.
      const now = (offsets[activeIndex] ?? 0) + videoRef.current.currentTime;
      if (e.code === 'ArrowLeft') { e.preventDefault(); seekTo(now - SEEK_STEP); return; }
      if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(now + SEEK_STEP); return; }
      // 한글 입력 상태(ㄴ)에서도 찍혀야 한다 — e.key 는 IME 를 타서 'ㄴ'·'Process' 로 오지만
      // e.code 는 물리 키라 자판 상태와 무관하다. key 비교는 code 가 안 오는 경우의 보루.
      if (e.code === plainHotkey.code || plainHotkey.letters.includes(e.key)) {
        e.preventDefault();
        addTag();
        return;
      }
      // 축구 Q/W/E/R — 홈 골·홈 장면·원정 장면·원정 골.
      // 농구 Q/W/E(홈 1·2·3점) · A/S/D(원정 1·2·3점). 한글 자판에서도 같다.
      const kind = tagKinds.find((k) => (
        e.code === k.code || e.key === k.letter || e.key === k.letter.toUpperCase() || e.key === k.hangul
      ));
      if (kind) {
        e.preventDefault();
        addTag(kind.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekTo, addTag, offsets, activeIndex, tagKinds, plainHotkey]);

  // 추출이나 업로드 도중에 창을 닫으면 작업이 끊기고, 업로드 중이었다면 서버에
  // 클립이 일부만 올라간 잡이 남는다. 최소한 경고는 띄운다.
  useEffect(() => {
    if (!cutting && !publishing) return undefined;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [cutting, publishing]);

  const totalClipSeconds = tags.reduce((sum, tag) => sum + effBefore(tag) + effAfter(tag), 0);

  // 태그가 바뀌면 이미 뽑아둔 클립은 더 이상 맞지 않는다.
  useEffect(() => { setClips([]); setCutError(''); }, [tags, padBefore, padAfter]);

  const runCut = async () => {
    if (!sources.length || !tags.length || cutting) return;
    if (!clipTagCount) {
      // 전부 '점수만 반영' 이면 만들 장면이 없다. 점수판만으로는 영상이 되지 않는다.
      setCutError('클립이 될 태그가 없습니다. 점수만 반영하는 골 말고 장면 태그를 찍어 주세요.');
      return;
    }
    setCutting(true);
    setCutError('');
    setClips([]);
    try {
      // ffmpeg 코어는 처음 쓸 때만 받는다(31MB). 초기 번들에는 넣지 않는다.
      const { cutClipsLocally } = await import('../../../../lib/localCut');

      // 태그는 이어붙인 좌표지만 자르는 건 원본 파일 하나하나다. 태그마다 어느 원본인지
      // 찾아 그 안의 초로 되돌린다. 앞뒤 패딩이 원본 경계를 넘으면 그 원본 끝에서 자른다 —
      // 두 파일에 걸친 한 장면을 두 클립으로 쪼개면 합칠 때 그 사이에 크로스페이드가 끼어
      // 한 장면이 두 번 페이드되는 것처럼 보인다.
      const perSource: { start: number; end: number }[][] = sources.map(() => []);
      const placement: { src: number; pos: number }[] = [];
      // 이 클립이 tags 의 몇 번째 태그에서 나왔는지. 점수 계산과 종류를 되찾는 데 쓴다.
      const fromTag: number[] = [];
      let clamped = 0;
      for (let ti = 0; ti < tags.length; ti += 1) {
        const tag = tags[ti];
        // 점수만 반영하는 골은 장면을 넣지 않는다 — 점수판만 올린다.
        if (!makesClip(tag.kind)) continue;
        const { index, local } = locate(tag.t);
        const before = effBefore(tag);
        const after = effAfter(tag);
        const start = Math.max(0, local - before);
        const end = Math.min(sources[index].duration, local + after);
        if (start > local - before || end < local + after) clamped += 1;
        placement.push({ src: index, pos: perSource[index].length });
        fromTag.push(ti);
        perSource[index].push({ start, end });
      }
      setClipTagIndex(fromTag);

      // 원본별로 순서대로 자른다. 진행률은 전체 태그 수 기준으로 이어 붙인다.
      const cutBySource: CutClip[][] = [];
      let doneSoFar = 0;
      for (let i = 0; i < sources.length; i += 1) {
        if (!perSource[i].length) {
          cutBySource.push([]);
          continue;
        }
        const base = doneSoFar;
        const isLast = !sources.slice(i + 1).some((_, k) => perSource[i + 1 + k].length);
        // eslint-disable-next-line no-await-in-loop -- ffmpeg.wasm 인스턴스가 하나뿐이라 순차 처리해야 한다
        const madeHere = await cutClipsLocally(sources[i].file, perSource[i], (p) => {
          setCutProgress({
            done: base + p.done,
            total: clipTagCount,
            phase: p.phase === 'finished' && !isLast ? 'cutting' : p.phase,
          });
        });
        doneSoFar += perSource[i].length;
        cutBySource.push(madeHere);
      }

      // 업로드·합치기 순서는 index 로 정해진다. 원본별로 잘랐으니 여기서 이어붙인
      // 시간 순으로 번호를 다시 매긴다(tags 는 이미 시간순 정렬).
      const made = placement.map((at, n) => ({ ...cutBySource[at.src][at.pos], index: n + 1 }));
      setClips(made);
      if (clamped) {
        setCutError(`알림: ${clamped}개 클립은 원본 경계에 걸려 그 영상 끝(또는 처음)까지만 잘랐습니다.`);
      }
    } catch (err) {
      setCutError(err instanceof Error ? err.message : String(err));
    } finally {
      setCutting(false);
    }
  };

  const clipsTotalBytes = clips.reduce((sum, c) => sum + (c.blob?.size ?? 0), 0);

  const publish = async () => {
    if (!sources.length || !clips.length || publishing) return;
    setPublishing(true);
    setPublishError('');
    setDoneJobId('');
    setPublishPhase('uploading');
    setUploadProgress({ done: 0, total: clips.length });
    try {
      const { job_id: jobId } = await apiJson<{ job_id: string }>('/highlight/manual-jobs', {
        method: 'POST',
        body: JSON.stringify({
          source_filename: sources.length === 1
            ? sources[0].file.name
            : `${sources[0].file.name} 외 ${sources.length - 1}개`,
          // 결과물 목록을 종목별로 가르는 근거. 만들 때 새겨두지 않으면 나중에 알 길이 없다.
          sport,
        }),
      });

      // 병렬 업로드 — 클립을 하나씩 줄세우지 않고 여러 개를 동시에 올려 네트워크 왕복
      // 지연이 겹치게 한다(특히 서버가 멀 때 큼). 다만 서버(t3.medium)를 독점하지 않도록
      // 동시 4개로 제한한다. 파일명은 clip.index 로 고정돼 서버에서 이름이 겹치지 않는다.
      setPublishMsg(`클립 업로드 0 / ${clips.length}`);
      const UPLOAD_CONCURRENCY = 4;
      let uploaded = 0;
      let cursor = 0;
      const uploadOne = async (clip: CutClip) => {
        const form = new FormData();
        if (!clip.blob) throw new Error(`클립 ${clip.index} 데이터가 없습니다`);
        form.append('clip', clip.blob, `clip_${String(clip.index).padStart(3, '0')}.mp4`);
        form.append('requested_start', String(clip.requestedStart));
        form.append('requested_end', String(clip.requestedEnd));
        form.append('index', String(clip.index));
        // 점수판용. '점수만 반영' 태그는 클립이 되지 않으므로 clip.index 와 tags 의
        // 자리가 어긋난다 — 자를 때 남겨 둔 색인으로 되찾는다.
        const tagIdx = clipTagIndex[clip.index - 1];
        const tag = tagIdx === undefined ? undefined : tags[tagIdx];
        if (tag) {
          if (tag.kind) form.append('kind', tag.kind);
          // tag_offset 은 클립 시작에서 태깅 시점까지의 초 — 골이면 그 지점에서 점수가 오른다.
          form.append('tag_offset', String(Math.max(0, tag.t - clipRange(tag)[0])));
          // 이 클립이 시작·끝날 때의 점수. 클립을 만들지 않은 골까지 반영돼 있어서,
          // 서버가 kind 로 다시 쌓지 않고 이 값을 그대로 쓴다.
          const after = runningScores[tagIdx] ?? [scoreboard.startHome, scoreboard.startAway];
          const before = tagIdx > 0
            ? (runningScores[tagIdx - 1] ?? [scoreboard.startHome, scoreboard.startAway])
            : [scoreboard.startHome, scoreboard.startAway];
          form.append('score_before', `${before[0]}:${before[1]}`);
          form.append('score_after', `${after[0]}:${after[1]}`);
        }
        const res = await fetch(`${API_BASE}/highlight/manual-jobs/${jobId}/clips`, {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
        if (!res.ok) throw new Error(await res.text() || `클립 ${clip.index} 업로드 실패`);
        uploaded += 1;
        setUploadProgress({ done: uploaded, total: clips.length });
        setPublishMsg(`클립 업로드 ${uploaded} / ${clips.length}`);
      };
      // 워커 4개가 공용 커서에서 다음 클립을 집어 처리한다. 하나라도 실패하면
      // Promise.all 이 거부되어 바깥 try/catch 로 잡힌다.
      const runWorker = async () => {
        for (;;) {
          const i = cursor;
          cursor += 1;
          if (i >= clips.length) return;
          await uploadOne(clips[i]);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, clips.length) }, runWorker),
      );

      // 인트로 사진이 있으면 클립을 다 올린 뒤, 합치기 직전에 보낸다.
      if (introFile) {
        setPublishMsg('인트로 사진 업로드 중...');
        const introForm = new FormData();
        introForm.append('image', introFile, introFile.name);
        introForm.append('duration', String(introDuration));
        const introRes = await fetch(`${API_BASE}/highlight/manual-jobs/${jobId}/intro`, {
          method: 'POST',
          credentials: 'include',
          body: introForm,
        });
        if (!introRes.ok) throw new Error(await introRes.text() || '인트로 사진 업로드 실패');
      }

      // 여기서부터는 서버 몫 — 탭을 닫아도 합치기는 끝나고 "수동 결과물"에 뜬다.
      setPublishPhase('merging');
      setPublishMsg('서버에서 다듬고 합치는 중...');
      await apiJson(`/highlight/manual-jobs/${jobId}/merge`, {
        method: 'POST',
        body: JSON.stringify({
          scoreboard: scoreboard.enabled ? {
            enabled: true,
            home_name: scoreboard.homeName,
            away_name: scoreboard.awayName,
            home_color: scoreboard.homeColor,
            away_color: scoreboard.awayColor,
            start_home: scoreboard.startHome,
            start_away: scoreboard.startAway,
            size_pct: scoreboard.sizePct,
            pos_x: scoreboard.posX,
            pos_y: scoreboard.posY,
            // 대회 로고는 dataURL 그대로 보낸다 — 서버가 PNG 로 풀어 판 위에 얹는다.
            logo_url: scoreboard.logoUrl || '',
            // 판 위 로고의 크기(%). 100 이 시안 원본이다.
            logo_size_pct: scoreboard.logoSizePct,
          } : { enabled: false },
          // 합본 사이에 끼는 전체화면 카드. 시작 카드는 맨 앞, 구간 카드는 T 자리마다.
          // 카드에는 워터마크를 얹지 않는다 — 시안에 이미 로고가 들어 있어 서버가 뺀다.
          cards: cards.enabled ? {
            enabled: true,
            intro_duration_sec: cards.introDurationSec,
            section_duration_sec: cards.sectionDurationSec,
            template: cards.template,
            intro: {
              // 아무것도 안 채웠으면 시작 카드를 넣지 않는다 — 배경만 몇 초 나오는 건
              // 아무 뜻이 없다. 무엇이 '채운 것' 인지도 템플릿의 항목으로 센다.
              enabled: (cardTemplate?.start_fields ?? [])
                .some((spec) => (cardValues[spec.id] || '').trim()),
              values: cardValues,
              // 옮긴 자리만 실린다 — 서버가 시안 기본값과 비교해 한 번 더 거른다.
              boxes: cardBoxes,
            },
            // 자동으로 선 첫 구간까지 포함해 자리 순서대로 보낸다.
            outro: { enabled: cards.outro },
            sections: [AUTO_SECTION_ID, ...tags.filter((tag) => tag.kind === 'section').map((tag) => tag.id)]
              .map((id) => sectionPlan.get(id))
              .filter((entry): entry is { ordinal: number; label: string; beforeOrder: number } => Boolean(entry))
              .map((entry) => ({ before_order: entry.beforeOrder, label: entry.label })),
          } : { enabled: false },
          // 우리 로고 — 점수판과 따로 켜고 끈다. 영상 내내 같은 자리에 얹힌다.
          watermark: watermark.enabled ? {
            enabled: true,
            size_pct: watermark.sizePct,
            opacity: watermark.opacity,
            pos_x: watermark.posX,
            pos_y: watermark.posY,
          } : { enabled: false },
        }),
      });

      // 합치기는 재인코딩이라 몇 초 걸린다. 끝날 때까지 상태를 확인한다.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const job = await apiJson<JobStatus>(`/highlight/jobs/${jobId}`);
        if (job.status === 'done') {
          setDoneJobId(jobId);
          setPublishPhase('done');
          setPublishMsg('완료되었습니다.');
          break;
        }
        if (job.status === 'error') throw new Error(job.error_message || '합치기 실패');
        setPublishMsg(job.job_metadata?.progress?.detail || '처리 중...');
      }
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err));
      setPublishMsg('');
      setPublishPhase('idle');
    } finally {
      setPublishing(false);
    }
  };

  // 렌더 중에 createObjectURL 을 부르면 재생 중 timeupdate 마다 수 MB짜리 URL이 새로 생겨 샌다.
  // 클릭한 순간에만 만들고 해제한다.
  const downloadClip = async (clip: CutClip) => {
    if (previewBusy !== null) return;
    setPreviewBusy(clip.index);
    setCutError('');
    try {
      const { normalizeForPreview } = await import('../../../../lib/localCut');
      const normalized = await normalizeForPreview(clip.blob);
      const url = URL.createObjectURL(normalized);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clip_${String(clip.index).padStart(3, '0')}.mp4`;
      a.click();
      // 브라우저가 저장을 시작할 여유를 준 뒤 해제한다.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) {
      setCutError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewBusy(null);
    }
  };

  return (
    <div style={{ width: '100%' }}>
      <HighlightSubTabs />

      <div style={card}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 4 }}>수동 하이라이트 태깅</h2>
        <p style={{ fontSize: 13, color: 'var(--muted, #999)', marginTop: 0, marginBottom: 12 }}>
          영상을 업로드하지 않고 바로 재생합니다. 배속으로 넘겨보며 하이라이트 지점을 찍으면,
          이후 그 구간만 잘라 올립니다. 여러 개를 고르면 <strong>고른 순서대로 이어 붙여</strong>
          한 편처럼 재생·태깅하고, 합본도 그 순서로 나옵니다.
        </p>

        <input
          type="file"
          accept="video/*"
          multiple
          onChange={(e) => { void pickFiles(e.target.files); }}
          style={{ fontSize: 13 }}
        />
        {sources.length ? (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {sources.map((src, i) => (
              <div
                key={`${src.file.name}:${src.file.size}:${i}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
                  padding: '5px 9px', borderRadius: 6,
                  background: i === activeIndex ? 'var(--surface-input, #16161a)' : 'transparent',
                  border: `1px solid ${i === activeIndex ? 'var(--border-ghost, #3a3a42)' : 'transparent'}`,
                  color: 'var(--muted, #999)',
                }}
              >
                <span style={{ width: 18, color: 'var(--text, #eee)' }}>{i + 1}</span>
                <button
                  style={{ ...smallBtn, padding: '2px 8px' }}
                  onClick={() => seekTo(offsets[i])}
                  title="이 영상 처음으로 이동"
                >
                  ▶
                </button>
                <span style={{ color: 'var(--text, #eee)' }}>{src.file.name}</span>
                <span>{fmtBytes(src.file.size)} · {fmt(src.duration)}</span>
                {sources.length > 1 ? (
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    <button
                      style={{ ...smallBtn, padding: '2px 7px' }}
                      disabled={i === 0 || tags.length > 0}
                      title={tags.length ? '태그를 지운 뒤에 순서를 바꿀 수 있습니다 (태그 위치가 어긋납니다)' : '위로'}
                      onClick={() => moveSource(i, -1)}
                    >
                      ▲
                    </button>
                    <button
                      style={{ ...smallBtn, padding: '2px 7px' }}
                      disabled={i === sources.length - 1 || tags.length > 0}
                      title={tags.length ? '태그를 지운 뒤에 순서를 바꿀 수 있습니다 (태그 위치가 어긋납니다)' : '아래로'}
                      onClick={() => moveSource(i, 1)}
                    >
                      ▼
                    </button>
                  </span>
                ) : null}
              </div>
            ))}
            {sources.length > 1 ? (
              <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '4px 0 0' }}>
                총 {sources.length}개 · {fmt(duration)} — 위 순서대로 이어 붙여 다룹니다.
              </p>
            ) : null}
          </div>
        ) : null}

        {unsupported ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 8,
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.4)',
              fontSize: 13,
            }}
          >
            이 브라우저가 열 수 없는 코덱입니다 (HEVC 등으로 추정). 서버 변환이 필요하니
            <strong> Player Clips </strong> 탭의 기존 업로드 방식을 사용하세요.
          </div>
        ) : null}

        {status ? (
          <p style={{ fontSize: 12, color: 'var(--accent, #3b82f6)', margin: '8px 0 0' }}>{status}</p>
        ) : null}
      </div>

      {videoUrl && !unsupported ? (
        <>
          <div style={card}>
            <video
              ref={videoRef}
              src={videoUrl}
              style={{ width: '100%', maxHeight: '60vh', background: '#000', borderRadius: 8 }}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                v.playbackRate = speed;
                // 원본을 갈아끼운 직후에만 위치를 옮긴다(seekTo·자동 전환에서 예약해 둔 값).
                const at = pendingSeekRef.current;
                pendingSeekRef.current = null;
                if (at !== null) v.currentTime = at;
                if (resumeRef.current) {
                  resumeRef.current = false;
                  void v.play();
                }
              }}
              onError={() => setUnsupported(true)}
              // 재생 위치는 이어붙인 좌표로 환산해 둔다 — 태그도 타임라인도 이 좌표를 쓴다.
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                const at = (offsets[activeIndex] ?? 0) + v.currentTime;
                setCurrent(at);
                // 태그로 시작한 미리보기면 클립 끝에서 멈춘다.
                if (previewEndRef.current !== null && at >= previewEndRef.current) {
                  previewEndRef.current = null;
                  v.pause();
                }
              }}
              onEnded={() => {
                // 태그 미리보기 중이면 그 클립까지만 보여주고 멈춘다.
                if (previewEndRef.current !== null) {
                  previewEndRef.current = null;
                  return;
                }
                // 마지막이 아니면 다음 원본을 이어서 재생한다 — 한 편처럼 보이게.
                if (activeIndex + 1 >= sources.length) return;
                pendingSeekRef.current = 0;
                resumeRef.current = true;
                setActiveIndex(activeIndex + 1);
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              controls
            />

            {/* 타임라인 — 찍은 지점을 한눈에 보고 클릭해서 이동 */}
            <div
              style={{
                position: 'relative',
                height: 26,
                marginTop: 10,
                background: 'var(--border-ghost, #2c2c32)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
              onClick={(e) => {
                if (!duration) return;
                const rect = e.currentTarget.getBoundingClientRect();
                seekTo(((e.clientX - rect.left) / rect.width) * duration);
              }}
            >
              {/* 원본 경계 — 어디서 다음 영상으로 넘어가는지 눈에 보이게 */}
              {duration && sources.length > 1
                ? offsets.slice(1).map((off, i) => (
                    <div
                      key={`boundary-${i}`}
                      title={`${i + 2}번째 영상 시작 (${fmt(off)})`}
                      style={{
                        position: 'absolute',
                        left: `${(off / duration) * 100}%`,
                        top: 0,
                        bottom: 0,
                        width: 1,
                        background: 'var(--muted, #999)',
                      }}
                    />
                  ))
                : null}
              {duration ? (
                <div
                  style={{
                    position: 'absolute',
                    left: `${(current / duration) * 100}%`,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    background: 'var(--text, #eee)',
                  }}
                />
              ) : null}
              {duration
                ? tags.map((tag) => (
                    <div
                      key={tag.id}
                      title={fmt(tag.t)}
                      style={{
                        position: 'absolute',
                        left: `${(tag.t / duration) * 100}%`,
                        top: 3,
                        bottom: 3,
                        width: 3,
                        marginLeft: -1,
                        background: 'var(--accent, #3b82f6)',
                        borderRadius: 2,
                      }}
                    />
                  ))
                : null}
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
              <button style={btn} onClick={togglePlay}>{playing ? '⏸ 정지' : '▶ 재생'}</button>
              {/* onClick 에 addTag 를 그대로 물리면 MouseEvent 가 kind 로 넘어간다. 반드시 감싼다. */}
              <button style={primaryBtn} onClick={() => addTag()}>
                ＋ 태깅 ({plainHotkey.label} / {plainHotkey.hangul})
              </button>
              {tagKinds.map((kind) => (
                <button
                  key={kind.key}
                  style={{ ...smallBtn, padding: '8px 12px', borderColor: kind.color }}
                  title={`${kind.label} — ${kind.letter.toUpperCase()} (한글 ${kind.hangul})`}
                  onClick={() => addTag(kind.key)}
                >
                  <span style={{ color: kind.color, fontWeight: 700 }}>{kind.letter.toUpperCase()}</span>
                  {' '}{kind.label}
                </button>
              ))}

              <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 6 }}>
                배속
                <select
                  value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  style={{ ...smallBtn, padding: '4px 6px' }}
                >
                  {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
                </select>
              </label>

              <span style={{ fontSize: 13, color: 'var(--muted, #999)', marginLeft: 'auto' }}>
                {sources.length > 1 ? `${activeIndex + 1}/${sources.length}번째 · ` : ''}
                {fmt(current)} / {fmt(duration)}
              </span>
            </div>

            <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '10px 0 0' }}>
              단축키 — <strong>Space</strong> 재생·정지 · <strong>←/→</strong> {SEEK_STEP}초 이동
              {' · '}
              <strong>{plainHotkey.label}</strong> 일반 태깅
              {/* 종류 키는 지금 스포츠의 세트를 그대로 읽는다 — 목록과 안내가 어긋날 수 없다. */}
              {tagKinds.map((kind) => (
                <span key={kind.key}>
                  {' · '}
                  <strong>{kind.letter.toUpperCase()}</strong>({kind.hangul}) {kind.label}
                </span>
              ))}
            </p>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>태그 {tags.length}개</h3>
              <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 4 }}>
                앞
                <input
                  type="number" min={0} max={30} style={numInput}
                  value={padBefore}
                  onChange={(e) => setPadBefore(Math.max(0, Number(e.target.value) || 0))}
                />
                초
              </label>
              <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 4 }}>
                뒤
                <input
                  type="number" min={0} max={30} style={numInput}
                  value={padAfter}
                  onChange={(e) => setPadAfter(Math.max(0, Number(e.target.value) || 0))}
                />
                초
              </label>
              {tags.length ? (
                <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                  예상 합본 길이 약 {fmt(totalClipSeconds)}
                </span>
              ) : null}
              {tags.length ? (
                <button style={{ ...smallBtn, marginLeft: 'auto' }} onClick={() => setTags([])}>전체 삭제</button>
              ) : null}
            </div>

            {/* 카드 — 합본 사이에 끼는 전체화면 한 장.
                [시작 카드] 클립들 [구간 카드] 클립들 … 순으로 나간다. 점수판·워터마크와
                달리 영상 위에 얹는 게 아니라 영상 사이에 들어간다. */}
            <div
              style={{
                marginBottom: 14, padding: 12, borderRadius: 8,
                background: 'var(--surface-input, #16161a)',
                border: '1px solid var(--border-ghost, #2c2c32)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={cards.enabled}
                    onChange={(e) => setCards((p) => ({ ...p, enabled: e.target.checked }))}
                  />
                  카드 넣기
                </label>
                <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                  {cards.enabled
                    ? `맨 앞에 시작 카드, T(ㅅ)로 찍은 자리마다 ${
                      sectionCount ? `구간 카드 ${sectionCount}장` : '구간 카드'}가 들어갑니다.`
                    : '영상 사이에 시작 정보·구간 카드를 넣습니다.'}
                </span>
                {cards.enabled && cardTemplates.length ? (
                  <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    템플릿
                    <select
                      value={cards.template}
                      onChange={(e) => setCards((p) => ({ ...p, template: e.target.value }))}
                      style={{ ...smallBtn, padding: '3px 6px', fontSize: 12 }}
                    >
                      {cardTemplates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {cards.enabled ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
                    {([
                      ['시작 카드', 'introDurationSec'],
                      ['구간 카드', 'sectionDurationSec'],
                    ] as const).map(([label, key]) => (
                      <label
                        key={key}
                        style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        {label}
                        <input
                          type="number" min={0.5} max={15} step={0.5} style={numInput}
                          value={cards[key]}
                          onChange={(e) => setCards((p) => ({
                            ...p,
                            [key]: Math.min(15, Math.max(0.5, Number(e.target.value) || CARD_SEC_DEFAULT)),
                          }))}
                        />
                        초
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>

              {cards.enabled ? (
                <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {/* 칸은 템플릿이 알려준 항목으로 만든다 — 대회마다 고칠 수 있는 게
                      다르므로 여기 박아 두면 템플릿을 들일 때마다 화면을 고쳐야 한다. */}
                  {(cardTemplate?.start_fields ?? []).map((spec) => (
                    <label
                      key={spec.id}
                      style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      {spec.label}
                      {spec.kind === 'logo' ? (
                        <>
                          <input
                            type="file"
                            accept="image/*"
                            style={{ fontSize: 11, width: 150 }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              void readLogoDataUrl(file)
                                .then((url) => setCardValue(spec.id, url))
                                .catch(() => setStatus('로고를 읽지 못했습니다.'));
                            }}
                          />
                          {cardValues[spec.id] ? (
                            <button
                              style={{ ...smallBtn, padding: '2px 8px' }}
                              onClick={() => setCardValue(spec.id, '')}
                            >
                              빼기
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <input
                          value={cardValues[spec.id] ?? ''}
                          placeholder={spec.placeholder}
                          maxLength={spec.max_len}
                          onChange={(e) => setCardValue(spec.id, e.target.value)}
                          style={{
                            ...numInput, width: spec.ui_width, padding: '4px 8px',
                            fontSize: 12, textAlign: 'left',
                          }}
                        />
                      )}
                      {/* 자리 — 시안 좌표(왼쪽 위 모서리). 지금 값이 기본으로 들어가
                          있고, 고치면 미리보기가 바로 따라온다. 크기는 템플릿이
                          정한 대로 둔다(글자 크기·줄바꿈 폭이 거기 매여 있다). */}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: 0.85 }}>
                        <span style={{ fontSize: 11 }}>X</span>
                        <input
                          type="number"
                          step={1}
                          value={Math.round(boxOf(spec).x)}
                          onChange={(e) => setCardBox(spec, 'x', Number(e.target.value))}
                          style={{ ...numInput, width: 62, padding: '4px 6px', fontSize: 12 }}
                        />
                        <span style={{ fontSize: 11 }}>Y</span>
                        <input
                          type="number"
                          step={1}
                          value={Math.round(boxOf(spec).y)}
                          onChange={(e) => setCardBox(spec, 'y', Number(e.target.value))}
                          style={{ ...numInput, width: 62, padding: '4px 6px', fontSize: 12 }}
                        />
                        {/* 로고만 크기를 준다. 글자는 글꼴이 크기를 정해서, 상자만
                            늘리면 줄바꿈 폭만 바뀌고 글자는 그대로다.
                            크기는 **가운데를 붙잡고** 늘어난다 — 키울 때마다 오른쪽
                            아래로 흘러내리면 자리를 매번 다시 잡아야 한다. */}
                        {spec.scalable ? (
                          <>
                            <span style={{ fontSize: 11 }}>크기</span>
                            <input
                              type="number"
                              step={5}
                              min={20}
                              max={300}
                              value={Math.round(scaleOf(spec))}
                              onChange={(e) => setCardBox(spec, 'scale', Number(e.target.value))}
                              style={{ ...numInput, width: 58, padding: '4px 6px', fontSize: 12 }}
                            />
                            <span style={{ fontSize: 11 }}>%</span>
                          </>
                        ) : null}
                      </span>
                    </label>
                  ))}

                  {/* 옮긴 게 있을 때만 되돌리기를 띄운다 — 늘 있으면 눈에 걸린다. */}
                  {cardBoxesMoved ? (
                    <button style={{ ...smallBtn, alignSelf: 'center' }} onClick={resetCardBoxes}>
                      위치 되돌리기
                    </button>
                  ) : null}

                  {/* 첫 구간 이름만 템플릿 밖이다 — 카드에 그릴 값이 아니라 '몇 번째
                      구간부터 세느냐' 라서, 템플릿이 바뀌어도 그대로 쓴다. */}
                  {/* 마무리 카드 — 파인플레이 로고 영상. 내장이라 고를 게 없고 켜고 끄기만 한다. */}
                  <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={cards.outro}
                      onChange={(e) => setCards((p) => ({ ...p, outro: e.target.checked }))}
                    />
                    마무리 카드 (파인플레이 로고 2초)
                  </label>

                  <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    첫 구간
                    <input
                      value={cards.firstSectionLabel}
                      placeholder={sectionNameAt(sport, 0)}
                      maxLength={20}
                      onChange={(e) => setCards((p) => ({ ...p, firstSectionLabel: e.target.value }))}
                      style={{ ...numInput, width: 120, padding: '4px 8px', fontSize: 12, textAlign: 'left' }}
                    />
                  </label>

                  <p style={{ width: '100%', margin: 0, fontSize: 12, color: 'var(--muted, #999)' }}>
                    {cardTemplate?.note ? `${cardTemplate.note} ` : ''}
                    첫 구간({sectionNameAt(sport, 0)}) 카드는 시작 카드 바로 뒤에 <strong>자동으로</strong> 들어가므로,
                    T 는 그 다음 구간부터 찍으면 됩니다. 구간 이름은 아래 목록에서 바로 고칠 수 있습니다.
                  </p>

                  {/* 미리보기 — 서버가 합칠 때와 같은 코드로 그려 준다. */}
                  <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>미리보기</span>
                      <button
                        style={cardPreviewOf === 'start'
                          ? { ...smallBtn, color: 'var(--text, #eee)', borderColor: SECTION_TAG_KIND.color }
                          : smallBtn}
                        onClick={() => setCardPreviewOf('start')}
                      >
                        시작 카드
                      </button>
                      {tags.filter((tag) => tag.kind === 'section').map((tag) => {
                        const entry = sectionPlan.get(tag.id);
                        if (!entry) return null;
                        return (
                          <button
                            key={tag.id}
                            style={cardPreviewOf === tag.id
                              ? { ...smallBtn, color: 'var(--text, #eee)', borderColor: SECTION_TAG_KIND.color }
                              : smallBtn}
                            onClick={() => setCardPreviewOf(tag.id)}
                          >
                            {entry.label}
                          </button>
                        );
                      })}
                      {cardPreviewBusy ? (
                        <span style={{ fontSize: 11, color: 'var(--muted, #999)' }}>그리는 중…</span>
                      ) : null}
                    </div>
                    {cardPreviewError ? (
                      <p style={{ margin: 0, fontSize: 12, color: '#f87171' }}>{cardPreviewError}</p>
                    ) : null}
                    {cardPreviewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 서버가 방금 그려 준 blob 이라 최적화 대상이 아니다
                      <img
                        src={cardPreviewUrl}
                        alt="카드 미리보기"
                        style={{
                          width: '100%', maxWidth: 520, borderRadius: 8, display: 'block',
                          border: '1px solid var(--border-ghost, #2c2c32)',
                          opacity: cardPreviewBusy ? 0.6 : 1,
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: '100%', maxWidth: 520, aspectRatio: '16 / 9', borderRadius: 8,
                          border: '1px dashed var(--border-ghost, #2c2c32)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, color: 'var(--muted, #999)',
                        }}
                      >
                        {cardPreviewBusy ? '그리는 중…' : '미리보기를 불러오는 중'}
                      </div>
                    )}
                    <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--muted, #999)' }}>
                      합본에 들어갈 그림 그대로입니다 — 서버가 합칠 때 쓰는 코드로 그립니다.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            {/* 점수판 — 합칠 때 서버가 영상 좌상단에 새긴다. 골 태그를 찍은 그 시점에 점수가 올라간다. */}
            <div
              style={{
                marginBottom: 14, padding: 12, borderRadius: 8,
                background: 'var(--surface-input, #16161a)',
                border: '1px solid var(--border-ghost, #2c2c32)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={scoreboard.enabled}
                    onChange={(e) => setScoreboard((p) => ({ ...p, enabled: e.target.checked }))}
                  />
                  점수판 새기기
                </label>
                <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                  {scoreboard.enabled
                    ? `골 태그(Q·R)를 찍은 순간 점수가 올라갑니다 — 최종 ${finalScore[0]} : ${finalScore[1]}`
                    : '영상 왼쪽 위에 팀명과 점수를 새깁니다.'}
                </span>

                <span style={{ width: 1, height: 16, background: 'var(--border-ghost, #2c2c32)' }} />

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={watermark.enabled}
                    onChange={(e) => setWatermark((p) => ({ ...p, enabled: e.target.checked }))}
                  />
                  우리 로고
                </label>
                {watermark.enabled ? (
                  <>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted, #999)' }}>투명도</span>
                      <input
                        type="range"
                        min={5}
                        max={100}
                        step={5}
                        value={Math.round(watermark.opacity * 100)}
                        onChange={(e) => setWatermark((p) => ({ ...p, opacity: Number(e.target.value) / 100 }))}
                        style={{ width: 110 }}
                      />
                      <span style={{ color: 'var(--muted, #999)', width: 34 }}>
                        {Math.round(watermark.opacity * 100)}%
                      </span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted, #999)' }}>크기</span>
                      <input
                        type="number"
                        min={1}
                        max={25}
                        step={0.5}
                        value={watermark.sizePct}
                        onChange={(e) => setWatermark((p) => ({
                          ...p,
                          sizePct: Math.max(1, Math.min(25, Number(e.target.value) || 1)),
                        }))}
                        style={{ ...numInput, width: 60 }}
                      />
                      <span style={{ color: 'var(--muted, #999)' }}>%</span>
                    </label>
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                    영상 오른쪽 위에 우리 로고를 옅게 새깁니다.
                  </span>
                )}
              </div>

              {scoreboard.enabled ? (
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {([
                      ['home', '홈', scoreboard.homeName, scoreboard.homeColor, scoreboard.startHome],
                      ['away', '원정', scoreboard.awayName, scoreboard.awayColor, scoreboard.startAway],
                    ] as const).map(([side, label, nameValue, colorValue, startValue]) => (
                      <div key={side} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, color: 'var(--muted, #999)', width: 32 }}>{label}</span>
                        <input
                          type="text"
                          maxLength={20}
                          placeholder={side === 'home' ? 'HOME' : 'AWAY'}
                          value={nameValue}
                          onChange={(e) => setScoreboard((p) => (
                            side === 'home'
                              ? { ...p, homeName: e.target.value }
                              : { ...p, awayName: e.target.value }
                          ))}
                          style={{ ...numInput, width: 150 }}
                        />
                        <input
                          type="color"
                          value={colorValue}
                          title={`${label} 팀 색`}
                          onChange={(e) => setScoreboard((p) => (
                            side === 'home'
                              ? { ...p, homeColor: e.target.value }
                              : { ...p, awayColor: e.target.value }
                          ))}
                          style={{ width: 34, height: 28, padding: 0, border: '1px solid var(--border-ghost, #3a3a42)', borderRadius: 6, background: 'transparent' }}
                        />
                        {/* 후반만 태깅하는 경우처럼 0-0 에서 시작하지 않을 때 쓴다. */}
                        <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          시작 점수
                          <input
                            type="number" min={0} max={99}
                            value={startValue}
                            onChange={(e) => {
                              const n = Math.max(0, Math.min(99, Number(e.target.value) || 0));
                              setScoreboard((p) => (side === 'home' ? { ...p, startHome: n } : { ...p, startAway: n }));
                            }}
                            style={{ ...numInput, width: 52 }}
                          />
                        </label>
                      </div>
                    ))}
                    <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      크기
                      <input
                        type="range" min={14} max={45} step={1}
                        value={scoreboard.sizePct}
                        onChange={(e) => setScoreboard((p) => ({ ...p, sizePct: Number(e.target.value) }))}
                        style={{ width: 140 }}
                      />
                      화면 가로의 {scoreboard.sizePct}%
                    </label>
                    {/* 대회 로고 — 판 위쪽 가운데에 절반 걸쳐 올라간다. 안 넣으면 안 그린다.
                        dataURL 로 들고 있다가 합치기 요청에 그대로 실어 보낸다. */}
                    <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      로고
                      <input
                        type="file"
                        accept="image/*"
                        style={{ fontSize: 11, width: 190 }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          void readLogoDataUrl(file)
                            .then((url) => setScoreboard((p) => ({ ...p, logoUrl: url })))
                            .catch(() => setStatus('로고를 읽지 못했습니다.'));
                        }}
                      />
                      {scoreboard.logoUrl ? (
                        <button
                          style={{ ...smallBtn, padding: '2px 8px' }}
                          onClick={() => setScoreboard((p) => ({ ...p, logoUrl: '' }))}
                        >
                          로고 빼기
                        </button>
                      ) : null}
                    </label>
                    {/* 로고 크기 — 판 폭에 비례한다. 100% 가 시안 원본이고, 키우면
                        판 위로 더 올라간다(늘 절반이 걸친 모양은 그대로). */}
                    {scoreboard.logoUrl ? (
                      <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        로고 크기
                        <input
                          type="range"
                          min={LOGO_SIZE_RANGE[0]}
                          max={LOGO_SIZE_RANGE[1]}
                          step={5}
                          value={scoreboard.logoSizePct}
                          onChange={(e) => setScoreboard((p) => ({ ...p, logoSizePct: Number(e.target.value) }))}
                          style={{ width: 120 }}
                        />
                        {scoreboard.logoSizePct}%
                        {scoreboard.logoSizePct !== 100 ? (
                          <button
                            style={{ ...smallBtn, padding: '2px 8px' }}
                            onClick={() => setScoreboard((p) => ({ ...p, logoSizePct: 100 }))}
                          >
                            기본
                          </button>
                        ) : null}
                      </label>
                    ) : null}
                  </div>

                  <div>
                    {/* 프레임 안 점수판은 실제 비율이라 작다. 글자·색 확인용으로 크게도 보여준다. */}
                    <ScoreboardPreview config={scoreboard} home={finalScore[0]} away={finalScore[1]} />
                    <p style={{ fontSize: 11, color: 'var(--muted, #999)', margin: '6px 0 10px' }}>
                      새겨질 점수판 (최종 점수 기준)
                    </p>
                    <OverlayPlacer
                      videoW={boardVideo.w}
                      videoH={boardVideo.h}
                      frameUrl={frameUrl}
                      selected={activeOverlay}
                      onSelect={setActiveOverlay}
                      items={[
                        {
                          key: 'board' as const,
                          label: '점수판',
                          place: boardPlacement(
                            boardVideo.w, boardVideo.h,
                            scoreboard.sizePct, scoreboard.posX, scoreboard.posY,
                            Boolean(scoreboard.logoUrl), scoreboard.logoSizePct,
                          ),
                          recompute: (pct: number) => boardPlacement(
                            boardVideo.w, boardVideo.h, pct, 0, 0,
                            Boolean(scoreboard.logoUrl), scoreboard.logoSizePct,
                          ),
                          sizePct: scoreboard.sizePct,
                          sizeRange: [10, 60] as [number, number],
                          onMove: (posX: number, posY: number) => setScoreboard((p) => ({ ...p, posX, posY })),
                          onResize: (sizePct: number, posX: number, posY: number) =>
                            setScoreboard((p) => ({ ...p, sizePct, posX, posY })),
                          render: (width: number) => (
                            <ScoreboardPreview
                              config={scoreboard}
                              home={finalScore[0]}
                              away={finalScore[1]}
                              width={width}
                            />
                          ),
                        },
                        ...(watermark.enabled ? [{
                          key: 'mark' as const,
                          label: '로고',
                          place: markPlacement(
                            boardVideo.w, boardVideo.h,
                            watermark.sizePct, watermark.posX, watermark.posY,
                          ),
                          recompute: (pct: number) => markPlacement(boardVideo.w, boardVideo.h, pct, 0, 0),
                          sizePct: watermark.sizePct,
                          sizeRange: [1, 25] as [number, number],
                          onMove: (posX: number, posY: number) => setWatermark((p) => ({ ...p, posX, posY })),
                          onResize: (sizePct: number, posX: number, posY: number) =>
                            setWatermark((p) => ({ ...p, sizePct, posX, posY })),
                          render: (width: number) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={MARK_SRC}
                              alt="로고"
                              draggable={false}
                              style={{ width, height: width * MARK_RATIO, opacity: watermark.opacity, display: 'block' }}
                            />
                          ),
                        }] : []),
                      ]}
                    />
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 8, flexWrap: 'wrap' }}>
                      {/* 9칸 프리셋 — 모서리·가운데는 끌지 않고 한 번에 맞춘다. */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 22px)', gap: 3 }}>
                        {POS_PRESETS.map((preset) => {
                          const on = scoreboard.posX === preset.x && scoreboard.posY === preset.y;
                          return (
                            <button
                              key={preset.label}
                              title={preset.label}
                              onClick={() => setScoreboard((p) => ({ ...p, posX: preset.x, posY: preset.y }))}
                              style={{
                                width: 22, height: 16, padding: 0, cursor: 'pointer',
                                borderRadius: 3,
                                border: `1px solid ${on ? 'var(--accent, #3b82f6)' : 'var(--border-ghost, #3a3a42)'}`,
                                background: on ? 'var(--accent, #3b82f6)' : 'var(--button-dark, #2a2a30)',
                              }}
                            />
                          );
                        })}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted, #999)', flex: 1, minWidth: 180 }}>
                        점수판을 <strong>끌어서</strong> 옮기거나 왼쪽 9칸으로 맞추세요.
                        모서리·정중앙 근처에서는 딱 붙습니다. 최종 점수 기준으로 그려집니다.
                        <div style={{ marginTop: 4 }}>가로 {scoreboard.posX}% · 세로 {scoreboard.posY}%</div>
                      </div>
                      <button style={smallBtn} onClick={captureFrame} title="지금 보이는 장면을 배경으로 담습니다">
                        현재 화면 담기
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {tags.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted, #999)', margin: 0 }}>
                아직 태그가 없습니다. 재생하며 하이라이트 지점에서 <strong>S</strong>(일반)나
                {' '}<strong>Q·W·E·R</strong>(홈 골·홈 장면·원정 장면·원정 골)을 누르세요.
              </p>
            ) : (
              <>
              <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '0 0 10px' }}>
                태그와 패딩은 자동 저장됩니다. 다른 페이지에 다녀와도 같은 파일을 다시 고르면 복원되지만,
                추출해둔 클립은 남지 않아 다시 뽑아야 합니다.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {tags.map((tag, i) => {
                  const overridden = tag.before !== undefined || tag.after !== undefined;
                  const padCell: React.CSSProperties = {
                    ...numInput, width: 46, padding: '3px 5px', fontSize: 12,
                  };
                  const previewing = tag.id === previewTagId;
                  return (
                    <div
                      key={tag.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 10px', borderRadius: 6,
                        // 눌러서 재생한 줄 — 영상을 보다 돌아왔을 때 어디였는지 알 수 있게.
                        background: previewing
                          ? 'rgba(59,130,246,0.14)'
                          : 'var(--surface-input, #16161a)',
                        boxShadow: previewing
                          ? 'inset 3px 0 0 var(--accent, #3b82f6)'
                          : undefined,
                        fontSize: 13, flexWrap: 'wrap',
                      }}
                    >
                      <span style={{ color: 'var(--muted, #999)', width: 28 }}>{i + 1}</span>
                      {/* 이 태그로 어떤 클립이 나오는지 그대로 보여준다 — 클립 시작부터 재생하고 끝에서 멈춘다. */}
                      <button
                        style={previewing
                          ? { ...smallBtn, color: 'var(--accent, #3b82f6)', borderColor: 'var(--accent, #3b82f6)' }
                          : smallBtn}
                        title={`이 클립만 재생 (${fmt(clipRange(tag)[0])} ~ ${fmt(clipRange(tag)[1])}) — 태깅 시점은 ${fmt(tag.t)}`}
                        onClick={() => playTagClip(tag)}
                      >
                        ▶ {fmt(tag.t)}
                      </button>
                      {sources.length > 1 ? (
                        // 이어붙인 좌표만 보면 원본 어디인지 알 수 없다. 파일 안 위치도 같이 보여준다.
                        <span style={{ fontSize: 11, color: 'var(--muted, #999)' }}>
                          {locate(tag.t).index + 1}번 {fmt(locate(tag.t).local)}
                        </span>
                      ) : null}

                      {/* 태그 종류. 골로 바꾸면 이 시점부터 점수판 점수가 올라간다. */}
                      <select
                        value={tag.kind ?? ''}
                        onChange={(e) => setTagKind(tag.id, (e.target.value || undefined) as TagKind | undefined)}
                        style={{
                          ...smallBtn, padding: '3px 6px', fontSize: 12,
                          borderColor: (tag.kind && KIND_BY_KEY.get(tag.kind)?.color) || 'var(--border-ghost, #3a3a42)',
                        }}
                      >
                        <option value="">일반</option>
                        {tagKinds.map((kind) => (
                          <option key={kind.key} value={kind.key}>{kind.label}</option>
                        ))}
                      </select>
                      {/* 구간 태그는 클립이 아니라 '카드 한 장'이다. 그 카드에 찍힐
                          이름을 여기서 바로 고친다 — 비우면 순서대로 붙는 기본 이름. */}
                      {tag.kind === 'section' ? (
                        <input
                          value={tag.label ?? ''}
                          placeholder={sectionNameAt(sport, sectionPlan.get(tag.id)?.ordinal ?? 0)}
                          onChange={(e) => setTagLabel(tag.id, e.target.value)}
                          maxLength={20}
                          title="이 자리에 세울 카드에 찍힐 이름"
                          style={{
                            ...numInput, width: 104, padding: '3px 6px', fontSize: 12,
                            textAlign: 'center', borderColor: SECTION_TAG_KIND.color,
                          }}
                        />
                      ) : null}
                      {scoreboard.enabled && tag.kind !== 'section' ? (
                        <span
                          style={{
                            fontSize: 12, fontVariantNumeric: 'tabular-nums',
                            color: tag.kind && KIND_BY_KEY.get(tag.kind)?.goal ? '#eee' : 'var(--muted, #999)',
                            fontWeight: tag.kind && KIND_BY_KEY.get(tag.kind)?.goal ? 700 : 400,
                          }}
                          title="이 클립이 끝난 시점의 점수"
                        >
                          {runningScores[i][0]} : {runningScores[i][1]}
                        </span>
                      ) : null}

                      <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 3 }}>
                        앞
                        <input
                          type="number" min={0} max={60} style={padCell}
                          value={tag.before ?? ''} placeholder={String(padBefore)}
                          onChange={(e) => updateTagPad(
                            tag.id, 'before',
                            e.target.value === '' ? undefined : Math.max(0, Number(e.target.value) || 0),
                          )}
                        />
                      </label>
                      <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'flex', alignItems: 'center', gap: 3 }}>
                        뒤
                        <input
                          type="number" min={0} max={60} style={padCell}
                          value={tag.after ?? ''} placeholder={String(padAfter)}
                          onChange={(e) => updateTagPad(
                            tag.id, 'after',
                            e.target.value === '' ? undefined : Math.max(0, Number(e.target.value) || 0),
                          )}
                        />
                      </label>

                      {/* 클립 구간을 직접 고친다. 앞/뒤 칸이 '시점 고정, 길이 조절' 이라면
                          이쪽은 '구간 고정, 시점은 80% 자리로 따라감' 이다(setTagRange). */}
                      {(() => {
                        const [clipStart, clipEnd] = clipRange(tag);
                        const timeCell: React.CSSProperties = {
                          ...numInput, width: 58, padding: '3px 5px', fontSize: 12,
                          textAlign: 'center', fontVariantNumeric: 'tabular-nums',
                        };
                        const box = (field: 'start' | 'end', value: number) => {
                          const key = `${tag.id}:${field}`;
                          return (
                            <input
                              type="text"
                              inputMode="numeric"
                              style={timeCell}
                              title={field === 'start' ? '클립 시작 (m:ss)' : '클립 끝 (m:ss)'}
                              value={rangeDraft?.key === key ? rangeDraft.text : fmt(value)}
                              onChange={(e) => setRangeDraft({ key, text: e.target.value })}
                              onFocus={(e) => e.currentTarget.select()}
                              onBlur={() => commitRange(tag, field)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                                if (e.key === 'Escape') { setRangeDraft(null); e.currentTarget.blur(); }
                              }}
                            />
                          );
                        };
                        return (
                          <span style={{
                            color: overridden ? 'var(--accent, #3b82f6)' : 'var(--muted, #999)',
                            fontSize: 12, display: 'flex', alignItems: 'center', gap: 4,
                          }}>
                            클립 {box('start', clipStart)} ~ {box('end', clipEnd)}
                            {overridden ? ' ·개별' : ''}
                          </span>
                        );
                      })()}

                      {overridden ? (
                        <button
                          style={smallBtn}
                          title="전역 기본값으로 되돌리기"
                          onClick={() => setTags((prev) => prev.map((p) =>
                            p.id === tag.id ? { id: p.id, t: p.t } : p))}
                        >
                          ↺ 기본
                        </button>
                      ) : null}

                      <button
                        style={{ ...smallBtn, marginLeft: 'auto' }}
                        onClick={() => removeTag(tag.id)}
                      >
                        삭제
                      </button>
                    </div>
                  );
                })}
              </div>
              </>
            )}
          </div>

          {tags.length ? (
            <div style={card}>
              <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>클립 추출</h3>
              <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '0 0 12px' }}>
                재인코딩 없이 잘라내므로 빠릅니다. 키프레임 위치 때문에 클립이 요청 구간보다
                조금 길게 나오고, 정확한 다듬기는 서버가 합칠 때 처리합니다.
              </p>

              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button style={primaryBtn} onClick={runCut} disabled={cutting}>
                  {cutting ? '추출 중...' : `✂ 클립 ${clipTagCount}개 추출`}
                </button>
                {!cutting && clips.length ? (
                  <span style={{ fontSize: 13, color: '#22c55e' }}>
                    클립 {clips.length}개 · 총 {fmtBytes(clipsTotalBytes)} — 업로드 준비 완료
                  </span>
                ) : null}
              </div>

              {cutting && cutProgress ? (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>1. 클립 추출 (브라우저)</span>
                    <LeaveBadge canLeave={false} />
                    <span style={{ fontSize: 12, color: 'var(--muted, #999)', marginLeft: 'auto' }}>
                      {cutProgress.phase === 'loading'
                        ? 'ffmpeg 준비 중 (최초 1회 31MB)'
                        : `${cutProgress.done} / ${cutProgress.total}`}
                    </span>
                  </div>
                  <ProgressBar
                    percent={cutProgress.total ? (cutProgress.done / cutProgress.total) * 100 : 0}
                    indeterminate={cutProgress.phase === 'loading'}
                  />
                </div>
              ) : null}

              {cutError ? (
                <div
                  style={{
                    marginTop: 12, padding: 12, borderRadius: 8, fontSize: 13,
                    background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
                  }}
                >
                  추출 실패: {cutError}
                </div>
              ) : null}

              {clips.length ? (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {clips.map((clip) => (
                    <div
                      key={clip.index}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                        padding: '6px 10px', borderRadius: 6, background: 'var(--surface-input, #16161a)',
                      }}
                    >
                      <span style={{ color: 'var(--muted, #999)', width: 28 }}>{clip.index}</span>
                      <span>{fmt(clip.requestedStart)} ~ {fmt(clip.requestedEnd)}</span>
                      <span style={{ color: 'var(--muted, #999)', fontSize: 12 }}>
                        {fmtBytes(clip.blob?.size ?? 0)}
                      </span>
                      <button
                        style={{ ...smallBtn, marginLeft: 'auto' }}
                        onClick={() => downloadClip(clip)}
                        disabled={previewBusy !== null}
                      >
                        {previewBusy === clip.index ? '준비 중...' : '확인용 다운로드'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {clips.length ? (
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-ghost, #2c2c32)' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
                    {introUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={introUrl}
                        alt="인트로 미리보기"
                        style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border-ghost, #3a3a42)' }}
                      />
                    ) : null}
                    <label style={{ ...smallBtn, display: 'inline-flex', alignItems: 'center' }}>
                      {introFile ? '인트로 사진 변경' : '＋ 인트로 사진 (선택)'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        style={{ display: 'none' }}
                        onChange={(e) => pickIntro(e.target.files?.[0] ?? null)}
                        disabled={publishing}
                      />
                    </label>
                    {introFile ? (
                      <>
                        <label style={{ fontSize: 12, color: 'var(--muted, #999)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          표시 시간
                          <input
                            type="number"
                            step={0.1}
                            min={0.5}
                            max={5}
                            value={introDuration}
                            onChange={(e) => setIntroDuration(Math.max(0.5, Math.min(5, Number(e.target.value) || 1.8)))}
                            style={numInput}
                            disabled={publishing}
                          />
                          초
                        </label>
                        <button style={smallBtn} onClick={() => pickIntro(null)} disabled={publishing}>제거</button>
                      </>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--muted, #999)' }}>
                        하이라이트 맨 앞에 사진을 잠깐 보여줍니다.
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button style={primaryBtn} onClick={publish} disabled={publishing}>
                      {publishing ? '처리 중...' : `⬆ 업로드하고 하나로 합치기 (${fmtBytes(clipsTotalBytes)})`}
                    </button>
                    {publishPhase === 'done' && publishMsg ? (
                      <span style={{ fontSize: 13, color: '#22c55e' }}>{publishMsg}</span>
                    ) : null}
                  </div>

                  {publishPhase === 'uploading' ? (
                    <div style={stageBox}>
                      <div style={stageHead}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>2. 클립 업로드 (브라우저)</span>
                        <LeaveBadge canLeave={false} />
                        <span style={stageCount}>{uploadProgress.done} / {uploadProgress.total}</span>
                      </div>
                      <ProgressBar
                        percent={uploadProgress.total ? (uploadProgress.done / uploadProgress.total) * 100 : 0}
                      />
                      <p style={stageNote}>
                        업로드가 끝날 때까지 <strong>이 탭을 닫지 마세요.</strong> 다음 영상은 새 탭에서 준비하세요.
                      </p>
                    </div>
                  ) : null}

                  {publishPhase === 'merging' ? (
                    <div style={stageBox}>
                      <div style={stageHead}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>3. 서버에서 다듬고 합치는 중</span>
                        <LeaveBadge canLeave />
                        <span style={stageCount}>{publishMsg}</span>
                      </div>
                      <ProgressBar indeterminate color="#22c55e" />
                      <p style={stageNote}>
                        여기부턴 서버가 처리해요. <strong>탭을 닫아도 되고</strong>, 완료되면{' '}
                        <strong>수동 결과물</strong> 탭에 자동으로 나타납니다.
                      </p>
                    </div>
                  ) : null}

                  <p style={{ fontSize: 12, color: 'var(--muted, #999)', margin: '8px 0 0' }}>
                    원본은 올라가지 않습니다. 잘린 클립만 보내고, 서버가 요청 구간에 맞춰
                    정확히 다듬어 하나로 이어붙입니다.
                  </p>

                  {publishError ? (
                    <div
                      style={{
                        marginTop: 12, padding: 12, borderRadius: 8, fontSize: 13,
                        background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
                      }}
                    >
                      실패: {publishError}
                    </div>
                  ) : null}

                  {doneJobId ? (
                    <div
                      style={{
                        marginTop: 12, padding: 12, borderRadius: 8, fontSize: 13,
                        background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)',
                        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                      }}
                    >
                      <span>하이라이트가 만들어졌습니다. 서버에 저장되어 언제든 다시 받을 수 있습니다.</span>
                      <a
                        href={`${API_BASE}/highlight/jobs/${doneJobId}/export/download`}
                        style={{ ...smallBtn, textDecoration: 'none' }}
                      >
                        합본 다운로드
                      </a>
                      <Link href="/admin/highlight/results" style={{ ...smallBtn, textDecoration: 'none' }}>
                        결과물 목록
                      </Link>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
