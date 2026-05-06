import type { DomainEvent, PlayerIdentity, TimelineSegment } from "../../../../../../shared/types";
import { isTrustedDomainSegment } from "../../../../../evidenceTrust";
import type { AmericanFootballActionSpot, AmericanFootballActionSpottingResult } from "./types";

export function applyAmericanFootballActionSpots(timeline: TimelineSegment[], result: AmericanFootballActionSpottingResult): TimelineSegment[] {
  if (!result.available || result.spots.length === 0) return timeline;
  return timeline.map((segment) => {
    const spots = spotsForSegment(result.spots, segment);
    if (spots.length === 0) return segment;
    return applySegmentSpots(segment, result, spots);
  });
}

function spotsForSegment(spots: AmericanFootballActionSpot[], segment: TimelineSegment) {
  const tolerance = Number(process.env.AMERICAN_FOOTBALL_ACTION_SPOT_TOLERANCE_SECONDS || process.env.NFL_ACTION_SPOT_TOLERANCE_SECONDS || 3);
  return spots
    .filter((spot) => spot.position >= segment.start - tolerance && spot.position <= segment.end + tolerance)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

function applySegmentSpots(segment: TimelineSegment, result: AmericanFootballActionSpottingResult, spots: AmericanFootballActionSpot[]): TimelineSegment {
  const base = segment.domain;
  const trustedBase = isTrustedDomainSegment(base);
  const events = [
    ...spots.map((spot, index) => buildAmericanFootballActionEvent(segment, result, spot, index)),
    ...(trustedBase ? (base?.events ?? []) : [])
  ]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
  const captions = unique([...spots.map((spot) => captionForSpot(spot)), ...(trustedBase ? (base?.captions ?? []) : [])]);
  const labels = unique([
    "sports.american_football",
    "source.american_football_action_spotting",
    ...spots.flatMap((spot) => [`event.${normalizeEventType(spot.eventType || spot.label)}`, `american_football.${normalizeLabel(spot.label)}`]),
    ...(trustedBase ? (base?.labels ?? []) : [])
  ]);
  const searchText = [
    trustedBase ? base?.searchText : "",
    ...spots.map((spot) => `American football action: ${spot.label} at ${spot.position.toFixed(2)} seconds with confidence ${spot.confidence.toFixed(2)}.`)
  ]
    .filter(Boolean)
    .join(" ");
  const domain = {
    groups: unique(["sports.american_football", ...(trustedBase ? (base?.groups ?? []) : [])]),
    captions,
    labels,
    events,
    scope: trustedBase ? base?.scope : undefined,
    searchText,
    confidence: Math.max(...events.map((event) => event.confidence)),
    generatedBy: trustedBase ? `${base?.generatedBy}+american-football-action-spotting` : "american-football-action-spotting",
    trust: "detected" as const,
    vlm: trustedBase ? base?.vlm : undefined
  };
  return {
    ...segment,
    domain,
    tags: unique([...segment.tags, ...labels]).slice(0, 32),
    sources: unique([...segment.sources, "domain" as const])
  };
}

function buildAmericanFootballActionEvent(
  segment: TimelineSegment,
  result: AmericanFootballActionSpottingResult,
  spot: AmericanFootballActionSpot,
  index: number
): DomainEvent {
  const caption = captionForSpot(spot);
  const eventType = normalizeEventType(spot.eventType || spot.label);
  const playType = playTypeForEvent(eventType, spot.label);
  const quarterbackParticipant = quarterbackForSpot(spot);
  const tracking = trackingForSpot(segment, spot);
  const playMetadata = playMetadataForSpot(spot);
  const pressurePresent = eventType === "pressure" || eventType === "pocket_escape" || labelIncludes(spot.label, ["pressure", "pass rush", "blitz", "sack"]);
  return {
    id: `${segment.id}-domain-american-football-action-${index + 1}`,
    domain: "sports.american_football",
    ontologyVersion: "american-football-action-spotting-v1",
    caption,
    eventType,
    labels: unique([
      "sports.american_football",
      "source.american_football_action_spotting",
      `event.${eventType}`,
      playType !== "unknown" ? `play.${playType}` : "",
      `american_football.${normalizeLabel(spot.label)}`
    ]),
    confidence: clampConfidence(spot.confidence),
    trust: "detected",
    evidence: {
      asr: [],
      ocr: [],
      visual: [`American football action spot: ${spot.label} at ${spot.position.toFixed(2)} seconds.`],
      metadata: [
        result.provider,
        result.model,
        playMetadata?.gameId ? `gameId=${playMetadata.gameId}` : "",
        playMetadata?.playId ? `playId=${playMetadata.playId}` : "",
        playMetadata?.down !== null && playMetadata?.down !== undefined ? `down=${playMetadata.down}` : "",
        playMetadata?.distance !== null && playMetadata?.distance !== undefined ? `distance=${playMetadata.distance}` : "",
        playMetadata?.yardline ? `yardline=${playMetadata.yardline}` : "",
        ...spot.evidence
      ].filter(Boolean),
      heuristics: []
    },
    americanFootball: {
      phase: phaseForEvent(eventType, playType, spot.label),
      playType,
      playMetadata,
      quarterback: {
        present: Boolean(quarterbackParticipant) || quarterbackLikely(eventType, playType, spot.label),
        confidence: quarterbackParticipant ? clampConfidence(quarterbackParticipant.confidence) : quarterbackLikely(eventType, playType, spot.label) ? clampConfidence(spot.confidence) : 0,
        trackId: quarterbackParticipant?.trackId ?? null,
        trackingStatus: quarterbackParticipant?.trackId ? "detected" : tracking.trackIds.length > 0 ? "estimated" : "not_configured",
        identity: identityForParticipant(quarterbackParticipant)
      },
      pressure: {
        present: pressurePresent,
        confidence: pressurePresent ? clampConfidence(spot.confidence) : 0,
        source: "vision"
      },
      pocket: {
        status: pocketStatusForEvent(eventType, spot.label, pressurePresent),
        confidence: pocketStatusForEvent(eventType, spot.label, pressurePresent) === "unknown" ? 0 : clampConfidence(spot.confidence)
      },
      decision: {
        outcome: decisionForEvent(eventType, playType, spot.label),
        confidence: decisionForEvent(eventType, playType, spot.label) === "unknown" ? 0 : clampConfidence(spot.confidence)
      },
      participants: spot.participants,
      tracking,
      limitations: [
        "This event is imported from an American-football action spotting output.",
        "Player identity, down-distance, helmet assignment, contact, and MOT fields are only populated when the prediction JSON provides aligned evidence for them."
      ]
    }
  };
}

function captionForSpot(spot: AmericanFootballActionSpot) {
  return `${spot.label} action spotted at ${spot.position.toFixed(2)}s`;
}

function playMetadataForSpot(spot: AmericanFootballActionSpot): NonNullable<NonNullable<DomainEvent["americanFootball"]>["playMetadata"]> | undefined {
  if (!spot.playMetadata) return undefined;
  return {
    provider: spot.playMetadata.provider,
    gameId: spot.playMetadata.gameId,
    playId: spot.playMetadata.playId,
    season: spot.playMetadata.season,
    week: spot.playMetadata.week,
    possessionTeam: spot.playMetadata.possessionTeam,
    defensiveTeam: spot.playMetadata.defensiveTeam,
    down: spot.playMetadata.down,
    distance: spot.playMetadata.distance,
    yardline: spot.playMetadata.yardline,
    yardline100: spot.playMetadata.yardline100,
    quarter: spot.playMetadata.quarter,
    clock: spot.playMetadata.clock,
    description: spot.playMetadata.description,
    sourceText: spot.playMetadata.sourceText
  };
}

function quarterbackForSpot(spot: AmericanFootballActionSpot) {
  return spot.participants?.find((participant) => participant.role === "quarterback" || participant.role === "passer") ?? null;
}

function identityForParticipant(participant: ReturnType<typeof quarterbackForSpot>): PlayerIdentity | null {
  if (!participant?.name) return null;
  const source =
    participant.source === "nflverse" || participant.source === "helmet_assignment" || participant.source === "tracking"
      ? "knowledge"
      : participant.source === "asr" || participant.source === "ocr" || participant.source === "vlm"
        ? participant.source
        : "metadata";
  return {
    name: participant.name,
    confidence: clampConfidence(participant.confidence),
    source,
    evidence: [`American-football action spot participant source: ${participant.source}.`]
  };
}

function trackingForSpot(segment: TimelineSegment, spot: AmericanFootballActionSpot): NonNullable<NonNullable<DomainEvent["americanFootball"]>["tracking"]> {
  const visionTracking = segment.sceneData?.vision?.tracking;
  const trackIds = unique([
    ...(spot.tracking?.trackIds ?? []),
    ...(visionTracking?.playerTracks?.map((track) => track.id) ?? []),
    visionTracking?.nearestPlayerTrackId ?? "",
    visionTracking?.ballTrackId ?? ""
  ]);
  const frameIds = unique([
    ...(spot.tracking?.frameIds ?? []),
    visionTracking?.trackedFrameCount ? `trackedFrames:${visionTracking.trackedFrameCount}` : ""
  ]);
  const contactIds = unique(spot.tracking?.contactIds ?? []);
  return {
    schema: spot.tracking?.schema ?? (trackIds.length > 0 ? "mot" : "unavailable"),
    playId: spot.tracking?.playId ?? spot.playMetadata?.playId ?? null,
    frameIds,
    trackIds,
    contactIds,
    confidence: clampConfidence(spot.tracking?.confidence ?? visionTracking?.trackCoverage ?? (trackIds.length > 0 ? 0.45 : 0))
  };
}

function normalizeEventType(value: string) {
  const label = normalizeLabel(value);
  if (label.includes("scramble") || label.includes("qb_run") || label.includes("quarterback_run")) return "scramble";
  if (label.includes("throw_on_run") || label.includes("rolling") || label.includes("off_platform")) return "throw_on_run";
  if (label.includes("pocket_escape") || label.includes("escape_pocket") || label.includes("out_of_pocket")) return "pocket_escape";
  if (label.includes("pressure") || label.includes("pass_rush") || label.includes("blitz") || label.includes("sack")) return "pressure";
  if (label.includes("touchdown") || label === "td") return "touchdown";
  if (label.includes("pass") || label.includes("completion") || label.includes("interception")) return "pass";
  if (label.includes("rush") || label.includes("run") || label.includes("carry")) return "rush";
  if (label.includes("field_goal")) return "field_goal";
  if (label.includes("punt")) return "punt";
  if (label.includes("kickoff") || label.includes("kick_off")) return "kickoff";
  return label || "scene";
}

function normalizeLabel(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/->/g, "_to_")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function playTypeForEvent(eventType: string, label: string): NonNullable<DomainEvent["americanFootball"]>["playType"] {
  const normalized = normalizeLabel(label);
  if (eventType === "scramble") return "scramble";
  if (eventType === "pocket_escape") return "pocket_escape";
  if (eventType === "throw_on_run") return "throw_on_run";
  if (eventType === "pressure") return "pressure";
  if (eventType === "pass" || normalized.includes("pass") || normalized.includes("completion") || normalized.includes("interception")) return "pass";
  if (eventType === "rush" || normalized.includes("rush") || normalized.includes("run") || normalized.includes("carry")) return "rush";
  return "unknown";
}

function phaseForEvent(
  eventType: string,
  playType: NonNullable<DomainEvent["americanFootball"]>["playType"],
  label: string
): NonNullable<DomainEvent["americanFootball"]>["phase"] {
  const normalized = normalizeLabel(label);
  if (playType === "scramble" || eventType === "scramble") return "scramble";
  if (normalized.includes("play_action")) return "play_action";
  if (playType === "rush") return "designed_run";
  if (playType === "pass" || playType === "throw_on_run" || playType === "pocket_escape" || playType === "pressure") return "dropback";
  return "unknown";
}

function pocketStatusForEvent(eventType: string, label: string, pressurePresent: boolean): NonNullable<DomainEvent["americanFootball"]>["pocket"]["status"] {
  const normalized = normalizeLabel(label);
  if (eventType === "pocket_escape" || normalized.includes("out_of_pocket") || normalized.includes("escape")) return "escaped";
  if (pressurePresent || normalized.includes("collapsing_pocket")) return "collapsing";
  if (normalized.includes("clean_pocket")) return "intact";
  return "unknown";
}

function decisionForEvent(
  eventType: string,
  playType: NonNullable<DomainEvent["americanFootball"]>["playType"],
  label: string
): NonNullable<DomainEvent["americanFootball"]>["decision"]["outcome"] {
  const normalized = normalizeLabel(label);
  if (eventType === "scramble" || playType === "scramble" || playType === "rush") return "run";
  if (eventType === "throw_on_run" || playType === "pass" || normalized.includes("throw") || normalized.includes("completion")) return "throw";
  if (normalized.includes("sack_avoid") || normalized.includes("avoid_sack") || normalized.includes("escape_pressure")) return "sack_avoidance";
  return "unknown";
}

function quarterbackLikely(eventType: string, playType: NonNullable<DomainEvent["americanFootball"]>["playType"], label: string) {
  return playType === "pass" || playType === "scramble" || playType === "pocket_escape" || playType === "throw_on_run" || eventType === "pressure" || /quarterback|qb/i.test(label);
}

function labelIncludes(label: string, values: string[]) {
  const normalized = normalizeLabel(label);
  return values.some((value) => normalized.includes(normalizeLabel(value)));
}

function clampConfidence(value: number) {
  return Number(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)).toFixed(2));
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items.filter(Boolean)));
}
