import type { DomainQueryFilterEvidence, DomainQueryPlan, DomainSearchFilters } from "../shared/types";
import { buildRetrievalPlan, sanitizeEvidenceTerms, sanitizeRequiredEvidence } from "./queryRetrievalPlan";
import { getKnowledgeSnapshot, matchKnowledgeCompetition, matchKnowledgePlayer } from "./knowledge/registry";
import { planQueryWithVlmWorker } from "./vlmWorkerClient";

type ModelQueryPlan = {
  route?: string;
  responseMode?: string;
  knowledgeMode?: string;
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
const allowedKnowledgeModes = new Set<DomainQueryPlan["knowledgeMode"]>(["none", "grounding", "direct_answer"]);
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
const allowedStatModes = new Set(["leaderboard", "player_total"]);
const allowedEventTypes = new Set(["pass_receive", "shot", "dribble", "progressive_pass", "save", "pressure", "scramble", "pocket_escape", "throw_on_run"]);
const allowedPassTypes = new Set(["through_ball", "cross", "cutback"]);
const allowedFieldZones = new Set(["final_third", "penalty_area", "middle_third", "defensive_third"]);

export async function planDomainQueryWithLlm(query: string, explicitFilters: DomainSearchFilters = {}): Promise<DomainQueryPlan> {
  const base = buildNeutralQueryPlan(query, explicitFilters);
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
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: getOpenAiModel(),
        input: [
          {
            role: "system",
            content:
              [
                "You are a query router for a video intelligence platform with optional related knowledge attached to the selected asset group. Return only JSON.",
                "Choose route only by evidence source: asset_evidence for indexed video evidence, knowledge_seeded_asset_evidence when selected related knowledge must first resolve a ranking/stat subject and then indexed video evidence should retrieve moments for that subject, knowledge_evidence for a direct answer from selected related knowledge, asset_catalog for asset/group lookup, unsupported when neither indexed assets nor selected related knowledge can answer. Do not encode domain names such as sports in route.",
                "Choose responseMode by answer shape: moment_retrieval for finding scenes/clips, grounded_answer for answering a question from retrieved video evidence, summary for summaries, analysis for pattern/comparison reasoning, structured_answer for structured related-knowledge facts, asset_lookup for catalog queries.",
                "Questions asking what appears in the selected video, what a person/object looks like, what someone is wearing, or asking describe/explain/what/which/how about visible video content are asset_evidence + grounded_answer + none. Low confidence or incomplete evidence is not unsupported; retrieval should run and the answer can report evidence gaps.",
                "Use unsupported only for requests that cannot be answered from indexed asset evidence or selected related knowledge at all, such as external current events, web lookup, weather, or unrelated general knowledge. Invalid combinations include unsupported + grounded_answer, unsupported + summary, and unsupported + analysis.",
                "Choose knowledgeMode by how related knowledge is used: none, grounding, or direct_answer. Extract structured constraints only when supported by the selected related-knowledge context or explicit wording, and do not invent statistics or facts.",
                "For sports statistics, set statMode to leaderboard when the user asks for the top/ranking/leader, player_total when the user asks for a specific player's total, otherwise null. Do not rely on route alone to imply this.",
                "For analysis questions, set analysisSubject to the normalized subject being analyzed when the user names one. For example, a player, team, object, or person visible in the requested video evidence.",
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
                knowledgeMode: "none | grounding | direct_answer",
                metric: "goals | assists | appearances | minutes | cards | points | touchdowns | passing_yards | passing_touchdowns | rushing_yards | receiving_yards | sacks | interceptions | null",
                statMode: "leaderboard | player_total | null",
                analysisSubject: "normalized subject for analysis | null",
                competition: "string | null",
                season: "string | null",
                player: "canonical player name | null",
                eventType: "string | null",
                passType: "string | null",
                fieldZone: "string | null",
                role: "receiver | passer | shooter | any | null",
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
            type: "json_object"
          }
        },
        temperature: 0.1,
        max_output_tokens: 700
      })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : `OpenAI HTTP ${response.status}`);
    return parseOpenAiJson(extractResponseText(body));
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
  const filterEvidence = sanitizeFilterEvidence(llm.filterEvidence);
  const llmFilters = compactFilters({
    competition: resolveCompetition(llm.competition),
    season: stringOrUndefined(llm.season),
    player: resolvePlayer(llm.player),
    eventType: allowedValue(llm.eventType, allowedEventTypes),
    passType: allowedValue(llm.passType, allowedPassTypes),
    fieldZone: allowedValue(llm.fieldZone, allowedFieldZones),
    role: allowedValue(llm.role, allowedRoles) as DomainSearchFilters["role"] | undefined
  });
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
  let knowledgeMode =
    (allowedValue(llm.knowledgeMode, allowedKnowledgeModes) as DomainQueryPlan["knowledgeMode"] | undefined) ??
    legacyPlan?.knowledgeMode ??
    defaultKnowledgeModeForRoute(route);
  const normalizationWarnings: string[] = [];
  if (shouldPreserveAssetEvidencePlan(route, responseMode, llm)) {
    route = "asset_evidence";
    responseMode = responseMode === "summary" || responseMode === "analysis" || responseMode === "grounded_answer" ? responseMode : "moment_retrieval";
    knowledgeMode = "none";
  }
  const statSeededRetrieval =
    route !== "unsupported" &&
    metric &&
    statMode === "leaderboard" &&
    (route === "knowledge_seeded_asset_evidence" || (responseMode !== "structured_answer" && hasVideoMomentRetrievalIntent(base.originalQuery)));
  if (statSeededRetrieval) {
    route = "knowledge_seeded_asset_evidence";
    responseMode = "moment_retrieval";
    knowledgeMode = "grounding";
  }
  if (!statSeededRetrieval && route === "knowledge_evidence" && responseMode !== "structured_answer") {
    route = responseMode === "asset_lookup" ? "asset_catalog" : "asset_evidence";
    knowledgeMode = knowledgeMode === "direct_answer" ? "grounding" : knowledgeMode;
    normalizationWarnings.push("Normalized non-structured knowledge route to an indexed asset route.");
  }
  if (!statSeededRetrieval && route !== "unsupported" && metric && statMode === "leaderboard") {
    route = "knowledge_evidence";
    responseMode = "structured_answer";
    knowledgeMode = "direct_answer";
  }
  if (route !== "unsupported" && hasActiveDomainFilters(explicit) && knowledgeMode === "none") {
    route = "asset_evidence";
    responseMode = responseMode === "asset_lookup" || responseMode === "structured_answer" ? "moment_retrieval" : responseMode;
    knowledgeMode = "grounding";
  }
  if (route !== "unsupported" && responseMode === "structured_answer" && !metric && hasActiveDomainFilters({ ...base.domainFilters, ...llmFilters, ...explicit })) {
    route = "asset_evidence";
    responseMode = "moment_retrieval";
    knowledgeMode = "grounding";
  }
  if (route !== "unsupported" && route !== "knowledge_evidence" && responseMode === "structured_answer" && !metric) {
    route = "asset_evidence";
    responseMode = "grounded_answer";
    knowledgeMode = "none";
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
      : knowledgeMode !== "none"
        ? { ...base.domainFilters, ...llmFilters, ...explicit }
        : { ...explicit }
  );
  const domainFilters = sanitizeInferredFilters(rawDomainFilters, responseMode, knowledgeMode, explicit, filterEvidence);
  const semanticQuery = !llmRoute && !legacyPlan && hasActiveDomainFilters(base.domainFilters) && !hasActiveDomainFilters(llmFilters) ? base.semanticQuery : selectSemanticQuery(llm.semanticQuery, base);
  const llmRequiredEvidence = sanitizeRequiredEvidence(llm.retrieval?.requiredEvidence ?? []);
  const retrieval = buildRetrievalPlan(base.originalQuery, semanticQuery, {
    textQuery: llm.retrieval?.textQuery ?? semanticQuery,
    visualQuery: llm.retrieval?.visualQuery ?? semanticQuery,
    evidenceTerms: sanitizeEvidenceTerms(llm.retrieval?.evidenceTerms ?? []),
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
    knowledgeMode,
    intent: {
      ...base.intent,
      domain: knowledgeMode !== "none" && Object.keys(domainFilters).length > 0 ? domainFromFilters(domainFilters) : null,
      questionType: responseMode,
      metric: responseMode === "structured_answer" || route === "knowledge_seeded_asset_evidence" ? metric : null,
      statMode: responseMode === "structured_answer" || route === "knowledge_seeded_asset_evidence" ? statMode : null,
      analysisSubject: responseMode === "analysis" ? analysisSubject : null,
      eventType: domainFilters.eventType ?? null,
      passType: domainFilters.passType ?? null,
      fieldZone: domainFilters.fieldZone ?? null,
      player: domainFilters.player ?? null,
      role: domainFilters.role ?? null
    },
    confidence: Number(confidence.toFixed(2)),
    warnings: [...base.warnings, ...(planner.warnings ?? []), ...normalizationWarnings, ...llmWarnings],
    planner: {
      source: planner.source,
      model: planner.model,
      fallbackReason: planner.fallbackReason
    }
  };
}

