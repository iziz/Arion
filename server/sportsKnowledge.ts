import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type SportsLeague = "Premier League" | "NFL" | "Champions League" | "Bundesliga";

export type SportsKnowledgePlayer = {
  id: string;
  canonical: string;
  aliases: string[];
  sport: "football" | "american_football";
  league: SportsLeague;
  activeSeasons: string[];
  teamsBySeason: Record<string, string>;
};

export type KnowledgeMatch<T> = {
  value: T;
  confidence: number;
  source: "knowledge";
  evidence: string[];
};

type SportsCompetitionRecord = { value: SportsLeague; aliases: string[] };
type SportsTeamRecord = { value: string; aliases: string[] };

export const sportsCompetitions: SportsCompetitionRecord[] = [
  { value: "Premier League" as const, aliases: ["Premier League", "EPL", "프리미어 리그", "프리미어리그"] },
  { value: "NFL" as const, aliases: ["NFL", "National Football League"] },
  { value: "Champions League" as const, aliases: ["Champions League", "UCL", "챔피언스 리그", "챔피언스리그"] },
  { value: "Bundesliga" as const, aliases: ["Bundesliga", "분데스리가"] }
];

export const sportsTeams: SportsTeamRecord[] = [
  { value: "Manchester City", aliases: ["Manchester City", "Man City"] },
  { value: "Manchester United", aliases: ["Manchester United", "Man United"] },
  { value: "Arsenal", aliases: ["Arsenal"] },
  { value: "Liverpool", aliases: ["Liverpool"] },
  { value: "Chelsea", aliases: ["Chelsea"] },
  { value: "Tottenham Hotspur", aliases: ["Tottenham", "Spurs"] },
  { value: "Newcastle United", aliases: ["Newcastle"] },
  { value: "Brighton", aliases: ["Brighton"] },
  { value: "Nottingham Forest", aliases: ["Nottingham Forest", "Nottingham Forrester"] },
  { value: "Kansas City Chiefs", aliases: ["Kansas City Chiefs", "Chiefs"] },
  { value: "Buffalo Bills", aliases: ["Buffalo Bills", "Bills"] },
  { value: "Philadelphia Eagles", aliases: ["Philadelphia Eagles", "Eagles"] },
  { value: "San Francisco 49ers", aliases: ["San Francisco 49ers", "49ers", "Niners"] },
  { value: "Dallas Cowboys", aliases: ["Dallas Cowboys", "Cowboys"] }
];

