import type { AssetRecord, DomainEvent, TimelineSegment } from "../../shared/types";
import { ONTOLOGY_VERSION, footballRules } from "../domainCore/ontology";
import { inferPlayerIdentity } from "./scopeInference";
import {
  bestRule,
  confidenceFromSignals,
  eventTypeFromClassifier,
  eventTypeFromLabel,
  fieldZoneFromLabel,
  isObjectEvidenceReady,
  matchingTerms,
  normalizeLabel,
  passTypeFromClassifier,
  passTypeFromLabel,
  readableLabel,
  snippets,
  unique
} from "./utils";

export function buildFootballEvent(asset: AssetRecord, segment: TimelineSegment, normalized: string, domainMatches: string[]): DomainEvent {
  const passRule = bestRule(footballRules.passTypes, normalized);
  const eventRule = bestRule(footballRules.eventTypes, normalized);
  const explicitZoneRule = bestRule(footballRules.fieldZones, normalized);
  const visual = segment.sceneData?.vision;
  const classifier = visual?.eventClassification;
  let passType = passRule ? passTypeFromLabel(passRule.rule.label) : passTypeFromClassifier(classifier?.label);
  let eventType = eventRule ? eventTypeFromLabel(eventRule.rule.label) : eventTypeFromClassifier(classifier?.label, passType);
  if (classifier?.label === "shot") {
    eventType = "shot";
    passType = passType === "unknown" ? "unknown" : passType;
  }
  if (passType !== "unknown" && eventType === "shot") {
    eventType = "pass_receive";
  }
  const textFieldZone = inferFieldZone(normalized, explicitZoneRule?.rule.label, passType);
  const fieldZone = textFieldZone === "unknown" && visual?.fieldZone.zone ? visual.fieldZone.zone : textFieldZone;
  const phase = inferPhase(normalized);
  const receiverPresent = eventType === "pass_receive" || passType === "through_ball" || Boolean(classifier?.label.endsWith("_receive")) || Boolean(visual?.proximity?.ballNearPlayer);
  const passerPresent = passType !== "unknown";
  const ballState = eventRule?.rule.label.endsWith("shot") || classifier?.label === "shot" ? "shot" : passType !== "unknown" ? "pass_travel" : "unknown";
  const playerIdentity = inferPlayerIdentity(asset, segment);
  const evidenceAsr = snippets(segment.sceneData?.text.speech || segment.transcript);
  const evidenceOcr = [
    ...(segment.sceneData?.text.subtitles ?? []),
    ...(segment.sceneData?.text.screenText ?? []),
    ...(segment.sceneData?.text.overlays ?? [])
  ].slice(0, 4);
  const evidenceVisual = [
    ...(segment.sceneData?.image.labels ?? asset.intelligence.visual.labels),
    visual?.pitch.present ? `pitch estimated ${Math.round(visual.pitch.confidence * 100)}%` : "",
    visual && isObjectEvidenceReady(visual.objects.players.status) ? `players ${visual.objects.players.status} ${visual.objects.players.countEstimate}` : "",
    visual && isObjectEvidenceReady(visual.objects.ball.status) ? `ball ${visual.objects.ball.status} ${Math.round(visual.objects.ball.confidence * 100)}%` : "",
    visual && visual.fieldZone.zone !== "unknown" ? `visual zone ${visual.fieldZone.zone}` : "",
    visual?.fieldCalibration ? `field calibration ${visual.fieldCalibration.status} ${visual.fieldCalibration.method} zone=${visual.fieldCalibration.zone} ${Math.round(visual.fieldCalibration.zoneConfidence * 100)}%` : "",
    visual?.fieldCalibration && visual.fieldCalibration.attackingDirection !== "unknown"
      ? `attacking direction ${visual.fieldCalibration.attackingDirection} ${Math.round(visual.fieldCalibration.attackingDirectionConfidence * 100)}%`
      : "",
    visual?.tracking?.ballTrackId ? `ball track ${visual.tracking.ballTrackId}` : "",
    visual?.tracking?.nearestPlayerTrackId ? `nearest player track ${visual.tracking.nearestPlayerTrackId}` : "",
    classifier && classifier.label !== "unknown" ? `event classifier ${classifier.label} ${Math.round(classifier.confidence * 100)}%` : ""
  ].filter(Boolean);
  const heuristics = [
    passRule ? `Matched pass ontology: ${passRule.matches.join(", ")}` : "",
    eventRule ? `Matched event ontology: ${eventRule.matches.join(", ")}` : "",
    explicitZoneRule ? `Matched field zone ontology: ${explicitZoneRule.matches.join(", ")}` : "",
    classifier && classifier.label !== "unknown" ? `Event classifier v1 selected ${classifier.label} with rules: ${classifier.rules.join("; ")}` : "",
    playerIdentity ? `Player identity v0 inferred ${playerIdentity.name} from ${playerIdentity.source}` : "",
    !explicitZoneRule && textFieldZone !== "unknown" ? `Inferred field zone from attacking/pass context: ${fieldZone}` : "",
    textFieldZone === "unknown" && visual?.fieldZone.zone !== "unknown" ? `Estimated field zone from vision evidence: ${visual?.fieldZone.zone}` : "",
    visual?.fieldCalibration ? `Field calibration v1: ${visual.fieldCalibration.status}/${visual.fieldCalibration.method}, zone confidence ${Math.round(visual.fieldCalibration.zoneConfidence * 100)}%` : "",
    visual?.pitch.present ? `Vision evidence v0 estimated pitch presence: ${Math.round(visual.pitch.confidence * 100)}%` : "",
    visual?.eventCandidates[0]?.reason ?? "",
    visual?.tracking?.status === "tracked"
      ? `${visual.tracking.version ?? "tracking_v0"} linked ${visual.tracking.ballTrackId ?? "ball"} to ${visual.tracking.nearestPlayerTrackId ?? "no player"} with continuity ${visual.tracking.continuity}`
      : "",
    "Player, ball, and field geometry are estimated until detector/tracker stages are configured."
  ].filter(Boolean);
  const labels = unique([
    eventType !== "scene" ? `event.${eventType}` : "",
    passType !== "unknown" ? `pass.${passType}` : "",
    fieldZone !== "unknown" ? `zone.${fieldZone}` : "",
    receiverPresent ? "role.receiver" : "",
    playerIdentity ? `player.${normalizeLabel(playerIdentity.name)}` : "",
    classifier && classifier.label !== "unknown" ? `classifier.${classifier.label}` : "",
    ballState !== "unknown" ? `ball.${ballState}` : "",
    phase !== "unknown" ? `phase.${phase}` : ""
  ].filter(Boolean));
  const confidence = calculateFootballConfidence({
    passRuleMatches: passRule?.matches.length ?? 0,
    eventRuleMatches: eventRule?.matches.length ?? 0,
    fieldZone,
    explicitZone: Boolean(explicitZoneRule),
    receiverPresent,
    asrConfidence: asset.intelligence.asr.confidence,
    visualLabelCount: evidenceVisual.length,
    frameChangeScore: asset.intelligence.visual.motionScore,
    visionConfidence: visual ? Math.max(visual.pitch.confidence, visual.fieldZone.confidence, visual.objects.players.confidence, visual.objects.ball.confidence, visual.tracking?.continuity ?? 0, classifier?.confidence ?? 0) : 0
  });
  const caption = buildFootballCaption(eventType, passType, fieldZone, receiverPresent, confidence);

  return {
    id: `${segment.id}-domain-football-1`,
    domain: "sports.football",
    ontologyVersion: ONTOLOGY_VERSION,
    caption,
    eventType,
    labels,
    confidence,
    trust: "heuristic",
    evidence: {
      asr: evidenceAsr,
      ocr: evidenceOcr,
      visual: evidenceVisual.slice(0, 6),
      metadata: domainMatches.slice(0, 6),
      heuristics
    },
    football: {
      phase,
      fieldZone,
      passType,
      receivingPlayer: {
        present: receiverPresent,
        confidence: receiverPresent ? confidenceFromSignals(confidence, eventRule ? 0.15 : -0.1) : 0,
        trackId: visual?.tracking?.nearestPlayerTrackId ?? null,
        trackingStatus: receiverPresent && visual?.objects.players.status === "detected" ? "detected" : receiverPresent && visual?.objects.players.status === "estimated" ? "estimated" : "not_configured",
        identity: receiverPresent ? playerIdentity : null
      },
      passingPlayer: {
        present: passerPresent,
        confidence: passerPresent ? confidenceFromSignals(confidence, 0) : 0,
        trackId: visual?.tracking?.nearestPlayerTrackId ?? null,
        trackingStatus: passerPresent && visual?.objects.players.status === "detected" ? "detected" : passerPresent && visual?.objects.players.status === "estimated" ? "estimated" : "not_configured",
        identity: passerPresent && !receiverPresent ? playerIdentity : null
      },
      ball: {
        state: ballState,
        confidence: ballState !== "unknown" ? confidenceFromSignals(confidence, isObjectEvidenceReady(visual?.objects.ball.status) ? 0.04 : -0.08) : 0,
        trackingStatus: ballState !== "unknown" && visual?.tracking?.ballTrackId ? "detected" : ballState !== "unknown" && visual?.objects.ball.status === "detected" ? "detected" : ballState !== "unknown" && visual?.objects.ball.status === "estimated" ? "estimated" : "not_configured"
      },
      field: {
        calibrationStatus: visual?.fieldCalibration?.status ?? (visual?.fieldZone.method === "detector_x_position" ? "estimated" : visual?.fieldZone.method === "color_motion_heuristic" ? "estimated" : "not_configured"),
        attackingDirection: visual?.fieldCalibration?.attackingDirection ?? "unknown",
        zoneConfidence:
          fieldZone === "unknown"
            ? 0
            : confidenceFromSignals(
                confidence,
                explicitZoneRule ? 0.05 : typeof visual?.fieldCalibration?.zoneConfidence === "number" ? visual.fieldCalibration.zoneConfidence - 0.55 : visual?.fieldZone.confidence ? -0.02 : -0.18
              )
      },
      limitations: [
        "Vision evidence estimates pitch/player/ball cues from detector boxes and fallback heuristics.",
        visual?.tracking?.version === "tracking_v2"
          ? "Tracking v2 uses video-level tracker IDs but still lacks team assignment and jersey identity."
          : "Tracking v0 links boxes by nearest centers; it is not stable player identity re-id.",
        "Player identity v0 is text-derived from title/ASR/OCR/metadata, not visual face or jersey recognition.",
        visual?.fieldCalibration?.status === "calibrated"
          ? "Field zone is calibrated by homography."
          : "Field zone is estimated until a homography calibration stage is configured."
      ]
    }
  };
}

