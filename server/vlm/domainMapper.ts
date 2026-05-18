import type { AssetRecord, DomainEvent, DomainVlmQuality, PlayerIdentity, TimelineSegment } from "../../shared/types";
import { isTrustedDomainEvent, isTrustedDomainSegment } from "../evidenceTrust";

export type VlmSportsEventResponse = {
  domain?: string;
  model?: string;
  provider?: string;
  caption?: string;
  eventType?: string;
  confidence?: number;
  labels?: string[];
  evidence?: string[];
  football?: {
    phase?: string;
    fieldZone?: string;
    passType?: string;
    receivingPlayer?: VlmPlayerRole;
    passingPlayer?: VlmPlayerRole;
    ballState?: string;
    attackingDirection?: string;
  };
  americanFootball?: {
    phase?: string;
    playType?: string;
    quarterback?: VlmPlayerRole;
    pressure?: {
      present?: boolean;
      confidence?: number;
      source?: string;
    };
    pocket?: {
      status?: string;
      confidence?: number;
    };
    decision?: {
      outcome?: string;
      confidence?: number;
    };
  };
  rawResponse?: string;
};

type VlmPlayerRole = {
  present?: boolean;
  name?: string | null;
  confidence?: number;
  trackId?: string | null;
  evidence?: string[];
};

export function mergeVlmResponse(asset: AssetRecord, segment: TimelineSegment, response: VlmSportsEventResponse, requestedDomain: string, modelName: string): TimelineSegment {
  const domain = normalizeDomain(response.domain ?? requestedDomain);
  const base = segment.domain;
  const baseEvents = (base?.events ?? []).filter(isTrustedDomainEvent);
  const trustedBase = isTrustedDomainSegment(base) || baseEvents.length > 0;
  const rawEvent = buildVlmDomainEvent(segment, response, domain, modelName);
  if (!rawEvent) return segment;
  const event = mergeObservedFootballRoleEvidence(rawEvent, baseEvents);
  const captions = unique([response.caption, ...(trustedBase ? (base?.captions ?? []) : [])].filter(isNonEmpty));
  const labels = unique([domain, ...event.labels, ...(response.labels ?? []), ...(trustedBase ? (base?.labels ?? []) : [])].filter(isNonEmpty));
  const events = uniqueEvents([event, ...(trustedBase ? baseEvents : [])]).sort((a, b) => b.confidence - a.confidence).slice(0, 4);
  const searchText = [
    trustedBase ? base?.searchText : "",
    `VLM caption: ${event.caption}.`,
    `VLM event: ${event.eventType}.`,
    event.football
      ? `VLM football: ${event.football.fieldZone} ${event.football.passType} passer=${playerRoleSearchText(event.football.passingPlayer)} receiver=${playerRoleSearchText(event.football.receivingPlayer)}.`
      : "",
    event.americanFootball
      ? `VLM american football: ${event.americanFootball.playType} pressure=${event.americanFootball.pressure.present} pocket=${event.americanFootball.pocket.status} decision=${event.americanFootball.decision.outcome}.`
      : "",
    response.evidence?.join(" ")
  ]
    .filter(isNonEmpty)
    .join(" ");

  return {
    ...segment,
    domain: {
      groups: unique([domain, ...(base?.groups ?? [])]).filter(isSportsDomainGroup),
      captions,
      labels,
      events,
      scope: base?.scope,
      searchText,
      confidence: Number(Math.max(base?.confidence ?? 0, event.confidence).toFixed(2)),
      generatedBy: base?.generatedBy ? `${base.generatedBy}+vlm:${response.model ?? modelName}` : `vlm:${response.model ?? modelName}`,
      trust: "detected",
      vlm: buildVlmQuality(response, "refined", "Related knowledge VLM structure accepted.", null, modelName)
    },
    tags: unique([...segment.tags, ...labels]).slice(0, 32),
    sources: unique([...segment.sources, "domain" as const])
  };
}

export function markVlmQuality(
  segment: TimelineSegment,
  response: VlmSportsEventResponse | null,
  status: DomainVlmQuality["status"],
  message: string,
  error: string | null,
  modelName: string
): TimelineSegment {
  if (!segment.domain) return segment;
  return {
    ...segment,
    domain: {
      ...segment.domain,
      vlm: buildVlmQuality(response, status, message, error, modelName)
    }
  };
}

