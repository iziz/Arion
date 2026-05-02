import type { DomainQueryPlan, DomainSearchFilters } from "../shared/types";
import { planDomainQuery } from "./queryPlanner";
import { getSportsKnowledgeSnapshot, matchCompetition, matchKnowledgePlayer, matchKnowledgePlayers } from "./sportsKnowledge";

type OpenAiPlan = {
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
  confidence?: number;
  warnings?: string[];
};

const planCache = new Map<string, { expiresAt: number; plan: DomainQueryPlan }>();
const allowedQuestionTypes = new Set(["moment_retrieval", "stat_qa"]);
const allowedMetrics = new Set(["goals", "assists", "appearances", "minutes", "cards"]);
const allowedRoles = new Set(["receiver", "passer", "shooter", "any"]);
const allowedEventTypes = new Set(["pass_receive", "shot", "dribble", "pressure", "scramble", "pocket_escape", "throw_on_run"]);
const allowedPassTypes = new Set(["through_ball", "cross", "cutback"]);
const allowedFieldZones = new Set(["final_third", "penalty_area", "middle_third", "defensive_third"]);

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
              "You are a domain query planner for a sports video intelligence platform. Return only JSON. Extract structured constraints for retrieval and stats QA. Do not invent statistics or facts. Use null when uncertain."
          },
          {
            role: "user",
            content: JSON.stringify({
              currentDate: new Date().toISOString().slice(0, 10),
              defaultFootballSeasonRule: "For Premier League, current season is YYYY-YY starting in July. In May 2026 this is 2025-26.",
              allowed: {
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
                questionType: "moment_retrieval | stat_qa",
                metric: "goals | assists | appearances | minutes | cards | null",
                competition: "string | null",
                season: "string | null",
                player: "canonical player name | null",
                eventType: "string | null",
                passType: "string | null",
                fieldZone: "string | null",
                role: "receiver | passer | shooter | any | null",
                semanticQuery: "English retrieval query",
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
    player: resolvePlayer(llm.player),
    eventType: allowedValue(llm.eventType, allowedEventTypes),
    passType: allowedValue(llm.passType, allowedPassTypes),
    fieldZone: allowedValue(llm.fieldZone, allowedFieldZones),
    role: allowedValue(llm.role, allowedRoles) as DomainSearchFilters["role"] | undefined
  });
  const metric = (allowedValue(llm.metric, allowedMetrics) as DomainQueryPlan["intent"]["metric"] | undefined) ?? base.intent.metric ?? null;
  const questionType =
    allowedQuestionTypes.has(String(llm.questionType)) && (llm.questionType !== "stat_qa" || metric)
      ? (llm.questionType as DomainQueryPlan["intent"]["questionType"])
      : base.intent.questionType;
  const rawDomainFilters = compactFilters(
    questionType === "stat_qa"
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
  const domainFilters = sanitizeInferredFilters(rawDomainFilters, base.originalQuery, questionType, explicit);
  const semanticQuery = stringOrUndefined(llm.semanticQuery) ?? base.semanticQuery;
  const confidence = Math.max(base.confidence, Math.min(0.94, Number(llm.confidence ?? 0)));
  const llmWarnings = Array.isArray(llm.warnings)
    ? llm.warnings.filter((warning) => typeof warning === "string" && warning.trim() && !/knownPlayers|provided/i.test(warning))
    : [];
  return {
    ...base,
    semanticQuery,
    rewrittenQuery: buildRewrittenQuery(domainFilters, semanticQuery),
    domainFilters,
    intent: {
      ...base.intent,
      domain: Object.keys(domainFilters).length > 0 ? domainFromFilters(domainFilters) : base.intent.domain,
      questionType,
      metric: questionType === "stat_qa" ? metric : null,
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
  questionType: DomainQueryPlan["intent"]["questionType"],
  explicitFilters: DomainSearchFilters
) {
  if (questionType !== "moment_retrieval") return filters;
  const next = { ...filters };
  if (!explicitFilters.season && !hasExplicitSeason(query)) delete next.season;
  if (!explicitFilters.fieldZone && !hasExplicitFieldZone(query)) delete next.fieldZone;
  if (!explicitFilters.competition && !hasExplicitCompetition(query)) delete next.competition;
  return compactFilters(next);
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

function resolvePlayer(value: string | null | undefined) {
  if (!value) return undefined;
  return matchKnowledgePlayer(value)?.value.canonical ?? stringOrUndefined(value);
}

function knownPlayersForPrompt(query: string) {
  const matches = matchKnowledgePlayers(query).map((match) => match.value);
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
