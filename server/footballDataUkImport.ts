import type { SportsKnowledgeSnapshot } from "../shared/types";
import { mergeSportsKnowledge, type SportsKnowledgeFact } from "./sportsKnowledge";

const footballDataUkBaseUrl = "https://www.football-data.co.uk/mmz4281";

type ImportOptions = {
  seasons?: string[];
  divisions?: string[];
};

type CsvRow = Record<string, string>;

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
  shots: number;
  shotsOnTarget: number;
  corners: number;
  fouls: number;
  yellowCards: number;
  redCards: number;
};

export async function importFootballDataUkKnowledge(options: ImportOptions = {}): Promise<{
  source: "football-data-uk";
  seasons: string[];
  divisions: string[];
  teams: number;
  facts: number;
  warnings: string[];
  snapshot: SportsKnowledgeSnapshot;
}> {
  const seasons = normalizeSeasons(options.seasons);
  const divisions = normalizeDivisions(options.divisions);
  const warnings: string[] = [];
  const teams = new Map<string, ImportedTeam>();
  const aggregates = new Map<string, TeamAggregate>();

  for (const seasonCode of seasons) {
    for (const division of divisions) {
      const competition = competitionFromDivision(division);
      try {
        const rows = await fetchCsv(`${footballDataUkBaseUrl}/${seasonCode}/${division}.csv`);
        for (const row of rows) {
          applyMatchRow(row, competition, seasonLabelFromCode(seasonCode), teams, aggregates);
        }
      } catch (error) {
        warnings.push(error instanceof Error ? `${division}/${seasonCode}: ${error.message}` : `${division}/${seasonCode}: football-data.co.uk import failed`);
      }
    }
  }

  const facts = Array.from(aggregates.values()).flatMap(factsFromAggregate);
  const snapshot = mergeSportsKnowledge({
    competitions: divisions.map((division) => ({
      value: competitionFromDivision(division),
      aliases: competitionAliases(division),
      domainGroup: "sports.football" as const,
      sport: "football" as const
    })),
    teams: Array.from(teams.values()),
    facts
  }, {
    replaceProviders: ["football-data-uk"],
    replaceDomainGroups: ["sports.football"]
  });

  return {
    source: "football-data-uk",
    seasons,
    divisions,
    teams: teams.size,
    facts: facts.length,
    warnings,
    snapshot
  };
}

