'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, apiFetch, apiJson } from '../../../../lib/api';
import { FPA_DRAFT_EVENT, FPA_DRAFT_STORAGE_KEY } from '../../../../components/FpaDraftGuard';
import { useSportContext } from '../../../../components/SportContext';

type DualDotTeam = 'ally' | 'opponent';
type TeamSide = 'home' | 'away';

// 팀 레이어는 화면 표시용 home/away와 xFP scoring용 ally/opponent를 분리한다.
// ally/opponent는 현재 Stat Input의 Team 값 기준으로 payload 생성 시 확정된다.
// color = 점 몸통 색, edge = 테두리 색. GK 는 몸통이 초록(키퍼 키트)이라
// 팀은 테두리가 알려준다 — 홈/어웨이 GK 를 색으로도 가르기 위한 것이다.
type DualLayer = { key: string; label: string; hotkey: string; teamSide: TeamSide; role: 'field' | 'gk'; color: string; edge?: string };
const DUAL_LAYERS: DualLayer[] = [
  // 보드 팔레트 — 홈=주황(육각형) / 어웨이=파랑(원). 점 도형과 같은 색이라 범례가 어긋나지 않는다.
  { key: 'home_field', label: '홈', hotkey: 'q', teamSide: 'home', role: 'field', color: '#FF8A01' },
  { key: 'away_field', label: '어웨이', hotkey: 'w', teamSide: 'away', role: 'field', color: '#4377EB' },
  // GK 는 양 팀 모두 몸통이 초록(키퍼 키트)이고, 팀은 테두리 색이 가른다.
  { key: 'home_gk', label: '홈 GK', hotkey: 'e', teamSide: 'home', role: 'gk', color: '#1E8A4C', edge: '#FF8A01' },
  { key: 'away_gk', label: '어웨이 GK', hotkey: 'r', teamSide: 'away', role: 'gk', color: '#12703F', edge: '#4377EB' },
];

function relationForTeamSide(teamSide: TeamSide | undefined, actorTeam: TeamSide): DualDotTeam {
  return teamSide === actorTeam ? 'ally' : 'opponent';
}

// 점에 씌울 도형(홈 육각형 / 어웨이 원). teamSide 가 비어 있는 옛 데이터는
// ally/opponent 와 지금 행위 팀으로 되돌려 판정한다.
function dotShapeSide(dot: { teamSide?: TeamSide; team?: DualDotTeam }, actorTeam: TeamSide): TeamSide {
  if (dot.teamSide) return dot.teamSide;
  const opposite: TeamSide = actorTeam === 'home' ? 'away' : 'home';
  return dot.team === 'opponent' ? opposite : actorTeam;
}

function sideLabel(side: TeamSide): string {
  return side === 'home' ? '홈' : '어웨이';
}

/* ── 보드 피치 / 선수 토큰 ────────────────────────────────────────────────
   앱 씬모션(SceneMotionView)·xFP Lineup Board 와 같은 자산을 쓴다.

   좌표는 손대지 않는다. .fpa-pitch 요소가 곧 경기장(0~1050 x 0~680)이고, 이미지는
   흰 터치라인이 요소 가장자리에 오도록 CSS 로 키워 밀어 넣는다(globals.css 참고).
   실측: scene/pitch.png 1281x829, 터치라인 중심 L34.5 R1246.5 T23.5 B805.5.
   → 마킹 위치가 기존 fpa-field.png 와 경기장 폭 대비 0.15%(약 0.16m) 차이라 무시 가능. */
const PITCH_SRC = '/scene/pitch.png';

// agusrjs/futsal-pitch의 Futsal().draw(horizontal, color=True) 기하를 React SVG로
// 이식했다. 원본은 MIT License (Copyright 2025 Agustín Rojas)이며, 40×20m 코트,
// 3m 센터서클·골, 6m/10m 지점, 페널티아크·교체선·코너 마크를 동일하게 쓴다.
function FutsalPitch({ alt }: { alt: string }) {
  return (
    <svg aria-label={alt} className="fpa-pitch-image fpa-futsal-pitch-image" preserveAspectRatio="none" role="img" viewBox="-2 -2 44 24">
      <rect fill="#e6302f" height="24" width="44" x="-2" y="-2" />
      <rect fill="#007ac0" height="20" width="40" x="0" y="0" />
      <g fill="none" stroke="#FFFFFF" strokeWidth="0.14">
        <rect height="20" width="40" x="0" y="0" />
        <path d="M20 0V20M17 10a3 3 0 1 0 6 0a3 3 0 1 0-6 0" />
        <path d="M0 17.83A6 6 0 0 1 6 11.83V8.17A6 6 0 0 1 0 2.17M40 17.83A6 6 0 0 0 34 11.83V8.17A6 6 0 0 0 40 2.17" />
        <path d="M0 8.5V11.5M40 8.5V11.5M10 19.7V20.3M15 19.7V20.3M25 19.7V20.3M30 19.7V20.3" />
        <path d="M0 0a.625.625 0 0 1 .625.625M40 0a.625.625 0 0 0-.625.625M0 20a.625.625 0 0 0 .625-.625M40 20a.625.625 0 0 1-.625-.625" />
      </g>
      <g fill="#FFFFFF">
        <circle cx="20" cy="10" r=".12" />
        <circle cx="6" cy="10" r=".12" /><circle cx="10" cy="10" r=".12" />
        <circle cx="10" cy="5" r=".06" /><circle cx="10" cy="15" r=".06" />
        <circle cx="34" cy="10" r=".12" /><circle cx="30" cy="10" r=".12" />
        <circle cx="30" cy="5" r=".06" /><circle cx="30" cy="15" r=".06" />
      </g>
    </svg>
  );
}

// 그라디언트는 문서에 한 번만 두고 토큰들이 id 로 참조한다(점마다 defs 를 복제하지 않도록).
function DualTokenDefs() {
  return (
    <svg aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        <radialGradient
          id="fpaTokHome"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(12.035 12.035) rotate(90) scale(9.16618)"
        >
          <stop stopColor="#FF7E40" stopOpacity="0.8" />
          <stop offset="1" stopColor="#FFB56D" />
        </radialGradient>
        <radialGradient
          id="fpaTokAway"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(10 10) rotate(90) scale(10)"
        >
          <stop stopColor="#4377EB" />
          <stop offset="1" stopColor="#3438C1" />
        </radialGradient>
        {/* 골키퍼는 초록 키트 — 실제 경기에서 키퍼만 다른 색을 입는 것과 같다.
            팀은 도형(육각형/원)이 계속 알려주므로 색 하나만 바꿔도 헷갈리지 않는다.
            userSpaceOnUse 라 도형의 viewBox 마다 좌표가 달라 둘로 나눈다. */}
        <radialGradient
          id="fpaTokGkHome"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(12.035 12.035) rotate(90) scale(9.16618)"
        >
          <stop stopColor="#5BE59A" stopOpacity="0.85" />
          <stop offset="1" stopColor="#1E8A4C" />
        </radialGradient>
        <radialGradient
          id="fpaTokGkAway"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(10 10) rotate(90) scale(10)"
        >
          <stop stopColor="#3DDC6B" />
          <stop offset="1" stopColor="#12703F" />
        </radialGradient>
      </defs>
    </svg>
  );
}

// 홈=육각형 / 어웨이=원. 색만이 아니라 **모양**으로도 갈라서 강조색(주황)과
// 헷갈리지 않게 한다 — 앱이 쓰는 것과 같은 도형이다.
// 골키퍼는 초록 키트로 칠한다. 도형은 그대로라 팀은 계속 읽히고, 필드 플레이어와는
// 한눈에 갈린다(실제 경기에서 키퍼만 다른 색을 입는 것과 같은 규칙).
function DualToken({ side, role }: { side: TeamSide; role?: string }) {
  const gk = role === 'gk';
  if (side === 'away') {
    return (
      <svg className="fpa-dot-shape" viewBox="0 0 20 20" aria-hidden="true">
        <circle
          opacity="0.85"
          cx="10"
          cy="10"
          r="9.2"
          fill={gk ? 'url(#fpaTokGkAway)' : 'url(#fpaTokAway)'}
          stroke="white"
          strokeWidth="1"
        />
      </svg>
    );
  }
  return (
    <svg className="fpa-dot-shape" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0L22.3923 6V18L12 24L1.6077 18V6L12 0Z" fill={gk ? '#12703F' : '#FF7400'} />
      <path
        d="M21.3835 6.58179V17.4167L11.9998 22.8347L2.61694 17.4177V6.58081L11.9998 1.16479L21.3835 6.58179Z"
        fill={gk ? '#1E8A4C' : '#FF8A01'}
        stroke="#21213F"
        strokeWidth="0.2"
      />
      <path
        d="M12.035 2.8688L19.9731 7.4519V16.6181L12.035 21.2012L4.09684 16.6181V7.4519L12.035 2.8688Z"
        fill={gk ? 'url(#fpaTokGkHome)' : 'url(#fpaTokHome)'}
      />
    </svg>
  );
}

function newDotId() {
  return Math.random().toString(36).slice(2, 10);
}

type PitchDot = {
  id?: string;       // 점 식별자 — 화살표 연결(삭제·드래그)용
  meter_x: number;
  meter_y: number;
  screen_x: number;
  screen_y: number;
  team?: DualDotTeam;
  teamSide?: TeamSide; // absolute home/away layer; team is actor-relative ally/opponent
  layer?: string;
  role?: string;     // field | gk (레이어)
  color?: string;    // 레이어 색
  number?: string;   // 등번호 — stat input 코드의 행위자 번호가 제출 시 그 점에 지정됨 (xFP/fpa)
  // 등번호 식별이 불확실함 — 영상으로 번호를 확정하지 못해 추측으로 찍었다는 표시.
  // 저장·전송에 함께 실려 앱이 "이 액션의 등번호는 확실하지 않다" 를 알 수 있게 한다.
  needsCheck?: boolean;
  // 잔상 — 라인업 배치가 깔아둔 '아직 쓰지 않은' 자리. 화면에만 있고 채점·저장·전송
  // 어디에도 들어가지 않는다. 태거가 클릭하면 그 자리에서 실제 점이 된다(좌표 불변).
  ghost?: boolean;
};

type PitchSide = 'before' | 'after';

type InputMode = 'single' | 'dual';

type SelectedDualDot = {
  side: PitchSide;
  index: number;
};

type RenderPitchDot = PitchDot & {
  left: string;
  top: string;
  label: string;
  team: DualDotTeam;
  isPrimaryAlly: boolean;
};

// code/rowIndex: 끝점 드래그로 도착점을 옮겼을 때 그 로그 행을 재채점하기 위한 연결 (신규 생성 화살표에만 채워짐)
type PassArrow = { side: PitchSide; startId?: string; x1: number; y1: number; x2: number; y2: number; code?: string; rowIndex?: number };

// 저장된 장면 — 로그행 + 캔버스 스냅샷(점·화살표). 불러오기 시 그대로 복원, 저장 시 제자리 덮어쓰기.
type SavedScene = {
  rows: LogPreview[];
  logs: string[];
  beforeDots: PitchDot[];
  afterDots: PitchDot[];
  passArrows: PassArrow[];
  primary: number | null;
  // match–clip–action 계층: 이 액션(장면)이 속한 클립 번호(1부터). 구버전 초안은 1로 간주.
  clipIndex?: number;
};

type LogPreview = {
  Time: string;
  Team: string;
  Player: string;
  Action: string;
  Receiver: string;
  Coord: string;
  Tags: string;
  DualState?: string;
  xG?: string;
  ShotThreat?: string;
  xGOT?: string;
  EPV?: string;
  PC?: string;
  // 슛 골대 클릭 지점 — "gx,gy,공격방향" (gx,gy 0~1 정규화, 빗나간 슛은 범위 밖 값). 씬 모션 슛 경로 렌더용.
  GoalMouth?: string;
  StatInput?: string; // 원본 스탯 코드 — 장면 저장 시 최종 좌표로 재채점하기 위해 각 행에 보존
};

// FinePlay 신청 라인업(사이드별) — 태깅 등번호 검증용. 서버 lineup_sides / fineplay-lineup 응답과 1:1.
type LineupSidePlayers = {
  team_name?: string;
  // 포메이션 키('4-3-3', '5-3-2 윙백형' …). 매니페스트에 없으면 빈 문자열 —
  // 그때는 슬롯 id 에서 라인 구성을 역산한다(linesFromSlotIds).
  formation?: string;
  // positionSlot = 앱 FormationSlot.id. 사전 배치가 이걸로 자리를 잡는다.
  players: {
    jersey: string; name?: string; isSubstitute?: boolean; positionSlot?: string;
    // 기록지에서 온 확인거리 —
    //   bib/rosterNumber: 조끼를 입고 뛴 선수. jersey 는 조끼 번호(영상에 보이는 것)이고
    //     rosterNumber 가 원 등번호다.
    //   bibAmbiguous: 빨간 숫자가 여럿이라 어느 쪽이 조끼인지 못 가렸다.
    //   positionInferred: 포지션 칸이 비어 포메이션·행 순서로 자리를 유추했다.
    bib?: boolean; rosterNumber?: string; bibAmbiguous?: boolean; positionInferred?: boolean;
  }[];
};
type LineupSides = Partial<Record<TeamSide, LineupSidePlayers>>;

// 화면에서 교체를 반영한 뒤의 명단 한 명. positionSlot 이 자리를 들고 다니므로,
// 교체 선수가 나간 선수의 positionSlot 을 넘겨받으면 그 자리에 그대로 배치된다.
type RosterPlayer = {
  jersey: string; name?: string; positionSlot: string; isSubstitute: boolean;
  bib?: boolean; rosterNumber?: string; bibAmbiguous?: boolean; positionInferred?: boolean;
};

type PersistedLogRow = LogPreview & {
  SceneIndex?: string;
  SceneActionIndex?: string;
  SceneState?: string;
};

type MetricKey = 'xG' | 'xGOT' | 'EPV' | 'PC';

type GoalmouthPoint = {
  x: number; // 골대 프레임 기준 — 골대 안 0~1, 빗나간 슛은 범위 밖 값
  y: number;
  viewX: number; // 클릭 영역(타깃) 기준 표시용 좌표 0~1
  viewY: number;
};

type PendingXgot = {
  canvas: 'live' | 'edit'; // 어느 캔버스의 슛인지 — 완료 시 그쪽 rows/logs 에 기록
  rowIndex: number;
  xg: number;
  isOnTarget: boolean; // false(d)면 xGOT=0, 골대 기준 위치만 기록
  isGoal: boolean;
  isHeader: boolean;
  isWeakFoot: boolean;
  underPressure: boolean;
  oneOnOne: boolean;
};

type XgotEstimateResult = {
  xgot: number;
  delta: number;
  label: string;
};

type Match = {
  id: string;
  name: string;
  competition_class: string;
  round_number: number;
  archived: boolean;
  sport?: 'FOOTBALL' | 'BASKETBALL' | 'FUTSAL';
  created_at: string;
  metadata?: {
    home_team?: string;
    away_team?: string;
  } | null;
};

type DualStatePoint = {
  meter_x?: number;
  meter_y?: number;
  team?: DualDotTeam;
  team_side?: TeamSide;
  role?: string;
  layer?: string;
  number?: string;
  id?: string;
};

type ParsedDualState = {
  actor_team?: TeamSide;
  primary_row_index?: number | null;
  before?: DualStatePoint[];
  after?: DualStatePoint[];
};

function parseMatchTeams(match: Match) {
  const metadataHome = match.metadata?.home_team?.trim();
  const metadataAway = match.metadata?.away_team?.trim();
  if (metadataHome && metadataAway) return { home: metadataHome, away: metadataAway };
  const cleaned = match.name.replace(/^\[[^\]]+\]\s*/, '');
  const [home, away] = cleaned.split(/\s+vs\s+/i).map((part) => part.trim());
  return { home: home || 'Home', away: away || 'Away' };
}

function extractReceiveCoord(logText?: string) {
  if (!logText) return '';
  const matches = Array.from(logText.matchAll(/Pos\((.+?), (.+?)\)/g));
  if (matches.length < 2) return '';
  const [, x, y] = matches[matches.length - 1];
  return `Pos(${x}, ${y})`;
}

function extractDualStateSummary(logText?: string) {
  if (!logText) return '';
  const marker = 'DualState: ';
  const start = logText.indexOf(marker);
  if (start < 0) return '';
  try {
    const parsed = JSON.parse(logText.slice(start + marker.length)) as {
      actor_team?: string;
      before?: Array<{ team?: string; team_side?: string }>;
      after?: Array<{ team?: string; team_side?: string }>;
    };
    const before = parsed.before || [];
    const after = parsed.after || [];
    const beforeHome = before.filter((point) => point.team_side === 'home').length;
    const beforeAway = before.filter((point) => point.team_side === 'away').length;
    const afterHome = after.filter((point) => point.team_side === 'home').length;
    const afterAway = after.filter((point) => point.team_side === 'away').length;
    const actorTeam = typeof parsed.actor_team === 'string' ? parsed.actor_team : '';
    if (beforeHome + beforeAway + afterHome + afterAway > 0) {
      return `${actorTeam ? `${actorTeam} · ` : ''}B H${beforeHome}/A${beforeAway} · A H${afterHome}/A${afterAway}`;
    }
    const beforeOpponents = before.filter((point) => point.team === 'opponent').length;
    const afterOpponents = after.filter((point) => point.team === 'opponent').length;
    return `B${before.length}/${beforeOpponents}O A${after.length}/${afterOpponents}O`;
  } catch {
    return 'Dual';
  }
}

function extractMetricValue(logText: string | undefined, key: MetricKey) {
  if (!logText) return '';
  const match = logText.match(new RegExp(`${key}=([^,|]+)`));
  return match?.[1]?.trim() || '';
}

function displayMetric(row: LogPreview, logText: string | undefined, key: MetricKey) {
  return row[key] || extractMetricValue(logText, key) || '-';
}

function mergeMetricsIntoLog(logText: string, metrics: Partial<Record<MetricKey, string>>) {
  const current: Partial<Record<MetricKey, string>> = {};
  (['xG', 'xGOT', 'EPV', 'PC'] as MetricKey[]).forEach((key) => {
    const value = extractMetricValue(logText, key);
    if (value) current[key] = value;
  });
  const nextMetrics = { ...current, ...metrics };
  const metricText = (['xG', 'xGOT', 'EPV', 'PC'] as MetricKey[])
    .map((key) => {
      const value = nextMetrics[key];
      return value ? `${key}=${value}` : '';
    })
    .filter(Boolean)
    .join(', ');
  if (!metricText) return logText;

  const parts = logText.split(' | ');
  const metricIndex = parts.findIndex((part) => part.startsWith('Metrics: '));
  if (metricIndex >= 0) {
    parts[metricIndex] = `Metrics: ${metricText}`;
    return parts.join(' | ');
  }
  const dualIndex = parts.findIndex((part) => part.startsWith('DualState: '));
  if (dualIndex >= 0) {
    parts.splice(dualIndex, 0, `Metrics: ${metricText}`);
  } else {
    parts.push(`Metrics: ${metricText}`);
  }
  return parts.join(' | ');
}

function mergeGoalmouthIntoLog(logText: string, goalmouthText: string) {
  if (!logText) return logText;
  const parts = logText.split(' | ');
  const nextPart = `GoalMouth: ${goalmouthText}`;
  const existingIndex = parts.findIndex((part) => part.startsWith('GoalMouth: '));
  if (existingIndex >= 0) {
    parts[existingIndex] = nextPart;
    return parts.join(' | ');
  }
  const dualIndex = parts.findIndex((part) => part.startsWith('DualState: '));
  if (dualIndex >= 0) {
    parts.splice(dualIndex, 0, nextPart);
  } else {
    parts.push(nextPart);
  }
  return parts.join(' | ');
}

function extractActionCode(statInput: string) {
  const baseAction = statInput.trim().toLowerCase().split('.', 1)[0] || '';
  const match = baseAction.match(/^\d+([a-z]+)\d*$/i);
  return match?.[1] || '';
}

function shouldPromptXgot(statInput: string, row: LogPreview) {
  const actionCode = extractActionCode(statInput);
  if (actionCode === 'd' || actionCode === 'dd' || actionCode === 'ddd') return true;
  return row.Action === 'Shot' && /(^|, )On Target|(^|, )Off Target|(^|, )Goal/.test(row.Tags || '');
}

function screenFromMeter(meterX: number, meterY: number) {
  return {
    screen_x: Number(((meterX / 105) * 1050).toFixed(2)),
    screen_y: Number((((68 - meterY) / 68) * 680).toFixed(2)),
  };
}

/* ── 라인업 사전 배치 ────────────────────────────────────────────────────────
   영상만 보고 등번호를 찾아내는 게 dual 태깅에서 제일 오래 걸린다. 신청에 이미
   라인업이 실려 오므로, before 프레임에 포메이션대로 등번호 점을 미리 깔아준다.

   앱(FinePlay)이 보내는 positionSlot 은 FormationSlot.id 다:
     'gk' | 'player_{라인}_{순번}' | 'c{행}_{열}'(커스텀 5×5) | 'SUB'(교체)
   좌표는 앱의 buildPresetSlots() 가 포메이션 문자열에서 만들어내므로 그 규칙을
   그대로 옮긴다. 포메이션 문자열이 안 오면 슬롯 id 집합에서 라인 구성을 역산한다
   — 숫자('4-3-3')는 복원되고 변형 접미사(윙백형·압박형·다이아몬드)만 못 살린다. */

type FormationSlotGrid = { id: string; gridX: number; gridY: number; position: string };

// 앱 buildPresetSlots 이식. gridX 0(좌)~4(우), gridY 는 GK=20 최대 / 수비가 최소.
function buildFormationSlots(formationKey: string, lines: number[]): FormationSlotGrid[] {
  const slots: FormationSlotGrid[] = [{ id: 'gk', gridX: 2, gridY: 20, position: 'GK' }];
  const lineCount = lines.length;
  if (!lineCount) return slots;

  const gridYValues = lineCount === 2 ? [5, 15]
    : lineCount === 3 ? [5, 10, 15]
    : lineCount === 4 ? [4, 8, 12, 16]
    : lineCount === 5 ? [4, 7, 10, 13, 16]
    : lines.map((_, i) => 5 + i * 3);

  for (let i = 0; i < lineCount; i += 1) {
    const playerCount = lines[i];
    const gridY = gridYValues[i];
    // 인원수가 표에 없는 경우의 공통 폴백 — 0~4 에 고르게 편다.
    const spread = () => Array.from({ length: playerCount }, (_, j) => (
      playerCount === 1 ? 2 : Math.round((4 / (playerCount - 1)) * j)
    ));

    // 자리 좌표와 포지션 라벨을 함께 만든다 — 라벨은 명단 패널에서 보여준다.
    const fill = (name: string) => Array.from({ length: playerCount }, () => name);
    let xCoords: number[];
    let positions: string[];
    if (i === 0) {                                   // 최후방 수비 라인
      [xCoords, positions] = playerCount === 3 ? [[1, 2, 3], ['CB', 'CB', 'CB']]
        : playerCount === 4 ? [[0, 1, 3, 4], ['LB', 'CB', 'CB', 'RB']]
        : playerCount === 5 ? [[0, 1, 2, 3, 4], ['LB', 'CB', 'CB', 'CB', 'RB']]
        : [spread(), fill('CB')];
    } else if (i === lineCount - 1) {                // 최전방 공격 라인
      [xCoords, positions] = playerCount === 1 ? [[2], ['ST']]
        : playerCount === 2 ? [[1, 3], ['ST', 'ST']]
        : playerCount === 3 ? [[0, 2, 4], ['LW', 'ST', 'RW']]
        : playerCount === 4 ? [[0, 1, 3, 4], ['LW', 'CF', 'CF', 'RW']]
        : [spread(), fill('ST')];
    } else if (lineCount === 3) {                    // 3라인의 허리
      [xCoords, positions] = playerCount === 2 ? [[1, 3], ['LCM', 'RCM']]
        : playerCount === 3 ? [[1, 2, 3], ['LCM', 'CM', 'RCM']]
        : playerCount === 4 ? [[0, 1, 3, 4], ['LM', 'LCM', 'RCM', 'RM']]
        : playerCount === 5 ? [[0, 1, 2, 3, 4], ['LM', 'LCM', 'CM', 'RCM', 'RM']]
        : [spread(), fill('CM')];
    } else if (lineCount === 4 && i === 1) {         // 4라인의 수비형 허리
      [xCoords, positions] = playerCount === 1 ? [[2], ['DM']]
        : playerCount === 2 ? [[1, 3], ['LDM', 'RDM']]
        : playerCount === 3 ? [[1, 2, 3], ['LDM', 'DM', 'RDM']]
        : playerCount === 4 ? [[0, 1, 3, 4], ['LM', 'LDM', 'RDM', 'RM']]
        : [spread(), fill('DM')];
    } else if (lineCount === 4) {                    // 4라인의 공격형 허리
      [xCoords, positions] = playerCount === 1 ? [[2], ['CAM']]
        : playerCount === 2 ? [[1, 3], ['LAM', 'RAM']]
        : playerCount === 3 ? [[0, 2, 4], ['LAM', 'CAM', 'RAM']]
        : playerCount === 4 ? [[0, 1, 3, 4], ['LAM', 'LCM', 'RCM', 'RAM']]
        : [spread(), fill('AM')];
    } else {
      [xCoords, positions] = [spread(), fill('CM')];
    }

    // 스위퍼: 최후방 중앙을 SW 로 바꾼다 (좌표는 그대로).
    if (formationKey.includes('스위퍼') && i === 0) {
      positions = positions.map((name, j) => (xCoords[j] === 2 ? 'SW' : name));
    }

    for (let j = 0; j < playerCount; j += 1) {
      let gridXFinal = xCoords[j];
      let gridYFinal = gridY;
      let positionFinal = positions[j];
      // 변형은 gridY 를 옮겨 새 라인을 만든다 — 행 매핑이 자동으로 한 줄 더 잡는다.
      if (formationKey.includes('윙백형')) {
        if (i === 0 && (gridXFinal === 0 || gridXFinal === 4)) {
          positionFinal = gridXFinal === 0 ? 'LWB' : 'RWB';
          gridYFinal = gridY + 2;
        } else if (lineCount === 3 && i === 1 && playerCount === 4 && (gridXFinal === 0 || gridXFinal === 4)) {
          positionFinal = gridXFinal === 0 ? 'LWB' : 'RWB';
          gridYFinal = 7;
        }
      }
      if (formationKey.includes('압박형') && i > 0) gridYFinal += 2;
      if (formationKey.includes('다이아몬드') && i === 1 && playerCount === 4) {
        if (j === 0) { positionFinal = 'DM'; gridXFinal = 2; gridYFinal = gridY - 2; }
        else if (j === 1) { positionFinal = 'LCM'; gridXFinal = 1; }
        else if (j === 2) { positionFinal = 'RCM'; gridXFinal = 3; }
        else if (j === 3) { positionFinal = 'CAM'; gridXFinal = 2; gridYFinal = gridY + 2; }
      }
      slots.push({ id: `player_${i}_${j}`, gridX: gridXFinal, gridY: gridYFinal, position: positionFinal });
    }
  }
  return slots;
}

// 경기기록지(사전작업) 라인업의 포지션 라벨 → 격자.
// 앱은 positionSlot 이 'player_{라인}_{순번}' 이라 포메이션을 알아야 자리가 나오지만,
// 기록지는 좌우가 라벨에 들어 있어(LCB/RCB/LDM/RAM …) 라벨만으로 자리가 확정된다.
// 실제 기록지 12팀(4-2-3-1·4-3-3·4-4-2·5-4-1·4-5-1)에서 나온 21종을 모두 덮고,
// 같은 팀 안에서 두 선수가 같은 칸에 겹치지 않는 것을 확인했다.
const RECORD_SHEET_POSITION_GRID: Record<string, { gridX: number; gridY: number }> = {
  GK: { gridX: 2, gridY: 20 },
  // SW(스위퍼) — 백5 가운데를 조금 더 내려 세운다. 백4와 같은 줄에 두면 CB 와 자리가
  // 겹치고, 실제로도 스위퍼는 한 발 뒤에 선다. (2026 SUFA 5-3-2 기록지에 나온다)
  SW: { gridX: 2, gridY: 4 },
  LB: { gridX: 0, gridY: 5 },
  LCB: { gridX: 1, gridY: 5 },
  CB: { gridX: 2, gridY: 5 },
  RCB: { gridX: 3, gridY: 5 },
  RB: { gridX: 4, gridY: 5 },
  LWB: { gridX: 0, gridY: 7 },
  RWB: { gridX: 4, gridY: 7 },
  LDM: { gridX: 1, gridY: 8 },
  DM: { gridX: 2, gridY: 8 },
  // CDM — 기록지가 4-1-4-1 홀딩을 이렇게 적는다. 자리는 DM 과 같다.
  CDM: { gridX: 2, gridY: 8 },
  RDM: { gridX: 3, gridY: 8 },
  LM: { gridX: 0, gridY: 10 },
  LCM: { gridX: 1, gridY: 10 },
  CM: { gridX: 2, gridY: 10 },
  RCM: { gridX: 3, gridY: 10 },
  RM: { gridX: 4, gridY: 10 },
  LAM: { gridX: 0, gridY: 12 },
  CAM: { gridX: 2, gridY: 12 },
  RAM: { gridX: 4, gridY: 12 },
  LW: { gridX: 0, gridY: 15 },
  LS: { gridX: 1, gridY: 15 },
  ST: { gridX: 2, gridY: 15 },
  RS: { gridX: 3, gridY: 15 },
  RW: { gridX: 4, gridY: 15 },
};

