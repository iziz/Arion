import type { DomainParticipantConstraint, DomainQueryFilterEvidence, DomainQueryPlan, DomainSearchFilters } from "../shared/types";
import { buildRetrievalPlan, sanitizeEvidenceTerms, sanitizeRequiredEvidence } from "./queryRetrievalPlan";
import { getKnowledgeSnapshot, matchKnowledgeCompetition, matchKnowledgePlayer } from "./knowledge/registry";
import { genAiAttributes, traceAsync } from "./observability";
import { planQueryWithVlmWorker } from "./vlmWorkerClient";
import { planDomainQuery } from "./queryPlanner";

type ModelQueryPlan = {
  route?: string;
  responseMode?: string;
  relatedKnowledgeMode?: string;
  questionType?: "moment_retrieval" | "stat_qa";
  metric?: DomainQueryPlan["intent"]["metric"];
  statMode?: DomainQueryPlan["intent"]["statMode"];
  analysisSubject?: string | null;
  competition?: string | null;
  season?: string | null;
  player?: string | null;
  eventType?: string | null;
  passType?: string | null;
  fieldZone?: string | null;
  role?: DomainSearchFilters["role"] | null;
  participants?: unknown;
  participantConstraints?: unknown;
  semanticQuery?: string | null;
  retrieval?: {
    textQuery?: string | null;
    visualQuery?: string | null;
    evidenceTerms?: string[] | null;
    requiredEvidence?: unknown;
  } | null;
  filterEvidence?: unknown;
  confidence?: number;
  warnings?: string[];
};

type PlannerSource = NonNullable<DomainQueryPlan["planner"]>["source"];

const planCache = new Map<string, { expiresAt: number; plan: DomainQueryPlan }>();
const allowedQuestionTypes = new Set(["moment_retrieval", "stat_qa"]);
const allowedRoutes = new Set<DomainQueryPlan["route"]>([
  "asset_evidence",
  "knowledge_seeded_asset_evidence",
  "knowledge_evidence",
  "asset_catalog",
  "unsupported"
]);
const allowedResponseModes = new Set<DomainQueryPlan["responseMode"]>([
  "moment_retrieval",
  "grounded_answer",
  "summary",
  "analysis",
  "structured_answer",
  "asset_lookup"
]);
const allowedRelatedKnowledgeModes = new Set<DomainQueryPlan["relatedKnowledgeMode"]>(["none", "grounding", "direct_answer"]);
const allowedMetrics = new Set([
  "goals",
  "assists",
  "appearances",
  "minutes",
  "cards",
  "points",
  "touchdowns",
  "passing_yards",
  "passing_touchdowns",
  "rushing_yards",
  "receiving_yards",
  "sacks",
  "interceptions"
]);
const allowedRoles = new Set(["receiver", "passer", "shooter", "any"]);
const allowedParticipantRelations = new Set(["action_source", "action_target", "subject", "unknown"]);
const allowedStatModes = new Set(["leaderboard", "player_total"]);
const allowedEventTypes = new Set(["pass_receive", "shot", "dribble", "progressive_pass", "save", "pressure", "scramble", "pocket_escape", "throw_on_run"]);
const allowedPassTypes = new Set(["through_ball", "cross", "cutback"]);
const allowedFieldZones = new Set(["final_third", "penalty_area", "middle_third", "defensive_third"]);
const fallbackCompetitionAliases: Record<string, string[]> = {
  "Premier League": ["Premier League", "EPL", "프리미어 리그", "프리미어리그"],
  "Champions League": ["Champions League", "UCL", "챔피언스 리그", "챔피언스리그"],
  Bundesliga: ["Bundesliga", "분데스리가"],
  NFL: ["NFL", "National Football League", "미식축구", "미국 football"]
};
const nullableString = { type: ["string", "null"] } as const;
const nullablePlannerStringEnum = (values: string[]) => ({ type: ["string", "null"], enum: [...values, null] });
const plannerStringArray = { type: "array", items: { type: "string" }, maxItems: 16 } as const;
const openAiQueryPlannerSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "route",
    "responseMode",
    "relatedKnowledgeMode",
    "questionType",
    "metric",
    "statMode",
    "analysisSubject",
    "competition",
    "season",
    "player",
    "eventType",
    "passType",
    "fieldZone",
    "role",
    "participants",
    "semanticQuery",
    "retrieval",
    "filterEvidence",
    "confidence",
    "warnings"
  ],
  properties: {
    route: { type: "string", enum: Array.from(allowedRoutes) },
    responseMode: { type: "string", enum: Array.from(allowedResponseModes) },
    relatedKnowledgeMode: { type: "string", enum: Array.from(allowedRelatedKnowledgeModes) },
    questionType: nullablePlannerStringEnum(Array.from(allowedQuestionTypes)),
    metric: nullablePlannerStringEnum(Array.from(allowedMetrics)),
    statMode: nullablePlannerStringEnum(Array.from(allowedStatModes)),
    analysisSubject: nullableString,
    competition: nullableString,
    season: nullableString,
    player: nullableString,
    eventType: nullablePlannerStringEnum(Array.from(allowedEventTypes)),
    passType: nullablePlannerStringEnum(Array.from(allowedPassTypes)),
    fieldZone: nullablePlannerStringEnum(Array.from(allowedFieldZones)),
    role: nullablePlannerStringEnum(Array.from(allowedRoles)),
    participants: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entity", "relation", "role", "eventType", "evidence"],
        properties: {
          entity: { type: "string" },
          relation: { type: "string", enum: Array.from(allowedParticipantRelations) },
          role: nullablePlannerStringEnum(Array.from(allowedRoles)),
          eventType: nullablePlannerStringEnum(Array.from(allowedEventTypes)),
          evidence: { type: "array", items: { type: "string" }, maxItems: 4 }
        }
      }
    },
    semanticQuery: nullableString,
    retrieval: {
      type: "object",
      additionalProperties: false,
      required: ["textQuery", "visualQuery", "evidenceTerms", "requiredEvidence"],
      properties: {
        textQuery: nullableString,
        visualQuery: nullableString,
        evidenceTerms: plannerStringArray,
        requiredEvidence: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "terms", "match"],
            properties: {
              kind: { type: "string", enum: ["visible_text", "spoken_text"] },
              terms: { type: "array", items: { type: "string" }, maxItems: 8 },
              match: { type: "string", enum: ["all", "any"] }
            }
          }
        }
      }
    },
    filterEvidence: {
      type: "object",
      additionalProperties: false,
      required: ["competition", "season", "player", "eventType", "passType", "fieldZone", "role", "statMode", "analysisSubject"],
      properties: {
        competition: plannerStringArray,
        season: plannerStringArray,
        player: plannerStringArray,
        eventType: plannerStringArray,
        passType: plannerStringArray,
        fieldZone: plannerStringArray,
        role: plannerStringArray,
        statMode: plannerStringArray,
        analysisSubject: plannerStringArray
      }
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    warnings: { type: "array", items: { type: "string" }, maxItems: 8 }
  }
} as const;

