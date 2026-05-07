import type { DomainQueryProfile } from "../domainCore/ontology";
import type { KnowledgeDomainGroup, TimelineSegment } from "../../shared/types";
import { americanFootballRules, footballRules } from "../domainCore/ontology";
import { isTrustedDomainSegment, trustedDomainEvents } from "../evidenceTrust";
import { eventTypeFromLabel, fieldZoneFromLabel, matchingTerms, normalizeText, passTypeFromLabel, readableLabel, unique } from "./utils";

export function expandDomainQuery(query: string): DomainQueryProfile {
  const normalized = normalizeText(query);
  const labels: string[] = [];
  const domains: KnowledgeDomainGroup[] = [];
  const fieldZones: DomainQueryProfile["football"]["fieldZones"] = [];
  const passTypes: DomainQueryProfile["football"]["passTypes"] = [];
  const eventTypes: string[] = [];
  const americanFootballEventTypes: string[] = [];

  if (matchingTerms(normalized, [...footballRules.domain.terms, "final third", "through ball", "스루패스"]).length > 0) {
    domains.push("sports.football");
    labels.push("sports.football");
  }
  if (matchingTerms(normalized, [...americanFootballRules.domain.terms, "under pressure", "pocket escape", "throw on the run"]).length > 0) {
    domains.push("sports.american_football");
    labels.push("sports.american_football");
  }

  for (const rule of footballRules.passTypes) {
    if (matchingTerms(normalized, [...rule.terms, ...rule.aliases]).length === 0) continue;
    labels.push(rule.label, ...rule.aliases);
    passTypes.push(passTypeFromLabel(rule.label));
  }
  for (const rule of footballRules.fieldZones) {
    if (matchingTerms(normalized, [...rule.terms, ...rule.aliases]).length === 0) continue;
    labels.push(rule.label, ...rule.aliases);
    fieldZones.push(fieldZoneFromLabel(rule.label));
  }
  for (const rule of footballRules.eventTypes) {
    if (matchingTerms(normalized, [...rule.terms, ...rule.aliases]).length === 0) continue;
    labels.push(rule.label, ...rule.aliases);
    eventTypes.push(eventTypeFromLabel(rule.label));
  }
  for (const rule of americanFootballRules.eventTypes) {
    if (matchingTerms(normalized, [...rule.terms, ...rule.aliases]).length === 0) continue;
    labels.push(rule.label, ...rule.aliases);
    americanFootballEventTypes.push(eventTypeFromLabel(rule.label));
  }

  const playerRequired = /선수|player/.test(normalized);
  const pressureRequired = matchingTerms(normalized, americanFootballRules.eventTypes[1].terms).length > 0;
  const quarterbackRequired = /quarterback|qb/.test(normalized);
  const expandedText = unique([
    query,
    ...labels,
    ...labels.map(readableLabel),
    passTypes.includes("through_ball") ? "through ball 스루패스 침투패스 ball in behind in die tiefe ueber die spitze" : "",
    fieldZones.includes("final_third") ? "final third attacking third 파이널 서드 공격 진영" : "",
    domains.includes("sports.football") ? "football soccer 축구" : "",
    domains.includes("sports.american_football") ? "american football nfl quarterback pocket scramble pressure pass rush" : ""
  ])
    .filter(Boolean)
    .join(" ");

  return {
    expandedText,
    domains: unique(domains),
    labels: unique(labels),
    football: {
      fieldZones: unique(fieldZones).filter((zone) => zone !== "unknown"),
      passTypes: unique(passTypes).filter((passType) => passType !== "unknown"),
      eventTypes: unique(eventTypes),
      receiverRequired: false,
      playerRequired
    },
    americanFootball: {
      eventTypes: unique(americanFootballEventTypes),
      pressureRequired,
      quarterbackRequired
    }
  };
}

export function domainSearchText(segment: TimelineSegment) {
  if (!segment.domain || !isTrustedDomainSegment(segment.domain)) return "";
  return [segment.domain.searchText, ...segment.domain.captions, ...segment.domain.labels].filter(Boolean).join(" ");
}

export function scoreDomainMatch(segment: TimelineSegment, profile: DomainQueryProfile) {
  if (!segment.domain || !isTrustedDomainSegment(segment.domain) || profile.labels.length === 0) return 0;
  let score = 0;
  const labels = new Set(segment.domain.labels);
  for (const domain of profile.domains) {
    if (segment.domain.groups.includes(domain) || labels.has(domain)) score += 1.25;
  }
  for (const label of profile.labels) {
    if (labels.has(label)) score += 1;
  }
  for (const event of trustedDomainEvents(segment)) {
    if ([...profile.football.eventTypes, ...profile.americanFootball.eventTypes].includes(event.eventType)) score += 1.4;
    const football = event.football;
    if (football) {
      if (profile.football.passTypes.includes(football.passType)) score += 1.6;
      if (profile.football.fieldZones.includes(football.fieldZone)) score += 1.2;
      if (profile.football.fieldZones.includes("final_third") && football.fieldZone === "penalty_area") score += 0.8;
    }
    const americanFootball = event.americanFootball;
    if (americanFootball) {
      if (profile.americanFootball.pressureRequired && americanFootball.pressure.present) score += 1.3;
      if (profile.americanFootball.quarterbackRequired && americanFootball.quarterback.present) score += 1.1;
      if (americanFootball.playType !== "unknown" && profile.americanFootball.eventTypes.includes(americanFootball.playType)) score += 1;
    }
    score += Math.min(1.2, event.confidence);
  }
  return Number(score.toFixed(3));
}
