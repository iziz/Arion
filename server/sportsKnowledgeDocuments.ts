import type { KnowledgeEvidence, KnowledgeSourceId, SportsKnowledgeSnapshot } from "../shared/types";
import { getSportsKnowledgeSnapshot } from "./sportsKnowledge";

export type SportsKnowledgeDocument = {
  id: string;
  domainGroup: KnowledgeSourceId;
  provider: KnowledgeEvidence["source"];
  kind: KnowledgeEvidence["kind"];
  entityType: KnowledgeEvidence["entityType"];
  entityName: string;
  competition?: string;
  season?: string;
  team?: string;
  matchTime?: string;
  text: string;
  sourceText: string;
};

export type SportsKnowledgeVectorRecord = SportsKnowledgeDocument & {
  vector: number[];
};

export type SportsKnowledgeVectorHit = SportsKnowledgeVectorRecord & {
  score: number;
};

export type BuildKnowledgeDocumentOptions = {
  maxPlayers?: number;
  maxActivities?: number;
  maxFacts?: number;
};

export function buildSportsKnowledgeDocuments(
  snapshot: SportsKnowledgeSnapshot = getSportsKnowledgeSnapshot(),
  options: BuildKnowledgeDocumentOptions = {}
): SportsKnowledgeDocument[] {
  const competitionDocs = snapshot.competitions.map((competition) => {
    const domainGroup = competition.domainGroup ?? domainGroupForLeague(competition.value);
    const sourceText = `Competition ${competition.value} belongs to ${domainGroup}. Aliases: ${competition.aliases.join(", ")}.`;
    return {
      id: `knowledge:competition:${domainGroup}:${slug(competition.value)}`,
      domainGroup,
      provider: "sports_knowledge" as const,
      kind: "competition_scope" as const,
      entityType: "competition" as const,
      entityName: competition.value,
      competition: competition.value,
      text: sourceText,
      sourceText
    };
  });

  const teamDocs = snapshot.teams.map((team) => {
    const domainGroup = team.domainGroup ?? (team.league ? domainGroupForLeague(team.league) : "sports.football");
    const sourceText = `Team ${team.value}${team.league ? ` plays in ${team.league}` : ""}. Aliases: ${team.aliases.join(", ")}.`;
    return {
      id: `knowledge:team:${domainGroup}:${slug(team.league ?? "all")}:${slug(team.value)}`,
      domainGroup,
      provider: "sports_knowledge" as const,
      kind: "team_stat" as const,
      entityType: "team" as const,
      entityName: team.value,
      competition: team.league,
      team: team.value,
      text: sourceText,
      sourceText
    };
  });

  const playerDocs = [...snapshot.players].sort(compareKnowledgePlayers).slice(0, options.maxPlayers ?? snapshot.players.length).map((player) => {
    const seasons = player.activeSeasons.join(", ");
    const teams = unique(Object.values(player.teamsBySeason).filter(Boolean)).join(", ");
    const sourceText = `${player.canonical} is a ${player.sport.replace(/_/g, " ")} player in ${player.league}${teams ? ` for ${teams}` : ""}${player.position ? `, position ${player.position}` : ""}${seasons ? `. Seasons: ${seasons}` : ""}.`;
    return {
      id: `knowledge:player:${domainGroupForSport(player.sport)}:${slug(player.league)}:${slug(player.id)}`,
      domainGroup: domainGroupForSport(player.sport),
      provider: knowledgeSource(player.provider),
      kind: "player_profile" as const,
      entityType: "player" as const,
      entityName: player.canonical,
      competition: player.league,
      season: seasons || undefined,
      team: teams || undefined,
      text: [
        sourceText,
        player.aliases.length ? `Aliases: ${player.aliases.join(", ")}.` : "",
        player.externalIds ? `External ids: ${Object.entries(player.externalIds).map(([key, value]) => `${key}:${value}`).join(", ")}.` : ""
      ].filter(Boolean).join(" "),
      sourceText
    };
  });

  const activityDocs = (snapshot.matchActivities ?? []).slice(0, options.maxActivities ?? snapshot.matchActivities?.length ?? 0).map((activity) => {
    const domainGroup = domainGroupForLeague(activity.competition);
    const sourceText = activity.sourceText || `${activity.player} ${activity.event} for ${activity.team} in ${activity.competition} ${activity.season}.`;
    return {
      id: `knowledge:activity:${domainGroup}:${activity.provider}:${activity.id}`,
      domainGroup,
      provider: knowledgeSource(activity.provider),
      kind: "match_activity" as const,
      entityType: "player" as const,
      entityName: activity.player,
      competition: activity.competition,
      season: activity.season,
      team: activity.team,
      matchTime: activity.minute === null ? undefined : `${activity.minute}'`,
      text: [
        sourceText,
        `Role: ${activity.role}. Event: ${activity.event}. Match: ${activity.homeTeam} vs ${activity.awayTeam}.`
      ].join(" "),
      sourceText
    };
  });

  const factDocs = (snapshot.facts ?? []).slice(0, options.maxFacts ?? snapshot.facts?.length ?? 0).map((fact) => {
    const domainGroup = domainGroupForLeague(fact.competition);
    const sourceText = fact.sourceText || `${fact.entityName} ${fact.metric} in ${fact.competition} ${fact.season}: ${String(fact.value)}.`;
    return {
      id: `knowledge:fact:${domainGroup}:${fact.provider}:${fact.id}`,
      domainGroup,
      provider: knowledgeSource(fact.provider),
      kind: fact.kind === "attendance" ? "attendance" as const : "team_stat" as const,
      entityType: fact.entityType === "country" ? "event" as const : fact.entityType,
      entityName: fact.entityName,
      competition: fact.competition,
      season: fact.season,
      team: fact.team,
      text: [
        sourceText,
        `Metric: ${fact.metric}. Value: ${String(fact.value)}. Kind: ${fact.kind}.`
      ].join(" "),
      sourceText
    };
  });

  return dedupeDocuments([...competitionDocs, ...teamDocs, ...playerDocs, ...factDocs, ...activityDocs]);
}

