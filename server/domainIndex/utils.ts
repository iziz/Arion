import type { DomainEvent } from "../../shared/types";
import type { OntologyRule } from "../domainCore/ontology";
import { isDetectedObjectStatus } from "../evidenceTrust";

export function bestRule(rules: OntologyRule[], normalized: string) {
  const matches = rules
    .map((rule) => ({ rule, matches: matchingTerms(normalized, rule.terms) }))
    .filter((item) => item.matches.length > 0)
    .sort((a, b) => b.matches.length - a.matches.length || b.rule.terms[0].length - a.rule.terms[0].length);
  return matches[0] ?? null;
}

export function matchingTerms(normalized: string, terms: string[]) {
  return unique(terms.filter((term) => normalized.includes(normalizeText(term))));
}

export function isObjectEvidenceReady(status?: "not_configured" | "estimated" | "detected" | "not_detected") {
  return isDetectedObjectStatus(status);
}

export function confidenceFromSignals(base: number, delta: number) {
  return Number(Math.max(0, Math.min(0.95, base + delta)).toFixed(2));
}

export function passTypeFromClassifier(label?: string): NonNullable<DomainEvent["football"]>["passType"] {
  if (label === "through_ball_receive") return "through_ball";
  if (label === "cross_receive") return "cross";
  if (label === "cutback_receive") return "cutback";
  return "unknown";
}

export function eventTypeFromClassifier(label: string | undefined, passType: NonNullable<DomainEvent["football"]>["passType"]) {
  if (label === "shot") return "shot";
  if (label === "carry" || label === "dribble" || label === "progressive_pass" || label === "save" || label === "pressure" || label === "scramble" || label === "pocket_escape" || label === "throw_on_run") return label;
  if (label?.endsWith("_receive") || passType !== "unknown") return "pass_receive";
  return "scene";
}

export function passTypeFromLabel(label: string): NonNullable<DomainEvent["football"]>["passType"] {
  if (label.endsWith("through_ball")) return "through_ball";
  if (label.endsWith("cross")) return "cross";
  if (label.endsWith("cutback")) return "cutback";
  if (label.endsWith("long_ball")) return "long_ball";
  if (label.endsWith("short_pass")) return "short_pass";
  return "unknown";
}

export function fieldZoneFromLabel(label: string): NonNullable<DomainEvent["football"]>["fieldZone"] {
  if (label.endsWith("final_third")) return "final_third";
  if (label.endsWith("penalty_area")) return "penalty_area";
  if (label.endsWith("middle_third")) return "middle_third";
  if (label.endsWith("defensive_third")) return "defensive_third";
  return "unknown";
}

export function eventTypeFromLabel(label: string) {
  if (label.endsWith("pass_receive")) return "pass_receive";
  if (label.endsWith("shot")) return "shot";
  if (label.endsWith("dribble")) return "dribble";
  if (label.endsWith("progressive_pass")) return "progressive_pass";
  if (label.endsWith("save")) return "save";
  if (label.endsWith("pressure")) return "pressure";
  if (label.endsWith("scramble")) return "scramble";
  if (label.endsWith("pocket_escape")) return "pocket_escape";
  if (label.endsWith("throw_on_run")) return "throw_on_run";
  return "scene";
}

export function readableLabel(value: string) {
  return value.replace(/^[^.]+\./, "").replace(/_/g, " ");
}

export function normalizeLabel(value: string) {
  return normalizeText(value).replace(/\s+/g, "_");
}

export function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function snippets(value: string) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const sentences = cleaned.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  return (sentences.length ? sentences : [cleaned]).slice(0, 3).map((item) => item.slice(0, 220));
}

export function extractLightKeywords(value: string) {
  return unique(
    value
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .map((term) => term.trim().replace(/^-+|-+$/g, ""))
      .filter((term) => term.length > 2)
  );
}

export function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}
