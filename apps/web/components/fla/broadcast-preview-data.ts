/**
 * 중계 데이터 미리보기 — 팀·브랜딩 점검(BroadcastPreviewPanel 전용, 요청 없음).
 *
 * 값은 공개 GET /api/broadcast/v1/matches/{id} 응답(중계 그림이 실제로 쓰는 _broadcast_state 결과)을 그대로 보여 준다.
 * 출처(수동·PDF 유니폼·팀 로고 표·기본값)는 공개 응답에 없어서(외부 노출 방지) 매치 컨트롤이 이미 받은
 * 경기 metadata 로 apps/api/app/team_branding.py resolve_branding 과 같은 순서로 다시 따져 본다.
 * 다시 따진 값이 공개 응답 값과 다르면(경기 정보가 그사이 바뀌었거나 규칙이 달라졌으면) 출처를 단정하지 않는다.
 */

export type Side = 'HOME' | 'AWAY';
export type BrandingKey = 'home_color' | 'away_color' | 'home_logo_url' | 'away_logo_url';
export type BrandingSource = 'manual' | 'pdf' | 'team_logo' | 'default';
export type PublicBranding = { home_logo_url?: string; away_logo_url?: string; home_color?: string; away_color?: string };

const DEFAULTS: Record<BrandingKey, string> = { home_color: '#ff7900', away_color: '#3d22f3', home_logo_url: '', away_logo_url: '' };
const HEX = /^#[0-9a-fA-F]{6}$/;

export const SOURCE_LABELS: Record<BrandingSource, string> = {
  manual: '수동 지정',
  pdf: 'PDF 명단 유니폼',
  team_logo: '팀 로고 표',
  default: '기본값',
};

type AnyRecord = Record<string, any>;
const record = (value: unknown): AnyRecord => (value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {});

/** team_branding.match_team_names 와 같은 순서 — 경기 이름은 '[대회 | 1R] HOME vs AWAY'. */
export function matchNameTeams(name?: string | null): Record<Side, string> | null {
  const title = String(name || '').replace(/^\s*\[[^\]]+\]\s*/, '');
  const parts = title.split(/\s+vs\.?\s+/i);
  return parts.length >= 2 ? { HOME: parts[0].trim(), AWAY: parts.slice(1).join(' vs ').trim() } : null;
}

export function matchTeamNames(match: AnyRecord | null | undefined): Record<Side, string> {
  const metadata = record(match?.metadata);
  const names = record(record(metadata.lineups).team_names);
  const info = record(metadata.lineup_team_info);
  const parsed = matchNameTeams(match?.name);
  const pick = (side: Side) => String(metadata[`${side.toLowerCase()}_team`] || names[side] || record(info[side]).name || parsed?.[side] || side).trim();
  return { HOME: pick('HOME'), AWAY: pick('AWAY') };
}

/** 출처를 다시 따진다. 공개 응답 값과 맞지 않으면 null(확인 못 함). */
export function brandingSources(metadata: AnyRecord | null | undefined, branding: PublicBranding): Record<BrandingKey, BrandingSource | null> {
  const meta = record(metadata);
  const stored = record(meta.broadcast);
  const storedSources = record(stored.branding_sources);
  const uniforms = record(record(meta.lineups).uniforms);
  const result = {} as Record<BrandingKey, BrandingSource | null>;
  (Object.keys(DEFAULTS) as BrandingKey[]).forEach((key) => {
    const side = key.split('_')[0].toUpperCase();
    const isColor = key.endsWith('_color');
    const fallback = DEFAULTS[key];
    const saved = stored[key];
    const savedValid = isColor ? HEX.test(String(saved || '')) : !!saved;
    const source = storedSources[key];
    const manual = source === 'manual' || (source == null && savedValid && String(saved).toLowerCase() !== fallback.toLowerCase());
    const shown = String(branding[key] || '').trim();
    let derived: BrandingSource;
    let expected: string | null;
    if (manual && savedValid) {
      derived = 'manual';
      expected = String(saved).trim();
    } else if (isColor) {
      const kit = record(record(record(uniforms[side]).field).shirt).hex;
      if (HEX.test(String(kit || ''))) { derived = 'pdf'; expected = String(kit); } else { derived = 'default'; expected = fallback; }
    } else {
      // 팀 로고 표는 경기 정보에 없다 — 수동이 아닌데 로고가 있으면 팀 로고 표에서 온 것뿐이다.
      derived = shown ? 'team_logo' : 'default';
      expected = shown;
    }
    result[key] = expected != null && expected.toLowerCase() === shown.toLowerCase() ? derived : null;
  });
  return result;
}

function rgb(hex: string): [number, number, number] | null {
  if (!HEX.test(hex)) return null;
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

/** 두 색의 거리(0~441). 64 미만이면 화면에서 구분이 어렵다고 본다. */
export function colorDistance(a?: string, b?: string): number | null {
  const x = rgb(String(a || ''));
  const y = rgb(String(b || ''));
  if (!x || !y) return null;
  return Math.sqrt(x.reduce((sum, value, index) => sum + (value - y[index]) ** 2, 0));
}

export type BrandingCheck = {
  missingLogos: Side[];
  warnings: string[];
};

export function checkBranding(input: {
  matchName?: string | null;
  homeTeam?: string;
  awayTeam?: string;
  branding: PublicBranding;
  failedLogos?: Side[];
}): BrandingCheck {
  const warnings: string[] = [];
  const missingLogos = (['HOME', 'AWAY'] as Side[]).filter((side) => !String(input.branding[side === 'HOME' ? 'home_logo_url' : 'away_logo_url'] || '').trim());
  if (missingLogos.length) warnings.push(`로고 없음: ${missingLogos.join('·')} — 중계 그림에는 로고 대신 팀 이름 글자가 나갑니다.`);
  const failed = (input.failedLogos || []).filter((side) => !missingLogos.includes(side));
  if (failed.length) warnings.push(`로고 그림을 불러오지 못했습니다: ${failed.join('·')} — 중계 그림에서도 빠질 수 있습니다.`);
  const distance = colorDistance(input.branding.home_color, input.branding.away_color);
  if (distance != null && distance < 64) {
    warnings.push(distance === 0
      ? `HOME·AWAY 색이 같습니다 (${input.branding.home_color}).`
      : `HOME·AWAY 색이 거의 같습니다 (${input.branding.home_color} · ${input.branding.away_color}).`);
  }
  const names = { HOME: String(input.homeTeam || '').trim(), AWAY: String(input.awayTeam || '').trim() };
  const empty = (['HOME', 'AWAY'] as Side[]).filter((side) => !names[side] || names[side].toUpperCase() === side);
  if (empty.length) warnings.push(`팀 이름이 비어 있습니다: ${empty.join('·')}`);
  const parsed = matchNameTeams(input.matchName);
  if (parsed && !empty.length && (parsed.HOME !== names.HOME || parsed.AWAY !== names.AWAY)) {
    warnings.push(`팀 이름이 경기 이름과 다릅니다 (경기 이름: ${parsed.HOME} vs ${parsed.AWAY}).`);
  }
  return { missingLogos, warnings };
}
