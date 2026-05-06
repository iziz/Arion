import type { KnowledgeSnapshot } from "../shared/types";
import {
  mergeSportsKnowledge,
  type AmericanFootballPlayMetadata,
  type SportsKnowledgeFact,
  type SportsKnowledgeMatchActivity,
  type SportsKnowledgePlayer
} from "./knowledge/adapters/sports/store";

const nflverseBaseUrl = "https://github.com/nflverse/nflverse-data/releases/download";
const currentYear = new Date().getUTCFullYear();

type ImportOptions = {
  seasons?: number[];
  includePlayers?: boolean;
  includePlays?: boolean;
  maxPlaysPerSeason?: number;
};

type NflverseCsvRow = Record<string, string>;

type ImportedTeam = {
  value: string;
  aliases: string[];
  domainGroup: "sports.american_football";
  league: "NFL";
};

export async function importNflverseKnowledge(options: ImportOptions = {}): Promise<{
  source: "nflverse";
  seasons: number[];
  players: number;
  teams: number;
  matchActivities: number;
  facts: number;
  plays: number;
  warnings: string[];
  snapshot: KnowledgeSnapshot;
}> {
  const seasons = normalizeSeasons(options.seasons);
  const warnings: string[] = [];
  const playersByKey = new Map<string, SportsKnowledgePlayer>();
  const teams = new Map<string, ImportedTeam>();
  const matchActivities: SportsKnowledgeMatchActivity[] = [];
  const facts: SportsKnowledgeFact[] = [];
  const americanFootballPlays: AmericanFootballPlayMetadata[] = [];

  if (options.includePlayers !== false) {
    try {
      for (const player of playersFromRows(await fetchCsv(`${nflverseBaseUrl}/players/players.csv`))) {
        mergePlayer(playersByKey, player);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "nflverse players import failed");
    }
  }

  for (const season of seasons) {
    try {
      const rows = await fetchCsv(`${nflverseBaseUrl}/rosters/roster_${season}.csv`);
      for (const team of teamsFromRows(rows)) teams.set(team.value, team);
      for (const player of playersFromRosterRows(rows, season)) mergePlayer(playersByKey, player);
      matchActivities.push(...activitiesFromRosterRows(rows, season));
      facts.push(...factsFromRosterRows(rows, season));
    } catch (error) {
      warnings.push(error instanceof Error ? `roster_${season}: ${error.message}` : `roster_${season}: nflverse roster import failed`);
    }

    if (options.includePlays !== false) {
      try {
        const rows = await fetchCsv(`${nflverseBaseUrl}/pbp/play_by_play_${season}.csv`);
        americanFootballPlays.push(...americanFootballPlaysFromPbpRows(rows, season, options.maxPlaysPerSeason));
      } catch (error) {
        warnings.push(error instanceof Error ? `play_by_play_${season}: ${error.message}` : `play_by_play_${season}: nflverse play-by-play import failed`);
      }
    }
  }

  const snapshot = mergeSportsKnowledge({
    teams: Array.from(teams.values()),
    players: Array.from(playersByKey.values()),
    matchActivities,
    facts,
    americanFootballPlays
  }, {
    replaceProviders: ["nflverse"],
    replaceDomainGroups: ["sports.american_football"]
  });

  return {
    source: "nflverse",
    seasons,
    players: playersByKey.size,
    teams: teams.size,
    matchActivities: matchActivities.length,
    facts: facts.length,
    plays: americanFootballPlays.length,
    warnings,
    snapshot
  };
}

