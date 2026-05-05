import type { KnowledgeSnapshot } from "../shared/types";
import {
  mergeSportsKnowledge,
  type SportsKnowledgeFact,
  type SportsKnowledgeMatchActivity,
  type SportsKnowledgePlayer
} from "./knowledge/adapters/sports/store";

const statsbombBaseUrl = "https://raw.githubusercontent.com/statsbomb/open-data/master/data";

type ImportOptions = {
  competitions?: string[];
  seasons?: string[];
  maxMatches?: number;
  maxEventMatches?: number;
  includeEvents?: boolean;
};

type CompetitionRow = {
  competition_id: number;
  season_id: number;
  country_name: string;
  competition_name: string;
  season_name: string;
  competition_gender?: string;
  match_available?: string | null;
};

type MatchRow = {
  match_id: number;
  match_date?: string;
  home_score?: number;
  away_score?: number;
  home_team?: { home_team_name?: string };
  away_team?: { away_team_name?: string };
};

type LineupTeam = {
  team_name: string;
  lineup: Array<{
    player_id?: number;
    player_name?: string;
    player_nickname?: string | null;
    jersey_number?: number | null;
    country?: { name?: string };
    positions?: Array<{ position?: string; from?: string; start_reason?: string }>;
  }>;
};

type EventRow = {
  id?: string;
  index?: number;
  type?: { name?: string };
  player?: { id?: number; name?: string };
  team?: { name?: string };
  minute?: number;
  shot?: { outcome?: { name?: string } };
  pass?: { goal_assist?: boolean };
  foul_committed?: { card?: { name?: string } };
  bad_behaviour?: { card?: { name?: string } };
  substitution?: { replacement?: { id?: number; name?: string } };
};

type ImportedTeam = {
  value: string;
  aliases: string[];
  domainGroup: "sports.football";
  league: string;
};

type TeamAggregate = {
  team: string;
  competition: string;
  season: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
};

