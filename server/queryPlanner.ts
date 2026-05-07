import type { DomainQueryPlan, DomainSearchFilters } from "../shared/types";
import { buildRetrievalPlan } from "./queryRetrievalPlan";
import { matchKnowledgeCompetition, matchKnowledgePlayer, resolveRecentSeasons } from "./knowledge/registry";

const ignoredPlayerAliases = new Set(["query", "search", "match", "video", "clip", "clips", "moment", "moments", "speed", "top", "best", "goal", "goals", "save", "saves", "play", "plays"]);

export function planDomainQuery(query: string, explicitFilters: DomainSearchFilters = {}): DomainQueryPlan {
  const originalQuery = query.trim();
  const normalized = normalize(originalQuery);
  const playerInventory = isPlayerInventoryQuery(originalQuery);
  const inferred: DomainSearchFilters = {};
  const warnings: string[] = [];
  let confidence = playerInventory ? 0.72 : originalQuery ? 0.35 : 0.15;
  const playerMatch = matchSearchPlayer(originalQuery);
  let competition = explicitFilters.competition ?? inferCompetition(originalQuery);
  if (!competition && playerMatch) competition = playerMatch.value.league;
  const relatedKnowledgeContext = hasRelatedKnowledgeIntentContext(normalized, explicitFilters, competition, Boolean(playerMatch));
  const statMetric = relatedKnowledgeContext ? inferStatMetric(normalized, competition) : null;
  const statQuestion = Boolean(
    statMetric &&
      (hasAny(normalized, ["how many", "number of", "몇", "얼마나", "득점 수", "기록"]) || isStatLeaderboardQuery(originalQuery))
  );
  if (competition) {
    inferred.competition = competition;
    confidence += 0.08;
  }

  const season = inferSeason(originalQuery, competition);
  if (season) {
    inferred.season = season;
    confidence += 0.06;
  }

  const player = playerMatch?.value.canonical;
  if (player) {
    inferred.player = player;
    confidence += 0.12;
  }

  if (hasAny(normalized, ["through ball", "through-ball", "스루패스", "스루 패스", "침투패스", "침투 패스", "ball in behind", "pass in behind"])) {
    inferred.passType = "through_ball";
    confidence += 0.12;
  } else if (hasAny(normalized, ["cross", "크로스"])) {
    inferred.passType = "cross";
    confidence += 0.08;
  } else if (hasAny(normalized, ["cutback", "cut back", "컷백"])) {
    inferred.passType = "cutback";
    confidence += 0.08;
  }

  if (hasAny(normalized, ["final third", "attacking third", "파이널 서드", "공격 진영", "공격 지역"])) {
    inferred.fieldZone = "final_third";
    confidence += 0.1;
  } else if (hasAny(normalized, ["penalty area", "box", "페널티 박스", "박스"])) {
    inferred.fieldZone = "penalty_area";
    confidence += 0.08;
  }

  const receiveIntent = !statQuestion && relatedKnowledgeContext && hasAny(normalized, ["receive", "receives", "received", "receiver", "receiving", "받는", "받아", "받았다", "리시브"]);
  const shotIntent = !statQuestion && relatedKnowledgeContext && hasAny(normalized, ["goal", "goals", "scoring", "scored", "score", "shot", "shoot", "finish", "득점", "골", "슛", "슈팅", "마무리"]);
  const dribbleIntent = relatedKnowledgeContext && hasAny(normalized, ["dribble", "dribbles", "dribbling", "take on", "takes on", "드리블", "돌파"]);
  const saveIntent = relatedKnowledgeContext && hasAny(normalized, ["save", "saves", "keeper save", "goalkeeper save", "선방", "세이브"]);
  const pressureIntent = relatedKnowledgeContext && hasAny(normalized, ["pressure", "under pressure", "pressured", "압박"]);
  const scrambleIntent = relatedKnowledgeContext && hasAny(normalized, ["scramble", "scramble play", "스크램블"]);
  const pocketEscapeIntent = relatedKnowledgeContext && hasAny(normalized, ["pocket escape", "escapes the pocket", "out of the pocket", "포켓 탈출"]);
  const throwOnRunIntent = relatedKnowledgeContext && hasAny(normalized, ["throw on the run", "throws on the run", "rolling right", "rolling left", "이동 중 패스"]);
  if (receiveIntent) {
    inferred.eventType = "pass_receive";
    confidence += 0.12;
  } else if (inferred.passType) {
    inferred.eventType = "pass_receive";
    confidence += 0.06;
  } else if (shotIntent) {
    inferred.eventType = "shot";
    confidence += 0.1;
  } else if (dribbleIntent) {
    inferred.eventType = "dribble";
    confidence += 0.1;
  } else if (saveIntent) {
    inferred.eventType = "save";
    confidence += 0.1;
  } else if (scrambleIntent) {
    inferred.eventType = "scramble";
    confidence += 0.1;
  } else if (pocketEscapeIntent) {
    inferred.eventType = "pocket_escape";
    confidence += 0.1;
  } else if (throwOnRunIntent) {
    inferred.eventType = "throw_on_run";
    confidence += 0.1;
  } else if (pressureIntent) {
    inferred.eventType = "pressure";
    confidence += 0.08;
  }

  if (!inferred.eventType && (inferred.player || inferred.competition || inferred.fieldZone)) {
    warnings.push(statQuestion ? "This is a structured knowledge question; use related knowledge instead of moment retrieval for the direct answer." : "No explicit event was detected, so semantic search remains broad.");
  }
  if (statQuestion && isMomentSearchQuery(originalQuery)) {
    warnings.push("This query needs related-knowledge grounding before searching indexed video moments.");
  }
  if (inferred.fieldZone) {
    warnings.push("Field zone is matched from indexed domain labels, not calibrated pitch geometry.");
  }

  const domainFilters = compactFilters({ ...inferred, ...compactFilters(explicitFilters) });
  const semanticQuery = playerInventory ? "mentioned player names" : buildSemanticQuery(originalQuery, domainFilters);
  const rewrittenQuery = playerInventory ? "Extract mentioned player names from indexed timeline text and domain scopes." : buildRewrittenQuery(domainFilters, semanticQuery);
  const routePlan = inferQueryRoute(originalQuery, statQuestion, domainFilters, playerInventory);
  const retrieval = buildRetrievalPlan(originalQuery, semanticQuery);

  return {
    originalQuery,
    semanticQuery,
    rewrittenQuery,
    retrieval,
    domainFilters,
    route: routePlan.route,
    responseMode: routePlan.responseMode,
    relatedKnowledgeMode: routePlan.relatedKnowledgeMode,
    intent: {
      domain: Object.keys(domainFilters).length > 0 ? domainFromFilters(domainFilters) : null,
      questionType: routePlan.responseMode,
      metric: routePlan.responseMode === "structured_answer" ? statMetric : null,
      eventType: domainFilters.eventType ?? null,
      passType: domainFilters.passType ?? null,
      fieldZone: domainFilters.fieldZone ?? null,
      player: domainFilters.player ?? null,
      role: domainFilters.role ?? null
    },
    confidence: Number(Math.min(0.92, confidence).toFixed(2)),
    warnings
  };
}