async function fetchCsv(url: string) {
  const response = await fetch(url, { headers: { "User-Agent": "Arion" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`nflverse download failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 120)}` : ""}`);
  }
  return rowsFromCsv(await response.text());
}

function playersFromRows(rows: NflverseCsvRow[]): SportsKnowledgePlayer[] {
  return rows.flatMap((row) => {
    const canonical = pick(row, ["display_name", "full_name", "player_name"]);
    if (!canonical) return [];
    const lastSeason = pick(row, ["last_season"]);
    const latestTeam = teamName(pick(row, ["latest_team"]));
    return [
      {
        id: `nflverse-${pick(row, ["gsis_id"]) || slug(canonical)}`,
        canonical,
        aliases: playerAliases(row, canonical),
        sport: "american_football",
        league: "NFL",
        activeSeasons: lastSeason ? [lastSeason] : [],
        teamsBySeason: lastSeason && latestTeam ? { [lastSeason]: latestTeam } : {},
        provider: "nflverse",
        externalIds: externalIds(row),
        position: pick(row, ["position", "position_group"]) || null,
        shirtNumber: numberValue(pick(row, ["jersey_number"]))
      } satisfies SportsKnowledgePlayer
    ];
  });
}

function playersFromRosterRows(rows: NflverseCsvRow[], season: number): SportsKnowledgePlayer[] {
  return rows.flatMap((row) => {
    const canonical = pick(row, ["full_name", "display_name"]);
    if (!canonical) return [];
    const team = teamName(pick(row, ["team"]));
    return [
      {
        id: `nflverse-${pick(row, ["gsis_id"]) || slug(canonical)}`,
        canonical,
        aliases: playerAliases(row, canonical),
        sport: "american_football",
        league: "NFL",
        activeSeasons: [String(season)],
        teamsBySeason: team ? { [String(season)]: team } : {},
        provider: "nflverse",
        externalIds: externalIds(row),
        position: pick(row, ["depth_chart_position", "position", "ngs_position"]) || null,
        shirtNumber: numberValue(pick(row, ["jersey_number"]))
      } satisfies SportsKnowledgePlayer
    ];
  });
}

function teamsFromRows(rows: NflverseCsvRow[]): ImportedTeam[] {
  const teams = new Map<string, ImportedTeam>();
  for (const row of rows) {
    const code = pick(row, ["team", "latest_team"]);
    const value = teamName(code);
    if (!value) continue;
    const existing = teams.get(value);
    const aliases = Array.from(new Set([...(existing?.aliases ?? []), value, code, ...(teamAliases[code] ?? [])].filter(Boolean)));
    teams.set(value, { value, aliases, domainGroup: "sports.american_football", league: "NFL" });
  }
  return Array.from(teams.values());
}

function activitiesFromRosterRows(rows: NflverseCsvRow[], season: number): SportsKnowledgeMatchActivity[] {
  return rows.flatMap((row) => {
    const player = pick(row, ["full_name", "display_name"]);
    const team = teamName(pick(row, ["team"]));
    if (!player || !team) return [];
    const position = pick(row, ["depth_chart_position", "position", "ngs_position"]) || "unknown position";
    const status = pick(row, ["status", "status_description_abbr"]) || "unknown status";
    return [
      {
        id: `nflverse:roster:${season}:${slug(team)}:${pick(row, ["gsis_id"]) || slug(player)}`,
        provider: "nflverse",
        competition: "NFL",
        season: String(season),
        matchId: 0,
        utcDate: null,
        matchday: null,
        homeTeam: team,
        awayTeam: "Season roster",
        team,
        player,
        playerId: numberValue(pick(row, ["espn_id", "nfl_id"])),
        role: "STAT",
        minute: null,
        event: "season roster",
        sourceText: `${player} was listed by nflverse on ${team}'s ${season} roster as ${position} (${status}).`
      } satisfies SportsKnowledgeMatchActivity
    ];
  });
}

function factsFromRosterRows(rows: NflverseCsvRow[], season: number): SportsKnowledgeFact[] {
  const counts = new Map<string, { team: string; total: number; positions: Map<string, number> }>();
  for (const row of rows) {
    const team = teamName(pick(row, ["team"]));
    if (!team) continue;
    const position = pick(row, ["depth_chart_position", "position", "ngs_position"]) || "unknown";
    const current = counts.get(team) ?? { team, total: 0, positions: new Map<string, number>() };
    current.total += 1;
    current.positions.set(position, (current.positions.get(position) ?? 0) + 1);
    counts.set(team, current);
  }
  return Array.from(counts.values()).flatMap((item) => [
    {
      id: `nflverse:fact:roster:${season}:${slug(item.team)}:roster-players`,
      provider: "nflverse",
      kind: "team_stat",
      competition: "NFL",
      season: String(season),
      entityType: "team",
      entityName: item.team,
      team: item.team,
      metric: "roster_players",
      value: item.total,
      rank: null,
      sourceText: `${item.team} had ${item.total} roster rows in nflverse for ${season}.`
    } satisfies SportsKnowledgeFact,
    ...Array.from(item.positions.entries()).map(([position, count]) => ({
      id: `nflverse:fact:roster:${season}:${slug(item.team)}:${slug(position)}-players`,
      provider: "nflverse" as const,
      kind: "team_stat" as const,
      competition: "NFL",
      season: String(season),
      entityType: "team" as const,
      entityName: item.team,
      team: item.team,
      metric: `${position}_players`,
      value: count,
      rank: null,
      sourceText: `${item.team} had ${count} ${position} roster rows in nflverse for ${season}.`
    }))
  ]);
}