function buildVlmQuality(
  response: VlmSportsEventResponse | null,
  status: DomainVlmQuality["status"],
  message: string,
  error: string | null,
  modelName: string
): DomainVlmQuality {
  return {
    provider: response?.provider ?? "qwen-vl",
    model: response?.model ?? modelName,
    status,
    attemptedAt: new Date().toISOString(),
    confidence: clampConfidence(response?.confidence ?? 0),
    message,
    rawResponse: truncateRaw(response?.rawResponse ?? null),
    error
  };
}

function buildVlmDomainEvent(
  segment: TimelineSegment,
  response: VlmSportsEventResponse,
  domain: "sports.football" | "sports.american_football",
  modelName: string
): DomainEvent | null {
  const caption = response.caption?.trim();
  const confidence = clampConfidence(response.confidence ?? 0);
  if (!caption || confidence <= 0) return null;
  if (domain === "sports.american_football") return buildVlmAmericanFootballEvent(segment, response, caption, confidence, modelName);
  const football = response.football ?? {};
  const passType = normalizePassType(football.passType);
  const fieldZone = normalizeFieldZone(football.fieldZone);
  const receiverIdentity = buildPlayerIdentity(football.receivingPlayer);
  const passerIdentity = buildPlayerIdentity(football.passingPlayer);
  const receiverPresent = Boolean(football.receivingPlayer?.present || receiverIdentity);
  const passerPresent = Boolean(football.passingPlayer?.present || passerIdentity);
  const eventType = normalizeFootballEventType(normalizeEventType(response.eventType), passType, receiverPresent, passerPresent);
  const labels = unique([
    domain,
    eventType !== "scene" ? `event.${eventType}` : "",
    passType !== "unknown" ? `pass.${passType}` : "",
    fieldZone !== "unknown" ? `zone.${fieldZone}` : "",
    receiverPresent ? "role.receiver" : "",
    passerPresent ? "role.passer" : "",
    receiverIdentity ? `player.${normalizeLabel(receiverIdentity.name)}` : "",
    passerIdentity ? `player.${normalizeLabel(passerIdentity.name)}` : "",
    ...(response.labels ?? [])
  ].filter(isNonEmpty));

  return {
    id: `${segment.id}-domain-vlm-1`,
    domain,
    ontologyVersion: "sports-domain-v1",
    caption,
    eventType,
    labels,
    confidence,
    trust: "detected",
    evidence: {
      asr: snippets(segment.transcript),
      ocr: [
        ...(segment.sceneData?.text.subtitles ?? []),
        ...(segment.sceneData?.text.screenText ?? []),
        ...(segment.sceneData?.text.overlays ?? [])
      ].slice(0, 4),
      visual: [`VLM caption: ${caption}`, ...(response.evidence ?? [])].slice(0, 8),
      metadata: [response.provider ?? "vlm-worker", response.model ?? modelName],
      heuristics: ["Structured by optional local VLM worker.", "Use verification checks before treating VLM output as ground truth."]
    },
    football: {
      phase: normalizePhase(football.phase),
      fieldZone,
      passType,
      receivingPlayer: {
        present: receiverPresent,
        confidence: receiverPresent ? clampConfidence(football.receivingPlayer?.confidence ?? confidence) : 0,
        trackId: football.receivingPlayer?.trackId ?? segment.sceneData?.vision?.tracking?.nearestPlayerTrackId ?? null,
        trackingStatus: receiverPresent ? "estimated" : "not_configured",
        identity: receiverIdentity
      },
      passingPlayer: {
        present: passerPresent,
        confidence: passerPresent ? clampConfidence(football.passingPlayer?.confidence ?? confidence) : 0,
        trackId: football.passingPlayer?.trackId ?? null,
        trackingStatus: passerPresent ? "estimated" : "not_configured",
        identity: passerIdentity
      },
      ball: {
        state: normalizeBallState(football.ballState, passType, eventType),
        confidence: passType !== "unknown" || eventType === "pass_receive" || eventType === "shot" ? confidence : 0,
        trackingStatus: "estimated"
      },
      field: {
        calibrationStatus: fieldZone === "unknown" ? "not_configured" : "estimated",
        attackingDirection: normalizeDirection(football.attackingDirection),
        zoneConfidence: fieldZone === "unknown" ? 0 : confidence
      },
      limitations: [
        "This event was generated by a local VLM worker from sampled frames and indexed text.",
        "It is not calibrated player tracking, jersey recognition, or pitch homography."
      ]
    }
  };
}