export async function planDomainQueryWithLlm(query: string, explicitFilters: DomainSearchFilters = {}): Promise<DomainQueryPlan> {
  const base = planDomainQuery(query, explicitFilters);
  const openAiDisabledReason = getOpenAiPlannerDisabledReason(query);
  if (openAiDisabledReason && !query.trim()) return plannerUnavailable(query, explicitFilters, [openAiDisabledReason], openAiDisabledReason);

  const cacheKey = cacheKeyFor(query, explicitFilters);
  const cached = planCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.plan;

  let openAiFailure: string | null = openAiDisabledReason;
  try {
    if (!openAiDisabledReason) {
      const refined = mergeModelPlan(base, await requestOpenAiPlan(query, explicitFilters), explicitFilters, {
        source: "openai",
        model: getOpenAiModel()
      });
      planCache.set(cacheKey, { expiresAt: Date.now() + 30_000, plan: refined });
      return refined;
    }
  } catch (error) {
    openAiFailure = errorMessage(error);
  }

  try {
    const vlm = await requestVlmPlan(query, explicitFilters);
    const fallbackReason = openAiFailure ? `OpenAI planner fallback: ${openAiFailure}` : undefined;
    const refined = mergeModelPlan(base, vlm.plan, explicitFilters, {
      source: "vlm",
      model: vlm.model,
      fallbackReason,
      warnings: fallbackReason ? [fallbackReason] : []
    });
    planCache.set(cacheKey, { expiresAt: Date.now() + 30_000, plan: refined });
    return refined;
  } catch (error) {
    const vlmFailure = errorMessage(error);
    const warnings = [
      openAiFailure ? `OpenAI planner unavailable: ${openAiFailure}` : null,
      `VLM planner unavailable: ${vlmFailure}`
    ].filter(Boolean) as string[];
    return plannerUnavailable(query, explicitFilters, warnings, warnings.join(" "));
  }
}

function getOpenAiPlannerDisabledReason(query: string) {
  if (!query.trim()) return "Query is empty.";
  if (!process.env.OPENAI_API_KEY) return "OPENAI_API_KEY is not configured.";
  if (process.env.OPENAI_QUERY_PLANNER === "off" || process.env.OPENAI_QUERY_PLANNER === "false") return "OPENAI_QUERY_PLANNER is disabled.";
  return null;
}