function sanitizeInferredFilters(
  filters: DomainSearchFilters,
  responseMode: DomainQueryPlan["responseMode"],
  knowledgeMode: DomainQueryPlan["knowledgeMode"],
  explicitFilters: DomainSearchFilters,
  filterEvidence: DomainQueryFilterEvidence
) {
  if (knowledgeMode === "none") return filters;
  const next = { ...filters };
  if (!explicitFilters.season && !hasFilterEvidence(filterEvidence, "season")) delete next.season;
  if (!explicitFilters.fieldZone && !hasFilterEvidence(filterEvidence, "fieldZone")) delete next.fieldZone;
  if (!explicitFilters.competition && !hasFilterEvidence(filterEvidence, "competition")) delete next.competition;
  if (!explicitFilters.player && !hasFilterEvidence(filterEvidence, "player")) delete next.player;
  if (!explicitFilters.eventType && !hasFilterEvidence(filterEvidence, "eventType")) delete next.eventType;
  if (!explicitFilters.passType && !hasFilterEvidence(filterEvidence, "passType")) delete next.passType;
  if (!explicitFilters.role && !hasFilterEvidence(filterEvidence, "role")) delete next.role;
  if (responseMode === "structured_answer") {
    delete next.eventType;
    delete next.passType;
    delete next.fieldZone;
    delete next.role;
  }
  return compactFilters(next);
}

