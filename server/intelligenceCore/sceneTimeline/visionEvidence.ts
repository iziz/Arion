import type { AssetRecord, TimelineSegment, VisionEvidence } from "../../../shared/types";
import { domainSearchText } from "../../domainIndex";
import { isDetectedObjectStatus, isTrustedDomainSegment } from "../../evidenceTrust";
import { videoVlmSearchText } from "../../videoVlmText";

export function buildVisionEvidence(asset: AssetRecord, start: number, end: number): VisionEvidence {
  const visual = asset.intelligence.visual;
  if (visual.available === false || visual.labels.includes("metadata-derived") || visual.labels.includes("visual-fallback")) {
    return unavailableVisionEvidence(start, end, visual.error ?? null);
  }
  const labels = visual.labels;
  const { red, green, blue } = hexToRgb(visual.dominantColor);
  const greenDominance = green + red + blue > 0 ? Number((green / Math.max(1, red + green + blue)).toFixed(3)) : 0;
  const pitchPresent = labels.includes("green-dominant") || greenDominance >= 0.36;
  const frameChange = asset.intelligence.visual.motionScore;
  const confidenceBase = Math.min(0.48, 0.12 + (pitchPresent ? 0.18 : 0) + Math.min(0.08, frameChange * 0.25));
  const frameAt = Number(((start + end) / 2).toFixed(2));

  return {
    generatedBy: "vision-evidence-v0-coarse-profile",
    trust: "heuristic",
    frameAt,
    pitch: {
      present: pitchPresent,
      greenDominance,
      confidence: Number((pitchPresent ? confidenceBase : Math.max(0.08, greenDominance)).toFixed(2))
    },
    objects: {
      players: {
        countEstimate: 0,
        confidence: 0,
        status: "not_configured"
      },
      ball: {
        present: false,
        confidence: 0,
        status: "not_configured"
      }
    },
    fieldZone: {
      zone: "unknown",
      confidence: 0,
      method: "none"
    },
    fieldCalibration: {
      status: "not_configured",
      method: "none",
      zone: "unknown",
      zoneConfidence: 0,
      attackingDirection: "unknown",
      attackingDirectionConfidence: 0,
      evidence: ["Coarse visual profile is not calibrated field evidence."],
      limitations: [
        "No detector, tracker, or pitch homography is configured for this evidence.",
        "Zone is not inferred from color-only visual profile data."
      ]
    },
    eventCandidates: [],
    limitations: [
      "Coarse visual profile uses color and frame-change heuristics, not object bounding boxes.",
      "Player, ball, event, and calibrated field evidence require detector, tracker, VLM, or homography stages."
    ]
  };
}

function unavailableVisionEvidence(start: number, end: number, error: string | null): VisionEvidence {
    return {
      generatedBy: "vision-evidence-unavailable",
      trust: "unavailable",
      frameAt: Number(((start + end) / 2).toFixed(2)),
    pitch: {
      present: false,
      greenDominance: 0,
      confidence: 0
    },
    objects: {
      players: {
        countEstimate: 0,
        confidence: 0,
        status: "not_configured"
      },
      ball: {
        present: false,
        confidence: 0,
        status: "not_configured"
      }
    },
    fieldZone: {
      zone: "unknown",
      confidence: 0,
      method: "none"
    },
    fieldCalibration: {
      status: "not_configured",
      method: "none",
      zone: "unknown",
      zoneConfidence: 0,
      attackingDirection: "unknown",
      attackingDirectionConfidence: 0,
      evidence: ["Visual sampling was unavailable."],
      limitations: [error ? `Visual sampler error: ${error}` : "No sampled visual frames are available."]
    },
    eventCandidates: [],
    limitations: [error ? `Visual sampler error: ${error}` : "No sampled visual frames are available."]
  };
}

export function isObjectEvidenceReady(status?: "not_configured" | "estimated" | "detected" | "not_detected") {
  return isDetectedObjectStatus(status);
}

export function segmentSearchText(segment: TimelineSegment) {
  const text = segment.sceneData?.text;
  const domainText = isTrustedDomainSegment(segment.domain) ? domainSearchText(segment) : "";
  const vlmText = videoVlmSearchText(segment);
  if (!text) return [segment.transcript, domainText, vlmText].filter(Boolean).join(" ");
  return [text.speech, ...text.subtitles, ...text.screenText, ...text.overlays, domainText, vlmText].filter(Boolean).join(" ");
}

function hexToRgb(value: string) {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return { red: 0, green: 0, blue: 0 };
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16)
  };
}
