import type { DomainQueryPlan, DomainSearchFilters } from "../shared/types";

const knownPlayers = [
  { canonical: "Erling Haaland", patterns: [/erling\s+haaland/i, /\bhaaland\b/i] },
  { canonical: "Kylian Mbappé", patterns: [/kylian\s+mbapp[eé]/i, /\bmbapp[eé]\b/i] },
  { canonical: "Son Heung-min", patterns: [/son\s+heung-?min/i, /\bheung-?min\s+son\b/i, /\bsonny\b/i] },
  { canonical: "Patrick Mahomes", patterns: [/patrick\s+mahomes/i, /\bmahomes\b/i] }
];

const competitionRules = [
  { value: "Premier League", patterns: [/premier\s+league/i, /epl\b/i, /프리미어\s*리그/i] },
  { value: "NFL", patterns: [/\bnfl\b/i, /national\s+football\s+league/i] },
  { value: "Champions League", patterns: [/champions\s+league/i, /ucl\b/i, /챔피언스\s*리그/i] },
  { value: "Bundesliga", patterns: [/bundesliga/i, /분데스리가/i] }
];

export function planDomainQuery(query: string, explicitFilters: DomainSearchFilters = {}): DomainQueryPlan {
  const originalQuery = query.trim();
  const normalized = normalize(originalQuery);
  const inferred: DomainSearchFilters = {};
  const warnings: string[] = [];
  let confidence = originalQuery ? 0.35 : 0.15;

  const competition = inferCompetition(originalQuery);
  if (competition) {
    inferred.competition = competition;
    confidence += 0.08;
  }

  const season = inferSeason(originalQuery);
  if (season) {
    inferred.season = season;
    confidence += 0.06;
  }

  const player = inferPlayer(originalQuery);
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
  if (receiveIntent || inferred.passType) {
    inferred.eventType = "pass_receive";
    inferred.role = "receiver";
    confidence += receiveIntent ? 0.12 : 0.06;
  } else if (shotIntent) {
    inferred.eventType = "shot";
    inferred.role = "shooter";
    confidence += 0.1;
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
      domain: Object.keys(domainFilters).length > 0 ? "sports.football" : null,
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
  for (const rule of competitionRules) {
    if (rule.patterns.some((pattern) => pattern.test(query))) return rule.value;
  }
  return undefined;
}

function inferSeason(query: string) {
  const recent = query.match(/최근\s*(\d+)\s*시즌|last\s*(\d+)\s*seasons?|recent\s*(\d+)\s*seasons?/i);
  if (recent) return `last_${recent[1] ?? recent[2] ?? recent[3]}_seasons`;
  const range = query.match(/\b(20\d{2})\s*[-/]\s*(\d{2}|20\d{2})\b/);
  if (range) return `${range[1]}-${range[2]}`;
  const year = query.match(/\b(20\d{2})\b/);
  return year?.[1];
}

function inferPlayer(query: string) {
  for (const player of knownPlayers) {
    if (player.patterns.some((pattern) => pattern.test(query))) return player.canonical;
  }
  const capitalizedName = query.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-zé]+){1,2})\b/);
  return capitalizedName?.[1];
}

function buildSemanticQuery(query: string, filters: DomainSearchFilters) {
  return [
    query,
    filters.player,
    filters.competition,
    filters.eventType === "pass_receive" ? "receive receiving player" : "",
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