function mergeObservedFootballRoleEvidence(event: DomainEvent, baseEvents: DomainEvent[]): DomainEvent {
  if (!event.football || event.domain !== "sports.football" || event.eventType !== "pass_receive") return event;
  const basePassEvents = baseEvents.filter((baseEvent) => baseEvent.domain === "sports.football" && baseEvent.eventType === "pass_receive" && baseEvent.football);
  if (basePassEvents.length === 0) return event;

  const passingIdentity = event.football.passingPlayer.identity ?? observedRoleIdentity(basePassEvents, "passingPlayer");
  const receivingIdentity = event.football.receivingPlayer.identity ?? observedRoleIdentity(basePassEvents, "receivingPlayer");
  if (!passingIdentity && !receivingIdentity) return event;

  const mergedFootball = {
    ...event.football,
    passingPlayer: mergeFootballRole(event.football.passingPlayer, passingIdentity),
    receivingPlayer: mergeFootballRole(event.football.receivingPlayer, receivingIdentity)
  };
  const mergedLabels = unique([
    ...event.labels,
    passingIdentity ? "role.passer" : "",
    receivingIdentity ? "role.receiver" : "",
    passingIdentity ? `player.${normalizeLabel(passingIdentity.name)}` : "",
    receivingIdentity ? `player.${normalizeLabel(receivingIdentity.name)}` : ""
  ].filter(isNonEmpty));
  const mergedHeuristics = unique([
    ...event.evidence.heuristics,
    passingIdentity && !event.football.passingPlayer.identity ? "Merged segment-local observed passer identity from the base domain index." : "",
    receivingIdentity && !event.football.receivingPlayer.identity ? "Merged segment-local observed receiver identity from the base domain index." : ""
  ].filter(isNonEmpty));

  return {
    ...event,
    labels: mergedLabels,
    evidence: {
      ...event.evidence,
      heuristics: mergedHeuristics
    },
    football: mergedFootball
  };
}

function observedRoleIdentity(baseEvents: DomainEvent[], role: "passingPlayer" | "receivingPlayer"): PlayerIdentity | null {
  for (const event of baseEvents) {
    const identity = event.football?.[role].identity;
    if (!identity || !isSegmentLocalIdentity(identity)) continue;
    return identity;
  }
  return null;
}

function mergeFootballRole(
  role: NonNullable<DomainEvent["football"]>["passingPlayer"],
  identity: PlayerIdentity | null
): NonNullable<DomainEvent["football"]>["passingPlayer"] {
  if (!identity) return role;
  return {
    ...role,
    present: true,
    identity,
    confidence: Math.max(role.confidence, identity.confidence),
    trackingStatus: role.trackingStatus === "not_configured" ? "estimated" : role.trackingStatus
  };
}

function isSegmentLocalIdentity(identity: PlayerIdentity) {
  return identity.source === "asr" || identity.source === "ocr" || identity.source === "vlm";
}

function buildVlmAmericanFootballEvent(
  segment: TimelineSegment,
  response: VlmSportsEventResponse,
  caption: string,
  confidence: number,
  modelName: string
): DomainEvent {
  const americanFootball = response.americanFootball ?? {};
  const eventType = normalizeEventType(response.eventType);
  const playType = normalizeAmericanFootballPlayType(americanFootball.playType, eventType);
  const quarterback = buildPlayerIdentity(americanFootball.quarterback);
  const pressurePresent = Boolean(americanFootball.pressure?.present) || eventType === "pressure";
  const pressureConfidence = clampConfidence(americanFootball.pressure?.confidence ?? (pressurePresent ? confidence : 0));
  const pocketStatus = normalizePocketStatus(americanFootball.pocket?.status, eventType, pressurePresent);
  const decisionOutcome = normalizeDecisionOutcome(americanFootball.decision?.outcome, eventType, playType);
  const labels = unique([
    "sports.american_football",
    eventType !== "scene" ? `event.${eventType}` : "",
    playType !== "unknown" ? `play.${playType}` : "",
    pressurePresent ? "pressure.present" : "",
    pocketStatus !== "unknown" ? `pocket.${pocketStatus}` : "",
    decisionOutcome !== "unknown" ? `decision.${decisionOutcome}` : "",
    quarterback ? "role.quarterback" : "",
    quarterback ? `player.${normalizeLabel(quarterback.name)}` : "",
    ...(response.labels ?? [])
  ].filter(isNonEmpty));

  return {
    id: `${segment.id}-domain-vlm-1`,
    domain: "sports.american_football",
    ontologyVersion: "sports-domain-v1",
      caption,
      eventType,
      labels,
      confidence,
      trust: "detected",
      evidence: {
      asr: snippets(segment.transcript),
      ocr: [
        ...(segment.sceneData?.text.subtitles ?? []),
        ...(segment.sceneData?.text.screenText ?? []),
        ...(segment.sceneData?.text.overlays ?? [])
      ].slice(0, 4),
      visual: [`VLM caption: ${caption}`, ...(response.evidence ?? [])].slice(0, 8),
      metadata: [response.provider ?? "vlm-worker", response.model ?? modelName],
      heuristics: ["Structured by optional local VLM worker.", "Use verification checks before treating VLM output as ground truth."]
    },
    americanFootball: {
      phase: normalizeAmericanFootballPhase(americanFootball.phase, eventType, playType),
      playType,
      quarterback: {
        present: Boolean(quarterback) || eventType === "scramble" || eventType === "throw_on_run" || eventType === "pocket_escape",
        confidence: quarterback ? clampConfidence(americanFootball.quarterback?.confidence ?? confidence) : 0,
        trackId: americanFootball.quarterback?.trackId ?? segment.sceneData?.vision?.tracking?.nearestPlayerTrackId ?? null,
        trackingStatus: quarterback ? "estimated" : "not_configured",
        identity: quarterback
      },
      pressure: {
        present: pressurePresent,
        confidence: pressureConfidence,
        source: normalizePressureSource(americanFootball.pressure?.source)
      },
      pocket: {
        status: pocketStatus,
        confidence: pocketStatus === "unknown" ? 0 : clampConfidence(americanFootball.pocket?.confidence ?? confidence)
      },
      decision: {
        outcome: decisionOutcome,
        confidence: decisionOutcome === "unknown" ? 0 : clampConfidence(americanFootball.decision?.confidence ?? confidence)
      },
      limitations: [
        "This event was generated by a local VLM worker from sampled frames and indexed text.",
        "It is not a full American-football play model with down-distance, route, or pressure attribution."
      ]
    }
  };
}

