import type { AssetRecord, IndexRecord, TimelineSegment } from "../../shared/types";
import { americanFootballRules, footballRules } from "../domainCore/ontology";
import { isTrustedDomainSegment } from "../evidenceTrust";
import { buildAmericanFootballEvent } from "./americanFootballEventBuilder";
import { buildFootballEvent } from "./footballEventBuilder";
import { collectSegmentText, stageLabelsForIndex } from "./segmentText";
import { inferFootballScope, scopeLabels } from "./scopeInference";
import { extractLightKeywords, matchingTerms, normalizeText, readableLabel, unique } from "./utils";

export function buildDomainSegmentIndex(asset: AssetRecord, index: IndexRecord, segment: TimelineSegment): TimelineSegment["domain"] | undefined {
  if (!isSportsDomainIndexingEnabled(index)) return undefined;
  const text = collectSegmentText(asset, index, segment);
  const normalized = normalizeText(text);
  const americanDomainMatches = matchingTerms(normalized, americanFootballRules.domain.terms);
  const americanEventMatches = americanFootballRules.eventTypes.flatMap((rule) => matchingTerms(normalized, rule.terms));
  const americanFootballCueCount = americanDomainMatches.length + americanEventMatches.length;
  const hasSpecificAmericanFootballCue = americanEventMatches.length > 0 || americanDomainMatches.some((term) => !["football"].includes(term));
  const isAmericanFootball =
    index.domainIndexing?.groups.includes("sports.american_football") && (americanFootballCueCount >= 2 || hasSpecificAmericanFootballCue);
  if (isAmericanFootball) return buildAmericanFootballDomainSegment(asset, index, segment, normalized, americanDomainMatches);

  const domainMatches = matchingTerms(normalized, footballRules.domain.terms);
  const passMatches = footballRules.passTypes.flatMap((rule) => matchingTerms(normalized, rule.terms));
  const eventMatches = footballRules.eventTypes.flatMap((rule) => matchingTerms(normalized, rule.terms));
  const footballCueCount = domainMatches.length + passMatches.length + eventMatches.length;
  const hasSpecificFootballCue = passMatches.some((term) => term !== "ball" && term !== "pass") || domainMatches.some((term) => term !== "shot" && term !== "pass");
  const isFootball = index.domainIndexing?.groups.includes("sports.football") && (footballCueCount >= 2 || hasSpecificFootballCue);
  if (!isFootball) return undefined;

  const event = buildFootballEvent(asset, segment, normalized, domainMatches);
  const scope = inferFootballScope(asset, segment);
  const stageLabels = stageLabelsForIndex(index);
  const labels = unique([footballRules.domain.label, ...event.labels, ...scopeLabels(scope), ...stageLabels]);
  const captions = [event.caption];
  const searchText = [
    "Domain: sports football soccer 축구.",
    scope.competition ? `Competition: ${scope.competition.value}.` : "",
    scope.season ? `Season: ${scope.season.value}.` : "",
    scope.teams.length > 0 ? `Teams: ${scope.teams.map((item) => item.value).join(", ")}.` : "",
    scope.players.length > 0 ? `Players: ${scope.players.map((item) => item.value).join(", ")}.` : "",
    `Caption: ${event.caption}`,
    `Labels: ${labels.join(" ")}`,
    event.football
      ? [
          `Event: ${readableLabel(event.eventType)}.`,
          `Pass type: ${readableLabel(event.football.passType)}.`,
          `Field zone: ${readableLabel(event.football.fieldZone)}.`,
          event.football.receivingPlayer.present ? "Receiver: receiving player receiver present 받는 선수." : "Receiver: unknown.",
          event.football.receivingPlayer.identity ? `Receiver identity: ${event.football.receivingPlayer.identity.name}.` : "",
          event.football.passingPlayer.identity ? `Passing player identity: ${event.football.passingPlayer.identity.name}.` : "",
          event.football.ball.state !== "unknown" ? `Ball state: ${readableLabel(event.football.ball.state)}.` : ""
        ].join(" ")
      : ""
  ]
    .filter(Boolean)
    .join(" ");

  return {
    groups: ["sports.football"],
    captions,
    labels,
    events: [event],
    scope,
    searchText,
    confidence: event.confidence,
    generatedBy: "domain-ontology-heuristic-v1",
    trust: "heuristic"
  };
}

export function isSportsDomainIndexingEnabled(index: IndexRecord) {
  return Boolean(index.domainIndexing?.enabled && index.domainIndexing.groups.length > 0);
}

export function enrichTimelineWithDomain(asset: AssetRecord, index: IndexRecord): TimelineSegment[] {
  return asset.timeline.map((segment) => withDomainSegment(asset, index, segment));
}

export function withDomainSegment(asset: AssetRecord, index: IndexRecord, segment: TimelineSegment): TimelineSegment {
  const domain = segment.domain ?? buildDomainSegmentIndex(asset, index, segment);
  if (!domain) return segment;
  const domainTagText = domain.labels.flatMap((label) => [label, readableLabel(label)]).join(" ");
  return {
    ...segment,
    domain,
    tags: unique([...segment.tags, ...domain.labels, ...extractLightKeywords(domainTagText)]).slice(0, 32),
    sources: unique([...segment.sources, ...(isTrustedDomainSegment(domain) ? (["domain"] as const) : [])])
  };
}

function buildAmericanFootballDomainSegment(
  asset: AssetRecord,
  index: IndexRecord,
  segment: TimelineSegment,
  normalized: string,
  domainMatches: string[]
): TimelineSegment["domain"] {
  const event = buildAmericanFootballEvent(asset, segment, normalized, domainMatches);
  const scope = inferFootballScope(asset, segment);
  const stageLabels = stageLabelsForIndex(index);
  const labels = unique([americanFootballRules.domain.label, ...event.labels, ...scopeLabels(scope), ...stageLabels]);
  const captions = [event.caption];
  const searchText = [
    "Domain: sports american football NFL quarterback.",
    scope.competition ? `Competition: ${scope.competition.value}.` : "",
    scope.season ? `Season: ${scope.season.value}.` : "",
    scope.teams.length > 0 ? `Teams: ${scope.teams.map((item) => item.value).join(", ")}.` : "",
    scope.players.length > 0 ? `Players: ${scope.players.map((item) => item.value).join(", ")}.` : "",
    `Caption: ${event.caption}`,
    `Labels: ${labels.join(" ")}`,
    event.americanFootball
      ? [
          `Event: ${readableLabel(event.eventType)}.`,
          `Play type: ${readableLabel(event.americanFootball.playType)}.`,
          event.americanFootball.quarterback.present ? "Quarterback: present." : "Quarterback: unknown.",
          event.americanFootball.quarterback.identity ? `Quarterback identity: ${event.americanFootball.quarterback.identity.name}.` : "",
          event.americanFootball.pressure.present ? "Pressure: present." : "Pressure: unknown.",
          `Pocket: ${readableLabel(event.americanFootball.pocket.status)}.`,
          `Decision: ${readableLabel(event.americanFootball.decision.outcome)}.`
        ].join(" ")
      : ""
  ]
    .filter(Boolean)
    .join(" ");

  return {
    groups: ["sports.american_football"],
    captions,
    labels,
    events: [event],
    scope,
    searchText,
    confidence: event.confidence,
    generatedBy: "domain-ontology-heuristic-v1",
    trust: "heuristic"
  };
}