/** 슬롯 값이 기록지 포지션 라벨인가 — 앱 슬롯('player_…'·'c0_1')과 구분한다. */
function isRecordSheetPosition(slot: string) {
  return Object.prototype.hasOwnProperty.call(RECORD_SHEET_POSITION_GRID, slot.toUpperCase());
}

/** 기록지 라벨 목록 → 슬롯. 라벨이 곧 id 라 그대로 쓴다. */
function buildRecordSheetSlots(labels: string[]): FormationSlotGrid[] {
  const seen = new Set<string>();
  const slots: FormationSlotGrid[] = [];
  labels.forEach((raw) => {
    const label = raw.toUpperCase();
    const grid = RECORD_SHEET_POSITION_GRID[label];
    if (!grid || seen.has(label)) return;
    seen.add(label);
    slots.push({ id: label, gridX: grid.gridX, gridY: grid.gridY, position: label });
  });
  return slots;
}

// 커스텀 5×5 자유 배치 슬롯 — 앱 buildCustomGridSlots 와 같은 규칙(0행이 최하단=GK 줄).
// 쓰인 자리만 모으면 0행이 비었을 때 행 지도가 앞뒤로 뒤집히므로 25칸을 전부 만든다.
const CUSTOM_GK_GRID_Y = 100;
function buildCustomGridSlots(): FormationSlotGrid[] {
  const slots: FormationSlotGrid[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      slots.push({ id: `c${row}_${col}`, gridX: col, gridY: row === 0 ? CUSTOM_GK_GRID_Y : row, position: row === 0 ? 'GK' : '' });
    }
  }
  return slots;
}

// 슬롯 id 집합 → 라인별 인원수. 포메이션 문자열이 없을 때 숫자 구성을 역산한다.
function linesFromSlotIds(ids: string[]): number[] {
  const counts = new Map<number, number>();
  ids.forEach((id) => {
    const m = /^player_(\d+)_(\d+)$/.exec(id);
    if (!m) return;
    const line = Number(m[1]);
    counts.set(line, Math.max(counts.get(line) ?? 0, Number(m[2]) + 1));
  });
  if (!counts.size) return [];
  const maxLine = Math.max(...Array.from(counts.keys()));
  return Array.from({ length: maxLine + 1 }, (_, i) => counts.get(i) ?? 0);
}

// 앱 buildFormationYMap 과 같은 규칙: GK(최대 gridY)=행 0, 나머지는 gridY 오름차순.
function rowMapFromSlots(slots: FormationSlotGrid[]): Map<number, number> {
  const ys = slots.map((s) => s.gridY);
  const gkY = Math.max(...ys);
  const outfield = Array.from(new Set(ys.filter((y) => y !== gkY))).sort((a, b) => a - b);
  const map = new Map<number, number>([[gkY, 0]]);
  outfield.forEach((y, i) => map.set(y, i + 1));
  return map;
}

// 킥오프 형태로 자기 진영에 세운다 — 태거가 실제 위치로 끌어 옮기는 출발점.
const LINEUP_GK_X = 5;      // 자기 골문 앞
const LINEUP_BACK_X = 18;   // 최후방 필드 라인
const LINEUP_FRONT_X = 48;  // 하프라인 조금 앞
const LINEUP_Y_MARGIN = 7;  // 터치라인 여유

/** 행·격자열 → 미터 좌표. attacksRight=false 면 피치를 180° 돌린다(x·y 동시 반전). */
function lineupMeters(row: number, rowCount: number, gridX: number, attacksRight: boolean) {
  const outfieldSpans = Math.max(1, rowCount - 2);
  const x = row === 0
    ? LINEUP_GK_X
    : LINEUP_BACK_X + ((row - 1) / outfieldSpans) * (LINEUP_FRONT_X - LINEUP_BACK_X);
  // 공격 방향을 바라볼 때 gridX 0 이 왼쪽 = y 큰 쪽.
  const y = 68 - LINEUP_Y_MARGIN - (gridX / 4) * (68 - 2 * LINEUP_Y_MARGIN);
  return attacksRight
    ? { meter_x: Number(x.toFixed(2)), meter_y: Number(y.toFixed(2)) }
    : { meter_x: Number((105 - x).toFixed(2)), meter_y: Number((68 - y).toFixed(2)) };
}

function toPayloadDot(dot: PitchDot, actorTeam?: TeamSide) {
  const payload: {
    meter_x: number;
    meter_y: number;
    team?: DualDotTeam;
    team_side?: TeamSide;
    role?: string;
    layer?: string;
    number?: string;
    id?: string;
    needs_check?: boolean;
  } = {
    meter_x: dot.meter_x,
    meter_y: dot.meter_y,
  };
  const actorRelativeTeam = dot.teamSide && actorTeam ? relationForTeamSide(dot.teamSide, actorTeam) : dot.team;
  if (actorRelativeTeam) payload.team = actorRelativeTeam;
  if (dot.teamSide) payload.team_side = dot.teamSide;
  if (dot.role) payload.role = dot.role;
  if (dot.layer) payload.layer = dot.layer;
  if (dot.number) payload.number = dot.number;
  if (dot.id) payload.id = dot.id;
  if (dot.needsCheck) payload.needs_check = true;
  return payload;
}

function colorForDualDot(teamSide?: TeamSide, role?: string, team?: DualDotTeam) {
  const layer = DUAL_LAYERS.find((candidate) => candidate.teamSide === teamSide && candidate.role === role);
  if (layer) return layer.color;
  if (teamSide === 'home') return role === 'gk' ? '#1E8A4C' : '#FF8A01';
  if (teamSide === 'away') return role === 'gk' ? '#12703F' : '#4377EB';
  return team === 'opponent' ? '#4377EB' : '#FF8A01';
}

function normalizePitchDot(raw: Partial<PitchDot> & { team_side?: TeamSide }, actorTeam?: TeamSide): PitchDot | null {
  const meterX = Number(raw.meter_x);
  const meterY = Number(raw.meter_y);
  if (!Number.isFinite(meterX) || !Number.isFinite(meterY)) return null;
  const screen = Number.isFinite(Number(raw.screen_x)) && Number.isFinite(Number(raw.screen_y))
    ? { screen_x: Number(raw.screen_x), screen_y: Number(raw.screen_y) }
    : screenFromMeter(meterX, meterY);
  const legacyLayerSide: TeamSide | undefined =
    raw.layer === 'atk' || raw.layer === 'atk_gk' ? 'home'
      : raw.layer === 'def' || raw.layer === 'def_gk' ? 'away'
        : undefined;
  const teamSide = raw.teamSide || raw.team_side || legacyLayerSide;
  const team = teamSide && actorTeam ? relationForTeamSide(teamSide, actorTeam) : raw.team;
  const rawRole = raw.role || (raw.layer?.includes('gk') ? 'gk' : undefined);
  const role = rawRole === 'attacker' || rawRole === 'defender' ? 'field' : rawRole;
  const layer = raw.layer || (teamSide ? `${teamSide}_${role === 'gk' ? 'gk' : 'field'}` : undefined);
  return {
    ...raw,
    id: raw.id || newDotId(),
    meter_x: Number(meterX.toFixed(2)),
    meter_y: Number(meterY.toFixed(2)),
    ...screen,
    team: team || 'ally',
    teamSide,
    layer,
    role,
    color: raw.color || colorForDualDot(teamSide, role, team),
  };
}

function parseDualStateFromLog(logText?: string): ParsedDualState | null {
  if (!logText) return null;
  const marker = 'DualState: ';
  const start = logText.indexOf(marker);
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(logText.slice(start + marker.length)) as ParsedDualState;
    if (!Array.isArray(parsed.before) && !Array.isArray(parsed.after)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function latestDualStateFromLogs(logsToScan: string[]): ParsedDualState | null {
  for (let index = logsToScan.length - 1; index >= 0; index -= 1) {
    const parsed = parseDualStateFromLog(logsToScan[index]);
    if (parsed) return parsed;
  }
  return null;
}

function dotsFromDualState(logsToScan: string[], side: PitchSide, fallbackActorTeam?: TeamSide) {
  const state = latestDualStateFromLogs(logsToScan);
  const actorTeam = state?.actor_team || fallbackActorTeam;
  const points = side === 'before' ? state?.before : state?.after;
  if (!Array.isArray(points)) return [];
  return points
    .map((point) => normalizePitchDot(point, actorTeam))
    .filter((dot): dot is PitchDot => Boolean(dot));
}

function hydrateSceneDots(dots: PitchDot[], logsToScan: string[], side: PitchSide, fallbackActorTeam?: TeamSide) {
  const normalized = dots
    .map((dot) => normalizePitchDot(dot, fallbackActorTeam))
    .filter((dot): dot is PitchDot => Boolean(dot));
  return normalized.length ? normalized : dotsFromDualState(logsToScan, side, fallbackActorTeam);
}

function sceneFromDualLogs(rows: LogPreview[], logsToScan: string[], fallbackActorTeam?: TeamSide): SavedScene | null {
  const state = latestDualStateFromLogs(logsToScan);
  if (!state) return null;
  const header = logsToScan[0]?.split(' | ') || [];
  const headerTeam = header[1] === 'home' || header[1] === 'away' ? header[1] : undefined;
  const actorTeam = state.actor_team || headerTeam || fallbackActorTeam;
  const beforeDotsFromState = dotsFromDualState(logsToScan, 'before', actorTeam);
  const afterDotsFromState = dotsFromDualState(logsToScan, 'after', actorTeam);
  if (!beforeDotsFromState.length && !afterDotsFromState.length) return null;
  return {
    rows,
    logs: logsToScan,
    beforeDots: beforeDotsFromState,
    afterDots: afterDotsFromState,
    passArrows: [],
    primary: typeof state.primary_row_index === 'number' ? state.primary_row_index : null,
  };
}

function sceneStateFromRow(row: LogPreview) {
  const raw = (row as PersistedLogRow).SceneState;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as {
      beforeDots?: PitchDot[];
      afterDots?: PitchDot[];
      before?: PitchDot[];
      after?: PitchDot[];
      passArrows?: PassArrow[];
      primary?: number | null;
    };
  } catch {
    return null;
  }
}

function scenesFromPersistedRows(rows: LogPreview[], logsToScan: string[], fallbackActorTeam?: TeamSide) {
  const groups = new Map<string, { rows: LogPreview[]; logs: string[]; state: ReturnType<typeof sceneStateFromRow> }>();
  rows.forEach((row, index) => {
    const sceneIndex = (row as PersistedLogRow).SceneIndex;
    if (!sceneIndex) return;
    const existing = groups.get(sceneIndex) || { rows: [], logs: [], state: null };
    existing.rows.push(row);
    existing.logs.push(logsToScan[index] || '');
    existing.state = existing.state || sceneStateFromRow(row);
    groups.set(sceneIndex, existing);
  });

  return Array.from(groups.entries())
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, group]) => {
      const state = group.state;
      if (!state) return null;
      const beforeSource = state.beforeDots || state.before || [];
      const afterSource = state.afterDots || state.after || [];
      const scene: SavedScene = {
        rows: group.rows,
        logs: group.logs,
        beforeDots: hydrateSceneDots(beforeSource, group.logs, 'before', fallbackActorTeam),
        afterDots: hydrateSceneDots(afterSource, group.logs, 'after', fallbackActorTeam),
        passArrows: Array.isArray(state.passArrows) ? state.passArrows.map((arrow) => ({ ...arrow })) : [],
        primary: typeof state.primary === 'number' ? state.primary : null,
      };
      return scene;
    })
    .filter((scene): scene is SavedScene => Boolean(scene));
}

function dotFromClientPoint(clientX: number, clientY: number, rect: DOMRect): PitchDot {
  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);
  return {
    meter_x: Number(((x / rect.width) * 105).toFixed(2)),
    meter_y: Number((((rect.height - y) / rect.height) * 68).toFixed(2)),
    screen_x: Number(((x / rect.width) * 1050).toFixed(2)),
    screen_y: Number(((y / rect.height) * 680).toFixed(2)),
  };
}

// 피치 빈 곳(점이 아닌 곳)에서 우클릭했을 때, 커서에 가장 가까운 점의 인덱스를 찾는다.
// 점은 작아서 정확히 맞히기 어렵기에 반경(px) 안이면 그 점을 지운다. 반경 밖이면 -1.
const DOT_HIT_RADIUS_PX = 24;
function nearestDotIndex(dots: PitchDot[], clientX: number, clientY: number, rect: DOMRect): number {
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  let best = -1;
  let bestDist = DOT_HIT_RADIUS_PX;
  dots.forEach((dot, index) => {
    // 잔상은 빈 곳 우클릭(가까운 점 삭제)의 표적이 되지 않는다 — 잔상은 그 점 위에서 직접 우클릭해 없앤다.
    if (dot.ghost) return;
    const dx = (dot.screen_x / 1050) * rect.width - px;
    const dy = (dot.screen_y / 680) * rect.height - py;
    const dist = Math.hypot(dx, dy);
    if (dist <= bestDist) {
      bestDist = dist;
      best = index;
    }
  });
  return best;
}

function isAllyDot(dot: PitchDot) {
  return (dot.team || 'ally') === 'ally';
}

/** 잔상을 걷어낸 '실제' 점만. 채점·payload·장면 스냅샷은 전부 이걸 통과해야 한다.
    잔상은 포메이션 자리에 서 있을 뿐 실제 위치가 아니라, 섞여 들어가면 좌표가 거짓이 된다. */
function realDots(list: PitchDot[]): PitchDot[] {
  return list.filter((dot) => !dot.ghost);
}

/** 같은 팀의 같은 등번호를 가리키는 키 — 잔상을 다시 깔 때 이미 활성화된 선수를 건너뛰는 데 쓴다. */
function dotRosterKey(dot: PitchDot): string | null {
  return dot.number ? `${dot.teamSide ?? '?'}:${dot.number}` : null;
}

function clonePitchDotsForNextScene(dotsToClone: PitchDot[]) {
  return dotsToClone.map((dot) => ({ ...dot, id: newDotId() }));
}

function clonePitchDotsWithIdMap(dotsToClone: PitchDot[]) {
  const idMap = new Map<string, string>();
  const dots = dotsToClone.map((dot) => {
    const nextId = newDotId();
    if (dot.id) idMap.set(dot.id, nextId);
    return { ...dot, id: nextId };
  });
  return { dots, idMap };
}

function statInputHasReceiver(statInput: string) {
  const baseAction = statInput.trim().split('.', 1)[0] || '';
  return /^\d+[a-z]+\d+$/i.test(baseAction);
}

function statInputReceiverNumber(statInput: string) {
  return statInput.trim().split('.', 1)[0]?.match(/^\d+[a-z]+(\d+)$/i)?.[1];
}

/** 등번호로 아군 점을 찾는다 (before 우선).

    라인업을 미리 깔면 번호가 이미 점에 붙어 있다. 그때는 **어디를 클릭했든** 그 번호의
    점이 행위자여야 한다 — 예전엔 선택된 점을 행위자로 삼고 거기에 번호를 덮어써서,
    2번 점을 클릭한 채 `11ss4` 를 넣으면 2번이 11번으로 바뀌어 버렸다.
    번호가 안 붙은 수기 태깅에서는 못 찾으므로, 호출부가 기존처럼 선택 점으로 떨어진다. */
function findAllyDotByNumber(
  number: string | undefined,
  before: PitchDot[],
  after: PitchDot[],
): { side: PitchSide; index: number; dot: PitchDot } | null {
  if (!number) return null;
  // 잔상은 실제 위치가 아니라 행위자가 될 수 없다 — 집히면 포메이션 자리가 그대로 채점 좌표가 된다.
  const match = (dot: PitchDot) => !dot.ghost && isAllyDot(dot) && dot.number === number;
  const beforeIndex = before.findIndex(match);
  if (beforeIndex >= 0) return { side: 'before', index: beforeIndex, dot: before[beforeIndex] };
  const afterIndex = after.findIndex(match);
  if (afterIndex >= 0) return { side: 'after', index: afterIndex, dot: after[afterIndex] };
  return null;
}

// 드리블/돌파/침투: 도착점은 행위자가 after 프레임에서 서 있는 위치다. 리시버가 붙으면 패스 계열.
const MOVE_ACTION_CODES = ['r', 'rr', 'e', 'ee', 'pn'];

function statInputIsMoveAction(statInput: string) {
  if (statInputHasReceiver(statInput)) return false;
  return MOVE_ACTION_CODES.includes(extractActionCode(statInput));
}

// 슛(d/dd/ddd/db)의 채점 위치는 행위자 점 하나뿐 — 아군 점이 여럿이어도(팀메이트·마커)
// 다른 점이 슛 위치로 밀리면 xG가 왜곡된다 (백엔드는 dots[-1]을 슛 위치로 사용).
const SHOT_INPUT_CODES = new Set(['d', 'dd', 'ddd', 'db']);
function statInputIsShotAction(statInput: string) {
  return SHOT_INPUT_CODES.has(extractActionCode(statInput));
}

function statInputIsNumberOnly(statInput: string) {
  return /^\d+$/.test(statInput.trim());
}

// 수비 화살표 액션 — before 프레임에 상대 볼/슛 경로를 화살표(start→end)로 그림 (2클릭). 리시버 번호 없음.
// aa/q/ww = 패스/볼 경로 → EPV(end)−EPV(start) 로 채점하므로 양 끝이 모두 점수에 들어간다.
// qw = 슛 블락 → xG(슈터 위치)만으로 채점. end(블록 지점)는 기록용이고 점수에 안 쓰인다.
//   상대팀은 좌표만 찍으므로 슛 위치 마커가 필요해 화살표를 유지한다 (2026-07-10 결정).
// 제외: Duel(b/bb)·Clear(w)=포인트 액션.
const DEFENSE_ARROW_CODES = new Set(['aa', 'q', 'ww', 'qw', 'w']);
// 경합(b/bb)도 볼 경로를 화살표로 그린다 — 시작=볼이 온 곳, 끝=경합 지점.
// 끝점이 곧 채점 좌표라, 화살표를 그리면 after 프레임에서 위치를 다시 잡을 필요가 없다.
const DUEL_ARROW_CODES = new Set(['b', 'bb']);
// 두 번 클릭으로 **볼 경로**를 그리는 액션 전체 — 색·선종류·끝점 마커를 패스와 달리 준다.
const BALL_PATH_ARROW_CODES = new Set([...DEFENSE_ARROW_CODES, ...DUEL_ARROW_CODES]);
const SHOT_BLOCK_CODES = new Set(['qw']);
function statInputActionCode(statInput?: string | null) {
  const base = (statInput ?? '').trim().split('.', 1)[0] || '';
  return base.match(/^\d+([a-z]+)$/i)?.[1].toLowerCase() ?? '';
}
function statInputIsBallPathArrow(statInput?: string | null) {
  return BALL_PATH_ARROW_CODES.has(statInputActionCode(statInput));
}
function statInputIsDuelArrow(statInput?: string | null) {
  return DUEL_ARROW_CODES.has(statInputActionCode(statInput));
}
function statInputIsShotBlock(statInput?: string | null) {
  return SHOT_BLOCK_CODES.has(statInputActionCode(statInput));
}

// 화살표 그리기 대기 상태 서술자 — 피치 위 배지/커서/미리보기 렌더에 사용
type ArrowArm = { side: PitchSide; code: string; stage: 'start' | 'end'; sx: number; sy: number };

// 패스(아군 볼) vs 수비(상대 볼 차단)를 한눈에 구분 — 색·선종류·끝점 마커가 모두 다름.
// aa/q/ww/qw 세부 구분은 화살표에 붙는 코드 칩이 담당한다.
const ARROW_COLORS = { pass: '#16c2c2', defense: '#e0524f' } as const;
type ArrowKind = keyof typeof ARROW_COLORS;
function arrowKind(code?: string): ArrowKind {
  return statInputIsBallPathArrow(code) ? 'defense' : 'pass';
}

// 각 클릭이 무엇을 뜻하는지 — 피치 배지와 하단 상태바가 같은 문구를 쓴다
function arrowArmHint(code: string, stage: 'start' | 'end') {
  if (statInputIsShotBlock(code)) {
    return stage === 'start' ? '슛 위치(슈터) 클릭 · xG 채점 기준' : '블록 지점 클릭 · 기록용';
  }
  if (statInputIsDuelArrow(code)) {
    return stage === 'start' ? '볼이 온 곳 클릭' : '경합 지점 클릭 · 채점 기준';
  }
  if (statInputIsBallPathArrow(code)) {
    return stage === 'start' ? '상대 볼 출발점 클릭' : '끊은 지점 클릭';
  }
  return '패스 도착점 클릭';
}

function arrowBelongsToRemovedDot(arrow: PassArrow, side: PitchSide, removedId: string) {
  if (arrow.startId !== removedId) return false;
  return arrow.side === side || side === 'before';
}

function mirroredBeforeArrowsForAfter(arrows: PassArrow[], idMap: Map<string, string>) {
  return arrows
    .filter((arrow) => arrow.side === 'before')
    .map((arrow) => ({
      ...arrow,
      side: 'after' as PitchSide,
      startId: arrow.startId ? idMap.get(arrow.startId) || arrow.startId : undefined,
    }));
}

function sceneStateForPersistence(scene: SavedScene, sceneIndex: number) {
  return JSON.stringify({
    schema: 'fineplay.fpa.scene_state.v0.1',
    scene_index: sceneIndex,
    beforeDots: scene.beforeDots,
    afterDots: scene.afterDots,
    passArrows: scene.passArrows,
    primary: scene.primary,
  });
}

function validateMatchIdForSave(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'ID') return '';
  if (/\s/.test(trimmed)) return 'Match ID에는 띄어쓰기를 사용할 수 없습니다';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return 'Match ID는 UUID 형식이어야 합니다. 비워두면 자동 생성됩니다';
  }
  return '';
}

function generateMatchId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (char) =>
    (Number(char) ^ (Math.random() * 16) >> (Number(char) / 4)).toString(16));
}

function buildRenderPitchDots(sourceDots: PitchDot[]): RenderPitchDot[] {
  let allyCount = 0;
  let opponentCount = 0;
  return sourceDots.map((sourceDot) => {
    const dot = normalizePitchDot(sourceDot) || sourceDot;
    const dotTeam = dot.team || 'ally';
    // 잔상은 A1·O2 같은 순번을 먹지 않는다 — 활성화 여부에 따라 실제 점의 라벨이 흔들리면 안 된다.
    const teamIndex = dot.ghost ? 0 : dotTeam === 'ally' ? (allyCount += 1) : (opponentCount += 1);
    return {
      ...dot,
      team: dotTeam,
      left: `${(dot.screen_x / 1050) * 100}%`,
      top: `${(dot.screen_y / 680) * 100}%`,
      label: dot.number || (dot.ghost ? '' : `${dotTeam === 'ally' ? 'A' : 'O'}${teamIndex}`),
      isPrimaryAlly: !dot.ghost && dotTeam === 'ally' && teamIndex <= 2,
    };
  });
}

// 라이브 dual 캔버스 undo 단위 — 조작 직전의 캔버스+로그 스냅샷 (Undo 는 마지막 조작 자체를 되돌림)
type DualUndoSnapshot = {
  beforeDots: PitchDot[];
  afterDots: PitchDot[];
  passArrows: PassArrow[];
  rows: LogPreview[];
  logs: string[];
  primaryRowIndex: number | null;
  selectedRowIndex: number | null;
};