function inferFieldZone(normalized: string, explicitLabel: string | undefined, passType: NonNullable<DomainEvent["football"]>["passType"]) {
  if (explicitLabel) return fieldZoneFromLabel(explicitLabel);
  if (matchingTerms(normalized, footballRules.fieldZones[1].terms).length > 0) return "penalty_area";
  const attackingCues = ["goal", "keeper", "goalkeeper", "shot", "finish", "chance", "assist", "box", "tor", "abschluss", "찬스", "슈팅", "골"];
  if (passType === "through_ball" && matchingTerms(normalized, attackingCues).length > 0) return "final_third";
  if (passType === "through_ball") return "final_third";
  if (matchingTerms(normalized, footballRules.fieldZones[2].terms).length > 0) return "middle_third";
  if (matchingTerms(normalized, footballRules.fieldZones[3].terms).length > 0) return "defensive_third";
  return "unknown";
}

function inferPhase(normalized: string): NonNullable<DomainEvent["football"]>["phase"] {
  if (matchingTerms(normalized, footballRules.phase.setPiece).length > 0) return "set_piece";
  if (matchingTerms(normalized, footballRules.phase.attack).length > 0) return "attack";
  if (matchingTerms(normalized, ["transition", "turnover", "역습", "counter"]).length > 0) return "transition";
  return "unknown";
}