async function requestOpenAiPlan(query: string, explicitFilters: DomainSearchFilters): Promise<ModelQueryPlan> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENAI_QUERY_TIMEOUT_MS ?? 6000));
  const model = getOpenAiModel();
  try {
    return await traceAsync(
      "planner.openai.responses",
      genAiAttributes("openai", "query_plan", model, {
        "planner.explicit_filters": Object.keys(compactFilters(explicitFilters)).join(","),
        "planner.query_length": query.length
      }),
      async () => {
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model,
            input: [
              {
                role: "system",
                content:
                  [
                    "You are a query router for a video intelligence platform with optional related knowledge attached to the selected asset group. Return only JSON matching the provided schema exactly.",
                "Choose route only by evidence source: asset_evidence for indexed video evidence, knowledge_seeded_asset_evidence when selected related knowledge must first resolve a ranking/stat subject and then indexed video evidence should retrieve moments for that subject, knowledge_evidence for a direct answer from selected related knowledge, asset_catalog for asset/group lookup, unsupported when neither indexed assets nor selected related knowledge can answer. Do not encode domain names such as sports in route.",
                "Choose responseMode by answer shape: moment_retrieval for finding scenes/clips, grounded_answer for answering a question from retrieved video evidence, summary for summaries, analysis for pattern/comparison reasoning, structured_answer for structured related-knowledge facts, asset_lookup for catalog queries.",
                "Questions asking what appears in the selected video, what a person/object looks like, what someone is wearing, or asking describe/explain/what/which/how about visible video content are asset_evidence + grounded_answer + none. Low confidence or incomplete evidence is not unsupported; retrieval should run and the answer can report evidence gaps.",
                "Use unsupported only for requests that cannot be answered from indexed asset evidence or selected related knowledge at all, such as external current events, web lookup, weather, or unrelated general knowledge. Invalid combinations include unsupported + grounded_answer, unsupported + summary, and unsupported + analysis.",
                "Choose relatedKnowledgeMode only by how selected related knowledge is used: none, grounding, or direct_answer. Domain filters are structured asset-evidence constraints and may be used with relatedKnowledgeMode=none when supported by explicit wording, participant semantics, caller filters, or selected related-knowledge context. Do not invent statistics or facts.",
                "For sports statistics, set statMode to leaderboard when the user asks for the top/ranking/leader, player_total when the user asks for a specific player's total, otherwise null. Do not rely on route alone to imply this.",
                "For analysis questions, set analysisSubject to the normalized subject being analyzed when the user names one. For example, a player, team, object, or person visible in the requested video evidence.",
                "When the user asks for a named entity participating in an action, use participants to preserve semantic direction. relation=action_source means the entity initiates the action, relation=action_target means the entity receives or is targeted by the action, subject means the entity is only the topic. Set a concrete role only when the role follows from that semantic direction and the action; otherwise use any or null. Do not derive participant roles from language-specific keyword rules.",
                "Return filterEvidence for every inferred structured filter or analysis/stat subject. Each key must contain the exact short phrase or planner rationale that justifies the value. ExplicitFilters supplied by the caller do not need filterEvidence.",
                "Always build retrieval fields for the search engine. For non-English queries, retrieval.evidenceTerms must include both original-language literal evidence terms and English aliases. Evidence terms are concrete observable concepts only, never command words such as find, show, search, scene, video, clip, appears, or shown.",
                "Use retrieval.requiredEvidence for hard constraints that must be present in a specific evidence source. For visible text/OCR/subtitle/logo text requests, set requiredEvidence to [{kind:'visible_text', terms:['literal text'], match:'all'}]. For spoken dialogue requests such as says/speaks/said/uttered or Korean 말하는/라고 말, set requiredEvidence to [{kind:'spoken_text', terms:['literal phrase','direct translation alias'], match:'any'}]. If the user quotes a phrase or uses X라고 말, preserve the literal phrase and do not broaden it to same-language paraphrases. Use broader polite/casual/stem variants only when the user asks for a concept such as thank-you expressions rather than an exact utterance. Source labels such as OCR, subtitle, caption, logo, speech, ASR, transcript, or visible text are evidence channels, not required literal terms."
                  ].join(" ")
              },
              {
                role: "user",
                content: JSON.stringify({
                  currentDate: currentPlannerDate(),
                  defaultFootballSeasonRule: defaultFootballSeasonRule(),
                  allowed: allowedPlannerValues(),
                  knownCompetitions: getKnowledgeSnapshot().competitions.map((competition) => competition.value),
                  knownPlayers: knownPlayersForPrompt(),
                  explicitFilters,
                  query,
                  outputShape: {
                route: "asset_evidence | knowledge_seeded_asset_evidence | knowledge_evidence | asset_catalog | unsupported",
                responseMode: "moment_retrieval | grounded_answer | summary | analysis | structured_answer | asset_lookup",
                relatedKnowledgeMode: "none | grounding | direct_answer",
                metric: "goals | assists | appearances | minutes | cards | points | touchdowns | passing_yards | passing_touchdowns | rushing_yards | receiving_yards | sacks | interceptions | null",
                statMode: "leaderboard | player_total | null",
                analysisSubject: "normalized subject for analysis | null",
                competition: "string | null",
                season: "string | null",
                player: "canonical player name | null",
                eventType: "string | null",
                passType: "string | null",
                fieldZone: "string | null",
                role: "null (deprecated; participant roles must be represented in participants)",
                participants: [
                  {
                    entity: "canonical entity or player name",
                    relation: "action_source | action_target | subject | unknown",
                    role: "receiver | passer | shooter | any | null",
                    eventType: "string | null",
                    evidence: ["short semantic rationale, not keyword-matching code"]
                  }
                ],
                semanticQuery: "English retrieval query",
                retrieval: {
                  textQuery: "normalized text retrieval query for multilingual semantic embeddings",
                  visualQuery: "concise English visual retrieval prompt for OpenCLIP",
                  evidenceTerms: [
                    "only concrete evidence concepts that should appear in indexed ASR/OCR/VLM text; include original-language literals and English aliases for non-English queries; exclude command words like find/show/search/scene/video/appears/shown"
                  ],
                  requiredEvidence: [
                    {
                      kind: "visible_text | spoken_text",
                      terms: ["literal required text and direct translation aliases, for example 미소 or 고마워/thank you"],
                      match: "all | any"
                    }
                  ]
                },
                filterEvidence: {
                  competition: ["short evidence for inferred competition"],
                  season: ["short evidence for inferred season"],
                  player: ["short evidence for inferred player"],
                  eventType: ["short evidence for inferred event type"],
                  passType: ["short evidence for inferred pass type"],
                  fieldZone: ["short evidence for inferred field zone"],
                  role: ["short evidence for inferred role"],
                  statMode: ["short evidence for stat answer kind"],
                  analysisSubject: ["short evidence for analysis subject"]
                },
                confidence: "0..1",
                warnings: ["short caveats"]
              }
                })
              }
            ],
            text: {
              format: {
                type: "json_schema",
                name: "arion_query_plan",
                strict: true,
                schema: openAiQueryPlannerSchema
              }
            },
            temperature: 0.1,
            max_output_tokens: 900
          })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : `OpenAI HTTP ${response.status}`);
        return parseOpenAiJson(extractResponseText(body));
      },
      "planner.openai.responses"
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function requestVlmPlan(query: string, explicitFilters: DomainSearchFilters): Promise<{ model: string; plan: ModelQueryPlan }> {
  const result = await planQueryWithVlmWorker({
    query,
    explicitFilters,
    allowed: allowedPlannerValues(),
    knownCompetitions: getKnowledgeSnapshot().competitions.map((competition) => competition.value),
    knownPlayers: knownPlayersForPrompt(),
    currentDate: currentPlannerDate(),
    defaultFootballSeasonRule: defaultFootballSeasonRule()
  });
  return {
    model: result.model,
    plan: result.plan as ModelQueryPlan
  };
}

