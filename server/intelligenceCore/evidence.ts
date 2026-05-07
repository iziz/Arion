import type { AssetRecord, ClipResult, DomainQueryPlan, DomainSearchFilters, PlayerIdentity, SearchMatchReason, TimelineSegment, VerificationCheck } from "../../shared/types";
import { isTrustedDomainSegment, isTrustedDomainEvent, isTrustedVisionEvidence, isTrustedVisionFieldZone, trustedDomainEvents } from "../evidenceTrust";
import { matchKnowledgePlayer, playerTeamForSeason } from "../knowledge/registry";
import { isObjectEvidenceReady, segmentSearchText } from "./sceneTimeline";
import { SEMANTIC_ONLY_THRESHOLD, VISUAL_ONLY_THRESHOLD } from "./searchThresholds";
import { formatTime, normalizeSearchValue, unique } from "./textUtils";

export function clipFromSegment(asset: AssetRecord, segment: TimelineSegment, verification: VerificationCheck[], reasons: SearchMatchReason[], filters?: DomainSearchFilters): ClipResult {
  const event = trustedDomainEvents(segment)[0];
  const football = event?.football;
  const americanFootball = event?.americanFootball;
  const player = selectClipPlayer(segment, filters, football, americanFootball);
  const start = Math.max(0, Number((segment.start - 2).toFixed(2)));
  const end = Number((segment.end + 2).toFixed(2));
  return {
    id: `${asset.id}:${segment.id}:clip`,
    assetId: asset.id,
    segmentId: segment.id,
    title: `${formatTime(segment.start)}-${formatTime(segment.end)} · ${segment.label}`,
    start,
    end,
    thumbnailPath: segment.sceneData?.image.thumbnailPath ?? segment.thumbnailPath,
    event: event?.eventType ?? segment.sceneData?.vision?.eventClassification?.label ?? "moment",
    player,
    confidence: Number(Math.max(event?.confidence ?? 0, segment.confidence).toFixed(2)),
    verificationSummary: summarizeVerification(verification),
    reasons: unique([
      event?.caption ?? "",
      ...reasons.map((reason) => `${reason.label}: ${reason.value}`),
      ...(event?.evidence.heuristics ?? [])
    ].filter(Boolean)).slice(0, 6)
  };
}

function selectClipPlayer(
  segment: TimelineSegment,
  filters: DomainSearchFilters | undefined,
  football: ReturnType<typeof trustedDomainEvents>[number]["football"] | undefined,
  americanFootball: ReturnType<typeof trustedDomainEvents>[number]["americanFootball"] | undefined
) {
  const receiver = football?.receivingPlayer.identity ?? null;
  const passer = football?.passingPlayer.identity ?? null;
  const quarterback = americanFootball?.quarterback.identity ?? null;
  const requestedPlayer = filters?.player;
  if (requestedPlayer) {
    const rolePreferred =
      filters.role === "passer"
        ? passer
        : filters.role === "receiver"
          ? receiver
          : filters.role === "shooter"
            ? receiver ?? passer
            : null;
    if (rolePreferred && identityMatchesPlayer(rolePreferred, requestedPlayer)) return rolePreferred.name;
    const matchingIdentity = [receiver, passer, quarterback].find((identity) => identityMatchesPlayer(identity, requestedPlayer));
    if (matchingIdentity) return matchingIdentity.name;
    const scopedPlayer = segment.domain?.scope?.players.find((player) => scopeValueMatchesPlayer(player.value, requestedPlayer));
    if (scopedPlayer) return scopedPlayer.value;
  }
  if (filters?.role === "passer") return passer?.name ?? receiver?.name ?? quarterback?.name ?? segment.domain?.scope?.players[0]?.value ?? null;
  if (filters?.role === "receiver") return receiver?.name ?? passer?.name ?? quarterback?.name ?? segment.domain?.scope?.players[0]?.value ?? null;
  return receiver?.name ?? passer?.name ?? quarterback?.name ?? segment.domain?.scope?.players[0]?.value ?? null;
}

function summarizeVerification(verification: VerificationCheck[]): ClipResult["verificationSummary"] {
  return {
    pass: verification.filter((check) => check.status === "pass").length,
    softPass: verification.filter((check) => check.status === "soft_pass").length,
    unknown: verification.filter((check) => check.status === "unknown").length,
    fail: verification.filter((check) => check.status === "fail").length
  };
}

export function scoreText(input: string, queryTerms: string[]) {
  const normalized = normalizeForLexicalMatch(input);
  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  return queryTerms.reduce((score, term) => score + (matchesLexicalTerm(normalized, tokens, term) ? 1 : 0), 0);
}

function matchesLexicalTerm(normalizedHaystack: string, tokens: Set<string>, term: string) {
  const normalizedTerm = normalizeForLexicalMatch(term);
  if (!normalizedTerm) return false;
  const termTokens = normalizedTerm.split(/\s+/).filter(Boolean);
  if (termTokens.length > 1) return normalizedHaystack.includes(termTokens.join(" "));
  const [singleTerm] = termTokens;
  if (!singleTerm) return false;
  if (/[가-힣]/.test(singleTerm)) return normalizedHaystack.includes(singleTerm);
  return tokens.has(singleTerm);
}

