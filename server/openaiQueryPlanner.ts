import type { DomainQueryPlan, DomainSearchFilters } from "../shared/types";
import { isMomentSearchQuery, isStatLeaderboardQuery, planDomainQuery } from "./queryPlanner";
import { buildRetrievalPlan, sanitizeEvidenceTerms } from "./queryRetrievalPlan";
import { getSportsKnowledgeSnapshot, matchCompetition, matchKnowledgePlayer, matchKnowledgePlayers } from "./sportsKnowledge";

type OpenAiPlan = {
  route?: DomainQueryPlan["route"];
  questionType?: "moment_retrieval" | "stat_qa";
  metric?: DomainQueryPlan["intent"]["metric"];
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
  } | null;
  confidence?: number;
  warnings?: string[];
};

const planCache = new Map<string, { expiresAt: number; plan: DomainQueryPlan }>();
const allowedQuestionTypes = new Set(["moment_retrieval", "stat_qa"]);
const allowedRoutes = new Set<DomainQueryPlan["route"]>([
  "video_summary",
  "generic_video_qa",
  "sports_moment_retrieval",
  "sports_analysis",
  "sports_stat_qa",
  "asset_lookup",
  "unsupported"
]);
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
const allowedEventTypes = new Set(["pass_receive", "shot", "dribble", "progressive_pass", "save", "pressure", "scramble", "pocket_escape", "throw_on_run"]);
const allowedPassTypes = new Set(["through_ball", "cross", "cutback"]);
const allowedFieldZones = new Set(["final_third", "penalty_area", "middle_third", "defensive_third"]);
const ignoredPlayerAliases = new Set(["query", "search", "match", "video", "clip", "clips", "moment", "moments", "speed", "top", "best", "goal", "goals", "save", "saves", "play", "plays"]);

export async function planDomainQueryWithOpenAi(query: string, explicitFilters: DomainSearchFilters = {}): Promise<DomainQueryPlan> {
  const base = withPlanner(planDomainQuery(query, explicitFilters), "rules", null);
  if (!shouldUseOpenAiPlanner(query)) return base;

  const cacheKey = cacheKeyFor(query, explicitFilters);
  const cached = planCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.plan;

  try {
    const refined = mergeOpenAiPlan(base, await requestOpenAiPlan(query, explicitFilters), explicitFilters);
    planCache.set(cacheKey, { expiresAt: Date.now() + 30_000, plan: refined });
    return refined;
  } catch (error) {
    return {
      ...base,
      warnings: [...base.warnings, `OpenAI planner fallback: ${error instanceof Error ? error.message : "unknown error"}`],
      planner: {
        source: "rules",
        model: getOpenAiModel(),
        fallbackReason: error instanceof Error ? error.message : "unknown error"
      }
    };
  }
}

function shouldUseOpenAiPlanner(query: string) {
  if (!process.env.OPENAI_API_KEY) return false;
  if (process.env.OPENAI_QUERY_PLANNER === "off" || process.env.OPENAI_QUERY_PLANNER === "false") return false;
  return query.trim().length > 0;
}