function inferQueryRoute(
  query: string,
  statQuestion: boolean,
  domainFilters: DomainSearchFilters,
  playerInventory: boolean
): Pick<DomainQueryPlan, "route" | "responseMode" | "relatedKnowledgeMode"> {
  if (statQuestion) return { route: "knowledge_evidence", responseMode: "structured_answer", relatedKnowledgeMode: "direct_answer" };
  if (playerInventory) return { route: "asset_catalog", responseMode: "asset_lookup", relatedKnowledgeMode: "none" };
  const hasDomainFilters = hasDomainFilterEvidence(domainFilters);
  if (hasDomainFilters) {
    return {
      route: "asset_evidence",
      responseMode: isAnalysisQuery(query) ? "analysis" : isSummaryQuery(query) ? "summary" : isGroundedAnswerQuery(query) ? "grounded_answer" : "moment_retrieval",
      relatedKnowledgeMode: "none"
    };
  }
  if (isSummaryQuery(query)) return { route: "asset_evidence", responseMode: "summary", relatedKnowledgeMode: "none" };
  if (isGroundedAnswerQuery(query)) return { route: "asset_evidence", responseMode: "grounded_answer", relatedKnowledgeMode: "none" };
  return { route: "asset_evidence", responseMode: "moment_retrieval", relatedKnowledgeMode: "none" };
}

function hasDomainFilterEvidence(filters: DomainSearchFilters) {
  return Boolean(filters.competition || filters.player || filters.eventType || filters.passType || filters.fieldZone || filters.role);
}

function hasRelatedKnowledgeIntentContext(normalized: string, explicitFilters: DomainSearchFilters, competition: string | undefined, hasPlayerMatch: boolean) {
  if (competition || hasPlayerMatch || hasDomainFilterEvidence(explicitFilters)) return true;
  return hasAny(normalized, [
    "football",
    "soccer",
    "premier league",
    "nfl",
    "match",
    "keeper",
    "goalkeeper",
    "penalty",
    "pitch",
    "quarterback",
    "touchdown",
    "축구",
    "경기",
    "선수",
    "골",
    "득점",
    "슈팅",
    "슛",
    "크로스",
    "패스",
    "드리블",
    "선방",
    "터치다운",
    "쿼터백"
  ]);
}

