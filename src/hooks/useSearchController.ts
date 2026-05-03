import { type FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AskResponse,
  AssetRecord,
  DomainQueryPlan,
  IndexRecord,
  OrchestrationPlan,
  SearchResult,
  SportsKnowledgeAnswer
} from "../../shared/types";
import { api, sleep } from "../api";
import type { SearchScopeMode } from "../consoleTypes";
import {
  buildSearchAssistantAnswer,
  filterSearchResultsByTrust,
  TRUST_PRESETS,
  type SearchTrustFilters
} from "../searchTrust";
import type { SearchConversationTurn } from "../components/SearchPanels";

export function useSearchController({
  indexes,
  assets,
  selectedIndexId,
  selectedAssetId,
  setMessage
}: {
  indexes: IndexRecord[];
  assets: AssetRecord[];
  selectedIndexId: string | null;
  selectedAssetId: string | null;
  setMessage: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [searchScopeMode, setSearchScopeModeState] = useState<SearchScopeMode>("all");
  const [searchIndexId, setSearchIndexIdState] = useState(selectedIndexId ?? "");
  const [searchAssetId, setSearchAssetIdState] = useState(selectedAssetId ?? "");
  const trustFilters: SearchTrustFilters = TRUST_PRESETS.balanced;
  const [useKnowledgeLayer, setUseKnowledgeLayer] = useState(true);
  const [queryPlan, setQueryPlan] = useState<DomainQueryPlan | null>(null);
  const [orchestrationPlan, setOrchestrationPlan] = useState<OrchestrationPlan | null>(null);
  const [sportsAnswer, setSportsAnswer] = useState<SportsKnowledgeAnswer | null>(null);
  const [askResponse, setAskResponse] = useState<AskResponse | null>(null);
  const [searchConversation, setSearchConversation] = useState<SearchConversationTurn[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const filteredSearchResults = useMemo(() => filterSearchResultsByTrust(searchResults, trustFilters), [searchResults, trustFilters]);
  const searchAsset = useMemo(() => assets.find((asset) => asset.id === searchAssetId) ?? null, [assets, searchAssetId]);
  const searchIndex = useMemo(() => {
    const scopedIndexId = searchScopeMode === "asset" ? searchAsset?.indexId : searchIndexId;
    return indexes.find((index) => index.id === scopedIndexId) ?? null;
  }, [indexes, searchAsset, searchIndexId, searchScopeMode]);
  const searchScopeLabel = useMemo(() => {
    if (searchScopeMode === "all") return `All videos (${assets.length})`;
    if (searchScopeMode === "asset") return searchAsset?.title ?? "Select video";
    if (!searchIndex) return "Select asset group";
    const groupAssetCount = assets.filter((asset) => asset.indexId === searchIndex.id).length;
    return `${searchIndex.name} (${groupAssetCount})`;
  }, [assets, searchAsset, searchIndex, searchScopeMode]);

  useEffect(() => {
    if (indexes.length === 0) {
      if (searchIndexId) setSearchIndexIdState("");
      return;
    }
    if (indexes.some((index) => index.id === searchIndexId)) return;
    const selectedIndexIsValid = selectedIndexId ? indexes.some((index) => index.id === selectedIndexId) : false;
    setSearchIndexIdState(selectedIndexIsValid && selectedIndexId ? selectedIndexId : indexes[0]?.id ?? "");
  }, [indexes, searchIndexId, selectedIndexId]);

  useEffect(() => {
    if (assets.length === 0) {
      if (searchAssetId) setSearchAssetIdState("");
      return;
    }
    if (!searchAssetId || assets.some((asset) => asset.id === searchAssetId)) return;
    const selectedAssetIsValid = selectedAssetId ? assets.some((asset) => asset.id === selectedAssetId) : false;
    setSearchAssetIdState(selectedAssetIsValid && selectedAssetId ? selectedAssetId : "");
  }, [assets, searchAssetId, selectedAssetId]);

  function setSearchScopeMode(mode: SearchScopeMode) {
    setSearchScopeModeState(mode);
    if (mode === "group" && !indexes.some((index) => index.id === searchIndexId)) {
      setSearchIndexIdState(selectedIndexId && indexes.some((index) => index.id === selectedIndexId) ? selectedIndexId : indexes[0]?.id ?? "");
    }
    if (mode === "asset" && !assets.some((asset) => asset.id === searchAssetId)) {
      const fallbackAsset =
        (selectedAssetId ? assets.find((asset) => asset.id === selectedAssetId) : null) ??
        assets.find((asset) => asset.indexId === searchIndexId) ??
        assets[0] ??
        null;
      setSearchAssetIdState(fallbackAsset?.id ?? "");
      if (fallbackAsset) setSearchIndexIdState(fallbackAsset.indexId);
    }
  }

  function setSearchIndexId(indexId: string) {
    setSearchIndexIdState(indexId);
    const selectedAssetBelongsToGroup = searchAssetId ? assets.some((asset) => asset.id === searchAssetId && asset.indexId === indexId) : false;
    if (searchScopeMode === "asset" && !selectedAssetBelongsToGroup) {
      setSearchAssetIdState(assets.find((asset) => asset.indexId === indexId)?.id ?? "");
    }
  }

  function setSearchAssetId(assetId: string) {
    setSearchAssetIdState(assetId);
    const asset = assets.find((item) => item.id === assetId);
    if (asset) setSearchIndexIdState(asset.indexId);
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const submittedQuery = query.trim();
    if (!submittedQuery) return;
    setSearching(true);
    setMessage("");
    setSportsAnswer(null);
    setAskResponse(null);
    const searchScope = resolveSearchScope(searchScopeMode, searchIndexId, searchAssetId, assets);
    try {
      const started = await api.post<AskResponse>("/api/ask", {
        q: submittedQuery,
        indexId: searchScope.indexId,
        assetId: searchScope.assetId,
        useKnowledgeLayer
      });
      setAskResponse(started);
      const completed = await pollAskOperation(started.operation.id);
      setAskResponse(completed);
      setQueryPlan(completed.queryPlan);
      setOrchestrationPlan(completed.orchestrationPlan);
      setSportsAnswer(completed.sportsAnswer?.applicable ? completed.sportsAnswer : null);
      if (completed.route === "stat_qa" && completed.sportsAnswer) {
        setSearchResults([]);
        appendSearchTurn(submittedQuery, completed.answer ?? completed.sportsAnswer.answer, "stat_qa", completed.sportsAnswer, [], completed.queryPlan);
        return;
      }
      setSearchResults(completed.results);
      appendSearchTurn(
        submittedQuery,
        completed.answer ?? (completed.queryPlan ? buildSearchAssistantAnswer(completed.results, completed.queryPlan) : "The ask operation completed without a readable answer."),
        completed.results.length > 0 ? "moment_retrieval" : completed.route === "error" ? "error" : "empty",
        null,
        completed.results,
        completed.queryPlan
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Ask request failed";
      setSearchResults([]);
      appendSearchTurn(submittedQuery, errorMessage, "error", null, [], null);
      setMessage(errorMessage);
    } finally {
      setSearching(false);
    }
  }

  async function pollAskOperation(operationId: string) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep(400);
      const next = await api.get<AskResponse>(`/api/ask/${operationId}`);
      setAskResponse(next);
      if (next.operation.status === "succeeded" || next.operation.status === "failed") return next;
    }
    throw new Error("Ask operation timed out while waiting for server trace.");
  }

  function appendSearchTurn(
    submittedQuery: string,
    answer: string,
    route: SearchConversationTurn["route"],
    nextSportsAnswer: SportsKnowledgeAnswer | null,
    results: SearchResult[],
    plan: DomainQueryPlan | null
  ) {
    setSearchConversation((current) =>
      [
        ...current,
        {
          id: `${Date.now()}-${current.length}`,
          query: submittedQuery || "Filtered search",
          answer,
          route,
          sportsAnswer: nextSportsAnswer,
          results,
          plan
        }
      ].slice(-8)
    );
  }

  function buildAssetMomentUrl(assetId: string, segmentId?: string | null, at?: number | null) {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "data");
    url.searchParams.set("assetTab", "overview");
    url.searchParams.set("asset", assetId);
    if (segmentId) {
      url.searchParams.set("segment", segmentId);
    } else {
      url.searchParams.delete("segment");
    }
    if (typeof at === "number" && Number.isFinite(at)) {
      url.searchParams.set("t", at.toFixed(2));
    } else {
      url.searchParams.delete("t");
    }
    return url.toString();
  }

  return {
    query,
    setQuery,
    searchScopeMode,
    setSearchScopeMode,
    searchIndexId,
    setSearchIndexId,
    searchAssetId,
    setSearchAssetId,
    searchScopeLabel,
    trustFilters,
    useKnowledgeLayer,
    setUseKnowledgeLayer,
    queryPlan,
    orchestrationPlan,
    sportsAnswer,
    askResponse,
    searchConversation,
    searchResults,
    setSearchResults,
    filteredSearchResults,
    searching,
    runSearch,
    buildAssetMomentUrl
  };
}

function resolveSearchScope(scopeMode: SearchScopeMode, indexId: string, assetId: string, assets: AssetRecord[]) {
  if (scopeMode === "all") return {};
  if (scopeMode === "group") return { indexId: indexId || undefined };
  const asset = assets.find((item) => item.id === assetId);
  return {
    indexId: asset?.indexId,
    assetId: asset?.id
  };
}