async function requestOpenAiPlan(query: string, explicitFilters: DomainSearchFilters): Promise<OpenAiPlan> {
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
              "You are a query router for a video intelligence platform with optional related knowledge. Return only JSON. Choose the route from the allowed route contract, extract structured sports constraints only when the route is sports-specific, and do not invent statistics or facts. Use null when uncertain. Object, person, scene, text, speech, or visual-moment searches inside a video are generic_video_qa, not unsupported, even when they are broad or low-confidence. Use unsupported only for requests that cannot be answered from indexed video or related knowledge. Always build retrieval fields for the search engine. For non-English queries, retrieval.evidenceTerms must include both original-language literal evidence terms and English aliases. Evidence terms are concrete observable concepts only, never command words such as find, show, search, scene, video, clip, appears, or shown."
          },
          {
            role: "user",
            content: JSON.stringify({
              currentDate: new Date().toISOString().slice(0, 10),
              defaultFootballSeasonRule: "For Premier League, current season is YYYY-YY starting in July. In May 2026 this is 2025-26.",
              allowed: {
                route: Array.from(allowedRoutes),
                questionType: ["moment_retrieval", "stat_qa"],
                metric: Array.from(allowedMetrics),
                eventType: Array.from(allowedEventTypes),
                passType: Array.from(allowedPassTypes),
                fieldZone: Array.from(allowedFieldZones),
                role: Array.from(allowedRoles)
              },
              knownCompetitions: getSportsKnowledgeSnapshot().competitions.map((competition) => competition.value),
              knownPlayers: knownPlayersForPrompt(query),
              explicitFilters,
              query,
              outputShape: {
                route: "video_summary | generic_video_qa | sports_moment_retrieval | sports_analysis | sports_stat_qa | asset_lookup | unsupported",
                questionType: "moment_retrieval | stat_qa",
                metric: "goals | assists | appearances | minutes | cards | points | touchdowns | passing_yards | passing_touchdowns | rushing_yards | receiving_yards | sacks | interceptions | null",
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
                  ]
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

function mergeOpenAiPlan(base: DomainQueryPlan, llm: OpenAiPlan, explicitFilters: DomainSearchFilters): DomainQueryPlan {
  const explicit = compactFilters(explicitFilters);
  const llmFilters = compactFilters({
    competition: resolveCompetition(llm.competition),
    season: stringOrUndefined(llm.season),
    player: resolvePlayer(llm.player, base.originalQuery),
    eventType: allowedValue(llm.eventType, allowedEventTypes),
    passType: allowedValue(llm.passType, allowedPassTypes),
    fieldZone: allowedValue(llm.fieldZone, allowedFieldZones),
    role: allowedValue(llm.role, allowedRoles) as DomainSearchFilters["role"] | undefined
  });
  const metric = normalizeMetricForCompetition(
    (allowedValue(llm.metric, allowedMetrics) as DomainQueryPlan["intent"]["metric"] | undefined) ?? base.intent.metric ?? null,
    llmFilters.competition ?? explicit.competition ?? base.domainFilters.competition
  );
  const wantsLeaderboardGrounding = Boolean(metric && isStatLeaderboardQuery(base.originalQuery) && !llmFilters.player && !base.domainFilters.player);
  const llmRoute = allowedValue(llm.route, allowedRoutes) as DomainQueryPlan["route"] | undefined;
  let route = llmRoute ?? routeFromLegacyQuestionType(llm.questionType, metric) ?? base.route;
  if (route === "unsupported" && isMomentSearchQuery(base.originalQuery) && hasRetrievalPlan(llm)) route = "generic_video_qa";
  if (!llmRoute && hasActiveSportsFilters(base.domainFilters) && !hasActiveSportsFilters(llmFilters) && !isSportsRoute(route)) route = base.route;
  if (route !== "unsupported" && wantsLeaderboardGrounding) route = "sports_stat_qa";
  if (route !== "unsupported" && hasActiveSportsFilters(explicit) && !isSportsRoute(route)) route = base.route;
  if (route !== "unsupported" && route === "sports_stat_qa" && base.route !== "sports_stat_qa" && !isStatLeaderboardQuery(base.originalQuery)) {
    route = hasActiveSportsFilters({ ...base.domainFilters, ...llmFilters, ...explicit }) ? "sports_moment_retrieval" : base.route;
  }
  if (route !== "unsupported" && route === "sports_stat_qa" && !metric) route = base.route === "sports_stat_qa" ? "sports_stat_qa" : "generic_video_qa";
  const questionType = questionTypeForRoute(route);
  const rawDomainFilters = compactFilters(
    route === "sports_stat_qa"
      ? {
          ...base.domainFilters,
          ...llmFilters,
          ...explicit,
          eventType: undefined,
          passType: undefined,
          fieldZone: undefined,
          role: undefined
        }
      : isSportsRoute(route)
        ? { ...base.domainFilters, ...llmFilters, ...explicit }
        : { ...explicit }
  );
  const domainFilters = sanitizeInferredFilters(rawDomainFilters, base.originalQuery, route, explicit);
  const semanticQuery = !llmRoute && hasActiveSportsFilters(base.domainFilters) && !hasActiveSportsFilters(llmFilters) ? base.semanticQuery : selectSemanticQuery(llm.semanticQuery, base);
  const retrieval = buildRetrievalPlan(base.originalQuery, semanticQuery, {
    textQuery: llm.retrieval?.textQuery ?? semanticQuery,
    visualQuery: llm.retrieval?.visualQuery ?? semanticQuery,
    evidenceTerms: sanitizeEvidenceTerms(llm.retrieval?.evidenceTerms ?? [])
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
    domainFilters,
    route,
    intent: {
      ...base.intent,
      domain: isSportsRoute(route) && Object.keys(domainFilters).length > 0 ? domainFromFilters(domainFilters) : null,
      questionType,
      metric: route === "sports_stat_qa" ? metric : null,
      eventType: domainFilters.eventType ?? null,
      passType: domainFilters.passType ?? null,
      fieldZone: domainFilters.fieldZone ?? null,
      player: domainFilters.player ?? null,
      role: domainFilters.role ?? null
    },
    confidence: Number(confidence.toFixed(2)),
    warnings: [...base.warnings, ...llmWarnings],
    planner: {
      source: "openai",
      model: getOpenAiModel()
    }
  };
}

function sanitizeInferredFilters(
  filters: DomainSearchFilters,
  query: string,
  route: DomainQueryPlan["route"],
  explicitFilters: DomainSearchFilters
) {
  if (!isSportsRoute(route) || route === "sports_stat_qa") return filters;
  const next = { ...filters };
  if (!explicitFilters.season && !hasExplicitSeason(query)) delete next.season;
  if (!explicitFilters.fieldZone && !hasExplicitFieldZone(query)) delete next.fieldZone;
  if (!explicitFilters.competition && !hasExplicitCompetition(query)) delete next.competition;
  return compactFilters(next);
}

function routeFromLegacyQuestionType(questionType: OpenAiPlan["questionType"], metric: DomainQueryPlan["intent"]["metric"]) {
  if (!allowedQuestionTypes.has(String(questionType))) return undefined;
  if (questionType === "stat_qa" && metric) return "sports_stat_qa" as const;
  return undefined;
}

function questionTypeForRoute(route: DomainQueryPlan["route"]): DomainQueryPlan["intent"]["questionType"] {
  return route === "sports_stat_qa" ? "stat_qa" : "moment_retrieval";
}

function isSportsRoute(route: DomainQueryPlan["route"]) {
  return route === "sports_moment_retrieval" || route === "sports_analysis" || route === "sports_stat_qa";
}

function hasActiveSportsFilters(filters: DomainSearchFilters) {
  return Boolean(filters.competition || filters.player || filters.eventType || filters.passType || filters.fieldZone || filters.role);
}

function hasRetrievalPlan(plan: OpenAiPlan) {
  return Boolean(
    stringOrUndefined(plan.semanticQuery) ||
      stringOrUndefined(plan.retrieval?.textQuery) ||
      stringOrUndefined(plan.retrieval?.visualQuery) ||
      sanitizeEvidenceTerms(plan.retrieval?.evidenceTerms ?? []).length > 0
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

function parseOpenAiJson(text: string): OpenAiPlan {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("OpenAI planner returned non-object JSON");
  return parsed as OpenAiPlan;
}

function extractResponseText(body: unknown): string {
  if (typeof body !== "object" || body === null) throw new Error("OpenAI planner returned an invalid response");
  const response = body as { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> };
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  const text = response.output?.flatMap((item) => item.content ?? []).map((content) => content.text).find((value) => typeof value === "string" && value.trim());
  if (typeof text === "string") return text;
  throw new Error("OpenAI planner returned no text");
}

function resolvePlayer(value: string | null | undefined, query: string) {
  if (!value) return undefined;
  const knownPlayer = matchKnowledgePlayer(value)?.value;
  if (knownPlayer && queryMentionsKnownPlayer(knownPlayer, query)) return knownPlayer.canonical;
  const literal = stringOrUndefined(value);
  if (!literal) return undefined;
  return normalizePlannerText(query).includes(normalizePlannerText(literal)) ? literal : undefined;
}

function queryMentionsKnownPlayer(player: NonNullable<ReturnType<typeof matchKnowledgePlayer>>["value"], query: string) {
  const normalizedQuery = normalizePlannerText(query);
  return [player.canonical, ...player.aliases].some((alias) => {
    const normalizedAlias = normalizePlannerText(alias);
    if (!normalizedAlias || ignoredPlayerAliases.has(normalizedAlias)) return false;
    if (/^[a-z0-9\s-]+$/.test(normalizedAlias)) {
      return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedAlias)}($|[^a-z0-9])`, "i").test(normalizedQuery);
    }
    return normalizedQuery.includes(normalizedAlias);
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function knownPlayersForPrompt(query: string) {
  const matches = matchKnowledgePlayers(query).map((match) => match.value).filter((player) => queryMentionsKnownPlayer(player, query));
  const fallback = getSportsKnowledgeSnapshot().players.filter((player) => player.provider === "local").slice(0, 40);
  const byId = new Map([...matches, ...fallback].map((player) => [player.id, player]));
  return Array.from(byId.values()).slice(0, 50).map((player) => ({
    canonical: player.canonical,
    aliases: player.aliases.slice(0, 8),
    league: player.league
  }));
}

function resolveCompetition(value: string | null | undefined) {
  if (!value) return undefined;
  return matchCompetition(value)?.value ?? stringOrUndefined(value);
}

function allowedValue<T extends string>(value: unknown, allowed: Set<T>) {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : undefined;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function hasExplicitSeason(query: string) {
  return /이번\s*시즌|올\s*시즌|현재\s*시즌|this\s*season|current\s*season|최근\s*\d+\s*시즌|last\s*\d+\s*seasons?|recent\s*\d+\s*seasons?|\b20\d{2}\s*[-/]\s*(?:\d{2}|20\d{2})\b|\b20\d{2}\b/i.test(query);
}

function hasExplicitCompetition(query: string) {
  return Boolean(matchCompetition(query));
}

function hasExplicitFieldZone(query: string) {
  return /final third|attacking third|penalty area|\bbox\b|middle third|defensive third|파이널\s*서드|공격\s*(?:진영|지역)|페널티\s*박스|박스|미들\s*서드|수비\s*(?:진영|지역)/i.test(query);
}

function savedFootageIntent(query: string) {
  return /saved footage|saved video|indexed footage|uploaded|보관|저장|업로드|인덱싱|clip|clips|클립|장면|영상/.test(query);
}

function withPlanner(plan: DomainQueryPlan, source: "rules" | "openai", model: string | null): DomainQueryPlan {
  return {
    ...plan,
    planner: {
      source,
      model
    }
  };
}

function cacheKeyFor(query: string, explicitFilters: DomainSearchFilters) {
  return JSON.stringify({ query: query.trim(), explicitFilters: compactFilters(explicitFilters) });
}

function getOpenAiModel() {
  return process.env.OPENAI_QUERY_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
}
