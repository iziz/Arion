import type { AssetRecord, DomainQueryPlan, DomainScopeValue, IndexRecord, OrchestrationPlan, PlayerIdentity } from "../shared/types";
import { isKnownKnowledgeSourceId } from "../shared/knowledgeSources";
import { trustedDomainEvents } from "./evidenceTrust";
import { getKnowledgePlayer } from "./sportsKnowledge";

export function buildOrchestrationPlan(queryPlan: DomainQueryPlan, assets: AssetRecord[], indexes: IndexRecord[]): OrchestrationPlan {
  const mode = inferMode(queryPlan);
  const domainWorkflow = shouldUseRelatedKnowledgeWorkflow(queryPlan, indexes, assets);
  const knowledgePlayer = queryPlan.intent.player ? getKnowledgePlayer(queryPlan.intent.player) : null;
  const identityCandidates = domainWorkflow ? collectIdentityCandidates(queryPlan.intent.player, assets) : [];
  const scopeCoverage = domainWorkflow ? estimateScopeCoverage(queryPlan, assets) : { competition: "not_requested", season: "not_requested" };
  const identityDecision = domainWorkflow ? buildIdentityDecision(queryPlan.intent.player, identityCandidates, mode, knowledgePlayer) : null;
  const scopeDecision = domainWorkflow ? buildScopeDecision(queryPlan, scopeCoverage) : null;
  const routeDecision = buildRouteDecision(mode, indexes, assets, queryPlan);
  const decisions = domainWorkflow && identityDecision && scopeDecision ? [identityDecision, scopeDecision, routeDecision] : [routeDecision];
  const retrievalFallback = domainWorkflow
    ? [
        routeDecision.status !== "ready" ? routeDecision.reason : "",
        scopeCoverage.competition === "missing" ? "Competition scope is not indexed for some matching assets; keep it as a soft constraint." : "",
        scopeCoverage.season === "missing" ? "Season scope is not indexed for some matching assets; keep it as a soft constraint." : "",
        queryPlan.intent.player && identityCandidates.length === 0 && !knowledgePlayer ? "Player identity is unresolved; use lexical title/ASR fallback." : "",
        queryPlan.intent.player && identityCandidates.length === 0 && knowledgePlayer && mode !== "structured_answer"
          ? "Player identity is known in the selected related knowledge, but not grounded in indexed video evidence yet."
          : ""
      ].filter(Boolean)
    : [routeDecision.status !== "ready" ? routeDecision.reason : ""].filter(Boolean);
  const warnings = domainWorkflow
    ? [
        ...queryPlan.warnings,
        routeDecision.status !== "ready" ? routeDecision.reason : "",
        identityDecision && identityDecision.status !== "ready" ? identityDecision.reason : "",
        scopeDecision && scopeDecision.status !== "ready" ? scopeDecision.reason : "",
        mode !== "search" && mode !== "structured_answer" ? "Generation step should only run over retrieved, evidence-backed moments." : ""
      ].filter(Boolean)
    : [
        ...queryPlan.warnings,
        routeDecision.status !== "ready" ? routeDecision.reason : "",
        mode !== "search" && mode !== "structured_answer" ? "Generation step should only run over retrieved, evidence-backed moments." : ""
      ].filter(Boolean);
  const confidence = Number(Math.min(queryPlan.confidence, ...decisions.map((decision) => decision.confidence)).toFixed(2));

  return {
    query: queryPlan.originalQuery,
    mode,
    confidence,
    decisions,
    steps: domainWorkflow && identityDecision && scopeDecision
      ? buildRelatedKnowledgeOrchestrationSteps(queryPlan, mode, identityCandidates, identityDecision, scopeDecision, scopeCoverage, retrievalFallback)
      : buildGenericOrchestrationSteps(queryPlan, mode, routeDecision, retrievalFallback),
    retrieval: {
      engine: retrievalEngineForRoute(queryPlan),
      filters: queryPlan.domainFilters,
      fallback: retrievalFallback
    },
    analysis: {
      required: mode !== "search" && mode !== "structured_answer",
      model: mode === "search" || mode === "structured_answer" ? "none" : "pattern_analysis_generate",
      prompt: buildAnalysisPrompt(queryPlan, domainWorkflow),
      inputs: analysisInputsForRoute(queryPlan, domainWorkflow)
    },
    warnings
  };
}

