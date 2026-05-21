import type { DomainQueryPlan, RetrievalEvidenceConstraint } from "../shared/types";
import { extractKeywords, normalizeSearchValue, unique } from "./intelligenceCore/textUtils";

export type ResolvedQueryRetrievalPlan = {
  textQuery: string;
  visualQuery: string;
  evidenceTerms: string[];
  requiredEvidence: RetrievalEvidenceConstraint[];
};

export function resolveQueryRetrievalPlan(queryPlan: DomainQueryPlan | null | undefined, fallbackQuery: string): ResolvedQueryRetrievalPlan {
  const textQuery = cleanText(queryPlan?.retrieval?.textQuery) || cleanText(queryPlan?.semanticQuery) || cleanText(queryPlan?.rewrittenQuery) || cleanText(fallbackQuery);
  const visualQuery = cleanText(queryPlan?.retrieval?.visualQuery) || textQuery;
  const evidenceTerms = sanitizeEvidenceTerms(queryPlan?.retrieval?.evidenceTerms ?? fallbackEvidenceTerms(queryPlan, fallbackQuery));
  const requiredEvidence = sanitizeRequiredEvidence(queryPlan?.retrieval?.requiredEvidence ?? []);
  return {
    textQuery,
    visualQuery,
    evidenceTerms,
    requiredEvidence
  };
}

export function buildRetrievalPlan(
  originalQuery: string,
  semanticQuery: string,
  retrieval?: Partial<ResolvedQueryRetrievalPlan> | null
): ResolvedQueryRetrievalPlan {
  const textQuery = cleanText(retrieval?.textQuery) || cleanText(semanticQuery) || cleanText(originalQuery);
  const visualQuery = cleanText(retrieval?.visualQuery) || textQuery;
  const evidenceTerms = sanitizeEvidenceTerms(retrieval?.evidenceTerms ?? []);
  const requiredEvidence = sanitizeRequiredEvidence(retrieval?.requiredEvidence ?? []);
  return {
    textQuery,
    visualQuery,
    evidenceTerms,
    requiredEvidence
  };
}

export function sanitizeEvidenceTerms(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return unique(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => normalizeEvidenceTerm(value))
      .filter((value) => value.length > 0)
  ).slice(0, 16);
}

export function sanitizeRequiredEvidence(values: unknown): RetrievalEvidenceConstraint[] {
  if (!Array.isArray(values)) return [];
  const constraints: RetrievalEvidenceConstraint[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const rawKind = record.kind ?? record.source;
    const kind = rawKind === "visible_text" || rawKind === "spoken_text" ? rawKind : null;
    if (!kind) continue;
    const terms = sanitizeEvidenceTerms(record.terms).slice(0, 8);
    if (terms.length === 0) continue;
    constraints.push({
      kind,
      terms,
      match: record.match === "any" ? "any" : "all"
    });
  }
  return constraints.slice(0, 4);
}

function fallbackEvidenceTerms(queryPlan: DomainQueryPlan | null | undefined, fallbackQuery: string) {
  return queryPlan ? [] : extractKeywords(fallbackQuery);
}

function normalizeEvidenceTerm(value: string) {
  return normalizeSearchValue(value)
    .replace(/[^a-z0-9가-힣ぁ-ゟ゠-ヿ一-龯々〆〤\s-]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim().replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join(" ");
}

function cleanText(value: string | null | undefined) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
