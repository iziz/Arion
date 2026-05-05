import type { AssetRecord, DomainQueryPlan, DomainSearchFilters, KnowledgeEvidence, PlayerIdentity } from "../shared/types";
import { trustedDomainEvents } from "./evidenceTrust";
import { getKnowledgePlayer, getKnowledgeSnapshot, matchKnowledgePlayer } from "./knowledge/registry";

export type GroundedQuery = {
  filters: DomainSearchFilters;
  semanticQuery: string;
  evidence: KnowledgeEvidence[];
  evidenceSummary: string;
};

export function groundQueryWithKnowledge(queryPlan: DomainQueryPlan, assets: AssetRecord[]): GroundedQuery {
  const rawEvidence = [
    ...groundCompetition(queryPlan),
    ...groundPlayers(queryPlan),
    ...groundMatchActivities(queryPlan),
    ...groundFacts(queryPlan),
    ...groundVideoScope(queryPlan, assets)
  ];
  const evidence = rankKnowledgeEvidence(queryPlan, dedupeEvidence(rawEvidence)).slice(0, 80);
  const semanticTerms = buildSemanticTerms(queryPlan, evidence);
  return {
    filters: queryPlan.domainFilters,
    semanticQuery: semanticTerms.join(" "),
    evidence,
    evidenceSummary: summarizeEvidence(evidence)
  };
}

function groundFacts(queryPlan: DomainQueryPlan): KnowledgeEvidence[] {
  const snapshot = getKnowledgeSnapshot();
  const requestedCompetition = queryPlan.domainFilters.competition;
  const requestedSeason = queryPlan.domainFilters.season;
  const wantsStructuredStats = Boolean(queryPlan.intent.metric || queryPlan.intent.statMode || queryPlan.responseMode === "structured_answer");
  if (!requestedCompetition && !requestedSeason && !wantsStructuredStats) return [];

  return (snapshot.facts ?? [])
    .filter((fact) => {
      if (requestedCompetition && fact.competition !== requestedCompetition) return false;
      if (requestedSeason && !seasonMatches([fact.season], requestedSeason)) return false;
      if (wantsStructuredStats) return true;
      return Boolean(requestedCompetition || requestedSeason);
    })
    .slice(0, 30)
    .map((fact) => ({
      id: `knowledge:fact:${fact.id}`,
      kind: fact.kind === "attendance" ? "attendance" as const : "team_stat" as const,
      entityType: fact.entityType === "country" ? "event" as const : fact.entityType,
      entityName: fact.entityName,
      source: knowledgeSource(fact.provider),
      confidence: 0.76,
      evidenceText: fact.sourceText,
      competition: fact.competition,
      season: fact.season,
      team: fact.team,
      matchTime: undefined
    }));
}

export function knowledgeEvidenceForNames(evidence: KnowledgeEvidence[], names: string[]) {
  const normalized = new Set(names.map(normalize));
  return evidence.filter((item) => item.entityType !== "player" || normalized.has(normalize(item.entityName)));
}

function groundCompetition(queryPlan: DomainQueryPlan): KnowledgeEvidence[] {
  const competition = queryPlan.domainFilters.competition;
  if (!competition) return [];
  return [
    {
      id: `knowledge:competition:${slug(competition)}`,
      kind: "competition_scope",
      entityType: "competition",
      entityName: competition,
      source: "sports_knowledge",
      confidence: 0.9,
      evidenceText: `Competition scope resolved from related knowledge: ${competition}.`,
      competition
    }
  ];
}

function groundPlayers(queryPlan: DomainQueryPlan): KnowledgeEvidence[] {
  const snapshot = getKnowledgeSnapshot();
  const requestedPlayer = resolvePlannedPlayer(queryPlan);
  const requestedCompetition = queryPlan.domainFilters.competition;
  const requestedSeason = queryPlan.domainFilters.season;
  const candidates = snapshot.players.filter((player) => {
    if (requestedPlayer && normalize(player.canonical) !== normalize(requestedPlayer) && !player.aliases.some((alias) => normalize(alias) === normalize(requestedPlayer))) {
      return false;
    }
    if (requestedCompetition && player.league !== requestedCompetition) return false;
    if (!requestedPlayer && requestedSeason && !seasonMatches(player.activeSeasons, requestedSeason)) return false;
    if (!requestedPlayer && !requestedCompetition && !requestedSeason) return false;
    return true;
  }).slice(0, 250);

  return candidates.flatMap((player) => {
    const seasons = requestedSeason ? player.activeSeasons.filter((season) => seasonMatches([season], requestedSeason)) : player.activeSeasons;
    const seasonText = seasons.length > 0 ? seasons.join(", ") : "known seasons";
    const teams = unique(seasons.map((season) => player.teamsBySeason[season]).filter(Boolean));
    const teamText = teams.length > 0 ? teams.join(", ") : unique(Object.values(player.teamsBySeason).filter(Boolean)).join(", ");
    return [
      {
        id: `knowledge:player:${player.id}`,
        kind: "player_profile" as const,
        entityType: "player" as const,
        entityName: player.canonical,
        source: knowledgeSource(player.provider),
        confidence: requestedPlayer ? 0.94 : 0.78,
        evidenceText: `${player.canonical} is indexed in related knowledge for ${player.league}${teamText ? ` with ${teamText}` : ""}.`,
        competition: player.league,
        season: requestedSeason,
        team: teamText || undefined
      },
      {
        id: `knowledge:roster:${player.id}:${slug(requestedSeason ?? "all")}`,
        kind: "roster" as const,
        entityType: "player" as const,
        entityName: player.canonical,
        source: knowledgeSource(player.provider),
        confidence: requestedSeason ? 0.86 : 0.74,
        evidenceText: `${player.canonical} roster coverage includes ${seasonText}.`,
        competition: player.league,
        season: requestedSeason,
        team: teamText || undefined
      }
    ];
  });
}