function responseModeFromLegacyQuestionType(questionType: ModelQueryPlan["questionType"], metric: DomainQueryPlan["intent"]["metric"]) {
  if (!allowedQuestionTypes.has(String(questionType))) return undefined;
  if (questionType === "stat_qa" && metric) return "structured_answer" as const;
  if (questionType === "moment_retrieval") return "moment_retrieval" as const;
  return undefined;
}

function legacyRoutePlan(route: unknown): Pick<DomainQueryPlan, "route" | "responseMode" | "knowledgeMode"> | undefined {
  switch (route) {
    case "video_summary":
      return { route: "asset_evidence", responseMode: "summary", knowledgeMode: "none" };
    case "generic_video_qa":
      return { route: "asset_evidence", responseMode: "moment_retrieval", knowledgeMode: "none" };
    case "sports_moment_retrieval":
      return { route: "asset_evidence", responseMode: "moment_retrieval", knowledgeMode: "grounding" };
    case "sports_analysis":
      return { route: "asset_evidence", responseMode: "analysis", knowledgeMode: "grounding" };
    case "sports_stat_qa":
      return { route: "knowledge_evidence", responseMode: "structured_answer", knowledgeMode: "direct_answer" };
    case "asset_lookup":
      return { route: "asset_catalog", responseMode: "asset_lookup", knowledgeMode: "none" };
    default:
      return undefined;
  }
}

function hasActiveDomainFilters(filters: DomainSearchFilters) {
  return Boolean(filters.competition || filters.player || filters.eventType || filters.passType || filters.fieldZone || (filters.role && filters.role !== "any"));
}

function hasVideoMomentRetrievalIntent(query: string) {
  return /장면|영상|클립|하이라이트|순간|나오는|보이는|찾아|보여|scene|clip|moment|highlight|footage|video|find|show/i.test(query);
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
    filters.fieldZone ? `zone=${filters.fieldZone}` : ""
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : semanticQuery || "No structured query";
}

function domainFromFilters(filters: DomainSearchFilters) {
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
    knowledgeMode: "none",
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

function defaultKnowledgeModeForRoute(route: DomainQueryPlan["route"]): DomainQueryPlan["knowledgeMode"] {
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
    knowledgeMode: Array.from(allowedKnowledgeModes),
    legacyQuestionType: ["moment_retrieval", "stat_qa"],
    metric: Array.from(allowedMetrics),
    statMode: Array.from(allowedStatModes),
    eventType: Array.from(allowedEventTypes),
    passType: Array.from(allowedPassTypes),
    fieldZone: Array.from(allowedFieldZones),
    role: Array.from(allowedRoles),
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
