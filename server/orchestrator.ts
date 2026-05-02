import type { AssetRecord, DomainQueryPlan, DomainScopeValue, IndexRecord, OrchestrationPlan, PlayerIdentity } from "../shared/types";
import { getKnowledgePlayer } from "./sportsKnowledge";

export function buildOrchestrationPlan(queryPlan: DomainQueryPlan, assets: AssetRecord[], indexes: IndexRecord[]): OrchestrationPlan {
  const mode = inferMode(queryPlan);
  const knowledgePlayer = queryPlan.intent.player ? getKnowledgePlayer(queryPlan.intent.player) : null;
  const identityCandidates = collectIdentityCandidates(queryPlan.intent.player, assets);
  const scopeCoverage = estimateScopeCoverage(queryPlan, assets);
  const identityDecision = buildIdentityDecision(queryPlan.intent.player, identityCandidates, mode, knowledgePlayer);
  const scopeDecision = buildScopeDecision(queryPlan, scopeCoverage);
  const retrievalFallback = [
    scopeCoverage.competition === "missing" ? "Competition scope is not indexed for some matching assets; keep it as a soft constraint." : "",
    scopeCoverage.season === "missing" ? "Season scope is not indexed for some matching assets; keep it as a soft constraint." : "",
    queryPlan.intent.player && identityCandidates.length === 0 && !(mode === "stat_qa" && knowledgePlayer) ? "Player identity is unresolved; use lexical title/ASR fallback." : ""
  ].filter(Boolean);
  const warnings = [
    ...queryPlan.warnings,
    identityDecision.status !== "ready" ? identityDecision.reason : "",
    scopeDecision.status !== "ready" ? scopeDecision.reason : "",
    mode !== "search" && mode !== "stat_qa" ? "Generation step should only run over retrieved, evidence-backed moments." : ""
  ].filter(Boolean);

  return {
    query: queryPlan.originalQuery,
    mode,
    confidence: Number(Math.min(queryPlan.confidence, identityDecision.confidence, scopeDecision.confidence).toFixed(2)),
    decisions: [identityDecision, scopeDecision, buildRouteDecision(mode, indexes)],
    steps: [
      {
        id: "parse",
        label: "Intent and constraint parsing",
        owner: "router",
        action: "Extract player, event, field zone, role, competition, and season constraints.",
        input: queryPlan.originalQuery,
        output: queryPlan.rewrittenQuery,
        status: "ready",
        trigger: "Every natural-language query starts here."
      },
      {
        id: "identity",
        label: "Identity resolution",
        owner: "knowledge",
        action: "Resolve requested player name against indexed roster/title/ASR/OCR evidence.",
        input: queryPlan.intent.player ?? "No player constraint",
        output: identityCandidates.slice(0, 3).map((candidate) => `${candidate.value} ${Math.round(candidate.confidence * 100)}%`).join(", ") || "No candidate",
        status: identityDecision.status,
        trigger: "Player-specific query or role-specific event."
      },
      {
        id: "scope",
        label: "Context scope check",
        owner: "knowledge",
        action: "Check whether competition and season are grounded in domain scope metadata.",
        input: [queryPlan.domainFilters.competition, queryPlan.domainFilters.season].filter(Boolean).join(" · ") || "No scope constraint",
        output: `competition=${scopeCoverage.competition}, season=${scopeCoverage.season}`,
        status: scopeDecision.status,
        trigger: "Competition or season is present in the query."
      },
      {
        id: "ground",
        label: "Knowledge grounding",
        owner: "knowledge",
        action: "Fetch structured roster, player profile, competition, and video-scope evidence before moment retrieval.",
        input: queryPlan.rewrittenQuery,
        output: "Grounded entity evidence for retrieval expansion and result attribution",
        status: "ready",
        trigger: "Queries that need information beyond the video pixels, ASR, or OCR."
      },
      {
        id: "retrieve",
        label: mode === "stat_qa" ? "Stats retrieval" : "Moment retrieval",
        owner: mode === "stat_qa" ? "knowledge" : "retrieval",
        action: mode === "stat_qa" ? "Query imported sports statistics before video moment retrieval." : "Run semantic retrieval and merge it with structured event filters.",
        input: queryPlan.semanticQuery,
        output: mode === "stat_qa" ? "Player metric answer with source evidence" : "Ranked timeline segments with match reasons",
        status: retrievalFallback.length > 0 ? "fallback" : "ready",
        trigger: mode === "stat_qa" ? "Questions asking for counts or season totals." : "Need to find all candidate moments before analysis."
      },
      {
        id: "generate",
        label: mode === "stat_qa" ? "Direct answer" : "Pattern analysis",
        owner: "analysis",
        action:
          mode === "stat_qa"
            ? "Return a sourced stats answer without treating video search results as official totals."
            : mode === "search"
              ? "Skip generation unless the user asks for summary, comparison, or decision patterns."
              : "Generate a grounded pattern summary from retrieved segments only.",
        input: mode === "stat_qa" ? "Imported sports knowledge rows" : mode === "search" ? "Not required" : "Retrieved moments + domain evidence + scope metadata",
        output: mode === "stat_qa" ? "Sourced statistics answer" : mode === "search" ? "Search results only" : "Evidence-backed tactical or player pattern report",
        status: mode === "search" ? "fallback" : "ready",
        trigger: mode === "stat_qa" ? "Aggregate stat question." : "Analysis verbs such as summarize, compare, pattern, decision, or analyze."
      }
    ],
    retrieval: {
      engine: mode === "stat_qa" ? "structured_domain" : queryPlan.intent.domain ? "hybrid" : "semantic_retrieval",
      filters: queryPlan.domainFilters,
      fallback: retrievalFallback
    },
    analysis: {
      required: mode !== "search" && mode !== "stat_qa",
      model: mode === "search" || mode === "stat_qa" ? "none" : "pattern_analysis_generate",
      prompt: buildAnalysisPrompt(queryPlan),
      inputs: ["retrieved_segments", "domain_events", "knowledge_evidence", "identity_resolution", "scope_metadata"]
    },
    warnings
  };
}

