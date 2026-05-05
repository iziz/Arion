import type { AssetRecord, DomainEvent, TimelineSegment } from "../../shared/types";
import { ONTOLOGY_VERSION, americanFootballRules } from "../domainCore/ontology";
import { inferPlayerIdentity } from "./scopeInference";
import {
  bestRule,
  confidenceFromSignals,
  eventTypeFromClassifier,
  eventTypeFromLabel,
  isObjectEvidenceReady,
  matchingTerms,
  normalizeLabel,
  readableLabel,
  snippets,
  unique
} from "./utils";

export function buildAmericanFootballEvent(asset: AssetRecord, segment: TimelineSegment, normalized: string, domainMatches: string[]): DomainEvent {
  const eventRule = bestRule(americanFootballRules.eventTypes, normalized);
  const visual = segment.sceneData?.vision;
  const classifier = visual?.eventClassification;
  const eventType = eventRule ? eventTypeFromLabel(eventRule.rule.label) : eventTypeFromClassifier(classifier?.label, "unknown");
  const playType = americanFootballPlayType(eventType, normalized);
  const quarterbackIdentity = inferPlayerIdentity(asset, segment);
  const pressurePresent = eventType === "pressure" || matchingTerms(normalized, americanFootballRules.eventTypes[1].terms).length > 0 || Boolean(classifier?.features.pressureCue);
  const pocketStatus = inferPocketStatus(eventType, normalized, pressurePresent);
  const decisionOutcome = inferDecisionOutcome(eventType, normalized);
  const evidenceAsr = snippets(segment.sceneData?.text.speech || segment.transcript);
  const evidenceOcr = [
    ...(segment.sceneData?.text.subtitles ?? []),
    ...(segment.sceneData?.text.screenText ?? []),
    ...(segment.sceneData?.text.overlays ?? [])
  ].slice(0, 4);
  const evidenceVisual = [
    ...(segment.sceneData?.image.labels ?? asset.intelligence.visual.labels),
    visual && isObjectEvidenceReady(visual.objects.players.status) ? `players ${visual.objects.players.status} ${visual.objects.players.countEstimate}` : "",
    visual && isObjectEvidenceReady(visual.objects.ball.status) ? `ball ${visual.objects.ball.status} ${Math.round(visual.objects.ball.confidence * 100)}%` : "",
    visual?.tracking?.nearestPlayerTrackId ? `nearest player track ${visual.tracking.nearestPlayerTrackId}` : "",
    classifier && classifier.label !== "unknown" ? `event classifier ${classifier.label} ${Math.round(classifier.confidence * 100)}%` : ""
  ].filter(Boolean);
  const heuristics = [
    eventRule ? `Matched American football ontology: ${eventRule.matches.join(", ")}` : "",
    classifier && classifier.label !== "unknown" ? `Event classifier v1 selected ${classifier.label} with rules: ${classifier.rules.join("; ")}` : "",
    quarterbackIdentity ? `Quarterback identity v0 inferred ${quarterbackIdentity.name} from ${quarterbackIdentity.source}` : "",
    pressurePresent ? "Pressure cue inferred from text or clustered-player vision context." : "",
    "American football structure is text/vision heuristic until a sport-specific play detector is configured."
  ].filter(Boolean);
  const confidence = calculateAmericanFootballConfidence({
    eventRuleMatches: eventRule?.matches.length ?? 0,
    pressurePresent,
    playerIdentityPresent: Boolean(quarterbackIdentity),
    asrConfidence: asset.intelligence.asr.confidence,
    visualLabelCount: evidenceVisual.length,
    frameChangeScore: asset.intelligence.visual.motionScore,
    classifierConfidence: classifier?.confidence ?? 0
  });
  const labels = unique([
    "sports.american_football",
    eventType !== "scene" ? `event.${eventType}` : "",
    playType !== "unknown" ? `play.${playType}` : "",
    pressurePresent ? "pressure.present" : "",
    pocketStatus !== "unknown" ? `pocket.${pocketStatus}` : "",
    decisionOutcome !== "unknown" ? `decision.${decisionOutcome}` : "",
    quarterbackIdentity ? "role.quarterback" : "",
    quarterbackIdentity ? `player.${normalizeLabel(quarterbackIdentity.name)}` : "",
    classifier && classifier.label !== "unknown" ? `classifier.${classifier.label}` : ""
  ].filter(Boolean));

  return {
    id: `${segment.id}-domain-american-football-1`,
    domain: "sports.american_football",
    ontologyVersion: ONTOLOGY_VERSION,
    caption: buildAmericanFootballCaption(eventType, playType, pressurePresent, pocketStatus, decisionOutcome, confidence),
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
    americanFootball: {
      phase: americanFootballPhase(eventType, playType, normalized),
      playType,
      quarterback: {
        present: Boolean(quarterbackIdentity) || /quarterback|qb/.test(normalized),
        confidence: quarterbackIdentity ? confidenceFromSignals(confidence, 0.08) : /quarterback|qb/.test(normalized) ? 0.46 : 0,
        trackId: visual?.tracking?.nearestPlayerTrackId ?? null,
        trackingStatus: visual?.objects.players.status === "detected" ? "detected" : visual?.objects.players.status === "estimated" ? "estimated" : "not_configured",
        identity: quarterbackIdentity
      },
      pressure: {
        present: pressurePresent,
        confidence: pressurePresent ? confidenceFromSignals(confidence, classifier?.features.pressureCue ? 0.08 : -0.04) : 0,
        source: classifier?.features.pressureCue ? "vision" : pressurePresent ? "text" : "unknown"
      },
      pocket: {
        status: pocketStatus,
        confidence: pocketStatus === "unknown" ? 0 : confidenceFromSignals(confidence, pressurePresent ? 0.02 : -0.08)
      },
      decision: {
        outcome: decisionOutcome,
        confidence: decisionOutcome === "unknown" ? 0 : confidenceFromSignals(confidence, eventType === "scramble" || eventType === "throw_on_run" ? 0.06 : -0.05)
      },
      limitations: [
        "American football event structure uses text, OCR, and coarse vision cues.",
        "It does not yet include route concepts, pressure attribution, down-distance, or calibrated player tracking."
      ]
    }
  };
}