async function fetchCsv(url: string) {
  const response = await fetch(url, { headers: { "User-Agent": "Arion" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`download failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 120)}` : ""}`);
  }
  return rowsFromCsv(await response.text());
}

function applyMatchRow(
  row: CsvRow,
  competition: string,
  season: string,
  teams: Map<string, ImportedTeam>,
  aggregates: Map<string, TeamAggregate>
) {
  const homeTeam = pick(row, ["HomeTeam"]);
  const awayTeam = pick(row, ["AwayTeam"]);
  const homeGoals = numberValue(pick(row, ["FTHG"]));
  const awayGoals = numberValue(pick(row, ["FTAG"]));
  if (!homeTeam || !awayTeam || homeGoals === null || awayGoals === null) return;
  addTeam(teams, homeTeam, competition);
  addTeam(teams, awayTeam, competition);
  applyTeamMatch(aggregateFor(aggregates, competition, season, homeTeam), {
    goalsFor: homeGoals,
    goalsAgainst: awayGoals,
    shots: numberValue(pick(row, ["HS"])),
    shotsOnTarget: numberValue(pick(row, ["HST"])),
    corners: numberValue(pick(row, ["HC"])),
    fouls: numberValue(pick(row, ["HF"])),
    yellowCards: numberValue(pick(row, ["HY"])),
    redCards: numberValue(pick(row, ["HR"]))
  });
  applyTeamMatch(aggregateFor(aggregates, competition, season, awayTeam), {
    goalsFor: awayGoals,
    goalsAgainst: homeGoals,
    shots: numberValue(pick(row, ["AS"])),
    shotsOnTarget: numberValue(pick(row, ["AST"])),
    corners: numberValue(pick(row, ["AC"])),
    fouls: numberValue(pick(row, ["AF"])),
    yellowCards: numberValue(pick(row, ["AY"])),
    redCards: numberValue(pick(row, ["AR"]))
  });
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
    goalsAgainst: 0,
    shots: 0,
    shotsOnTarget: 0,
    corners: 0,
    fouls: 0,
    yellowCards: 0,
    redCards: 0
  };
  aggregates.set(key, aggregate);
  return aggregate;
}

function applyTeamMatch(aggregate: TeamAggregate, values: {
  goalsFor: number;
  goalsAgainst: number;
  shots: number | null;
  shotsOnTarget: number | null;
  corners: number | null;
  fouls: number | null;
  yellowCards: number | null;
  redCards: number | null;
}) {
  aggregate.played += 1;
  if (values.goalsFor > values.goalsAgainst) aggregate.wins += 1;
  if (values.goalsFor === values.goalsAgainst) aggregate.draws += 1;
  if (values.goalsFor < values.goalsAgainst) aggregate.losses += 1;
  aggregate.goalsFor += values.goalsFor;
  aggregate.goalsAgainst += values.goalsAgainst;
  aggregate.shots += values.shots ?? 0;
  aggregate.shotsOnTarget += values.shotsOnTarget ?? 0;
  aggregate.corners += values.corners ?? 0;
  aggregate.fouls += values.fouls ?? 0;
  aggregate.yellowCards += values.yellowCards ?? 0;
  aggregate.redCards += values.redCards ?? 0;
}

function addTeam(teams: Map<string, ImportedTeam>, value: string, league: string) {
  const existing = teams.get(`${league}:${value}`);
  const aliases = Array.from(new Set([value, ...(existing?.aliases ?? [])]));
  teams.set(`${league}:${value}`, { value, aliases, domainGroup: "sports.football", league });
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
    fact(item, "team_stat", "goal_difference", item.goalsFor - item.goalsAgainst),
    fact(item, "team_offense", "shots", item.shots),
    fact(item, "team_offense", "shots_on_target", item.shotsOnTarget),
    fact(item, "team_offense", "corners", item.corners),
    fact(item, "team_stat", "fouls", item.fouls),
    fact(item, "team_stat", "yellow_cards", item.yellowCards),
    fact(item, "team_stat", "red_cards", item.redCards)
  ];
}

function fact(item: TeamAggregate, kind: SportsKnowledgeFact["kind"], metric: string, value: string | number): SportsKnowledgeFact {
  return {
    id: `football-data-uk:fact:${slug(item.competition)}:${slug(item.season)}:${slug(item.team)}:${slug(metric)}`,
    provider: "football-data-uk",
    kind,
    competition: item.competition,
    season: item.season,
    entityType: "team",
    entityName: item.team,
    team: item.team,
    metric,
    value,
    rank: null,
    sourceText: `${item.team} ${metric.replace(/_/g, " ")} in ${item.competition} ${item.season}: ${value}.`
  };
}

function normalizeSeasons(seasons: string[] | undefined) {
  const values = seasons?.map((season) => season.trim()).filter(Boolean) ?? [];
  if (values.length > 0) return Array.from(new Set(values.map(seasonCode)));
  const current = currentSeasonCode();
  const previousStart = Number(current.slice(0, 2)) - 1;
  const previous = `${String(previousStart).padStart(2, "0")}${current.slice(0, 2)}`;
  return [current, previous];
}

function normalizeDivisions(divisions: string[] | undefined) {
  const values = divisions?.map((division) => division.trim().toUpperCase()).filter(Boolean) ?? [];
  return values.length > 0 ? Array.from(new Set(values)) : ["E0", "D1", "I1", "SP1", "F1"];
}

function currentSeasonCode() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 6 ? year : year - 1;
  return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
}

function seasonCode(value: string) {
  const compact = value.replace(/[^0-9]/g, "");
  if (/^\d{4}$/.test(compact)) return compact;
  if (/^\d{8}$/.test(compact)) return `${compact.slice(2, 4)}${compact.slice(6, 8)}`;
  return currentSeasonCode();
}

function seasonLabelFromCode(code: string) {
  const start = Number(code.slice(0, 2));
  const end = Number(code.slice(2, 4));
  const century = start > 70 ? 1900 : 2000;
  return `${century + start}-${String(end).padStart(2, "0")}`;
}

function competitionFromDivision(division: string) {
  return divisionMap[division]?.competition ?? division;
}

function competitionAliases(division: string) {
  const mapped = divisionMap[division];
  return mapped ? [mapped.competition, ...mapped.aliases, division] : [division];
}

const divisionMap: Record<string, { competition: string; aliases: string[] }> = {
  E0: { competition: "Premier League", aliases: ["EPL", "English Premier League"] },
  E1: { competition: "EFL Championship", aliases: ["Championship"] },
  D1: { competition: "Bundesliga", aliases: ["1. Bundesliga"] },
  I1: { competition: "Serie A", aliases: ["Italian Serie A"] },
  SP1: { competition: "La Liga", aliases: ["Spanish La Liga", "Primera Division"] },
  F1: { competition: "Ligue 1", aliases: ["French Ligue 1", "Le Championnat"] },
  N1: { competition: "Eredivisie", aliases: ["Dutch Eredivisie"] },
  P1: { competition: "Primeira Liga", aliases: ["Portugal Liga I"] }
};

function rowsFromCsv(raw: string) {
  const records = parseCsv(raw);
  const [headers, ...rows] = records;
  if (!headers || rows.length === 0) return [];
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header.trim(), row[index]?.trim() ?? ""])));
}

function parseCsv(raw: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function pick(row: CsvRow, names: string[]) {
  for (const name of names) {
    const value = row[name];
    if (value?.trim()) return value.trim();
  }
  return "";
}

function numberValue(value: string) {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function slug(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