function mergeModelPlan(
  base: DomainQueryPlan,
  llm: ModelQueryPlan,
  explicitFilters: DomainSearchFilters,
  planner: { source: Exclude<PlannerSource, "unavailable">; model: string | null; fallbackReason?: string; warnings?: string[] }
): DomainQueryPlan {
  const explicit = compactFilters(explicitFilters);
  const filterEvidence = { ...(base.filterEvidence ?? {}), ...sanitizeFilterEvidence(llm.filterEvidence) };
  const participants = sanitizeParticipantConstraints(llm.participants ?? llm.participantConstraints, base.originalQuery);
  const directFilters = compactFilters({
    competition: resolveCompetition(llm.competition),
    season: stringOrUndefined(llm.season),
    player: resolvePlayer(llm.player),
    eventType: allowedValue(llm.eventType, allowedEventTypes),
    passType: allowedValue(llm.passType, allowedPassTypes),
    fieldZone: allowedValue(llm.fieldZone, allowedFieldZones)
  });
  const participantFilters = participantDomainFilters(participants, directFilters.player);
  applyParticipantFilterEvidence(filterEvidence, participants, participantFilters);
  const llmFilters = compactFilters({ ...directFilters, ...participantFilters });
  const normalizationWarnings: string[] = [];
  const statMode = (allowedValue(llm.statMode, allowedStatModes) as DomainQueryPlan["intent"]["statMode"] | undefined) ?? null;
  const analysisSubject = stringOrUndefined(llm.analysisSubject) ?? null;
  const metric = normalizeMetricForCompetition(
    (allowedValue(llm.metric, allowedMetrics) as DomainQueryPlan["intent"]["metric"] | undefined) ?? base.intent.metric ?? null,
    llmFilters.competition ?? explicit.competition ?? base.domainFilters.competition
  );
  const legacyPlan = legacyRoutePlan(llm.route);
  const llmRoute = allowedValue(llm.route, allowedRoutes) as DomainQueryPlan["route"] | undefined;
  let route = llmRoute ?? legacyPlan?.route ?? base.route;
  let responseMode =
    (allowedValue(llm.responseMode, allowedResponseModes) as DomainQueryPlan["responseMode"] | undefined) ??
    legacyPlan?.responseMode ??
    responseModeFromLegacyQuestionType(llm.questionType, metric) ??
    defaultResponseModeForRoute(route);
  let relatedKnowledgeMode =
    (allowedValue(llm.relatedKnowledgeMode, allowedRelatedKnowledgeModes) as DomainQueryPlan["relatedKnowledgeMode"] | undefined) ??
    legacyPlan?.relatedKnowledgeMode ??
    defaultRelatedKnowledgeModeForRoute(route);
  if (shouldPreserveAssetEvidencePlan(route, responseMode, llm)) {
    route = "asset_evidence";
    responseMode = responseMode === "summary" || responseMode === "analysis" || responseMode === "grounded_answer" ? responseMode : "moment_retrieval";
    relatedKnowledgeMode = "none";
  }
  const statSeededRetrieval =
    route !== "unsupported" &&
    metric &&
    statMode === "leaderboard" &&
    (route === "knowledge_seeded_asset_evidence" || (responseMode !== "structured_answer" && hasVideoMomentRetrievalIntent(base.originalQuery)));
  if (statSeededRetrieval) {
    route = "knowledge_seeded_asset_evidence";
    responseMode = "moment_retrieval";
    relatedKnowledgeMode = "grounding";
  }
  if (!statSeededRetrieval && route === "knowledge_evidence" && responseMode !== "structured_answer") {
    route = responseMode === "asset_lookup" ? "asset_catalog" : "asset_evidence";
    relatedKnowledgeMode = relatedKnowledgeMode === "direct_answer" ? "grounding" : relatedKnowledgeMode;
    normalizationWarnings.push("Normalized non-structured knowledge route to an indexed asset route.");
  }
  if (!statSeededRetrieval && route !== "unsupported" && metric && statMode === "leaderboard") {
    route = "knowledge_evidence";
    responseMode = "structured_answer";
    relatedKnowledgeMode = "direct_answer";
  }
  if (route !== "unsupported" && hasActiveDomainFilters(explicit) && relatedKnowledgeMode === "none") {
    route = "asset_evidence";
    responseMode = responseMode === "asset_lookup" || responseMode === "structured_answer" ? "moment_retrieval" : responseMode;
  }
  if (route !== "unsupported" && responseMode === "structured_answer" && !metric && hasActiveDomainFilters({ ...base.domainFilters, ...llmFilters, ...explicit })) {
    route = "asset_evidence";
    responseMode = "moment_retrieval";
    relatedKnowledgeMode = "none";
  }
  if (route !== "unsupported" && route !== "knowledge_evidence" && responseMode === "structured_answer" && !metric) {
    route = "asset_evidence";
    responseMode = "grounded_answer";
    relatedKnowledgeMode = "none";
  }
  const rawDomainFilters = compactFilters(
    responseMode === "structured_answer"
      ? {
          ...base.domainFilters,
          ...llmFilters,
          ...explicit,
          eventType: undefined,
          passType: undefined,
          fieldZone: undefined,
          role: undefined
        }
      : { ...base.domainFilters, ...llmFilters, ...explicit }
  );
  const sanitizedFilters = sanitizeInferredFilters(rawDomainFilters, {
    route,
    responseMode,
    relatedKnowledgeMode,
    explicitFilters: explicit,
    filterEvidence,
    originalQuery: base.originalQuery
  });
  const domainFilters = sanitizedFilters.filters;
  const semanticQuery = !llmRoute && !legacyPlan && hasActiveDomainFilters(base.domainFilters) && !hasActiveDomainFilters(llmFilters) ? base.semanticQuery : selectSemanticQuery(llm.semanticQuery, base);
  const llmRequiredEvidence = sanitizeRequiredEvidence(llm.retrieval?.requiredEvidence ?? []);
  const llmEvidenceTerms = sanitizeEvidenceTerms(llm.retrieval?.evidenceTerms ?? []);
  const retrieval = buildRetrievalPlan(base.originalQuery, semanticQuery, {
    textQuery: llm.retrieval?.textQuery ?? base.retrieval?.textQuery ?? semanticQuery,
    visualQuery: llm.retrieval?.visualQuery ?? base.retrieval?.visualQuery ?? semanticQuery,
    evidenceTerms: llmEvidenceTerms.length > 0 ? llmEvidenceTerms : base.retrieval?.evidenceTerms ?? [],
    requiredEvidence: llmRequiredEvidence.length > 0 ? llmRequiredEvidence : base.retrieval?.requiredEvidence ?? []
  });
  const llmConfidence = normalizedConfidence(llm.confidence, base.confidence);
  const confidence = route === base.route && !llmRoute ? Math.max(base.confidence, llmConfidence) : llmConfidence;
  const llmWarnings = Array.isArray(llm.warnings)
    ? llm.warnings.filter((warning) => typeof warning === "string" && warning.trim() && !/knownPlayers|provided/i.test(warning))
    : [];
  return {
    ...base,
    semanticQuery,
    rewrittenQuery: buildRewrittenQuery(domainFilters, semanticQuery),
    retrieval,
    filterEvidence,
    domainFilters,
    route,
    responseMode,
    relatedKnowledgeMode,
    intent: {
      ...base.intent,
      domain: Object.keys(domainFilters).length > 0 ? domainFromFilters(domainFilters) : null,
      questionType: responseMode,
      metric: responseMode === "structured_answer" || route === "knowledge_seeded_asset_evidence" ? metric : null,
      statMode: responseMode === "structured_answer" || route === "knowledge_seeded_asset_evidence" ? statMode : null,
      analysisSubject: responseMode === "analysis" ? analysisSubject : null,
      participants,
      eventType: domainFilters.eventType ?? null,
      passType: domainFilters.passType ?? null,
      fieldZone: domainFilters.fieldZone ?? null,
      player: domainFilters.player ?? null,
      role: domainFilters.role ?? null,
      catalogKey: domainFilters.catalogKey ?? null,
      performer: domainFilters.performer ?? null,
      studio: domainFilters.studio ?? null,
      label: domainFilters.label ?? null,
      series: domainFilters.series ?? null,
      genre: domainFilters.genre ?? null,
      scene: domainFilters.scene ?? null,
      appearance: domainFilters.appearance ?? null
    },
    confidence: Number(confidence.toFixed(2)),
    warnings: [...base.warnings, ...(planner.warnings ?? []), ...normalizationWarnings, ...sanitizedFilters.warnings, ...llmWarnings],
    planner: {
      source: planner.source,
      model: planner.model,
      fallbackReason: planner.fallbackReason
    }
  };
}