function normalizeForLexicalMatch(value: string) {
  return normalizeSearchValue(value)
    .replace(/[^a-z0-9가-힣\s-]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim().replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join(" ");
}

export function scoreSources(sources: TimelineSegment["sources"]) {
  let score = 0;
  if (sources.includes("whisper")) score += 0.75;
  if (sources.includes("paddleocr")) score += 0.65;
  if (sources.includes("shot")) score += 0.45;
  if (sources.includes("visual")) score += 0.08;
  if (sources.includes("metadata")) score += 0.1;
  return score;
}

export function scoreVlmQuality(segment: TimelineSegment) {
  const quality = segment.domain?.vlm;
  if (!quality) return 0;
  if (quality.status === "refined") return 0.8 + quality.confidence;
  if (quality.status === "invalid") return -0.8;
  if (quality.status === "failed") return -1.2;
  return 0;
}

export function hasActiveDomainFilters(filters?: DomainSearchFilters) {
  return Boolean(
    filters &&
      Object.entries(filters).some(([key, value]) => {
        if (typeof value !== "string" || value.trim().length === 0) return false;
        return !(key === "role" && value === "any");
      })
  );
}

type DomainFilterConstraint = keyof DomainSearchFilters;

export type SegmentDomainFilterEvaluation = {
  accepted: boolean;
  trust: "trusted" | "weak" | "failed";
  matchedFilters: DomainFilterConstraint[];
  weakMatches: DomainFilterConstraint[];
  failures: DomainFilterConstraint[];
};

export function matchesAssetDomainText(asset: AssetRecord, filters?: DomainSearchFilters) {
  if (!filters) return true;
  const terms = [filters.player].map((value) => value?.trim()).filter(Boolean) as string[];
  if (terms.length === 0) return true;
  const haystack = normalizeSearchValue(
    [
      asset.title,
      asset.description,
      asset.originalName,
      asset.tags.join(" "),
      asset.summary,
      asset.intelligence.asr.transcript,
      asset.intelligence.ocr.tokens.join(" "),
      asset.timeline.map((segment) => segmentSearchText(segment)).join(" "),
      asset.timeline
        .flatMap((segment) =>
          trustedDomainEvents(segment).flatMap((event) => [
            event.caption,
            ...event.labels,
            event.football?.receivingPlayer.identity?.name,
            event.football?.passingPlayer.identity?.name,
            event.americanFootball?.quarterback.identity?.name
          ])
        )
        .filter(Boolean)
        .join(" ")
    ].join(" ")
  );
  return terms.every((term) => haystack.includes(normalizeSearchValue(term)));
}

export function matchesSegmentDomainFilters(asset: AssetRecord, segment: TimelineSegment, filters?: DomainSearchFilters) {
  return evaluateSegmentDomainFilters(asset, segment, filters).accepted;
}

export function evaluateSegmentDomainFilters(asset: AssetRecord, segment: TimelineSegment, filters?: DomainSearchFilters): SegmentDomainFilterEvaluation {
  const evaluation: SegmentDomainFilterEvaluation = {
    accepted: true,
    trust: "trusted",
    matchedFilters: [],
    weakMatches: [],
    failures: []
  };
  if (!filters || !hasActiveDomainFilters(filters)) return evaluation;
  const fullSegmentText = segmentDomainFilterText(asset, segment);
  const trust = (constraint: DomainFilterConstraint) => {
    if (!evaluation.matchedFilters.includes(constraint)) evaluation.matchedFilters.push(constraint);
  };
  const weaken = (constraint: DomainFilterConstraint) => {
    if (!evaluation.weakMatches.includes(constraint)) evaluation.weakMatches.push(constraint);
  };
  const fail = (constraint: DomainFilterConstraint) => {
    if (!evaluation.failures.includes(constraint)) evaluation.failures.push(constraint);
  };

  const applyScopeFilter = (field: "competition" | "season", value?: string) => {
    if (splitFilterValues(value).length === 0) return;
    if (scopeFilterAllows(segment, field, value)) {
      trust(field);
      return;
    }
    if (textAllowsFilter(fullSegmentText, value) || missingScopeCanStaySoft(segment, field, filters, fullSegmentText)) {
      weaken(field);
      return;
    }
    fail(field);
  };

  applyScopeFilter("competition", filters.competition);
  applyScopeFilter("season", filters.season);

  if (filters.player) {
    const role = roleSpecificIdentityFilter(filters.role);
    if (role && hasTrustedPlayerIdentityForRole(segment, filters.player, role)) {
      trust("player");
    } else if (role && hasRoleSpecificPlayerConflict(segment, filters.player, role)) {
      fail("player");
    } else if (role) {
      fail("player");
    } else if (!role && hasTrustedPlayerIdentity(segment, filters.player)) {
      trust("player");
    } else if (textAllowsFilter(fullSegmentText, filters.player)) {
      weaken("player");
    } else {
      fail("player");
    }
  }

  applyEventFilters(segment, filters, fullSegmentText, { trust, weaken, fail });

  if (evaluation.failures.length > 0) {
    return { ...evaluation, accepted: false, trust: "failed" };
  }
  if (evaluation.weakMatches.length > 0) {
    return { ...evaluation, trust: "weak" };
  }
  return evaluation;
}

function segmentDomainFilterText(asset: AssetRecord, segment: TimelineSegment) {
  return normalizeSearchValue(
    [
      asset.title,
      asset.description,
      asset.originalName,
      asset.tags.join(" "),
      segment.label,
      segment.transcript,
      segment.tags.join(" "),
      segmentSearchText(segment),
      isTrustedDomainSegment(segment.domain) ? segment.domain?.searchText : "",
      ...trustedDomainEvents(segment).flatMap((event) => [
        event.caption,
        ...event.labels,
        ...event.evidence.asr,
        ...event.evidence.ocr,
        ...event.evidence.metadata,
        event.football?.receivingPlayer.identity?.name,
        event.football?.passingPlayer.identity?.name,
        event.americanFootball?.quarterback.identity?.name
      ])
    ].join(" ")
  );
}

function applyEventFilters(
  segment: TimelineSegment,
  filters: DomainSearchFilters,
  fullSegmentText: string,
  record: {
    trust: (constraint: DomainFilterConstraint) => void;
    weaken: (constraint: DomainFilterConstraint) => void;
    fail: (constraint: DomainFilterConstraint) => void;
  }
) {
  const eventFilters = {
    eventType: filters.eventType?.trim(),
    passType: filters.passType?.trim(),
    fieldZone: filters.fieldZone?.trim(),
    role: filters.role && filters.role !== "any" ? filters.role.trim() : undefined
  };
  const needsEventMatch = Object.values(eventFilters).some(Boolean);
  if (!needsEventMatch) return;
  const events = trustedDomainEvents(segment);
  const structuredMatch = events.some((event) => {
    if (eventFilters.eventType && event.eventType !== eventFilters.eventType) return false;
    if (eventFilters.passType && event.football?.passType !== eventFilters.passType) return false;
    if (eventFilters.fieldZone && event.football?.fieldZone !== eventFilters.fieldZone) return false;
    if (filters.role === "receiver" && !event.football?.receivingPlayer.present) return false;
    if (filters.role === "passer" && !event.football?.passingPlayer.present) return false;
    if (filters.role === "shooter" && event.eventType !== "shot") return false;
    return true;
  });
  const activeConstraints = Object.entries(eventFilters)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key as DomainFilterConstraint);
  if (structuredMatch) {
    activeConstraints.forEach(record.trust);
    return;
  }
  if (eventFilters.passType || eventFilters.fieldZone || eventFilters.role === "receiver" || eventFilters.role === "passer" || events.length > 0) {
    activeConstraints.forEach(record.fail);
    return;
  }
  if (eventFilters.eventType) {
    if (textAllowsEventFilter(fullSegmentText, eventFilters.eventType)) record.weaken("eventType");
    else record.fail("eventType");
  }
  if (eventFilters.role) {
    record.fail("role");
  }
}

