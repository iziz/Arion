import type { AssetRecord, TimelineSegment, VisionEvidence } from "../../../shared/types";
import { domainSearchText } from "../../domainIndex";
import { isDetectedObjectStatus, isTrustedDomainSegment, isTrustedVisionEvidence, isTrustedVisionFieldZone } from "../../evidenceTrust";
import { normalizeSearchValue } from "../textUtils";

export function buildVisionEvidence(asset: AssetRecord, start: number, end: number): VisionEvidence {
  const visual = asset.intelligence.visual;
  if (visual.available === false || visual.labels.includes("metadata-derived") || visual.labels.includes("visual-fallback")) {
    return unavailableVisionEvidence(start, end, visual.error ?? null);
  }
  const labels = visual.labels;
  const { red, green, blue } = hexToRgb(visual.dominantColor);
  const greenDominance = green + red + blue > 0 ? Number((green / Math.max(1, red + green + blue)).toFixed(3)) : 0;
  const pitchPresent = labels.includes("green-dominant") || greenDominance >= 0.36;
  const motion = asset.intelligence.visual.motionScore;
  const confidenceBase = Math.min(0.82, 0.28 + (pitchPresent ? 0.24 : 0) + Math.min(0.22, motion * 0.8));
  const frameAt = Number(((start + end) / 2).toFixed(2));
  const playersLikely = pitchPresent && (labels.includes("active-motion") || labels.includes("stable-shot"));
  const ballLikely = pitchPresent && motion >= 0.08;
  const zone = estimateVisualFieldZone(asset, pitchPresent, motion);
  const zoneConfidence = zone === "unknown" ? 0 : Number(Math.min(0.54, confidenceBase - 0.05).toFixed(2));
  const candidates: VisionEvidence["eventCandidates"] = [];
  if (pitchPresent && motion >= 0.1) {
    candidates.push({
      type: "pass_receive",
      confidence: Number(Math.min(0.62, confidenceBase + 0.08).toFixed(2)),
      reason: "Green pitch and motion cues suggest an in-play football action candidate."
    });
  }
  if (pitchPresent && hasShotCue(asset)) {
    candidates.push({
      type: "shot",
      confidence: Number(Math.min(0.6, confidenceBase + 0.04).toFixed(2)),
      reason: "Pitch cue appears with shot/goal language in nearby ASR/OCR context."
    });
  }

  return {
    generatedBy: "vision-evidence-v0-color-motion",
    trust: "heuristic",
    frameAt,
    pitch: {
      present: pitchPresent,
      greenDominance,
      confidence: Number((pitchPresent ? confidenceBase : Math.max(0.08, greenDominance)).toFixed(2))
    },
    objects: {
      players: {
        countEstimate: playersLikely ? Math.max(2, Math.round(6 + motion * 10)) : 0,
        confidence: playersLikely ? Number(Math.min(0.58, confidenceBase).toFixed(2)) : 0,
        status: playersLikely ? "estimated" : "not_detected"
      },
      ball: {
        present: ballLikely,
        confidence: ballLikely ? Number(Math.min(0.42, 0.18 + motion * 0.9).toFixed(2)) : 0,
        status: ballLikely ? "estimated" : "not_detected"
      }
    },
    fieldZone: {
      zone,
      confidence: zoneConfidence,
      method: zone === "unknown" ? "none" : "color_motion_heuristic"
    },
    fieldCalibration: {
      status: zone === "unknown" ? "not_configured" : "estimated",
      method: zone === "unknown" ? "none" : "text_context",
      zone,
      zoneConfidence,
      attackingDirection: "unknown",
      attackingDirectionConfidence: 0,
      evidence: zone === "unknown" ? ["No pitch-zone cue was available."] : ["Zone estimated from text, color, and motion context."],
      limitations: [
        "No pitch homography is configured.",
        "Zone is not derived from calibrated field coordinates."
      ]
    },
    eventCandidates: candidates,
    limitations: [
      "Vision evidence v0 uses color and motion heuristics, not object bounding boxes.",
      "Player identity, ball trajectory, and calibrated pitch coordinates require detector/tracker stages."
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
  const vision = segment.sceneData?.vision;
  const visionText = vision && isTrustedVisionEvidence(vision)
    ? [
        vision.pitch.present ? "football pitch field" : "",
        isObjectEvidenceReady(vision.objects.players.status) ? `players ${vision.objects.players.status}` : "",
        isObjectEvidenceReady(vision.objects.ball.status) ? `ball ${vision.objects.ball.status}` : "",
        isTrustedVisionFieldZone(vision) ? vision.fieldZone.zone : "",
        vision.tracking?.ballTrackId ? `ball track ${vision.tracking.ballTrackId}` : "",
        vision.tracking?.nearestPlayerTrackId ? `nearest player ${vision.tracking.nearestPlayerTrackId}` : "",
        vision.eventClassification && vision.eventClassification.label !== "unknown" ? `event classifier ${vision.eventClassification.label}` : ""
      ]
      .filter(Boolean)
      .join(" ")
    : "";
  if (!text) return [segment.transcript, domainText, visionText].filter(Boolean).join(" ");
  return [text.speech, ...text.subtitles, ...text.screenText, ...text.overlays, domainText, visionText].filter(Boolean).join(" ");
}

function estimateVisualFieldZone(asset: AssetRecord, pitchPresent: boolean, motion: number): VisionEvidence["fieldZone"]["zone"] {
  if (!pitchPresent) return "unknown";
  const text = normalizeSearchValue(
    [
      asset.title,
      asset.description,
      asset.intelligence.asr.transcript,
      asset.intelligence.ocr.tokens.join(" ")
    ].join(" ")
  );
  if (/(penalty|box|박스|페널티|goal|keeper|골|슈팅|shot|finish)/i.test(text)) return "penalty_area";
  if (/(through ball|스루|침투|attack|attacking|chance|찬스)/i.test(text)) return "final_third";
  if (motion >= 0.14) return "middle_third";
  return "unknown";
}

function hasShotCue(asset: AssetRecord) {
  return /(shot|shoot|finish|goal|슈팅|슛|골|마무리)/i.test(
    [asset.title, asset.description, asset.intelligence.asr.transcript, asset.intelligence.ocr.tokens.join(" ")].join(" ")
  );
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