function resolvePlannedPlayer(queryPlan: DomainQueryPlan) {
  const direct = queryPlan.domainFilters.player ?? queryPlan.intent.player ?? undefined;
  if (direct) return direct;
  const analysisSubject = queryPlan.intent.analysisSubject;
  if (analysisSubject) {
    const player = getKnowledgePlayer(analysisSubject);
    if (player) return player.canonical;
  }
  const plannedText = [
    queryPlan.retrieval?.evidenceTerms.join(" "),
    queryPlan.semanticQuery,
    queryPlan.rewrittenQuery
  ].filter(Boolean).join(" ");
  return matchKnowledgePlayer(plannedText)?.value.canonical;
}

function groundMatchActivities(queryPlan: DomainQueryPlan): KnowledgeEvidence[] {
  const snapshot = getKnowledgeSnapshot();
  const requestedPlayer = queryPlan.domainFilters.player;
  const requestedCompetition = queryPlan.domainFilters.competition;
  const requestedSeason = queryPlan.domainFilters.season;
  if (!requestedPlayer && !requestedCompetition && !requestedSeason) return [];

  return (snapshot.matchActivities ?? [])
    .filter((activity) => {
      if (requestedPlayer && normalize(activity.player) !== normalize(requestedPlayer)) return false;
      if (requestedCompetition && activity.competition !== requestedCompetition) return false;
      if (requestedSeason && !seasonMatches([activity.season], requestedSeason)) return false;
      return true;
    })
    .slice(0, 80)
    .map((activity) => ({
      id: `knowledge:activity:${activity.id}`,
      kind: "match_activity" as const,
      entityType: "player" as const,
      entityName: activity.player,
      source: knowledgeSource(activity.provider),
      confidence: activity.minute === null ? 0.82 : 0.88,
      evidenceText: activity.sourceText,
      competition: activity.competition,
      season: activity.season,
      team: activity.team,
      matchTime: activity.minute === null ? undefined : `${activity.minute}'`
    }));
}

function groundVideoScope(queryPlan: DomainQueryPlan, assets: AssetRecord[]): KnowledgeEvidence[] {
  if (!isPlayerInventoryPlan(queryPlan) && !queryPlan.domainFilters.player && !queryPlan.intent.player) return [];

  const evidence: KnowledgeEvidence[] = [];
  for (const asset of assets) {
    for (const segment of asset.timeline) {
      const players = new Map<string, { name: string; confidence: number; evidence: string[] }>();
      const addPlayer = (name: string | null | undefined, confidence: number, playerEvidence: string[]) => {
        if (!name) return;
        const existing = players.get(name);
        if (!existing || confidence > existing.confidence) players.set(name, { name, confidence, evidence: playerEvidence });
      };
      for (const player of segment.domain?.scope?.players ?? []) {
        addPlayer(player.value, player.confidence, player.evidence);
      }
      for (const event of trustedDomainEvents(segment)) {
        addIdentity(players, event.football?.receivingPlayer.identity);
        addIdentity(players, event.football?.passingPlayer.identity);
        addIdentity(players, event.americanFootball?.quarterback.identity);
      }
      for (const player of players.values()) {
        evidence.push({
          id: `video:${asset.id}:${segment.id}:player:${slug(player.name)}`,
          kind: "video_scope",
          entityType: "player",
          entityName: player.name,
          source: "video_index",
          confidence: player.confidence,
          evidenceText: `Video index links ${player.name} to ${asset.title} at ${formatTime(segment.start)}-${formatTime(segment.end)}.`,
          assetId: asset.id,
          segmentId: segment.id,
          matchTime: `${formatTime(segment.start)}-${formatTime(segment.end)}`
        });
      }
    }
  }
  return dedupeEvidence(evidence);
}