function textAllowsFilter(haystack: string, value?: string) {
  const values = splitFilterValues(value);
  return values.some((item) => {
    const normalized = normalizeSearchValue(item);
    return Boolean(normalized && haystack.includes(normalized));
  });
}

function textAllowsEventFilter(haystack: string, eventType: string) {
  const aliases: Record<string, string[]> = {
    shot: ["shot", "shoot", "scoring", "scored", "score", "goal", "goals", "finish", "득점", "골", "슈팅", "슛"],
    dribble: ["dribble", "dribbling", "carry", "take on", "드리블", "돌파"],
    save: ["save", "saves", "keeper save", "goalkeeper save", "shot stop", "선방", "세이브"],
    progressive_pass: ["progressive pass", "line breaking pass", "breaks the line", "전진 패스", "라인 브레이킹"],
    pass_receive: ["receive", "receiving", "through ball", "pass", "받는", "스루패스", "패스"],
    pressure: ["pressure", "pressured", "under pressure", "압박"],
    scramble: ["scramble", "스크램블"],
    pocket_escape: ["pocket escape", "out of the pocket", "포켓 탈출"],
    throw_on_run: ["throw on the run", "rolling", "이동 중 패스"]
  };
  return (aliases[eventType] ?? [eventType]).some((alias) => textAllowsFilter(haystack, alias));
}

export function scoreDomainFilterMatch(asset: AssetRecord, segment: TimelineSegment, filters?: DomainSearchFilters) {
  if (!filters || !hasActiveDomainFilters(filters)) return 0;
  const checks = buildVerificationChecks(asset, segment, filters);
  return Number(
    checks
      .reduce((score, check) => {
        if (check.status === "pass") return score + 1;
        if (check.status === "soft_pass") return score + 0.5;
        return score;
      }, 0)
      .toFixed(3)
  );
}

