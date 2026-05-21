import type { AssetRecord, DomainQueryPlan, IndexRecord, SearchResult } from "../shared/types";
import { searchAssets } from "./intelligence";
import { planDomainQuery } from "./queryPlanner";

export type SearchEvaluationExpected = {
  assetIds?: string[];
  segmentIds?: string[];
};

export type SearchEvaluationCase = {
  id: string;
  query: string;
  expected: SearchEvaluationExpected;
  queryPlan?: DomainQueryPlan;
  topK?: number;
};

export type SearchEvaluationCaseResult = {
  id: string;
  query: string;
  topK: number;
  hit: boolean;
  firstRelevantRank: number | null;
  reciprocalRank: number;
  ndcg: number;
  resultAssetIds: string[];
  resultSegmentIds: string[];
  queryPlan: DomainQueryPlan;
};

export type SearchEvaluationReport = {
  cases: SearchEvaluationCaseResult[];
  summary: {
    cases: number;
    topKHitRate: number;
    meanReciprocalRank: number;
    meanNdcg: number;
  };
};

export function evaluateSearchQuality(
  cases: SearchEvaluationCase[],
  assets: AssetRecord[],
  indexes: IndexRecord[],
  options: {
    defaultTopK?: number;
    planner?: (query: string) => DomainQueryPlan;
  } = {}
): SearchEvaluationReport {
  const planner = options.planner ?? planDomainQuery;
  const results = cases.map((item) => {
    const topK = item.topK ?? options.defaultTopK ?? 5;
    const queryPlan = item.queryPlan ?? planner(item.query);
    const searchResults = searchAssets(assets, indexes, item.query, {
      limit: topK,
      queryPlan,
      domainFilters: queryPlan.domainFilters
    });
    return evaluateCase(item, queryPlan, searchResults, topK);
  });
  return {
    cases: results,
    summary: {
      cases: results.length,
      topKHitRate: average(results.map((item) => (item.hit ? 1 : 0))),
      meanReciprocalRank: average(results.map((item) => item.reciprocalRank)),
      meanNdcg: average(results.map((item) => item.ndcg))
    }
  };
}

function evaluateCase(item: SearchEvaluationCase, queryPlan: DomainQueryPlan, results: SearchResult[], topK: number): SearchEvaluationCaseResult {
  const ranked = results.slice(0, topK);
  const relevance = ranked.map((result) => resultRelevance(result, item.expected));
  const firstRelevantIndex = relevance.findIndex((value) => value > 0);
  const idealRelevance = idealRelevanceScores(item.expected, topK);
  const ndcg = normalizedDiscountedCumulativeGain(relevance, idealRelevance);
  return {
    id: item.id,
    query: item.query,
    topK,
    hit: firstRelevantIndex >= 0,
    firstRelevantRank: firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : null,
    reciprocalRank: firstRelevantIndex >= 0 ? Number((1 / (firstRelevantIndex + 1)).toFixed(4)) : 0,
    ndcg,
    resultAssetIds: ranked.map((result) => result.asset.id),
    resultSegmentIds: ranked.flatMap((result) => result.segments.map((segment) => segment.id)),
    queryPlan
  };
}

function resultRelevance(result: SearchResult, expected: SearchEvaluationExpected) {
  const expectedSegments = new Set(expected.segmentIds ?? []);
  if (result.segments.some((segment) => expectedSegments.has(segment.id))) return 2;
  const expectedAssets = new Set(expected.assetIds ?? []);
  return expectedAssets.has(result.asset.id) ? 1 : 0;
}

function idealRelevanceScores(expected: SearchEvaluationExpected, topK: number) {
  const scores =
    (expected.segmentIds?.length ?? 0) > 0
      ? Array.from({ length: expected.segmentIds?.length ?? 0 }, () => 2)
      : Array.from({ length: expected.assetIds?.length ?? 0 }, () => 1);
  return scores.sort((a, b) => b - a).slice(0, topK);
}

function normalizedDiscountedCumulativeGain(relevance: number[], idealRelevance: number[]) {
  const ideal = discountedCumulativeGain(idealRelevance);
  if (ideal === 0) return 0;
  return Number((discountedCumulativeGain(relevance) / ideal).toFixed(4));
}

function discountedCumulativeGain(relevance: number[]) {
  return relevance.reduce((score, value, index) => score + (2 ** value - 1) / Math.log2(index + 2), 0);
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}
