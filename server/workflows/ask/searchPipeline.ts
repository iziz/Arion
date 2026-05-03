import { expandDomainQuery } from "../../domainIndex";
import { searchAssets } from "../../intelligence";
import { groundQueryWithKnowledge } from "../../knowledgeGrounding";
import { embedQueryText } from "../../localEmbeddingRuntime";
import { embedVisualQuery } from "../../localVisualEmbeddingRuntime";
import { searchVectors } from "../../localVectorStore";
import { searchVisualVectors } from "../../localVisualVectorStore";
import { traceAsync } from "../../observability";
import { isPlayerInventoryQuery } from "../../queryPlanner";
import type { AssetRecord, SearchResult, TimelineSegment } from "../../../shared/types";
import { formatSearchScope } from "./answerBuilder";
import { runOptionalAskStep } from "./stepRunner";
import type { AskRequest, SearchPipelineRequest } from "./types";

export async function executeSearchPipeline({
  query,
  queryPlan,
  assets,
  indexes,
  indexId,
  tag,
  modality,
  limit,
  askEntry
}: SearchPipelineRequest): Promise<SearchResult[]> {
  const groundedQuery = await runOptionalAskStep(askEntry, {
    id: "ground",
    label: "Knowledge grounding",
    owner: "knowledge",
    input: queryPlan.rewrittenQuery
  }, async () => {
    const grounded = groundQueryWithKnowledge(queryPlan, assets);
    return {
      value: grounded,
      output: grounded.evidenceSummary
    };
  });
  const expandedQuery = expandDomainQuery(groundedQuery.semanticQuery).expandedText;
  const options = {
    indexId,
    tag,
    modality,
    limit,
    domainFilters: groundedQuery.filters,
    queryPlan,
    knowledgeEvidence: groundedQuery.evidence
  };
  if (isPlayerInventoryQuery(query)) {
    return runOptionalAskStep(askEntry, {
      id: "rank",
      label: "Rank matching assets",
      owner: "retrieval",
      input: "player inventory query"
    }, async () => {
      const results = searchAssets(assets, indexes, query, options).map((result) => ({ ...result, explain: [...result.explain, `knowledge grounding=${groundedQuery.evidenceSummary}`] }));
      return {
        value: results,
        output: `${results.length} assets`
      };
    });
  }
  const vectors = await runOptionalAskStep(askEntry, {
    id: "embed_query",
    label: "Query embeddings",
    owner: "retrieval",
    input: expandedQuery
	  }, async () => {
	    const queryVector = await traceAsync("search.embed_text_query", { indexId: options.indexId ?? "all" }, () => embedQueryText(expandedQuery), "search.embed_text_query");
	    let visualQueryVector: number[] = [];
	    let visualOutput = "visual=unavailable";
	    try {
	      visualQueryVector = await traceAsync("search.embed_visual_query", { indexId: options.indexId ?? "all" }, () => embedVisualQuery(query), "search.embed_visual_query");
	      visualOutput = `visual=${visualQueryVector.length} dims`;
	    } catch (error) {
	      visualOutput = `visual=unavailable (${error instanceof Error ? error.message : "visual embedding failed"})`;
	    }
	    return {
	      value: { queryVector, visualQueryVector },
	      output: `text=${queryVector.length} dims · ${visualOutput}`,
	      status: visualQueryVector.length > 0 ? "succeeded" : "fallback"
	    };
	  });
  const { vectorHits, visualHits } = await runOptionalAskStep(askEntry, {
    id: "vector_search",
    label: "Vector search",
    owner: "retrieval",
    input: `index=${options.indexId ?? "all"} · limit=${limit ?? 25}`
  }, async () => {
    const [vectorHits, visualHits] = await Promise.all([
      traceAsync("search.vector_text", { indexId: options.indexId ?? "all" }, () => searchVectors(options.indexId, vectors.queryVector, Number(limit ?? 25)), "search.vector_text"),
      vectors.visualQueryVector.length
        ? traceAsync(
            "search.vector_visual",
            { indexId: options.indexId ?? "all" },
            () => searchVisualVectors(options.indexId, vectors.visualQueryVector, Number(limit ?? 25)),
            "search.vector_visual"
          )
        : Promise.resolve([])
    ]);
    return {
      value: { vectorHits, visualHits },
      output: `${vectorHits.length} text hits · ${visualHits.length} visual hits`
    };
  });
  const vectorSegmentsByAsset = new Map<string, number>();
  const vectorHitsBySegment = new Map<string, number>();
  const visualHitsBySegment = new Map<string, number>();
  for (const hit of vectorHits) {
    vectorSegmentsByAsset.set(hit.assetId, (vectorSegmentsByAsset.get(hit.assetId) ?? 0) + 1);
    vectorHitsBySegment.set(hit.segmentId, Math.max(vectorHitsBySegment.get(hit.segmentId) ?? 0, hit.score));
  }
  for (const hit of visualHits) {
    vectorSegmentsByAsset.set(hit.assetId, (vectorSegmentsByAsset.get(hit.assetId) ?? 0) + 1);
    visualHitsBySegment.set(hit.segmentId, Math.max(visualHitsBySegment.get(hit.segmentId) ?? 0, hit.score));
  }
  return runOptionalAskStep(askEntry, {
    id: "rank",
    label: "Rank and verify moments",
    owner: "retrieval",
    input: formatSearchScope({ indexId, tag, modality })
  }, async () => {
    const results = searchAssets(assets, indexes, query, { ...options, queryVector: vectors.queryVector, vectorHitsBySegment, visualHitsBySegment }).map((result) => ({
      ...result,
      explain: [...result.explain, `knowledge grounding=${groundedQuery.evidenceSummary}`, `${vectorSegmentsByAsset.get(result.asset.id) ?? 0} local vector DB hits`]
    }));
    return {
      value: results,
      output: `${results.length} assets · ${results.reduce((sum, result) => sum + result.segments.length, 0)} moments`
    };
  });
}

export function scopeAssetsForQuery(assets: AssetRecord[], request: AskRequest) {
  return assets
    .filter((asset) => !request.indexId || asset.indexId === request.indexId)
    .filter((asset) => !request.tag || asset.tags.includes(request.tag))
    .map((asset) =>
      request.modality
        ? {
            ...asset,
            timeline: asset.timeline.filter((segment) => segment.modalities.includes(request.modality as TimelineSegment["modalities"][number]))
          }
        : asset
    );
}