function inferMode(queryPlan: DomainQueryPlan): OrchestrationPlan["mode"] {
  if (queryPlan.route === "unsupported") return "search";
  switch (queryPlan.responseMode) {
    case "structured_answer":
      return "structured_answer";
    case "summary":
    case "analysis":
    case "grounded_answer":
      return "analysis";
    case "moment_retrieval":
    case "asset_lookup":
      return "search";
  }
}

function retrievalEngineForRoute(queryPlan: DomainQueryPlan): OrchestrationPlan["retrieval"]["engine"] {
  if (queryPlan.knowledgeMode === "direct_answer") return "structured_domain";
  if (queryPlan.knowledgeMode === "grounding") return "hybrid";
  return "semantic_retrieval";
}

function shouldUseRelatedKnowledgeWorkflow(queryPlan: DomainQueryPlan, indexes: IndexRecord[], assets: AssetRecord[]) {
  if (queryPlan.knowledgeMode === "none") return false;
  return scopedDomainIndexes(queryPlan, indexes, assets).length > 0;
}

function scopedDomainIndexes(queryPlan: DomainQueryPlan, indexes: IndexRecord[], assets: AssetRecord[]) {
  const requestedDomain = isKnownKnowledgeSourceId(queryPlan.intent.domain) ? queryPlan.intent.domain : null;
  const scopedIndexIds = new Set(assets.map((asset) => asset.indexId));
  const scopedIndexes = scopedIndexIds.size > 0 ? indexes.filter((index) => scopedIndexIds.has(index.id)) : indexes;
  return scopedIndexes.filter((index) => index.domainIndexing?.enabled && (!requestedDomain || index.domainIndexing.groups.includes(requestedDomain)));
}

function buildRelatedKnowledgeOrchestrationSteps(
  queryPlan: DomainQueryPlan,
  mode: OrchestrationPlan["mode"],
  identityCandidates: DomainScopeValue[],
  identityDecision: OrchestrationPlan["decisions"][number],
  scopeDecision: OrchestrationPlan["decisions"][number],
  scopeCoverage: { competition: string; season: string },
  retrievalFallback: string[]
): OrchestrationPlan["steps"] {
  return [
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
    buildGroundingStep(queryPlan),
    buildRetrievalStep(queryPlan, mode, true, retrievalFallback),
    buildGenerationStep(mode)
  ];
}

function buildGenericOrchestrationSteps(
  queryPlan: DomainQueryPlan,
  mode: OrchestrationPlan["mode"],
  routeDecision: OrchestrationPlan["decisions"][number],
  retrievalFallback: string[]
): OrchestrationPlan["steps"] {
  return [
    {
      id: "parse",
      label: "Video request parsing",
      owner: "router",
      action: "Classify the video request and preserve the user-facing semantic query.",
      input: queryPlan.originalQuery,
      output: queryPlan.rewrittenQuery,
      status: "ready",
      trigger: "Every natural-language query starts here."
    },
    {
      id: "route",
      label: "Evidence route",
      owner: "router",
      action: "Keep retrieval scoped to indexed asset evidence for this route.",
      input: routeLabel(queryPlan.route),
      output: routeDecision.reason,
      status: routeDecision.status,
      trigger: "Asset-evidence retrieval can run without related-knowledge identity or scope grounding."
    },
    {
      id: "evidence_scope",
      label: "Indexed evidence scope",
      owner: "retrieval",
      action: "Use stored ASR, OCR, visual, VLM, title, and metadata evidence from the selected videos.",
      input: queryPlan.semanticQuery,
      output: "Related knowledge grounding not required",
      status: "ready",
      trigger: "The selected search scope does not activate matching related knowledge."
    },
    buildRetrievalStep(queryPlan, mode, false, retrievalFallback),
    buildGenerationStep(mode)
  ];
}

