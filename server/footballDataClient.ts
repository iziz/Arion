import type { SportsKnowledgeSnapshot } from "../shared/types";
import { mergeSportsKnowledge, type SportsKnowledgeMatchActivity, type SportsKnowledgePlayer, type SportsLeague } from "./sportsKnowledge";

const footballDataBaseUrl = "https://api.football-data.org/v4";
const minRequestIntervalMs = 6500;
let nextAllowedRequestAt = 0;
let requestQueue = Promise.resolve();

type ImportOptions = {
  competitionCode?: string;
  season?: number;
  includeMatches?: boolean;
  matchLimit?: number;
};

type FootballDataTeam = {
  id: number;
  name: string;
  shortName?: string;
  tla?: string;
  squad?: Array<{
    id: number;
    name: string;
    position?: string | null;
    shirtNumber?: number | null;
  }>;
};

type FootballDataTeamsResponse = {
  competition?: { code?: string; name?: string };
  season?: { startDate?: string; endDate?: string };
  teams?: FootballDataTeam[];
};

type FootballDataMatch = {
  id: number;
  utcDate?: string | null;
  matchday?: number | null;
  homeTeam?: FootballDataMatchTeam;
  awayTeam?: FootballDataMatchTeam;
  goals?: Array<{
    minute?: number | null;
    team?: { name?: string };
    scorer?: { id?: number; name?: string };
    assist?: { id?: number; name?: string } | null;
    type?: string;
  }>;
  bookings?: Array<{
    minute?: number | null;
    team?: { name?: string };
    player?: { id?: number; name?: string };
    card?: string;
  }>;
  substitutions?: Array<{
    minute?: number | null;
    team?: { name?: string };
    playerOut?: { id?: number; name?: string };
    playerIn?: { id?: number; name?: string };
  }>;
};

type FootballDataMatchTeam = {
  id?: number;
  name?: string;
  lineup?: Array<FootballDataLineupPerson>;
  bench?: Array<FootballDataLineupPerson>;
};

type FootballDataLineupPerson = {
  id?: number;
  name?: string;
  position?: string | null;
  shirtNumber?: number | null;
};

type FootballDataMatchesResponse = {
  matches?: FootballDataMatch[];
};

export async function importFootballDataKnowledge(options: ImportOptions = {}): Promise<{
  competitionCode: string;
  season: number;
  teams: number;
  players: number;
  matchActivities: number;
  warnings: string[];
  snapshot: SportsKnowledgeSnapshot;
}> {
  const competitionCode = normalizeCompetitionCode(options.competitionCode ?? "PL");
  const season = options.season ?? defaultSeasonStartYear();
  const league = leagueFromCompetitionCode(competitionCode);
  const teamsResponse = await footballDataGet<FootballDataTeamsResponse>(`/competitions/${competitionCode}/teams`, { season: String(season) });
  const teams = teamsResponse.teams ?? [];
  const seasonLabel = seasonLabelFromYear(season);
  const players = teams.flatMap((team) => (team.squad ?? []).map((person) => playerFromSquadPerson(person, team, league, seasonLabel)));
  const teamRecords = teams.map((team) => ({
    value: team.name,
    aliases: [team.name, team.shortName, team.tla].filter((value): value is string => Boolean(value))
  }));
  const warnings: string[] = [];
  let matchActivities: SportsKnowledgeMatchActivity[] = [];
  if (options.includeMatches) {
    try {
      matchActivities = await importMatchActivities(competitionCode, season, league, seasonLabel, options.matchLimit ?? 20);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "football-data match activity import failed");
    }
  }
  const snapshot = mergeSportsKnowledge({
    teams: teamRecords,
    players,
    matchActivities
  });
  return {
    competitionCode,
    season,
    teams: teamRecords.length,
    players: players.length,
    matchActivities: matchActivities.length,
    warnings,
    snapshot
  };
}

async function importMatchActivities(
  competitionCode: string,
  season: number,
  league: SportsLeague,
  seasonLabel: string,
  limit: number
): Promise<SportsKnowledgeMatchActivity[]> {
  const response = await footballDataGet<FootballDataMatchesResponse>(
    `/competitions/${competitionCode}/matches`,
    { season: String(season), status: "FINISHED", limit: String(Math.max(1, Math.min(100, limit))) },
    {
      "X-Unfold-Lineups": "true",
      "X-Unfold-Goals": "true",
      "X-Unfold-Bookings": "true",
      "X-Unfold-Subs": "true"
    }
  );
  return (response.matches ?? []).flatMap((match) => activitiesFromMatch(match, league, seasonLabel));
}

