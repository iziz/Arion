import { expandDomainQuery } from "../../domainIndex";
import { searchAssets } from "../../intelligence";
import { groundQueryWithKnowledge } from "../../knowledgeGrounding";
import { embedQueryText } from "../../localEmbeddingRuntime";
import { searchKnowledgeVectors } from "../../localKnowledgeVectorStore";
import { embedVisualQuery } from "../../localVisualEmbeddingRuntime";
import { searchVectors } from "../../localVectorStore";
import { searchVisualVectors } from "../../localVisualVectorStore";
import { traceAsync } from "../../observability";
import { isPlayerInventoryQuery } from "../../queryPlanner";
import { knowledgeVectorHitToEvidence } from "../../sportsKnowledgeDocuments";
import type { AssetRecord, IndexRecord, KnowledgeEvidence, SearchResult, SportsDomainGroup, TimelineSegment } from "../../../shared/types";
import { formatSearchScope } from "./answerBuilder";
import { runOptionalAskStep } from "./stepRunner";
import type { AskRequest, SearchPipelineRequest } from "./types";

export async function executeSearchPipeline({
  query,
  explicitFilters,
  queryPlan,
  assets,
  indexes,
  indexId,
  assetId,
  domainGroup,
  tag,
  modality,
  limit,
  useKnowledgeLayer,
  askEntry
}: SearchPipelineRequest): Promise<SearchResult[]> {
  const scopedAssets = scopeAssetsForQuery(assets, { query, explicitFilters, indexId, assetId, domainGroup, tag, modality, limit, useKnowledgeLayer }, indexes);
  const assetScopeIndexId = assetId ? scopedAssets[0]?.indexId : undefined;
  const vectorScopeIndexId = resolveVectorScopeIndexId(indexes, indexId ?? assetScopeIndexId, domainGroup);
  const useSportsKnowledgeLayer = Boolean(useKnowledgeLayer && shouldUseSportsKnowledgeLayer(queryPlan, indexes, indexId ?? assetScopeIndexId, domainGroup));
  const groundedQuery = await runOptionalAskStep(askEntry, {
    id: "ground",
    label: "Knowledge grounding",
    owner: "knowledge",
    input: queryPlan.rewrittenQuery
  }, async () => {
    if (!useSportsKnowledgeLayer) {
      return {
        value: {
          filters: queryPlan.domainFilters,
          semanticQuery: queryPlan.semanticQuery,
          evidence: [],
          evidenceSummary: useKnowledgeLayer
            ? "Sports knowledge skipped because the query is not grounded to a supported sports domain."
            : "Knowledge layer disabled by search option."
        },
        output: useKnowledgeLayer ? "Skipped for non-sports query scope." : "Disabled by search option.",
        status: "skipped" as const
      };
    }
    const grounded = groundQueryWithKnowledge(queryPlan, scopedAssets);
    return {
      value: grounded,
      output: grounded.evidenceSummary
    };
  });
  const expandedQuery = expandDomainQuery([queryPlan.originalQuery, groundedQuery.semanticQuery].filter(Boolean).join(" ")).expandedText;
  const options = {
    indexId: vectorScopeIndexId,
    tag,
    modality,
    limit,
    domainFilters: groundedQuery.filters,
    queryPlan,
    knowledgeEvidence: groundedQuery.evidence,
    useKnowledgeLayer: useSportsKnowledgeLayer
  };
  if (isPlayerInventoryQuery(query)) {
    return runOptionalAskStep(askEntry, {
      id: "rank",
      label: "Rank matching assets",
      owner: "retrieval",
      input: "player inventory query"
    }, async () => {
      const results = searchAssets(scopedAssets, indexes, query, options).map((result) => ({ ...result, explain: [...result.explain, `knowledge grounding=${groundedQuery.evidenceSummary}`] }));
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
    const queryVector = await traceAsync("search.embed_text_query", { indexId: options.indexId ?? domainGroup ?? "all" }, () => embedQueryText(expandedQuery), "search.embed_text_query");
    let visualQueryVector: number[] = [];
    let visualOutput = "visual=unavailable";
    try {
      visualQueryVector = await traceAsync("search.embed_visual_query", { indexId: options.indexId ?? domainGroup ?? "all" }, () => embedVisualQuery(query), "search.embed_visual_query");
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
    input: `index=${options.indexId ?? domainGroup ?? "all"} · limit=${limit ?? 25}`
  }, async () => {
    const [vectorHits, visualHits] = await Promise.all([
      traceAsync("search.vector_text", { indexId: options.indexId ?? "all" }, () => searchVectors(options.indexId, vectors.queryVector, Number(limit ?? 25)), "search.vector_text"),
      vectors.visualQueryVector.length
        ? traceAsync(
            "search.vector_visual",
            { indexId: options.indexId ?? domainGroup ?? "all" },
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
  const knowledgeVectorHits = await runOptionalAskStep(askEntry, {
    id: "knowledge_vector_search",
    label: "Knowledge vector retrieval",
    owner: "knowledge",
    input: `domain=${domainGroup ?? "auto"} · limit=${limit ?? 24}`
  }, async () => {
    if (!useSportsKnowledgeLayer) {
      return {
        value: [],
        output: useKnowledgeLayer ? "Skipped for non-sports query scope." : "Disabled by search option.",
        status: "skipped" as const
      };
    }
    const knowledgeDomainGroup = domainGroup ?? domainGroupFromCompetition(queryPlan.domainFilters.competition);
    const hits = await traceAsync(
      "search.knowledge_vector",
      { domainGroup: knowledgeDomainGroup ?? "all", limit: Number(limit ?? 24) },
      () => searchKnowledgeVectors(knowledgeDomainGroup, vectors.queryVector, Number(limit ?? 24), expandedQuery),
      "search.knowledge_vector"
    );
    return {
      value: hits,
      output: `${hits.length} knowledge hits`
    };
  });
  const knowledgeVectorEvidence = dedupeKnowledgeEvidence(knowledgeVectorHits.map(knowledgeVectorHitToEvidence));
  const combinedKnowledgeEvidence = dedupeKnowledgeEvidence([...groundedQuery.evidence, ...knowledgeVectorEvidence]);
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
    input: formatSearchScope({ indexId, assetId, domainGroup, tag, modality })
  }, async () => {
    const results = searchAssets(scopedAssets, indexes, query, { ...options, knowledgeEvidence: combinedKnowledgeEvidence, queryVector: vectors.queryVector, vectorHitsBySegment, visualHitsBySegment }).map((result) => ({
      ...result,
      explain: [...result.explain, `knowledge grounding=${groundedQuery.evidenceSummary}`, `${knowledgeVectorEvidence.length} knowledge vector hits`, `${vectorSegmentsByAsset.get(result.asset.id) ?? 0} local vector DB hits`]
    }));
    return {
      value: results,
      output: `${results.length} assets · ${results.reduce((sum, result) => sum + result.segments.length, 0)} moments`
    };
  });
}

function domainGroupFromCompetition(competition: string | undefined): SportsDomainGroup | undefined {
  if (!competition) return undefined;
  return competition === "NFL" ? "sports.american_football" : "sports.football";
}

function shouldUseSportsKnowledgeLayer(
  queryPlan: SearchPipelineRequest["queryPlan"],
  indexes: IndexRecord[],
  indexId: string | undefined,
  domainGroup: AskRequest["domainGroup"]
) {
  if (domainGroup) return true;
  if (!isSportsRoute(queryPlan.route)) return false;
  const selectedIndex = indexId ? indexes.find((index) => index.id === indexId) : null;
  if (selectedIndex?.domainIndexing?.enabled && selectedIndex.domainIndexing.groups.length > 0) return true;
  const profile = expandDomainQuery(`${queryPlan.originalQuery} ${queryPlan.semanticQuery}`);
  if (queryPlan.route === "sports_stat_qa" || queryPlan.intent.metric) return true;
  if (queryPlan.intent.player || queryPlan.intent.eventType || queryPlan.intent.passType || queryPlan.intent.fieldZone || queryPlan.intent.role) return true;
  if (queryPlan.domainFilters.competition || queryPlan.domainFilters.player || queryPlan.domainFilters.eventType || queryPlan.domainFilters.passType || queryPlan.domainFilters.fieldZone || queryPlan.domainFilters.role) return true;
  return profile.domains.length > 0 || profile.labels.length > 0 || profile.football.playerRequired || profile.americanFootball.quarterbackRequired;
}

function isSportsRoute(route: SearchPipelineRequest["queryPlan"]["route"]) {
  return route === "sports_moment_retrieval" || route === "sports_analysis" || route === "sports_stat_qa";
}

function dedupeKnowledgeEvidence(evidence: KnowledgeEvidence[]) {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scopeAssetsForQuery(assets: AssetRecord[], request: AskRequest, indexes: IndexRecord[] = []) {
  const indexById = new Map(indexes.map((index) => [index.id, index]));
  const scoped = assets
    .filter((asset) => !request.assetId || asset.id === request.assetId)
    .filter((asset) => !request.indexId || asset.indexId === request.indexId)
    .filter((asset) => {
      const domainGroup = request.domainGroup;
      if (!domainGroup) return true;
      const index = indexById.get(asset.indexId);
      if (index?.domainIndexing?.groups.includes(domainGroup)) return true;
      return asset.timeline.some((segment) => segment.domain?.groups.includes(domainGroup));
    })
    .filter((asset) => !request.tag || asset.tags.includes(request.tag))
    .map((asset) =>
      request.modality
        ? {
            ...asset,
            timeline: asset.timeline.filter((segment) => segment.modalities.includes(request.modality as TimelineSegment["modalities"][number]))
          }
        : asset
    );
  const referencedAssets = scopeByReferencedAsset(scoped, request.query);
  return referencedAssets.length > 0 ? referencedAssets : scoped;
}

function resolveVectorScopeIndexId(indexes: IndexRecord[], indexId: string | undefined, domainGroup: AskRequest["domainGroup"]) {
  if (indexId) return indexId;
  if (!domainGroup) return undefined;
  const matching = indexes.filter((index) => index.domainIndexing?.groups.includes(domainGroup));
  return matching.length === 1 ? matching[0].id : undefined;
}

function scopeByReferencedAsset(assets: AssetRecord[], query: string) {
  const references = extractAssetReferences(query);
  if (references.length === 0) return [];
  return assets.filter((asset) => {
    const haystack = [asset.id, asset.title, asset.originalName, asset.storedName, asset.description].join(" ").toLowerCase();
    return references.some((reference) => haystack.includes(reference));
  });
}

function extractAssetReferences(query: string) {
  const references = new Set<string>();
  for (const match of query.matchAll(/\[([A-Za-z0-9_-]{6,})\]/g)) {
    references.add(match[1].toLowerCase());
  }
  for (const match of query.matchAll(/\bvideo\s*id\s*[:=]?\s*([A-Za-z0-9_-]{6,})\b/gi)) {
    references.add(match[1].toLowerCase());
  }
  return Array.from(references);
}