function calculateFootballConfidence(options: {
  passRuleMatches: number;
  eventRuleMatches: number;
  fieldZone: NonNullable<DomainEvent["football"]>["fieldZone"];
  explicitZone: boolean;
  receiverPresent: boolean;
  asrConfidence: number;
  visualLabelCount: number;
  frameChangeScore: number;
  visionConfidence: number;
}) {
  let confidence = 0.28;
  confidence += Math.min(0.24, options.passRuleMatches * 0.12);
  confidence += Math.min(0.16, options.eventRuleMatches * 0.08);
  confidence += options.fieldZone === "unknown" ? 0 : options.explicitZone ? 0.16 : 0.08;
  confidence += options.receiverPresent ? 0.08 : 0;
  confidence += Math.min(0.12, Math.max(0, options.asrConfidence) * 0.12);
  confidence += Math.min(0.015, options.visualLabelCount * 0.003);
  confidence += Math.min(0.01, Math.max(0, options.frameChangeScore) * 0.01);
  confidence += Math.min(0.08, Math.max(0, options.visionConfidence) * 0.1);
  return Number(Math.min(0.86, confidence).toFixed(2));
}

function buildFootballCaption(
  eventType: string,
  passType: NonNullable<DomainEvent["football"]>["passType"],
  fieldZone: NonNullable<DomainEvent["football"]>["fieldZone"],
  receiverPresent: boolean,
  confidence: number
) {
  const parts = ["Football"];
  if (eventType !== "scene") parts.push(readableLabel(eventType));
  if (passType !== "unknown") parts.push(`via ${readableLabel(passType)}`);
  if (fieldZone !== "unknown") parts.push(`in ${readableLabel(fieldZone)}`);
  if (receiverPresent) parts.push("with an inferred receiving player");
  parts.push(`candidate (${Math.round(confidence * 100)}% confidence)`);
  return parts.join(" ");
}