function isSummaryQuery(query: string) {
  return /요약|정리|summari[sz]e|summary|recap/i.test(query);
}

function isAnalysisQuery(query: string) {
  return /분석|비교|패턴|리포트|analy[sz]e|compare|pattern|report/i.test(query);
}

function isGroundedAnswerQuery(query: string) {
  const readable = readableText(query);
  const normalized = normalize(query);
  if (isMomentSearchQuery(query) || isSummaryQuery(query) || isAnalysisQuery(query)) return false;
  return (
    /뭐|무엇|어떤|어때|설명|스타일|왜|누구|어디|언제|얼마|보이나|입고|착용|말해/.test(readable) ||
    /\b(what|which|who|where|when|why|how|describe|explain|style|look like|wearing|worn|answer)\b/.test(normalized)
  );
}

export function isPlayerInventoryQuery(query: string) {
  const normalized = query.toLowerCase();
  const asksKoreanPlayerNames = /선수/.test(normalized) && /(이름|목록|리스트|언급|추출|전체|모든)/.test(normalized);
  const asksEnglishPlayerNames = /\bplayers?\b/.test(normalized) && /\b(name|names|list|mentioned|extract|all|every)\b/.test(normalized);
  return asksKoreanPlayerNames || asksEnglishPlayerNames;
}

export function isMomentSearchQuery(query: string) {
  const readable = readableText(query);
  const normalized = normalize(query);
  return /찾|검색|보여|장면|구간|클립|하이라이트|나온|등장/.test(readable) || /\b(find|show|search|moments?|clips?|scene|scenes|highlight|appears?|shown)\b/.test(normalized);
}

export function isStatLeaderboardQuery(query: string) {
  const readable = readableText(query);
  const normalized = normalize(query);
  return /가장\s*많|제일\s*많|최다|선두|1위|랭킹|순위/.test(readable) || /\b(most|top|highest|leader|leading|rank|ranking)\b/.test(normalized);
}

export function parseDomainFilters(value: Record<string, unknown>): DomainSearchFilters {
  return compactFilters({
    competition: stringValue(value.competition),
    season: stringValue(value.season),
    player: stringValue(value.player),
    eventType: stringValue(value.eventType),
    passType: stringValue(value.passType),
    fieldZone: stringValue(value.fieldZone),
    role: roleValue(value.role)
  });
}

function inferCompetition(query: string) {
  return matchKnowledgeCompetition(query)?.value;
}

function matchSearchPlayer(query: string) {
  const match = matchKnowledgePlayer(query);
  if (!match) return null;
  const alias = match.evidence[0]?.match(/^Matched player alias:\s*(.+)$/)?.[1];
  if (alias && ignoredPlayerAliases.has(normalize(alias))) return null;
  return match;
}

function inferSeason(query: string, competition?: string) {
  const recent = query.match(/최근\s*(\d+)\s*시즌|last\s*(\d+)\s*seasons?|recent\s*(\d+)\s*seasons?/i);
  if (recent) {
    const count = Number(recent[1] ?? recent[2] ?? recent[3]);
    if (/compare|비교/.test(query.toLowerCase()) && /이번\s*시즌|올\s*시즌|현재\s*시즌|this\s*season|current\s*season/i.test(query)) {
      return resolveComparisonSeasonWindow(competition, count);
    }
    return resolveRecentSeasons(competition === "NFL" ? "NFL" : competition === "Premier League" ? "Premier League" : undefined, count);
  }
  if (/이번\s*시즌|올\s*시즌|현재\s*시즌|this\s*season|current\s*season/i.test(query)) {
    return currentSeason(competition);
  }
  const range = query.match(/\b(20\d{2})\s*[-/]\s*(\d{2}|20\d{2})\b/);
  if (range) return `${range[1]}-${range[2]}`;
  const year = query.match(/\b(20\d{2})\b/);
  return year?.[1];
}

function resolveComparisonSeasonWindow(competition: string | undefined, previousCount: number) {
  const current = currentSeason(competition);
  const previous = previousSeasons(competition, current, previousCount);
  return [current, ...previous].join(",");
}

function previousSeasons(competition: string | undefined, current: string, count: number) {
  if (competition === "NFL") {
    const year = Number(current);
    if (!Number.isFinite(year)) return [];
    return Array.from({ length: count }, (_, index) => String(year - index - 1));
  }
  const start = Number(current.match(/^20\d{2}/)?.[0]);
  if (!Number.isFinite(start)) return [];
  return Array.from({ length: count }, (_, index) => {
    const seasonStart = start - index - 1;
    return `${seasonStart}-${String(seasonStart + 1).slice(2)}`;
  });
}