export async function importStatsBombOpenDataKnowledge(options: ImportOptions = {}): Promise<{
  source: "statsbomb";
  competitions: number;
  competitionSeasons: number;
  matches: number;
  eventMatches: number;
  teams: number;
  players: number;
  matchActivities: number;
  facts: number;
  warnings: string[];
  snapshot: KnowledgeSnapshot;
}> {
  const warnings: string[] = [];
  const competitionRows = await fetchJson<CompetitionRow[]>(`${statsbombBaseUrl}/competitions.json`);
  const selectedRows = selectCompetitionSeasons(competitionRows, options);
  const teams = new Map<string, ImportedTeam>();
  const players = new Map<string, SportsKnowledgePlayer>();
  const activities: SportsKnowledgeMatchActivity[] = [];
  const aggregates = new Map<string, TeamAggregate>();
  const maxMatches = bounded(options.maxMatches ?? 180, 1, 800);
  const maxEventMatches = bounded(options.maxEventMatches ?? 60, 0, maxMatches);
  let importedMatches = 0;
  let eventMatches = 0;

  for (const row of selectedRows) {
    if (importedMatches >= maxMatches) break;
    const competition = competitionName(row.competition_name);
    const season = seasonLabel(row.season_name);
    let matches: MatchRow[] = [];
    try {
      matches = await fetchJson<MatchRow[]>(`${statsbombBaseUrl}/matches/${row.competition_id}/${row.season_id}.json`);
    } catch (error) {
      warnings.push(error instanceof Error ? `${competition}/${season}: ${error.message}` : `${competition}/${season}: StatsBomb matches import failed`);
      continue;
    }
    for (const match of matches) {
      if (importedMatches >= maxMatches) break;
      importedMatches += 1;
      addMatchTeamsAndFacts(match, competition, season, teams, aggregates);
      try {
        const lineups = await fetchJson<LineupTeam[]>(`${statsbombBaseUrl}/lineups/${match.match_id}.json`);
        addLineups(match, competition, season, lineups, teams, players, activities);
      } catch (error) {
        warnings.push(error instanceof Error ? `lineups/${match.match_id}: ${error.message}` : `lineups/${match.match_id}: StatsBomb lineups import failed`);
      }
      if (options.includeEvents !== false && eventMatches < maxEventMatches) {
        try {
          const events = await fetchJson<EventRow[]>(`${statsbombBaseUrl}/events/${match.match_id}.json`);
          addEvents(match, competition, season, events, players, activities);
          eventMatches += 1;
        } catch (error) {
          warnings.push(error instanceof Error ? `events/${match.match_id}: ${error.message}` : `events/${match.match_id}: StatsBomb events import failed`);
        }
      }
    }
  }

  const facts = Array.from(aggregates.values()).flatMap(factsFromAggregate);
  const competitionRecords = competitionRows.map((row) => {
    const value = competitionName(row.competition_name);
    return {
      value,
      aliases: Array.from(new Set([value, row.competition_name, row.country_name].filter(Boolean))),
      domainGroup: "sports.football" as const,
      sport: "football" as const
    };
  });
  const snapshot = mergeSportsKnowledge({
    competitions: competitionRecords,
    teams: Array.from(teams.values()),
    players: Array.from(players.values()),
    matchActivities: activities,
    facts
  }, {
    replaceProviders: ["statsbomb"],
    replaceDomainGroups: ["sports.football"]
  });

  return {
    source: "statsbomb",
    competitions: new Set(competitionRecords.map((row) => row.value)).size,
    competitionSeasons: selectedRows.length,
    matches: importedMatches,
    eventMatches,
    teams: teams.size,
    players: players.size,
    matchActivities: activities.length,
    facts: facts.length,
    warnings,
    snapshot
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "User-Agent": "Arion" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`download failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 120)}` : ""}`);
  }
  return (await response.json()) as T;
}

function selectCompetitionSeasons(rows: CompetitionRow[], options: ImportOptions) {
  const requestedCompetitions = new Set((options.competitions ?? defaultCompetitions).map((value) => normalize(competitionName(value))));
  const requestedSeasons = new Set((options.seasons ?? []).map((value) => normalize(seasonLabel(value))));
  return rows
    .filter((row) => {
      if (requestedCompetitions.size > 0 && !requestedCompetitions.has(normalize(competitionName(row.competition_name)))) return false;
      if (requestedSeasons.size > 0 && !requestedSeasons.has(normalize(seasonLabel(row.season_name)))) return false;
      return true;
    })
    .sort((a, b) => {
      const dateA = Date.parse(a.match_available ?? "") || 0;
      const dateB = Date.parse(b.match_available ?? "") || 0;
      return dateB - dateA || competitionName(a.competition_name).localeCompare(competitionName(b.competition_name));
    });
}

const defaultCompetitions = ["Premier League", "Bundesliga", "Champions League", "La Liga", "FIFA World Cup", "UEFA Euro"];

function addMatchTeamsAndFacts(
  match: MatchRow,
  competition: string,
  season: string,
  teams: Map<string, ImportedTeam>,
  aggregates: Map<string, TeamAggregate>
) {
  const homeTeam = match.home_team?.home_team_name;
  const awayTeam = match.away_team?.away_team_name;
  const homeScore = numberOrNull(match.home_score);
  const awayScore = numberOrNull(match.away_score);
  if (!homeTeam || !awayTeam) return;
  addTeam(teams, homeTeam, competition);
  addTeam(teams, awayTeam, competition);
  if (homeScore === null || awayScore === null) return;
  applyResult(aggregateFor(aggregates, competition, season, homeTeam), homeScore, awayScore);
  applyResult(aggregateFor(aggregates, competition, season, awayTeam), awayScore, homeScore);
}

function addLineups(
  match: MatchRow,
  competition: string,
  season: string,
  lineups: LineupTeam[],
  teams: Map<string, ImportedTeam>,
  players: Map<string, SportsKnowledgePlayer>,
  activities: SportsKnowledgeMatchActivity[]
) {
  for (const teamLineup of lineups) {
    const team = teamLineup.team_name;
    if (!team) continue;
    addTeam(teams, team, competition);
    for (const player of teamLineup.lineup ?? []) {
      const canonical = player.player_nickname || player.player_name;
      if (!canonical) continue;
      mergePlayer(players, {
        id: `statsbomb:${slug(competition)}:${player.player_id ?? slug(canonical)}`,
        canonical,
        aliases: Array.from(new Set([canonical, player.player_name, player.player_nickname].filter(isString))),
        sport: "football",
        league: competition,
        activeSeasons: [season],
        teamsBySeason: { [season]: team },
        provider: "statsbomb",
        externalIds: player.player_id ? { statsbomb: player.player_id } : undefined,
        position: firstPosition(player.positions),
        shirtNumber: numberOrNull(player.jersey_number)
      });
      const role = lineupRole(player.positions);
      const base = activityBase(match, competition, season, team, canonical, player.player_id ?? null);
      activities.push({
        ...base,
        id: `statsbomb:lineup:${match.match_id}:${slug(team)}:${player.player_id ?? slug(canonical)}`,
        role,
        minute: null,
        event: "lineup",
        sourceText: `${canonical} was listed as ${role.toLowerCase()} for ${team} in ${competition} ${season}.`
      });
      activities.push({
        ...base,
        id: `statsbomb:appearance:${match.match_id}:${slug(team)}:${player.player_id ?? slug(canonical)}`,
        role: "STAT",
        minute: null,
        event: "appearance",
        sourceText: `${canonical} recorded 1 appearances for ${team} in ${competition} ${season}.`
      });
    }
  }
}

function addEvents(
  match: MatchRow,
  competition: string,
  season: string,
  events: EventRow[],
  players: Map<string, SportsKnowledgePlayer>,
  activities: SportsKnowledgeMatchActivity[]
) {
  for (const event of events) {
    const type = event.type?.name ?? "";
    const player = event.player?.name;
    const team = event.team?.name ?? "";
    if (!player || !team) continue;
    upsertEventPlayer(players, competition, season, team, player, event.player?.id);
    if (type === "Shot" && event.shot?.outcome?.name === "Goal") {
      activities.push(eventActivity(match, competition, season, team, player, event.player?.id, event, "GOAL", "goal", "recorded 1 goals"));
    } else if (type === "Pass" && event.pass?.goal_assist) {
      activities.push(eventActivity(match, competition, season, team, player, event.player?.id, event, "ASSIST", "assist", "recorded 1 assists"));
    } else if ((type === "Foul Committed" && event.foul_committed?.card) || (type === "Bad Behaviour" && event.bad_behaviour?.card)) {
      activities.push(eventActivity(match, competition, season, team, player, event.player?.id, event, "CARD", "card", "recorded 1 cards"));
    } else if (type === "Substitution") {
      activities.push(eventActivity(match, competition, season, team, player, event.player?.id, event, "SUB_OUT", "substitution out", "was substituted out"));
      const replacement = event.substitution?.replacement;
      if (replacement?.name) {
        upsertEventPlayer(players, competition, season, team, replacement.name, replacement.id);
        activities.push(eventActivity(match, competition, season, team, replacement.name, replacement.id, event, "SUB_IN", "substitution in", "was substituted in"));
      }
    }
  }
}

function upsertEventPlayer(players: Map<string, SportsKnowledgePlayer>, competition: string, season: string, team: string, canonical: string, playerId: number | undefined) {
  mergePlayer(players, {
    id: `statsbomb:${slug(competition)}:${playerId ?? slug(canonical)}`,
    canonical,
    aliases: [canonical],
    sport: "football",
    league: competition,
    activeSeasons: [season],
    teamsBySeason: { [season]: team },
    provider: "statsbomb",
    externalIds: playerId ? { statsbomb: playerId } : undefined,
    position: null,
    shirtNumber: null
  });
}

function eventActivity(
  match: MatchRow,
  competition: string,
  season: string,
  team: string,
  player: string,
  playerId: number | undefined,
  event: EventRow,
  role: SportsKnowledgeMatchActivity["role"],
  eventName: string,
  metricText: string
): SportsKnowledgeMatchActivity {
  return {
    ...activityBase(match, competition, season, team, player, playerId ?? null),
    id: `statsbomb:event:${match.match_id}:${event.id ?? event.index ?? role}:${slug(role)}:${playerId ?? slug(player)}`,
    role,
    minute: numberOrNull(event.minute),
    event: eventName,
    sourceText: `${player} ${metricText} for ${team} in ${competition} ${season}${typeof event.minute === "number" ? ` at ${event.minute}'` : ""}.`
  };
}

function activityBase(match: MatchRow, competition: string, season: string, team: string, player: string, playerId: number | null) {
  return {
    provider: "statsbomb" as const,
    competition,
    season,
    matchId: match.match_id,
    utcDate: match.match_date ?? null,
    matchday: null,
    homeTeam: match.home_team?.home_team_name ?? "Home",
    awayTeam: match.away_team?.away_team_name ?? "Away",
    team,
    player,
    playerId
  };
}

function factsFromAggregate(item: TeamAggregate): SportsKnowledgeFact[] {
  const points = item.wins * 3 + item.draws;
  return [
    fact(item, "league_table", "played", item.played),
    fact(item, "league_table", "wins", item.wins),
    fact(item, "league_table", "draws", item.draws),
    fact(item, "league_table", "losses", item.losses),
    fact(item, "league_table", "points", points),
    fact(item, "team_offense", "goals_for", item.goalsFor),
    fact(item, "team_defense", "goals_against", item.goalsAgainst),
    fact(item, "team_stat", "goal_difference", item.goalsFor - item.goalsAgainst)
  ];
}

function fact(item: TeamAggregate, kind: SportsKnowledgeFact["kind"], metric: string, value: number): SportsKnowledgeFact {
  return {
    id: `statsbomb:fact:${slug(item.competition)}:${slug(item.season)}:${slug(item.team)}:${slug(metric)}`,
    provider: "statsbomb",
    kind,
    competition: item.competition,
    season: item.season,
    entityType: "team",
    entityName: item.team,
    team: item.team,
    metric,
    value,
    rank: null,
    sourceText: `${item.team} ${metric.replace(/_/g, " ")} in StatsBomb ${item.competition} ${item.season}: ${value}.`
  };
}

function aggregateFor(aggregates: Map<string, TeamAggregate>, competition: string, season: string, team: string) {
  const key = `${competition}:${season}:${team}`;
  const aggregate = aggregates.get(key) ?? {
    team,
    competition,
    season,
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0
  };
  aggregates.set(key, aggregate);
  return aggregate;
}

function applyResult(aggregate: TeamAggregate, goalsFor: number, goalsAgainst: number) {
  aggregate.played += 1;
  if (goalsFor > goalsAgainst) aggregate.wins += 1;
  if (goalsFor === goalsAgainst) aggregate.draws += 1;
  if (goalsFor < goalsAgainst) aggregate.losses += 1;
  aggregate.goalsFor += goalsFor;
  aggregate.goalsAgainst += goalsAgainst;
}

function addTeam(teams: Map<string, ImportedTeam>, value: string, league: string) {
  const key = `${league}:${value}`;
  const existing = teams.get(key);
  teams.set(key, {
    value,
    aliases: Array.from(new Set([value, ...(existing?.aliases ?? [])])),
    domainGroup: "sports.football",
    league
  });
}

function mergePlayer(players: Map<string, SportsKnowledgePlayer>, player: SportsKnowledgePlayer) {
  const key = `${player.league}:${normalize(player.canonical)}`;
  const existing = players.get(key);
  if (!existing) {
    players.set(key, player);
    return;
  }
  players.set(key, {
    ...existing,
    aliases: Array.from(new Set([...existing.aliases, ...player.aliases])),
    activeSeasons: Array.from(new Set([...existing.activeSeasons, ...player.activeSeasons])).sort(),
    teamsBySeason: { ...existing.teamsBySeason, ...player.teamsBySeason },
    externalIds: { ...(existing.externalIds ?? {}), ...(player.externalIds ?? {}) },
    position: existing.position ?? player.position,
    shirtNumber: existing.shirtNumber ?? player.shirtNumber
  });
}

function lineupRole(positions: LineupTeam["lineup"][number]["positions"]): "STARTING" | "BENCH" {
  if (!positions || positions.length === 0) return "BENCH";
  return positions.some((item) => item.start_reason === "Starting XI" || item.from === "00:00") ? "STARTING" : "BENCH";
}

function firstPosition(positions: LineupTeam["lineup"][number]["positions"]) {
  return positions?.find((item) => item.position)?.position ?? null;
}

function competitionName(value: string) {
  return competitionNameMap[value] ?? value;
}

const competitionNameMap: Record<string, string> = {
  "1. Bundesliga": "Bundesliga"
};

function seasonLabel(value: string) {
  const match = value.match(/^(\d{4})\/(\d{4})$/);
  if (match) return `${match[1]}-${match[2].slice(-2)}`;
  return value.replace("/", "-");
}

function numberOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function bounded(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

function slug(value: string) {
  return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
