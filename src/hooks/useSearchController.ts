import { type FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AskAnswerContent,
  AskResponse,
  AssetSummaryRecord,
  DomainQueryPlan,
  IndexRecord,
  KnowledgeSourceId,
  OrchestrationPlan,
  SearchResult,
  StructuredKnowledgeAnswer
} from "../../shared/types";
import { formatKnowledgeSourceLabel } from "../../shared/knowledgeSources";
import { api } from "../api";
import type { SearchKnowledgeContext, SearchScopeMode } from "../consoleTypes";
import { buildConsoleUrl } from "../navigation";
import {
  filterSearchResultsByTrust,
  TRUST_PRESETS,
  type SearchTrustFilters
} from "../searchTrust";
import type { SearchConversationTurn } from "../components/SearchPanels";

const SEARCH_HISTORY_STORAGE_KEY = "arion.search.history.v2";
const LEGACY_SEARCH_HISTORY_STORAGE_KEYS = ["arion.search.history.v1"];
const SEARCH_HISTORY_LIMIT = 30;

export function useSearchController({
  indexes,
  assets,
  selectedIndexId,
  selectedAssetId,
  setMessage
}: {
  indexes: IndexRecord[];
  assets: AssetSummaryRecord[];
  selectedIndexId: string | null;
  selectedAssetId: string | null;
  setMessage: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [searchScopeMode, setSearchScopeModeState] = useState<SearchScopeMode>("all");
  const [searchIndexId, setSearchIndexIdState] = useState(selectedIndexId ?? "");
  const [searchAssetId, setSearchAssetIdState] = useState(selectedAssetId ?? "");
  const trustFilters: SearchTrustFilters = TRUST_PRESETS.balanced;
  const [queryPlan, setQueryPlan] = useState<DomainQueryPlan | null>(null);
  const [orchestrationPlan, setOrchestrationPlan] = useState<OrchestrationPlan | null>(null);
  const [knowledgeAnswer, setKnowledgeAnswer] = useState<StructuredKnowledgeAnswer | null>(null);
  const [askResponse, setAskResponse] = useState<AskResponse | null>(null);
  const [searchConversation, setSearchConversation] = useState<SearchConversationTurn[]>([]);
  const [searchHistoryReady, setSearchHistoryReady] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    for (const key of LEGACY_SEARCH_HISTORY_STORAGE_KEYS) window.localStorage.removeItem(key);
    const storedHistory = readStoredSearchHistory();
    setSearchConversation(storedHistory);
    setSearchHistoryReady(true);
    void reconcileStoredAskTurns(storedHistory);
  }, []);

  useEffect(() => {
    if (!searchHistoryReady) return;
    writeStoredSearchHistory(searchConversation);
  }, [searchConversation, searchHistoryReady]);

  const filteredSearchResults = useMemo(() => filterSearchResultsByTrust(searchResults, trustFilters), [searchResults, trustFilters]);
  const searchAsset = useMemo(() => assets.find((asset) => asset.id === searchAssetId) ?? null, [assets, searchAssetId]);
  const searchIndex = useMemo(() => {
    const scopedIndexId = searchScopeMode === "asset" ? searchAsset?.indexId : searchIndexId;
    return indexes.find((index) => index.id === scopedIndexId) ?? null;
  }, [indexes, searchAsset, searchIndexId, searchScopeMode]);
  const searchScopeLabel = useMemo(() => {
    if (searchScopeMode === "all") return `All videos (${assets.length})`;
    if (searchScopeMode === "asset") return searchAsset ? `Video: ${searchAsset.title}` : "Select video";
    if (!searchIndex) return "Select asset group";
    return `Asset group: ${searchIndex.name} (${assets.filter((asset) => asset.indexId === searchIndex.id).length})`;
  }, [assets, searchAsset, searchIndex, searchScopeMode]);
  const searchKnowledgeContext = useMemo(
    () => buildSearchKnowledgeContext(searchScopeMode, searchIndex, searchAsset, indexes, assets),
    [assets, indexes, searchAsset, searchIndex, searchScopeMode]
  );
  const useKnowledgeLayer = searchKnowledgeContext.enabled;

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
    setQuery("");
    const turnId = `ask-${Date.now()}-${searchConversation.length}`;
    let activeTurnId: string | null = turnId;
    let latestResponse: AskResponse | null = null;
    setSearching(true);
    setMessage("");
    setKnowledgeAnswer(null);
    setAskResponse(null);
    setQueryPlan(null);
    setOrchestrationPlan(null);
    setSearchResults([]);
    upsertSearchTurn({
      id: turnId,
      query: submittedQuery || "Filtered search",
      answerContent: null,
      route: "moment_retrieval",
      knowledgeAnswer: null,
      results: [],
      plan: null,
      operation: null,
      orchestrationPlan: null
    });
    const searchScope = resolveSearchScope(searchScopeMode, searchIndexId, searchAssetId, assets);
    try {
      const started = await api.post<AskResponse>("/api/ask", {
        q: submittedQuery,
        indexId: searchScope.indexId,
        assetId: searchScope.assetId,
        domainGroup: searchKnowledgeContext.domainGroup,
        useKnowledgeLayer
      });
      latestResponse = started;
      setAskResponse(started);
      upsertSearchTurn(buildSearchTurnFromResponse(turnId, submittedQuery, started));
      const completed = await waitForAskOperation(started.operation.id, (response) => {
        latestResponse = response;
        setQueryPlan(response.queryPlan);
        setOrchestrationPlan(response.orchestrationPlan);
        upsertSearchTurn(
          isTerminalAskResponse(response)
            ? buildCompletedSearchTurnFromResponse(turnId, submittedQuery, response)
            : buildSearchTurnFromResponse(turnId, submittedQuery, response)
        );
      });
      latestResponse = completed;
      setAskResponse(completed);
      setQueryPlan(completed.queryPlan);
      setOrchestrationPlan(completed.orchestrationPlan);
      setKnowledgeAnswer(completed.knowledgeAnswer?.applicable ? completed.knowledgeAnswer : null);
      setSearchResults(completed.results);
      upsertSearchTurn(buildCompletedSearchTurnFromResponse(turnId, submittedQuery, completed));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Ask request failed";
      setSearchResults([]);
      upsertSearchTurn({
        id: activeTurnId ?? `${Date.now()}-${searchConversation.length}`,
        query: submittedQuery || "Filtered search",
        answerContent: plainClientAnswerContent(errorMessage),
        route: "error",
        knowledgeAnswer: null,
        results: [],
        plan: latestResponse?.queryPlan ?? null,
        operation: latestResponse?.operation ?? null,
        orchestrationPlan: latestResponse?.orchestrationPlan ?? null
      });
      setMessage(errorMessage);
    } finally {
      setSearching(false);
    }
  }

  async function waitForAskOperation(operationId: string, onResponse?: (response: AskResponse) => void) {
    return new Promise<AskResponse>((resolve, reject) => {
      let settled = false;
      const source = new EventSource(`/api/events/stream?operationId=${encodeURIComponent(operationId)}`);
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("Ask operation timed out while waiting for server trace."));
      }, 48_000);
      const onUpdate = (event: Event) => {
        const response = readAskResponseEvent(event, operationId);
        if (response) finish(response);
      };
      const finish = (response: AskResponse) => {
        setAskResponse(response);
        onResponse?.(response);
        if (response.operation.status !== "succeeded" && response.operation.status !== "failed") return;
        cleanup();
        resolve(response);
      };
      const cleanup = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        source.removeEventListener("ask.operation.updated", onUpdate);
        source.close();
      };
      source.addEventListener("ask.operation.updated", onUpdate);
      void api.get<AskResponse>(`/api/ask/${operationId}`).then(finish).catch((error) => {
        cleanup();
        reject(error);
      });
    });
  }

  async function reconcileStoredAskTurns(turns: SearchConversationTurn[]) {
    const pendingTurns = turns.filter((turn) => shouldReconnectStoredAskTurn(turn));
    if (pendingTurns.length === 0) return;
    const latestTurnId = turns[turns.length - 1]?.id ?? null;
    await Promise.all(
      pendingTurns.map(async (turn) => {
        const operationId = turn.operation?.id;
        if (!operationId) return;
        try {
          const current = await api.get<AskResponse>(`/api/ask/${operationId}`);
          applyStoredAskResponse(turn, current, turn.id === latestTurnId);
          if (!isTerminalAskResponse(current)) {
            void waitForAskOperation(operationId, (response) => applyStoredAskResponse(turn, response, turn.id === latestTurnId)).then((response) => {
              applyStoredAskResponse(turn, response, turn.id === latestTurnId);
            }).catch(() => undefined);
          }
        } catch {
          // Keep the stored turn as-is when the operation is no longer available.
        }
      })
    );
  }

  function applyStoredAskResponse(turn: SearchConversationTurn, response: AskResponse, syncActiveState: boolean) {
    const nextTurn = isTerminalAskResponse(response)
      ? buildCompletedSearchTurnFromResponse(turn.id, turn.query, response)
      : buildSearchTurnFromResponse(turn.id, turn.query, response);
    upsertSearchTurn(nextTurn);
    if (!syncActiveState) return;
    setAskResponse(response);
    setQueryPlan(response.queryPlan);
    setOrchestrationPlan(response.orchestrationPlan);
    setKnowledgeAnswer(response.knowledgeAnswer?.applicable ? response.knowledgeAnswer : null);
    setSearchResults(response.results);
  }

  function readAskResponseEvent(event: Event, operationId: string) {
    try {
      const message = event as MessageEvent<string>;
      const parsed = JSON.parse(message.data) as { payload?: { operationId?: unknown; response?: unknown } };
      if (parsed.payload?.operationId !== operationId) return null;
      return parsed.payload.response as AskResponse;
    } catch {
      return null;
    }
  }

  function upsertSearchTurn(turn: SearchConversationTurn) {
    setSearchConversation((current) =>
      (current.some((item) => item.id === turn.id)
        ? current.map((item) => (item.id === turn.id ? turn : item))
        : [...current, turn]
      ).slice(-SEARCH_HISTORY_LIMIT)
    );
  }

  function clearSearchHistory() {
    setSearchConversation([]);
    setSearchResults([]);
    setKnowledgeAnswer(null);
    setAskResponse(null);
    setQueryPlan(null);
    setOrchestrationPlan(null);
    setMessage("");
    window.localStorage.removeItem(SEARCH_HISTORY_STORAGE_KEY);
  }

  function buildAssetMomentUrl(assetId: string, segmentId?: string | null, at?: number | null) {
    return buildConsoleUrl(window.location.href, {
      activeTab: "data",
      selectedAssetId: assetId,
      selectedSegmentId: segmentId,
      assetDetailTab: "overview",
      seekAt: at
    });
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
    searchKnowledgeContext,
    queryPlan,
    orchestrationPlan,
    knowledgeAnswer,
    askResponse,
    searchConversation,
    searchResults,
    setSearchResults,
    filteredSearchResults,
    searching,
    runSearch,
    clearSearchHistory,
    buildAssetMomentUrl
  };
}

