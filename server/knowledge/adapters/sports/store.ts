import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KnowledgeDomainGroup, KnowledgeSnapshot } from "../../../../shared/types";

export type SportsLeague = string;

export type SportsKnowledgePlayer = {
  id: string;
  canonical: string;
  aliases: string[];
  sport: "football" | "american_football";
  league: SportsLeague;
  activeSeasons: string[];
  teamsBySeason: Record<string, string>;
  provider?: "local" | "football-data" | "football-data-uk" | "kaggle" | "statbunker" | "statsbomb" | "nflverse" | "fbref";
  externalIds?: Record<string, string | number>;
  position?: string | null;
  shirtNumber?: number | null;
};

export type SportsKnowledgeMatchActivity = NonNullable<KnowledgeSnapshot["matchActivities"]>[number];
export type SportsKnowledgeFact = NonNullable<KnowledgeSnapshot["facts"]>[number];
export type KnowledgeSnapshotSummaryOptions = {
  maxPlayersPerDomain?: number;
  maxActivitiesPerDomain?: number;
  maxFactsPerDomain?: number;
};

export type KnowledgeMatch<T> = {
  value: T;
  confidence: number;
  source: "knowledge";
  evidence: string[];
};

type SportsCompetitionRecord = { value: SportsLeague; aliases: string[]; domainGroup?: KnowledgeDomainGroup; sport?: SportsKnowledgePlayer["sport"] };
type SportsTeamRecord = { value: string; aliases: string[]; domainGroup?: KnowledgeDomainGroup; league?: SportsLeague };
type ExternalSportsKnowledge = {
  competitions?: SportsCompetitionRecord[];
  teams?: SportsTeamRecord[];
  players?: SportsKnowledgePlayer[];
  matchActivities?: SportsKnowledgeMatchActivity[];
  facts?: SportsKnowledgeFact[];
  deletedPlayerIds?: string[];
  deletedPlayerKeys?: string[];
};

let externalKnowledgeCache: ExternalSportsKnowledge | null = null;
let externalKnowledgeCacheMtimeMs = 0;

export const sportsCompetitions: SportsCompetitionRecord[] = [
  competition("Premier League", ["Premier League", "EPL", "프리미어 리그", "프리미어리그"], "sports.football", "football"),
  competition("NFL", ["NFL", "National Football League", "미식축구", "미국 football"], "sports.american_football", "american_football"),
  competition("Champions League", ["Champions League", "UCL", "챔피언스 리그", "챔피언스리그"], "sports.football", "football"),
  competition("Bundesliga", ["Bundesliga", "분데스리가"], "sports.football", "football")
];

export const sportsTeams: SportsTeamRecord[] = [
  team("Manchester City", ["Manchester City", "Man City"], "sports.football", "Premier League"),
  team("Manchester United", ["Manchester United", "Man United"], "sports.football", "Premier League"),
  team("Arsenal", ["Arsenal"], "sports.football", "Premier League"),
  team("Liverpool", ["Liverpool"], "sports.football", "Premier League"),
  team("Chelsea", ["Chelsea"], "sports.football", "Premier League"),
  team("Tottenham Hotspur", ["Tottenham", "Spurs"], "sports.football", "Premier League"),
  team("Newcastle United", ["Newcastle"], "sports.football", "Premier League"),
  team("Brighton", ["Brighton"], "sports.football", "Premier League"),
  team("Nottingham Forest", ["Nottingham Forest", "Nottingham Forrester"], "sports.football", "Premier League"),
  ...nflTeams()
];