export function knowledgeVectorHitToEvidence(hit: SportsKnowledgeVectorHit): KnowledgeEvidence {
  return {
    id: `knowledge-vector:${hit.id}`,
    kind: hit.kind,
    entityType: hit.entityType,
    entityName: hit.entityName,
    source: hit.provider,
    confidence: Math.max(0.5, Math.min(0.96, Number((0.62 + hit.score * 0.34).toFixed(3)))),
    evidenceText: hit.sourceText,
    competition: hit.competition,
    season: hit.season,
    team: hit.team,
    matchTime: hit.matchTime
  };
}

function dedupeDocuments(documents: SportsKnowledgeDocument[]) {
  const seen = new Set<string>();
  return documents.filter((document) => {
    if (seen.has(document.id)) return false;
    seen.add(document.id);
    return true;
  });
}

function knowledgeSource(provider: string | undefined): KnowledgeEvidence["source"] {
  if (
    provider === "football-data" ||
    provider === "football-data-uk" ||
    provider === "kaggle" ||
    provider === "statbunker" ||
    provider === "statsbomb" ||
    provider === "nflverse" ||
    provider === "fbref"
  ) return provider;
  return "sports_knowledge";
}

function domainGroupForSport(sport: "football" | "american_football"): KnowledgeSourceId {
  return sport === "american_football" ? "sports.american_football" : "sports.football";
}

function domainGroupForLeague(league: string): KnowledgeSourceId {
  return league === "NFL" ? "sports.american_football" : "sports.football";
}

function unique(items: string[]) {
  return Array.from(new Set(items));
}

function compareKnowledgePlayers(a: SportsKnowledgeSnapshot["players"][number], b: SportsKnowledgeSnapshot["players"][number]) {
  return playerPriority(b) - playerPriority(a) || a.canonical.localeCompare(b.canonical);
}

function playerPriority(player: SportsKnowledgeSnapshot["players"][number]) {
  const seasons = player.activeSeasons.join(" ");
  return [
    player.provider === "local" ? 1000 : 0,
    /2026|2025|2025-26|2024-25/.test(seasons) ? 200 : 0,
    player.position ? 25 : 0,
    Object.keys(player.teamsBySeason).length,
    player.aliases.length
  ].reduce((sum, value) => sum + value, 0);
}

function slug(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
}