function scopeFilterAllows(segment: TimelineSegment, field: "competition" | "season", filterValue?: string) {
  const filterValues = splitFilterValues(filterValue);
  if (filterValues.length === 0) return true;
  const scopeValue = field === "competition" ? segment.domain?.scope?.competition : segment.domain?.scope?.season;
  if (!scopeValue) return false;
  const normalizedScopeValue = normalizeSearchValue(scopeValue.value);
  return filterValues.some((value) => {
    const normalizedFilter = normalizeSearchValue(value);
    return normalizedScopeValue.includes(normalizedFilter) || normalizedFilter.includes(normalizedScopeValue);
  });
}

function missingScopeCanStaySoft(segment: TimelineSegment, field: "competition" | "season", filters: DomainSearchFilters, fullSegmentText: string) {
  const scopeValue = field === "competition" ? segment.domain?.scope?.competition : segment.domain?.scope?.season;
  if (scopeValue) return false;
  if (field === "competition" && splitFilterValues(filters.competition).some((value) => normalizeSearchValue(value) === "nfl") && segment.domain?.groups.includes("sports.american_football")) return true;
  if (!filters.player || !textAllowsFilter(fullSegmentText, filters.player)) return false;
  if (hasTrustedPlayerIdentity(segment, filters.player)) return true;
  const hasEventConstraint = Boolean(filters.eventType || filters.passType || filters.fieldZone || (filters.role && filters.role !== "any"));
  if (!hasEventConstraint) return false;
  return trustedDomainEvents(segment).length > 0 || (isTrustedVisionEvidence(segment.sceneData?.vision) && Boolean(segment.sceneData?.vision?.eventClassification));
}

function hasTrustedPlayerIdentity(segment: TimelineSegment, player: string) {
  const expected = normalizeSearchValue(player);
  if (!expected) return false;
  const candidates = [
    ...(segment.domain?.scope?.players.map((item) => item.value) ?? []),
    ...trustedDomainEvents(segment).flatMap((event) => [
      event.football?.receivingPlayer.identity?.name,
      event.football?.passingPlayer.identity?.name,
      event.americanFootball?.quarterback.identity?.name
    ])
  ].filter(Boolean) as string[];
  return candidates.some((candidate) => {
    const normalized = normalizeSearchValue(candidate);
    return normalized.includes(expected) || expected.includes(normalized);
  });
}

function hasTrustedPlayerIdentityForRole(segment: TimelineSegment, player: string, role: "receiver" | "passer") {
  return Boolean(findTrustedPlayerIdentityForRole(segment, player, role));
}

function findTrustedPlayerIdentityForRole(segment: TimelineSegment, player: string, role: "receiver" | "passer") {
  return roleIdentities(segment, role).find((identity) => identityMatchesPlayer(identity, player)) ?? null;
}

function hasRoleSpecificPlayerConflict(segment: TimelineSegment, player: string, role: "receiver" | "passer") {
  return Boolean(findRoleSpecificPlayerConflict(segment, player, role));
}

function findRoleSpecificPlayerConflict(segment: TimelineSegment, player: string, role: "receiver" | "passer") {
  const requestedRoleIdentities = roleIdentities(segment, role);
  const otherRoleIdentities = roleIdentities(segment, role === "receiver" ? "passer" : "receiver");
  const requestedRolePresent = trustedDomainEvents(segment).some((event) =>
    role === "receiver" ? event.football?.receivingPlayer.present : event.football?.passingPlayer.present
  );
  const mismatchedRequestedRole = requestedRoleIdentities.find((identity) => !identityMatchesPlayer(identity, player));
  if (mismatchedRequestedRole && !requestedRoleIdentities.some((identity) => identityMatchesPlayer(identity, player))) {
    return {
      observed: `${role} ${mismatchedRequestedRole.name}`,
      evidence: mismatchedRequestedRole.evidence.length ? mismatchedRequestedRole.evidence : [`Structured ${role} identity is ${mismatchedRequestedRole.name}.`]
    };
  }
  const playerInOtherRole = otherRoleIdentities.find((identity) => identityMatchesPlayer(identity, player));
  if (requestedRolePresent && playerInOtherRole) {
    return {
      observed: `${role === "receiver" ? "passer" : "receiver"} ${playerInOtherRole.name}`,
      evidence: playerInOtherRole.evidence.length ? playerInOtherRole.evidence : [`Structured ${role === "receiver" ? "passer" : "receiver"} identity is ${playerInOtherRole.name}.`]
    };
  }
  return null;
}

function roleIdentities(segment: TimelineSegment, role: "receiver" | "passer"): PlayerIdentity[] {
  return trustedDomainEvents(segment)
    .map((event) => (role === "receiver" ? event.football?.receivingPlayer.identity : event.football?.passingPlayer.identity))
    .filter((identity): identity is PlayerIdentity => Boolean(identity));
}

function roleSpecificIdentityFilter(role?: DomainSearchFilters["role"]) {
  return role === "receiver" || role === "passer" ? role : null;
}

function identityMatchesPlayer(identity: PlayerIdentity | null | undefined, player: string) {
  return Boolean(identity && scopeValueMatchesPlayer(identity.name, player));
}