function buildPlayerIdentity(role?: VlmPlayerRole): PlayerIdentity | null {
  const name = role?.name?.trim();
  if (!name) return null;
  const evidence = stringList(role?.evidence, 4);
  return {
    name,
    confidence: clampConfidence(role?.confidence ?? 0.45),
    source: "vlm",
    evidence: evidence.length > 0 ? evidence : ["Local VLM worker reported this player name."]
  };
}

function normalizeEventType(value?: string) {
  const normalized = normalize(value);
  if (/through.*receive|pass.*receive|receive/.test(normalized)) return "pass_receive";
  if (/shot|shoot|finish|goal/.test(normalized)) return "shot";
  if (/dribble|carry|take_on/.test(normalized)) return "dribble";
  if (/scramble/.test(normalized)) return "scramble";
  if (/pocket.*escape|out.*of.*pocket/.test(normalized)) return "pocket_escape";
  if (/throw.*run|rolling|off.*platform/.test(normalized)) return "throw_on_run";
  if (/pressure|press/.test(normalized)) return "pressure";
  if (/save/.test(normalized)) return "save";
  if (/progressive/.test(normalized)) return "progressive_pass";
  return normalized || "scene";
}

function normalizeFootballEventType(
  value: string,
  passType: NonNullable<DomainEvent["football"]>["passType"],
  receiverPresent: boolean,
  passerPresent: boolean
) {
  if ((value === "scene" || value === "progressive_pass") && (passType !== "unknown" || receiverPresent || passerPresent)) return "pass_receive";
  return value;
}

function normalizeDomain(value?: string): "sports.football" | "sports.american_football" {
  return value === "sports.american_football" ? "sports.american_football" : "sports.football";
}

function normalizeAmericanFootballPlayType(value: string | undefined, eventType: string): NonNullable<DomainEvent["americanFootball"]>["playType"] {
  const normalized = normalize(value || eventType);
  if (/scramble/.test(normalized)) return "scramble";
  if (/pocket.*escape|out.*of.*pocket/.test(normalized)) return "pocket_escape";
  if (/throw.*run|rolling|off.*platform/.test(normalized)) return "throw_on_run";
  if (/pressure|press|rush|blitz/.test(normalized)) return "pressure";
  if (/pass|throw/.test(normalized)) return "pass";
  if (/rush|run/.test(normalized)) return "rush";
  return "unknown";
}

function normalizeAmericanFootballPhase(
  value: string | undefined,
  eventType: string,
  playType: NonNullable<DomainEvent["americanFootball"]>["playType"]
): NonNullable<DomainEvent["americanFootball"]>["phase"] {
  const normalized = normalize(value);
  if (/scramble/.test(normalized) || eventType === "scramble" || playType === "scramble") return "scramble";
  if (/play.*action/.test(normalized)) return "play_action";
  if (/designed.*run/.test(normalized) || playType === "rush") return "designed_run";
  if (/dropback|pass/.test(normalized) || playType === "pass" || playType === "throw_on_run" || playType === "pocket_escape" || playType === "pressure") return "dropback";
  return "unknown";
}

