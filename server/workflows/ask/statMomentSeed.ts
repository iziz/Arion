import type { AssetRecord, DomainQueryPlan, DomainSearchFilters, IndexRecord, SportsDomainGroup, SportsKnowledgeAnswer } from "../../../shared/types";
import { isMomentSearchQuery, isStatLeaderboardQuery } from "../../queryPlanner";
import { trustedDomainEvents } from "../../evidenceTrust";

type IndexedPlayerSeed = {
  player: string;
  confidence: number;
  evidence: string[];
  role: "quarterback" | "player";
};

export function applyScopeDomainDefaults(
  explicitFilters: DomainSearchFilters,
  scope: { indexId?: string; domainGroup?: SportsDomainGroup },
  indexes: IndexRecord[]
) {
  const selectedIndex = scope.indexId ? indexes.find((index) => index.id === scope.indexId) : null;
  const groups = scope.domainGroup ? [scope.domainGroup] : selectedIndex?.domainIndexing?.groups ?? [];
  if (groups.includes("sports.american_football") && explicitFilters.competition !== "NFL") {
    return { ...explicitFilters, competition: "NFL" };
  }
  if (groups.includes("sports.football") && explicitFilters.competition === "NFL") {
    const next = { ...explicitFilters };
    delete next.competition;
    return next;
  }
  return explicitFilters;
}

export function shouldContinueWithMomentRetrieval(queryPlan: DomainQueryPlan, sportsAnswer: SportsKnowledgeAnswer) {
  return Boolean(
    queryPlan.intent.questionType === "stat_qa" &&
      sportsAnswer.applicable &&
      sportsAnswer.route === "stat_qa" &&
      sportsAnswer.status === "answered" &&
      sportsAnswer.subject.player &&
      isMomentSearchQuery(queryPlan.originalQuery)
  );
}

export function buildStatSeededMomentPlan(queryPlan: DomainQueryPlan, sportsAnswer: SportsKnowledgeAnswer): DomainQueryPlan {
  const player = sportsAnswer.subject.player;
  if (!player) return queryPlan;
  const domainFilters = compactFilters({
    ...queryPlan.domainFilters,
    competition: sportsAnswer.subject.competition ?? queryPlan.domainFilters.competition,
    season: sportsAnswer.subject.season ?? queryPlan.domainFilters.season,
    player,
    eventType: undefined,
    passType: undefined,
    fieldZone: undefined,
    role: undefined
  });
  const metricText = sportsAnswer.subject.metric ? `${sportsAnswer.subject.metric} leader` : "statistics leader";
  const semanticQuery = [
    player,
    metricText,
    queryPlan.originalQuery,
    queryPlan.semanticQuery,
    sportsAnswer.evidence.map((item) => item.sourceText).join(" ")
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ...queryPlan,
    semanticQuery,
    rewrittenQuery: buildRewrittenQuery(domainFilters),
    domainFilters,
    intent: {
      ...queryPlan.intent,
      domain: domainFromFilters(domainFilters),
      questionType: "moment_retrieval",
      player,
      eventType: null,
      passType: null,
      fieldZone: null,
      role: null
    },
    confidence: Number(Math.max(queryPlan.confidence, Math.min(0.9, sportsAnswer.confidence)).toFixed(2)),
    warnings: [
      ...queryPlan.warnings,
      `Sports knowledge resolved the ranking subject to ${player}; video retrieval is still limited to indexed evidence.`
    ]
  };
}