function buildRetrievalStep(queryPlan: DomainQueryPlan, mode: OrchestrationPlan["mode"], useDomainRetrieval: boolean, retrievalFallback: string[]): OrchestrationPlan["steps"][number] {
  return {
    id: "retrieve",
    label: mode === "structured_answer" ? "Structured retrieval" : "Moment retrieval",
    owner: mode === "structured_answer" ? "knowledge" : "retrieval",
    action:
      mode === "structured_answer"
        ? "Query imported related knowledge before video moment retrieval."
        : useDomainRetrieval
          ? "Run semantic retrieval and merge it with structured event filters."
          : "Run semantic retrieval over indexed video evidence.",
    input: queryPlan.semanticQuery,
    output: mode === "structured_answer" ? "Structured knowledge answer with source evidence" : "Ranked timeline segments with match reasons",
    status: retrievalFallback.length > 0 ? "fallback" : "ready",
    trigger: mode === "structured_answer" ? "Questions asking for structured facts from related knowledge." : "Need to find candidate moments before analysis."
  };
}

function buildGenerationStep(mode: OrchestrationPlan["mode"]): OrchestrationPlan["steps"][number] {
  return {
    id: "generate",
    label: mode === "structured_answer" ? "Direct answer" : "Answer generation",
    owner: "analysis",
    action:
      mode === "structured_answer"
        ? "Return a sourced stats answer without treating video search results as official totals."
        : mode === "search"
          ? "Skip generation unless the user asks for summary, comparison, or decision patterns."
          : "Generate a grounded answer from retrieved segments only.",
    input: mode === "structured_answer" ? "Imported knowledge rows" : mode === "search" ? "Not required" : "Retrieved video evidence",
    output: mode === "structured_answer" ? "Sourced structured answer" : mode === "search" ? "Search results only" : "Evidence-backed video answer",
    status: mode === "search" ? "fallback" : "ready",
    trigger: mode === "structured_answer" ? "Direct related-knowledge question." : "Analysis verbs such as summarize, compare, pattern, decision, or analyze."
  };
}

function buildGroundingStep(queryPlan: DomainQueryPlan): OrchestrationPlan["steps"][number] {
  if (queryPlan.knowledgeMode === "none") {
    return {
      id: "ground",
      label: "Knowledge grounding",
      owner: "knowledge",
      action: "Skip related knowledge grounding and keep retrieval scoped to indexed video evidence.",
      input: queryPlan.rewrittenQuery,
      output: "No related knowledge expansion required",
      status: "ready",
      trigger: "Routes without matching related knowledge use ASR, OCR, visual, title, and metadata evidence only."
    };
  }
  return {
    id: "ground",
    label: "Knowledge grounding",
    owner: "knowledge",
    action: "Fetch structured roster, player profile, competition, and video-scope evidence before moment retrieval.",
    input: queryPlan.rewrittenQuery,
    output: "Grounded entity evidence for retrieval expansion and result attribution",
    status: "ready",
    trigger: "Domain routes need selected knowledge beyond the video pixels, ASR, or OCR."
  };
}

