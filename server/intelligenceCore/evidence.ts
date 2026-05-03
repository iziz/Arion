import type { AssetRecord, ClipResult, DomainQueryPlan, DomainSearchFilters, SearchMatchReason, TimelineSegment, VerificationCheck } from "../../shared/types";
import { isTrustedDomainSegment, isTrustedDomainEvent, isTrustedVisionEvidence, isTrustedVisionFieldZone, trustedDomainEvents } from "../evidenceTrust";
import { playerTeamForSeason } from "../sportsKnowledge";
import { isObjectEvidenceReady, segmentSearchText } from "./sceneTimeline";
import { formatTime, normalizeSearchValue, unique } from "./textUtils";

export function clipFromSegment(asset: AssetRecord, segment: TimelineSegment, verification: VerificationCheck[], reasons: SearchMatchReason[]): ClipResult {
  const event = trustedDomainEvents(segment)[0];
  const football = event?.football;
  const americanFootball = event?.americanFootball;
  const player =
    football?.receivingPlayer.identity?.name ??
    football?.passingPlayer.identity?.name ??
    americanFootball?.quarterback.identity?.name ??
    segment.domain?.scope?.players[0]?.value ??
    null;
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

function summarizeVerification(verification: VerificationCheck[]): ClipResult["verificationSummary"] {
  return {
    pass: verification.filter((check) => check.status === "pass").length,
    softPass: verification.filter((check) => check.status === "soft_pass").length,
    unknown: verification.filter((check) => check.status === "unknown").length,
    fail: verification.filter((check) => check.status === "fail").length
  };
}

export function scoreText(input: string, queryTerms: string[]) {
  const haystack = input.toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export function scoreSources(sources: TimelineSegment["sources"]) {
  let score = 0;
  if (sources.includes("whisper")) score += 0.75;
  if (sources.includes("paddleocr")) score += 0.65;
  if (sources.includes("shot")) score += 0.45;
  if (sources.includes("visual")) score += 0.25;
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
  return Boolean(filters && Object.values(filters).some((value) => typeof value === "string" && value.trim().length > 0));
}

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
  if (!filters || !hasActiveDomainFilters(filters)) return true;
  const fullSegmentText = normalizeSearchValue(
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
  if (!scopeFilterAllows(segment, "competition", filters.competition) && !textAllowsFilter(fullSegmentText, filters.competition)) {
    if (!missingScopeCanStaySoft(segment, "competition", filters, fullSegmentText)) return false;
  }
  if (!scopeFilterAllows(segment, "season", filters.season) && !textAllowsFilter(fullSegmentText, filters.season)) {
    if (!missingScopeCanStaySoft(segment, "season", filters, fullSegmentText)) return false;
  }
  const textTerms = [filters.player].map((value) => value?.trim()).filter(Boolean) as string[];
  if (textTerms.length > 0) {
    if (!textTerms.every((term) => fullSegmentText.includes(normalizeSearchValue(term)))) return false;
  }

  const eventFilters = {
    eventType: filters.eventType?.trim(),
    passType: filters.passType?.trim(),
    fieldZone: filters.fieldZone?.trim(),
    role: filters.role?.trim()
  };
  const needsEventMatch = Object.values(eventFilters).some(Boolean);
  if (!needsEventMatch) return true;
  const structuredMatch = trustedDomainEvents(segment).some((event) => {
    if (eventFilters.eventType && event.eventType !== eventFilters.eventType) return false;
    if (eventFilters.passType && event.football?.passType !== eventFilters.passType) return false;
    if (eventFilters.fieldZone && event.football?.fieldZone !== eventFilters.fieldZone) return false;
    if (filters.role === "receiver" && !event.football?.receivingPlayer.present) return false;
    if (filters.role === "passer" && !event.football?.passingPlayer.present) return false;
    if (filters.role === "shooter" && event.eventType !== "shot") return false;
    return true;
  });
  if (structuredMatch) return true;
  if (eventFilters.passType || eventFilters.fieldZone) return false;
  return false;
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
  if (!filters.player || !textAllowsFilter(fullSegmentText, filters.player)) return false;
  if (hasTrustedPlayerIdentity(segment, filters.player)) return true;
  const hasEventConstraint = Boolean(filters.eventType || filters.passType || filters.fieldZone || filters.role);
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
    const identities = events
      .flatMap((event) => [event.football?.receivingPlayer.identity, event.football?.passingPlayer.identity, event.americanFootball?.quarterback.identity])
      .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
    const scopedPlayers = segment.domain?.scope?.players ?? [];
    const player = [...identities, ...scopedPlayers].find((candidate) => {
      const value = "name" in candidate ? candidate.name : candidate.value;
      const normalized = normalizeSearchValue(value);
      const expected = normalizeSearchValue(filters.player ?? "");
      return normalized.includes(expected) || expected.includes(normalized);
    });
    const observed = player ? ("name" in player ? player.name : player.value) : null;
    const confidence = player?.confidence ?? 0;
    const evidence = player?.evidence ?? [];
    pushTextBackedCheck("player", filters.player, observed, confidence, evidence);
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
    const textMatch = !match && textAllowsEventFilter(segmentText, filters.eventType);
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
    const textMatch = !match && filters.role === "shooter" && textAllowsEventFilter(segmentText, "shot");
    checks.push({
      segmentId: segment.id,
      constraint: "role",
      expected: filters.role,
      observed: match ? filters.role : textMatch ? "text fallback" : "missing",
      status: match ? "pass" : textMatch ? "soft_pass" : "fail",
      confidence: match?.confidence ?? (textMatch ? 0.4 : 0),
      evidence: match ? [match.caption] : textMatch ? ["Matched unstructured goal/shot text fallback."] : ["No matching structured player role."]
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
  queryPlan?: DomainQueryPlan
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
  }

  if (scores.lexicalScore > 0) {
    reasons.push({ segmentId: segment.id, kind: "lexical", label: "Text", value: `${scores.lexicalScore} query terms matched` });
  }
  if (scores.domainScore > 0) {
    reasons.push({ segmentId: segment.id, kind: "semantic", label: "Domain rank", value: `${scores.domainScore} sports score` });
  }
  if ((scores.knowledgeScore ?? 0) > 0) {
    reasons.push({ segmentId: segment.id, kind: "evidence", label: "Knowledge", value: `${scores.knowledgeScore} grounded terms matched` });
  }
  if (scores.semanticScore > 0.72) {
    reasons.push({ segmentId: segment.id, kind: "semantic", label: "Vector", value: `${Math.round(scores.semanticScore * 100)}% text similarity` });
  }
  if (scores.visualScore > 0.25) {
    reasons.push({ segmentId: segment.id, kind: "visual", label: "Visual", value: `${Math.round(scores.visualScore * 100)}% visual similarity` });
  }
  const vision = segment.sceneData?.vision;
  const trustedVision = isTrustedVisionEvidence(vision);
  if (trustedVision && vision?.pitch.present) {
    reasons.push({ segmentId: segment.id, kind: "visual", label: "Pitch", value: `estimated ${Math.round(vision.pitch.confidence * 100)}%`, confidence: vision.pitch.confidence });
  }
  if (trustedVision && vision && isObjectEvidenceReady(vision.objects.players.status)) {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Players",
      value: `${vision.objects.players.status} ${vision.objects.players.countEstimate}`,
      confidence: vision.objects.players.confidence
    });
  }
  if (trustedVision && vision && isObjectEvidenceReady(vision.objects.ball.status)) {
    reasons.push({ segmentId: segment.id, kind: "visual", label: "Ball", value: vision.objects.ball.status, confidence: vision.objects.ball.confidence });
  }
  if (vision && isTrustedVisionFieldZone(vision)) {
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
  if (trustedVision && vision?.fieldCalibration && vision.fieldCalibration.attackingDirection !== "unknown") {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Direction",
      value: vision.fieldCalibration.attackingDirection,
      confidence: vision.fieldCalibration.attackingDirectionConfidence
    });
  }
  if (trustedVision && vision?.tracking?.status === "tracked") {
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
  if (trustedVision && vision?.eventClassification && vision.eventClassification.label !== "unknown") {
    reasons.push({
      segmentId: segment.id,
      kind: "evidence",
      label: "Classifier",
      value: vision.eventClassification.label,
      confidence: vision.eventClassification.confidence
    });
  }

  if (firstEvent) {
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