function readStoredSearchHistory(): SearchConversationTurn[] {
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredSearchTurn).slice(-SEARCH_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeStoredSearchHistory(turns: SearchConversationTurn[]) {
  try {
    if (turns.length === 0) {
      window.localStorage.removeItem(SEARCH_HISTORY_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(turns.slice(-SEARCH_HISTORY_LIMIT)));
  } catch {
    // Ignore storage quota/private mode failures; search still works in memory.
  }
}

function isStoredSearchTurn(value: unknown): value is SearchConversationTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<SearchConversationTurn>;
  return (
    typeof turn.id === "string" &&
    typeof turn.query === "string" &&
    "answerContent" in turn &&
    (turn.answerContent === null || isAskAnswerContent(turn.answerContent)) &&
    Array.isArray(turn.results)
  );
}

function isAskAnswerContent(value: unknown): value is AskAnswerContent {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { format?: unknown }).format === "plain" || (value as { format?: unknown }).format === "sections") &&
    typeof (value as { text?: unknown }).text === "string" &&
    Array.isArray((value as { sections?: unknown }).sections)
  );
}

function buildSearchTurnFromResponse(
  id: string,
  submittedQuery: string,
  response: AskResponse,
  overrides: Partial<Pick<SearchConversationTurn, "route" | "knowledgeAnswer" | "results">> = {}
): SearchConversationTurn {
  const results = overrides.results ?? response.results;
  return {
    id,
    query: submittedQuery || "Filtered search",
    answerContent: response.answerContent,
    route: overrides.route ?? conversationRouteFor(response),
    knowledgeAnswer: overrides.knowledgeAnswer ?? (response.knowledgeAnswer?.applicable ? response.knowledgeAnswer : null),
    results,
    plan: response.queryPlan,
    operation: response.operation,
    orchestrationPlan: response.orchestrationPlan
  };
}