function sanitizeInferredFilters(
  filters: DomainSearchFilters,
  context: {
    route: DomainQueryPlan["route"];
    responseMode: DomainQueryPlan["responseMode"];
    relatedKnowledgeMode: DomainQueryPlan["relatedKnowledgeMode"];
    explicitFilters: DomainSearchFilters;
    filterEvidence: DomainQueryFilterEvidence;
    originalQuery: string;
  }
) {
  const { route, responseMode, relatedKnowledgeMode, explicitFilters, filterEvidence, originalQuery } = context;
  const next = { ...filters };
  if (!explicitFilters.season && !hasFilterEvidence(filterEvidence, "season")) delete next.season;
  if (!explicitFilters.fieldZone && !hasFilterEvidence(filterEvidence, "fieldZone")) delete next.fieldZone;
  if (!explicitFilters.competition && !hasFilterEvidence(filterEvidence, "competition")) delete next.competition;
  if (!explicitFilters.player && !hasFilterEvidence(filterEvidence, "player")) delete next.player;
  if (!explicitFilters.eventType && !hasFilterEvidence(filterEvidence, "eventType")) delete next.eventType;
  if (!explicitFilters.passType && !hasFilterEvidence(filterEvidence, "passType")) delete next.passType;
  if (!explicitFilters.role && !hasFilterEvidence(filterEvidence, "role")) delete next.role;
  if (!explicitFilters.catalogKey && !hasFilterEvidence(filterEvidence, "catalogKey")) delete next.catalogKey;
  if (!explicitFilters.performer && !hasFilterEvidence(filterEvidence, "performer")) delete next.performer;
  if (!explicitFilters.studio && !hasFilterEvidence(filterEvidence, "studio")) delete next.studio;
  if (!explicitFilters.label && !hasFilterEvidence(filterEvidence, "label")) delete next.label;
  if (!explicitFilters.series && !hasFilterEvidence(filterEvidence, "series")) delete next.series;
  if (!explicitFilters.genre && !hasFilterEvidence(filterEvidence, "genre")) delete next.genre;
  if (!explicitFilters.scene && !hasFilterEvidence(filterEvidence, "scene")) delete next.scene;
  if (!explicitFilters.appearance && !hasFilterEvidence(filterEvidence, "appearance")) delete next.appearance;
  if (responseMode === "structured_answer") {
    delete next.eventType;
    delete next.passType;
    delete next.fieldZone;
    delete next.role;
  }
  const warnings: string[] = [];
  if (usesIndexedAssetEvidenceOnly(route, responseMode, relatedKnowledgeMode)) {
    const droppedScopeFilters: string[] = [];
    if (next.competition && !explicitFilters.competition && !queryMentionsCompetition(originalQuery, next.competition)) {
      droppedScopeFilters.push(`competition=${next.competition}`);
      delete next.competition;
    }
    if (next.season && !explicitFilters.season && !queryMentionsSeason(originalQuery, next.season)) {
      droppedScopeFilters.push(`season=${next.season}`);
      delete next.season;
    }
    if (droppedScopeFilters.length > 0) {
      warnings.push(`Dropped inferred scope filters not stated in the query: ${droppedScopeFilters.join(", ")}.`);
    }
  }
  return {
    filters: compactFilters(next),
    warnings
  };
}

function responseModeFromLegacyQuestionType(questionType: ModelQueryPlan["questionType"], metric: DomainQueryPlan["intent"]["metric"]) {
  if (!allowedQuestionTypes.has(String(questionType))) return undefined;
  if (questionType === "stat_qa" && metric) return "structured_answer" as const;
  if (questionType === "moment_retrieval") return "moment_retrieval" as const;
  return undefined;
}

