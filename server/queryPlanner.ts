import type { DomainQueryPlan, DomainSearchFilters } from "../shared/types";
import { matchCompetition, matchKnowledgePlayer, resolveRecentSeasons } from "./sportsKnowledge";

export function planDomainQuery(query: string, explicitFilters: DomainSearchFilters = {}): DomainQueryPlan {
  const originalQuery = query.trim();
  const normalized = normalize(originalQuery);
  const inferred: DomainSearchFilters = {};
  const warnings: string[] = [];
  let confidence = originalQuery ? 0.35 : 0.15;

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

  const receiveIntent = hasAny(normalized, ["receive", "receives", "received", "receiver", "receiving", "받는", "받아", "받았다", "리시브"]);
  const shotIntent = hasAny(normalized, ["shot", "shoot", "finish", "슛", "슈팅", "마무리"]);
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
    warnings.push("No explicit event was detected, so semantic search remains broad.");
  }
  if (inferred.player && inferred.role === "receiver") {
    warnings.push("Player role is inferred from language; detector/tracker evidence is not available yet.");
  }
  if (inferred.fieldZone) {
    warnings.push("Field zone is matched from indexed domain labels, not calibrated pitch geometry.");
  }

  const domainFilters = compactFilters({ ...inferred, ...compactFilters(explicitFilters) });
  const semanticQuery = buildSemanticQuery(originalQuery, domainFilters);
  const rewrittenQuery = buildRewrittenQuery(domainFilters, semanticQuery);

  return {
    originalQuery,
    semanticQuery,
    rewrittenQuery,
    domainFilters,
    intent: {
      domain: Object.keys(domainFilters).length > 0 ? domainFromFilters(domainFilters) : null,
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
  if (recent) return resolveRecentSeasons(competition === "NFL" ? "NFL" : competition === "Premier League" ? "Premier League" : undefined, Number(recent[1] ?? recent[2] ?? recent[3]));
  const range = query.match(/\b(20\d{2})\s*[-/]\s*(\d{2}|20\d{2})\b/);
  if (range) return `${range[1]}-${range[2]}`;
  const year = query.match(/\b(20\d{2})\b/);
  return year?.[1];
}

function buildSemanticQuery(query: string, filters: DomainSearchFilters) {
  return [
    query,
    filters.player,
    filters.competition,
    filters.eventType === "pass_receive" ? "receive receiving player" : "",
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