export function americanFootballPlaysFromPbpRows(rows: NflverseCsvRow[], fallbackSeason: number, maxRows?: number): AmericanFootballPlayMetadata[] {
  const limit = Number.isFinite(maxRows) && maxRows !== undefined ? Math.max(0, Math.floor(maxRows)) : rows.length;
  const plays: AmericanFootballPlayMetadata[] = [];
  for (const row of rows) {
    if (plays.length >= limit) break;
    const gameId = pick(row, ["game_id", "game id"]);
    const playId = pick(row, ["play_id", "play id"]);
    const description = pick(row, ["desc", "description"]);
    if (!gameId || !playId || !description) continue;
    const season = String(numberValue(pick(row, ["season"])) ?? fallbackSeason);
    const week = numberValue(pick(row, ["week"]));
    const homeTeam = teamName(pick(row, ["home_team", "home"]));
    const awayTeam = teamName(pick(row, ["away_team", "away"]));
    const possessionTeam = teamName(pick(row, ["posteam", "possession_team", "possession"]));
    const defensiveTeam = teamName(pick(row, ["defteam", "defensive_team", "defense"]));
    const down = numberValue(pick(row, ["down"]));
    const distance = numberValue(pick(row, ["ydstogo", "distance", "yards_to_go"]));
    const yardline = pick(row, ["yrdln", "yardline"]);
    const yardline100 = numberValue(pick(row, ["yardline_100", "yardline100"]));
    const quarter = numberValue(pick(row, ["qtr", "quarter"]));
    const clock = pick(row, ["time", "clock"]);
    const playType = pick(row, ["play_type", "play type"]) || "unknown";
    const yardsGained = numberValue(pick(row, ["yards_gained", "yards gained"]));
    const touchdown = booleanValue(pick(row, ["touchdown", "td"])) || Boolean(pick(row, ["td_player_id", "td_player_name"]));
    const turnover =
      booleanValue(pick(row, ["interception", "fumble_lost", "turnover"])) ||
      Boolean(pick(row, ["interception_player_id", "fumble_lost_1_player_id", "fumble_lost_2_player_id"]));
    const passerPlayerId = pick(row, ["passer_player_id", "passer_id"]);
    const passerPlayerName = pick(row, ["passer_player_name", "passer"]);
    const rusherPlayerId = pick(row, ["rusher_player_id", "rusher_id"]);
    const rusherPlayerName = pick(row, ["rusher_player_name", "rusher"]);
    const receiverPlayerId = pick(row, ["receiver_player_id", "receiver_id"]);
    const receiverPlayerName = pick(row, ["receiver_player_name", "receiver"]);
    plays.push({
      id: `nflverse:play:${season}:${gameId}:${playId}`,
      provider: "nflverse",
      competition: "NFL",
      season,
      week,
      gameId,
      playId,
      gameDate: pick(row, ["game_date", "game date"]) || null,
      homeTeam,
      awayTeam,
      possessionTeam: possessionTeam || null,
      defensiveTeam: defensiveTeam || null,
      quarter,
      clock: clock || null,
      down,
      distance,
      yardline: yardline || null,
      yardline100,
      playType,
      description,
      yardsGained,
      touchdown,
      turnover,
      passerPlayerId: passerPlayerId || null,
      passerPlayerName: passerPlayerName || null,
      rusherPlayerId: rusherPlayerId || null,
      rusherPlayerName: rusherPlayerName || null,
      receiverPlayerId: receiverPlayerId || null,
      receiverPlayerName: receiverPlayerName || null,
      sourceText: buildPlaySourceText({
        gameId,
        playId,
        season,
        week,
        possessionTeam,
        defensiveTeam,
        down,
        distance,
        yardline,
        quarter,
        clock,
        playType,
        description,
        yardsGained
      })
    });
  }
  return plays;
}

function buildPlaySourceText(play: {
  gameId: string;
  playId: string;
  season: string;
  week: number | null;
  possessionTeam: string;
  defensiveTeam: string;
  down: number | null;
  distance: number | null;
  yardline: string;
  quarter: number | null;
  clock: string;
  playType: string;
  description: string;
  yardsGained: number | null;
}) {
  const downDistance = play.down && play.distance !== null ? `${ordinal(play.down)} and ${play.distance}` : "down-distance unknown";
  const context = [
    `nflverse ${play.season}${play.week ? ` week ${play.week}` : ""}`,
    `gameId=${play.gameId}`,
    `playId=${play.playId}`,
    play.quarter ? `Q${play.quarter}` : "",
    play.clock || "",
    play.possessionTeam ? `${play.possessionTeam} offense` : "",
    play.defensiveTeam ? `vs ${play.defensiveTeam}` : "",
    downDistance,
    play.yardline || "",
    play.playType
  ].filter(Boolean).join(" · ");
  return `${context}. ${play.description}${play.yardsGained !== null ? ` Yards gained: ${play.yardsGained}.` : ""}`;
}