function scopeValueMatchesPlayer(value: string, player: string) {
  const valuePlayer = matchKnowledgePlayer(value)?.value;
  const expectedPlayer = matchKnowledgePlayer(player)?.value;
  if (valuePlayer && expectedPlayer) return valuePlayer.id === expectedPlayer.id;
  const normalized = normalizeSearchValue(value);
  const expected = normalizeSearchValue(player);
  return Boolean(normalized && expected && (normalized.includes(expected) || expected.includes(normalized)));
}

function splitFilterValues(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildVerificationChecks(asset: AssetRecord, segment: TimelineSegment, filters?: DomainSearchFilters): VerificationCheck[] {
  if (!filters || !hasActiveDomainFilters(filters)) return [];
  const checks: VerificationCheck[] = [];
  const events = trustedDomainEvents(segment);
  const segmentText = normalizeSearchValue(
    [
      asset.title,
      asset.description,
      asset.originalName,
      asset.tags.join(" "),
      segment.label,
      segment.transcript,
      segmentSearchText(segment),
      isTrustedDomainSegment(segment.domain) ? segment.domain?.searchText : ""
    ].join(" ")
  );
  const pushTextBackedCheck = (constraint: VerificationCheck["constraint"], expected: string | undefined, observed: string | null, confidence: number, evidence: string[]) => {
    if (!expected) return;
    const expectedValues = splitFilterValues(expected);
    const normalizedObserved = normalizeSearchValue(observed ?? "");
    const matchedExpected = expectedValues.find((value) => {
      const normalizedExpected = normalizeSearchValue(value);
      return normalizedObserved && (normalizedObserved.includes(normalizedExpected) || normalizedExpected.includes(normalizedObserved));
    });
    if (matchedExpected) {
      checks.push({ segmentId: segment.id, constraint, expected, observed: observed ?? "", status: "pass", confidence, evidence });
    } else if (textAllowsFilter(segmentText, expected)) {
      checks.push({ segmentId: segment.id, constraint, expected, observed: "text fallback", status: "soft_pass", confidence: 0.45, evidence: ["Matched unstructured text fallback."] });
    } else if (constraint === "competition" && expectedValues.some((value) => normalizeSearchValue(value) === "nfl") && segment.domain?.groups.includes("sports.american_football")) {
      checks.push({
        segmentId: segment.id,
        constraint,
        expected,
        observed: "sports.american_football",
        status: "soft_pass",
        confidence: 0.5,
        evidence: ["Matched NFL default through american-football domain scope."]
      });
    } else if ((constraint === "competition" || constraint === "season") && missingScopeCanStaySoft(segment, constraint, filters, segmentText)) {
      checks.push({
        segmentId: segment.id,
        constraint,
        expected,
        observed: "weak scope context",
        status: "soft_pass",
        confidence: 0.42,
        evidence: ["Matched weak scope context through player and event evidence."]
      });
    } else {
      checks.push({ segmentId: segment.id, constraint, expected, observed: observed ?? "missing", status: "unknown", confidence: 0, evidence: ["No indexed evidence for this constraint."] });
    }
  };

  pushTextBackedCheck(
    "competition",
    filters.competition,
    segment.domain?.scope?.competition?.value ?? null,
    segment.domain?.scope?.competition?.confidence ?? 0,
    segment.domain?.scope?.competition?.evidence ?? []
  );
  pushTextBackedCheck("season", filters.season, segment.domain?.scope?.season?.value ?? null, segment.domain?.scope?.season?.confidence ?? 0, segment.domain?.scope?.season?.evidence ?? []);

  if (filters.player) {
    const role = roleSpecificIdentityFilter(filters.role);
    const roleMatch = role ? findTrustedPlayerIdentityForRole(segment, filters.player, role) : null;
    const roleConflict = role && !roleMatch ? findRoleSpecificPlayerConflict(segment, filters.player, role) : null;
    if (roleMatch) {
      checks.push({
        segmentId: segment.id,
        constraint: "player",
        expected: `${filters.player} as ${role}`,
        observed: roleMatch.name,
        status: "pass",
        confidence: roleMatch.confidence,
        evidence: roleMatch.evidence
      });
    } else if (roleConflict) {
      checks.push({
        segmentId: segment.id,
        constraint: "player",
        expected: `${filters.player} as ${role}`,
        observed: roleConflict.observed,
        status: "fail",
        confidence: 0,
        evidence: roleConflict.evidence
      });
    } else if (role) {
      checks.push({
        segmentId: segment.id,
        constraint: "player",
        expected: `${filters.player} as ${role}`,
        observed: "missing role-bound identity",
        status: "fail",
        confidence: 0,
        evidence: ["No structured role-bound player identity for this query."]
      });
    } else {
      const identities = events
        .flatMap((event) => [event.football?.receivingPlayer.identity, event.football?.passingPlayer.identity, event.americanFootball?.quarterback.identity])
        .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
      const scopedPlayers = segment.domain?.scope?.players ?? [];
      const player = [...identities, ...scopedPlayers].find((candidate) => {
        const value = "name" in candidate ? candidate.name : candidate.value;
        return scopeValueMatchesPlayer(value, filters.player ?? "");
      });
      const observed = player ? ("name" in player ? player.name : player.value) : null;
      const confidence = player?.confidence ?? 0;
      const evidence = player?.evidence ?? [];
      pushTextBackedCheck("player", filters.player, observed, confidence, evidence);
    }
    const team = playerTeamForSeason(filters.player, filters.season);
    if (team) {
      const observedTeams = segment.domain?.scope?.teams.map((item) => item.value) ?? [];
      const normalizedTeam = normalizeSearchValue(team);
      const teamMatch = observedTeams.find((item) => normalizeSearchValue(item).includes(normalizedTeam) || normalizedTeam.includes(normalizeSearchValue(item)));
      checks.push({
        segmentId: segment.id,
        constraint: "player",
        expected: `${filters.player} roster team ${team}`,
        observed: teamMatch ?? (observedTeams.join(", ") || "missing"),
        status: teamMatch ? "pass" : "unknown",
        confidence: teamMatch ? 0.82 : 0,
        evidence: teamMatch ? [`Knowledge roster team for ${filters.player}: ${team}`] : ["No matching team scope for roster verification."]
      });
    }
  }

  const firstMatchingEvent = events[0];
  if (filters.eventType) {
    const match = events.find((event) => event.eventType === filters.eventType);
    const textMatch = !match && events.length === 0 && textAllowsEventFilter(segmentText, filters.eventType);
    checks.push({
      segmentId: segment.id,
      constraint: "eventType",
      expected: filters.eventType,
      observed: match?.eventType ?? (textMatch ? "text fallback" : firstMatchingEvent?.eventType ?? "missing"),
      status: match ? "pass" : textMatch ? "soft_pass" : "fail",
      confidence: match?.confidence ?? (textMatch ? 0.45 : 0),
      evidence: match ? [match.caption] : textMatch ? ["Matched unstructured event text fallback."] : ["No matching structured event type."]
    });
  }
  if (filters.passType) {
    const match = events.find((event) => event.football?.passType === filters.passType);
    checks.push({
      segmentId: segment.id,
      constraint: "passType",
      expected: filters.passType,
      observed: match?.football?.passType ?? firstMatchingEvent?.football?.passType ?? "missing",
      status: match ? "pass" : "fail",
      confidence: match?.football?.ball.confidence ?? 0,
      evidence: match ? [match.caption] : ["No matching structured pass type."]
    });
  }
  if (filters.fieldZone) {
    const match = events.find((event) => event.football?.fieldZone === filters.fieldZone);
    const calibration = match?.football?.field;
    const status = match ? (isTrustedDomainEvent(match) ? "pass" : calibration?.calibrationStatus === "estimated" ? "soft_pass" : "unknown") : "fail";
    checks.push({
      segmentId: segment.id,
      constraint: "fieldZone",
      expected: filters.fieldZone,
      observed: match?.football?.fieldZone ?? firstMatchingEvent?.football?.fieldZone ?? "missing",
      status,
      confidence: match?.football?.field.zoneConfidence ?? 0,
      evidence: match
        ? [
            match.caption,
            `Field calibration: ${calibration?.calibrationStatus ?? "not_configured"}`,
            ...(segment.sceneData?.vision?.fieldCalibration?.evidence ?? [])
          ].filter(Boolean)
        : ["No matching structured field zone."]
    });
  }
  if (filters.role && filters.role !== "any") {
    const match = events.find((event) => {
      if (filters.role === "receiver") return event.football?.receivingPlayer.present;
      if (filters.role === "passer") return event.football?.passingPlayer.present;
      if (filters.role === "shooter") return event.eventType === "shot";
      return false;
    });
    checks.push({
      segmentId: segment.id,
      constraint: "role",
      expected: filters.role,
      observed: match ? filters.role : "missing",
      status: match ? "pass" : "fail",
      confidence: match?.confidence ?? 0,
      evidence: match ? [match.caption] : ["No matching structured player role."]
    });
  }
  return checks;
}

export function buildSearchMatchReasons(
  asset: AssetRecord,
  segment: TimelineSegment,
  scores: {
    lexicalScore: number;
    semanticScore: number;
    visualScore: number;
    domainScore: number;
    knowledgeScore?: number;
  },
  filters?: DomainSearchFilters,
  queryPlan?: DomainQueryPlan,
  queryTerms: string[] = []
): SearchMatchReason[] {
  const reasons: SearchMatchReason[] = [];
  const events = trustedDomainEvents(segment);
  const firstEvent = events[0];
  const segmentText = normalizeSearchValue(
    [
      asset.title,
      asset.description,
      segment.label,
      segment.transcript,
      segment.tags.join(" "),
      segmentSearchText(segment),
      isTrustedDomainSegment(segment.domain) ? segment.domain?.searchText : ""
    ].join(" ")
  );

  if (queryPlan && Object.keys(queryPlan.domainFilters).length > 0) {
    reasons.push({
      segmentId: segment.id,
      kind: "query_plan",
      label: "Query plan",
      value: queryPlan.rewrittenQuery,
      confidence: queryPlan.confidence
    });
  }

  if (filters?.competition && segmentText.includes(normalizeSearchValue(filters.competition))) {
    reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Competition", value: filters.competition });
  }
  if (filters?.season && segmentText.includes(normalizeSearchValue(filters.season))) {
    reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Season", value: filters.season });
  }
  if (firstEvent && segment.domain?.scope?.competition) {
    const competition = segment.domain.scope.competition;
    reasons.push({
      segmentId: segment.id,
      kind: "domain_filter",
      label: "Scope competition",
      value: `${competition.value} (${competition.source})`,
      confidence: competition.confidence
    });
  }
  if (firstEvent && segment.domain?.scope?.season) {
    const season = segment.domain.scope.season;
    reasons.push({
      segmentId: segment.id,
      kind: "domain_filter",
      label: "Scope season",
      value: `${season.value} (${season.source})`,
      confidence: season.confidence
    });
  }
  if (filters?.player && segmentText.includes(normalizeSearchValue(filters.player))) {
    reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Player", value: filters.player });
  }

  for (const event of events) {
    if (filters?.eventType && event.eventType === filters.eventType) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Event", value: filters.eventType, confidence: event.confidence });
    }
    if (filters?.passType && event.football?.passType === filters.passType) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Pass", value: filters.passType, confidence: event.football.ball.confidence });
    }
    if (filters?.fieldZone && event.football?.fieldZone === filters.fieldZone) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Zone", value: filters.fieldZone, confidence: event.football.field.zoneConfidence });
    }
    if (filters?.role === "receiver" && event.football?.receivingPlayer.present) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Role", value: "receiver", confidence: event.football.receivingPlayer.confidence });
    }
    if (filters?.role === "passer" && event.football?.passingPlayer.present) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Role", value: "passer", confidence: event.football.passingPlayer.confidence });
    }
  }

  if (scores.lexicalScore > 0) {
    reasons.push({
      segmentId: segment.id,
      kind: "lexical",
      label: "Text",
      value: buildLexicalReasonValue(asset, segment, queryTerms, scores.lexicalScore)
    });
  }
  if (scores.domainScore > 0) {
    reasons.push({ segmentId: segment.id, kind: "semantic", label: "Related rank", value: `${scores.domainScore} related evidence score` });
  }
  if ((scores.knowledgeScore ?? 0) > 0) {
    reasons.push({ segmentId: segment.id, kind: "evidence", label: "Knowledge", value: `${scores.knowledgeScore} grounded terms matched` });
  }
  if (scores.semanticScore >= SEMANTIC_ONLY_THRESHOLD) {
    reasons.push({ segmentId: segment.id, kind: "semantic", label: "Vector", value: `${Math.round(scores.semanticScore * 100)}% text similarity` });
  }
  if (scores.visualScore >= VISUAL_ONLY_THRESHOLD) {
    reasons.push({ segmentId: segment.id, kind: "visual", label: "Visual", value: `${Math.round(scores.visualScore * 100)}% visual similarity` });
  }
  const includeSportsVisionReasons = shouldIncludeSportsVisionReasons(filters, queryPlan);
  const vision = segment.sceneData?.vision;
  const trustedVision = isTrustedVisionEvidence(vision);
  if (includeSportsVisionReasons && trustedVision && vision?.pitch.present) {
    reasons.push({ segmentId: segment.id, kind: "visual", label: "Pitch", value: `estimated ${Math.round(vision.pitch.confidence * 100)}%`, confidence: vision.pitch.confidence });
  }
  if (includeSportsVisionReasons && trustedVision && vision && isObjectEvidenceReady(vision.objects.players.status)) {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Players",
      value: `${vision.objects.players.status} ${vision.objects.players.countEstimate}`,
      confidence: vision.objects.players.confidence
    });
  }
  if (includeSportsVisionReasons && trustedVision && vision && isObjectEvidenceReady(vision.objects.ball.status)) {
    reasons.push({ segmentId: segment.id, kind: "visual", label: "Ball", value: vision.objects.ball.status, confidence: vision.objects.ball.confidence });
  }
  if (includeSportsVisionReasons && vision && isTrustedVisionFieldZone(vision)) {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Visual zone",
      value: vision.fieldCalibration
        ? `${vision.fieldZone.zone} · ${vision.fieldCalibration.status}/${vision.fieldCalibration.method}`
        : vision.fieldZone.zone,
      confidence: vision.fieldZone.confidence
    });
  }
  if (includeSportsVisionReasons && trustedVision && vision?.fieldCalibration && vision.fieldCalibration.attackingDirection !== "unknown") {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Direction",
      value: vision.fieldCalibration.attackingDirection,
      confidence: vision.fieldCalibration.attackingDirectionConfidence
    });
  }
  if (includeSportsVisionReasons && trustedVision && vision?.tracking?.status === "tracked") {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Track",
      value: [
        vision.tracking.version ?? "tracking_v0",
        vision.tracking.ballTrackId ?? "ball untracked",
        vision.tracking.nearestPlayerTrackId ? `near ${vision.tracking.nearestPlayerTrackId}` : "",
        vision.tracking.ballMovement.direction !== "unknown" ? vision.tracking.ballMovement.direction : ""
      ]
        .filter(Boolean)
        .join(" · "),
      confidence: vision.tracking.continuity
    });
  }
  if (includeSportsVisionReasons && trustedVision && vision?.eventClassification && vision.eventClassification.label !== "unknown") {
    reasons.push({
      segmentId: segment.id,
      kind: "evidence",
      label: "Classifier",
      value: vision.eventClassification.label,
      confidence: vision.eventClassification.confidence
    });
  }

  if (includeSportsVisionReasons && firstEvent) {
    const receiverIdentity = firstEvent.football?.receivingPlayer.identity;
    const passerIdentity = firstEvent.football?.passingPlayer.identity;
    const quarterbackIdentity = firstEvent.americanFootball?.quarterback.identity;
    if (receiverIdentity) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Receiver ID", value: `${receiverIdentity.name} (${receiverIdentity.source})`, confidence: receiverIdentity.confidence });
    } else if (passerIdentity) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Player ID", value: `${passerIdentity.name} (${passerIdentity.source})`, confidence: passerIdentity.confidence });
    } else if (quarterbackIdentity) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Quarterback ID", value: `${quarterbackIdentity.name} (${quarterbackIdentity.source})`, confidence: quarterbackIdentity.confidence });
    }
    for (const heuristic of firstEvent.evidence.heuristics.slice(0, 2)) {
      reasons.push({ segmentId: segment.id, kind: "evidence", label: "Evidence", value: heuristic, confidence: firstEvent.confidence });
    }
    for (const limitation of firstEvent.football?.limitations.slice(0, 1) ?? []) {
      reasons.push({ segmentId: segment.id, kind: "limitation", label: "Limitation", value: limitation });
    }
  }

  return reasons.slice(0, 10);
}

