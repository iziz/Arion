import type { DomainQueryPlan, DomainSearchFilters } from "../shared/types";
import { matchCompetition, matchKnowledgePlayer, resolveRecentSeasons } from "./sportsKnowledge";

export function planDomainQuery(query: string, explicitFilters: DomainSearchFilters = {}): DomainQueryPlan {
  const originalQuery = query.trim();
  const normalized = normalize(originalQuery);
  const playerInventory = isPlayerInventoryQuery(originalQuery);
  const inferred: DomainSearchFilters = {};
  const warnings: string[] = [];
  let confidence = playerInventory ? 0.72 : originalQuery ? 0.35 : 0.15;
  const statMetric = inferStatMetric(normalized);
  const statQuestion = Boolean(statMetric && hasAny(normalized, ["how many", "number of", "몇", "얼마나", "득점 수", "기록"]));

  const playerMatch = matchKnowledgePlayer(originalQuery);
  let competition = inferCompetition(originalQuery);
  if (!competition && playerMatch) competition = playerMatch.value.league;
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

  const receiveIntent = !statQuestion && hasAny(normalized, ["receive", "receives", "received", "receiver", "receiving", "받는", "받아", "받았다", "리시브"]);
  const shotIntent = !statQuestion && hasAny(normalized, ["goal", "goals", "scoring", "scored", "score", "shot", "shoot", "finish", "득점", "골", "슛", "슈팅", "마무리"]);
  const dribbleIntent = hasAny(normalized, ["dribble", "dribbles", "dribbling", "take on", "takes on", "드리블", "돌파"]);
  const pressureIntent = hasAny(normalized, ["pressure", "under pressure", "pressured", "압박"]);
  const scrambleIntent = hasAny(normalized, ["scramble", "scramble play", "스크램블"]);
  const pocketEscapeIntent = hasAny(normalized, ["pocket escape", "escapes the pocket", "out of the pocket", "포켓 탈출"]);
  const throwOnRunIntent = hasAny(normalized, ["throw on the run", "throws on the run", "rolling right", "rolling left", "이동 중 패스"]);
  if (receiveIntent || inferred.passType) {
    inferred.eventType = "pass_receive";
    inferred.role = "receiver";
    confidence += receiveIntent ? 0.12 : 0.06;
  } else if (shotIntent) {
    inferred.eventType = "shot";
    inferred.role = "shooter";
    confidence += 0.1;
  } else if (dribbleIntent) {
    inferred.eventType = "dribble";
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
    warnings.push(statQuestion ? "This is a stats question; use knowledge QA instead of moment retrieval for the direct answer." : "No explicit event was detected, so semantic search remains broad.");
  }
  if (inferred.player && inferred.role === "receiver") {
    warnings.push("Player role is inferred from language; detector/tracker evidence is not available yet.");
  }
  if (inferred.fieldZone) {
    warnings.push("Field zone is matched from indexed domain labels, not calibrated pitch geometry.");
  }

  const domainFilters = compactFilters({ ...inferred, ...compactFilters(explicitFilters) });
  const semanticQuery = playerInventory ? "mentioned player names" : buildSemanticQuery(originalQuery, domainFilters);
  const rewrittenQuery = playerInventory ? "Extract mentioned player names from indexed timeline text and domain scopes." : buildRewrittenQuery(domainFilters, semanticQuery);

  return {
    originalQuery,
    semanticQuery,
    rewrittenQuery,
    domainFilters,
    intent: {
      domain: Object.keys(domainFilters).length > 0 ? domainFromFilters(domainFilters) : null,
      questionType: statQuestion ? "stat_qa" : "moment_retrieval",
      metric: statMetric,
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

export function isPlayerInventoryQuery(query: string) {
  const normalized = query.toLowerCase();
  const asksKoreanPlayerNames = /선수/.test(normalized) && /(이름|목록|리스트|언급|추출|전체|모든)/.test(normalized);
  const asksEnglishPlayerNames = /\bplayers?\b/.test(normalized) && /\b(name|names|list|mentioned|extract|all|every)\b/.test(normalized);
  return asksKoreanPlayerNames || asksEnglishPlayerNames;
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
  return matchCompetition(query)?.value;
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

function inferStatMetric(normalized: string): DomainQueryPlan["intent"]["metric"] {
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
    filters.player,
    filters.competition,
    filters.eventType === "pass_receive" ? "receive receiving player" : "",
    filters.eventType === "shot" ? "goal scoring shot finish" : "",
    filters.eventType === "dribble" ? "dribble carry take on 드리블 돌파" : "",
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

function hasAny(value: string, terms: string[]) {
  return terms.some((term) => value.includes(normalize(term)));
}
