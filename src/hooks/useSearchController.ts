import { type FormEvent, useMemo, useState } from "react";
import type {
  AskResponse,
  DomainQueryPlan,
  DomainSearchFilters,
  OrchestrationPlan,
  SearchResult,
  SportsDomainGroup,
  SportsKnowledgeAnswer
} from "../../shared/types";
import { api, sleep } from "../api";
import {
  buildSearchAssistantAnswer,
  filterSearchResultsByTrust,
  trustPresetFor,
  TRUST_PRESETS,
  type SearchTrustFilters
} from "../searchTrust";
import type { SearchConversationTurn } from "../components/SearchPanels";

export function useSearchController({
  setMessage
}: {
  setMessage: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [searchTag, setSearchTag] = useState("");
  const [searchDomainGroup, setSearchDomainGroupState] = useState<SportsDomainGroup | "">("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [domainFilters, setDomainFilters] = useState<DomainSearchFilters>({});
  const [trustFilters, setTrustFilters] = useState<SearchTrustFilters>(TRUST_PRESETS.balanced);
  const [useKnowledgeLayer, setUseKnowledgeLayer] = useState(true);
  const [queryPlan, setQueryPlan] = useState<DomainQueryPlan | null>(null);
  const [orchestrationPlan, setOrchestrationPlan] = useState<OrchestrationPlan | null>(null);
  const [sportsAnswer, setSportsAnswer] = useState<SportsKnowledgeAnswer | null>(null);
  const [askResponse, setAskResponse] = useState<AskResponse | null>(null);
  const [searchConversation, setSearchConversation] = useState<SearchConversationTurn[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const filteredSearchResults = useMemo(() => filterSearchResultsByTrust(searchResults, trustFilters), [searchResults, trustFilters]);
  const activeSearchFilterCount =
    Object.values(domainFilters).filter(Boolean).length +
    (searchTag ? 1 : 0) +
    (trustPresetFor(trustFilters) === "balanced" ? 0 : 1) +
    (useKnowledgeLayer ? 0 : 1);

  function setSearchDomainGroup(domainGroup: SportsDomainGroup | "") {
    setSearchDomainGroupState(domainGroup);
    setDomainFilters((current) => sanitizeFiltersForDomain(current, domainGroup));
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const submittedQuery = query.trim();
    if (!submittedQuery && !searchTag && !Object.values(domainFilters).some(Boolean)) return;
    setSearching(true);
    setMessage("");
    setSportsAnswer(null);
    setAskResponse(null);
    try {
      const started = await api.post<AskResponse>("/api/ask", {
        q: submittedQuery,
        domainGroup: searchDomainGroup || undefined,
        tag: searchTag || undefined,
        domainFilters,
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
    searchTag,
    setSearchTag,
    searchDomainGroup,
    setSearchDomainGroup,
    filtersOpen,
    setFiltersOpen,
    domainFilters,
    setDomainFilters,
    trustFilters,
    setTrustFilters,
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
    activeSearchFilterCount,
    runSearch,
    buildAssetMomentUrl
  };
}

function sanitizeFiltersForDomain(filters: DomainSearchFilters, domainGroup: SportsDomainGroup | ""): DomainSearchFilters {
  const next: DomainSearchFilters = { ...filters };
  if (!domainGroup) {
    delete next.eventType;
    delete next.passType;
    delete next.fieldZone;
    delete next.role;
    return compactFilters(next);
  }
  if (domainGroup === "sports.american_football") {
    if (next.competition && next.competition !== "NFL") delete next.competition;
    if (next.eventType && !["scramble", "pressure", "pocket_escape", "throw_on_run"].includes(next.eventType)) delete next.eventType;
    delete next.passType;
    delete next.fieldZone;
    delete next.role;
  }
  if (domainGroup === "sports.football") {
    if (next.competition === "NFL") delete next.competition;
    if (next.eventType && !["pass_receive", "shot", "dribble"].includes(next.eventType)) delete next.eventType;
  }
  return compactFilters(next);
}

function compactFilters(filters: DomainSearchFilters): DomainSearchFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => typeof value === "string" && value.trim().length > 0)
  ) as DomainSearchFilters;
}