function collectIdentityCandidates(player: string | null, assets: AssetRecord[]): DomainScopeValue[] {
  if (!player) return [];
  const normalizedPlayer = normalize(player);
  const candidates = new Map<string, DomainScopeValue>();
  for (const asset of assets) {
    for (const segment of asset.timeline) {
      const scopedPlayers = segment.domain?.scope?.players ?? [];
      const eventPlayers = trustedDomainEvents(segment)
        .flatMap((event) => [event.football?.receivingPlayer.identity, event.football?.passingPlayer.identity, event.americanFootball?.quarterback.identity])
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
  const requestedValues = splitRequestedValues(value).map(normalize);
  let scoped = 0;
  let matched = 0;
  for (const asset of assets) {
    for (const segment of asset.timeline) {
      const scopeValue = field === "competition" ? segment.domain?.scope?.competition?.value : segment.domain?.scope?.season?.value;
      if (!scopeValue) continue;
      scoped += 1;
      const normalizedScopeValue = normalize(scopeValue);
      if (requestedValues.some((requested) => normalizedScopeValue.includes(requested) || requested.includes(normalizedScopeValue))) matched += 1;
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
  if (mode === "structured_answer" && knowledgePlayer) {
    return {
      id: "identity",
      label: "Identity",
      value: `${knowledgePlayer.canonical} (related knowledge)`,
      confidence: 0.94,
      status: "ready",
      reason: "The player identity is resolved against the selected related knowledge."
    };
  }
  if (knowledgePlayer && candidates.length === 0) {
    return {
      id: "identity",
      label: "Identity",
      value: `${knowledgePlayer.canonical} (related knowledge)`,
      confidence: 0.62,
      status: "fallback",
      reason: "The player is resolved in the selected related knowledge, but no indexed video segment currently grounds that identity."
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

function buildRouteDecision(mode: OrchestrationPlan["mode"], indexes: IndexRecord[], assets: AssetRecord[], queryPlan: DomainQueryPlan): OrchestrationPlan["decisions"][number] {
  if (queryPlan.knowledgeMode === "none") {
    return {
      id: "route",
      label: "Route",
      value: routeLabel(queryPlan.route),
      confidence: assets.length > 0 ? 0.86 : 0.42,
      status: assets.length > 0 ? "ready" : "fallback",
      reason:
        assets.length > 0
          ? "This route uses indexed video evidence without related knowledge expansion."
          : "No assets are available in the selected scope."
    };
  }
  const requestedDomain = isKnownKnowledgeSourceId(queryPlan.intent.domain) ? queryPlan.intent.domain : null;
  const domainIndexes = scopedDomainIndexes(queryPlan, indexes, assets);
  if (mode === "structured_answer") {
    return {
      id: "route",
      label: "Route",
      value: routeLabel(queryPlan.route),
      confidence: 0.86,
      status: "ready",
      reason: "This query asks for an aggregate statistic, so it should be answered from the selected related knowledge."
    };
  }
  return {
    id: "route",
    label: "Route",
    value: routeLabel(queryPlan.route),
    confidence: domainIndexes.length > 0 ? 0.82 : 0.58,
    status: domainIndexes.length > 0 ? "ready" : "fallback",
    reason:
      domainIndexes.length > 0
        ? requestedDomain
          ? `At least one asset group has ${requestedDomain} related knowledge enabled.`
          : "At least one asset group has related knowledge enabled."
        : requestedDomain
          ? `No asset group with ${requestedDomain} related knowledge is active in this scope.`
          : "No related knowledge is active in this scope."
  };
}

function buildAnalysisPrompt(queryPlan: DomainQueryPlan, useRelatedKnowledge: boolean) {
  if (queryPlan.responseMode === "summary") {
    return "Summarize only from retrieved indexed video evidence. Prefer ASR/OCR text when present, include key time ranges, and report evidence gaps.";
  }
  if (!useRelatedKnowledge) {
    return "Answer only from retrieved indexed video evidence. Report confidence gaps and missing ASR/OCR/visual evidence.";
  }
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

function analysisInputsForRoute(queryPlan: DomainQueryPlan, useRelatedKnowledge: boolean): OrchestrationPlan["analysis"]["inputs"] {
  if (!useRelatedKnowledge) return ["retrieved_segments", "asr_text", "ocr_text", "visual_evidence", "asset_metadata"];
  return ["retrieved_segments", "domain_events", "knowledge_evidence", "identity_resolution", "scope_metadata"];
}

function routeLabel(route: DomainQueryPlan["route"]) {
  switch (route) {
    case "asset_evidence":
      return "Asset evidence";
    case "knowledge_evidence":
      return "Knowledge evidence";
    case "asset_catalog":
      return "Asset catalog";
    case "unsupported":
      return "Unsupported";
  }
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

function splitRequestedValues(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