function normalizePocketStatus(value: string | undefined, eventType: string, pressurePresent: boolean): NonNullable<DomainEvent["americanFootball"]>["pocket"]["status"] {
  const normalized = normalize(value);
  if (/escaped|escape|out.*of.*pocket/.test(normalized) || eventType === "pocket_escape") return "escaped";
  if (/collaps/.test(normalized) || pressurePresent) return "collapsing";
  if (/intact|clean/.test(normalized)) return "intact";
  return "unknown";
}

function normalizeDecisionOutcome(
  value: string | undefined,
  eventType: string,
  playType: NonNullable<DomainEvent["americanFootball"]>["playType"]
): NonNullable<DomainEvent["americanFootball"]>["decision"]["outcome"] {
  const normalized = normalize(value);
  if (/run|rush/.test(normalized) || eventType === "scramble" || playType === "scramble") return "run";
  if (/throw|pass/.test(normalized) || eventType === "throw_on_run" || playType === "throw_on_run" || playType === "pass") return "throw";
  if (/sack.*avoid|avoid.*sack|escape/.test(normalized) || eventType === "pocket_escape") return "sack_avoidance";
  return "unknown";
}

function normalizePressureSource(value: string | undefined): NonNullable<DomainEvent["americanFootball"]>["pressure"]["source"] {
  const normalized = normalize(value);
  if (normalized === "text" || normalized === "vision" || normalized === "vlm") return normalized;
  return "vlm";
}

function isSportsDomainGroup(value: string): value is "sports.football" | "sports.american_football" {
  return value === "sports.football" || value === "sports.american_football";
}

function normalizePassType(value?: string): NonNullable<DomainEvent["football"]>["passType"] {
  const normalized = normalize(value);
  if (/through|in_behind|behind/.test(normalized)) return "through_ball";
  if (/cross/.test(normalized)) return "cross";
  if (/cutback|cut_back/.test(normalized)) return "cutback";
  if (/long/.test(normalized)) return "long_ball";
  if (/short|pass/.test(normalized)) return "short_pass";
  return "unknown";
}

function normalizeFieldZone(value?: string): NonNullable<DomainEvent["football"]>["fieldZone"] {
  const normalized = normalize(value);
  if (/penalty|box|area/.test(normalized)) return "penalty_area";
  if (/final|attacking/.test(normalized)) return "final_third";
  if (/middle|midfield/.test(normalized)) return "middle_third";
  if (/defensive|own/.test(normalized)) return "defensive_third";
  return "unknown";
}

function normalizePhase(value?: string): NonNullable<DomainEvent["football"]>["phase"] {
  const normalized = normalize(value);
  if (/set/.test(normalized)) return "set_piece";
  if (/transition|counter/.test(normalized)) return "transition";
  if (/attack/.test(normalized)) return "attack";
  return "unknown";
}

function normalizeBallState(value: string | undefined, passType: NonNullable<DomainEvent["football"]>["passType"], eventType: string): NonNullable<DomainEvent["football"]>["ball"]["state"] {
  const normalized = normalize(value);
  if (/shot/.test(normalized) || eventType === "shot") return "shot";
  if (/pass|travel/.test(normalized) || passType !== "unknown" || eventType === "pass_receive") return "pass_travel";
  if (/play/.test(normalized)) return "in_play";
  return "unknown";
}

function normalizeDirection(value?: string): NonNullable<DomainEvent["football"]>["field"]["attackingDirection"] {
  const normalized = normalize(value);
  if (/left.*right|ltr/.test(normalized)) return "left_to_right";
  if (/right.*left|rtl/.test(normalized)) return "right_to_left";
  return "unknown";
}

function normalize(value?: string) {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeLabel(value: string) {
  return normalize(value).replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.max(0, Math.min(1, value)).toFixed(2));
}

function truncateRaw(value: string | null) {
  if (!value) return null;
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}

function playerRoleSearchText(role: NonNullable<DomainEvent["football"]>["passingPlayer"] | NonNullable<DomainEvent["football"]>["receivingPlayer"]) {
  if (!role.present) return "false";
  return role.identity?.name ? `${role.identity.name}` : "true";
}

function snippets(text: string) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function uniqueEvents(events: DomainEvent[]) {
  const byId = new Map<string, DomainEvent>();
  for (const event of events) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  return Array.from(byId.values());
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringList(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, limit);
}