function legacyRoutePlan(route: unknown): Pick<DomainQueryPlan, "route" | "responseMode" | "relatedKnowledgeMode"> | undefined {
  switch (route) {
    case "video_summary":
      return { route: "asset_evidence", responseMode: "summary", relatedKnowledgeMode: "none" };
    case "generic_video_qa":
      return { route: "asset_evidence", responseMode: "moment_retrieval", relatedKnowledgeMode: "none" };
    case "sports_moment_retrieval":
      return { route: "asset_evidence", responseMode: "moment_retrieval", relatedKnowledgeMode: "none" };
    case "sports_analysis":
      return { route: "asset_evidence", responseMode: "analysis", relatedKnowledgeMode: "none" };
    case "sports_stat_qa":
      return { route: "knowledge_evidence", responseMode: "structured_answer", relatedKnowledgeMode: "direct_answer" };
    case "asset_lookup":
      return { route: "asset_catalog", responseMode: "asset_lookup", relatedKnowledgeMode: "none" };
    default:
      return undefined;
  }
}

function hasActiveDomainFilters(filters: DomainSearchFilters) {
  return Boolean(
    filters.competition ||
      filters.player ||
      filters.eventType ||
      filters.passType ||
      filters.fieldZone ||
      (filters.role && filters.role !== "any") ||
      filters.catalogKey ||
      filters.performer ||
      filters.studio ||
      filters.label ||
      filters.series ||
      filters.genre ||
      filters.scene ||
      filters.appearance
  );
}

function hasVideoMomentRetrievalIntent(query: string) {
  return /장면|영상|클립|하이라이트|순간|나오는|보이는|찾아|보여|scene|clip|moment|highlight|footage|video|find|show/i.test(query);
}

function sanitizeParticipantConstraints(value: unknown, originalQuery: string): DomainParticipantConstraint[] {
  if (!Array.isArray(value)) return [];
  const participants: DomainParticipantConstraint[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawEntity = stringOrUndefined(record.entity) ?? stringOrUndefined(record.player) ?? stringOrUndefined(record.name);
    if (!rawEntity) continue;
    const entity = resolvePlayer(rawEntity) ?? rawEntity;
    if (!queryMentionsParticipantEntity(originalQuery, rawEntity, entity)) continue;
    const rawEventType = allowedValue(record.eventType, allowedEventTypes);
    const rawRole = allowedValue(record.role, allowedRoles) as DomainSearchFilters["role"] | undefined;
    const relation = (allowedValue(record.relation, allowedParticipantRelations) as DomainParticipantConstraint["relation"] | undefined) ?? "unknown";
    const role = participantRole(rawRole, relation, rawEventType);
    const eventType = participantEventType(rawEventType, role);
    const evidence = stringList(record.evidence, 4);
    if (evidence.length === 0) continue;
    participants.push({
      entity,
      relation,
      role,
      eventType,
      evidence
    });
  }
  return participants.slice(0, 4);
}

function queryMentionsParticipantEntity(query: string, rawEntity: string, resolvedEntity: string) {
  const normalizedQuery = normalizePlannerText(query);
  const knownPlayer = matchKnowledgePlayer(rawEntity)?.value ?? matchKnowledgePlayer(resolvedEntity)?.value;
  if (knownPlayer) {
    return knownPlayer.aliases.some((alias) => {
      const normalized = normalizePlannerText(alias);
      return Boolean(normalized && normalizedQuery.includes(normalized));
    });
  }
  return meaningfulEntityTokens(rawEntity, resolvedEntity).some((token) => normalizedQuery.includes(token));
}

function meaningfulEntityTokens(...values: string[]) {
  const generic = new Set(["a", "an", "the", "other", "another", "player", "teammate", "someone", "somebody", "선수", "다른"]);
  return values
    .flatMap((value) => normalizePlannerText(value).split(/[\s._-]+/))
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !generic.has(token));
}

function participantRole(
  role: DomainSearchFilters["role"] | undefined,
  relation: DomainParticipantConstraint["relation"],
  eventType: string | undefined
): DomainParticipantConstraint["role"] {
  if (role && role !== "any") return role;
  if (eventType === "pass_receive" && relation === "action_source") return "passer";
  if (eventType === "pass_receive" && relation === "action_target") return "receiver";
  if (eventType === "shot" && (relation === "action_source" || relation === "subject")) return "shooter";
  return "any";
}

function participantEventType(eventType: string | undefined, role: DomainParticipantConstraint["role"]) {
  if (eventType) return eventType;
  if (role === "passer" || role === "receiver") return "pass_receive";
  if (role === "shooter") return "shot";
  return null;
}

function participantDomainFilters(participants: DomainParticipantConstraint[], plannedPlayer: string | undefined): DomainSearchFilters {
  const participant = participants.find((item) => {
    if (!plannedPlayer) return item.role !== "any";
    return sameEntity(item.entity, plannedPlayer) && item.role !== "any";
  });
  if (!participant) return {};
  return compactFilters({
    player: plannedPlayer ?? participant.entity,
    role: participant.role === "any" ? undefined : participant.role,
    eventType: participant.eventType ?? undefined
  });
}

function applyParticipantFilterEvidence(
  filterEvidence: DomainQueryFilterEvidence,
  participants: DomainParticipantConstraint[],
  filters: DomainSearchFilters
) {
  if (participants.length === 0 || !hasActiveDomainFilters(filters)) return;
  const participant = participants.find((item) => (filters.player ? sameEntity(item.entity, filters.player) : true) && (!filters.role || item.role === filters.role));
  if (!participant) return;
  const evidence = participant.evidence.length > 0 ? participant.evidence : [`Participant ${participant.entity} is ${participant.relation}.`];
  if (filters.player && !filterEvidence.player) filterEvidence.player = [`Participant entity: ${participant.entity}.`];
  if (filters.role && !filterEvidence.role) filterEvidence.role = evidence;
  if (filters.eventType && !filterEvidence.eventType) filterEvidence.eventType = evidence;
}

