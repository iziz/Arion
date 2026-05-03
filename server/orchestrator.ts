import type { AssetRecord, DomainQueryPlan, DomainScopeValue, IndexRecord, OrchestrationPlan, PlayerIdentity } from "../shared/types";
import { trustedDomainEvents } from "./evidenceTrust";
import { getKnowledgePlayer } from "./sportsKnowledge";

export function buildOrchestrationPlan(queryPlan: DomainQueryPlan, assets: AssetRecord[], indexes: IndexRecord[]): OrchestrationPlan {
  const mode = inferMode(queryPlan);
  const knowledgePlayer = queryPlan.intent.player ? getKnowledgePlayer(queryPlan.intent.player) : null;
  const identityCandidates = collectIdentityCandidates(queryPlan.intent.player, assets);
  const scopeCoverage = estimateScopeCoverage(queryPlan, assets);
  const identityDecision = buildIdentityDecision(queryPlan.intent.player, identityCandidates, mode, knowledgePlayer);
  const scopeDecision = buildScopeDecision(queryPlan, scopeCoverage);
  const routeDecision = buildRouteDecision(mode, indexes, assets, queryPlan);
  const retrievalFallback = [
    routeDecision.status !== "ready" ? routeDecision.reason : "",
    scopeCoverage.competition === "missing" ? "Competition scope is not indexed for some matching assets; keep it as a soft constraint." : "",
    scopeCoverage.season === "missing" ? "Season scope is not indexed for some matching assets; keep it as a soft constraint." : "",
    queryPlan.intent.player && identityCandidates.length === 0 && !knowledgePlayer ? "Player identity is unresolved; use lexical title/ASR fallback." : "",
    queryPlan.intent.player && identityCandidates.length === 0 && knowledgePlayer && mode !== "stat_qa"
      ? "Player identity is known in sports knowledge, but not grounded in indexed video evidence yet."
      : ""
  ].filter(Boolean);
  const warnings = [
    ...queryPlan.warnings,
    routeDecision.status !== "ready" ? routeDecision.reason : "",
    identityDecision.status !== "ready" ? identityDecision.reason : "",
    scopeDecision.status !== "ready" ? scopeDecision.reason : "",
    mode !== "search" && mode !== "stat_qa" ? "Generation step should only run over retrieved, evidence-backed moments." : ""
  ].filter(Boolean);

  return {
    query: queryPlan.originalQuery,
    mode,
    confidence: Number(Math.min(queryPlan.confidence, identityDecision.confidence, scopeDecision.confidence, routeDecision.confidence).toFixed(2)),
    decisions: [identityDecision, scopeDecision, routeDecision],
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
      buildGroundingStep(queryPlan),
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
      engine: retrievalEngineForRoute(queryPlan),
      filters: queryPlan.domainFilters,
      fallback: retrievalFallback
    },
    analysis: {
      required: mode !== "search" && mode !== "stat_qa",
      model: mode === "search" || mode === "stat_qa" ? "none" : "pattern_analysis_generate",
      prompt: buildAnalysisPrompt(queryPlan),
      inputs: analysisInputsForRoute(queryPlan)
    },
    warnings
  };
}

function inferMode(queryPlan: DomainQueryPlan): OrchestrationPlan["mode"] {
  switch (queryPlan.route) {
    case "sports_stat_qa":
      return "stat_qa";
    case "video_summary":
    case "sports_analysis":
      return "analysis";
    case "sports_moment_retrieval":
    case "generic_video_qa":
    case "asset_lookup":
    case "unsupported":
      return "search";
  }
}

function retrievalEngineForRoute(queryPlan: DomainQueryPlan): OrchestrationPlan["retrieval"]["engine"] {
  if (queryPlan.route === "sports_stat_qa") return "structured_domain";
  if (isSportsRoute(queryPlan.route)) return "hybrid";
  return "semantic_retrieval";
}