export function buildScopedMetadataMomentPlan(
  queryPlan: DomainQueryPlan,
  sportsAnswer: SportsKnowledgeAnswer,
  assets: AssetRecord[],
  domainGroup?: SportsDomainGroup
): DomainQueryPlan | null {
  if (!isMomentSearchQuery(queryPlan.originalQuery) || !isStatLeaderboardQuery(queryPlan.originalQuery)) return null;
  if (sportsAnswer.status === "answered" && sportsAnswer.subject.player) return null;
  const seed = resolveTopIndexedPlayer(assets, domainGroup ?? queryPlan.intent.domain);
  if (!seed) return null;
  const domainFilters = compactFilters({
    ...queryPlan.domainFilters,
    player: seed.player,
    eventType: undefined,
    passType: undefined,
    fieldZone: undefined,
    role: undefined
  });
  const semanticQuery = [
    seed.player,
    seed.role,
    queryPlan.domainFilters.competition,
    queryPlan.domainFilters.season,
    queryPlan.originalQuery,
    queryPlan.semanticQuery,
    seed.evidence.join(" ")
  ].filter(Boolean).join(" ");
  return {
    ...queryPlan,
    semanticQuery,
    rewrittenQuery: buildRewrittenQuery(domainFilters),
    domainFilters,
    intent: {
      ...queryPlan.intent,
      domain: domainGroup ?? domainFromFilters(domainFilters),
      questionType: "moment_retrieval",
      player: seed.player,
      eventType: null,
      passType: null,
      fieldZone: null,
      role: null
    },
    confidence: Number(Math.max(queryPlan.confidence, seed.confidence).toFixed(2)),
    warnings: [
      ...queryPlan.warnings,
      "No imported sports-stat leaderboard resolved this scoped query; falling back to indexed asset metadata.",
      `Current scope metadata resolved the search subject to ${seed.player}.`
    ]
  };
}

function buildRewrittenQuery(filters: DomainSearchFilters) {
  return [
    filters.competition ? `competition=${filters.competition}` : "",
    filters.season ? `season=${filters.season}` : "",
    filters.player ? `player=${filters.player}` : ""
  ].filter(Boolean).join(" · ");
}

function domainFromFilters(filters: DomainSearchFilters) {
  if (filters.competition === "NFL") return "sports.american_football";
  return "sports.football";
}

function compactFilters(filters: DomainSearchFilters): DomainSearchFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => typeof value === "string" && value.trim().length > 0)
  ) as DomainSearchFilters;
}

function resolveTopIndexedPlayer(assets: AssetRecord[], domain: string | null): IndexedPlayerSeed | null {
  const candidates = new Map<string, { player: string; confidence: number; count: number; evidence: string[]; role: IndexedPlayerSeed["role"] }>();
  for (const asset of assets) {
    for (const segment of asset.timeline) {
      for (const event of trustedDomainEvents(segment)) {
        const quarterback = event.americanFootball?.quarterback.identity;
        if (quarterback) addCandidate(candidates, quarterback.name, quarterback.confidence, `Quarterback metadata in ${asset.title}: ${event.caption}`, "quarterback");
        if (domain === "sports.american_football") continue;
        for (const identity of [event.football?.receivingPlayer.identity, event.football?.passingPlayer.identity]) {
          if (identity) addCandidate(candidates, identity.name, identity.confidence, `Player metadata in ${asset.title}: ${event.caption}`, "player");
        }
      }
      for (const player of segment.domain?.scope?.players ?? []) {
        addCandidate(candidates, player.value, player.confidence, `Video scope links ${player.value} to ${asset.title}.`, "player");
      }
    }
  }
  return Array.from(candidates.values())
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence || a.player.localeCompare(b.player))
    .map((candidate) => ({
      player: candidate.player,
      confidence: Number(Math.min(0.82, 0.45 + candidate.count * 0.05 + candidate.confidence * 0.25).toFixed(2)),
      evidence: candidate.evidence.slice(0, 6),
      role: candidate.role
    }))[0] ?? null;
}

function addCandidate(
  candidates: Map<string, { player: string; confidence: number; count: number; evidence: string[]; role: IndexedPlayerSeed["role"] }>,
  player: string,
  confidence: number,
  evidence: string,
  role: IndexedPlayerSeed["role"]
) {
  const key = player.toLowerCase().trim();
  if (!key) return;
  const existing = candidates.get(key);
  if (existing) {
    existing.count += 1;
    existing.confidence = Math.max(existing.confidence, confidence);
    if (existing.evidence.length < 8) existing.evidence.push(evidence);
    if (role === "quarterback") existing.role = "quarterback";
    return;
  }
  candidates.set(key, { player, confidence, count: 1, evidence: [evidence], role });
}