function sameEntity(left: string, right: string) {
  const normalizedLeft = normalizePlannerText(left);
  const normalizedRight = normalizePlannerText(right);
  return Boolean(normalizedLeft && normalizedRight && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)));
}

function sanitizeFilterEvidence(value: unknown): DomainQueryFilterEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const keys: Array<keyof DomainQueryFilterEvidence> = [
    "competition",
    "season",
    "player",
    "eventType",
    "passType",
    "fieldZone",
    "role",
    "catalogKey",
    "performer",
    "studio",
    "label",
    "series",
    "genre",
    "scene",
    "appearance",
    "statMode",
    "analysisSubject"
  ];
  const entries = keys
    .map((key) => {
      const evidence = stringList(source[key], 6);
      return evidence.length > 0 ? [key, evidence] : null;
    })
    .filter((entry): entry is [keyof DomainQueryFilterEvidence, string[]] => Boolean(entry));
  return Object.fromEntries(entries) as DomainQueryFilterEvidence;
}

function hasFilterEvidence(evidence: DomainQueryFilterEvidence, key: keyof DomainSearchFilters) {
  return (evidence[key]?.length ?? 0) > 0;
}

function usesIndexedAssetEvidenceOnly(
  route: DomainQueryPlan["route"],
  responseMode: DomainQueryPlan["responseMode"],
  relatedKnowledgeMode: DomainQueryPlan["relatedKnowledgeMode"]
) {
  return route === "asset_evidence" && relatedKnowledgeMode === "none" && isAssetEvidenceGenerationMode(responseMode);
}

function queryMentionsCompetition(query: string, competition: string) {
  const normalizedQuery = normalizePlannerText(query);
  const matched = matchKnowledgeCompetition(competition)?.value;
  const aliases = getKnowledgeSnapshot().competitions
    .filter((candidate) => candidate.value === (matched ?? competition))
    .flatMap((candidate) => [candidate.value, ...candidate.aliases]);
  const candidates = [...aliases, ...(fallbackCompetitionAliases[matched ?? competition] ?? [competition])];
  return candidates.some((candidate) => {
    const normalized = normalizePlannerText(candidate);
    return Boolean(normalized && normalizedQuery.includes(normalized));
  });
}

function queryMentionsSeason(query: string, season: string) {
  const normalizedQuery = normalizePlannerText(query).replace(/[–—]/g, "-");
  const normalizedSeason = normalizePlannerText(season).replace(/[–—]/g, "-");
  if (normalizedSeason && normalizedQuery.includes(normalizedSeason)) return true;
  if (mentionsRelativeSeason(normalizedQuery)) return true;
  const seasonRange = /^(\d{4})-(\d{2})$/.exec(normalizedSeason);
  if (seasonRange) {
    const [, startYear, endYearSuffix] = seasonRange;
    const fullEndYear = `${startYear.slice(0, 2)}${endYearSuffix}`;
    return [
      `${startYear}/${endYearSuffix}`,
      `${startYear}-${fullEndYear}`,
      `${startYear}/${fullEndYear}`
    ].some((candidate) => normalizedQuery.includes(candidate));
  }
  return Boolean(normalizedSeason && normalizedQuery.includes(normalizedSeason));
}

function mentionsRelativeSeason(normalizedQuery: string) {
  return /이번\s*시즌|올\s*시즌|현재\s*시즌|current\s+season|this\s+season/.test(normalizedQuery);
}

function shouldPreserveAssetEvidencePlan(route: DomainQueryPlan["route"], responseMode: DomainQueryPlan["responseMode"], llm: ModelQueryPlan) {
  if (route !== "unsupported") return false;
  return hasRetrievalPlan(llm) && isAssetEvidenceGenerationMode(responseMode);
}

function isAssetEvidenceGenerationMode(responseMode: DomainQueryPlan["responseMode"]) {
  return responseMode === "moment_retrieval" || responseMode === "grounded_answer" || responseMode === "summary" || responseMode === "analysis";
}

function hasRetrievalPlan(plan: ModelQueryPlan) {
  return Boolean(
    stringOrUndefined(plan.retrieval?.textQuery) ||
      stringOrUndefined(plan.retrieval?.visualQuery) ||
      sanitizeEvidenceTerms(plan.retrieval?.evidenceTerms ?? []).length > 0 ||
      sanitizeRequiredEvidence(plan.retrieval?.requiredEvidence ?? []).length > 0
  );
}

function normalizeMetricForCompetition(
  metric: DomainQueryPlan["intent"]["metric"] | null,
  competition: string | undefined
): DomainQueryPlan["intent"]["metric"] | null {
  if (competition === "NFL" && metric === "goals") return "points";
  return metric;
}

function normalizedConfidence(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(0.94, numeric));
}

function selectSemanticQuery(value: unknown, base: DomainQueryPlan) {
  const next = stringOrUndefined(value);
  if (!next) return base.semanticQuery;
  const normalizedNext = normalizePlannerText(next);
  const normalizedOriginal = normalizePlannerText(base.originalQuery);
  if (normalizedNext === normalizedOriginal && normalizePlannerText(base.semanticQuery) !== normalizedOriginal) return base.semanticQuery;
  return next;
}

function normalizePlannerText(value: string) {
  return value.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
}

function parseOpenAiJson(text: string): ModelQueryPlan {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("OpenAI planner returned non-object JSON");
  return parsed as ModelQueryPlan;
}

function extractResponseText(body: unknown): string {
  if (typeof body !== "object" || body === null) throw new Error("OpenAI planner returned an invalid response");
  const response = body as { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> };
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  const text = response.output?.flatMap((item) => item.content ?? []).map((content) => content.text).find((value) => typeof value === "string" && value.trim());
  if (typeof text === "string") return text;
  throw new Error("OpenAI planner returned no text");
}