export const sportsPlayers: SportsKnowledgePlayer[] = [
  player("erling-haaland", "Erling Haaland", ["Haaland", "Erling Haaland", "Holland"], "football", "Premier League", "Manchester City", ["2022-23", "2023-24", "2024-25", "2025-26"]),
  player("son-heung-min", "Son Heung-min", ["Son Heung-min", "Heung-min Son", "Sonny"], "football", "Premier League", "Tottenham Hotspur", ["2015-16", "2016-17", "2017-18", "2018-19", "2019-20", "2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]),
  player("mohamed-salah", "Mohamed Salah", ["Mohamed Salah", "Salah"], "football", "Premier League", "Liverpool", ["2017-18", "2018-19", "2019-20", "2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]),
  player("phil-foden", "Phil Foden", ["Phil Foden", "Foden"], "football", "Premier League", "Manchester City", ["2017-18", "2018-19", "2019-20", "2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]),
  player("kylian-mbappe", "Kylian Mbappé", ["Kylian Mbappé", "Kylian Mbappe", "Mbappé", "Mbappe"], "football", "Champions League", "Paris Saint-Germain", ["2017-18", "2018-19", "2019-20", "2020-21", "2021-22", "2022-23", "2023-24"]),
  player("patrick-mahomes", "Patrick Mahomes", ["Patrick Mahomes", "Mahomes"], "american_football", "NFL", "Kansas City Chiefs", ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"])
];

export function matchKnowledgePlayer(text: string): KnowledgeMatch<SportsKnowledgePlayer> | null {
  const normalized = normalize(text);
  for (const candidate of getSportsPlayers()) {
    const alias = candidate.aliases.find((value) => normalized.includes(normalize(value)));
    if (!alias) continue;
    return {
      value: candidate,
      confidence: alias === candidate.canonical ? 0.94 : 0.86,
      source: "knowledge",
      evidence: [`Matched player alias: ${alias}`]
    };
  }
  return null;
}

export function matchKnowledgePlayers(text: string): Array<KnowledgeMatch<SportsKnowledgePlayer>> {
  const normalized = normalize(text);
  return getSportsPlayers()
    .map((candidate) => {
      const alias = candidate.aliases.find((value) => normalized.includes(normalize(value)));
      if (!alias) return null;
      return {
        value: candidate,
        confidence: alias === candidate.canonical ? 0.94 : 0.86,
        source: "knowledge" as const,
        evidence: [`Matched player alias: ${alias}`]
      };
    })
    .filter((candidate): candidate is KnowledgeMatch<SportsKnowledgePlayer> => Boolean(candidate));
}

export function matchCompetition(text: string): KnowledgeMatch<SportsLeague> | null {
  const normalized = normalize(text);
  for (const candidate of getSportsCompetitions()) {
    const alias = candidate.aliases.find((value) => normalized.includes(normalize(value)));
    if (!alias) continue;
    return {
      value: candidate.value,
      confidence: 0.9,
      source: "knowledge",
      evidence: [`Matched competition alias: ${alias}`]
    };
  }
  return null;
}

export function matchTeams(text: string) {
  const normalized = normalize(text);
  return getSportsTeams()
    .filter((candidate) => candidate.aliases.some((alias) => normalized.includes(normalize(alias))))
    .map((candidate) => ({
      value: candidate.value,
      confidence: 0.84,
      source: "knowledge" as const,
      evidence: [`Matched team alias: ${candidate.aliases.find((alias) => normalized.includes(normalize(alias))) ?? candidate.value}`]
    }));
}

export function resolveRecentSeasons(league: SportsLeague | undefined, count: number) {
  const seasons = league === "NFL" ? ["2025", "2024", "2023", "2022", "2021", "2020"] : ["2025-26", "2024-25", "2023-24", "2022-23", "2021-22", "2020-21"];
  return seasons.slice(0, count).join(",");
}

export function playerTeamForSeason(playerName: string, season: string | undefined) {
  const player = getSportsPlayers().find((candidate) => candidate.canonical === playerName);
  if (!player || !season) return null;
  if (season.includes(",")) {
    const values = season.split(",");
    const teams = Array.from(new Set(values.map((value) => player.teamsBySeason[value]).filter(Boolean)));
    return teams.length > 0 ? teams.join(", ") : null;
  }
  return player.teamsBySeason[season] ?? null;
}

export function getKnowledgePlayer(playerName: string) {
  const normalized = normalize(playerName);
  return getSportsPlayers().find((candidate) => normalize(candidate.canonical) === normalized || candidate.aliases.some((alias) => normalize(alias) === normalized)) ?? null;
}

export function getSportsKnowledgeSnapshot() {
  return {
    competitions: getSportsCompetitions(),
    teams: getSportsTeams(),
    players: getSportsPlayers()
  };
}

function getSportsCompetitions() {
  const external = loadExternalKnowledge();
  return dedupeByValue([...sportsCompetitions, ...(external.competitions ?? [])], (item) => item.value);
}

function getSportsTeams() {
  const external = loadExternalKnowledge();
  return dedupeByValue([...sportsTeams, ...(external.teams ?? [])], (item) => item.value);
}

function getSportsPlayers() {
  const external = loadExternalKnowledge();
  return dedupeByValue([...sportsPlayers, ...(external.players ?? [])], (player) => player.canonical);
}

function loadExternalKnowledge(): {
  competitions?: SportsCompetitionRecord[];
  teams?: SportsTeamRecord[];
  players?: SportsKnowledgePlayer[];
} {
  const knowledgePath = resolve(process.cwd(), ".data", "sports-knowledge.json");
  if (!existsSync(knowledgePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(knowledgePath, "utf8"));
    return {
      competitions: Array.isArray(parsed.competitions) ? parsed.competitions : undefined,
      teams: Array.isArray(parsed.teams) ? parsed.teams : undefined,
      players: Array.isArray(parsed.players) ? parsed.players : undefined
    };
  } catch {
    return {};
  }
}

function dedupeByValue<T>(items: T[], keyFn: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalize(keyFn(item));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function player(
  id: string,
  canonical: string,
  aliases: string[],
  sport: SportsKnowledgePlayer["sport"],
  league: SportsLeague,
  team: string,
  seasons: string[]
): SportsKnowledgePlayer {
  return {
    id,
    canonical,
    aliases,
    sport,
    league,
    activeSeasons: seasons,
    teamsBySeason: Object.fromEntries(seasons.map((season) => [season, team]))
  };
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}