function inferMode(queryPlan: DomainQueryPlan): OrchestrationPlan["mode"] {
  if (queryPlan.intent.questionType === "stat_qa") return "stat_qa";
  const normalized = queryPlan.originalQuery.toLowerCase();
  const asksAnalysis = /분석|요약|비교|패턴|리포트|decision|pattern|analy[sz]e|summari[sz]e|compare/.test(normalized);
  const asksSearch = /찾|검색|find|show|moments|장면|구간/.test(normalized);
  if (asksAnalysis && asksSearch) return "search_and_analysis";
  if (asksAnalysis) return "analysis";
  return "search";
}

function collectIdentityCandidates(player: string | null, assets: AssetRecord[]): DomainScopeValue[] {
  if (!player) return [];
  const normalizedPlayer = normalize(player);
  const candidates = new Map<string, DomainScopeValue>();
  for (const asset of assets) {
    for (const segment of asset.timeline) {
      const scopedPlayers = segment.domain?.scope?.players ?? [];
      const eventPlayers = (segment.domain?.events ?? [])
        .flatMap((event) => [event.football?.receivingPlayer.identity, event.football?.passingPlayer.identity])
        .filter(Boolean)
        .map((identity) => identityToScopeValue(identity as PlayerIdentity));
      for (const candidate of [...scopedPlayers, ...eventPlayers]) {
        if (!normalize(candidate.value).includes(normalizedPlayer) && !normalizedPlayer.includes(normalize(candidate.value))) continue;
        const existing = candidates.get(candidate.value);
        if (!existing || candidate.confidence > existing.confidence) candidates.set(candidate.value, candidate);
      }
    }
  }
  return Array.from(candidates.values()).sort((a, b) => b.confidence - a.confidence);
}

function identityToScopeValue(identity: PlayerIdentity): DomainScopeValue {
  return {
    value: identity.name,
    confidence: identity.confidence,
    source: identity.source === "query" ? "metadata" : identity.source,
    evidence: identity.evidence
  };
}

function estimateScopeCoverage(queryPlan: DomainQueryPlan, assets: AssetRecord[]) {
  return {
    competition: coverageFor("competition", queryPlan.domainFilters.competition, assets),
    season: coverageFor("season", queryPlan.domainFilters.season, assets)
  };
}