function mergePlayer(playersByKey: Map<string, SportsKnowledgePlayer>, player: SportsKnowledgePlayer) {
  const key = normalize(player.canonical);
  const existing = playersByKey.get(key);
  if (!existing) {
    playersByKey.set(key, player);
    return;
  }
  playersByKey.set(key, {
    ...existing,
    aliases: Array.from(new Set([...existing.aliases, ...player.aliases])),
    activeSeasons: Array.from(new Set([...existing.activeSeasons, ...player.activeSeasons])).sort(),
    teamsBySeason: { ...existing.teamsBySeason, ...player.teamsBySeason },
    externalIds: { ...(existing.externalIds ?? {}), ...(player.externalIds ?? {}) },
    position: player.position ?? existing.position,
    shirtNumber: player.shirtNumber ?? existing.shirtNumber
  });
}

function normalizeSeasons(seasons: number[] | undefined) {
  const values = seasons?.filter((season) => Number.isInteger(season) && season >= 1920 && season <= currentYear + 1) ?? [];
  const defaults = [currentYear, currentYear - 1, currentYear - 2];
  return Array.from(new Set((values.length > 0 ? values : defaults).map(Number))).sort((a, b) => b - a);
}

function playerAliases(row: NflverseCsvRow, canonical: string) {
  const firstName = pick(row, ["first_name"]);
  const lastName = pick(row, ["last_name"]);
  const footballName = pick(row, ["football_name"]);
  const aliases = [
    canonical,
    pick(row, ["full_name"]),
    pick(row, ["display_name"]),
    pick(row, ["short_name"]),
    footballName && lastName && normalize(footballName) !== normalize(firstName) ? [footballName, lastName].join(" ") : "",
    [firstName, lastName].filter(Boolean).join(" "),
    lastName
  ].filter((value) => value && value.length > 1);
  return Array.from(new Set(aliases));
}

function externalIds(row: NflverseCsvRow) {
  return Object.fromEntries(
    [
      "gsis_id",
      "nfl_id",
      "espn_id",
      "pfr_id",
      "pff_id",
      "sportradar_id",
      "smart_id",
      "sleeper_id",
      "yahoo_id"
    ].flatMap((key) => {
      const value = pick(row, [key]);
      return value ? [[key, numericOrString(value)]] : [];
    })
  );
}

function rowsFromCsv(raw: string) {
  const records = parseCsv(raw);
  const [headers, ...rows] = records;
  if (!headers || rows.length === 0) return [];
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  return rows.map((row) =>
    Object.fromEntries(normalizedHeaders.map((header, index) => [header, row[index]?.trim() ?? ""]))
  );
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

function pick(row: NflverseCsvRow, names: string[]) {
  for (const name of names) {
    const value = row[normalizeHeader(name)];
    if (value?.trim()) return value.trim();
  }
  return "";
}

function numericOrString(value: string) {
  const parsed = numberValue(value);
  return parsed ?? value;
}

function numberValue(value: string) {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: string) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function ordinal(value: number) {
  if (value === 1) return "1st";
  if (value === 2) return "2nd";
  if (value === 3) return "3rd";
  return `${value}th`;
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

function slug(value: string) {
  return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function teamName(code: string) {
  if (!code) return "";
  const normalized = code.trim().toUpperCase();
  return teamNameByCode[normalized] ?? code.trim();
}

const teamNameByCode: Record<string, string> = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB: "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  JAC: "Jacksonville Jaguars",
  KC: "Kansas City Chiefs",
  LA: "Los Angeles Rams",
  LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  LV: "Las Vegas Raiders",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE: "New England Patriots",
  NO: "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SF: "San Francisco 49ers",
  SEA: "Seattle Seahawks",
  TB: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WAS: "Washington Commanders",
  WSH: "Washington Commanders"
};

const teamAliases: Record<string, string[]> = {
  ARI: ["Cardinals"],
  ATL: ["Falcons"],
  BAL: ["Ravens"],
  BUF: ["Bills"],
  CAR: ["Panthers"],
  CHI: ["Bears"],
  CIN: ["Bengals"],
  CLE: ["Browns"],
  DAL: ["Cowboys"],
  DEN: ["Broncos"],
  DET: ["Lions"],
  GB: ["Packers"],
  HOU: ["Texans"],
  IND: ["Colts"],
  JAX: ["Jaguars", "Jags"],
  JAC: ["Jaguars", "Jags"],
  KC: ["Chiefs"],
  LA: ["Rams"],
  LAC: ["Chargers"],
  LAR: ["Rams"],
  LV: ["Raiders"],
  MIA: ["Dolphins"],
  MIN: ["Vikings"],
  NE: ["Patriots"],
  NO: ["Saints"],
  NYG: ["Giants"],
  NYJ: ["Jets"],
  PHI: ["Eagles"],
  PIT: ["Steelers"],
  SF: ["49ers", "Niners"],
  SEA: ["Seahawks"],
  TB: ["Buccaneers", "Bucs"],
  TEN: ["Titans"],
  WAS: ["Commanders"],
  WSH: ["Commanders"]
};
