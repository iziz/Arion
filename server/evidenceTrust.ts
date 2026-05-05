import type { DomainEvent, EvidenceTrustTier, TimelineSegment, VisionEvidence } from "../shared/types";

const trustedSearchTiers = new Set<EvidenceTrustTier>(["observed", "detected", "aligned"]);

export function isTrustedEvidenceTier(tier: EvidenceTrustTier | null | undefined) {
  return Boolean(tier && trustedSearchTiers.has(tier));
}

export function inferVisionTrust(vision: VisionEvidence | null | undefined): EvidenceTrustTier {
  if (!vision) return "unavailable";
  if (vision.trust) return vision.trust;
  if (vision.generatedBy === "vision-evidence-unavailable") return "unavailable";
  if (vision.tracking?.status === "tracked" || vision.objects.players.status === "detected" || vision.objects.ball.status === "detected") {
    return "detected";
  }
  if (vision.generatedBy.includes("color-motion") || vision.generatedBy.includes("coarse-profile") || vision.fieldZone.method === "color_motion_heuristic") return "heuristic";
  return "inferred";
}

export function isTrustedVisionEvidence(vision: VisionEvidence | null | undefined) {
  return isTrustedEvidenceTier(inferVisionTrust(vision));
}

export function isTrustedVisionFieldZone(vision: VisionEvidence | null | undefined) {
  return Boolean(
    vision &&
      isTrustedVisionEvidence(vision) &&
      vision.fieldZone.zone !== "unknown" &&
      vision.fieldZone.method !== "color_motion_heuristic" &&
      vision.fieldZone.method !== "text_context"
  );
}

export function isDetectedObjectStatus(status?: "not_configured" | "estimated" | "detected" | "not_detected") {
  return status === "detected";
}

export function inferDomainEventTrust(event: DomainEvent | null | undefined): EvidenceTrustTier {
  if (!event) return "unavailable";
  if (event.trust) return event.trust;
  if (event.id.includes("-domain-vlm-") || event.evidence.visual.some((item) => item.startsWith("VLM caption:"))) return "detected";
  if (event.evidence.heuristics.some((item) => /heuristic|ontology|estimated|v0/i.test(item))) return "heuristic";
  return "inferred";
}

export function isTrustedDomainEvent(event: DomainEvent | null | undefined) {
  return isTrustedEvidenceTier(inferDomainEventTrust(event));
}

export function trustedDomainEvents(segment: TimelineSegment) {
  return (segment.domain?.events ?? []).filter(isTrustedDomainEvent);
}

export function inferDomainSegmentTrust(domain: TimelineSegment["domain"] | null | undefined): EvidenceTrustTier {
  if (!domain) return "unavailable";
  if (domain.trust) return domain.trust;
  if (domain.vlm?.status === "refined") return "detected";
  if (domain.generatedBy.includes("domain-ontology-heuristic")) return "heuristic";
  if (domain.events.some(isTrustedDomainEvent)) return "detected";
  return "inferred";
}

export function isTrustedDomainSegment(domain: TimelineSegment["domain"] | null | undefined) {
  return isTrustedEvidenceTier(inferDomainSegmentTrust(domain));
}