function buildGroundingStep(queryPlan: DomainQueryPlan): OrchestrationPlan["steps"][number] {
  if (!isSportsRoute(queryPlan.route)) {
    return {
      id: "ground",
      label: "Knowledge grounding",
      owner: "knowledge",
      action: "Skip sports knowledge grounding and keep retrieval scoped to indexed video evidence.",
      input: queryPlan.rewrittenQuery,
      output: "No sports knowledge expansion required",
      status: "ready",
      trigger: "Non-sports routes use ASR, OCR, visual, title, and metadata evidence only."
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
    trigger: "Sports routes need information beyond the video pixels, ASR, or OCR."
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
  if (knowledgePlayer && candidates.length === 0) {
    return {
      id: "identity",
      label: "Identity",
      value: `${knowledgePlayer.canonical} (sports knowledge)`,
      confidence: 0.62,
      status: "fallback",
      reason: "The player is resolved in sports knowledge, but no indexed video segment currently grounds that identity."
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
  if (!isSportsRoute(queryPlan.route)) {
    return {
      id: "route",
      label: "Route",
      value: routeLabel(queryPlan.route),
      confidence: assets.length > 0 ? 0.86 : 0.42,
      status: assets.length > 0 ? "ready" : "fallback",
      reason:
        assets.length > 0
          ? "This route uses indexed video evidence without sports knowledge expansion."
          : "No assets are available in the selected scope."
    };
  }
  const requestedDomain = isSupportedSportsDomain(queryPlan.intent.domain) ? queryPlan.intent.domain : null;
  const scopedIndexIds = new Set(assets.map((asset) => asset.indexId));
  const scopedIndexes = scopedIndexIds.size > 0 ? indexes.filter((index) => scopedIndexIds.has(index.id)) : indexes;
  const domainIndexes = scopedIndexes.filter((index) => index.domainIndexing?.enabled && (!requestedDomain || index.domainIndexing.groups.includes(requestedDomain)));
  if (mode === "stat_qa") {
    return {
      id: "route",
      label: "Route",
      value: routeLabel(queryPlan.route),
      confidence: 0.86,
      status: "ready",
      reason: "This query asks for an aggregate statistic, so it should be answered from sports knowledge."
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
          ? `At least one ${requestedDomain} asset group has sports domain indexing enabled.`
          : "At least one asset group has sports domain indexing enabled."
        : requestedDomain
          ? `No ${requestedDomain} asset group is indexed yet.`
          : "No domain-indexed asset group is available."
  };
}

function buildAnalysisPrompt(queryPlan: DomainQueryPlan) {
  if (queryPlan.route === "video_summary") {
    return "Summarize only from retrieved indexed video evidence. Prefer ASR/OCR text when present, include key time ranges, and report evidence gaps.";
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

function analysisInputsForRoute(queryPlan: DomainQueryPlan): OrchestrationPlan["analysis"]["inputs"] {
  if (!isSportsRoute(queryPlan.route)) return ["retrieved_segments", "asr_text", "ocr_text", "visual_evidence", "asset_metadata"];
  return ["retrieved_segments", "domain_events", "knowledge_evidence", "identity_resolution", "scope_metadata"];
}

function routeLabel(route: DomainQueryPlan["route"]) {
  switch (route) {
    case "video_summary":
      return "Video summary";
    case "generic_video_qa":
      return "Generic video QA";
    case "sports_moment_retrieval":
      return "Sports moment retrieval";
    case "sports_analysis":
      return "Sports analysis";
    case "sports_stat_qa":
      return "Sports stats QA";
    case "asset_lookup":
      return "Asset lookup";
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

function isSupportedSportsDomain(value: string | null): value is "sports.football" | "sports.american_football" {
  return value === "sports.football" || value === "sports.american_football";
}

function isSportsRoute(route: DomainQueryPlan["route"]) {
  return route === "sports_moment_retrieval" || route === "sports_analysis" || route === "sports_stat_qa";
}