function activitiesFromMatch(match: FootballDataMatch, competition: SportsLeague, season: string): SportsKnowledgeMatchActivity[] {
  const homeTeam = match.homeTeam?.name ?? "Home";
  const awayTeam = match.awayTeam?.name ?? "Away";
  const base = {
    provider: "football-data" as const,
    competition,
    season,
    matchId: match.id,
    utcDate: match.utcDate ?? null,
    matchday: match.matchday ?? null,
    homeTeam,
    awayTeam
  };
  const lineup = [
    ...teamLineupActivities(base, match.homeTeam, homeTeam, "STARTING"),
    ...teamLineupActivities(base, match.awayTeam, awayTeam, "STARTING")
  ];
  const bench = [
    ...teamLineupActivities(base, match.homeTeam, homeTeam, "BENCH"),
    ...teamLineupActivities(base, match.awayTeam, awayTeam, "BENCH")
  ];
  const goals = (match.goals ?? []).flatMap((goal) => [
    personActivity(base, goal.team?.name ?? "", goal.scorer?.name, goal.scorer?.id, "GOAL", goal.minute ?? null, goal.type ?? "goal"),
    personActivity(base, goal.team?.name ?? "", goal.assist?.name, goal.assist?.id, "ASSIST", goal.minute ?? null, "assist")
  ]);
  const bookings = (match.bookings ?? []).map((booking) =>
    personActivity(base, booking.team?.name ?? "", booking.player?.name, booking.player?.id, "CARD", booking.minute ?? null, booking.card ?? "card")
  );
  const substitutions = (match.substitutions ?? []).flatMap((substitution) => [
    personActivity(base, substitution.team?.name ?? "", substitution.playerIn?.name, substitution.playerIn?.id, "SUB_IN", substitution.minute ?? null, "substitution in"),
    personActivity(base, substitution.team?.name ?? "", substitution.playerOut?.name, substitution.playerOut?.id, "SUB_OUT", substitution.minute ?? null, "substitution out")
  ]);
  return [...lineup, ...bench, ...goals, ...bookings, ...substitutions].filter((item): item is SportsKnowledgeMatchActivity => Boolean(item));
}

function teamLineupActivities(
  base: Omit<SportsKnowledgeMatchActivity, "id" | "team" | "player" | "playerId" | "role" | "minute" | "event" | "sourceText">,
  team: FootballDataMatchTeam | undefined,
  teamName: string,
  role: "STARTING" | "BENCH"
) {
  const people = role === "STARTING" ? team?.lineup ?? [] : team?.bench ?? [];
  return people.map((person) => personActivity(base, teamName, person.name, person.id, role, null, role === "STARTING" ? "starting lineup" : "bench"));
}

function personActivity(
  base: Omit<SportsKnowledgeMatchActivity, "id" | "team" | "player" | "playerId" | "role" | "minute" | "event" | "sourceText">,
  team: string,
  player: string | undefined,
  playerId: number | undefined,
  role: SportsKnowledgeMatchActivity["role"],
  minute: number | null,
  event: string
): SportsKnowledgeMatchActivity | null {
  if (!player) return null;
  const minuteText = minute === null ? "match sheet" : `${minute}'`;
  const id = `football-data:${base.matchId}:${slug(role)}:${playerId ?? slug(player)}:${minute ?? "sheet"}`;
  return {
    ...base,
    id,
    team,
    player,
    playerId: playerId ?? null,
    role,
    minute,
    event,
    sourceText: `${player} ${event} for ${team} in ${base.homeTeam} vs ${base.awayTeam} (${minuteText}).`
  };
}

function playerFromSquadPerson(person: NonNullable<FootballDataTeam["squad"]>[number], team: FootballDataTeam, league: SportsLeague, season: string): SportsKnowledgePlayer {
  return {
    id: `football-data-${person.id}`,
    canonical: person.name,
    aliases: unique([person.name]),
    sport: "football",
    league,
    activeSeasons: [season],
    teamsBySeason: { [season]: team.name },
    provider: "football-data",
    externalIds: { footballData: person.id, team: team.id },
    position: person.position ?? null,
    shirtNumber: person.shirtNumber ?? null
  };
}

async function footballDataGet<T>(path: string, params: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<T> {
  const token = process.env.FOOTBALL_DATA_API_KEY?.trim();
  if (!token) throw new Error("FOOTBALL_DATA_API_KEY is not configured");
  const url = new URL(`${footballDataBaseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  await throttleFootballDataRequest();
  const response = await fetch(url, {
    headers: {
      "X-Auth-Token": token,
      ...headers
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`football-data request failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 160)}` : ""}`);
  }
  return (await response.json()) as T;
}

function throttleFootballDataRequest() {
  requestQueue = requestQueue.then(async () => {
    const waitMs = Math.max(0, nextAllowedRequestAt - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextAllowedRequestAt = Date.now() + minRequestIntervalMs;
  });
  return requestQueue;
}

function normalizeCompetitionCode(value: string) {
  return value.trim().toUpperCase() || "PL";
}

function leagueFromCompetitionCode(code: string): SportsLeague {
  if (code === "CL") return "Champions League";
  if (code === "BL1") return "Bundesliga";
  return "Premier League";
}

function defaultSeasonStartYear() {
  const now = new Date();
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? year : year - 1;
}

function seasonLabelFromYear(year: number) {
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function slug(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