function buildCompletedSearchTurnFromResponse(id: string, submittedQuery: string, response: AskResponse): SearchConversationTurn {
  if (response.route === "structured_answer" && response.knowledgeAnswer) {
    return buildSearchTurnFromResponse(id, submittedQuery, response, {
      route: "structured_answer",
      knowledgeAnswer: response.knowledgeAnswer,
      results: []
    });
  }
  return buildSearchTurnFromResponse(
    id,
    submittedQuery,
    response,
    {
      route: response.results.length > 0 ? "moment_retrieval" : response.route === "error" ? "error" : "empty",
      knowledgeAnswer: null,
      results: response.results
    }
  );
}

function plainClientAnswerContent(answer: string): AskAnswerContent {
  const trimmed = answer.trim();
  return {
    format: "plain",
    text: trimmed,
    sections: trimmed
      ? [
          {
            id: "answer",
            label: null,
            body: trimmed,
            tone: "neutral"
          }
        ]
      : []
  };
}

function conversationRouteFor(response: AskResponse): SearchConversationTurn["route"] {
  if (response.route === "structured_answer") return "structured_answer";
  if (response.route === "error" || response.operation.status === "failed") return "error";
  if (response.route === "empty") return "empty";
  return "moment_retrieval";
}

function isTerminalAskResponse(response: AskResponse) {
  return response.operation.status === "succeeded" || response.operation.status === "failed";
}

