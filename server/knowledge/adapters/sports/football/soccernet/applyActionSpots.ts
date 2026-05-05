import type { DomainEvent, TimelineSegment } from "../../../../../../shared/types";
import { isTrustedDomainSegment } from "../../../../../evidenceTrust";
import type { SoccerNetActionSpot, SoccerNetActionSpottingResult } from "./types";

export function applySoccerNetActionSpots(timeline: TimelineSegment[], result: SoccerNetActionSpottingResult): TimelineSegment[] {
  if (!result.available || result.spots.length === 0) return timeline;
  return timeline.map((segment) => {
    const spots = spotsForSegment(result.spots, segment);
    if (spots.length === 0) return segment;
    return applySegmentSpots(segment, result, spots);
  });
}

function spotsForSegment(spots: SoccerNetActionSpot[], segment: TimelineSegment) {
  const tolerance = Number(process.env.SOCCERNET_ACTION_SPOT_TOLERANCE_SECONDS || 3);
  return spots
    .filter((spot) => spot.position >= segment.start - tolerance && spot.position <= segment.end + tolerance)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

function applySegmentSpots(segment: TimelineSegment, result: SoccerNetActionSpottingResult, spots: SoccerNetActionSpot[]): TimelineSegment {
  const base = segment.domain;
  const trustedBase = isTrustedDomainSegment(base);
  const events = [
    ...spots.map((spot, index) => buildSoccerNetEvent(segment, result, spot, index)),
    ...(trustedBase ? (base?.events ?? []) : [])
  ]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
  const captions = unique([...spots.map((spot) => captionForSpot(spot)), ...(trustedBase ? (base?.captions ?? []) : [])]);
  const labels = unique([
    "sports.football",
    "source.soccernet",
    ...spots.flatMap((spot) => [`event.${spot.eventType}`, `soccernet.${normalizeLabel(spot.label)}`]),
    ...(trustedBase ? (base?.labels ?? []) : [])
  ]);
  const searchText = [
    trustedBase ? base?.searchText : "",
    ...spots.map((spot) => `SoccerNet action: ${spot.label} at ${spot.position.toFixed(2)} seconds with confidence ${spot.confidence.toFixed(2)}.`)
  ]
    .filter(Boolean)
    .join(" ");
  const domain = {
    groups: unique(["sports.football", ...(trustedBase ? (base?.groups ?? []) : [])]),
    captions,
    labels,
    events,
    scope: trustedBase ? base?.scope : undefined,
    searchText,
    confidence: Math.max(...events.map((event) => event.confidence)),
    generatedBy: trustedBase ? `${base?.generatedBy}+soccernet-action-spotting` : "soccernet-action-spotting",
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

function buildSoccerNetEvent(segment: TimelineSegment, result: SoccerNetActionSpottingResult, spot: SoccerNetActionSpot, index: number): DomainEvent {
  const caption = captionForSpot(spot);
  const eventType = normalizeEventType(spot.eventType || spot.label);
  return {
    id: `${segment.id}-domain-soccernet-${index + 1}`,
    domain: "sports.football",
    ontologyVersion: "soccernet-action-spotting-v1",
    caption,
    eventType,
    labels: unique(["sports.football", "source.soccernet", `event.${eventType}`, `soccernet.${normalizeLabel(spot.label)}`]),
    confidence: clampConfidence(spot.confidence),
    trust: "detected",
    evidence: {
      asr: [],
      ocr: [],
      visual: [`SoccerNet action spot: ${spot.label} at ${spot.position.toFixed(2)} seconds.`],
      metadata: [result.provider, result.model, ...spot.evidence],
      heuristics: []
    },
    football: {
      phase: phaseForEvent(eventType),
      fieldZone: "unknown",
      passType: "unknown",
      receivingPlayer: {
        present: false,
        confidence: 0,
        trackId: null,
        trackingStatus: "not_configured"
      },
      passingPlayer: {
        present: false,
        confidence: 0,
        trackId: null,
        trackingStatus: "not_configured"
      },
      ball: {
        state: ballStateForEvent(eventType),
        confidence: eventType === "shot" || eventType === "goal" ? clampConfidence(spot.confidence) : 0,
        trackingStatus: "not_configured"
      },
      field: {
        calibrationStatus: "not_configured",
        attackingDirection: "unknown",
        zoneConfidence: 0
      },
      limitations: [
        "This event is imported from a SoccerNet action spotting output.",
        "It provides timestamp-level action evidence, not player identity, ball trajectory, or pitch calibration."
      ]
    }
  };
}

function captionForSpot(spot: SoccerNetActionSpot) {
  return `${spot.label} action spotted at ${spot.position.toFixed(2)}s`;
}

function normalizeEventType(value: string) {
  const label = normalizeLabel(value);
  if (label.includes("shot")) return "shot";
  if (label.includes("goal")) return "goal";
  if (label.includes("corner")) return "corner";
  if (label.includes("free_kick")) return "free_kick";
  if (label.includes("kick_off")) return "kickoff";
  if (label.includes("throw_in")) return "throw_in";
  if (label.includes("yellow") || label.includes("red_card")) return "card";
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

function phaseForEvent(eventType: string): NonNullable<DomainEvent["football"]>["phase"] {
  if (["corner", "free_kick", "kickoff", "throw_in", "penalty"].includes(eventType)) return "set_piece";
  if (["shot", "goal"].includes(eventType)) return "attack";
  return "unknown";
}

function ballStateForEvent(eventType: string): NonNullable<DomainEvent["football"]>["ball"]["state"] {
  if (eventType === "shot" || eventType === "goal") return "shot";
  return "unknown";
}

function clampConfidence(value: number) {
  return Number(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)).toFixed(2));
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items.filter(Boolean)));
}