function resolvePlayer(value: string | null | undefined) {
  if (!value) return undefined;
  const knownPlayer = matchKnowledgePlayer(value)?.value;
  if (knownPlayer) return knownPlayer.canonical;
  return stringOrUndefined(value);
}

function knownPlayersForPrompt() {
  return getKnowledgeSnapshot().players.slice(0, 50).map((player) => ({
    canonical: player.canonical,
    aliases: player.aliases.slice(0, 8),
    league: player.league
  }));
}

function resolveCompetition(value: string | null | undefined) {
  if (!value) return undefined;
  return matchKnowledgeCompetition(value)?.value ?? stringOrUndefined(value);
}

function allowedValue<T extends string>(value: unknown, allowed: Set<T>) {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : undefined;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringOrUndefined(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}

function compactFilters(filters: DomainSearchFilters): DomainSearchFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => typeof value === "string" && value.trim().length > 0)) as DomainSearchFilters;
}

function buildRewrittenQuery(filters: DomainSearchFilters, semanticQuery: string) {
  const parts = [
    filters.competition ? `competition=${filters.competition}` : "",
    filters.season ? `season=${filters.season}` : "",
    filters.player ? `player=${filters.player}` : "",
    filters.role ? `role=${filters.role}` : "",
    filters.eventType ? `event=${filters.eventType}` : "",
    filters.passType ? `pass=${filters.passType}` : "",
    filters.fieldZone ? `zone=${filters.fieldZone}` : "",
    filters.catalogKey ? `catalog=${filters.catalogKey}` : "",
    filters.performer ? `performer=${filters.performer}` : "",
    filters.studio ? `studio=${filters.studio}` : "",
    filters.label ? `label=${filters.label}` : "",
    filters.series ? `series=${filters.series}` : "",
    filters.genre ? `genre=${filters.genre}` : "",
    filters.scene ? `scene=${filters.scene}` : "",
    filters.appearance ? `appearance=${filters.appearance}` : ""
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : semanticQuery || "No structured query";
}

function domainFromFilters(filters: DomainSearchFilters) {
  if (filters.catalogKey || filters.performer || filters.studio || filters.label || filters.series || filters.genre || filters.scene || filters.appearance) return "adult.jp_search";
  if (filters.competition === "NFL" || ["scramble", "pocket_escape", "throw_on_run", "pressure"].includes(filters.eventType ?? "")) return "sports.american_football";
  return "sports.football";
}

function buildNeutralQueryPlan(query: string, explicitFilters: DomainSearchFilters): DomainQueryPlan {
  const originalQuery = query.trim();
  const semanticQuery = originalQuery;
  const domainFilters = compactFilters(explicitFilters);
  return {
    originalQuery,
    semanticQuery,
    rewrittenQuery: semanticQuery || "No structured query",
    retrieval: buildRetrievalPlan(originalQuery, semanticQuery, {
      textQuery: semanticQuery,
      visualQuery: semanticQuery,
      evidenceTerms: [],
      requiredEvidence: []
    }),
    filterEvidence: {},
    domainFilters,
    route: "unsupported",
    responseMode: "structured_answer",
    relatedKnowledgeMode: "none",
    intent: {
      domain: null,
      questionType: "structured_answer",
      metric: null,
      statMode: null,
      analysisSubject: null,
      eventType: null,
      passType: null,
      fieldZone: null,
      player: null,
      role: null
    },
    confidence: originalQuery ? 0.01 : 0,
    warnings: []
  };
}

function plannerUnavailable(query: string, explicitFilters: DomainSearchFilters, warnings: string[], fallbackReason: string): DomainQueryPlan {
  const plan = buildNeutralQueryPlan(query, explicitFilters);
  return {
    ...plan,
    warnings,
    planner: {
      source: "unavailable",
      model: null,
      fallbackReason
    }
  };
}

function defaultResponseModeForRoute(route: DomainQueryPlan["route"]): DomainQueryPlan["responseMode"] {
  switch (route) {
    case "asset_evidence":
    case "knowledge_seeded_asset_evidence":
      return "moment_retrieval";
    case "knowledge_evidence":
      return "structured_answer";
    case "asset_catalog":
      return "asset_lookup";
    case "unsupported":
      return "structured_answer";
  }
}

function defaultRelatedKnowledgeModeForRoute(route: DomainQueryPlan["route"]): DomainQueryPlan["relatedKnowledgeMode"] {
  switch (route) {
    case "knowledge_evidence":
      return "direct_answer";
    case "knowledge_seeded_asset_evidence":
      return "grounding";
    case "asset_evidence":
    case "asset_catalog":
    case "unsupported":
      return "none";
  }
}

function allowedPlannerValues() {
  return {
    route: Array.from(allowedRoutes),
    responseMode: Array.from(allowedResponseModes),
    relatedKnowledgeMode: Array.from(allowedRelatedKnowledgeModes),
    legacyQuestionType: ["moment_retrieval", "stat_qa"],
    metric: Array.from(allowedMetrics),
    statMode: Array.from(allowedStatModes),
    eventType: Array.from(allowedEventTypes),
    passType: Array.from(allowedPassTypes),
    fieldZone: Array.from(allowedFieldZones),
    role: Array.from(allowedRoles),
    participantRelation: Array.from(allowedParticipantRelations),
    requiredEvidenceKind: ["visible_text", "spoken_text"]
  };
}

function currentPlannerDate() {
  return new Date().toISOString().slice(0, 10);
}

function defaultFootballSeasonRule() {
  return "For Premier League, current season is YYYY-YY starting in July. In May 2026 this is 2025-26.";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}

function cacheKeyFor(query: string, explicitFilters: DomainSearchFilters) {
  return JSON.stringify({ query: query.trim(), explicitFilters: compactFilters(explicitFilters) });
}

function getOpenAiModel() {
  return process.env.OPENAI_QUERY_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
}