function shouldReconnectStoredAskTurn(turn: SearchConversationTurn) {
  return Boolean(
    turn.operation?.id &&
      (turn.operation.status === "queued" ||
        turn.operation.status === "running")
  );
}

function buildSearchKnowledgeContext(
  scopeMode: SearchScopeMode,
  searchIndex: IndexRecord | null,
  searchAsset: AssetSummaryRecord | null,
  indexes: IndexRecord[],
  assets: AssetSummaryRecord[]
): SearchKnowledgeContext {
  if (scopeMode === "group") {
    return describeIndexKnowledge(searchIndex, searchIndex ? "group" : "missing");
  }
  if (scopeMode === "asset") {
    const assetIndex = searchAsset ? indexes.find((index) => index.id === searchAsset.indexId) ?? null : null;
    return describeIndexKnowledge(assetIndex, searchAsset ? "asset" : "missing");
  }
  const assetIndexIds = new Set(assets.map((asset) => asset.indexId).filter(Boolean));
  const scopedIndexes = indexes.filter((index) => assetIndexIds.has(index.id));
  const domainIndexes = scopedIndexes.filter((index) => index.domainIndexing?.enabled);
  if (domainIndexes.length === 0) {
    return {
      enabled: false,
      label: "Video-only",
      detail: "No related knowledge is linked to the current video library.",
      tone: "off"
    };
  }
  return {
    enabled: true,
    label: domainIndexes.length === scopedIndexes.length ? "Knowledge-bound" : "Mixed knowledge",
    detail: `${domainIndexes.length}/${scopedIndexes.length || indexes.length} asset groups · ${formatDomainGroups(uniqueDomainGroups(domainIndexes))}`,
    tone: domainIndexes.length === scopedIndexes.length ? "domain" : "mixed"
  };
}

function describeIndexKnowledge(index: IndexRecord | null, scope: "group" | "asset" | "missing"): SearchKnowledgeContext {
  if (!index) {
    return {
      enabled: false,
      label: scope === "asset" ? "Select video" : "Select group",
      detail: "No search target selected.",
      tone: "off"
    };
  }
  if (!index.domainIndexing?.enabled) {
    return {
      enabled: false,
      label: "Video-only",
      detail: `${index.name} has no related knowledge linked.`,
      tone: "off"
    };
  }
  return {
    enabled: true,
    label: "Knowledge-bound",
    detail: `${index.name} · ${formatDomainGroups(index.domainIndexing.groups)}`,
    domainGroup: index.domainIndexing.groups.length === 1 ? index.domainIndexing.groups[0] : undefined,
    tone: "domain"
  };
}

function uniqueDomainGroups(indexes: IndexRecord[]) {
  return Array.from(new Set(indexes.flatMap((index) => index.domainIndexing?.groups ?? [])));
}

function formatDomainGroups(groups: KnowledgeSourceId[]) {
  if (groups.length === 0) return "No related knowledge";
  return groups.map(formatKnowledgeSourceLabel).join(", ");
}

function resolveSearchScope(scopeMode: SearchScopeMode, indexId: string, assetId: string, assets: AssetSummaryRecord[]) {
  if (scopeMode === "all") return {};
  if (scopeMode === "group") return { indexId: indexId || undefined };
  const asset = assets.find((item) => item.id === assetId);
  return {
    indexId: asset?.indexId,
    assetId: asset?.id
  };
}