function addIdentity(players: Map<string, { name: string; confidence: number; evidence: string[] }>, identity: PlayerIdentity | null | undefined) {
  if (!identity?.name) return;
  const existing = players.get(identity.name);
  if (!existing || identity.confidence > existing.confidence) {
    players.set(identity.name, {
      name: identity.name,
      confidence: identity.confidence,
      evidence: identity.evidence
    });
  }
}

function rankKnowledgeEvidence(queryPlan: DomainQueryPlan, evidence: KnowledgeEvidence[]) {
  const queryText = normalize(plannedEvidenceText(queryPlan));
  const terms = queryTerms(queryText);
  const filters = queryPlan.domainFilters;
  return evidence
    .map((item) => ({ item, score: scoreKnowledgeEvidence(item, queryText, terms, filters) }))
    .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence)
    .map((entry) => entry.item);
}

function plannedEvidenceText(queryPlan: DomainQueryPlan) {
  return [
    queryPlan.semanticQuery,
    queryPlan.rewrittenQuery,
    queryPlan.intent.analysisSubject,
    queryPlan.intent.player,
    queryPlan.intent.metric,
    queryPlan.intent.statMode,
    queryPlan.retrieval?.evidenceTerms.join(" ")
  ].filter(Boolean).join(" ");
}

function isPlayerInventoryPlan(queryPlan: DomainQueryPlan) {
  return queryPlan.route === "asset_catalog" || queryPlan.responseMode === "asset_lookup";
}

function scoreKnowledgeEvidence(item: KnowledgeEvidence, queryText: string, terms: string[], filters: DomainSearchFilters) {
  const evidenceText = normalize([item.entityName, item.evidenceText, item.team, item.competition, item.season, item.matchTime].filter(Boolean).join(" "));
  let score = item.confidence;
  if (filters.player && normalize(item.entityName) === normalize(filters.player)) score += 5;
  if (filters.competition && item.competition === filters.competition) score += 3;
  if (filters.season && item.season && seasonMatches([item.season], filters.season)) score += 3;
  if (item.team && queryText.includes(normalize(item.team))) score += 3;
  if (item.entityName && queryText.includes(normalize(item.entityName))) score += 3;
  if (item.kind === "match_activity" && /(minute|time|activity|event|시간|분|활동|기록|이벤트)/.test(queryText)) score += 2;
  if ((item.kind === "roster" || item.kind === "player_profile") && /(roster|lineup|squad|player|선수|명단|출전|스쿼드)/.test(queryText)) score += 2;
  if ((item.kind === "team_stat" || item.kind === "attendance") && /(table|standing|stat|points|goals|touchdowns?|passing|rushing|receiving|sacks?|interceptions?|attendance|순위|통계|승점|득점|실점|관중|터치다운|야드)/.test(queryText)) score += 2;
  score += terms.reduce((sum, term) => sum + (evidenceText.includes(term) ? 0.35 : 0), 0);
  if (item.source === "video_index") score += 0.4;
  return Number(score.toFixed(3));
}

function buildSemanticTerms(queryPlan: DomainQueryPlan, evidence: KnowledgeEvidence[]) {
  const selected = evidence.slice(0, 30);
  const entityTerms = unique(selected.flatMap((item) => [item.entityName, item.team, item.competition, item.season].filter(Boolean) as string[]));
  const evidenceText = selected
    .slice(0, 12)
    .map((item) => item.evidenceText)
    .join(" ");
  return unique([queryPlan.semanticQuery, ...entityTerms, evidenceText].filter(Boolean)).join(" ").split(/\s+/).slice(0, 160);
}

function summarizeEvidence(evidence: KnowledgeEvidence[]) {
  if (evidence.length === 0) return "No structured knowledge evidence selected.";
  const counts = evidence.reduce<Record<string, number>>((accumulator, item) => {
    accumulator[item.kind] = (accumulator[item.kind] ?? 0) + 1;
    return accumulator;
  }, {});
  return Object.entries(counts)
    .map(([kind, count]) => `${kind}:${count}`)
    .join(", ");
}

function seasonMatches(activeSeasons: string[], requested: string) {
  const requestedValues = requested.split(",").map((item) => item.trim()).filter(Boolean);
  if (requestedValues.length === 0) return true;
  return requestedValues.some((season) => activeSeasons.includes(season));
}

function dedupeEvidence(items: KnowledgeEvidence[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function queryTerms(input: string) {
  return unique(
    input
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .map((term) => term.trim().replace(/^-+|-+$/g, ""))
      .filter((term) => (/[가-힣]/.test(term) ? term.length >= 2 : term.length > 2))
  ).slice(0, 40);
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

function slug(value: string) {
  return normalize(value).replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
}

function formatTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
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
