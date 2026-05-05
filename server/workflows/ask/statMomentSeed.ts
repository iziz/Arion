import type { DomainQueryPlan, DomainSearchFilters, IndexRecord, KnowledgeSourceId, StructuredKnowledgeAnswer } from "../../../shared/types";
import { isMomentSearchQuery } from "../../queryPlanner";

export function applyScopeDomainDefaults(
  explicitFilters: DomainSearchFilters,
  scope: { indexId?: string; domainGroup?: KnowledgeSourceId },
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

export function shouldContinueWithMomentRetrieval(queryPlan: DomainQueryPlan, knowledgeAnswer: StructuredKnowledgeAnswer) {
  return Boolean(
    queryPlan.route === "knowledge_evidence" &&
      queryPlan.responseMode === "structured_answer" &&
      queryPlan.knowledgeMode === "direct_answer" &&
      knowledgeAnswer.applicable &&
      knowledgeAnswer.route === "stat_qa" &&
      knowledgeAnswer.status === "answered" &&
      knowledgeAnswer.subject.player &&
      isMomentSearchQuery(queryPlan.originalQuery)
  );
}

export function buildStatSeededMomentPlan(queryPlan: DomainQueryPlan, knowledgeAnswer: StructuredKnowledgeAnswer): DomainQueryPlan {
  const player = knowledgeAnswer.subject.player;
  if (!player) return queryPlan;
  const domainFilters = compactFilters({
    ...queryPlan.domainFilters,
    competition: knowledgeAnswer.subject.competition ?? queryPlan.domainFilters.competition,
    season: knowledgeAnswer.subject.season ?? queryPlan.domainFilters.season,
    player,
    eventType: undefined,
    passType: undefined,
    fieldZone: undefined,
    role: undefined
  });
  const metricText = knowledgeAnswer.subject.metric ? `${knowledgeAnswer.subject.metric} leader` : "statistics leader";
  const semanticQuery = [
    player,
    metricText,
    queryPlan.originalQuery,
    queryPlan.semanticQuery,
    knowledgeAnswer.evidence.map((item) => item.sourceText).join(" ")
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ...queryPlan,
    semanticQuery,
    rewrittenQuery: buildRewrittenQuery(domainFilters),
    domainFilters,
    route: "asset_evidence",
    responseMode: "moment_retrieval",
    knowledgeMode: "grounding",
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
    confidence: Number(Math.max(queryPlan.confidence, Math.min(0.9, knowledgeAnswer.confidence)).toFixed(2)),
    warnings: [
      ...queryPlan.warnings,
      `Related knowledge resolved the ranking subject to ${player}; video retrieval is still limited to indexed evidence.`
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
