import type { DomainQueryPlan } from "../shared/types";
import { extractKeywords, normalizeSearchValue, unique } from "./intelligenceCore/textUtils";

export type ResolvedQueryRetrievalPlan = {
  textQuery: string;
  visualQuery: string;
  evidenceTerms: string[];
};

export function resolveQueryRetrievalPlan(queryPlan: DomainQueryPlan | null | undefined, fallbackQuery: string): ResolvedQueryRetrievalPlan {
  const textQuery = cleanText(queryPlan?.retrieval?.textQuery) || cleanText(queryPlan?.semanticQuery) || cleanText(queryPlan?.rewrittenQuery) || cleanText(fallbackQuery);
  const visualQuery = cleanText(queryPlan?.retrieval?.visualQuery) || textQuery;
  const evidenceTerms = sanitizeEvidenceTerms(queryPlan?.retrieval?.evidenceTerms ?? fallbackEvidenceTerms(queryPlan, fallbackQuery));
  return {
    textQuery,
    visualQuery,
    evidenceTerms
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
  return {
    textQuery,
    visualQuery,
    evidenceTerms
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

function fallbackEvidenceTerms(queryPlan: DomainQueryPlan | null | undefined, fallbackQuery: string) {
  return queryPlan ? [] : extractKeywords(fallbackQuery);
}

function normalizeEvidenceTerm(value: string) {
  return normalizeSearchValue(value)
    .replace(/[^a-z0-9가-힣\s-]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim().replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join(" ");
}

function cleanText(value: string | null | undefined) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