export const sportsPlayers: SportsKnowledgePlayer[] = [
  player("erling-haaland", "Erling Haaland", ["Haaland", "Erling Haaland", "Holland", "홀란", "홀란드", "엘링 홀란"], "football", "Premier League", "Manchester City", ["2022-23", "2023-24", "2024-25", "2025-26"]),
  player("son-heung-min", "Son Heung-min", ["Son Heung-min", "Heung-min Son", "Sonny", "Son", "손흥민", "쏘니"], "football", "Premier League", "Tottenham Hotspur", ["2015-16", "2016-17", "2017-18", "2018-19", "2019-20", "2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]),
  player("mohamed-salah", "Mohamed Salah", ["Mohamed Salah", "Salah", "살라", "모하메드 살라"], "football", "Premier League", "Liverpool", ["2017-18", "2018-19", "2019-20", "2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]),
  player("phil-foden", "Phil Foden", ["Phil Foden", "Foden", "포든", "필 포든"], "football", "Premier League", "Manchester City", ["2017-18", "2018-19", "2019-20", "2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]),
  player("kylian-mbappe", "Kylian Mbappé", ["Kylian Mbappé", "Kylian Mbappe", "Mbappé", "Mbappe", "음바페", "킬리안 음바페"], "football", "Champions League", "Paris Saint-Germain", ["2017-18", "2018-19", "2019-20", "2020-21", "2021-22", "2022-23", "2023-24"]),
  ...nflPlayers()
];

export function matchKnowledgePlayer(text: string): KnowledgeMatch<SportsKnowledgePlayer> | null {
  const normalized = normalize(text);
  for (const candidate of getSportsPlayers()) {
    const alias = candidate.aliases.find((value) => matchesAlias(normalized, value));
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
      const alias = candidate.aliases.find((value) => matchesAlias(normalized, value));
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

export function getKnowledgeSnapshot() {
  const competitions = getSportsCompetitions();
  const teams = getSportsTeams();
  const players = getSportsPlayers();
  const matchActivities = getMatchActivities();
  const facts = getFacts();
  return {
    domains: buildKnowledgeDomains({ competitions, teams, players, matchActivities, facts }),
    competitions,
    teams,
    players,
    matchActivities,
    facts
  };
}

export function getKnowledgeSnapshotSummary(options: KnowledgeSnapshotSummaryOptions = {}): KnowledgeSnapshot {
  const snapshot = getKnowledgeSnapshot();
  const maxPlayersPerDomain = boundedLimit(options.maxPlayersPerDomain, 300);
  const maxActivitiesPerDomain = boundedLimit(options.maxActivitiesPerDomain, 120);
  const maxFactsPerDomain = boundedLimit(options.maxFactsPerDomain, 160);
  return {
    ...snapshot,
    players: limitByDomain(snapshot.players, (player) => domainGroupForSport(player.sport), maxPlayersPerDomain),
    matchActivities: limitByDomain(snapshot.matchActivities ?? [], (activity) => domainGroupForLeague(activity.competition), maxActivitiesPerDomain),
    facts: limitByDomain(snapshot.facts ?? [], (fact) => domainGroupForLeague(fact.competition), maxFactsPerDomain)
  };
}

export function upsertSportsKnowledgePlayer(input: Partial<SportsKnowledgePlayer> & { canonical: string }): KnowledgeSnapshot {
  const external = loadExternalKnowledge();
  const players = external.players ?? [];
  const canonical = input.canonical.trim();
  const sport = input.sport === "american_football" ? "american_football" : "football";
  const league = isSportsLeague(input.league) ? input.league : "Premier League";
  const id = input.id?.trim() || `${domainGroupForSport(sport)}:${league}:${slug(canonical)}`;
  const activeSeasons = input.activeSeasons?.filter(Boolean) ?? [];
  const player: SportsKnowledgePlayer = {
    id,
    canonical,
    aliases: Array.from(new Set([canonical, ...(input.aliases ?? [])].map((alias) => alias.trim()).filter(Boolean))),
    sport,
    league,
    activeSeasons,
    teamsBySeason: input.teamsBySeason ?? Object.fromEntries(activeSeasons.map((season) => [season, ""])),
    provider: input.provider ?? "local",
    externalIds: input.externalIds,
    position: input.position ?? null,
    shirtNumber: typeof input.shirtNumber === "number" && Number.isFinite(input.shirtNumber) ? input.shirtNumber : null
  };
  const key = playerMergeKey(player);
  const next = {
    ...external,
    deletedPlayerIds: (external.deletedPlayerIds ?? []).filter((item) => item !== id),
    deletedPlayerKeys: (external.deletedPlayerKeys ?? []).filter((item) => item !== key),
    players: [...players.filter((item) => item.id !== id && playerMergeKey(item) !== key), player]
  };
  writeExternalKnowledge(next);
  return getKnowledgeSnapshot();
}

export function deleteSportsKnowledgePlayer(id: string): KnowledgeSnapshot {
  const external = loadExternalKnowledge();
  const players = [...(external.players ?? []), ...sportsPlayers].filter((player) => player.id === id);
  const deletedPlayerKeys = Array.from(new Set([...(external.deletedPlayerKeys ?? []), ...players.map(playerMergeKey)]));
  const deletedPlayerIds = players.length > 0 ? external.deletedPlayerIds : Array.from(new Set([...(external.deletedPlayerIds ?? []), id].filter(Boolean)));
  const next = {
    ...external,
    deletedPlayerKeys,
    deletedPlayerIds,
    players: (external.players ?? []).filter((player) => (players.length > 0 ? !deletedPlayerKeys.includes(playerMergeKey(player)) : player.id !== id))
  };
  writeExternalKnowledge(next);
  return getKnowledgeSnapshot();
}

export function mergeSportsKnowledge(input: {
  competitions?: SportsCompetitionRecord[];
  teams?: SportsTeamRecord[];
  players?: SportsKnowledgePlayer[];
  matchActivities?: SportsKnowledgeMatchActivity[];
  facts?: SportsKnowledgeFact[];
}, options: {
  replaceProviders?: Array<NonNullable<SportsKnowledgePlayer["provider"]>>;
  replaceDomainGroups?: KnowledgeDomainGroup[];
} = {}): KnowledgeSnapshot {
  const external = loadExternalKnowledge();
  const replaceProviders = new Set(options.replaceProviders ?? []);
  const replaceDomainGroups = new Set(options.replaceDomainGroups ?? []);
  const externalPlayers = replaceProviders.size > 0 ? (external.players ?? []).filter((item) => !shouldReplaceProviderRecord(item.provider, domainGroupForSport(item.sport), replaceProviders, replaceDomainGroups)) : external.players ?? [];
  const externalActivities = replaceProviders.size > 0 ? (external.matchActivities ?? []).filter((item) => !shouldReplaceProviderRecord(item.provider, domainGroupForLeague(item.competition), replaceProviders, replaceDomainGroups)) : external.matchActivities ?? [];
  const externalFacts = replaceProviders.size > 0 ? (external.facts ?? []).filter((item) => !shouldReplaceProviderRecord(item.provider, domainGroupForLeague(item.competition), replaceProviders, replaceDomainGroups)) : external.facts ?? [];
  const competitions = [...(input.competitions ?? []), ...(external.competitions ?? [])].map(normalizeCompetitionRecord);
  const teams = [...(input.teams ?? []), ...(external.teams ?? [])].map(normalizeTeamRecord);
  const next = {
    competitions: dedupeByValue(competitions, competitionMergeKey),
    teams: dedupeByValue(teams, teamMergeKey),
    players: mergePlayers([...(input.players ?? []), ...externalPlayers]),
    matchActivities: dedupeByValue([...(input.matchActivities ?? []), ...externalActivities], activityMergeKey),
    facts: dedupeByValue([...(input.facts ?? []), ...externalFacts], factMergeKey),
    deletedPlayerIds: external.deletedPlayerIds,
    deletedPlayerKeys: external.deletedPlayerKeys
  };
  writeExternalKnowledge(next);
  return getKnowledgeSnapshot();
}

function getSportsCompetitions() {
  const external = loadExternalKnowledge();
  return dedupeByValue([...(external.competitions ?? []), ...sportsCompetitions].map(normalizeCompetitionRecord), competitionMergeKey);
}

function getSportsTeams() {
  const external = loadExternalKnowledge();
  return dedupeByValue([...(external.teams ?? []), ...sportsTeams].map(normalizeTeamRecord), teamMergeKey);
}

function getSportsPlayers() {
  const external = loadExternalKnowledge();
  const deleted = new Set(external.deletedPlayerIds ?? []);
  const deletedKeys = new Set(external.deletedPlayerKeys ?? []);
  return mergePlayers([...(external.players ?? []), ...sportsPlayers]).filter((player) => !deleted.has(player.id) && !deletedKeys.has(playerMergeKey(player)));
}

function getMatchActivities() {
  const external = loadExternalKnowledge();
  return external.matchActivities ?? [];
}

function getFacts() {
  const external = loadExternalKnowledge();
  return external.facts ?? [];
}

function buildKnowledgeDomains({
  competitions,
  teams,
  players,
  matchActivities,
  facts
}: {
  competitions: SportsCompetitionRecord[];
  teams: SportsTeamRecord[];
  players: SportsKnowledgePlayer[];
  matchActivities: SportsKnowledgeMatchActivity[];
  facts: SportsKnowledgeFact[];
}): KnowledgeSnapshot["domains"] {
  return [
    { id: "sports.football" as const, label: "Football", sport: "football" as const },
    { id: "sports.american_football" as const, label: "American football", sport: "american_football" as const }
  ].map((domain) => ({
    ...domain,
    competitions: competitions.filter((competition) => domainGroupForLeague(competition.value) === domain.id).map((competition) => competition.value),
    teams: teams.filter((item) => domainGroupForTeam(item) === domain.id).length,
    players: players.filter((player) => domainGroupForSport(player.sport) === domain.id).length,
    matchActivities: matchActivities.filter((activity) => domainGroupForLeague(activity.competition) === domain.id).length,
    facts: facts.filter((fact) => domainGroupForLeague(fact.competition) === domain.id).length
  }));
}

function boundedLimit(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(2000, Math.floor(value as number)));
}

function limitByDomain<T>(items: T[], domainFn: (item: T) => KnowledgeDomainGroup, limit: number) {
  if (limit === 0) return [];
  const counts = new Map<KnowledgeDomainGroup, number>();
  return items.filter((item) => {
    const domain = domainFn(item);
    const count = counts.get(domain) ?? 0;
    if (count >= limit) return false;
    counts.set(domain, count + 1);
    return true;
  });
}

function normalizeCompetitionRecord(record: SportsCompetitionRecord): SportsCompetitionRecord {
  const domainGroup = record.domainGroup ?? domainGroupForLeague(record.value);
  return {
    ...record,
    domainGroup,
    sport: record.sport ?? sportForDomain(domainGroup)
  };
}

function normalizeTeamRecord(record: SportsTeamRecord): SportsTeamRecord {
  const domainGroup = record.domainGroup ?? (record.league ? domainGroupForLeague(record.league) : "sports.football");
  return {
    ...record,
    domainGroup
  };
}

function domainGroupForTeam(record: SportsTeamRecord): KnowledgeDomainGroup {
  return record.domainGroup ?? (record.league ? domainGroupForLeague(record.league) : "sports.football");
}

function domainGroupForLeague(league: string): KnowledgeDomainGroup {
  return league === "NFL" ? "sports.american_football" : "sports.football";
}

function domainGroupForSport(sport: SportsKnowledgePlayer["sport"]): KnowledgeDomainGroup {
  return sport === "american_football" ? "sports.american_football" : "sports.football";
}

function sportForDomain(domainGroup: KnowledgeDomainGroup): SportsKnowledgePlayer["sport"] {
  return domainGroup === "sports.american_football" ? "american_football" : "football";
}

function competitionMergeKey(record: SportsCompetitionRecord) {
  const domainGroup = record.domainGroup ?? domainGroupForLeague(record.value);
  return `${domainGroup}:${record.value}`;
}

function teamMergeKey(record: SportsTeamRecord) {
  return `${domainGroupForTeam(record)}:${record.league ?? "all"}:${record.value}`;
}

function activityMergeKey(activity: SportsKnowledgeMatchActivity) {
  return `${domainGroupForLeague(activity.competition)}:${activity.competition}:${activity.provider}:${activity.id}`;
}

function factMergeKey(fact: SportsKnowledgeFact) {
  return `${domainGroupForLeague(fact.competition)}:${fact.competition}:${fact.provider}:${fact.id}`;
}

function shouldReplaceProviderRecord(
  provider: SportsKnowledgePlayer["provider"] | SportsKnowledgeMatchActivity["provider"] | SportsKnowledgeFact["provider"] | undefined,
  domainGroup: KnowledgeDomainGroup,
  replaceProviders: Set<NonNullable<SportsKnowledgePlayer["provider"]>>,
  replaceDomainGroups: Set<KnowledgeDomainGroup>
) {
  if (!provider || !replaceProviders.has(provider)) return false;
  return replaceDomainGroups.size === 0 || replaceDomainGroups.has(domainGroup);
}

function loadExternalKnowledge(): ExternalSportsKnowledge {
  const knowledgePath = resolve(process.cwd(), ".data", "sports-knowledge.json");
  if (!existsSync(knowledgePath)) {
    externalKnowledgeCache = {};
    externalKnowledgeCacheMtimeMs = 0;
    return externalKnowledgeCache;
  }
  const mtimeMs = statSync(knowledgePath).mtimeMs;
  if (externalKnowledgeCache && externalKnowledgeCacheMtimeMs === mtimeMs) return externalKnowledgeCache;
  try {
    const parsed = JSON.parse(readFileSync(knowledgePath, "utf8"));
    externalKnowledgeCache = {
      competitions: Array.isArray(parsed.competitions) ? parsed.competitions : undefined,
      teams: Array.isArray(parsed.teams) ? parsed.teams : undefined,
      players: Array.isArray(parsed.players) ? parsed.players : undefined,
      matchActivities: Array.isArray(parsed.matchActivities) ? parsed.matchActivities : undefined,
      facts: Array.isArray(parsed.facts) ? parsed.facts : undefined,
      deletedPlayerIds: Array.isArray(parsed.deletedPlayerIds) ? parsed.deletedPlayerIds.filter((item: unknown): item is string => typeof item === "string") : undefined,
      deletedPlayerKeys: Array.isArray(parsed.deletedPlayerKeys) ? parsed.deletedPlayerKeys.filter((item: unknown): item is string => typeof item === "string") : undefined
    };
    externalKnowledgeCacheMtimeMs = mtimeMs;
    return externalKnowledgeCache;
  } catch {
    externalKnowledgeCache = {};
    externalKnowledgeCacheMtimeMs = mtimeMs;
    return externalKnowledgeCache;
  }
}

function writeExternalKnowledge(value: ExternalSportsKnowledge) {
  const knowledgePath = resolve(process.cwd(), ".data", "sports-knowledge.json");
  mkdirSync(resolve(process.cwd(), ".data"), { recursive: true });
  externalKnowledgeCache = value;
  writeFileSync(knowledgePath, JSON.stringify(value, null, 2));
  externalKnowledgeCacheMtimeMs = statSync(knowledgePath).mtimeMs;
}

function isSportsLeague(value: unknown): value is SportsLeague {
  return typeof value === "string" && value.trim().length > 0;
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

function mergePlayers(players: SportsKnowledgePlayer[]) {
  const byDomainCanonical = new Map<string, SportsKnowledgePlayer>();
  for (const player of players) {
    const key = playerMergeKey(player);
    const existing = byDomainCanonical.get(key);
    if (!existing) {
      byDomainCanonical.set(key, player);
      continue;
    }
    const activeSeasons = Array.from(new Set([...existing.activeSeasons, ...player.activeSeasons]));
    byDomainCanonical.set(key, {
      ...existing,
      aliases: Array.from(new Set([...existing.aliases, ...player.aliases])),
      activeSeasons,
      teamsBySeason: { ...player.teamsBySeason, ...existing.teamsBySeason },
      provider: existing.provider ?? player.provider,
      externalIds: { ...(player.externalIds ?? {}), ...(existing.externalIds ?? {}) },
      position: existing.position ?? player.position,
      shirtNumber: existing.shirtNumber ?? player.shirtNumber
    });
  }
  return Array.from(byDomainCanonical.values());
}

function playerMergeKey(player: SportsKnowledgePlayer) {
  return `${domainGroupForSport(player.sport)}:${player.league}:${normalize(player.canonical)}`;
}

function competition(value: SportsLeague, aliases: string[], domainGroup: KnowledgeDomainGroup, sport: SportsKnowledgePlayer["sport"]): SportsCompetitionRecord {
  return { value, aliases, domainGroup, sport };
}

function team(value: string, aliases: string[], domainGroup: KnowledgeDomainGroup, league: SportsLeague): SportsTeamRecord {
  return { value, aliases, domainGroup, league };
}

function nflTeams(): SportsTeamRecord[] {
  return [
    team("Arizona Cardinals", ["Arizona Cardinals", "Cardinals", "ARI"], "sports.american_football", "NFL"),
    team("Atlanta Falcons", ["Atlanta Falcons", "Falcons", "ATL"], "sports.american_football", "NFL"),
    team("Baltimore Ravens", ["Baltimore Ravens", "Ravens", "BAL"], "sports.american_football", "NFL"),
    team("Buffalo Bills", ["Buffalo Bills", "Bills", "BUF"], "sports.american_football", "NFL"),
    team("Carolina Panthers", ["Carolina Panthers", "Panthers", "CAR"], "sports.american_football", "NFL"),
    team("Chicago Bears", ["Chicago Bears", "Bears", "CHI"], "sports.american_football", "NFL"),
    team("Cincinnati Bengals", ["Cincinnati Bengals", "Bengals", "CIN"], "sports.american_football", "NFL"),
    team("Cleveland Browns", ["Cleveland Browns", "Browns", "CLE"], "sports.american_football", "NFL"),
    team("Dallas Cowboys", ["Dallas Cowboys", "Cowboys", "DAL"], "sports.american_football", "NFL"),
    team("Denver Broncos", ["Denver Broncos", "Broncos", "DEN"], "sports.american_football", "NFL"),
    team("Detroit Lions", ["Detroit Lions", "Lions", "DET"], "sports.american_football", "NFL"),
    team("Green Bay Packers", ["Green Bay Packers", "Packers", "GB"], "sports.american_football", "NFL"),
    team("Houston Texans", ["Houston Texans", "Texans", "HOU"], "sports.american_football", "NFL"),
    team("Indianapolis Colts", ["Indianapolis Colts", "Colts", "IND"], "sports.american_football", "NFL"),
    team("Jacksonville Jaguars", ["Jacksonville Jaguars", "Jaguars", "Jags", "JAX"], "sports.american_football", "NFL"),
    team("Kansas City Chiefs", ["Kansas City Chiefs", "Chiefs", "KC"], "sports.american_football", "NFL"),
    team("Las Vegas Raiders", ["Las Vegas Raiders", "Raiders", "LV"], "sports.american_football", "NFL"),
    team("Los Angeles Chargers", ["Los Angeles Chargers", "Chargers", "LA Chargers", "LAC"], "sports.american_football", "NFL"),
    team("Los Angeles Rams", ["Los Angeles Rams", "Rams", "LA Rams", "LAR"], "sports.american_football", "NFL"),
    team("Miami Dolphins", ["Miami Dolphins", "Dolphins", "MIA"], "sports.american_football", "NFL"),
    team("Minnesota Vikings", ["Minnesota Vikings", "Vikings", "MIN"], "sports.american_football", "NFL"),
    team("New England Patriots", ["New England Patriots", "Patriots", "NE"], "sports.american_football", "NFL"),
    team("New Orleans Saints", ["New Orleans Saints", "Saints", "NO"], "sports.american_football", "NFL"),
    team("New York Giants", ["New York Giants", "Giants", "NYG"], "sports.american_football", "NFL"),
    team("New York Jets", ["New York Jets", "Jets", "NYJ"], "sports.american_football", "NFL"),
    team("Philadelphia Eagles", ["Philadelphia Eagles", "Eagles", "PHI"], "sports.american_football", "NFL"),
    team("Pittsburgh Steelers", ["Pittsburgh Steelers", "Steelers", "PIT"], "sports.american_football", "NFL"),
    team("San Francisco 49ers", ["San Francisco 49ers", "49ers", "Niners", "SF"], "sports.american_football", "NFL"),
    team("Seattle Seahawks", ["Seattle Seahawks", "Seahawks", "SEA"], "sports.american_football", "NFL"),
    team("Tampa Bay Buccaneers", ["Tampa Bay Buccaneers", "Buccaneers", "Bucs", "TB"], "sports.american_football", "NFL"),
    team("Tennessee Titans", ["Tennessee Titans", "Titans", "TEN"], "sports.american_football", "NFL"),
    team("Washington Commanders", ["Washington Commanders", "Commanders", "WAS"], "sports.american_football", "NFL")
  ];
}

function nflPlayers(): SportsKnowledgePlayer[] {
  const seasons = ["2022", "2023", "2024", "2025"];
  return [
    nflPlayer("patrick-mahomes", "Patrick Mahomes", ["Patrick Mahomes", "Mahomes", "P. Mahomes"], "Kansas City Chiefs", ["2017", "2018", "2019", "2020", "2021", ...seasons], "QB", 15),
    nflPlayer("brock-purdy", "Brock Purdy", ["Brock Purdy", "Purdy", "B. Purdy"], "San Francisco 49ers", ["2022", "2023", "2024", "2025"], "QB", 13),
    nflPlayer("jalen-hurts", "Jalen Hurts", ["Jalen Hurts", "Hurts", "J. Hurts"], "Philadelphia Eagles", ["2020", "2021", ...seasons], "QB", 1),
    nflPlayer("josh-allen", "Josh Allen", ["Josh Allen", "Allen", "J. Allen"], "Buffalo Bills", ["2018", "2019", "2020", "2021", ...seasons], "QB", 17),
    nflPlayer("lamar-jackson", "Lamar Jackson", ["Lamar Jackson", "L. Jackson"], "Baltimore Ravens", ["2018", "2019", "2020", "2021", ...seasons], "QB", 8),
    nflPlayer("joe-burrow", "Joe Burrow", ["Joe Burrow", "Burrow", "J. Burrow"], "Cincinnati Bengals", ["2020", "2021", ...seasons], "QB", 9),
    nflPlayer("dak-prescott", "Dak Prescott", ["Dak Prescott", "Prescott", "D. Prescott"], "Dallas Cowboys", ["2016", "2017", "2018", "2019", "2020", "2021", ...seasons], "QB", 4),
    nflPlayer("justin-herbert", "Justin Herbert", ["Justin Herbert", "Herbert", "J. Herbert"], "Los Angeles Chargers", ["2020", "2021", ...seasons], "QB", 10),
    nflPlayer("cj-stroud", "C.J. Stroud", ["C.J. Stroud", "CJ Stroud", "Stroud"], "Houston Texans", ["2023", "2024", "2025"], "QB", 7),
    nflPlayer("jared-goff", "Jared Goff", ["Jared Goff", "Goff", "J. Goff"], "Detroit Lions", ["2021", ...seasons], "QB", 16),
    nflPlayer("jordan-love", "Jordan Love", ["Jordan Love", "Love", "J. Love"], "Green Bay Packers", ["2020", "2021", ...seasons], "QB", 10),
    nflPlayer("caleb-williams", "Caleb Williams", ["Caleb Williams", "C. Williams"], "Chicago Bears", ["2024", "2025"], "QB", 18),
    nflPlayer("jayden-daniels", "Jayden Daniels", ["Jayden Daniels", "J. Daniels"], "Washington Commanders", ["2024", "2025"], "QB", 5),
    nflPlayer("saquon-barkley", "Saquon Barkley", ["Saquon Barkley", "Barkley", "S. Barkley"], "Philadelphia Eagles", ["2024", "2025"], "RB", 26),
    nflPlayer("christian-mccaffrey", "Christian McCaffrey", ["Christian McCaffrey", "McCaffrey", "CMC"], "San Francisco 49ers", ["2022", "2023", "2024", "2025"], "RB", 23),
    nflPlayer("travis-kelce", "Travis Kelce", ["Travis Kelce", "Kelce", "T. Kelce"], "Kansas City Chiefs", ["2013", "2014", "2015", "2016", "2017", "2018", "2019", "2020", "2021", ...seasons], "TE", 87),
    nflPlayer("justin-jefferson", "Justin Jefferson", ["Justin Jefferson", "Jefferson", "J. Jefferson"], "Minnesota Vikings", ["2020", "2021", ...seasons], "WR", 18),
    nflPlayer("tyreek-hill", "Tyreek Hill", ["Tyreek Hill", "Hill", "T. Hill"], "Miami Dolphins", ["2022", "2023", "2024", "2025"], "WR", 10)
  ];
}

function nflPlayer(
  id: string,
  canonical: string,
  aliases: string[],
  teamName: string,
  seasons: string[],
  position: string,
  shirtNumber: number
): SportsKnowledgePlayer {
  return {
    ...player(id, canonical, aliases, "american_football", "NFL", teamName, seasons),
    position,
    shirtNumber
  };
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

function slug(value: string) {
  return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function matchesAlias(normalizedText: string, alias: string) {
  const normalizedAlias = normalize(alias);
  if (!normalizedAlias) return false;
  if (/^[a-z0-9\s-]+$/.test(normalizedAlias)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedAlias)}($|[^a-z0-9])`, "i").test(normalizedText);
  }
  return normalizedText.includes(normalizedAlias);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
