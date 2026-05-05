import type { KnowledgeVectorRecord } from "./knowledge/documents";
import { cosineSimilarity, normalizeSearchValue } from "./intelligenceCore/textUtils";

export function scoreKnowledgeVectorRecord(record: KnowledgeVectorRecord, queryVector: number[], terms: string[], queryText: string) {
  const vectorScore = cosineSimilarity(queryVector, record.vector);
  const haystack = normalizeSearchValue([record.entityName, record.competition, record.season, record.team, record.text].filter(Boolean).join(" "));
  const termHits = terms.filter((term) => haystack.includes(normalizeSearchValue(term))).length;
  const lexicalScore = terms.length > 0 ? termHits / terms.length : 0;
  const normalizedQuery = normalizeSearchValue(queryText);
  const entityBoost = record.entityName && normalizedQuery.includes(normalizeSearchValue(record.entityName)) ? 0.25 : 0;
  const competitionBoost = record.competition && normalizedQuery.includes(normalizeSearchValue(record.competition)) ? 0.08 : 0;
  return Number((vectorScore * 0.72 + lexicalScore * 0.42 + entityBoost + competitionBoost).toFixed(6));
}
