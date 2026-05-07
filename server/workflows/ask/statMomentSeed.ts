import type { DomainQueryPlan, DomainSearchFilters, IndexRecord, KnowledgeSourceId, StructuredKnowledgeAnswer } from "../../../shared/types";
import { buildRetrievalPlan } from "../../queryRetrievalPlan";

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

export function isKnowledgeSeededMomentPlan(queryPlan: DomainQueryPlan) {
 return (
    queryPlan.route === "knowledge_seeded_asset_evidence" &&
    queryPlan.responseMode === "moment_retrieval" &&
    queryPlan.relatedKnowledgeMode === "grounding" &&
    Boolean(queryPlan.intent.metric) &&
    queryPlan.intent.statMode === "leaderboard"
  );
}

export function buildStatSeedKnowledgePlan(queryPlan: DomainQueryPlan): DomainQueryPlan {
  const domainFilters = compactFilters({
    ...queryPlan.domainFilters,
    player: undefined,
    eventType: undefined,
    passType: undefined,
    fieldZone: undefined,
    role: undefined
  });
  return {
    ...queryPlan,
    domainFilters,
    route: "knowledge_evidence",
    responseMode: "structured_answer",
    relatedKnowledgeMode: "direct_answer",
    intent: {
      ...queryPlan.intent,
      questionType: "structured_answer",
      player: null,
      eventType: null,
      passType: null,
      fieldZone: null,
      role: null,
      metric: queryPlan.intent.metric,
      statMode: queryPlan.intent.statMode
    }
  };
}

export function shouldContinueWithMomentRetrieval(queryPlan: DomainQueryPlan, knowledgeAnswer: StructuredKnowledgeAnswer) {
  return Boolean(
    isKnowledgeSeededMomentPlan(queryPlan) &&
      knowledgeAnswer.applicable &&
      knowledgeAnswer.route === "stat_qa" &&
      knowledgeAnswer.status === "answered" &&
      knowledgeAnswer.subject.player
  );
}

export function buildStatSeededMomentPlan(queryPlan: DomainQueryPlan, knowledgeAnswer: StructuredKnowledgeAnswer): DomainQueryPlan {
  const player = knowledgeAnswer.subject.player;
  if (!player) return queryPlan;
  const metricDefaults = metricMomentDefaults(queryPlan.intent.metric);
  const domainFilters = compactFilters({
    ...queryPlan.domainFilters,
    competition: knowledgeAnswer.subject.competition ?? queryPlan.domainFilters.competition,
    season: knowledgeAnswer.subject.season ?? queryPlan.domainFilters.season,
    player,
    eventType: queryPlan.domainFilters.eventType ?? metricDefaults.eventType,
    role: queryPlan.domainFilters.role ?? metricDefaults.role
  });
  const metricText = knowledgeAnswer.subject.metric ? `${knowledgeAnswer.subject.metric} leader` : "statistics leader";
  const semanticQuery = [
    player,
    metricText,
    queryPlan.semanticQuery,
    queryPlan.retrieval?.evidenceTerms.join(" "),
    knowledgeAnswer.evidence.map((item) => item.sourceText).join(" ")
  ]
    .filter(Boolean)
    .join(" ");
  const retrieval = buildRetrievalPlan(queryPlan.originalQuery, semanticQuery, {
    textQuery: semanticQuery,
    visualQuery: [player, metricText, queryPlan.retrieval?.visualQuery ?? queryPlan.semanticQuery].filter(Boolean).join(" "),
    evidenceTerms: [
      player,
      ...(queryPlan.retrieval?.evidenceTerms ?? []),
      ...metricDefaults.evidenceTerms
    ],
    requiredEvidence: queryPlan.retrieval?.requiredEvidence ?? []
  });
  return {
    ...queryPlan,
    semanticQuery,
    rewrittenQuery: buildRewrittenQuery(domainFilters),
    retrieval,
    domainFilters,
    route: "knowledge_seeded_asset_evidence",
    responseMode: "moment_retrieval",
    relatedKnowledgeMode: "grounding",
    intent: {
      ...queryPlan.intent,
      domain: domainFromFilters(domainFilters),
      questionType: "moment_retrieval",
      player,
      eventType: domainFilters.eventType ?? null,
      passType: domainFilters.passType ?? null,
      fieldZone: domainFilters.fieldZone ?? null,
      role: domainFilters.role ?? null
    },
    confidence: Number(Math.max(queryPlan.confidence, Math.min(0.9, knowledgeAnswer.confidence)).toFixed(2)),
    warnings: [
      ...queryPlan.warnings,
      `Related knowledge resolved the ranking subject to ${player}; video retrieval is still limited to indexed evidence.`
    ]
  };
}

function metricMomentDefaults(metric: DomainQueryPlan["intent"]["metric"]) {
  if (metric === "goals") {
    return {
      eventType: "shot",
      role: "shooter" as const,
      evidenceTerms: ["goal", "goals", "scoring", "shot", "finish", "득점", "골", "슈팅", "슛"]
    };
  }
  return {
    eventType: undefined,
    role: undefined,
    evidenceTerms: []
  };
}

function buildRewrittenQuery(filters: DomainSearchFilters) {
  return [
    filters.competition ? `competition=${filters.competition}` : "",
    filters.season ? `season=${filters.season}` : "",
    filters.player ? `player=${filters.player}` : "",
    filters.eventType ? `event=${filters.eventType}` : "",
    filters.role && filters.role !== "any" ? `role=${filters.role}` : ""
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
