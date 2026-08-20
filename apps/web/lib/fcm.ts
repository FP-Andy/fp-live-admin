export type RawMatchRecord = {
  id: string;
  name: string;
  competition_class?: string | null;
  round_number?: number | null;
  archived: boolean;
  archived_at?: string | null;
  created_at?: string | null;
  operator_id?: string | null;
  metadata?: {
    home_team?: string;
    away_team?: string;
  } | null;
};

export type FcmEligibleMatch = {
  id: string;
  name: string;
  competitionClass: string;
  roundNumber: number;
  archivedAt?: string | null;
  createdAt?: string | null;
  operatorId?: string | null;
  homeTeam: string;
  awayTeam: string;
};

const MATCH_NAME_PATTERN = /^\[(?<competition>[A-Z0-9가-힣-]+)\s\|\s(?<round>\d+)R\]\s(?<home>.+)\svs\s(?<away>.+)$/;

function normalizeCompetitionClass(value?: string | null): string | null {
  const normalized = (value || '').trim().toUpperCase();
  return normalized || null;
}

function parseMatchName(name: string) {
  const match = name.match(MATCH_NAME_PATTERN);
  if (!match?.groups) return null;
  const competitionClass = normalizeCompetitionClass(match.groups.competition);
  const roundNumber = Number(match.groups.round);
  const homeTeam = match.groups.home?.trim();
  const awayTeam = match.groups.away?.trim();

  if (!competitionClass || !Number.isFinite(roundNumber) || roundNumber < 1 || !homeTeam || !awayTeam) {
    return null;
  }

  return {
    competitionClass,
    roundNumber,
    homeTeam,
    awayTeam,
  };
}

export function toEligibleFcmMatch(match: RawMatchRecord): FcmEligibleMatch | null {
  if (!match.archived) return null;

  const parsed = parseMatchName(match.name);
  if (!parsed) return null;

  const competitionClass = normalizeCompetitionClass(match.competition_class) || parsed.competitionClass;
  const roundNumber = Number(match.round_number || parsed.roundNumber);
  const homeTeam = match.metadata?.home_team?.trim() || parsed.homeTeam;
  const awayTeam = match.metadata?.away_team?.trim() || parsed.awayTeam;

  if (!competitionClass || !Number.isFinite(roundNumber) || roundNumber < 1 || !homeTeam || !awayTeam) {
    return null;
  }

  return {
    id: match.id,
    name: match.name,
    competitionClass,
    roundNumber,
    archivedAt: match.archived_at,
    createdAt: match.created_at,
    operatorId: match.operator_id,
    homeTeam,
    awayTeam,
  };
}

export function getEligibleFcmMatches(matches: RawMatchRecord[]): FcmEligibleMatch[] {
  return matches
    .map(toEligibleFcmMatch)
    .filter((match): match is FcmEligibleMatch => Boolean(match))
    .sort((a, b) => {
      const classDiff = a.competitionClass.localeCompare(b.competitionClass);
      if (classDiff !== 0) return classDiff;
      const roundDiff = b.roundNumber - a.roundNumber;
      if (roundDiff !== 0) return roundDiff;
      const left = a.archivedAt ? Date.parse(a.archivedAt) : 0;
      const right = b.archivedAt ? Date.parse(b.archivedAt) : 0;
      return right - left;
    });
}