function coverageFor(field: "competition" | "season", value: string | undefined, assets: AssetRecord[]): "not_requested" | "ready" | "missing" {
  if (!value) return "not_requested";
  const normalizedValue = normalize(value);
  let scoped = 0;
  let matched = 0;
  for (const asset of assets) {
    for (const segment of asset.timeline) {
      const scopeValue = field === "competition" ? segment.domain?.scope?.competition?.value : segment.domain?.scope?.season?.value;
      if (!scopeValue) continue;
      scoped += 1;
      if (normalize(scopeValue).includes(normalizedValue) || normalizedValue.includes(normalize(scopeValue))) matched += 1;
    }
  }
  if (matched > 0) return "ready";
  return scoped > 0 ? "missing" : "missing";
}

function buildIdentityDecision(player: string | null, candidates: DomainScopeValue[], mode: OrchestrationPlan["mode"], knowledgePlayer: ReturnType<typeof getKnowledgePlayer>): OrchestrationPlan["decisions"][number] {
  if (!player) {
    return {
      id: "identity",
      label: "Identity",
      value: "No player requested",
      confidence: 1,
      status: "ready",
      reason: "The query does not require player identity grounding."
    };
  }
  if (mode === "stat_qa" && knowledgePlayer) {
    return {
      id: "identity",
      label: "Identity",
      value: `${knowledgePlayer.canonical} (sports knowledge)`,
      confidence: 0.94,
      status: "ready",
      reason: "The player identity is resolved against imported sports knowledge."
    };
  }
  if (candidates.length === 0) {
    return {
      id: "identity",
      label: "Identity",
      value: player,
      confidence: 0.35,
      status: "fallback",
      reason: "No indexed identity candidate was found; search will rely on lexical and semantic evidence."
    };
  }
  const top = candidates[0];
  return {
    id: "identity",
    label: "Identity",
    value: `${top.value} (${top.source})`,
    confidence: top.confidence,
    status: top.confidence >= 0.65 ? "ready" : "needs_review",
    reason: top.confidence >= 0.65 ? "A player identity candidate is grounded in indexed evidence." : "Identity was inferred from weak evidence and should be reviewed."
  };
}

function buildScopeDecision(queryPlan: DomainQueryPlan, coverage: { competition: string; season: string }): OrchestrationPlan["decisions"][number] {
  const requested = [queryPlan.domainFilters.competition, queryPlan.domainFilters.season].filter(Boolean).join(" · ");
  if (!requested) {
    return {
      id: "scope",
      label: "Scope",
      value: "No competition/season requested",
      confidence: 1,
      status: "ready",
      reason: "The query does not require league or season scope grounding."
    };
  }
  const ready = (coverage.competition === "ready" || coverage.competition === "not_requested") && (coverage.season === "ready" || coverage.season === "not_requested");
  return {
    id: "scope",
    label: "Scope",
    value: requested,
    confidence: ready ? 0.78 : 0.52,
    status: ready ? "ready" : "fallback",
    reason: ready ? "Requested scope exists in indexed metadata." : "Requested scope is partially missing; keep it soft to avoid false negatives."
  };
}

function buildRouteDecision(mode: OrchestrationPlan["mode"], indexes: IndexRecord[]): OrchestrationPlan["decisions"][number] {
  const domainIndexes = indexes.filter((index) => index.domainIndexing?.enabled);
  if (mode === "stat_qa") {
    return {
      id: "route",
      label: "Route",
      value: "Knowledge stats QA",
      confidence: 0.86,
      status: "ready",
      reason: "This query asks for an aggregate statistic, so it should be answered from sports knowledge."
    };
  }
  return {
    id: "route",
    label: "Route",
    value: mode === "search" ? "Moment retrieval" : "Moment retrieval + Pattern analysis",
    confidence: domainIndexes.length > 0 ? 0.82 : 0.58,
    status: domainIndexes.length > 0 ? "ready" : "fallback",
    reason: domainIndexes.length > 0 ? "At least one asset group has sports domain indexing enabled." : "No domain-indexed asset group is available."
  };
}

function buildAnalysisPrompt(queryPlan: DomainQueryPlan) {
  return [
    "Answer only from retrieved evidence.",
    queryPlan.intent.player ? `Focus player: ${queryPlan.intent.player}.` : "",
    queryPlan.intent.eventType ? `Event: ${queryPlan.intent.eventType}.` : "",
    queryPlan.intent.passType ? `Pass: ${queryPlan.intent.passType}.` : "",
    queryPlan.intent.fieldZone ? `Field zone: ${queryPlan.intent.fieldZone}.` : "",
    "Report confidence gaps and ambiguous identity/scope evidence."
  ]
    .filter(Boolean)
    .join(" ");
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}
