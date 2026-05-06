import { knowledgeTemplateDescriptors } from "../../../../../shared/knowledgeTemplates";

export const americanFootballKnowledgeTemplate = knowledgeTemplateDescriptors["sports.american_football"]!;

export function nflverseAlignmentTermsForTeam(team: string | null | undefined) {
  if (!team) return [];
  const normalized = normalizeKnowledgeTemplateTerm(team);
  const parts = normalized.split("_").filter(Boolean);
  const mascot = parts.at(-1) ?? "";
  return unique([normalized, mascot].filter((term) => term.length >= 3));
}

export function hasNflverseAlignmentContext(assetText: string, segmentText: string, teamTerms: Set<string>) {
  const assetContext = normalizeKnowledgeTemplateTerm(assetText);
  if (/\bnfl\b|super_bowl|pro_bowl|afc|nfc/.test(assetContext)) return true;
  const assetTerms = significantTemplateTerms(assetContext);
  if (assetTerms.some((term) => teamTerms.has(term))) return true;
  const segmentTerms = significantTemplateTerms(normalizeKnowledgeTemplateTerm(segmentText));
  return segmentTerms.filter((term) => teamTerms.has(term)).length >= 2;
}

export function significantTemplateTerms(text: string) {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "over", "under", "play", "football", "yard", "yards"]);
  return unique(text.split("_").map((term) => term.trim()).filter((term) => term.length > 3 && !stop.has(term))).slice(0, 80);
}

export function normalizeKnowledgeTemplateTerm(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items.filter(Boolean)));
}