function buildLexicalReasonValue(asset: AssetRecord, segment: TimelineSegment, queryTerms: string[], lexicalScore: number) {
  const matches = findLexicalTermMatches(asset, segment, queryTerms);
  if (matches.length === 0) {
    return `${lexicalScore} query ${lexicalScore === 1 ? "term" : "terms"} matched`;
  }
  const detail = matches
    .slice(0, 4)
    .map((match) => `${match.term} (${match.sources.slice(0, 2).join(", ")})`)
    .join(" · ");
  const suffix = matches.length > 4 ? ` · +${matches.length - 4} more` : "";
  return `${matches.length} query ${matches.length === 1 ? "term" : "terms"} matched: ${detail}${suffix}`;
}

function findLexicalTermMatches(asset: AssetRecord, segment: TimelineSegment, queryTerms: string[]) {
  const matches = new Map<string, Set<string>>();
  for (const term of unique(queryTerms.map((value) => value.trim()).filter(Boolean))) {
    for (const source of buildLexicalMatchSources(asset, segment)) {
      const normalized = normalizeForLexicalMatch(source.text);
      const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
      if (!matchesLexicalTerm(normalized, tokens, term)) continue;
      if (!matches.has(term)) matches.set(term, new Set());
      matches.get(term)?.add(source.label);
    }
  }
  return Array.from(matches.entries()).map(([term, sources]) => ({
    term,
    sources: Array.from(sources)
  }));
}