export default function FpaLivePage() {
  const { sport: selectedSport } = useSportContext();
  const didHydrateRef = useRef(false);
  // 세션 초안에 실제 작업물이 들어 있었나 — 클립 복원이 그걸 덮어쓰지 않게 하는 잠금.
  const draftHadContentRef = useRef(false);
  const pitchRef = useRef<HTMLDivElement | null>(null);
  const beforePitchRef = useRef<HTMLDivElement | null>(null);
  const afterPitchRef = useRef<HTMLDivElement | null>(null);
  const editBeforePitchRef = useRef<HTMLDivElement | null>(null);
  const editAfterPitchRef = useRef<HTMLDivElement | null>(null);
  const draggingDualDotRef = useRef<(SelectedDualDot & { canvas: 'live' | 'edit'; historyPushed?: boolean }) | null>(null);
  // 패스 화살표 끝점 드래그 상태 — index=passArrows 배열 실제 인덱스, end='end'(도착점) 이동, moved=실제 이동 여부(클릭과 구분)
  const draggingArrowRef = useRef<{ index: number; end: 'start' | 'end'; side: PitchSide; canvas: 'live' | 'edit'; moved: boolean } | null>(null);
  const logBodyRef = useRef<HTMLDivElement | null>(null);
  const statInputRef = useRef<HTMLInputElement | null>(null);
  const editStatInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [half, setHalf] = useState<'1H' | '2H'>('1H');
  const [team, setTeam] = useState<'home' | 'away'>('home');
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [timeline, setTimeline] = useState('00:00');
  const [fpaSport, setFpaSport] = useState<'FOOTBALL' | 'FUTSAL'>(selectedSport === 'FUTSAL' ? 'FUTSAL' : 'FOOTBALL');
  const [statInput, setStatInput] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('single');
  const [activeLayer, setActiveLayer] = useState<string>('home_field');
  const currentLayer = DUAL_LAYERS.find((layer) => layer.key === activeLayer) ?? DUAL_LAYERS[0];
  const [dots, setDots] = useState<PitchDot[]>([]);
  const [beforeDots, setBeforeDots] = useState<PitchDot[]>([]);
  const [afterDots, setAfterDots] = useState<PitchDot[]>([]);
  const [selectedDualDot, setSelectedDualDot] = useState<SelectedDualDot | null>(null);
  const [pendingXgot, setPendingXgot] = useState<PendingXgot | null>(null);
  const [goalmouthPoint, setGoalmouthPoint] = useState<GoalmouthPoint | null>(null);
  const goalmouthFrameRef = useRef<HTMLDivElement | null>(null);
  const [xgotEstimate, setXgotEstimate] = useState<XgotEstimateResult | null>(null);
  const [xgotBusy, setXgotBusy] = useState(false);
  // rows/logs = "현재 작업 중 장면"의 액션 (single 모드는 그냥 flat 로그). 저장된 장면은 savedScenes.
  const [logs, setLogs] = useState<string[]>([]);
  const [rows, setRows] = useState<LogPreview[]>([]);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [primaryRowIndex, setPrimaryRowIndex] = useState<number | null>(null);
  // 저장된 장면들(순서 보존). 기록된 로그가 이걸 장면 단위로 보여줌.
  const [savedScenes, setSavedScenes] = useState<SavedScene[]>([]);
  // 지금 쌓고 있는 클립 번호 — "다음 클립 →" 으로 올리면 이후 액션 저장이 새 클립 밑으로 들어간다.
  const [currentClipIndex, setCurrentClipIndex] = useState(1);
  // 불러와 편집 중인 장면 index (null=새 장면). 저장 시 이 index 자리에 덮어씀 → 순서 유지.
  const [editingSceneIndex, setEditingSceneIndex] = useState<number | null>(null);
  // 패스/크로스: 시작 점에서 코드 입력 후 도착점 클릭 대기. 도착점 클릭 시 [시작,도착] 2점으로 채점.
  const [pendingPass, setPendingPass] = useState<{ code: string; side: PitchSide; startId?: string; sx: number; sy: number; mx: number; my: number } | null>(null);
  const [passArrows, setPassArrows] = useState<PassArrow[]>([]);
  // 기록된 로그: dual 은 장면 단위 선택 → 불러오기/수정
  const [selectedSceneIndex, setSelectedSceneIndex] = useState<number | null>(null);
  // 수정용 피치 — 기록된 로그 아래 별도 편집 캔버스. 라이브(찍는) 데이터와 완전 분리해 유실 방지.
  const [editRows, setEditRows] = useState<LogPreview[]>([]);
  const [editLogs, setEditLogs] = useState<string[]>([]);
  const [editBeforeDots, setEditBeforeDots] = useState<PitchDot[]>([]);
  const [editAfterDots, setEditAfterDots] = useState<PitchDot[]>([]);
  const [editPassArrows, setEditPassArrows] = useState<PassArrow[]>([]);
  const [editPrimary, setEditPrimary] = useState<number | null>(null);
  // 드래그 종료(pointerup) 시점에 최신 화살표 좌표를 읽기 위한 미러 (render마다 동기 갱신)
  const passArrowsRef = useRef<PassArrow[]>(passArrows);
  passArrowsRef.current = passArrows;
  const editPassArrowsRef = useRef<PassArrow[]>(editPassArrows);
  editPassArrowsRef.current = editPassArrows;
  // undo 스냅샷용 최신 상태 미러 (이벤트 리스너의 stale closure 회피 — render마다 동기 갱신)
  const dualUndoStateRef = useRef<DualUndoSnapshot>({ beforeDots, afterDots, passArrows, rows, logs, primaryRowIndex, selectedRowIndex });
  dualUndoStateRef.current = { beforeDots, afterDots, passArrows, rows, logs, primaryRowIndex, selectedRowIndex };
  const dualUndoHistoryRef = useRef<DualUndoSnapshot[]>([]);
  const [editSelectedDot, setEditSelectedDot] = useState<SelectedDualDot | null>(null);
  const [editSelectedRowIndex, setEditSelectedRowIndex] = useState<number | null>(null);
  // 수정용 입력 상태 — 라이브 입력값과 분리 (과거 장면은 half/시간/공격방향이 지금 라이브와 다름). 레이어만 공유(activeLayer).
  const [editHalf, setEditHalf] = useState<'1H' | '2H'>('1H');
  const [editTeam, setEditTeam] = useState<'home' | 'away'>('home');
  const [editDirection, setEditDirection] = useState<'left' | 'right'>('right');
  const [editTimeline, setEditTimeline] = useState('00:00');
  const [editStatInput, setEditStatInput] = useState('');
  const [editPendingPass, setEditPendingPass] = useState<{ code: string; side: PitchSide; startId?: string; sx: number; sy: number; mx: number; my: number } | null>(null);
  // 수비 화살표 1차 클릭 대기 — 상대 볼 출발점을 찍으면 pendingPass 로 승격되어 2차 클릭에서 화살표 완성
  const [pendingDefStart, setPendingDefStart] = useState<{ code: string; side: PitchSide } | null>(null);
  const [editPendingDefStart, setEditPendingDefStart] = useState<{ code: string; side: PitchSide } | null>(null);
  // 화살표 그리는 중 커서 위치(viewBox 좌표) — 시작점→커서 고무줄 미리보기용
  const [arrowPreview, setArrowPreview] = useState<{ canvas: 'live' | 'edit'; side: PitchSide; x: number; y: number } | null>(null);

  // pendingDefStart(출발점 대기) / pendingPass(도착점 대기)를 피치 렌더가 쓰기 좋은 형태로 통합
  const liveArrowArm: ArrowArm | null = pendingPass
    ? { side: pendingPass.side, code: pendingPass.code, stage: 'end', sx: pendingPass.sx, sy: pendingPass.sy }
    : pendingDefStart
      ? { side: pendingDefStart.side, code: pendingDefStart.code, stage: 'start', sx: 0, sy: 0 }
      : null;
  const editArrowArm: ArrowArm | null = editPendingPass
    ? { side: editPendingPass.side, code: editPendingPass.code, stage: 'end', sx: editPendingPass.sx, sy: editPendingPass.sy }
    : editPendingDefStart
      ? { side: editPendingDefStart.side, code: editPendingDefStart.code, stage: 'start', sx: 0, sy: 0 }
      : null;

  const cancelArrowDraw = () => {
    if (!pendingPass && !pendingDefStart && !editPendingPass && !editPendingDefStart) return;
    setPendingPass(null);
    setPendingDefStart(null);
    setEditPendingPass(null);
    setEditPendingDefStart(null);
    setArrowPreview(null);
    setStatus('화살표 그리기 취소');
  };

  // 화살표 대기 중인 피치 위에서만 커서를 추적 (미리보기 선). 그 외에는 리렌더 없음
  const trackArrowPreview = (
    canvas: 'live' | 'edit',
    side: PitchSide,
    arm: ArrowArm | null,
    event: React.PointerEvent<HTMLDivElement>,
    rect: DOMRect | undefined,
  ) => {
    if (!arm || arm.side !== side || !rect) return;
    const c = dotFromClientPoint(event.clientX, event.clientY, rect);
    setArrowPreview({ canvas, side, x: c.screen_x, y: c.screen_y });
  };

  const armedLive = !!liveArrowArm;
  const armedEdit = !!editArrowArm;
  useEffect(() => {
    if (!armedLive && !armedEdit) setArrowPreview(null);
  }, [armedLive, armedEdit]);

  // 라이브·수정용 피치가 공유하는 화살표 오버레이 (기존 화살표 + 그리는 중 미리보기)
  const renderArrowOverlay = (canvas: 'live' | 'edit', side: PitchSide, arrows: PassArrow[], arm: ArrowArm | null) => {
    const armedHere = arm?.side === side;
    const previewHere = arrowPreview?.canvas === canvas && arrowPreview.side === side ? arrowPreview : null;
    if (!arrows.some((arrow) => arrow.side === side) && !armedHere) return null;
    const liveArrows = canvas === 'edit' ? editPassArrowsRef : passArrowsRef;
    const markerId = (kind: ArrowKind) => `fpa-arrowhead-${kind}-${canvas}-${side}`;
    const armColor = ARROW_COLORS[arm ? arrowKind(arm.code) : 'pass'];

    // 드래그 핸들 — 시작점/도착점 양끝. 점이 아니라 화살표 좌표만 움직이고, 놓으면 재채점
    const handle = (index: number, end: 'start' | 'end', cx: number, cy: number, color: string, fallback: PassArrow) => (
      <circle className="fpa-arrow-handle" cx={cx} cy={cy} fill={color} r={13} stroke={color}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          draggingArrowRef.current = { index, end, side, canvas, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={() => {
          const info = draggingArrowRef.current;
          if (info && info.canvas === canvas && info.index === index && info.moved) {
            void rescorePassArrow(canvas, liveArrows.current[index] ?? fallback);
          }
        }} />
    );

    return (
      <svg className="fpa-scene-arrows" preserveAspectRatio="none" viewBox="0 0 1050 680">
        <defs>
          {(Object.keys(ARROW_COLORS) as ArrowKind[]).map((kind) => (
            <marker id={markerId(kind)} key={kind} markerHeight="6" markerWidth="6" orient="auto" refX="4.5" refY="3">
              <path d="M0,0 L6,3 L0,6 Z" fill={ARROW_COLORS[kind]} />
            </marker>
          ))}
        </defs>
        {armedHere && arm?.stage === 'end' ? (
          <g className="fpa-arrow-preview">
            <circle className="fpa-arrow-start-marker" cx={arm.sx} cy={arm.sy} r={11} stroke={armColor} />
            {previewHere ? (
              <line markerEnd={`url(#${markerId(arrowKind(arm.code))})`} stroke={armColor} strokeDasharray="12 8"
                x1={arm.sx} y1={arm.sy} x2={previewHere.x} y2={previewHere.y} />
            ) : null}
          </g>
        ) : null}
        {arrows.map((arrow, index) => {
          if (arrow.side !== side) return null;
          const kind = arrowKind(arrow.code);
          const color = ARROW_COLORS[kind];
          const defense = kind === 'defense';
          return (
            <g key={`${canvas}-arrow-${side}-${index}`}>
              <line
                markerEnd={defense ? undefined : `url(#${markerId(kind)})`}
                stroke={color} strokeDasharray={defense ? '14 7' : undefined} strokeWidth={4}
                x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2} />
              {defense ? (
                // 상대 볼이 어디서 출발해(○) 어디서 끊겼는지(✕). 방향이 드러나므로 화살촉은 생략
                <g className="fpa-arrow-defense-caps" stroke={color}>
                  <circle cx={arrow.x1} cy={arrow.y1} fill={color} r={6} />
                  <line x1={arrow.x2 - 10} y1={arrow.y2 - 10} x2={arrow.x2 + 10} y2={arrow.y2 + 10} />
                  <line x1={arrow.x2 - 10} y1={arrow.y2 + 10} x2={arrow.x2 + 10} y2={arrow.y2 - 10} />
                </g>
              ) : null}
              {handle(index, 'start', arrow.x1, arrow.y1, color, arrow)}
              {handle(index, 'end', arrow.x2, arrow.y2, color, arrow)}
            </g>
          );
        })}
      </svg>
    );
  };

  // 화살표 중점의 코드 칩 — SVG는 preserveAspectRatio="none" 이라 글자가 늘어나므로 HTML 오버레이로 그린다
  const renderArrowChips = (side: PitchSide, arrows: PassArrow[]) =>
    arrows.map((arrow, index) => (arrow.side === side && arrow.code ? (
      <div
        className={`fpa-arrow-chip ${arrowKind(arrow.code)}`}
        key={`chip-${side}-${index}`}
        style={{
          left: `${((arrow.x1 + arrow.x2) / 2 / 1050) * 100}%`,
          top: `${((arrow.y1 + arrow.y2) / 2 / 680) * 100}%`,
        }}
      >
        {arrow.code}
      </div>
    ) : null));
  const [matchId, setMatchId] = useState('ID');
  const [teamIdH, setTeamIdH] = useState('Home');
  const [teamIdA, setTeamIdA] = useState('Away');
  const [matchIdError, setMatchIdError] = useState('');
  const [status, setStatus] = useState('실시간 입력 준비됨');
  const [busy, setBusy] = useState(false);
  const [availableMatches, setAvailableMatches] = useState<Match[]>([]);
  const [matchPickerOpen, setMatchPickerOpen] = useState(false);
  const [matchFilterClass, setMatchFilterClass] = useState('ALL');
  const [matchFilterRound, setMatchFilterRound] = useState('ALL');
  const isFutsal = fpaSport === 'FUTSAL';
  const activePitchSrc = PITCH_SRC;
  const activePitchLabel = isFutsal ? 'futsal pitch' : 'football field';

  const matchClassOptions = Array.from(new Set(availableMatches.map((m) => m.competition_class)))
    .sort((a, b) => a.localeCompare(b, 'ko'));
  const matchRoundOptions = Array.from(new Set(
    availableMatches
      .filter((m) => matchFilterClass === 'ALL' || m.competition_class === matchFilterClass)
      .map((m) => m.round_number)
  )).sort((a, b) => a - b);
  const filteredAvailableMatches = availableMatches.filter((m) =>
    (matchFilterClass === 'ALL' || m.competition_class === matchFilterClass) &&
    (matchFilterRound === 'ALL' || String(m.round_number) === matchFilterRound)
  );

  // 전체 로그 = 저장된 장면들(flatten) + 현재 버퍼 (single 은 savedScenes 비어 있어 = 현재 버퍼). 저장/내보내기용.
  const allLogs = [...savedScenes.flatMap((scene) => scene.logs), ...logs];
  const allRows = [...savedScenes.flatMap((scene) => scene.rows), ...rows];

  // 저장 대상 장면 = 이미 저장된 장면들 + 아직 버퍼에 있는 현재 장면.
  // 버퍼를 빼면 "장면 저장" 을 누르지 않고 클립 저장한 경우 마지막 장면이 통째로 날아간다.
  const collectScenesForPersistence = (): SavedScene[] => [
    ...savedScenes,
    ...(rows.length
      ? [{
        rows,
        logs,
        // 아직 "장면 저장" 을 안 거친 버퍼라 잔상이 남아 있을 수 있다 — 여기서 걷어낸다.
        // (savedScenes 는 saveScene 이 이미 걷어낸 상태다)
        beforeDots: realDots(beforeDots),
        afterDots: realDots(afterDots),
        passArrows,
        primary: primaryRowIndex,
        clipIndex: currentClipIndex,
      }]
      : []),
  ];

  const buildRowsForPersistence = () => {
    if (inputMode !== 'dual') return allRows;
    const scenesToPersist = collectScenesForPersistence();
    // match–clip–action: SceneIndex = 클립 번호, SceneActionIndex = 클립 안 연번.
    // 같은 클립의 여러 액션(장면)이 한 SceneIndex 로 묶여 다운스트림(클립 매칭)에 클립 단위로 전달된다.
    const actionCounters = new Map<number, number>();
    return scenesToPersist.flatMap((scene, sceneIndex) => {
      const clipIndex = scene.clipIndex ?? 1;
      const sceneState = sceneStateForPersistence(scene, sceneIndex + 1);
      return scene.rows.map((row) => {
        const nextSeq = (actionCounters.get(clipIndex) ?? 0) + 1;
        actionCounters.set(clipIndex, nextSeq);
        return {
          ...row,
          SceneIndex: String(clipIndex),
          SceneActionIndex: String(nextSeq),
          SceneState: sceneState,
        };
      });
    });
  };

  useEffect(() => {
    if (typeof window === 'undefined' || didHydrateRef.current) return;
    didHydrateRef.current = true;
    const raw = window.sessionStorage.getItem(FPA_DRAFT_STORAGE_KEY);
    if (!raw) return;

    try {
      const draft = JSON.parse(raw) as {
        half?: '1H' | '2H';
        team?: 'home' | 'away';
        direction?: 'left' | 'right';
        timeline?: string;
        statInput?: string;
        inputMode?: InputMode;
        activeLayer?: string;
        dots?: PitchDot[];
        beforeDots?: PitchDot[];
        afterDots?: PitchDot[];
        selectedDualDot?: SelectedDualDot | null;
        logs?: string[];
        rows?: LogPreview[];
        savedScenes?: SavedScene[];
        editingSceneIndex?: number | null;
        editRows?: LogPreview[];
        editLogs?: string[];
        editBeforeDots?: PitchDot[];
        editAfterDots?: PitchDot[];
        editPassArrows?: PassArrow[];
        editPrimary?: number | null;
        editHalf?: '1H' | '2H';
        editTeam?: 'home' | 'away';
        editDirection?: 'left' | 'right';
        editTimeline?: string;
        editStatInput?: string;
        passArrows?: PassArrow[];
        primaryRowIndex?: number | null;
        selectedRowIndex?: number | null;
        matchId?: string;
        teamIdH?: string;
        teamIdA?: string;
      };

      if (draft.half) setHalf(draft.half);
      if (draft.team) setTeam(draft.team);
      if (draft.direction) setDirection(draft.direction);
      if (draft.timeline) setTimeline(draft.timeline);
      if (typeof draft.statInput === 'string') setStatInput(draft.statInput);
      if (draft.inputMode) setInputMode(draft.inputMode);
      if (draft.activeLayer) {
        const legacyLayerMap: Record<string, string> = {
          atk: 'home_field',
          def: 'away_field',
          atk_gk: 'home_gk',
          def_gk: 'away_gk',
        };
        const layerKey = legacyLayerMap[draft.activeLayer] || draft.activeLayer;
        setActiveLayer(DUAL_LAYERS.some((layer) => layer.key === layerKey) ? layerKey : 'home_field');
      }
      if (Array.isArray(draft.dots)) setDots(draft.dots);
      if (Array.isArray(draft.beforeDots)) setBeforeDots(draft.beforeDots);
      if (Array.isArray(draft.afterDots)) setAfterDots(draft.afterDots);
      if (draft.selectedDualDot) setSelectedDualDot(draft.selectedDualDot);
      if (Array.isArray(draft.logs)) setLogs(draft.logs);
      if (Array.isArray(draft.rows)) setRows(draft.rows);
      if (Array.isArray(draft.savedScenes)) {
        setSavedScenes(draft.savedScenes);
        // 클립 번호 이어가기 — 구버전 초안(clipIndex 없음)은 전부 클립 1로 간주.
        setCurrentClipIndex(Math.max(1, ...draft.savedScenes.map((s) => s.clipIndex ?? 1)));
      }
      // 클립 복원(서버 fpa_scenes)이 이 초안을 덮어쓰지 않게 표시해 둔다 — 초안은 아직
      // 저장 안 한 작업일 수 있어서, 서버본으로 갈아치우면 그게 통째로 날아간다.
      if (draft.savedScenes?.length || draft.rows?.length) draftHadContentRef.current = true;
      if (typeof draft.editingSceneIndex === 'number' || draft.editingSceneIndex === null) setEditingSceneIndex(draft.editingSceneIndex ?? null);
      if (Array.isArray(draft.editRows)) setEditRows(draft.editRows);
      if (Array.isArray(draft.editLogs)) setEditLogs(draft.editLogs);
      if (Array.isArray(draft.editBeforeDots)) setEditBeforeDots(draft.editBeforeDots);
      if (Array.isArray(draft.editAfterDots)) setEditAfterDots(draft.editAfterDots);
      if (Array.isArray(draft.editPassArrows)) setEditPassArrows(draft.editPassArrows);
      if (typeof draft.editPrimary === 'number' || draft.editPrimary === null) setEditPrimary(draft.editPrimary ?? null);
      if (draft.editHalf) setEditHalf(draft.editHalf);
      if (draft.editTeam) setEditTeam(draft.editTeam);
      if (draft.editDirection) setEditDirection(draft.editDirection);
      if (draft.editTimeline) setEditTimeline(draft.editTimeline);
      if (typeof draft.editStatInput === 'string') setEditStatInput(draft.editStatInput);
      if (Array.isArray(draft.passArrows)) setPassArrows(draft.passArrows);
      if (typeof draft.primaryRowIndex === 'number' || draft.primaryRowIndex === null) setPrimaryRowIndex(draft.primaryRowIndex ?? null);
      if (typeof draft.selectedRowIndex === 'number' || draft.selectedRowIndex === null) {
        setSelectedRowIndex(draft.selectedRowIndex);
      }
      if (typeof draft.matchId === 'string') setMatchId(draft.matchId);
      if (typeof draft.teamIdH === 'string') setTeamIdH(draft.teamIdH);
      if (typeof draft.teamIdA === 'string') setTeamIdA(draft.teamIdA);
      setStatus('이전 입력 상태를 복구했습니다');
    } catch {
      window.sessionStorage.removeItem(FPA_DRAFT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !didHydrateRef.current) return;

    const hasDraft =
      logs.length > 0 ||
      rows.length > 0 ||
      savedScenes.length > 0 ||
      dots.length > 0 ||
      beforeDots.length > 0 ||
      afterDots.length > 0 ||
      inputMode !== 'single' ||
      activeLayer !== 'home_field' ||
      statInput.trim().length > 0 ||
      matchId !== 'ID' ||
      teamIdH !== 'Home' ||
      teamIdA !== 'Away';

    if (!hasDraft) {
      window.sessionStorage.removeItem(FPA_DRAFT_STORAGE_KEY);
      window.dispatchEvent(new CustomEvent(FPA_DRAFT_EVENT, { detail: { hasDraft: false } }));
      return;
    }

    const draft = {
      half,
      team,
      direction,
      timeline,
      statInput,
      inputMode,
      activeLayer,
      dots,
      beforeDots,
      afterDots,
      selectedDualDot,
      logs,
      rows,
      savedScenes,
      editingSceneIndex,
      editRows,
      editLogs,
      editBeforeDots,
      editAfterDots,
      editPassArrows,
      editPrimary,
      editHalf,
      editTeam,
      editDirection,
      editTimeline,
      editStatInput,
      passArrows,
      primaryRowIndex,
      selectedRowIndex,
      matchId,
      teamIdH,
      teamIdA,
    };
    window.sessionStorage.setItem(FPA_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    window.dispatchEvent(new CustomEvent(FPA_DRAFT_EVENT, { detail: { hasDraft: true } }));
  }, [afterDots, beforeDots, direction, dots, activeLayer, editAfterDots, editBeforeDots, editDirection, editHalf, editLogs, editPassArrows, editPrimary, editRows, editStatInput, editTeam, editTimeline, editingSceneIndex, half, inputMode, logs, matchId, passArrows, primaryRowIndex, rows, savedScenes, selectedDualDot, selectedRowIndex, statInput, team, teamIdA, teamIdH, timeline]);

  useEffect(() => {
    const logBody = logBodyRef.current;
    if (!logBody) return;
    logBody.scrollTop = logBody.scrollHeight;
  }, [rows.length]);

  const pitchDots = useMemo(
    () =>
      dots.map((dot, index) => ({
        ...dot,
        left: `${(dot.screen_x / 1050) * 100}%`,
        top: `${(dot.screen_y / 680) * 100}%`,
        label: String(index + 1),
      })),
    [dots]
  );

  const beforePitchDots = useMemo(
    () => buildRenderPitchDots(beforeDots),
    [beforeDots]
  );

  const afterPitchDots = useMemo(
    () => buildRenderPitchDots(afterDots),
    [afterDots]
  );

  const editBeforePitchDots = useMemo(
    () => buildRenderPitchDots(editBeforeDots),
    [editBeforeDots]
  );

  const editAfterPitchDots = useMemo(
    () => buildRenderPitchDots(editAfterDots),
    [editAfterDots]
  );

  const dualPointSummary = useMemo(() => {
    // 잔상은 아직 찍은 점이 아니다 — 개수에 넣으면 '몇 명 찍었나' 가 거짓이 된다.
    const beforeReal = realDots(beforeDots);
    const afterReal = realDots(afterDots);
    const beforeAllyCount = beforeReal.filter(isAllyDot).length;
    const afterAllyCount = afterReal.filter(isAllyDot).length;
    return {
      beforeAllyCount,
      beforeOpponentCount: beforeReal.length - beforeAllyCount,
      afterAllyCount,
      afterOpponentCount: afterReal.length - afterAllyCount,
    };
  }, [afterDots, beforeDots]);

  // 남은 잔상 수 — 라인업 컨트롤 라벨과 '잔상 지우기' 버튼 활성화에 쓴다.
  const beforeGhostCount = useMemo(() => beforeDots.filter((dot) => dot.ghost).length, [beforeDots]);

  const updateDualDot = (side: PitchSide, index: number, nextDot: PitchDot) => {
    const update = (prev: PitchDot[]) => prev.map((dot, dotIndex) => (dotIndex === index ? nextDot : dot));
    if (side === 'before') {
      setBeforeDots(update);
    } else {
      setAfterDots(update);
    }
  };

  const updateEditDot = (side: PitchSide, index: number, nextDot: PitchDot) => {
    const update = (prev: PitchDot[]) => prev.map((dot, dotIndex) => (dotIndex === index ? nextDot : dot));
    if (side === 'before') {
      setEditBeforeDots(update);
    } else {
      setEditAfterDots(update);
    }
  };

  // 라이브/수정 캔버스 점 선택은 상호 배타 — Delete 키가 엉뚱한 캔버스 점을 지우지 않도록
  const selectLiveDualDot = (sel: SelectedDualDot) => {
    setSelectedDualDot(sel);
    setEditSelectedDot(null);
  };

  const selectEditDot = (sel: SelectedDualDot) => {
    setEditSelectedDot(sel);
    setSelectedDualDot(null);
  };

  const assignNumberToLiveSelectedDot = (number: string) => {
    const sel = selectedDualDot;
    if (!sel) {
      setStatus('번호를 붙일 좌표를 먼저 선택하세요');
      return false;
    }
    const dotsArr = sel.side === 'before' ? beforeDots : afterDots;
    if (!dotsArr[sel.index]) {
      setStatus('선택된 좌표를 찾을 수 없습니다');
      return false;
    }
    // 행위자 번호는 아군(우리 팀) 점에만 — 상대(away) 점엔 절대 안 붙게
    if (!isAllyDot(dotsArr[sel.index])) {
      setStatus('행위자 번호는 아군 점에만 붙일 수 있습니다 (상대 점 선택됨)');
      return false;
    }
    pushDualUndo();
    const assign = (prev: PitchDot[]) =>
      prev.map((dot, index) => (index === sel.index ? { ...dot, number } : dot));
    if (sel.side === 'before') setBeforeDots(assign);
    else setAfterDots(assign);
    setStatInput('');
    setStatus(`${number}번을 ${sel.side === 'before' ? 'Before' : 'After'} 좌표에 할당했습니다`);
    requestAnimationFrame(() => statInputRef.current?.focus());
    return true;
  };

  const assignNumberToEditSelectedDot = (number: string) => {
    const sel = editSelectedDot;
    if (!sel) {
      setStatus('수정용 피치에서 번호를 붙일 좌표를 먼저 선택하세요');
      return false;
    }
    const dotsArr = sel.side === 'before' ? editBeforeDots : editAfterDots;
    if (!dotsArr[sel.index]) {
      setStatus('수정용 피치의 선택된 좌표를 찾을 수 없습니다');
      return false;
    }
    if (!isAllyDot(dotsArr[sel.index])) {
      setStatus('행위자 번호는 아군 점에만 붙일 수 있습니다 (상대 점 선택됨)');
      return false;
    }
    const assign = (prev: PitchDot[]) =>
      prev.map((dot, index) => (index === sel.index ? { ...dot, number } : dot));
    if (sel.side === 'before') setEditBeforeDots(assign);
    else setEditAfterDots(assign);
    setEditStatInput('');
    setStatus(`${number}번을 수정용 ${sel.side === 'before' ? 'Before' : 'After'} 좌표에 할당했습니다`);
    requestAnimationFrame(() => editStatInputRef.current?.focus());
    return true;
  };

  const handlePitchClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = pitchRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nextDot = dotFromClientPoint(event.clientX, event.clientY, rect);
    setDots((prev) => [...prev, nextDot]);
    statInputRef.current?.focus();
  };

  const handleDualPitchClick = (side: PitchSide, event: React.MouseEvent<HTMLDivElement>) => {
    const rect = (side === 'before' ? beforePitchRef.current : afterPitchRef.current)?.getBoundingClientRect();
    if (!rect) return;
    // 패스 도착점 대기 중 + 같은 프레임이면 → 새 점이 아니라 화살표 끝점 + [시작,도착] 2점으로 채점
    if (pendingPass && pendingPass.side === side) {
      const c = dotFromClientPoint(event.clientX, event.clientY, rect);
      pushDualUndo();
      const arrow = { side, startId: pendingPass.startId, x1: pendingPass.sx, y1: pendingPass.sy, x2: c.screen_x, y2: c.screen_y, code: pendingPass.code, rowIndex: rows.length };
      setPassArrows((prev) => [...prev, arrow]);
      // 패스(리시버 번호가 있는 코드)면 이 클릭이 곧 리시버가 받은 자리다.
      // 잔상으로 남아 있으면 여기서 활성화해 그 좌표에 앉힌다 — 안 그러면 리시버가
      // 프레임에서 통째로 빠져 압박·PC 가 실제와 달라진다.
      const receiverNum = statInputReceiverNumber(pendingPass.code);
      if (receiverNum) settleReceiverGhost(side, receiverNum, c);
      const start: PitchDot = { meter_x: pendingPass.mx, meter_y: pendingPass.my, screen_x: pendingPass.sx, screen_y: pendingPass.sy };
      const end: PitchDot = { meter_x: c.meter_x, meter_y: c.meter_y, screen_x: c.screen_x, screen_y: c.screen_y };
      const code = pendingPass.code;
      setPendingPass(null);
      void scorePass(code, start, end);
      return;
    }
    // 수비 화살표 1차 클릭 = 상대 볼 출발점 → pendingPass 로 승격(2차 클릭에서 화살표 완성)
    if (pendingDefStart && pendingDefStart.side === side) {
      const c = dotFromClientPoint(event.clientX, event.clientY, rect);
      setPendingPass({ code: pendingDefStart.code, side, sx: c.screen_x, sy: c.screen_y, mx: c.meter_x, my: c.meter_y });
      setPendingDefStart(null);
      setStatus(`${arrowArmHint(pendingDefStart.code, 'end')} · Esc 취소`);
      return;
    }
    const nextDot: PitchDot = {
      id: newDotId(),
      ...dotFromClientPoint(event.clientX, event.clientY, rect),
      team: relationForTeamSide(currentLayer.teamSide, team),
      teamSide: currentLayer.teamSide,
      layer: currentLayer.key,
      role: currentLayer.role,
      color: currentLayer.color,
    };
    pushDualUndo();
    const place = (prev: PitchDot[]) => {
      const index = prev.length;
      selectLiveDualDot({ side, index });
      return [...prev, nextDot];
    };
    if (side === 'before') setBeforeDots(place);
    else setAfterDots(place);
    // 익명 점 생성 후 stat input 자동 포커스 (xFP/fpa: 점 찍고 바로 코드 입력)
    requestAnimationFrame(() => statInputRef.current?.focus());
  };

  const removeLastDot = () => {
    setDots((prev) => prev.slice(0, -1));
  };

  // 라이브 dual 캔버스를 바꾸는 모든 조작 직전에 호출 — 현재 상태를 undo 스택에 push (최대 50단계)
  const pushDualUndo = () => {
    dualUndoHistoryRef.current = [...dualUndoHistoryRef.current.slice(-49), { ...dualUndoStateRef.current }];
  };

  // 장면 저장/새 장면/불러오기 등 장면 경계에서 undo 스택 비움 (장면을 넘나드는 undo 방지)
  const resetDualUndo = () => {
    dualUndoHistoryRef.current = [];
  };

  const undoDual = () => {
    if (busy) {
      setStatus('채점 중에는 되돌릴 수 없습니다');
      return;
    }
    const stack = dualUndoHistoryRef.current;
    const snap = stack[stack.length - 1];
    if (!snap) {
      setStatus('되돌릴 조작이 없습니다');
      return;
    }
    dualUndoHistoryRef.current = stack.slice(0, -1);
    setBeforeDots(snap.beforeDots);
    setAfterDots(snap.afterDots);
    setPassArrows(snap.passArrows);
    setRows(snap.rows);
    setLogs(snap.logs);
    setPrimaryRowIndex(snap.primaryRowIndex);
    setSelectedRowIndex(snap.selectedRowIndex);
    setSelectedDualDot(null);
    setPendingPass(null);
    setPendingDefStart(null);
    setStatus('마지막 조작을 되돌렸습니다');
  };

  const removeSelectedDualDot = () => {
    if (!selectedDualDot) return;
    const sel = selectedDualDot;
    const dotsArr = sel.side === 'before' ? beforeDots : afterDots;
    if (!dotsArr[sel.index]) return;
    pushDualUndo();
    const removedId = dotsArr[sel.index]?.id;
    const removeAt = (prev: PitchDot[]) => prev.filter((_, index) => index !== sel.index);
    if (sel.side === 'before') {
      setBeforeDots(removeAt);
    } else {
      setAfterDots(removeAt);
    }
    if (removedId) setPassArrows((prev) => prev.filter((arrow) => !arrowBelongsToRemovedDot(arrow, sel.side, removedId)));
    draggingDualDotRef.current = null;
    setSelectedDualDot(null);
    setStatus('선택한 dual pitch 좌표 삭제');
  };

  const removeDualDotAt = (side: PitchSide, index: number) => {
    const dotsArr = side === 'before' ? beforeDots : afterDots;
    if (!dotsArr[index]) return;
    pushDualUndo();
    const removedId = dotsArr[index]?.id;
    if (side === 'before') setBeforeDots((prev) => prev.filter((_, i) => i !== index));
    else setAfterDots((prev) => prev.filter((_, i) => i !== index));
    // 그 점에 딸린 패스 화살표도 함께 삭제
    if (removedId) setPassArrows((prev) => prev.filter((arrow) => !arrowBelongsToRemovedDot(arrow, side, removedId)));
    // 삭제로 인덱스가 당겨지므로, 진행 중이던 드래그 arming은 무효화 (다른 점이 끌려오는 것 방지)
    draggingDualDotRef.current = null;
    setSelectedDualDot(null);
    setStatus('점 삭제');
  };

  const removeLastDualDot = (side: PitchSide) => {
    const dotsArr = side === 'before' ? beforeDots : afterDots;
    if (!dotsArr.length) return;
    // 잔상은 '마지막 점' 이 아니다 — 라인업을 깔아두면 배열 끝이 전부 잔상이라
    // Undo 성격의 이 삭제가 실제로 찍은 점을 못 지우게 된다. 마지막 실제 점을 지운다.
    let lastIndex = dotsArr.length - 1;
    while (lastIndex >= 0 && dotsArr[lastIndex].ghost) lastIndex -= 1;
    if (lastIndex < 0) return;
    pushDualUndo();
    const removedId = dotsArr[lastIndex]?.id;
    const drop = (prev: PitchDot[]) => prev.filter((_, index) => index !== lastIndex);
    if (side === 'before') {
      setBeforeDots(drop);
    } else {
      setAfterDots(drop);
    }
    if (removedId) setPassArrows((prev) => prev.filter((arrow) => !arrowBelongsToRemovedDot(arrow, side, removedId)));
    draggingDualDotRef.current = null;
    setSelectedDualDot(null);
  };

  const clearDualDots = (side: PitchSide) => {
    const sideDots = side === 'before' ? beforeDots : afterDots;
    if (!sideDots.length && !passArrows.some((arrow) => arrow.side === side)) return;
    pushDualUndo();
    const clearedIds = new Set(sideDots.map((dot) => dot.id).filter(Boolean));
    setPassArrows((prev) => prev.filter((arrow) => {
      if (arrow.side === side) return false;
      if (side === 'before' && arrow.startId && clearedIds.has(arrow.startId)) return false;
      return true;
    }));
    if (side === 'before') {
      setBeforeDots([]);
    } else {
      setAfterDots([]);
    }
    setSelectedDualDot(null);
  };

  // 선택한 점의 '확인필요' 표시를 켜고 끈다.
  // 영상으로 등번호를 확정하지 못해 추측으로 찍었을 때 쓴다 — 표시는 저장·전송에
  // 함께 실려 앱이 "이 액션의 등번호는 확실하지 않다" 를 알 수 있게 한다.
  // 장면 수정 캔버스가 열려 있으면 그쪽 선택을, 아니면 라이브 선택을 대상으로 한다.
  const toggleDotNeedsCheck = () => {
    const editing = editingSceneIndex != null && editSelectedDot;
    const sel = editing ? editSelectedDot : selectedDualDot;
    if (!sel) {
      setStatus('확인필요를 표시할 점을 먼저 클릭하세요');
      return;
    }
    const dots = editing
      ? (sel.side === 'before' ? editBeforeDots : editAfterDots)
      : (sel.side === 'before' ? beforeDots : afterDots);
    const target = dots[sel.index];
    if (!target) return;
    const next = !target.needsCheck;
    const apply = (prev: PitchDot[]) =>
      prev.map((dot, index) => (index === sel.index ? { ...dot, needsCheck: next } : dot));
    if (editing) {
      if (sel.side === 'before') setEditBeforeDots(apply);
      else setEditAfterDots(apply);
    } else {
      pushDualUndo();
      if (sel.side === 'before') setBeforeDots(apply);
      else setAfterDots(apply);
    }
    const who = target.number ? `${target.number}번` : '번호 없는 점';
    setStatus(next
      ? `확인필요 표시 — ${who} · 등번호가 확실하지 않다는 뜻으로 앱까지 전달됩니다`
      : `확인필요 해제 — ${who}`);
  };

  const copyBeforeToAfter = () => {
    // 잔상은 넘기지 않는다 — After 는 '액션이 끝난 시점의 실제 위치' 프레임이다.
    const beforeReal = realDots(beforeDots);
    if (!beforeReal.length) {
      setStatus('Before 에 활성화된 점이 없습니다 — 잔상을 클릭해 활성화하세요');
      return;
    }
    pushDualUndo();
    const { dots: nextAfterDots, idMap } = clonePitchDotsWithIdMap(beforeReal);
    // 패스·수비(상대 공 경로) 화살표 모두 after 에 동일하게 복사 (2026-07-20: 수비 제외하던 규칙 폐기)
    const nextAfterArrows = mirroredBeforeArrowsForAfter(passArrows, idMap);
    setAfterDots(nextAfterDots);
    setPassArrows((prev) => [...prev.filter((arrow) => arrow.side !== 'after'), ...nextAfterArrows]);
    setSelectedDualDot(null);
    setStatus('Before 좌표와 패스 화살표를 After로 복사했습니다');
  };

  // 현재 작업 캔버스+버퍼 비우기 (저장/새장면/불러오기 공용)
  const clearCurrentScene = () => {
    resetDualUndo();
    // 미완료 xGOT 대기가 남으면 다음 장면의 모든 입력이 가드에 막힌다 — 장면 경계에서 자동 해제(=skip)
    if (pendingXgot?.canvas === 'live') resetXgotState();
    setRows([]);
    setLogs([]);
    setPrimaryRowIndex(null);
    setSelectedRowIndex(null);
    setBeforeDots([]);
    setAfterDots([]);
    setSelectedDualDot(null);
    setPendingPass(null);
    setPendingDefStart(null);
    setPassArrows([]);
  };

  // 장면 저장: 저장 시점의 최종 before/after(+화살표)로 이 장면의 모든 액션을 재채점한 뒤 스냅샷을 savedScenes 에 append.
  //  → 코드 입력 순서와 무관하게 이동 액션(드리블/침투) 경로·획득 t/f 가 최종 좌표 기준으로 확정됨.
  const saveScene = async () => {
    if (!rows.length) {
      setStatus('저장할 액션이 없습니다');
      return;
    }
    setBusy(true);
    setStatus('액션 저장 · 최종 좌표로 재채점 중…');
    const beforeReal = realDots(beforeDots);
    const afterReal = realDots(afterDots);
    const { rows: scoredRows, logs: scoredLogs } = await rescoreSceneRows(rows, logs, {
      before: beforeReal,
      after: afterReal,
      arrows: passArrows,
      actorTeam: team,
      half,
      direction,
      timeline,
      primary: primaryRowIndex,
    });
    const snapshot: SavedScene = { rows: scoredRows, logs: scoredLogs, beforeDots: beforeReal, afterDots: afterReal, passArrows, primary: primaryRowIndex, clipIndex: currentClipIndex };
    // 다음 장면의 Before = 이 장면의 After(실제 점) + 나머지 선수의 '자리 기억'(잔상).
    //
    // 잔상뿐 아니라 **이번에 활성화했던 선수도 잔상으로 되돌려** 넘긴다. 안 그러면
    // After 로 복사하지 않은 채 저장했을 때 그 선수가 통째로 사라져, 다음 액션에서
    // 라인업을 다시 깔아야 한다. 잔상으로 넘기면 마지막에 놓아둔 위치는 그대로 남고,
    // 새 액션에 실제로 나오는지는 태거가 클릭으로 다시 확인하게 된다.
    //
    // 라인업 잔상을 쓰는 중일 때만 넘긴다 — 잔상 없이 수기로 찍는 기존 흐름은 그대로.
    const nextRealDots = clonePitchDotsForNextScene(afterReal);
    const carriedKeys = new Set(nextRealDots.map(dotRosterKey).filter(Boolean) as string[]);
    const usingLineupGhosts = beforeDots.some((dot) => dot.ghost);
    const nextGhostDots = usingLineupGhosts
      ? clonePitchDotsForNextScene(
        // 등번호가 붙은 점만 — 번호 없는 수기 마커까지 잔상으로 남기면 피치가 지저분해진다.
        beforeDots.filter((dot) => {
          const key = dotRosterKey(dot);
          return Boolean(key) && !carriedKeys.has(key as string);
        }),
      ).map((dot) => ({ ...dot, ghost: true }))
      : [];
    const nextBeforeDots = [...nextRealDots, ...nextGhostDots];
    // 저장으로 행이 확정되면 남은 xGOT 대기는 갱신할 행이 없다 — 해제 안 하면 다음 장면 입력이 잠김
    if (pendingXgot?.canvas === 'live') resetXgotState();
    resetDualUndo();
    setSavedScenes((prev) => [...prev, snapshot]);
    setRows([]);
    setLogs([]);
    setPrimaryRowIndex(null);
    setSelectedRowIndex(null);
    setBeforeDots(nextBeforeDots);
    setAfterDots([]);
    setSelectedDualDot(null);
    setPendingPass(null);
    setPendingDefStart(null);
    setPassArrows([]);
    setBusy(false);
    setStatus(`클립 ${currentClipIndex}에 액션 저장됨 · 최종 좌표로 재채점 완료 — After 좌표를 다음 Before로 복사했습니다`);
    // 저장 버튼 클릭으로 포커스가 버튼에 남는다 — 바로 다음 코드 타이핑이 되도록 입력창으로 복귀
    requestAnimationFrame(() => statInputRef.current?.focus());
  };

  // 새 액션: 저장 안 한 현재 액션을 버리고 새로 시작
  const startNewScene = () => {
    clearCurrentScene();
    setStatus('현재 액션 비움 (미저장)');
    requestAnimationFrame(() => statInputRef.current?.focus());
  };

  // 불러오기: 선택한 저장 장면을 기록된 로그 아래 "수정용 피치"로 복원 — 라이브 캔버스(찍는 데이터)는 안 건드림
  const loadSelectedScene = () => {
    if (selectedSceneIndex == null) return;
    const scene = savedScenes[selectedSceneIndex];
    if (!scene) return;
    const header = scene.logs[0]?.split(' | ') || [];
    const nextEditHalf = header[0] === '1H' || header[0] === '2H' ? header[0] : half;
    const nextEditTeam = header[1] === 'home' || header[1] === 'away' ? header[1] : team;
    const nextEditDirection = header[2] === 'left' || header[2] === 'right' ? header[2] : direction;
    const nextEditTimeline = /^\d{1,3}:\d{2}$/.test(header[3] || '') ? header[3] : timeline;
    setEditRows(scene.rows);
    setEditLogs(scene.logs);
    setEditBeforeDots(hydrateSceneDots(scene.beforeDots, scene.logs, 'before', nextEditTeam).map((dot) => ({ ...dot })));
    setEditAfterDots(hydrateSceneDots(scene.afterDots, scene.logs, 'after', nextEditTeam).map((dot) => ({ ...dot })));
    setEditPassArrows(scene.passArrows.map((arrow) => ({ ...arrow })));
    setEditPrimary(scene.primary);
    setEditingSceneIndex(selectedSceneIndex);
    setEditSelectedDot(null);
    setEditSelectedRowIndex(null);
    // 수정용 입력값 시드: 로그 헤더(half | team | direction | timeline)에서 복원, 없으면 라이브 현재값
    setEditHalf(nextEditHalf);
    setEditTeam(nextEditTeam);
    setEditDirection(nextEditDirection);
    setEditTimeline(nextEditTimeline);
    setEditStatInput('');
    setEditPendingPass(null);
    setEditPendingDefStart(null);
    setStatus(`액션 ${selectedSceneIndex + 1} 수정용 피치로 불러옴 — 아래에서 수정 후 "수정 저장"`);
  };

  // 수정용 피치 닫기 (저장 안 한 편집은 버림 — 라이브 데이터와 무관)
  const closeSceneEditor = () => {
    setEditingSceneIndex(null);
    setEditRows([]);
    setEditLogs([]);
    setEditBeforeDots([]);
    setEditAfterDots([]);
    setEditPassArrows([]);
    setEditPrimary(null);
    setEditSelectedDot(null);
    setEditSelectedRowIndex(null);
    setEditStatInput('');
    setEditPendingPass(null);
    setEditPendingDefStart(null);
    if (pendingXgot?.canvas === 'edit') resetXgotState();
  };

  const deleteSelectedScene = () => {
    if (selectedSceneIndex == null) return;
    const removedIndex = selectedSceneIndex;
    setSavedScenes((prev) => prev.filter((_, index) => index !== removedIndex));
    setSelectedSceneIndex(null);
    if (editingSceneIndex === removedIndex) {
      closeSceneEditor();
    } else if (editingSceneIndex != null && editingSceneIndex > removedIndex) {
      setEditingSceneIndex(editingSceneIndex - 1);
    }
    setStatus(`액션 ${removedIndex + 1} 삭제됨`);
  };

  // 기록된 로그 전체 삭제 — 저장된 장면 + 현재 작업 장면(캔버스 포함) 모두 비움. 서버에 저장된 데이터는 안 건드림.
  const clearAllRecordedLogs = () => {
    if (!allLogs.length && !savedScenes.length) return;
    const detail = inputMode === 'dual'
      ? `액션 ${savedScenes.length}개 · 로그 ${allLogs.length}건`
      : `액션 ${allLogs.length}건`;
    if (!window.confirm(`기록된 로그를 전체 삭제할까요? (${detail})\n삭제하면 되돌릴 수 없습니다.`)) return;
    setSavedScenes([]);
    setSelectedSceneIndex(null);
    setCurrentClipIndex(1);
    closeSceneEditor();
    clearCurrentScene();
    setDots([]);
    setStatus('기록된 로그 전체 삭제됨');
  };

  // 수정 저장: 편집 중 장면을 최종 좌표로 재채점 후 제자리 덮어쓰기 (순서 유지)
  const saveEditedScene = async () => {
    if (editingSceneIndex == null) return;
    if (!editRows.length) {
      setStatus('액션에 행이 없습니다 — 빈 액션은 저장할 수 없습니다');
      return;
    }
    const savedIndex = editingSceneIndex;
    setBusy(true);
    setStatus('수정 저장 · 최종 좌표로 재채점 중…');
    const { rows: scoredRows, logs: scoredLogs } = await rescoreSceneRows(editRows, editLogs, {
      before: editBeforeDots,
      after: editAfterDots,
      arrows: editPassArrows,
      actorTeam: editTeam,
      half: editHalf,
      direction: editDirection,
      timeline: editTimeline,
      primary: editPrimary,
    });
    const snapshot: SavedScene = {
      rows: scoredRows,
      logs: scoredLogs,
      beforeDots: editBeforeDots,
      afterDots: editAfterDots,
      passArrows: editPassArrows,
      primary: editPrimary,
    };
    setSavedScenes((prev) => prev.map((scene, index) => (index === savedIndex ? snapshot : scene)));
    setBusy(false);
    setStatus(`액션 ${savedIndex + 1} 수정 저장됨 · 최종 좌표로 재채점 완료`);
    closeSceneEditor();
  };

  const handleEditPitchClick = (side: PitchSide, event: React.MouseEvent<HTMLDivElement>) => {
    const rect = (side === 'before' ? editBeforePitchRef.current : editAfterPitchRef.current)?.getBoundingClientRect();
    if (!rect) return;
    // 패스 도착점 대기 중 + 같은 프레임이면 → 새 점이 아니라 화살표 끝점 + [시작,도착] 2점으로 채점 (라이브와 동일)
    if (editPendingPass && editPendingPass.side === side) {
      const c = dotFromClientPoint(event.clientX, event.clientY, rect);
      const arrow = { side, startId: editPendingPass.startId, x1: editPendingPass.sx, y1: editPendingPass.sy, x2: c.screen_x, y2: c.screen_y, code: editPendingPass.code, rowIndex: editRows.length };
      setEditPassArrows((prev) => [...prev, arrow]);
      const start: PitchDot = { meter_x: editPendingPass.mx, meter_y: editPendingPass.my, screen_x: editPendingPass.sx, screen_y: editPendingPass.sy };
      const end: PitchDot = { meter_x: c.meter_x, meter_y: c.meter_y, screen_x: c.screen_x, screen_y: c.screen_y };
      const code = editPendingPass.code;
      setEditPendingPass(null);
      void scoreEditPass(code, start, end);
      return;
    }
    // 수비 화살표 1차 클릭 = 상대 볼 출발점 → editPendingPass 로 승격 (라이브와 동일)
    if (editPendingDefStart && editPendingDefStart.side === side) {
      const c = dotFromClientPoint(event.clientX, event.clientY, rect);
      setEditPendingPass({ code: editPendingDefStart.code, side, sx: c.screen_x, sy: c.screen_y, mx: c.meter_x, my: c.meter_y });
      setEditPendingDefStart(null);
      setStatus(`수정용: ${arrowArmHint(editPendingDefStart.code, 'end')} · Esc 취소`);
      return;
    }
    const nextDot: PitchDot = {
      id: newDotId(),
      ...dotFromClientPoint(event.clientX, event.clientY, rect),
      team: relationForTeamSide(currentLayer.teamSide, editTeam),
      teamSide: currentLayer.teamSide,
      layer: currentLayer.key,
      role: currentLayer.role,
      color: currentLayer.color,
    };
    const place = (prev: PitchDot[]) => {
      selectEditDot({ side, index: prev.length });
      return [...prev, nextDot];
    };
    if (side === 'before') setEditBeforeDots(place);
    else setEditAfterDots(place);
    requestAnimationFrame(() => editStatInputRef.current?.focus());
  };

  const removeEditDotAt = (side: PitchSide, index: number) => {
    const dotsArr = side === 'before' ? editBeforeDots : editAfterDots;
    if (index < 0 || !dotsArr[index]) return;
    const removedId = dotsArr[index]?.id;
    if (side === 'before') setEditBeforeDots((prev) => prev.filter((_, i) => i !== index));
    else setEditAfterDots((prev) => prev.filter((_, i) => i !== index));
    if (removedId) setEditPassArrows((prev) => prev.filter((arrow) => !arrowBelongsToRemovedDot(arrow, side, removedId)));
    draggingDualDotRef.current = null;
    setEditSelectedDot(null);
    setStatus('수정용 피치 점 삭제');
  };

  const removeLastEditDot = (side: PitchSide) => {
    const dotsArr = side === 'before' ? editBeforeDots : editAfterDots;
    removeEditDotAt(side, dotsArr.length - 1);
  };

  const clearEditDots = (side: PitchSide) => {
    const clearedIds = new Set((side === 'before' ? editBeforeDots : editAfterDots).map((dot) => dot.id).filter(Boolean));
    setEditPassArrows((prev) => prev.filter((arrow) => {
      if (arrow.side === side) return false;
      if (side === 'before' && arrow.startId && clearedIds.has(arrow.startId)) return false;
      return true;
    }));
    if (side === 'before') setEditBeforeDots([]);
    else setEditAfterDots([]);
    setEditSelectedDot(null);
  };

  // 수정용 장면의 액션 삭제 + primary/선택 인덱스 동기화
  const removeEditLogAt = (removedIdx: number) => {
    setEditLogs((prev) => prev.filter((_, index) => index !== removedIdx));
    setEditRows((prev) => prev.filter((_, index) => index !== removedIdx));
    setEditSelectedRowIndex((sel) => (sel == null ? null : sel === removedIdx ? null : sel > removedIdx ? sel - 1 : sel));
    setEditPrimary((p) => (p == null ? p : p === removedIdx ? null : p > removedIdx ? p - 1 : p));
    setStatus('수정용 액션 행 삭제');
  };

  const resetXgotState = () => {
    setPendingXgot(null);
    setGoalmouthPoint(null);
    setXgotEstimate(null);
  };

  const finishXgotFlow = (message: string, canvas: 'live' | 'edit' = 'live') => {
    resetXgotState();
    if (canvas === 'live') {
      setSelectedDualDot(null);
    }
    setStatus(message);
    window.setTimeout(() => (canvas === 'edit' ? editStatInputRef : statInputRef).current?.focus(), 0);
  };

  const handleGoalmouthClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const targetRect = event.currentTarget.getBoundingClientRect();
    // 좌표는 골대 프레임 기준 — 프레임 바깥 클릭(빗나간 위치)은 0~1 범위 밖 값으로 기록
    const frameRect = goalmouthFrameRef.current?.getBoundingClientRect() || targetRect;
    const x = (event.clientX - frameRect.left) / frameRect.width;
    const y = 1 - (event.clientY - frameRect.top) / frameRect.height;
    const viewX = Math.min(Math.max((event.clientX - targetRect.left) / targetRect.width, 0), 1);
    const viewY = Math.min(Math.max((event.clientY - targetRect.top) / targetRect.height, 0), 1);
    const nextPoint = {
      x: Number(x.toFixed(3)),
      y: Number(y.toFixed(3)),
      viewX: Number(viewX.toFixed(3)),
      viewY: Number(viewY.toFixed(3)),
    };
    setGoalmouthPoint(nextPoint);
    setXgotEstimate(null);
    void requestXgotEstimate(nextPoint);
  };

  const skipXgotInput = () => {
    finishXgotFlow('xGOT 입력을 건너뛰고 피치로 복귀했습니다', pendingXgot?.canvas ?? 'live');
  };

  const requestXgotEstimate = async (pointOverride?: GoalmouthPoint) => {
    if (!pendingXgot) return null;
    const shotPoint = pointOverride || goalmouthPoint;
    if (!shotPoint) {
      setStatus('골문 위치를 먼저 클릭하세요');
      return null;
    }

    setXgotBusy(true);
    setStatus('xGOT 자동 계산 중');
    try {
      const response = await apiFetch('/xgot/estimate', {
        method: 'POST',
        body: JSON.stringify({
          xg: pendingXgot.xg,
          is_on_target: pendingXgot.isOnTarget,
          goalmouth_x: shotPoint.x,
          goalmouth_y: shotPoint.y,
          is_goal: pendingXgot.isGoal,
          is_header: pendingXgot.isHeader,
          is_weak_foot: pendingXgot.isWeakFoot,
          under_pressure: pendingXgot.underPressure,
          one_on_one: pendingXgot.oneOnOne,
          shot_pace_band: 'MID',
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || 'xGOT 계산 실패');
        return null;
      }

      const data = await response.json() as { xgot: number; delta: number; label: string };
      setXgotEstimate(data);
      setStatus(pendingXgot.isOnTarget
        ? `xGOT=${Number(data.xgot).toFixed(3)} 자동 산출 완료`
        : `빗나간 위치 (${shotPoint.x.toFixed(3)}, ${shotPoint.y.toFixed(3)}) 선택됨 — Save로 기록`);
      return data;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'xGOT 계산 실패');
      return null;
    } finally {
      setXgotBusy(false);
    }
  };

  const submitXgotInput = async () => {
    if (!pendingXgot) return;
    const estimate = xgotEstimate || await requestXgotEstimate();
    if (!estimate) return;

    try {
      setXgotBusy(true);
      const xgot = Number(estimate.xgot).toFixed(3);
      const xg = pendingXgot.xg.toFixed(3);
      const goalmouthText = goalmouthPoint ? `(${goalmouthPoint.x.toFixed(3)}, ${goalmouthPoint.y.toFixed(3)})` : '';
      const setTargetLogs = pendingXgot.canvas === 'edit' ? setEditLogs : setLogs;
      const setTargetRows = pendingXgot.canvas === 'edit' ? setEditRows : setRows;
      // 앱 전송용 x,y,direction 형식을 로그·row 양쪽에 동일하게 기록
      const goalMouth = goalmouthPoint
        ? `${goalmouthPoint.x.toFixed(3)},${goalmouthPoint.y.toFixed(3)},${direction}`
        : undefined;
      setTargetLogs((prev) => prev.map((log, index) => {
        if (index !== pendingXgot.rowIndex) return log;
        const merged = mergeMetricsIntoLog(log, { xG: xg, xGOT: xgot });
        return goalMouth ? mergeGoalmouthIntoLog(merged, goalMouth) : merged;
      }));
      setTargetRows((prev) => prev.map((row, index) => (
        index === pendingXgot.rowIndex
          ? { ...row, xG: xg, xGOT: xgot, ...(goalMouth ? { GoalMouth: goalMouth } : {}) }
          : row
      )));
      finishXgotFlow(
        pendingXgot.isOnTarget
          ? `xGOT=${xgot} 입력 완료 (${estimate.delta >= 0 ? '+' : ''}${estimate.delta}, ${estimate.label})`
          : `빗나간 위치 ${goalmouthText} 기록 완료 (xGOT=0)`,
        pendingXgot.canvas,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'xGOT 계산 실패');
    } finally {
      setXgotBusy(false);
    }
  };

  // 특정 코드에 대해 before/after에서 제출용 좌표를 뽑는 공용 로직 (라이브 제출 + 저장 시 재채점 공용)
  const submitDotsForCode = (code: string, before: PitchDot[], after: PitchDot[]): PitchDot[] => {
    const beforeAllies = before.filter(isAllyDot);
    const afterAllies = after.filter(isAllyDot);
    // pn/dribble 등 이동 액션: 첫 ally([0])가 아니라 코드 앞번호(행위자)와 일치하는 점을 before·after에서 골라 변위 계산
    const actorNum = code.trim().match(/^(\d+)/)?.[1];
    const pickActor = (arr: PitchDot[]) => (actorNum && arr.find((dot) => dot.number === actorNum)) || arr[0];
    // 패스/크로스: 행위자·리시버 번호가 찍혀 있으면 그 두 점을 쓴다.
    // 라인업을 미리 깔면 아군 점이 11개라, 앞의 두 점을 집던 예전 방식은 엉뚱한 좌표를 골랐다.
    if (statInputHasReceiver(code)) {
      const receiverNum = statInputReceiverNumber(code);
      const start = (actorNum && beforeAllies.find((dot) => dot.number === actorNum)) || beforeAllies[0];
      const end = (receiverNum && beforeAllies.find((dot) => dot.number === receiverNum && dot !== start))
        || (receiverNum && afterAllies.find((dot) => dot.number === receiverNum))
        || beforeAllies.find((dot) => dot !== start);
      if (start && end) return [start, end];
      if (beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    }
    // 이동 액션은 시작=before 행위자, 도착=after 행위자. 입력 시점엔 after 가 아직 없으므로
    // [시작, 시작] 으로 임시 채점하고, 장면 저장 시 rescoreSceneRows 가 프레임으로 확정한다.
    if (statInputIsMoveAction(code)) {
      const start = beforeAllies.length ? pickActor(beforeAllies) : pickActor(afterAllies);
      if (!start) return [];
      const end = beforeAllies.length && afterAllies.length ? pickActor(afterAllies) : start;
      return [start, end];
    }
    // 슛: 행위자 점만 — slice(0,2) 폴백으로 떨어지면 마지막 점(팀메이트/마커)이 슛 위치가 됨
    if (statInputIsShotAction(code)) {
      const start = beforeAllies.length ? pickActor(beforeAllies) : pickActor(afterAllies);
      if (!start) return [];
      const end = beforeAllies.length && afterAllies.length ? pickActor(afterAllies) : null;
      return end ? [start, end] : [start];
    }
    if (beforeAllies.length && afterAllies.length) return [pickActor(beforeAllies), pickActor(afterAllies)];
    if (beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    if (afterAllies.length >= 2) return afterAllies.slice(0, 2);
    return [...beforeAllies, ...afterAllies];
  };

  const buildDualSubmitDots = () => {
    if (inputMode !== 'dual') return dots;
    return submitDotsForCode(statInput, realDots(beforeDots), realDots(afterDots));
  };

  /** 코드의 **행위자** 등번호가 아직 잔상이면 그 번호를 돌려준다(아니면 null).

      행위자 좌표는 곧 채점 시작점이라, 포메이션 자리 그대로 받으면 조용히 틀린 데이터가 된다.
      리시버는 막지 않는다 — 도착점 클릭이 그 자리를 정하고, 잔상이면 그 클릭으로 함께
      활성화된다(settleReceiverGhost).

      코드의 번호는 언제나 행위 팀 선수다. 상대 팀에 같은 번호의 잔상이 있다고 막으면 안 되고,
      같은 번호의 실제 점이 이미 있으면 남은 잔상은 사본일 뿐이라 막지 않는다. */
  const pendingGhostActor = (code: string): string | null => {
    const base = code.trim().split('.', 1)[0] || '';
    const actorNum = base.match(/^(\d+)/)?.[1];
    if (!actorNum) return null;
    const mine = [...beforeDots, ...afterDots].filter((dot) => dot.teamSide === team);
    if (mine.some((dot) => !dot.ghost && dot.number === actorNum)) return null;
    return mine.some((dot) => dot.ghost && dot.number === actorNum) ? actorNum : null;
  };

  /** 패스 도착점 클릭 = 리시버가 공을 받은 자리. 리시버가 아직 잔상이면 여기서 활성화하고
      그 좌표로 옮긴다 — 태거가 같은 지점을 두 번 찍게 만들지 않으려는 것이다. */
  const settleReceiverGhost = (
    side: PitchSide,
    receiverNum: string,
    coords: { meter_x: number; meter_y: number; screen_x: number; screen_y: number },
  ) => {
    const place = (prev: PitchDot[]) => {
      const index = prev.findIndex(
        (dot) => dot.ghost && dot.teamSide === team && dot.number === receiverNum,
      );
      if (index < 0) return prev;
      return prev.map((dot, dotIndex) =>
        (dotIndex === index ? { ...dot, ...coords, ghost: false } : dot));
    };
    if (side === 'before') setBeforeDots(place);
    else setAfterDots(place);
  };

  // 패스/크로스 채점: 시작 점 + 도착점(클릭) 2점 → codex /fpa/logs/generate
  const scorePass = async (code: string, start: PitchDot, end: PitchDot) => {
    setBusy(true);
    setStatus('패스 채점 중');
    try {
      const nextRowIndex = rows.length;
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: code,
          dots: [toPayloadDot(start, team), toPayloadDot(end, team)],
          dual_pitch: buildDualPitchPayload(),
          half,
          team,
          direction,
          timeline,
          sport: fpaSport,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || '패스 채점 실패');
        return;
      }
      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = code;
      setLogs((prev) => [...prev, data.log_text]);
      setRows((prev) => {
        const next = [...prev, data.log_data];
        setSelectedRowIndex(next.length - 1);
        return next;
      });
      setPrimaryRowIndex((prev) => (prev == null ? nextRowIndex : prev));
      setStatus('패스 화살표 완성 · 채점됨');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '패스 채점 실패');
    } finally {
      setBusy(false);
    }
  };

  // 화살표 screen 좌표(0~1050 / 0~680) → meter dot 역변환 (dotFromClientPoint 의 역)
  const screenToMeterDot = (sx: number, sy: number): PitchDot => ({
    meter_x: Number(((sx / 1050) * 105).toFixed(2)),
    meter_y: Number((((680 - sy) / 680) * 68).toFixed(2)),
    screen_x: sx,
    screen_y: sy,
  });

  // 패스 화살표 도착점을 드래그로 옮긴 뒤 놓을 때 → 해당 로그 행을 새 [시작,도착]으로 재채점(제자리 교체)
  const rescorePassArrow = async (canvas: 'live' | 'edit', arrow: PassArrow) => {
    if (arrow.code == null || arrow.rowIndex == null) return;
    const isEdit = canvas === 'edit';
    const actorTeam = isEdit ? editTeam : team;
    const start = screenToMeterDot(arrow.x1, arrow.y1);
    const end = screenToMeterDot(arrow.x2, arrow.y2);
    setBusy(true);
    setStatus('화살표 이동 → 재채점 중');
    try {
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: arrow.code,
          dots: [toPayloadDot(start, actorTeam), toPayloadDot(end, actorTeam)],
          dual_pitch: isEdit ? buildEditDualPitchPayload() : buildDualPitchPayload(),
          half: isEdit ? editHalf : half,
          team: actorTeam,
          direction: isEdit ? editDirection : direction,
          timeline: isEdit ? editTimeline : timeline,
          sport: fpaSport,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || '재채점 실패');
        return;
      }
      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = arrow.code;
      const ri = arrow.rowIndex;
      (isEdit ? setEditLogs : setLogs)((prev) => prev.map((entry, idx) => (idx === ri ? data.log_text : entry)));
      (isEdit ? setEditRows : setRows)((prev) => prev.map((row, idx) => (idx === ri ? data.log_data : row)));
      setStatus('화살표 이동 · 재채점 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '재채점 실패');
    } finally {
      setBusy(false);
    }
  };

  // 장면 저장 시 호출 — 그 장면의 모든 행을 현재(최종) before/after(+패스 화살표) 기준으로 재채점해 교체본을 반환.
  //  · 패스/크로스: 연결된 화살표(rowIndex)의 시작·도착 좌표 사용
  //  · 그 외(이동/점 액션): submitDotsForCode 로 before/after에서 코드 기반 좌표 재선택
  //  · StatInput 없는 행(옛 데이터/xGOT 등)은 임시값 그대로 유지
  const rescoreSceneRows = async (
    sceneRows: LogPreview[],
    sceneLogs: string[],
    ctx: {
      before: PitchDot[];
      after: PitchDot[];
      arrows: PassArrow[];
      actorTeam: 'home' | 'away';
      half: string;
      direction: 'left' | 'right';
      timeline: string;
      primary: number | null;
    },
  ): Promise<{ rows: LogPreview[]; logs: string[] }> => {
    const dualPayload = {
      actor_team: ctx.actorTeam,
      primary_row_index: ctx.primary,
      input_tier: ctx.before.length + ctx.after.length >= 6 ? 'recommended' : 'minimal',
      before: { dots: ctx.before.map((dot) => toPayloadDot(dot, ctx.actorTeam)) },
      after: { dots: ctx.after.map((dot) => toPayloadDot(dot, ctx.actorTeam)) },
    };
    const nextRows = [...sceneRows];
    const nextLogs = [...sceneLogs];
    for (let i = 0; i < sceneRows.length; i += 1) {
      const code = sceneRows[i].StatInput;
      if (!code) continue;
      const arrow = ctx.arrows.find((item) => item.rowIndex === i);
      const dotsForRow = arrow
        ? [screenToMeterDot(arrow.x1, arrow.y1), screenToMeterDot(arrow.x2, arrow.y2)]
        : submitDotsForCode(code, ctx.before, ctx.after);
      if (!dotsForRow.length) continue;
      try {
        const response = await apiFetch('/fpa/logs/generate', {
          method: 'POST',
          body: JSON.stringify({
            stat_input: code,
            dots: dotsForRow.map((dot) => toPayloadDot(dot, ctx.actorTeam)),
            dual_pitch: dualPayload,
            half: ctx.half,
            team: ctx.actorTeam,
            direction: ctx.direction,
            timeline: ctx.timeline,
            sport: fpaSport,
          }),
        });
        if (!response.ok) continue;
        const data = await response.json() as { log_text: string; log_data: LogPreview };
        data.log_data.StatInput = code;
        // xGOT·GoalMouth는 백엔드 채점이 만들지 않음(골문클릭 플로우에서 나중에 채워짐) → 재채점이 덮어쓰지 않게 기존값 보존
        if (sceneRows[i].xGOT) data.log_data.xGOT = sceneRows[i].xGOT;
        if (sceneRows[i].GoalMouth) data.log_data.GoalMouth = sceneRows[i].GoalMouth;
        nextRows[i] = data.log_data;
        let mergedLog = data.log_text;
        if (data.log_data.xGOT) mergedLog = mergeMetricsIntoLog(mergedLog, { xGOT: data.log_data.xGOT });
        if (data.log_data.GoalMouth) mergedLog = mergeGoalmouthIntoLog(mergedLog, data.log_data.GoalMouth);
        nextLogs[i] = mergedLog;
      } catch {
        // 개별 행 재채점 실패는 임시값 유지 (전체 저장은 계속)
      }
    }
    return { rows: nextRows, logs: nextLogs };
  };

  // 옛 기록에서 되살린 태깅은 공격방향을 못 되짚었다(백필이 추측하지 않는다).
  // 틀린 방향으로 채점하면 EPV·PC 가 통째로 좌우 반전돼 조용히 잘못된 값이 남으므로,
  // 재채점·저장처럼 **점수를 다시 만드는 행동** 앞에서 한 번 확인을 받는다.
  const confirmRestoredDirection = (actionLabel: string) => {
    if (!needsDirectionConfirm) return true;
    const ok = window.confirm(
      '이 태깅은 옛 기록에서 되살린 것이라 하프와 공격방향이 복원되지 않았습니다.\n\n'
      + `현재 설정: ${half} · 공격방향 ${direction === 'right' ? '오른쪽 →' : '← 왼쪽'}\n\n`
      + `이대로 ${actionLabel}하면 이 설정으로 채점합니다. 방향이 틀리면 모든 지표가 좌우 반전됩니다.\n`
      + '맞습니까?',
    );
    if (!ok) {
      setStatus(`${actionLabel}을 멈췄습니다 — 하프·공격방향을 고친 뒤 다시 시도하세요`);
      return false;
    }
    setNeedsDirectionConfirm(false);
    return true;
  };

  // 저장된 장면의 채점 맥락(하프·공격방향·행위팀·시각)을 복구한다.
  //
  // SavedScene 은 이 넷을 따로 안 들고 있다 — 대신 로그 문자열의 앞부분이
  // "1H | home | right | 12:34 | …" 형식이라 거기서 되짚는다. 옛 기록에서 되살린
  // 장면은 그 자리가 '?' 라서(백필이 방향을 추측하지 않는다) 화면의 현재 설정으로
  // 떨어진다 — 그래서 복원본은 저장 전에 방향 확인을 받는다.
  const sceneScoringContext = (scene: SavedScene) => {
    const parts = (scene.logs?.[0] || '').split(' | ').map((part) => part.trim());
    const loggedHalf = parts[0] === '1H' || parts[0] === '2H' ? parts[0] : null;
    const loggedDirection = parts[2] === 'left' || parts[2] === 'right' ? parts[2] : null;
    const primaryRow = scene.primary != null ? scene.rows[scene.primary] : undefined;
    const rowTeam = (primaryRow?.Team || scene.rows[0]?.Team || '').trim().toLowerCase();
    return {
      half: loggedHalf ?? half,
      direction: loggedDirection ?? direction,
      actorTeam: rowTeam === 'home' || rowTeam === 'away' ? rowTeam : team,
      timeline: primaryRow?.Time || scene.rows[0]?.Time || timeline,
    };
  };

  // 저장된 장면 전부를 **지금 서버 로직**으로 다시 채점한다.
  //
  // 왜 필요한가: EPV·PC·xG 는 찍는 시점에 계산돼 행에 박히고, '클립에 저장' 은 그 행을
  // 그대로 보낸다. 그래서 채점 산식이 바뀌어도 이미 찍은 클립은 옛 값을 계속 들고 있다.
  // (백분위 눈금 = 앵커는 페이로드 조립 때마다 다시 읽으므로 이 버튼과 무관하게 바로 반영된다.
  //  이 버튼이 고치는 건 원시값 쪽이다.)
  const rescoreAllScenes = async () => {
    if (!savedScenes.length) {
      setStatus('재채점할 저장된 장면이 없습니다');
      return;
    }
    if (rows.length) {
      setStatus('현재 액션이 버퍼에 남아 있습니다 — 먼저 "장면 저장" 을 누르세요');
      return;
    }
    if (!confirmRestoredDirection('재채점')) return;
    setBusy(true);
    const next: SavedScene[] = [];
    let changed = 0;
    for (let i = 0; i < savedScenes.length; i += 1) {
      const scene = savedScenes[i];
      setStatus(`현재 로직으로 재채점 중… (${i + 1}/${savedScenes.length})`);
      const ctx = sceneScoringContext(scene);
      const { rows: scoredRows, logs: scoredLogs } = await rescoreSceneRows(scene.rows, scene.logs, {
        before: scene.beforeDots,
        after: scene.afterDots,
        arrows: scene.passArrows,
        ...ctx,
        primary: scene.primary,
      });
      scoredRows.forEach((row, j) => {
        const before = scene.rows[j];
        if (before.EPV !== row.EPV || before.PC !== row.PC || before.xG !== row.xG) changed += 1;
      });
      next.push({ ...scene, rows: scoredRows, logs: scoredLogs });
    }
    setSavedScenes(next);
    setBusy(false);
    const total = next.reduce((sum, scene) => sum + scene.rows.length, 0);
    setStatus(
      changed
        ? `재채점 완료 — ${total}건 중 ${changed}건의 지표가 바뀌었습니다. "클립에 저장" 을 눌러야 반영됩니다`
        : `재채점 완료 — ${total}건 모두 현재 로직과 같은 값입니다(저장 불필요)`,
    );
  };

  const buildDualPitchPayload = () => {
    if (inputMode !== 'dual') return undefined;
    // 잔상은 프레임에 넣지 않는다 — 압박·PC 는 프레임 전체 좌표로 계산하므로
    // 실제로 거기 없는 선수가 섞이면 지표가 통째로 흔들린다.
    const beforeReal = realDots(beforeDots);
    const afterReal = realDots(afterDots);
    return {
      actor_team: team,
      primary_row_index: primaryRowIndex,
      input_tier: beforeReal.length + afterReal.length >= 6 ? 'recommended' : 'minimal',
      before: {
        dots: beforeReal.map((dot) => toPayloadDot(dot, team)),
      },
      after: {
        dots: afterReal.map((dot) => toPayloadDot(dot, team)),
      },
    };
  };

  // ── 수정용 피치 채점 경로 — 라이브 addLog/scorePass 미러, 대상만 edit 상태 ──

  const buildEditSubmitDots = () => {
    const beforeAllies = editBeforeDots.filter(isAllyDot);
    const afterAllies = editAfterDots.filter(isAllyDot);
    const actorNum = editStatInput.trim().match(/^(\d+)/)?.[1];
    const pickActor = (arr: PitchDot[]) => (actorNum && arr.find((dot) => dot.number === actorNum)) || arr[0];
    if (statInputHasReceiver(editStatInput) && beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    // 슛: 행위자 점만 — live 캔버스(submitDotsForCode)와 동일 사유
    if (statInputIsShotAction(editStatInput)) {
      const start = beforeAllies.length ? pickActor(beforeAllies) : pickActor(afterAllies);
      if (!start) return [];
      const end = beforeAllies.length && afterAllies.length ? pickActor(afterAllies) : null;
      return end ? [start, end] : [start];
    }
    if (beforeAllies.length && afterAllies.length) return [pickActor(beforeAllies), pickActor(afterAllies)];
    if (beforeAllies.length >= 2) return beforeAllies.slice(0, 2);
    if (afterAllies.length >= 2) return afterAllies.slice(0, 2);
    return [...beforeAllies, ...afterAllies];
  };

  const buildEditDualPitchPayload = () => ({
    actor_team: editTeam,
    primary_row_index: editPrimary,
    input_tier: editBeforeDots.length + editAfterDots.length >= 6 ? 'recommended' : 'minimal',
    before: {
      dots: editBeforeDots.map((dot) => toPayloadDot(dot, editTeam)),
    },
    after: {
      dots: editAfterDots.map((dot) => toPayloadDot(dot, editTeam)),
    },
  });

  const adjustEditTimeline = (deltaSeconds: number) => {
    const [minutesRaw, secondsRaw] = editTimeline.split(':');
    const minutes = Number(minutesRaw || 0);
    const seconds = Number(secondsRaw || 0);
    const next = Math.max(0, minutes * 60 + seconds + deltaSeconds);
    const mm = String(Math.floor(next / 60)).padStart(2, '0');
    const ss = String(next % 60).padStart(2, '0');
    setEditTimeline(`${mm}:${ss}`);
  };

  const scoreEditPass = async (code: string, start: PitchDot, end: PitchDot) => {
    setBusy(true);
    setStatus('수정용 액션 패스 채점 중');
    try {
      const nextRowIndex = editRows.length;
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: code,
          dots: [toPayloadDot(start, editTeam), toPayloadDot(end, editTeam)],
          dual_pitch: buildEditDualPitchPayload(),
          half: editHalf,
          team: editTeam,
          direction: editDirection,
          timeline: editTimeline,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || '패스 채점 실패');
        return;
      }
      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = code;
      setEditLogs((prev) => [...prev, data.log_text]);
      setEditRows((prev) => {
        const next = [...prev, data.log_data];
        setEditSelectedRowIndex(next.length - 1);
        return next;
      });
      setEditPrimary((prev) => (prev == null ? nextRowIndex : prev));
      setStatus('수정용 액션에 패스 추가 · 채점됨');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '패스 채점 실패');
    } finally {
      setBusy(false);
    }
  };

  const addEditLog = async () => {
    if (!editStatInput.trim()) return;
    if (pendingXgot) {
      setStatus('진행 중인 xGOT 입력을 먼저 완료하세요');
      return;
    }
    if (statInputIsNumberOnly(editStatInput)) {
      assignNumberToEditSelectedDot(editStatInput.trim());
      return;
    }
    // 볼 경로를 화살표로 그리는 액션 — 수비(태클/인터셉트/차단/블록)와 경합. (라이브와 동일)
    if (statInputIsBallPathArrow(editStatInput)) {
      const code = editStatInput.trim();
      // 수비 행위자 번호를 선택된 아군 점에 반영 (라이브와 동일)
      const actorNum = code.match(/^(\d+)/)?.[1];
      const actorSel = editSelectedDot;
      const actorTarget = actorSel ? (actorSel.side === 'before' ? editBeforeDots : editAfterDots)[actorSel.index] : undefined;
      // 라이브와 같은 규칙 — 그 번호의 점이 이미 있으면 클릭한 점을 건드리지 않는다.
      const actorByNumber = findAllyDotByNumber(actorNum, editBeforeDots, editAfterDots);
      if (!actorByNumber && actorSel && actorNum && actorTarget && isAllyDot(actorTarget)) {
        const assign = (prev: PitchDot[]) =>
          prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
        if (actorSel.side === 'before') setEditBeforeDots(assign);
        else setEditAfterDots(assign);
      }
      setEditPendingDefStart({ code, side: 'before' });
      setEditStatInput('');
      setStatus(`수정용 Before: ${arrowArmHint(code, 'start')} · Esc 취소`);
      return;
    }
    // 패스/크로스(받는번호 O) = 시작 점 선택 후 도착점 클릭까지 채점 지연 (라이브와 동일)
    if (statInputHasReceiver(editStatInput)) {
      const editActorNum = editStatInput.trim().match(/^(\d+)/)?.[1];
      // 번호가 이미 찍힌 점이 있으면 그 점이 행위자다 (클릭 위치보다 우선).
      const actorByNumber = findAllyDotByNumber(editActorNum, editBeforeDots, editAfterDots);
      const sel = actorByNumber
        ? { side: actorByNumber.side, index: actorByNumber.index }
        : editSelectedDot;
      const dotsArr = sel?.side === 'before' ? editBeforeDots : editAfterDots;
      const startDot = sel ? dotsArr[sel.index] : undefined;
      if (!sel || !startDot) {
        setStatus('수정용 피치에서 패스 시작 점을 먼저 찍으세요 (또는 시작 선수 번호가 찍혀 있어야 합니다)');
        return;
      }
      if (!isAllyDot(startDot)) {
        setStatus('패스 시작 점은 아군 점이어야 합니다 (상대 점 선택됨)');
        return;
      }
      // 번호로 찾았으면 이미 그 점에 번호가 있으므로 덮어쓰지 않는다.
      if (editActorNum && !actorByNumber) {
        const assign = (prev: PitchDot[]) => prev.map((dot, index) => (index === sel.index ? { ...dot, number: editActorNum } : dot));
        if (sel.side === 'before') setEditBeforeDots(assign);
        else setEditAfterDots(assign);
      }
      setEditPendingPass({ code: editStatInput, side: sel.side, startId: startDot.id, sx: startDot.screen_x, sy: startDot.screen_y, mx: startDot.meter_x, my: startDot.meter_y });
      setEditStatInput('');
      setStatus('수정용 피치에서 패스 도착점을 클릭하세요 (화살표 · Esc 취소)');
      return;
    }
    setBusy(true);
    setStatus('수정용 액션 로그 생성 중');
    const requestedStatInput = editStatInput;
    const nextRowIndex = editRows.length;

    try {
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: editStatInput,
          dots: buildEditSubmitDots().map((dot) => toPayloadDot(dot, editTeam)),
          dual_pitch: buildEditDualPitchPayload(),
          half: editHalf,
          team: editTeam,
          direction: editDirection,
          timeline: editTimeline,
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || '로그 생성 실패');
        return;
      }

      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = requestedStatInput;
      setEditLogs((prev) => [...prev, data.log_text]);
      setEditRows((prev) => {
        const nextRows = [...prev, data.log_data];
        setEditSelectedRowIndex(nextRows.length - 1);
        return nextRows;
      });
      setEditStatInput('');
      // 라이브 캔버스와 같은 이유로 xGOT 분기보다 앞에서 번호를 붙인다 —
      // 슛은 아래에서 return 하므로 뒤에 두면 슛 점만 번호를 못 받는다.
      const actorNum = requestedStatInput.trim().match(/^(\d+)/)?.[1];
      const actorSel = editSelectedDot;
      const actorTarget = actorSel ? (actorSel.side === 'before' ? editBeforeDots : editAfterDots)[actorSel.index] : undefined;
      const actorByNumber = findAllyDotByNumber(actorNum, editBeforeDots, editAfterDots);
      const actorOnOpponent = !actorByNumber && !!(actorSel && actorNum && actorTarget && !isAllyDot(actorTarget));
      if (!actorByNumber && actorSel && actorNum && actorTarget && isAllyDot(actorTarget)) {
        const assign = (prev: PitchDot[]) =>
          prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
        if (actorSel.side === 'before') setEditBeforeDots(assign);
        else setEditAfterDots(assign);
      }
      const promptXgot = shouldPromptXgot(requestedStatInput, data.log_data);
      const rawXg = Number(data.log_data.xG || extractMetricValue(data.log_text, 'xG') || 0);
      if (promptXgot && Number.isFinite(rawXg)) {
        const tags = data.log_data.Tags || '';
        const isOffTarget = extractActionCode(requestedStatInput) === 'd' || tags.includes('Off Target');
        setPendingXgot({
          canvas: 'edit',
          rowIndex: nextRowIndex,
          xg: Math.min(Math.max(rawXg, 0), 1),
          isOnTarget: !isOffTarget,
          isGoal: extractActionCode(requestedStatInput) === 'ddd' || tags.includes('Goal'),
          isHeader: tags.includes('Header'),
          isWeakFoot: tags.includes('Weak Foot'),
          underPressure: tags.includes('Under Pressure'),
          oneOnOne: tags.includes('One-on-One') || tags.includes('1v1'),
        });
        setGoalmouthPoint(null);
        setXgotEstimate(null);
        setStatus(isOffTarget
          ? '슛 로그 추가 완료. 골대 기준 빗나간 위치를 클릭해 기록하세요'
          : '유효슈팅 로그 추가 완료. 골문 위치를 클릭해 xGOT를 입력하세요');
        return;
      }
      setEditPrimary((prev) => (prev == null ? nextRowIndex : prev));
      // 행위자 번호 지정은 위(xGOT 분기 앞)에서 이미 끝났다 — 여기선 결과만 알린다.
      setStatus(actorOnOpponent
        ? '액션 추가됨 · 행위자 번호는 상대 점에 안 붙었습니다 — 아군 점 선택 후 재지정하세요'
        : '수정용 장면에 액션 추가 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      // 패스 화살표 끝점 드래그 — 점과 분리, 화살표만 이동
      const arrowDrag = draggingArrowRef.current;
      if (arrowDrag) {
        const isEditArrow = arrowDrag.canvas === 'edit';
        const arrowRef = arrowDrag.side === 'before'
          ? (isEditArrow ? editBeforePitchRef.current : beforePitchRef.current)
          : (isEditArrow ? editAfterPitchRef.current : afterPitchRef.current);
        const arrowRect = arrowRef?.getBoundingClientRect();
        if (!arrowRect) return;
        // 실제로 움직이기 시작한 첫 순간에만 undo 스냅샷 (클릭만으로는 안 쌓음)
        if (!arrowDrag.moved && !isEditArrow) pushDualUndo();
        arrowDrag.moved = true;
        const coords = dotFromClientPoint(event.clientX, event.clientY, arrowRect);
        (isEditArrow ? setEditPassArrows : setPassArrows)((prev) => {
          const target = prev[arrowDrag.index];
          if (!target) return prev;
          const patch = arrowDrag.end === 'end'
            ? { x2: coords.screen_x, y2: coords.screen_y }
            : { x1: coords.screen_x, y1: coords.screen_y };
          // 화살표는 before/after 캔버스에 같은 rowIndex 로 한 벌씩 있다(미러 복사본).
          // 끌고 있는 쪽만 옮기면 좌표가 갈려서, 씬모션이 옛 경로와 새 경로를 잇달아
          // 두 번 재생한다(scene_motion._parse_arrows 의 짝 맞추기가 rowIndex 기준).
          // 점 드래그가 startId 로 양쪽을 같이 옮기는 것과 같은 규칙.
          return prev.map((arrow, idx) => {
            const isMirror = target.rowIndex !== undefined && arrow.rowIndex === target.rowIndex;
            return idx === arrowDrag.index || isMirror ? { ...arrow, ...patch } : arrow;
          });
        });
        return;
      }
      const dragging = draggingDualDotRef.current;
      if (!dragging) return;
      const isEdit = dragging.canvas === 'edit';
      const ref = dragging.side === 'before'
        ? (isEdit ? editBeforePitchRef.current : beforePitchRef.current)
        : (isEdit ? editAfterPitchRef.current : afterPitchRef.current);
      const rect = ref?.getBoundingClientRect();
      if (!rect) return;
      const currentDots = dragging.side === 'before'
        ? (isEdit ? editBeforeDots : beforeDots)
        : (isEdit ? editAfterDots : afterDots);
      const existing = currentDots[dragging.index];
      if (!existing) return;
      if (!dragging.historyPushed) {
        if (!isEdit) pushDualUndo();
        dragging.historyPushed = true;
      }
      const coords = dotFromClientPoint(event.clientX, event.clientY, rect);
      // 위치만 갱신 — team/role/color/number/id 보존 (안 하면 레이어 색 사라져 홈/어웨이 뒤바뀐 듯 보임)
      // ghost 는 반드시 떼고 쓴다: 잔상을 눌러 바로 끌면 활성화(setState)가 반영되기 전에
      // 이 핸들러가 옛 스냅샷(ghost=true)을 새 좌표로 다시 써서 활성화가 취소돼 버린다.
      // 끌어다 놓는 행위 자체가 '이 선수를 여기에 둔다' 는 뜻이라 떼는 게 맞기도 하다.
      (isEdit ? updateEditDot : updateDualDot)(dragging.side, dragging.index, { ...existing, ...coords, ghost: false });
      // 그 점에서 출발하는 패스 화살표 시작점도 따라 이동
      if (existing.id) {
        (isEdit ? setEditPassArrows : setPassArrows)((prev) => prev.map((arrow) =>
          arrow.startId === existing.id && (arrow.side === dragging.side || dragging.side === 'before')
            ? { ...arrow, x1: coords.screen_x, y1: coords.screen_y }
            : arrow));
      }
    };

    const handlePointerUp = () => {
      draggingDualDotRef.current = null;
      draggingArrowRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [afterDots, beforeDots, editAfterDots, editBeforeDots]);

  const syncTeam = (nextTeam: 'home' | 'away') => {
    if (nextTeam === team) return;
    setTeam(nextTeam);
    setDirection((prev) => (prev === 'right' ? 'left' : 'right'));
  };

  const addLog = async () => {
    if (!statInput.trim()) return;
    if (pendingXgot) {
      setStatus('진행 중인 xGOT 입력을 먼저 완료하세요');
      return;
    }
    if (inputMode === 'dual' && statInputIsNumberOnly(statInput)) {
      assignNumberToLiveSelectedDot(statInput.trim());
      return;
    }
    // 행위자가 아직 잔상이면 채점을 막는다 — 행위자 좌표가 곧 채점 시작점이라,
    // 포메이션 자리를 그대로 받으면 조용히 틀린 데이터가 굳는다.
    if (inputMode === 'dual') {
      const ghostActor = pendingGhostActor(statInput);
      if (ghostActor) {
        setStatus(
          `${ghostActor}번이 아직 잔상입니다 — 피치에서 클릭해 활성화하고 실제 위치로 옮기세요`,
        );
        return;
      }
    }
    // 볼 경로를 Before 에 화살표로 그리는 액션. 코드 입력 후 2번 클릭.
    //   수비(태클/인터셉트/차단/블록) = 상대 공 경로 (출발점 → 끊은 지점)
    //   경합(b/bb)              = 볼이 온 경로 (볼이 온 곳 → 경합 지점)
    // 끝점이 곧 채점 좌표라, 경합은 화살표를 그리면 after 프레임 조정이 필요 없어진다.
    if (inputMode === 'dual' && statInputIsBallPathArrow(statInput)) {
      const code = statInput.trim();
      // 수비 행위자 번호(예: 4q의 4)는 방금 찍은(선택된) 아군 점에 반영 — 화살표는 상대 공 경로라 점과 별개
      const actorNum = code.match(/^(\d+)/)?.[1];
      const actorSel = selectedDualDot;
      const actorTarget = actorSel ? (actorSel.side === 'before' ? beforeDots : afterDots)[actorSel.index] : undefined;
      // 그 번호의 점이 이미 있으면 클릭한 점을 건드리지 않는다.
      const actorByNumber = findAllyDotByNumber(actorNum, beforeDots, afterDots);
      if (!actorByNumber && actorSel && actorNum && actorTarget && isAllyDot(actorTarget)) {
        const assign = (prev: PitchDot[]) =>
          prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
        if (actorSel.side === 'before') setBeforeDots(assign);
        else setAfterDots(assign);
      }
      setPendingDefStart({ code, side: 'before' });
      setStatInput('');
      setStatus(`Before: ${arrowArmHint(code, 'start')} · Esc 취소`);
      return;
    }
    // 패스/크로스(받는번호 O) = 2점(시작·도착). 점 1개만 찍고 코드 입력 → 채점은 도착점 클릭 시 (xFP/fpa)
    if (inputMode === 'dual' && statInputHasReceiver(statInput)) {
      const actorNum = statInput.trim().match(/^(\d+)/)?.[1];
      // 번호가 이미 찍힌 점이 있으면 그 점이 행위자다 — 클릭 위치보다 우선한다.
      const actorByNumber = findAllyDotByNumber(actorNum, beforeDots, afterDots);
      let side: PitchSide | undefined = actorByNumber?.side ?? selectedDualDot?.side;
      let startIndex: number | undefined = actorByNumber?.index ?? selectedDualDot?.index;
      let startDot =
        side != null && startIndex != null ? (side === 'before' ? beforeDots : afterDots)[startIndex] : undefined;
      // 선택이 없으면(예: 장면 저장 후 after→before 복사 직후) 코드의 행위자 번호로 시작 점 탐색 → 그 점에서 화살표 시작
      if (!startDot && actorNum) {
        const bIdx = beforeDots.findIndex((dot) => !dot.ghost && isAllyDot(dot) && dot.number === actorNum);
        if (bIdx >= 0) {
          side = 'before';
          startIndex = bIdx;
          startDot = beforeDots[bIdx];
        } else {
          const aIdx = afterDots.findIndex((dot) => !dot.ghost && isAllyDot(dot) && dot.number === actorNum);
          if (aIdx >= 0) {
            side = 'after';
            startIndex = aIdx;
            startDot = afterDots[aIdx];
          }
        }
      }
      if (!startDot || side == null || startIndex == null) {
        setStatus('패스 시작 점을 먼저 찍으세요 (또는 시작 선수 번호가 찍혀 있어야 합니다)');
        return;
      }
      if (!isAllyDot(startDot)) {
        setStatus('패스 시작 점은 아군 점이어야 합니다 (상대 점 선택됨)');
        return;
      }
      // 번호로 찾은 경우엔 이미 그 점에 번호가 있으므로 덮어쓸 일이 없다.
      if (actorNum && !actorByNumber) {
        const idx = startIndex;
        const targetSide = side;
        const assign = (prev: PitchDot[]) => prev.map((dot, index) => (index === idx ? { ...dot, number: actorNum } : dot));
        if (targetSide === 'before') setBeforeDots(assign);
        else setAfterDots(assign);
      }
      setPendingPass({ code: statInput, side, startId: startDot.id, sx: startDot.screen_x, sy: startDot.screen_y, mx: startDot.meter_x, my: startDot.meter_y });
      setStatInput('');
      setStatus('패스 도착점을 클릭하세요 (화살표 · Esc 취소)');
      return;
    }
    setBusy(true);
    setStatus('로그 생성 중');
    const requestedStatInput = statInput;
    const nextRowIndex = rows.length;

    try {
      const submitDots = buildDualSubmitDots();
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: statInput,
          dots: submitDots.map((dot) => toPayloadDot(dot, team)),
          dual_pitch: buildDualPitchPayload(),
          half,
          team,
          direction,
          timeline,
          sport: fpaSport,
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || '로그 생성 실패');
        return;
      }

      const data = await response.json() as { log_text: string; log_data: LogPreview };
      data.log_data.StatInput = requestedStatInput;
      if (inputMode === 'dual') pushDualUndo();
      setLogs((prev) => [...prev, data.log_text]);
      setRows((prev) => {
        const nextRows = [...prev, data.log_data];
        setSelectedRowIndex(nextRows.length - 1);
        return nextRows;
      });
      setStatInput('');
      // 행위자 번호 지정은 xGOT 분기보다 **앞에서** 한다 — 슛(d/dd/ddd/db)은 아래에서
      // xGOT 입력을 띄우며 return 하므로, 뒤에 두면 슛 점만 번호를 영영 못 받는다.
      // 그러면 sceneState 에 number 가 없어 scene_motion._find_actor_pair 가 실패하고
      // 씬모션 공이 하프라인 정중앙(FIELD_W/2, FIELD_H/2)에서 출발한다.
      // 아군 점에만 붙인다 — 상대 점 선택 시 지정 스킵(오염 방지).
      const actorNum = requestedStatInput.trim().match(/^(\d+)/)?.[1];
      const actorSel = selectedDualDot;
      const actorTarget = actorSel ? (actorSel.side === 'before' ? beforeDots : afterDots)[actorSel.index] : undefined;
      // 번호가 이미 붙은 점이 있으면 그 점이 행위자다 — 클릭한 점의 번호를 덮어쓰지 않는다.
      const actorByNumber = inputMode === 'dual' ? findAllyDotByNumber(actorNum, beforeDots, afterDots) : null;
      const actorOnOpponent = !actorByNumber && !!(actorSel && actorNum && actorTarget && !isAllyDot(actorTarget));
      if (inputMode === 'dual' && !actorByNumber && actorSel && actorNum && actorTarget && isAllyDot(actorTarget)) {
        const assign = (prev: PitchDot[]) =>
          prev.map((dot, index) => (index === actorSel.index ? { ...dot, number: actorNum } : dot));
        if (actorSel.side === 'before') setBeforeDots(assign);
        else setAfterDots(assign);
      }
      const promptXgot = inputMode === 'dual' && shouldPromptXgot(requestedStatInput, data.log_data);
      const rawXg = Number(data.log_data.xG || extractMetricValue(data.log_text, 'xG') || 0);
      if (promptXgot && Number.isFinite(rawXg)) {
        const tags = data.log_data.Tags || '';
        const isOffTarget = extractActionCode(requestedStatInput) === 'd' || tags.includes('Off Target');
        setPendingXgot({
          canvas: 'live',
          rowIndex: nextRowIndex,
          xg: Math.min(Math.max(rawXg, 0), 1),
          isOnTarget: !isOffTarget,
          isGoal: extractActionCode(requestedStatInput) === 'ddd' || tags.includes('Goal'),
          isHeader: tags.includes('Header'),
          isWeakFoot: tags.includes('Weak Foot'),
          underPressure: tags.includes('Under Pressure'),
          oneOnOne: tags.includes('One-on-One') || tags.includes('1v1'),
        });
        setGoalmouthPoint(null);
        setXgotEstimate(null);
        setStatus(isOffTarget
          ? '슛 로그 추가 완료. 골대 기준 빗나간 위치를 클릭해 기록하세요'
          : '유효슈팅 로그 추가 완료. 골문 위치를 클릭해 xGOT를 입력하세요');
        return;
      }
      if (inputMode === 'dual') {
        // 좌표(점)는 유지 — 같은 장면에 액션 계속 누적. 초기화는 "새 장면"에서만 (xFP/fpa)
        setPrimaryRowIndex((prev) => (prev == null ? nextRowIndex : prev));
        // 행위자 번호 지정은 위(xGOT 분기 앞)에서 이미 끝났다 — 여기선 결과만 알린다.
        setStatus(actorOnOpponent
          ? '로그 추가됨 · 단 행위자 번호는 상대 점에 안 붙었습니다 — 아군 점 선택 후 재지정하세요'
          : '로그 추가 완료');
      } else {
        setDots([]);
        setStatus('로그 추가 완료');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  const exportWorkbook = async () => {
    if (!allLogs.length) return;
    setBusy(true);
    setStatus('분석 파일 생성 중');

    try {
      const response = await apiFetch('/fpa/analyze/export', {
        method: 'POST',
        body: JSON.stringify({
          logs: allLogs,
          rows: buildRowsForPersistence(),
          match_id: matchId,
          teamid_h: teamIdH,
          teamid_a: teamIdA,
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || '엑셀 생성 실패');
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const disposition = response.headers.get('content-disposition') || '';
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
      link.href = url;
      link.download = fileNameMatch?.[1] || 'fpa_live_analyzed_data.xlsx';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setStatus('분석 및 내보내기 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '엑셀 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  const importWorkbook = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setStatus('기존 FPA 로그를 불러오는 중');

    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_BASE}/fpa/logs/import`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!response.ok) {
        setStatus((await response.text()) || '로그 불러오기 실패');
        return;
      }

      const data = await response.json() as {
        logs: string[];
        rows: LogPreview[];
        match_id: string;
        teamid_h: string;
        teamid_a: string;
      };
      const importedLogs = data.logs || [];
      const importedRows = data.rows || [];
      const persistedScenes = scenesFromPersistedRows(importedRows, importedLogs, team);
      const dualScene = sceneFromDualLogs(importedRows, importedLogs, team);
      if (persistedScenes.length) {
        setInputMode('dual');
        setSavedScenes(persistedScenes);
        setSelectedSceneIndex(0);
        setLogs([]);
        setRows([]);
        setBeforeDots([]);
        setAfterDots([]);
        setPassArrows([]);
        setPrimaryRowIndex(null);
        closeSceneEditor();
      } else if (dualScene) {
        setInputMode('dual');
        setSavedScenes([dualScene]);
        setSelectedSceneIndex(0);
        setLogs([]);
        setRows([]);
        setBeforeDots([]);
        setAfterDots([]);
        setPassArrows([]);
        setPrimaryRowIndex(null);
        closeSceneEditor();
      } else {
        setLogs(importedLogs);
        setRows(importedRows);
        setSelectedRowIndex(importedRows.length ? 0 : null);
        setSavedScenes([]);
        closeSceneEditor();
      }
      resetDualUndo();
      if (data.match_id) setMatchId(data.match_id);
      if (data.teamid_h) setTeamIdH(data.teamid_h);
      if (data.teamid_a) setTeamIdA(data.teamid_a);
      setStatus(`로그 ${data.logs?.length || 0}건 불러오기 완료`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 불러오기 실패');
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
      setBusy(false);
    }
  };

  // 클립 귀속 모드 — 클립 결과 탭에서 새 창(/admin/fpa/live?clipId=...)으로 진입.
  // 여기서 찍은 씬을 '클립에 저장'하면 그 클립의 action 목록이 된다(전체 교체).
  const [clipTarget, setClipTarget] = useState<{ id: string; label: string } | null>(null);
  // 옛 액션에서 되살린 태깅인가 — 하프·공격방향이 원본에 없어 복원할 수 없었다는 뜻이다.
  // 방향이 틀린 채로 저장하면 모든 지표가 좌우 반전되므로, 저장 전에 한 번 확인을 받는다.
  const [needsDirectionConfirm, setNeedsDirectionConfirm] = useState(false);

  // FinePlay 신청 라인업 — before 프레임 사전 배치의 원본. matchId(클레임/사전 잡의
  // fpa_link 매치) 또는 클립 귀속 모드의 클립에서 가져온다. 라인업 있는 사이드만 담긴다.
  const [lineupSides, setLineupSides] = useState<LineupSides>({});

  // 피치 오른쪽 패널 탭 — 액션 목록 / 신청 명단
  const [sidePanelTab, setSidePanelTab] = useState<'actions' | 'roster'>('actions');
  // 명단 탭에서 보고 있는 팀
  const [rosterTeam, setRosterTeam] = useState<TeamSide>('home');

  // 교체 반영 — 신청 시점 명단과 실제 출전이 다를 때 화면에서만 선발↔교체를 맞바꾼다.
  // 서버에 저장하지 않는다(신청 원본은 그대로 두고, 배치할 때만 이 결과를 쓴다).
  const [rosterOverride, setRosterOverride] = useState<Partial<Record<TeamSide, RosterPlayer[]>>>({});
  // 라인업이 새로 로드되면(경기·클립 전환) 교체 반영을 버린다 — 다른 경기 명단이 섞이면 안 된다.
  useEffect(() => { setRosterOverride({}); }, [lineupSides]);

  const effectiveRoster = useMemo(() => {
    const out: Partial<Record<TeamSide, RosterPlayer[]>> = {};
    (['home', 'away'] as const).forEach((side) => {
      const players = lineupSides[side]?.players;
      if (!players?.length) return;
      out[side] = rosterOverride[side] ?? players.map((p) => ({
        jersey: p.jersey,
        name: p.name,
        positionSlot: p.positionSlot ?? '',
        // 앱은 교체를 isSubstitute 또는 positionSlot='SUB' 둘 중 하나로 표시한다.
        isSubstitute: Boolean(p.isSubstitute) || (p.positionSlot ?? '').toUpperCase() === 'SUB',
        // 기록지 확인거리는 그대로 들고 다닌다 — 교체를 반영해도 사라지면 안 된다.
        bib: p.bib,
        rosterNumber: p.rosterNumber,
        bibAmbiguous: p.bibAmbiguous,
        positionInferred: p.positionInferred,
      }));
    });
    return out;
  }, [lineupSides, rosterOverride]);

  // 선발 한 명과 교체 한 명을 맞바꾼다 — 들어온 선수가 나간 선수의 자리(positionSlot)를 그대로 받는다.
  const swapRosterPlayers = (side: TeamSide, dragJersey: string, dropJersey: string) => {
    const list = effectiveRoster[side];
    if (!list || dragJersey === dropJersey) return;
    const a = list.find((p) => p.jersey === dragJersey);
    const b = list.find((p) => p.jersey === dropJersey);
    // 선발↔교체만 의미가 있다. 같은 구역끼리 끌면 자리만 흔들리므로 막는다.
    if (!a || !b || a.isSubstitute === b.isSubstitute) return;
    setRosterOverride((prev) => ({
      ...prev,
      [side]: list.map((p) => {
        if (p.jersey === a.jersey) return { ...p, positionSlot: b.positionSlot, isSubstitute: b.isSubstitute };
        if (p.jersey === b.jersey) return { ...p, positionSlot: a.positionSlot, isSubstitute: a.isSubstitute };
        return p;
      }),
    }));
    const goingIn = a.isSubstitute ? a : b;
    const goingOut = a.isSubstitute ? b : a;
    setStatus(`교체 반영 — ${side === 'home' ? '홈' : '어웨이'} ${goingOut.jersey} → ${goingIn.jersey} · "before 에 배치" 를 다시 누르세요`);
  };

  useEffect(() => {
    const id = matchId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      setLineupSides({});
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const d = await apiJson<{ linked: boolean; sides?: LineupSides }>(
            `/fpa/matches/${id}/fineplay-lineup`,
          );
          setLineupSides(d.linked ? d.sides ?? {} : {});
        } catch {
          setLineupSides({});
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [matchId]);


  // 신청 라인업을 before 프레임에 포메이션대로 '잔상' 으로 깔아준다.
  // 영상만 보고 등번호를 찾는 수고를 없애는 게 목적이라, 정확한 위치가 아니라
  // '누가 어느 자리에 있는지' 를 먼저 세워두고 태거가 끌어 옮기게 한다.
  //
  // 잔상인 이유: 한 액션에 실제로 등장하는 선수는 서너 명인데 22명을 전부 실제 점으로
  // 깔면 나머지가 포메이션 자리 그대로 프레임에 실려 압박·PC 지표를 흔든다.
  // 태거가 클릭한 선수만 실제 점이 되고, 안 건드린 잔상은 채점·저장·전송 어디에도 안 간다.
  //
  // 교체 선수(positionSlot='SUB')는 좌표가 없으므로 선발만 놓는다.
  const placeLineupOnBefore = (targetSides: readonly TeamSide[] = ['home', 'away']) => {
    // 신청 원본이 아니라 '교체 반영된' 명단을 쓴다 — 명단 탭에서 바꾼 결과가 그대로 나간다.
    const sidesWithLineup = (['home', 'away'] as const)
      .filter((side) => targetSides.includes(side))
      .filter((side) => (effectiveRoster[side]?.length ?? 0) > 0);
    if (!sidesWithLineup.length) {
      setStatus(targetSides.length === 1
        ? `${sideLabel(targetSides[0])} 라인업이 없습니다 — 명단 탭에서 확인하세요`
        : '신청 라인업이 없습니다 — 이 경기에 연결된 FinePlay 신청을 먼저 확인하세요');
      return;
    }

    // 다시 깔아도 지우는 건 '그 팀의 잔상' 뿐이다. 이미 클릭해 활성화하고 실제 위치로
    // 옮겨 둔 점은 그대로 남는다 — 배치 한 번에 작업을 날려버리지 않으려는 것이다.
    // 지우는 게 잔상뿐이라 확인 팝업도 필요 없다.
    const keptDots = beforeDots.filter(
      (dot) => !dot.ghost || !sidesWithLineup.includes(dot.teamSide as TeamSide),
    );
    const clearedGhosts = beforeDots.length - keptDots.length;
    // 같은 팀·같은 등번호의 실제 점이 이미 있으면 그 선수의 잔상은 다시 깔지 않는다.
    const activeKeys = new Set(
      keptDots.filter((dot) => !dot.ghost).map(dotRosterKey).filter(Boolean) as string[],
    );

    // direction 은 '지금 선택된 팀(team)' 의 공격 방향이다. 홈 기준으로 환산해 둔다.
    const homeAttacksRight = team === 'home' ? direction === 'right' : direction === 'left';

    const nextDots: PitchDot[] = [];
    const placed: string[] = [];
    let skipped = 0;
    let alreadyActive = 0;

    sidesWithLineup.forEach((side) => {
      const starters = (effectiveRoster[side] ?? []).filter((p) => !p.isSubstitute && p.positionSlot);
      if (!starters.length) return;

      const slotIds = starters.map((p) => p.positionSlot);
      const isCustom = slotIds.some((id) => /^c\d+_\d+$/.test(id));
      // 기록지 라인업은 슬롯이 포지션 라벨이다 — 포메이션 없이 라벨만으로 자리가 나온다.
      const isRecordSheet = !isCustom && slotIds.some(isRecordSheetPosition);
      const slots = isCustom
        ? buildCustomGridSlots()
        : isRecordSheet
          ? buildRecordSheetSlots(slotIds)
          // 포메이션 키는 교체와 무관하므로 신청 원본에서 읽는다.
          : buildFormationSlots(lineupSides[side]?.formation ?? '', linesFromSlotIds(slotIds));
      if (!slots.length) return;

      const gridById = new Map(slots.map((s) => [s.id.toUpperCase(), s]));
      const rowMap = rowMapFromSlots(slots);
      const rowCount = Math.max(...Array.from(rowMap.values())) + 1;
      const attacksRight = side === 'home' ? homeAttacksRight : !homeAttacksRight;

      let sidePlaced = 0;
      starters.forEach((player) => {
        // 이미 활성화된 선수는 건드리지 않는다 — 옮겨 둔 위치가 잔상으로 되돌아가면 안 된다.
        if (activeKeys.has(`${side}:${player.jersey}`)) { alreadyActive += 1; return; }
        const grid = gridById.get(player.positionSlot.toUpperCase());
        if (!grid) { skipped += 1; return; }
        sidePlaced += 1;
        // 커스텀 격자는 0행(gridY=100)이 곧 GK 줄이다 — 앱의 buildCustomGridSlots 규칙.
        const isGk = grid.id === 'gk' || (isCustom && grid.gridY === CUSTOM_GK_GRID_Y);
        const layerKey = `${side}_${isGk ? 'gk' : 'field'}`;
        const layer = DUAL_LAYERS.find((entry) => entry.key === layerKey) ?? DUAL_LAYERS[0];
        const meters = lineupMeters(rowMap.get(grid.gridY) ?? 0, rowCount, grid.gridX, attacksRight);
        nextDots.push({
          id: newDotId(),
          ...meters,
          ...screenFromMeter(meters.meter_x, meters.meter_y),
          team: relationForTeamSide(side, team),
          teamSide: side,
          layer: layer.key,
          role: layer.role,
          color: layer.color,
          number: player.jersey,
          ghost: true,
        });
      });
      if (sidePlaced) placed.push(`${side === 'home' ? '홈' : '어웨이'} ${sidePlaced}명`);
    });

    if (!nextDots.length) {
      setStatus(
        alreadyActive
          ? `이미 ${alreadyActive}명이 활성화되어 있습니다 — 새로 깔 잔상이 없습니다`
          : '배치할 선발 선수가 없습니다 — 라인업에 포지션 정보가 없을 수 있습니다',
      );
      return;
    }

    pushDualUndo();
    // 걷어낸 건 잔상뿐이다. 잔상은 클릭해야 실제 점이 되므로 화살표가 걸려 있을 수 없어
    // 화살표는 손대지 않는다(실제 점을 지우던 예전 배치와 다른 점).
    setBeforeDots([...keptDots, ...nextDots]);
    setSelectedDualDot(null);
    setStatus(
      `라인업 잔상 배치 — ${placed.join(' · ')} · 필요한 선수를 클릭하면 활성화됩니다`
      + (alreadyActive ? ` · 이미 활성화된 ${alreadyActive}명은 그대로 둠` : '')
      + (clearedGhosts ? ` · 옛 잔상 ${clearedGhosts}개 교체` : '')
      + (skipped ? ` · ${skipped}명은 자리 정보를 못 읽어 건너뜀` : ''),
    );
  };

  /** 잔상 클릭 = 활성화. 좌표는 그대로 두고 ghost 표시만 뗀다.
      반환값은 '이 클릭이 활성화였는가' — 이어지는 드래그가 undo 스냅샷을 또 찍지 않게 쓴다. */
  const activateGhostDot = (side: PitchSide, index: number): boolean => {
    const list = side === 'before' ? beforeDots : afterDots;
    const target = list[index];
    if (!target?.ghost) return false;
    pushDualUndo();
    const activate = (prev: PitchDot[]) =>
      prev.map((dot, dotIndex) => (dotIndex === index ? { ...dot, ghost: false } : dot));
    if (side === 'before') setBeforeDots(activate);
    else setAfterDots(activate);
    setStatus(
      `${target.number ? `${target.number}번` : '선수'} 활성화 — 실제 위치로 끌어다 놓으세요`,
    );
    return true;
  };

  /** 남은 잔상을 전부 걷어낸다 — 액션에 안 쓰는 선수 자리를 치워 피치를 비운다. */
  const clearGhostDots = () => {
    if (!beforeGhostCount) return;
    pushDualUndo();
    setBeforeDots((prev) => prev.filter((dot) => !dot.ghost));
    setSelectedDualDot(null);
    setStatus(`잔상 ${beforeGhostCount}개를 지웠습니다`);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    // embed 모드(클립 결과 탭의 iframe 모달) — 사이드바/탑바를 숨겨 dual 창만 보이게 한다.
    if (params.get('embed')) document.documentElement.classList.add('fpa-embed');
    const clipId = params.get('clipId');
    if (!clipId) return;
    void (async () => {
      try {
        const d = await apiJson<{
          id: string;
          // 클립 귀속 팀(태깅 시점 A=홈/D=어웨이) — dual 의 행위 팀 기본값이 된다.
          team_side?: string | null;
          team_labels?: { home?: string; away?: string };
          lineup_sides?: LineupSides;
          action_count?: number;
          actions?: unknown[];
          fpa_scenes?: {
            half?: '1H' | '2H' | null;
            team?: 'home' | 'away' | null;
            direction?: 'left' | 'right' | null;
            // 옛 액션에서 되살린 것 — 하프·공격방향은 원본에 없어 비어 있다.
            reconstructed?: boolean;
            scenes?: SavedScene[];
          } | null;
        }>(`/highlight/clip-results/clips/${clipId}`);
        setClipTarget({
          id: d.id,
          label: `${d.team_labels?.home || 'Home'} vs ${d.team_labels?.away || 'Away'}`,
        });
        if (d.team_labels?.home) setTeamIdH(d.team_labels.home);
        if (d.team_labels?.away) setTeamIdA(d.team_labels.away);
        if (d.lineup_sides) setLineupSides(d.lineup_sides);
        setInputMode('dual');

        // 행위 팀을 클립 귀속 팀으로 맞춘다 — 홈 고정이면 어웨이 클립마다 손으로 바꿔야 하고,
        // 안 바꾸고 찍으면 아군/상대가 뒤집혀 채점까지 어긋난다.
        // 점 찍는 레이어도 같이 맞춘다: 팀만 바꾸면 첫 점이 **상대 점**으로 찍힌다
        // (relationForTeamSide 가 activeLayer 의 teamSide 를 행위 팀과 비교한다).
        // 저장된 태깅이 있으면 아래에서 그때 실제로 쓴 값이 이걸 덮는다.
        //
        // 이 창에 아직 저장 안 한 작업이 남아 있으면 건드리지 않는다 — 초안이 복원한
        // 팀·레이어를 여기서 갈아치우면, 이미 찍어둔 점들과 아군/상대 관계가 어긋난다.
        const clipSide = String(d.team_side || '').trim().toLowerCase();
        if (!draftHadContentRef.current && (clipSide === 'home' || clipSide === 'away')) {
          setTeam(clipSide);
          setActiveLayer(clipSide === 'away' ? 'away_field' : 'home_field');
        }

        // 저장해 둔 태깅 되살리기 — 나중에 고칠 일이 생겼을 때 이어서 수정하기 위한 것.
        const restored = d.fpa_scenes?.scenes;
        if (draftHadContentRef.current) {
          // 이 창에 아직 저장 안 한 작업이 남아 있다. 서버본으로 덮으면 그게 날아간다.
          setStatus(`클립 귀속 모드: ${clipId} — 저장 안 한 작업이 있어 복원을 건너뛰었습니다`);
        } else if (restored?.length) {
          setSavedScenes(restored);
          setCurrentClipIndex(Math.max(1, ...restored.map((s) => s.clipIndex ?? 1)));
          if (d.fpa_scenes?.half) setHalf(d.fpa_scenes.half);
          if (d.fpa_scenes?.team) {
            // 저장된 태깅이 실제로 쓴 행위 팀 — 클립 귀속 팀보다 이쪽이 정본이다.
            setTeam(d.fpa_scenes.team);
            setActiveLayer(d.fpa_scenes.team === 'away' ? 'away_field' : 'home_field');
          }
          if (d.fpa_scenes?.direction) setDirection(d.fpa_scenes.direction);
          const actionCount = restored.reduce((sum, s) => sum + s.rows.length, 0);
          if (d.fpa_scenes?.reconstructed) {
            // 옛 액션에서 되살린 것 — 하프·공격방향은 그 시절 저장에 없어 못 되짚는다.
            setNeedsDirectionConfirm(true);
            setStatus(
              `클립 귀속 모드: ${clipId} — 옛 기록에서 장면 ${restored.length}개(액션 ${actionCount}개)를 되살렸습니다.`
              + ' ⚠ 하프·공격방향은 복원할 수 없으니 저장 전에 반드시 확인하세요',
            );
          } else {
            setStatus(`클립 귀속 모드: ${clipId} — 저장된 장면 ${restored.length}개(액션 ${actionCount}개)를 불러왔습니다`);
          }
        } else if (d.action_count || d.actions?.length) {
          // 액션은 있는데 태깅 원본이 없다 = fpa_scenes 가 생기기 전에 저장됐고
          // scripts/backfill_clip_fpa_scenes.py 도 아직 안 돌았거나, 돌렸는데 그림·스탯
          // 코드가 모자라 복원 대상에서 빠진 클립이다.
          setStatus(`클립 귀속 모드: ${clipId} — 이 클립은 태깅 원본이 남아 있지 않습니다(복원 백필 대상이 아니거나 미실행)`);
        } else if (clipSide === 'home' || clipSide === 'away') {
          // 새로 찍는 클립 — 팀이 자동으로 맞춰졌다는 걸 알려준다. 틀리면 바꾸면 된다.
          const sideName = clipSide === 'away'
            ? `어웨이${d.team_labels?.away ? `(${d.team_labels.away})` : ''}`
            : `홈${d.team_labels?.home ? `(${d.team_labels.home})` : ''}`;
          setStatus(`클립 귀속 모드: ${clipId} — 팀을 ${sideName} 로 맞췄습니다 (필요하면 바꾸세요)`);
        } else {
          setStatus(`클립 귀속 모드: ${clipId}`);
        }
      } catch {
        setStatus('클립 정보를 불러오지 못했습니다');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveRowsToClip = async () => {
    if (!clipTarget) return;
    // 이 창에서 찍은 전부 — 저장된 장면들 + 현재 버퍼(flatten, 장면별 SceneState/주인공 포함).
    // 버퍼만 보내면 "장면 저장" 후 rows 가 비어 마지막 행만 남는 문제가 있었다.
    const sourceRows = buildRowsForPersistence();
    if (!sourceRows.length) {
      setStatus('클립에 저장할 액션이 없습니다');
      return;
    }
    if (!confirmRestoredDirection('저장')) return;
    setBusy(true);
    try {
      const res = await apiJson<{ actions: unknown[] }>(
        `/highlight/clip-results/clips/${clipTarget.id}/actions`,
        {
          method: 'PUT',
          body: JSON.stringify({
            rows: sourceRows,
            // 태깅 원본 — 액션(rows 에서 파생)과 별개로 **찍은 그대로** 남긴다.
            // 이걸 안 남기면 클립을 다시 열었을 때 되살릴 수가 없다: 액션 스키마에는
            // StatInput(재채점용 원본 코드)·로그 텍스트·하프/공격방향이 없고,
            // 서버가 sceneState 에서 점 스냅샷만 추려 scene_index 도 버리기 때문이다.
            scenes: {
              schema: 'fineplay.fpa.clip_scenes.v0.1',
              savedAt: new Date().toISOString(),
              half,
              team,
              direction,
              teamIdH,
              teamIdA,
              scenes: collectScenesForPersistence(),
            },
          }),
        },
      );
      setStatus(`클립 ${clipTarget.id}에 액션 ${res.actions.length}개 저장 완료 — 결과 탭에서 구간을 조정하세요`);
      // iframe 모달(parent) 또는 분리 창(opener)으로 떠 있으면 클립 결과 탭에 알려 액션 목록을 즉시 갱신시킨다.
      const host = window.parent !== window ? window.parent : window.opener;
      if (host) {
        host.postMessage({ type: 'fpa-clip-saved', clipId: clipTarget.id }, window.location.origin);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '클립 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  const openMatchPicker = async () => {
    setMatchPickerOpen(true);
    setMatchFilterClass('ALL');
    setMatchFilterRound('ALL');
    setStatus('경기 목록 불러오는 중');
    try {
      const data = await apiJson<Match[]>('/matches');
      setAvailableMatches(Array.isArray(data) ? data : []);
      setStatus('경기 선택 준비됨');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '경기 목록 불러오기 실패');
    }
  };

  const loadMatch = async (match: Match) => {
    setBusy(true);
    setStatus('경기와 저장된 FPA 로그 불러오는 중');
    try {
      const teams = parseMatchTeams(match);
      setFpaSport(match.sport === 'FUTSAL' ? 'FUTSAL' : 'FOOTBALL');
      setMatchId(match.id);
      setTeamIdH(teams.home);
      setTeamIdA(teams.away);

      const saved = await apiJson<{
        logs: string[];
        rows: LogPreview[];
        teamid_h: string;
        teamid_a: string;
      }>(`/fpa/matches/${match.id}/logs`);
      const savedLogs = saved.logs || [];
      const savedRows = saved.rows || [];
      const persistedScenes = scenesFromPersistedRows(savedRows, savedLogs, team);
      const dualScene = sceneFromDualLogs(savedRows, savedLogs, team);
      if (persistedScenes.length) {
        setInputMode('dual');
        setSavedScenes(persistedScenes);
        setSelectedSceneIndex(0);
        setLogs([]);
        setRows([]);
        setSelectedRowIndex(null);
      } else if (dualScene) {
        setInputMode('dual');
        setSavedScenes([dualScene]);
        setSelectedSceneIndex(0);
        setLogs([]);
        setRows([]);
        setSelectedRowIndex(null);
      } else {
        setLogs(savedLogs);
        setRows(savedRows);
        setSelectedRowIndex(savedRows.length ? 0 : null);
        // 불러온 경기 로그는 현재 버퍼로 (장면 구조 없음). scene/수정용 피치 상태 초기화.
        setSavedScenes([]);
        setSelectedSceneIndex(null);
      }
      closeSceneEditor();
      resetDualUndo();
      setPrimaryRowIndex(null);
      setPendingPass(null);
      setPendingDefStart(null);
      setPassArrows([]);
      if (saved.teamid_h) setTeamIdH(saved.teamid_h);
      if (saved.teamid_a) setTeamIdA(saved.teamid_a);
      setMatchPickerOpen(false);
      setStatus(saved.logs?.length ? `저장된 FPA 로그 ${saved.logs.length}건 불러오기 완료` : '경기 정보 불러오기 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '경기 불러오기 실패');
    } finally {
      setBusy(false);
    }
  };

  const saveLogsToMatch = async () => {
    if (!allLogs.length) {
      setStatus('저장할 로그가 없습니다');
      return;
    }
    const rawMatchId = matchId.trim();
    const matchIdForSave = rawMatchId && rawMatchId !== 'ID' ? rawMatchId : generateMatchId();
    const generatedMatchId = matchIdForSave !== rawMatchId;
    const nextMatchIdError = validateMatchIdForSave(matchIdForSave);
    setMatchIdError(nextMatchIdError);
    if (nextMatchIdError) {
      setStatus(nextMatchIdError);
      return;
    }
    const homeTeamForSave = teamIdH.trim() || 'Home';
    const awayTeamForSave = teamIdA.trim() || 'Away';
    setBusy(true);
    setStatus(generatedMatchId ? '랜덤 Match ID 생성 후 FPA 로그 DB 저장 중' : 'FPA 로그 DB 저장 중');
    try {
      const response = await apiFetch(`/fpa/matches/${encodeURIComponent(matchIdForSave)}/logs`, {
        method: 'PUT',
        body: JSON.stringify({
          logs: allLogs,
          rows: buildRowsForPersistence(),
          teamid_h: homeTeamForSave,
          teamid_a: awayTeamForSave,
        }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || 'FPA 로그 저장 실패');
        return;
      }
      setMatchId(matchIdForSave);
      setTeamIdH(homeTeamForSave);
      setTeamIdA(awayTeamForSave);
      setStatus(generatedMatchId ? `FPA 로그 ${allLogs.length}건 저장 완료 · Match ID 자동 생성됨` : `FPA 로그 ${allLogs.length}건 저장 완료`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'FPA 로그 저장 실패');
    } finally {
      setBusy(false);
    }
  };

  // 현재 버퍼(현재 장면/single 로그)에서 특정 인덱스 액션 삭제 + primary/선택 동기화
  const removeLogAt = (removedIdx: number) => {
    if (inputMode === 'dual') pushDualUndo();
    setLogs((prev) => prev.filter((_, index) => index !== removedIdx));
    setRows((prev) => prev.filter((_, index) => index !== removedIdx));
    setSelectedRowIndex((sel) => (sel == null ? null : sel === removedIdx ? null : sel > removedIdx ? sel - 1 : sel));
    setPrimaryRowIndex((p) => (p == null ? p : p === removedIdx ? null : p > removedIdx ? p - 1 : p));
    setStatus('액션 삭제');
  };

  const removeSelectedLog = () => {
    if (selectedRowIndex == null) return;
    removeLogAt(selectedRowIndex);
  };

  const moveSelectedLog = (directionDelta: -1 | 1) => {
    if (selectedRowIndex == null) return;
    const nextIndex = selectedRowIndex + directionDelta;
    if (nextIndex < 0 || nextIndex >= rows.length) return;

    const reorder = <T,>(items: T[]) => {
      const nextItems = [...items];
      const [picked] = nextItems.splice(selectedRowIndex, 1);
      nextItems.splice(nextIndex, 0, picked);
      return nextItems;
    };

    if (inputMode === 'dual') pushDualUndo();
    setLogs((prev) => reorder(prev));
    setRows((prev) => reorder(prev));
    setSelectedRowIndex(nextIndex);
    // scene 인덱스 동기화 (인접 swap)
    const swap = (i: number) => (i === selectedRowIndex ? nextIndex : i === nextIndex ? selectedRowIndex : i);
    setPrimaryRowIndex((p) => (p == null ? p : swap(p)));
    setStatus(directionDelta < 0 ? '선택한 로그를 위로 이동' : '선택한 로그를 아래로 이동');
  };

  const adjustTimeline = (deltaSeconds: number) => {
    const [minutesRaw, secondsRaw] = timeline.split(':');
    const minutes = Number(minutesRaw || 0);
    const seconds = Number(secondsRaw || 0);
    const next = Math.max(0, minutes * 60 + seconds + deltaSeconds);
    const mm = String(Math.floor(next / 60)).padStart(2, '0');
    const ss = String(next % 60).padStart(2, '0');
    setTimeline(`${mm}:${ss}`);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      // Esc 취소는 어느 입력칸에 포커스가 있든 동작해야 함 (코드 입력 직후가 대부분)
      if (event.key === 'Escape' && (pendingPass || pendingDefStart || editPendingPass || editPendingDefStart)) {
        event.preventDefault();
        cancelArrowDraw();
        return;
      }
      // ⌘Z/Ctrl+Z = 라이브 dual 캔버스 undo. 입력칸에 지울 텍스트가 있으면 브라우저 기본 undo 우선
      if (inputMode === 'dual' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') {
        if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value) return;
        event.preventDefault();
        undoDual();
        return;
      }
      if (target instanceof HTMLElement && target.tagName === 'INPUT' && target.id !== 'fpa-live-timeline' && target.id !== 'fpa-live-stat-input') {
        return;
      }
      const isTextEntryTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (inputMode === 'dual' && !isTextEntryTarget) {
        const eventHotkey = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
        const layer = DUAL_LAYERS.find((entry) => entry.hotkey === eventHotkey);
        if (layer) {
          event.preventDefault();
          setActiveLayer(layer.key);
          setStatus(`레이어: ${layer.label}`);
          return;
        }
      }

      if (
        inputMode === 'dual' &&
        editSelectedDot &&
        (event.key === 'Backspace' || event.key === 'Delete') &&
        !isTextEntryTarget
      ) {
        event.preventDefault();
        removeEditDotAt(editSelectedDot.side, editSelectedDot.index);
        return;
      }

      if (
        inputMode === 'dual' &&
        selectedDualDot &&
        (event.key === 'Backspace' || event.key === 'Delete') &&
        !isTextEntryTarget
      ) {
        event.preventDefault();
        removeSelectedDualDot();
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        event.preventDefault();
        adjustTimeline(60);
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        event.preventDefault();
        adjustTimeline(-60);
        return;
      }

      if (event.key === 'Enter' && document.activeElement?.id === 'fpa-live-stat-input') {
        event.preventDefault();
        void addLog();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [afterDots, beforeDots, busy, direction, dots, activeLayer, editAfterDots, editBeforeDots, editPendingDefStart, editPendingPass, editSelectedDot, half, inputMode, pendingDefStart, pendingPass, pendingXgot, rows.length, selectedDualDot, statInput, team, timeline]);

  const renderXgotPanel = () => {
    if (!pendingXgot) return null;
    return (
      <div className="fpa-xgot-panel">
        <div className="fpa-xgot-summary">
          <div>
            <span>xG</span>
            <strong>{pendingXgot.xg.toFixed(3)}</strong>
          </div>
          <div>
            <span>Shot</span>
            <strong>{pendingXgot.isGoal ? 'Goal' : pendingXgot.isOnTarget ? 'On Target' : 'Off Target'}</strong>
          </div>
          <div>
            <span>xGOT</span>
            <strong>{xgotBusy ? '...' : xgotEstimate ? xgotEstimate.xgot.toFixed(3) : '-'}</strong>
          </div>
        </div>

        <div className="fpa-xgot-body">
          <div className="fpa-goalmouth-target" onClick={handleGoalmouthClick} role="button" tabIndex={0}>
            <div className="fpa-goalmouth-frame" ref={goalmouthFrameRef}>
              <div className="fpa-goalmouth-net" />
              <div className="fpa-goalmouth-post left" />
              <div className="fpa-goalmouth-post right" />
              <div className="fpa-goalmouth-line one" />
              <div className="fpa-goalmouth-line two" />
              <div className="fpa-goalmouth-line horizontal" />
            </div>
            {goalmouthPoint ? (
              <div
                className="fpa-goalmouth-point"
                style={{ left: `${goalmouthPoint.viewX * 100}%`, top: `${goalmouthPoint.viewY * 100}%` }}
              />
            ) : null}
          </div>
        </div>

        <div className="fpa-xgot-footer">
          <div className="fpa-xgot-actions">
            <button disabled={xgotBusy} onClick={skipXgotInput} type="button">Skip</button>
            <button className="primary" disabled={!goalmouthPoint || xgotBusy} onClick={submitXgotInput} type="button">
              {xgotBusy ? 'Saving' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderDualPitch = (side: PitchSide) => {
    const renderDots = side === 'before' ? beforePitchDots : afterPitchDots;
    const panelRef = side === 'before' ? beforePitchRef : afterPitchRef;
    const title = side === 'before' ? 'Before' : 'After';
    // 잔상은 아직 찍은 점이 아니라 A/O 개수에서 빼고 따로 센다.
    const activeDots = renderDots.filter((dot) => !dot.ghost);
    const allyCount = activeDots.filter((dot) => dot.team === 'ally').length;
    const opponentCount = activeDots.length - allyCount;
    const ghostCount = renderDots.length - activeDots.length;
    const armedHere = liveArrowArm?.side === side;
    return (
      <div className="fpa-dual-pitch-card">
        <div className="fpa-dual-pitch-head">
          <span>{title}</span>
          <div>
            <span className="fpa-dual-pitch-count">A{allyCount} O{opponentCount}</span>
            {ghostCount ? (
              <span className="fpa-dual-pitch-count ghost" title="라인업 잔상 — 클릭해야 실제 점이 됩니다">
                잔상 {ghostCount}
              </span>
            ) : null}
            <button onClick={undoDual} title="마지막 조작 되돌리기 (⌘Z)" type="button">Undo</button>
            <button onClick={() => clearDualDots(side)} type="button">Clear</button>
          </div>
        </div>
        <div
          className={`fpa-pitch fpa-pitch-cream ${isFutsal ? 'fpa-pitch-futsal' : ''} ${armedHere ? 'fpa-pitch-armed' : ''}`}
          onClick={(event) => handleDualPitchClick(side, event)}
          onContextMenu={(event) => {
            // 점 위 우클릭은 점 자체 핸들러가 처리(그 점 삭제). 여기(빈 곳)로 오면
            // 커서에 가장 가까운 점을 지우고, 근처에 점이 없을 때만 마지막 점을 지운다.
            event.preventDefault();
            const rect = panelRef.current?.getBoundingClientRect();
            const idx = rect ? nearestDotIndex(renderDots, event.clientX, event.clientY, rect) : -1;
            if (idx >= 0) removeDualDotAt(side, idx);
            else removeLastDualDot(side);
          }}
          onPointerLeave={() => {
            if (arrowPreview?.canvas === 'live' && arrowPreview.side === side) setArrowPreview(null);
          }}
          onPointerMove={(event) => trackArrowPreview('live', side, liveArrowArm, event, panelRef.current?.getBoundingClientRect())}
          ref={panelRef}
          role="button"
          tabIndex={0}
        >
          {isFutsal ? <FutsalPitch alt={`${title} ${activePitchLabel}`} /> : <img alt={`${title} ${activePitchLabel}`} className="fpa-pitch-image" draggable={false} src={activePitchSrc} />}
          {armedHere && liveArrowArm ? (
            <div className="fpa-arrow-arm-badge" onClick={(event) => event.stopPropagation()}>
              <b>{liveArrowArm.code}</b>
              <span>{arrowArmHint(liveArrowArm.code, liveArrowArm.stage)}</span>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  cancelArrowDraw();
                }}
                title="화살표 그리기 취소 (Esc)"
                type="button"
              >
                ✕
              </button>
            </div>
          ) : null}
          {renderDots.map((dot, index) => {
            const selected = selectedDualDot?.side === side && selectedDualDot.index === index;
            return (
              <div
                className={`fpa-pitch-dot fpa-dual-dot ${dot.team === 'opponent' ? 'opponent' : 'ally'} ${selected ? 'selected' : ''} ${dot.needsCheck ? 'needs-check' : ''} ${dot.role === 'gk' ? 'is-gk' : ''} ${dot.ghost ? 'ghost' : ''} side-${dotShapeSide(dot, team)}`}
                key={`${side}-${index}-${dot.left}-${dot.top}`}
                title={dot.ghost ? '라인업 잔상 — 클릭하면 활성화됩니다 (우클릭: 지우기)' : undefined}
                onClick={(event) => {
                  // 화살표 그리는 중엔 점을 선택하지 않고 피치로 흘려보냄 (끊은 지점이 수비수 점 위인 경우가 흔함)
                  if (armedHere) return;
                  event.stopPropagation();
                  selectLiveDualDot({ side, index });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  removeDualDotAt(side, index);
                }}
                onPointerDown={(event) => {
                  if (armedHere) return;
                  // 우클릭(삭제)에서 드래그가 arming 되면, 삭제로 인덱스가 당겨진 뒤 커서 이동에 다른 점이 끌려온다
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  // 잔상이면 이 누름이 곧 활성화다. 활성화가 undo 스냅샷을 이미 찍었으므로
                  // 이어지는 드래그가 같은 제스처로 또 찍지 않게 historyPushed 로 넘긴다.
                  const activated = activateGhostDot(side, index);
                  draggingDualDotRef.current = { side, index, canvas: 'live', historyPushed: activated };
                  selectLiveDualDot({ side, index });
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                style={{ left: dot.left, top: dot.top }}
                tabIndex={0}
              >
                <DualToken side={dotShapeSide(dot, team)} role={dot.role} />
                <span className="fpa-dot-num">{dot.label}</span>
                {dot.role === 'gk' ? <span className="fpa-dot-gk">GK</span> : null}
                {dot.needsCheck ? <span className="fpa-dot-check">?</span> : null}
              </div>
            );
          })}
          {renderArrowOverlay('live', side, passArrows, liveArrowArm)}
          {renderArrowChips(side, passArrows)}
        </div>
      </div>
    );
  };

  // 수정용 피치 캔버스 — 기록된 로그 아래. 라이브 Before/After 와 같은 조작(점 추가·드래그·삭제), 데이터만 분리
  const renderEditPitch = (side: PitchSide) => {
    const renderDots = side === 'before' ? editBeforePitchDots : editAfterPitchDots;
    const panelRef = side === 'before' ? editBeforePitchRef : editAfterPitchRef;
    const title = side === 'before' ? 'Before' : 'After';
    const allyCount = renderDots.filter((dot) => dot.team === 'ally').length;
    const opponentCount = renderDots.length - allyCount;
    const armedHere = editArrowArm?.side === side;
    return (
      <div className="fpa-dual-pitch-card">
        <div className="fpa-dual-pitch-head">
          <span>{title}</span>
          <div>
            <span className="fpa-dual-pitch-count">A{allyCount} O{opponentCount}</span>
            <button onClick={() => removeLastEditDot(side)} type="button">Undo</button>
            <button onClick={() => clearEditDots(side)} type="button">Clear</button>
          </div>
        </div>
        <div
          className={`fpa-pitch fpa-pitch-cream ${isFutsal ? 'fpa-pitch-futsal' : ''} ${armedHere ? 'fpa-pitch-armed' : ''}`}
          onClick={(event) => handleEditPitchClick(side, event)}
          onContextMenu={(event) => {
            // 점 위 우클릭은 점 자체 핸들러가 처리(그 점 삭제). 빈 곳으로 오면
            // 커서에 가장 가까운 점을 지우고, 근처에 점이 없을 때만 마지막 점을 지운다.
            event.preventDefault();
            const rect = panelRef.current?.getBoundingClientRect();
            const idx = rect ? nearestDotIndex(renderDots, event.clientX, event.clientY, rect) : -1;
            if (idx >= 0) removeEditDotAt(side, idx);
            else removeLastEditDot(side);
          }}
          onPointerLeave={() => {
            if (arrowPreview?.canvas === 'edit' && arrowPreview.side === side) setArrowPreview(null);
          }}
          onPointerMove={(event) => trackArrowPreview('edit', side, editArrowArm, event, panelRef.current?.getBoundingClientRect())}
          ref={panelRef}
          role="button"
          tabIndex={0}
        >
          {isFutsal ? <FutsalPitch alt={`${title} ${activePitchLabel} (수정용)`} /> : <img alt={`${title} ${activePitchLabel} (수정용)`} className="fpa-pitch-image" draggable={false} src={activePitchSrc} />}
          {armedHere && editArrowArm ? (
            <div className="fpa-arrow-arm-badge" onClick={(event) => event.stopPropagation()}>
              <b>{editArrowArm.code}</b>
              <span>{arrowArmHint(editArrowArm.code, editArrowArm.stage)}</span>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  cancelArrowDraw();
                }}
                title="화살표 그리기 취소 (Esc)"
                type="button"
              >
                ✕
              </button>
            </div>
          ) : null}
          {renderDots.map((dot, index) => {
            const selected = editSelectedDot?.side === side && editSelectedDot.index === index;
            return (
              <div
                className={`fpa-pitch-dot fpa-dual-dot ${dot.team === 'opponent' ? 'opponent' : 'ally'} ${selected ? 'selected' : ''} ${dot.needsCheck ? 'needs-check' : ''} ${dot.role === 'gk' ? 'is-gk' : ''} side-${dotShapeSide(dot, editTeam)}`}
                key={`edit-${side}-${index}-${dot.left}-${dot.top}`}
                onClick={(event) => {
                  if (armedHere) return;
                  event.stopPropagation();
                  selectEditDot({ side, index });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  removeEditDotAt(side, index);
                }}
                onPointerDown={(event) => {
                  if (armedHere) return;
                  // 우클릭(삭제)에서 드래그 arming 금지 — live 캔버스와 동일 사유
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  draggingDualDotRef.current = { side, index, canvas: 'edit' };
                  selectEditDot({ side, index });
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                style={{ left: dot.left, top: dot.top }}
                tabIndex={0}
              >
                <DualToken side={dotShapeSide(dot, editTeam)} role={dot.role} />
                <span className="fpa-dot-num">{dot.label}</span>
                {dot.role === 'gk' ? <span className="fpa-dot-gk">GK</span> : null}
                {dot.needsCheck ? <span className="fpa-dot-check">?</span> : null}
              </div>
            );
          })}
          {renderArrowOverlay('edit', side, editPassArrows, editArrowArm)}
          {renderArrowChips(side, editPassArrows)}
        </div>
      </div>
    );
  };

  // 수정용 피치 패널 — 기록된 로그 아래. 저장 장면 편집 전용 (라이브 찍는 데이터는 위 캔버스에 그대로)
  const renderSceneEditor = () => {
    if (editingSceneIndex == null) return null;
    return (
      <section className="fpa-pitch-panel fpa-scene-editor">
        <div className="fpa-panel-header">
          <div className="fpa-panel-title">수정용 피치 · 액션 {editingSceneIndex + 1} 편집 중</div>
          <div className="fpa-panel-actions">
            <button onClick={closeSceneEditor} type="button">편집 취소</button>
            <button className="primary" disabled={!editRows.length} onClick={saveEditedScene} type="button">수정 저장</button>
          </div>
        </div>
        <div className="fpa-dual-input-bar">
          {renderPointTypeControl()}
          <div className="fpa-live-control-group">
            <span>Direction</span>
            <div className="fpa-segmented">
              <button className={editDirection === 'right' ? 'active' : ''} onClick={() => setEditDirection('right')} type="button">Right</button>
              <button className={editDirection === 'left' ? 'active' : ''} onClick={() => setEditDirection('left')} type="button">Left</button>
            </div>
          </div>
          <div className="fpa-live-meta-field">
            <span>Half</span>
            <div className="fpa-segmented">
              <button className={editHalf === '1H' ? 'active' : ''} onClick={() => setEditHalf('1H')} type="button">1st</button>
              <button className={editHalf === '2H' ? 'active' : ''} onClick={() => setEditHalf('2H')} type="button">2nd</button>
            </div>
          </div>
          <div className="fpa-live-control-group">
            <span>Team</span>
            <div className="fpa-segmented">
              <button className={editTeam === 'home' ? 'active' : ''} onClick={() => setEditTeam('home')} type="button">Home</button>
              <button className={editTeam === 'away' ? 'active' : ''} onClick={() => setEditTeam('away')} type="button">Away</button>
            </div>
          </div>
        </div>
        <div className="fpa-scene-editor-grid">
          <div className="fpa-scene-editor-pitches">
            {renderEditPitch('before')}
            {pendingXgot && pendingXgot.canvas === 'edit' ? (
              <div className="fpa-dual-pitch-card fpa-dual-xgot-card">
                <div className="fpa-dual-pitch-head">
                  <span>xGOT Input</span>
                  <div>
                    <span className="fpa-dual-pitch-count">Shot {pendingXgot.isGoal ? 'Goal' : pendingXgot.isOnTarget ? 'On Target' : 'Off Target'}</span>
                  </div>
                </div>
                {renderXgotPanel()}
              </div>
            ) : (
              renderEditPitch('after')
            )}
          </div>
          <aside className="fpa-scene-editor-actions">
            <div className="fpa-scene-actions">
              {editRows.length === 0 ? (
                <span className="muted">이 장면에 남은 액션이 없습니다</span>
              ) : (
                editRows.map((row, index) => {
                  const isPrimary = editPrimary === index;
                  return (
                    <div
                      className="fpa-scene-action-row"
                      key={`edit-${index}-${row.Player}-${row.Action}`}
                      onClick={() => setEditSelectedRowIndex(index)}
                      role="button"
                      tabIndex={0}
                      style={{ outline: editSelectedRowIndex === index ? '1px solid var(--accent)' : 'none' }}
                    >
                      <span>
                        <button
                          className={`fpa-scene-primary ${isPrimary ? 'on' : ''}`}
                          onClick={(event) => { event.stopPropagation(); setEditPrimary(index); }}
                          title="primary 액션으로 지정"
                          type="button"
                        >★</button>
                        {row.Team} {row.Player} · {row.Action}{row.Receiver ? ` → ${row.Receiver}` : ''}
                      </span>
                      <span className="metrics">
                        xG {row.xG ?? '-'} · EPV {row.EPV ?? '-'} · PC {row.PC ?? '-'}
                        {row.xGOT ? ` · xGOT ${row.xGOT}` : ''}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            <div className="fpa-scene-footer">
              <button
                className="fpa-scene-del-btn"
                disabled={editSelectedRowIndex == null}
                onClick={() => { if (editSelectedRowIndex != null) removeEditLogAt(editSelectedRowIndex); }}
                type="button"
              >선택 액션 삭제</button>
            </div>
          </aside>
        </div>
        <div className="fpa-dual-entry-bar">
          <div className="fpa-live-control-group">
            <span>Game Time</span>
            <div className="fpa-time-control">
              <button onClick={() => adjustEditTimeline(-60)} type="button">-1</button>
              <input
                id="fpa-edit-timeline"
                value={editTimeline}
                onChange={(event) => setEditTimeline(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); adjustEditTimeline(60); }
                  if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); adjustEditTimeline(-60); }
                }}
              />
              <button onClick={() => adjustEditTimeline(60)} type="button">+1</button>
            </div>
          </div>
          <div className="fpa-live-control-group fpa-live-control-group-wide">
            <span>Stat Input</span>
            <div className="fpa-stat-input-row">
              <input
                id="fpa-edit-stat-input"
                ref={editStatInputRef}
                value={editStatInput}
                onChange={(event) => setEditStatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void addEditLog();
                  }
                }}
                placeholder="스탯 코드 (예: 10ss8.k.f.w, 4tt7.lt)"
              />
              <button className="submit" disabled={!editStatInput.trim() || busy || Boolean(pendingXgot)} onClick={addEditLog} type="button">
                ↵
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  };

  // 로그 행 1줄. clickable=true(single) → 행 클릭 선택, false(dual 장면 내) → 표시만(장면 그룹이 클릭 처리)
  // role: 장면(그룹) 안에서의 위치 — 'main'=★ 주 액션, 'sub'=거기 종속된 부 액션(침투 등).
  // 전송 시 groupIndex/isGroupMain 으로 나가는 관계를 로그에서도 같은 모양으로 보여준다.
  const renderLogRow = (
    row: LogPreview,
    logStr: string | undefined,
    key: string,
    clickable: boolean,
    index: number,
    role: 'main' | 'sub' | null = null,
  ) => {
    const logParts = logStr?.split(' | ') || [];
    const jerseyCell = (jersey: string | undefined, fallback: string) => (
      <span>{(jersey || '').trim() || fallback}</span>
    );
    return (
      <div
        className={`fpa-log-entry ${clickable && selectedRowIndex === index ? 'selected' : ''} ${role === 'sub' ? 'sub' : ''}`}
        key={key}
        onClick={clickable ? () => setSelectedRowIndex(index) : undefined}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
      >
        <span>{logParts[0] || '-'}</span>
        <span>{row.Time}</span>
        <span>{row.Team}</span>
        <span>{logParts[2] || '-'}</span>
        {jerseyCell(row.Player, '')}
        <span title={role === 'sub' ? '부 액션 — 위 ★ 주 액션에 종속' : role === 'main' ? '주 액션 (★)' : undefined}>
          {role === 'sub' ? '↳ ' : role === 'main' ? '★ ' : ''}
          {row.Action}
        </span>
        {jerseyCell(row.Receiver, '-')}
        <span>{row.Coord}</span>
        <span>{extractReceiveCoord(logStr) || '-'}</span>
        <span title={row.Tags || '-'}>{row.Tags || '-'}</span>
        <span>{displayMetric(row, logStr, 'xG')}</span>
        <span>{displayMetric(row, logStr, 'xGOT')}</span>
        <span>{displayMetric(row, logStr, 'EPV')}</span>
        <span>{displayMetric(row, logStr, 'PC')}</span>
        <span title={extractDualStateSummary(logStr) || '-'}>{extractDualStateSummary(logStr) || '-'}</span>
      </div>
    );
  };

  // 장면 안 로그 표시 순서 — 주 액션(★ primary) 먼저, 나머지는 그 아래 종속(↳).
  // **표시만** 재배치한다. 원본 rows 순서·primary 인덱스는 그대로 두어야 전송 seq·
  // SceneState.primary(장면 내 행 인덱스) 기준 재채점이 어긋나지 않는다.
  const sceneRowOrder = (count: number, primary: number | null) => {
    if (count <= 0) return [];
    if (count === 1) return [{ j: 0, role: null as 'main' | 'sub' | null }];
    const main = primary != null && primary >= 0 && primary < count ? primary : 0;
    const subs = Array.from({ length: count }, (_, j) => j).filter((j) => j !== main);
    return [
      { j: main, role: 'main' as 'main' | 'sub' | null },
      ...subs.map((j) => ({ j, role: 'sub' as 'main' | 'sub' | null })),
    ];
  };

  const renderLogPanel = () => (
    <section className="fpa-log-panel">
      <div className="fpa-panel-header">
        <div className="fpa-panel-title">
          기록된 로그
          {clipTarget ? (
            <span style={{ marginLeft: 8, fontSize: 12, color: '#f59e0b' }}>
              🎬 클립 귀속: {clipTarget.id} ({clipTarget.label})
            </span>
          ) : null}
        </div>
        <div className="fpa-panel-actions">
          {clipTarget ? (
            <>
              {/* 채점 산식이 바뀐 뒤 옛 클립을 열었을 때 — 행에 박힌 옛 지표를 지금 로직으로 다시 계산한다. */}
              <button
                disabled={busy || !savedScenes.length}
                onClick={() => void rescoreAllScenes()}
                title="저장된 장면 전부를 현재 채점 로직으로 다시 계산합니다 (저장은 따로 눌러야 반영)"
                type="button"
              >
                🔄 현재 로직으로 재채점
              </button>
              <button className="primary" disabled={busy} onClick={saveRowsToClip} type="button">
                클립에 저장
              </button>
            </>
          ) : null}
          <input
            accept=".xlsx,.xls"
            hidden
            onChange={(event) => void importWorkbook(event.target.files?.[0] || null)}
            ref={importInputRef}
            type="file"
          />
          <button onClick={() => importInputRef.current?.click()} type="button">
            수정 및 불러오기
          </button>
          <button onClick={openMatchPicker} type="button">
            경기 불러오기
          </button>
          <button className="primary" disabled={!allLogs.length || busy} onClick={exportWorkbook} type="button">
            분석 및 내보내기
          </button>
          <button className="primary" disabled={!allLogs.length || busy} onClick={saveLogsToMatch} type="button">
            저장
          </button>
          <button className="fpa-scene-del-btn" disabled={!allLogs.length || busy} onClick={clearAllRecordedLogs} type="button">
            전체 삭제
          </button>
        </div>
      </div>
      <div className="fpa-log-board">
        <div className="fpa-log-header">
          <span>Half</span>
          <span>Time</span>
          <span>Team</span>
          <span>Dir</span>
          <span>Player</span>
          <span>Action</span>
          <span>Receiver</span>
          <span>Pos</span>
          <span>Receive Pos</span>
          <span>Tags</span>
          <span>xG</span>
          <span>xGOT</span>
          <span>EPV</span>
          <span>PC</span>
          <span>State</span>
        </div>
        <div className="fpa-log-body" ref={logBodyRef}>
          {inputMode === 'dual'
            // dual: 저장된 장면 + 현재 작업 중 장면을 함께 표시한다.
            ? (
              <>
                {(() => {
                  // match–clip–action: 클립 번호별로 묶어서 표시 — 이전 클립으로 돌아가 저장해도 제 그룹에 들어간다.
                  // sceneIdx(전역 배열 index)는 선택/수정용으로 유지한다.
                  const groups = new Map<number, { scene: SavedScene; sceneIdx: number }[]>();
                  savedScenes.forEach((scene, sceneIdx) => {
                    const clipIdx = scene.clipIndex ?? 1;
                    if (!groups.has(clipIdx)) groups.set(clipIdx, []);
                    groups.get(clipIdx)!.push({ scene, sceneIdx });
                  });
                  return [...groups.keys()].sort((a, b) => a - b).map((clipIdx) => (
                    <Fragment key={`clip-${clipIdx}`}>
                      <div className="fpa-log-clip-divider">
                        🎬 클립 {clipIdx}
                        <span className="fpa-log-clip-count">액션 {groups.get(clipIdx)!.length}개</span>
                      </div>
                      <div className="fpa-log-clip-group">
                        {groups.get(clipIdx)!.map(({ scene, sceneIdx }, actionPos) => (
                          <div
                            className={`fpa-log-scene ${selectedSceneIndex === sceneIdx ? 'selected' : ''} ${editingSceneIndex === sceneIdx ? 'editing' : ''}`}
                            key={`scene-${sceneIdx}`}
                            onClick={() => setSelectedSceneIndex(sceneIdx)}
                            role="button"
                            tabIndex={0}
                          >
                            <div className="fpa-log-action-divider">액션 {actionPos + 1}{editingSceneIndex === sceneIdx ? ' (편집 중)' : ''}</div>
                            {sceneRowOrder(scene.rows.length, scene.primary).map(({ j, role }) =>
                              renderLogRow(scene.rows[j], scene.logs[j], `s${sceneIdx}-${j}`, false, -1, role),
                            )}
                          </div>
                        ))}
                      </div>
                    </Fragment>
                  ));
                })()}
                {rows.length ? (
                  <div className="fpa-log-scene current" key="current-scene">
                    <div className="fpa-log-action-divider">🎬 클립 {currentClipIndex} · 현재 액션 (미저장)</div>
                    {sceneRowOrder(rows.length, primaryRowIndex).map(({ j, role }) =>
                      renderLogRow(rows[j], logs[j], `current-${j}`, false, -1, role),
                    )}
                  </div>
                ) : null}
              </>
            )
            // single: 원본대로 액션 단위 로그
            : rows.map((row, index) => renderLogRow(row, logs[index], `r-${index}`, true, index))}
        </div>
      </div>
      <div className={`fpa-log-actions ${inputMode === 'dual' ? 'fpa-log-actions-dual' : ''}`}>
        {inputMode === 'dual' ? (
          <>
            <button disabled={selectedSceneIndex == null} onClick={loadSelectedScene} type="button">
              선택 액션 수정 (아래 수정용 피치)
            </button>
            <button
              className="fpa-scene-del-btn"
              disabled={selectedSceneIndex == null}
              onClick={deleteSelectedScene}
              type="button"
            >
              선택 액션 삭제
            </button>
          </>
        ) : (
          <>
            <button disabled={selectedRowIndex == null} onClick={() => moveSelectedLog(-1)} type="button">
              선택 로그 위로
            </button>
            <button disabled={selectedRowIndex == null} onClick={() => moveSelectedLog(1)} type="button">
              선택 로그 아래로
            </button>
            <button disabled={selectedRowIndex == null} onClick={removeSelectedLog} type="button">
              선택 로그 삭제
            </button>
          </>
        )}
      </div>
    </section>
  );

  const renderSinglePitchPanel = () => (
    <section className="fpa-pitch-panel">
      <div className="fpa-panel-title">{isFutsal ? '풋살 피치 · 40m × 20m' : '축구장'}</div>
      <div
        className={`fpa-pitch fpa-pitch-cream ${isFutsal ? 'fpa-pitch-futsal' : ''}`}
        onClick={handlePitchClick}
        onContextMenu={(event) => {
          event.preventDefault();
          removeLastDot();
        }}
        ref={pitchRef}
        role="button"
        tabIndex={0}
      >
        {isFutsal ? <FutsalPitch alt={activePitchLabel} /> : <img alt={activePitchLabel} className="fpa-pitch-image" draggable={false} src={activePitchSrc} />}
        {pitchDots.map((dot) => (
          <div className="fpa-pitch-dot" key={`${dot.label}-${dot.left}-${dot.top}`} style={{ left: dot.left, top: dot.top }}>
            {dot.label}
          </div>
        ))}
      </div>
    </section>
  );

  const renderDualPitchPanel = () => (
    <section className="fpa-pitch-panel fpa-dual-state-panel">
      <div className="fpa-panel-header">
        <div className="fpa-panel-title">Dual Pitch State</div>
      </div>
      <div className="fpa-dual-pitch-grid">
        {renderDualPitch('before')}
        <div className="fpa-dual-copy">
          <button
            disabled={Boolean(pendingXgot) || beforeDots.length - beforeGhostCount === 0}
            onClick={copyBeforeToAfter}
            type="button"
          >
            →
          </button>
        </div>
        {pendingXgot && pendingXgot.canvas === 'live' ? (
          <div className="fpa-dual-pitch-card fpa-dual-xgot-card">
            <div className="fpa-dual-pitch-head">
              <span>xGOT Input</span>
              <div>
                <span className="fpa-dual-pitch-count">Shot {pendingXgot.isGoal ? 'Goal' : pendingXgot.isOnTarget ? 'On Target' : 'Off Target'}</span>
              </div>
            </div>
            {renderXgotPanel()}
          </div>
        ) : (
          renderDualPitch('after')
        )}
      </div>
    </section>
  );

  // 찍은 점에 코드/번호 부여 (xFP/fpa clip 인라인 입력)
  const renderPointTypeControl = () => (
    <div className="fpa-live-control-group fpa-dual-point-type fpa-dual-layers">
      <span>레이어 (찍기 전 선택)</span>
      <div className="fpa-segmented">
        {DUAL_LAYERS.map((layer) => (
          <button
            key={layer.key}
            className={activeLayer === layer.key ? 'active' : ''}
            onClick={() => setActiveLayer(layer.key)}
            style={activeLayer === layer.key
              ? { background: layer.color, borderColor: layer.edge || layer.color, color: '#fff' }
              : { borderLeft: `4px solid ${layer.edge || layer.color}` }}
            type="button"
          >
            {layer.label} ({layer.hotkey.toUpperCase()})
          </button>
        ))}
      </div>
    </div>
  );

  const renderHalfControl = () => (
    <div className="fpa-live-meta-field">
      <span>Half</span>
      <div className="fpa-segmented">
        <button className={half === '1H' ? 'active' : ''} onClick={() => setHalf('1H')} type="button">1st</button>
        <button className={half === '2H' ? 'active' : ''} onClick={() => setHalf('2H')} type="button">2nd</button>
      </div>
    </div>
  );

  // 신청 라인업이 있는 사이드 수 — 버튼 활성화·라벨에 쓴다.
  const lineupSidesWithPlayers = (['home', 'away'] as const)
    .filter((side) => (lineupSides[side]?.players?.length ?? 0) > 0);

  const renderLineupPrefillControl = () => (
    <div className="fpa-live-control-group fpa-lineup-controls">
      <span>라인업</span>
      {/* 사전 작업은 양 팀 명단이 다 있어 한 번에 깔면 22명이 쏟아진다. 지금 클립의
          팀부터 깔 수 있게 나누고, 그 팀 버튼을 눌러둔 것처럼 표시한다. */}
      {(['home', 'away'] as const).map((side) => (
        <button
          key={side}
          type="button"
          className={team === side ? 'active' : ''}
          onClick={() => placeLineupOnBefore([side])}
          disabled={busy || !(lineupSides[side]?.players?.length ?? 0)}
          title={(lineupSides[side]?.players?.length ?? 0)
            ? `${sideLabel(side)} 선발을 before 에 잔상으로 깝니다`
              + `${team === side ? ' (지금 클립의 팀)' : ''} · 클릭한 선수만 실제 점이 됩니다`
            : `${sideLabel(side)} 라인업이 없습니다`}
        >
          {sideLabel(side)} 배치
        </button>
      ))}
      <button
        type="button"
        onClick={() => placeLineupOnBefore()}
        disabled={busy || !lineupSidesWithPlayers.length}
        title={lineupSidesWithPlayers.length
          ? 'before 프레임에 양 팀 선발을 포메이션대로 잔상으로 깝니다 (활성화된 점은 그대로 둡니다)'
          : '이 경기에 연결된 FinePlay 신청 라인업이 없습니다'}
      >
        양팀
      </button>
      <button
        type="button"
        onClick={clearGhostDots}
        disabled={busy || !beforeGhostCount}
        title="아직 활성화하지 않은 잔상을 전부 지웁니다"
      >
        잔상 지우기{beforeGhostCount ? ` (${beforeGhostCount})` : ''}
      </button>
      <button
        type="button"
        onClick={toggleDotNeedsCheck}
        disabled={busy}
        title="선택한 점의 등번호가 확실하지 않다고 표시합니다 — 저장·전송에 함께 실립니다"
      >
        ? 확인필요
      </button>
    </div>
  );

  // 레이아웃 A: Input State 를 피치 위 가로 바로 (clip UX)
  // 2열 구성 — 왼쪽 열은 위(방향·전후반·팀)/아래(레이어)로 나누고, 오른쪽 열은
  // 라인업이 두 줄에 걸쳐 통째로 쓴다. 카드에 빈 구석이 남지 않게 하려는 것이다.
  const renderDualInputBar = () => (
    <section className="fpa-dual-input-bar">
      <div className="fpa-dual-bar-row fpa-dual-bar-meta">
        {renderDirectionControl()}
        {renderHalfControl()}
        {renderTeamControl()}
      </div>
      <div className="fpa-dual-bar-row fpa-dual-bar-main">
        {renderPointTypeControl()}
      </div>
      {/* 라인업은 두 줄에 걸쳐 오른쪽 한 칸을 통째로 쓴다 — 위 줄 오른쪽이 비어
          있던 자리를 메우고, 버튼이 세로로 늘어나 눌리는 면적이 커진다. */}
      {renderLineupPrefillControl()}
    </section>
  );

  // 명단 탭 — 팀 탭으로 한쪽씩 보고, 선발/교체를 끌어다 맞바꾼다.
  // 신청 원본은 그대로 두고 화면 상태만 바뀌며, 'before 에 배치' 가 이 결과를 읽는다.
  const renderRosterTab = () => {
    const sides = (['home', 'away'] as const).filter((side) => effectiveRoster[side]?.length);
    if (!sides.length) {
      return (
        <div className="fpa-roster-empty">
          신청 라인업이 없습니다.<br />
          연결된 FinePlay 신청이 있어야 명단이 뜹니다.
        </div>
      );
    }
    // 라인업이 한쪽만 있으면 그쪽으로 붙잡아 둔다.
    const side = sides.includes(rosterTeam) ? rosterTeam : sides[0];
    const list = effectiveRoster[side] ?? [];
    const starters = list.filter((p) => !p.isSubstitute);
    const subs = list.filter((p) => p.isSubstitute);
    const info = lineupSides[side];

    // 슬롯 id → 포지션 라벨. 자리를 아는 선발에만 붙는다.
    const slotIds = starters.map((p) => p.positionSlot).filter(Boolean);
    const isCustom = slotIds.some((id) => /^c\d+_\d+$/.test(id));
    const isRecordSheet = !isCustom && slotIds.some(isRecordSheetPosition);
    const slots = isCustom
      ? buildCustomGridSlots()
      : isRecordSheet
        ? buildRecordSheetSlots(slotIds)
        : buildFormationSlots(info?.formation ?? '', linesFromSlotIds(slotIds));
    const positionById = new Map(slots.map((slot) => [slot.id.toUpperCase(), slot.position]));

    const row = (player: RosterPlayer) => (
      <div
        className={`fpa-roster-row ${player.isSubstitute ? 'sub' : ''}`}
        data-team={side}
        draggable
        key={`${side}-${player.jersey}`}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', `${side}:${player.jersey}`);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
        onDrop={(event) => {
          event.preventDefault();
          const [dragSide, dragJersey] = (event.dataTransfer.getData('text/plain') || '').split(':');
          if (dragSide === side && dragJersey) swapRosterPlayers(side, dragJersey, player.jersey);
        }}
        title={[
          `끌어서 ${player.isSubstitute ? '선발' : '교체'} 선수와 맞바꾸기`,
          player.bib ? `조끼 ${player.jersey}번 — 기록지 원 등번호는 ${player.rosterNumber}번입니다` : '',
          player.bibAmbiguous ? '기록지에 빨간 숫자가 여럿이라 조끼 번호를 가리지 못했습니다 — 영상으로 확인하세요' : '',
          player.positionInferred ? '기록지에 포지션이 없어 포메이션과 행 순서로 자리를 유추했습니다' : '',
        ].filter(Boolean).join('\n')}
      >
        <span className="no">{player.jersey}</span>
        {/* 조끼를 입은 선수는 영상 번호(조끼)와 기록지 번호가 다르다. 원 번호를 같이
            보여주지 않으면 "명단에 없는 번호" 로 보여 태거가 헤맨다. */}
        {player.bib && player.rosterNumber ? (
          <span className="alt" title={`원 등번호 ${player.rosterNumber}`}>조끼·원{player.rosterNumber}</span>
        ) : null}
        {player.bibAmbiguous ? <span className="warn" title="조끼 번호 판정 불가">?</span> : null}
        <span className={`pos ${player.positionInferred ? 'guess' : ''}`}>
          {positionById.get(player.positionSlot.toUpperCase()) || (player.isSubstitute ? 'SUB' : '–')}
          {player.positionInferred ? '*' : ''}
        </span>
        <span className="nm">{player.name || '이름 없음'}</span>
      </div>
    );

    return (
      <div className="fpa-roster-tab">
        <div className="fpa-roster-tabs">
          {(['home', 'away'] as const).map((s) => {
            const roster = effectiveRoster[s];
            return (
              <button
                className={`${side === s ? 'on' : ''}`}
                data-team={s}
                disabled={!roster?.length}
                key={s}
                onClick={() => setRosterTeam(s)}
                type="button"
              >
                <span className="t">{s === 'home' ? '홈' : '어웨이'}</span>
                <span className="c">{roster?.length ? `${roster.filter((p) => !p.isSubstitute).length}+${roster.filter((p) => p.isSubstitute).length}` : '없음'}</span>
              </button>
            );
          })}
        </div>
        <div className="fpa-roster-meta">
          {info?.team_name || (side === 'home' ? '홈' : '어웨이')}
          {info?.formation ? <b>{info.formation}</b> : null}
        </div>
        <div className="fpa-roster-list">
          <div className="fpa-roster-sec">선발 {starters.length}</div>
          {starters.length ? starters.map(row) : <div className="fpa-roster-empty-line">없음</div>}
          <div className="fpa-roster-sec">교체명단 {subs.length}</div>
          {subs.length ? subs.map(row) : <div className="fpa-roster-empty-line">없음</div>}
        </div>
        <div className="fpa-roster-hint">
          교체가 있었다면 들어온 선수를 나간 선수 위로 끌어 놓으세요.
          그다음 <b>“before 에 배치”</b> 를 다시 누르면 바뀐 선발로 깔립니다.
        </div>
      </div>
    );
  };

  // 피치 오른쪽 패널 — [액션] 현재 장면의 액션들 / [명단] 신청 라인업(교체 반영)
  const renderSceneSummary = () => {
    const overload = dualPointSummary.afterAllyCount - dualPointSummary.afterOpponentCount;
    const sceneRows = rows;
    const rosterCount = (['home', 'away'] as const)
      .reduce((sum, side) => sum + (effectiveRoster[side]?.length ?? 0), 0);
    return (
      <section className="fpa-dual-side-box fpa-scene-summary">
        <div className="fpa-panel-header">
          <div className="fpa-side-tabs">
            <button
              className={sidePanelTab === 'actions' ? 'active' : ''}
              onClick={() => setSidePanelTab('actions')}
              type="button"
            >액션 {sceneRows.length}</button>
            <button
              className={sidePanelTab === 'roster' ? 'active' : ''}
              onClick={() => setSidePanelTab('roster')}
              type="button"
            >명단 {rosterCount}</button>
          </div>
          {sidePanelTab === 'actions' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="fpa-scene-new" onClick={startNewScene} type="button">새 액션</button>
              <button className="fpa-scene-save" disabled={sceneRows.length === 0} onClick={saveScene} type="button">액션 저장</button>
            </div>
          ) : null}
        </div>
        {sidePanelTab === 'roster' ? renderRosterTab() : (
        <>
        <div className="fpa-panel-title fpa-scene-clip-label">액션 요약 · 클립 {currentClipIndex}</div>
        <div className="fpa-scene-counts">
          <span>Ally {dualPointSummary.afterAllyCount}</span>
          <span>Opp {dualPointSummary.afterOpponentCount}</span>
          <span>Overload {overload > 0 ? `+${overload}` : overload}</span>
          <span>액션 {sceneRows.length}</span>
        </div>
        <div className="fpa-scene-actions">
          {sceneRows.length === 0 ? (
            <span className="muted">이 장면 액션 없음 — 스탯 입력으로 추가하세요</span>
          ) : (
            sceneRows.map((row, index) => {
              const isPrimary = primaryRowIndex === index;
              return (
                <div
                  className="fpa-scene-action-row"
                  key={`${index}-${row.Player}-${row.Action}`}
                  onClick={() => setSelectedRowIndex(index)}
                  role="button"
                  tabIndex={0}
                  style={{ outline: selectedRowIndex === index ? '1px solid var(--accent)' : 'none' }}
                >
                  <span>
                    <button
                      className={`fpa-scene-primary ${isPrimary ? 'on' : ''}`}
                      onClick={(event) => { event.stopPropagation(); setPrimaryRowIndex(index); }}
                      title="primary 액션으로 지정"
                      type="button"
                    >★</button>
                    {row.Team} {row.Player} · {row.Action}{row.Receiver ? ` → ${row.Receiver}` : ''}
                  </span>
                  <span className="metrics">
                    xG {row.xG ?? '-'} · EPV {row.EPV ?? '-'} · PC {row.PC ?? '-'}
                    {row.xGOT ? ` · xGOT ${row.xGOT}` : ''}
                  </span>
                </div>
              );
            })
          )}
        </div>
        <div className="fpa-scene-footer">
          <button
            className="fpa-scene-del-btn"
            disabled={selectedRowIndex == null}
            onClick={() => { if (selectedRowIndex != null) removeLogAt(selectedRowIndex); }}
            type="button"
          >선택 액션 삭제</button>
        </div>
        </>
        )}
      </section>
    );
  };

  const renderStatInputControl = () => (
    <div className="fpa-live-control-group fpa-live-control-group-wide">
      <span>Stat Input</span>
      <div className="fpa-stat-input-row">
        <input
          id="fpa-live-stat-input"
          ref={statInputRef}
          value={statInput}
          onChange={(event) => setStatInput(event.target.value)}
          placeholder="스탯 코드 (예: 10ss8.k.f.w, 4tt7.lt)"
        />
        <button className="submit" disabled={!statInput.trim() || busy || Boolean(pendingXgot)} onClick={addLog} type="button">
          ↵
        </button>
      </div>
    </div>
  );

  const renderDirectionControl = () => (
    <div className="fpa-live-control-group">
      <span>Direction</span>
      <div className="fpa-segmented">
        <button className={direction === 'right' ? 'active' : ''} onClick={() => setDirection('right')} type="button">Right</button>
        <button className={direction === 'left' ? 'active' : ''} onClick={() => setDirection('left')} type="button">Left</button>
      </div>
    </div>
  );

  const renderTeamControl = () => (
    <div className="fpa-live-control-group">
      <span>Team</span>
      <div className="fpa-segmented">
        <button className={team === 'home' ? 'active' : ''} onClick={() => syncTeam('home')} type="button">Home</button>
        <button className={team === 'away' ? 'active' : ''} onClick={() => syncTeam('away')} type="button">Away</button>
      </div>
    </div>
  );

  const renderTimeControl = () => (
    <div className="fpa-live-control-group">
      <span>Game Time</span>
      <div className="fpa-time-control">
        <button onClick={() => adjustTimeline(-60)} type="button">-1</button>
        <input id="fpa-live-timeline" value={timeline} onChange={(event) => setTimeline(event.target.value)} />
        <button onClick={() => adjustTimeline(60)} type="button">+1</button>
      </div>
    </div>
  );

  const renderDualEntryBar = () => (
    <section className="fpa-dual-entry-bar">
      {renderTimeControl()}
      {renderStatInputControl()}
    </section>
  );

  const renderLiveControls = (variant: InputMode) => (
    <section className={`fpa-live-controls ${variant === 'dual' ? 'compact' : ''}`}>
      <div className="fpa-live-controls-title">실시간 입력 (Live Controls)</div>
      {variant === 'dual' ? (
        <>
          {renderStatInputControl()}
          <div className="fpa-live-controls-compact-row">
            {renderDirectionControl()}
            {renderTeamControl()}
            {renderTimeControl()}
          </div>
        </>
      ) : (
        <div className="fpa-live-controls-row">
          {renderDirectionControl()}
          {renderTeamControl()}
          {renderTimeControl()}
          {renderStatInputControl()}
        </div>
      )}
    </section>
  );

  return (
    <div className="page-stack">
      {matchPickerOpen ? (
        <div className="fcm-modal-backdrop" role="presentation" onClick={() => setMatchPickerOpen(false)}>
          <div className="card card-panel fcm-modal fpa-match-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading">
              <div>
                <div className="sidebar-eyebrow">FLA Match</div>
                <h3>경기 불러오기</h3>
              </div>
              <button className="button-compact btn-secondary" onClick={() => setMatchPickerOpen(false)}>닫기</button>
            </div>
            <div className="row" style={{ gap: 8, marginBottom: 10, justifyContent: 'flex-start' }}>
              <label className="field-stack" style={{ minWidth: 140 }}>
                <span className="field-label">대회</span>
                <select
                  value={matchFilterClass}
                  onChange={(e) => {
                    setMatchFilterClass(e.target.value);
                    setMatchFilterRound('ALL');
                  }}
                >
                  <option value="ALL">전체</option>
                  {matchClassOptions.map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              </label>
              <label className="field-stack" style={{ minWidth: 110 }}>
                <span className="field-label">라운드</span>
                <select value={matchFilterRound} onChange={(e) => setMatchFilterRound(e.target.value)}>
                  <option value="ALL">전체</option>
                  {matchRoundOptions.map((round) => (
                    <option key={round} value={String(round)}>{round}R</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="fcm-guide-table-wrap fpa-match-table-wrap">
              <table className="fcm-guide-table">
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>대회</th>
                    <th>경기</th>
                    <th>상태</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAvailableMatches.map((match) => (
                    <tr key={match.id}>
                      <td>{match.sport === 'FUTSAL' ? 'FUTSAL' : match.sport === 'BASKETBALL' ? 'BASKETBALL' : 'FOOTBALL'}</td>
                      <td>{match.competition_class}</td>
                      <td>{match.name}</td>
                      <td>{match.archived ? 'Archived' : 'Active'}</td>
                      <td>
                        <button className="button-compact btn-secondary" disabled={busy} onClick={() => loadMatch(match)}>
                          불러오기
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!filteredAvailableMatches.length ? (
                    <tr>
                      <td colSpan={5} className="muted">해당 조건의 경기가 없습니다</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      <section className="fpa-live-shell">
        <DualTokenDefs />
        <div className="fpa-live-brand">
          <span className="fpa-live-brandmark">F</span>
          <span>Fine Play Analytics</span>
        </div>

        <div className={`fpa-live-meta ${inputMode === 'dual' ? 'dual' : ''}`}>
          <label className="fpa-live-meta-field">
            <span>Home Team</span>
            <input value={teamIdH} onChange={(event) => setTeamIdH(event.target.value)} placeholder="Home" />
          </label>
          <label className="fpa-live-meta-field">
            <span>Away Team</span>
            <input value={teamIdA} onChange={(event) => setTeamIdA(event.target.value)} placeholder="Away" />
          </label>
          <label className="fpa-live-meta-field">
            <span>Match ID</span>
            <div className="fpa-match-id-row">
              <input
                className={matchIdError ? 'invalid' : ''}
                value={matchId}
                onBlur={() => {
                  if (matchIdError) setMatchIdError(validateMatchIdForSave(matchId));
                }}
                onChange={(event) => {
                  setMatchId(event.target.value);
                  setMatchIdError('');
                }}
                placeholder="비워두면 자동 생성"
              />
              <button
                onClick={() => {
                  setMatchId(generateMatchId());
                  setMatchIdError('');
                }}
                type="button"
              >
                랜덤
              </button>
            </div>
            {matchIdError ? <small className="fpa-field-error">{matchIdError}</small> : null}
          </label>
          {inputMode === 'single' ? renderHalfControl() : null}
          <div className="fpa-live-meta-field">
            <span>Mode</span>
            <div className="fpa-segmented">
              <button className={inputMode === 'single' ? 'active' : ''} onClick={() => setInputMode('single')} type="button">Single</button>
              <button className={inputMode === 'dual' ? 'active' : ''} onClick={() => setInputMode('dual')} type="button">Dual</button>
            </div>
          </div>
        </div>


        {inputMode === 'dual' ? (
          <>
            <div className="fpa-dual-layout">
              <div className="fpa-dual-main-col">
                {renderDualInputBar()}
                {renderDualPitchPanel()}
              </div>
              {renderSceneSummary()}
            </div>
            {renderDualEntryBar()}
            {renderLogPanel()}
            {renderSceneEditor()}
          </>
        ) : (
          <>
            <div className="fpa-live-main">
              {renderLogPanel()}
              {renderSinglePitchPanel()}
            </div>
            {renderLiveControls('single')}
          </>
        )}

        <div className="fpa-live-status">
          <span>{status}</span>
          <span>
            {inputMode === 'dual'
              ? `레이어 ${currentLayer.label} / Before A${dualPointSummary.beforeAllyCount} O${dualPointSummary.beforeOpponentCount} / After A${dualPointSummary.afterAllyCount} O${dualPointSummary.afterOpponentCount}${selectedDualDot ? ` / 선택 ${selectedDualDot.side === 'before' ? 'B' : 'A'}${selectedDualDot.index + 1}` : ''}`
              : dots.length
                ? `좌표 ${dots.map((dot) => `(${dot.meter_x}, ${dot.meter_y})`).join(' / ')}`
                : '좌표 없음'}
          </span>
        </div>
      </section>
    </div>
  );
}