function calculateAmericanFootballConfidence(options: {
  eventRuleMatches: number;
  pressurePresent: boolean;
  playerIdentityPresent: boolean;
  asrConfidence: number;
  visualLabelCount: number;
  frameChangeScore: number;
  classifierConfidence: number;
}) {
  let confidence = 0.3;
  confidence += Math.min(0.28, options.eventRuleMatches * 0.14);
  confidence += options.pressurePresent ? 0.1 : 0;
  confidence += options.playerIdentityPresent ? 0.08 : 0;
  confidence += Math.min(0.12, Math.max(0, options.asrConfidence) * 0.12);
  confidence += Math.min(0.015, options.visualLabelCount * 0.003);
  confidence += Math.min(0.01, Math.max(0, options.frameChangeScore) * 0.01);
  confidence += Math.min(0.09, Math.max(0, options.classifierConfidence) * 0.12);
  return Number(Math.min(0.86, confidence).toFixed(2));
}

function buildAmericanFootballCaption(
  eventType: string,
  playType: NonNullable<DomainEvent["americanFootball"]>["playType"],
  pressurePresent: boolean,
  pocketStatus: NonNullable<DomainEvent["americanFootball"]>["pocket"]["status"],
  decisionOutcome: NonNullable<DomainEvent["americanFootball"]>["decision"]["outcome"],
  confidence: number
) {
  const parts = ["American football"];
  if (eventType !== "scene") parts.push(readableLabel(eventType));
  if (playType !== "unknown") parts.push(`play=${readableLabel(playType)}`);
  if (pressurePresent) parts.push("under pressure");
  if (pocketStatus !== "unknown") parts.push(`pocket ${readableLabel(pocketStatus)}`);
  if (decisionOutcome !== "unknown") parts.push(`decision ${readableLabel(decisionOutcome)}`);
  parts.push(`candidate (${Math.round(confidence * 100)}% confidence)`);
  return parts.join(" ");
}

function americanFootballPlayType(eventType: string, normalized: string): NonNullable<DomainEvent["americanFootball"]>["playType"] {
  if (eventType === "scramble" || /scramble|qb run|quarterback run/.test(normalized)) return "scramble";
  if (eventType === "pocket_escape" || /pocket escape|out of the pocket|breaks contain/.test(normalized)) return "pocket_escape";
  if (eventType === "throw_on_run" || /throw on the run|rolling right|rolling left|off platform/.test(normalized)) return "throw_on_run";
  if (eventType === "pressure" || /pressure|pass rush|blitz|collapsing pocket/.test(normalized)) return "pressure";
  if (/pass|throw/.test(normalized)) return "pass";
  if (/rush|run/.test(normalized)) return "rush";
  return "unknown";
}

function americanFootballPhase(
  eventType: string,
  playType: NonNullable<DomainEvent["americanFootball"]>["playType"],
  normalized: string
): NonNullable<DomainEvent["americanFootball"]>["phase"] {
  if (playType === "scramble" || eventType === "scramble") return "scramble";
  if (/play action|play-action/.test(normalized)) return "play_action";
  if (playType === "rush") return "designed_run";
  if (playType === "pass" || playType === "throw_on_run" || playType === "pocket_escape" || playType === "pressure") return "dropback";
  return "unknown";
}

function inferPocketStatus(eventType: string, normalized: string, pressurePresent: boolean): NonNullable<DomainEvent["americanFootball"]>["pocket"]["status"] {
  if (eventType === "pocket_escape" || /escapes? the pocket|out of the pocket|breaks contain/.test(normalized)) return "escaped";
  if (pressurePresent || /collapsing pocket|pocket collapses|pass rush|blitz/.test(normalized)) return "collapsing";
  if (/clean pocket|pocket holds|in the pocket/.test(normalized)) return "intact";
  return "unknown";
}

function inferDecisionOutcome(eventType: string, normalized: string): NonNullable<DomainEvent["americanFootball"]>["decision"]["outcome"] {
  if (eventType === "scramble" || /scramble|qb run|quarterback run|runs for/.test(normalized)) return "run";
  if (eventType === "throw_on_run" || /throws?|pass|completion|incomplete|touchdown/.test(normalized)) return "throw";
  if (/sack avoid|avoids? the sack|escapes? pressure/.test(normalized)) return "sack_avoidance";
  return "unknown";
}