function buildLexicalMatchSources(asset: AssetRecord, segment: TimelineSegment) {
  const scene = segment.sceneData;
  return [
    { label: "title", text: asset.title },
    { label: "description", text: asset.description },
    { label: "asset summary", text: asset.summary },
    { label: "moment label", text: segment.label },
    { label: "moment summary", text: segment.summary ?? "" },
    { label: "speech", text: segment.transcript },
    { label: "tags", text: segment.tags.join(" ") },
    { label: "VLM caption", text: scene?.vlm?.caption ?? "" },
    { label: "visible text", text: scene?.vlm?.visibleText.join(" ") ?? "" },
    { label: "screen text", text: scene?.text.screenText.join(" ") ?? "" },
    { label: "subtitle", text: scene?.text.subtitles.join(" ") ?? "" },
    { label: "overlay", text: scene?.text.overlays.join(" ") ?? "" },
    { label: "VLM evidence", text: scene?.vlm?.evidence.join(" ") ?? "" },
    { label: "VLM visual", text: [...(scene?.vlm?.actions ?? []), ...(scene?.vlm?.objects ?? [])].join(" ") },
    { label: "VLM description", text: scene?.vlm?.description ?? "" },
    { label: "domain text", text: isTrustedDomainSegment(segment.domain) ? segment.domain?.searchText ?? "" : "" },
    { label: "search text", text: segmentSearchText(segment) }
  ].filter((source) => source.text.trim().length > 0);
}

function shouldIncludeSportsVisionReasons(filters?: DomainSearchFilters, queryPlan?: DomainQueryPlan) {
  if (queryPlan?.relatedKnowledgeMode !== "none") {
    return true;
  }
  return Boolean(filters && (filters.competition || filters.season || filters.player || filters.eventType || filters.passType || filters.fieldZone || filters.role));
}

export function formatDomainFilters(filters?: DomainSearchFilters) {
  if (!filters) return "none";
  return Object.entries(filters)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `${key}:${value}`)
    .join(",");
}

export function recencyBoost(createdAt: string) {
  const ageDays = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  return Math.max(0, 0.6 - ageDays * 0.03);
}