function currentSeason(competition?: string) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (competition === "NFL") return String(month >= 8 ? year : year - 1);
  const start = month >= 7 ? year : year - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

function inferStatMetric(normalized: string, competition?: string): DomainQueryPlan["intent"]["metric"] {
  const americanFootball = competition === "NFL" || hasAny(normalized, ["nfl", "american football", "미식축구"]);
  if (hasAny(normalized, ["passing yards", "pass yards", "패싱 야드", "패스 야드"])) return "passing_yards";
  if (hasAny(normalized, ["passing touchdowns", "passing tds", "pass td", "패싱 터치다운"])) return "passing_touchdowns";
  if (hasAny(normalized, ["rushing yards", "rush yards", "러싱 야드", "러시 야드"])) return "rushing_yards";
  if (hasAny(normalized, ["receiving yards", "receiver yards", "리시빙 야드", "리시브 야드"])) return "receiving_yards";
  if (hasAny(normalized, ["touchdown", "touchdowns", "td", "tds", "터치다운"])) return "touchdowns";
  if (hasAny(normalized, ["sack", "sacks", "색"])) return "sacks";
  if (hasAny(normalized, ["interception", "interceptions", "pick", "picks", "인터셉션"])) return "interceptions";
  if (americanFootball && hasAny(normalized, ["point", "points", "scored", "score", "goal", "goals", "득점", "점수", "골"])) return "points";
  if (hasAny(normalized, ["goal", "goals", "scored", "score", "득점", "골"])) return "goals";
  if (hasAny(normalized, ["assist", "assists", "도움", "어시스트"])) return "assists";
  if (hasAny(normalized, ["appearance", "appearances", "apps", "출전"])) return "appearances";
  if (hasAny(normalized, ["minute", "minutes", "mins", "출장 시간", "출전 시간"])) return "minutes";
  if (hasAny(normalized, ["card", "cards", "경고", "퇴장"])) return "cards";
  return null;
}

function buildSemanticQuery(query: string, filters: DomainSearchFilters) {
  return [
    query,
    expandKoreanRetrievalAliases(query),
    filters.player,
    filters.competition,
    filters.eventType === "pass_receive" ? "receive receiving player" : "",
    filters.eventType === "shot" ? "goal scoring shot finish" : "",
    filters.eventType === "dribble" ? "dribble carry take on 드리블 돌파" : "",
    filters.eventType === "save" ? "goalkeeper save keeper save shot stop 선방 세이브" : "",
    filters.eventType === "pressure" ? "pressure under pressure 압박" : "",
    filters.eventType === "scramble" ? "scramble quarterback carry pocket escape" : "",
    filters.eventType === "pocket_escape" ? "pocket escape out of the pocket quarterback" : "",
    filters.eventType === "throw_on_run" ? "throw on the run rolling right rolling left" : "",
    filters.passType === "through_ball" ? "through ball ball in behind 스루패스 침투패스" : "",
    filters.fieldZone === "final_third" ? "final third attacking third 파이널 서드" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function expandKoreanRetrievalAliases(query: string) {
  const readable = readableText(query);
  const aliases = [
    /무한|무한히/.test(readable) ? "infinite infinitely endless" : "",
    /확대|확대경|줌인|줌\s*인|zoom/.test(readable) ? "zooming in zoom in magnification microscope" : "",
    /자유\s*의지|자유의지/.test(readable) ? "free will voluntary action agency" : "",
    /시뮬레이션|가상\s*현실|npc/i.test(readable) ? "simulation simulated reality NPC" : "",
    /뇌과학|신경\s*과학/.test(readable) ? "neuroscience brain science" : "",
    /존재|자아/.test(readable) ? "existence self identity" : "",
    /착각|환상/.test(readable) ? "illusion misconception" : ""
  ].filter(Boolean);
  return aliases.join(" ");
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

function compactFilters(filters: DomainSearchFilters): DomainSearchFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => typeof value === "string" && value.trim().length > 0)
  ) as DomainSearchFilters;
}

function domainFromFilters(filters: DomainSearchFilters) {
  if (filters.competition === "NFL" || ["scramble", "pocket_escape", "throw_on_run", "pressure"].includes(filters.eventType ?? "")) return "sports.american_football";
  return "sports.football";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function roleValue(value: unknown): DomainSearchFilters["role"] | undefined {
  return value === "receiver" || value === "passer" || value === "shooter" || value === "any" ? value : undefined;
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

function readableText(value: string) {
  return value.toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();
}

function hasAny(value: string, terms: string[]) {
  return terms.some((term) => value.includes(normalize(term)));
}
