import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import type { AskOperation, AssetRecord, DomainQueryPlan, IndexRecord, KnowledgeSourceId, OrchestrationPlan, SearchResult, StructuredKnowledgeAnswer } from "../../shared/types";
import { formatKnowledgeSourceLabel } from "../../shared/knowledgeSources";
import type { SearchKnowledgeContext, SearchScopeMode } from "../consoleTypes";
import {
  buildEvidenceLedger,
  filterSearchResultsByTrust,
  labelForTrustPreset,
  trustPresetFor,
  type SearchTrustFilters
} from "../searchTrust";
import { ClipStrip, KnowledgeEvidenceRow, SearchSceneEvidence, TrustBadge } from "./evidence/EvidenceComponents";

export type SearchConversationTurn = {
  id: string;
  query: string;
  answer: string;
  route: "structured_answer" | "moment_retrieval" | "empty" | "error";
  knowledgeAnswer: StructuredKnowledgeAnswer | null;
  results: SearchResult[];
  plan: DomainQueryPlan | null;
  operation: AskOperation | null;
  orchestrationPlan: OrchestrationPlan | null;
};

type MomentOpenOptions = {
  start?: number;
  end?: number;
  label?: string;
};

export function SearchScopeSelector({
  mode,
  onModeChange,
  indexes,
  assets,
  indexId,
  onIndexChange,
  assetId,
  onAssetChange
}: {
  mode: SearchScopeMode;
  onModeChange: (mode: SearchScopeMode) => void;
  indexes: IndexRecord[];
  assets: AssetRecord[];
  indexId: string;
  onIndexChange: (indexId: string) => void;
  assetId: string;
  onAssetChange: (assetId: string) => void;
}) {
  const selectedIndex = indexes.find((index) => index.id === indexId) ?? null;
  const selectedAsset = assets.find((asset) => asset.id === assetId) ?? null;
  const selectedAssetIndex = selectedAsset ? indexes.find((index) => index.id === selectedAsset.indexId) ?? null : null;
  const groupAssetCount = selectedIndex ? assets.filter((asset) => asset.indexId === selectedIndex.id).length : 0;
  const groupDomain = describeIndexDomain(selectedIndex);
  const allVideoDomain = describeAllVideoDomains(indexes, assets);
  const selectedVideoDomain = describeIndexDomain(selectedAssetIndex);
  const videoDomain = mode === "asset" ? selectedVideoDomain : allVideoDomain;
  const assetGroups = indexes
    .map((index) => ({ index, assets: assets.filter((asset) => asset.indexId === index.id) }))
    .filter((group) => group.assets.length > 0);
  const ungroupedAssets = assets.filter((asset) => !indexes.some((index) => index.id === asset.indexId));
  return (
    <div className="search-scope-control" aria-label="Search scope">
      <div className="search-scope-intents">
        <section className={`search-scope-intent ${mode === "group" ? "active" : ""}`}>
          <button
            type="button"
            className="scope-intent-button"
            disabled={indexes.length === 0}
            onClick={() => onModeChange("group")}
          >
            <strong>Asset group search</strong>
            <span>{selectedIndex ? `${selectedIndex.name} · ${groupAssetCount} videos` : "Select asset group"}</span>
            <em className={groupDomain.tone}>{groupDomain.label}</em>
          </button>
          {mode === "group" && (
            <label className="search-scope-picker">
              <span>Asset group</span>
              <select value={indexId} onChange={(event) => onIndexChange(event.target.value)} disabled={indexes.length === 0}>
                <option value="">Select an asset group</option>
                {indexes.map((index) => (
                  <option key={index.id} value={index.id}>{index.name}</option>
                ))}
              </select>
            </label>
          )}
        </section>
        <section className={`search-scope-intent video ${mode !== "group" ? "active" : ""}`}>
          <div className="scope-intent-heading">
            <div>
              <strong>Video search</strong>
              <span>{mode === "asset" && selectedAsset ? selectedAsset.title : `${assets.length} videos`}</span>
            </div>
            <em className={videoDomain.tone}>{videoDomain.label}</em>
          </div>
          <div className="scope-video-switch">
            <button type="button" className={mode === "all" ? "active" : ""} onClick={() => onModeChange("all")}>
              <strong>All videos</strong>
              <span>{assets.length} videos</span>
            </button>
            <button type="button" className={mode === "asset" ? "active" : ""} onClick={() => onModeChange("asset")} disabled={assets.length === 0}>
              <strong>Specific video</strong>
              <span>{selectedAsset ? selectedAsset.title : "Select video"}</span>
            </button>
          </div>
          {mode === "asset" && (
            <label className="search-scope-picker">
              <span>Video</span>
              <select value={assetId} onChange={(event) => onAssetChange(event.target.value)} disabled={assets.length === 0}>
                <option value="">Select a video</option>
                {assetGroups.map((group) => (
                  <optgroup key={group.index.id} label={group.index.name}>
                    {group.assets.map((asset) => (
                      <option key={asset.id} value={asset.id}>{asset.title}</option>
                    ))}
                  </optgroup>
                ))}
                {ungroupedAssets.length > 0 && (
                  <optgroup label="Ungrouped">
                    {ungroupedAssets.map((asset) => (
                      <option key={asset.id} value={asset.id}>{asset.title}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
          )}
        </section>
      </div>
    </div>
  );
}

export function SearchScopeSummary({
  scopeLabel,
  trustFilters,
  useKnowledgeLayer,
  knowledgeContext,
  onTargetClick,
  targetExpanded = false
}: {
  scopeLabel: string;
  trustFilters: SearchTrustFilters;
  useKnowledgeLayer: boolean;
  knowledgeContext: SearchKnowledgeContext;
  onTargetClick?: () => void;
  targetExpanded?: boolean;
}) {
  const targetContent = (
    <>
      <b>Target</b>
      {compactLabel(scopeLabel)}
    </>
  );
  return (
    <div className="search-scope-summary" aria-label="Current search scope">
      {onTargetClick ? (
        <button type="button" className="search-scope-chip target" aria-expanded={targetExpanded} onClick={onTargetClick}>
          {targetContent}
        </button>
      ) : (
        <span>{targetContent}</span>
      )}
      <span><b>Evidence</b>{labelForTrustPreset(trustPresetFor(trustFilters))}</span>
      <span className={knowledgeContext.tone}><b>Knowledge</b>{compactLabel(useKnowledgeLayer ? knowledgeContext.detail : knowledgeContext.label)}</span>
    </div>
  );
}

function compactLabel(value: string) {
  return value.length > 56 ? `${value.slice(0, 53)}...` : value;
}

function describeIndexDomain(index: IndexRecord | null): { label: string; tone: SearchKnowledgeContext["tone"] } {
  if (!index) return { label: "No target", tone: "off" };
  if (!index.domainIndexing?.enabled) return { label: "Video-only", tone: "off" };
  return { label: formatDomainGroups(index.domainIndexing.groups), tone: "domain" };
}

function describeAllVideoDomains(indexes: IndexRecord[], assets: AssetRecord[]): { label: string; tone: SearchKnowledgeContext["tone"] } {
  const assetIndexIds = new Set(assets.map((asset) => asset.indexId).filter(Boolean));
  const scopedIndexes = indexes.filter((index) => assetIndexIds.has(index.id));
  const domainIndexes = scopedIndexes.filter((index) => index.domainIndexing?.enabled);
  if (domainIndexes.length === 0) return { label: "Video-only", tone: "off" };
  if (domainIndexes.length === scopedIndexes.length) return { label: formatDomainGroups(uniqueDomainGroups(domainIndexes)), tone: "domain" };
  return { label: "Mixed knowledge", tone: "mixed" };
}

function uniqueDomainGroups(indexes: IndexRecord[]) {
  return Array.from(new Set(indexes.flatMap((index) => index.domainIndexing?.groups ?? [])));
}

function formatDomainGroups(groups: KnowledgeSourceId[]) {
  if (groups.length === 0) return "Knowledge-bound";
  return groups.map(formatKnowledgeSourceLabel).join(", ");
}

export function ResultTrustSummary({ total, visible, trustFilters }: { total: number; visible: number; trustFilters: SearchTrustFilters }) {
  if (total === 0) return null;
  return (
    <div className="result-trust-summary">
      <span>{visible}/{total} results</span>
      <span>{labelForTrustPreset(trustPresetFor(trustFilters))} evidence</span>
    </div>
  );
}

export function KnowledgeAnswerCard({ answer }: { answer: StructuredKnowledgeAnswer }) {
  return (
    <section className={`knowledge-answer-card ${answer.status}`}>
      <div>
        <span>Knowledge answer</span>
        <strong>{answer.answer}</strong>
        {answer.fallback && <p>{answer.fallback}</p>}
      </div>
      <div className="knowledge-answer-meta">
        {answer.subject.player && <span>Player {answer.subject.player}</span>}
        {answer.subject.competition && <span>Competition {answer.subject.competition}</span>}
        {answer.subject.season && <span>Season {answer.subject.season}</span>}
        {answer.subject.metric && <span>Metric {answer.subject.metric}</span>}
        <span>Confidence {Math.round(answer.confidence * 100)}%</span>
      </div>
      {answer.evidence.length > 0 && (
        <div className="knowledge-answer-evidence">
          {answer.evidence.slice(0, 3).map((item) => (
            <span key={`${item.provider}-${item.season}-${item.team}-${item.sourceText}`}>
              <b>{item.provider}</b>
              {item.sourceText}
            </span>
          ))}
        </div>
      )}
      {answer.warnings.length > 0 && <p className="knowledge-answer-warning">{answer.warnings.slice(0, 3).join(" ")}</p>}
    </section>
  );
}

type WorkflowItemStatus = AskOperation["steps"][number]["status"] | OrchestrationPlan["steps"][number]["status"];

type WorkflowItem = {
  id: string;
  owner: AskOperation["steps"][number]["owner"];
  title: string;
  summary: string;
  detail?: string;
  status: WorkflowItemStatus;
  durationMs?: number | null;
  chips: Array<{ label: string; value: string }>;
};

export function SearchWorkflowTrace({
  operation,
  queryPlan,
  orchestrationPlan,
  totalResults,
  visibleResults
}: {
  operation: AskOperation | null;
  queryPlan: DomainQueryPlan | null;
  orchestrationPlan: OrchestrationPlan | null;
  totalResults: number;
  visibleResults: number;
}) {
  const [isExpanded, setIsExpanded] = useState(() => operation?.status === "queued" || operation?.status === "running" || operation?.status === "failed");

  useEffect(() => {
    if (operation?.status === "queued" || operation?.status === "running" || operation?.status === "failed") {
      setIsExpanded(true);
    }
  }, [operation?.id, operation?.status]);

  if (!operation && !queryPlan && !orchestrationPlan) return null;
  const items = buildWorkflowItems(operation, queryPlan, orchestrationPlan, totalResults, visibleResults);
  const route = operation?.route === "pending"
    ? "running"
    : queryPlan
      ? `${queryPlan.route.replace(/_/g, " ")} · ${queryPlan.responseMode.replace(/_/g, " ")}`
      : operation?.route.replace(/_/g, " ") ?? "search";
  const summaryChips = buildWorkflowSummaryChips(operation, queryPlan, orchestrationPlan, totalResults, visibleResults, items.length);

  return (
    <section className={`search-workflow ${operation?.status ?? "succeeded"} ${isExpanded ? "expanded" : "collapsed"}`} aria-label="Search workflow">
      <div className="search-workflow-header">
        <div>
          <span>Search workflow</span>
          <strong>{route}</strong>
          <p>{queryPlan?.rewrittenQuery ?? operation?.query ?? orchestrationPlan?.query}</p>
        </div>
        <div className="search-workflow-actions">
          {operation && <em>{operation.id.slice(0, 8)} · {operation.status}</em>}
          <button type="button" className="workflow-collapse-button" aria-expanded={isExpanded} onClick={() => setIsExpanded((current) => !current)}>
            {isExpanded ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isExpanded ? (
        <>
          <div className="search-workflow-meta">
            {queryPlan && (
              <span>
                <b>plan</b>
                {Math.round(queryPlan.confidence * 100)}%
              </span>
            )}
            {orchestrationPlan && (
              <span>
                <b>engine</b>
                {orchestrationPlan.retrieval.engine.replace(/_/g, " ")}
              </span>
            )}
            {totalResults > 0 && (
              <span>
                <b>results</b>
                {visibleResults}/{totalResults}
              </span>
            )}
          </div>
          <div className="search-workflow-flow">
            {items.map((item, index) => (
              <article key={item.id} className={`workflow-step ${item.status}`}>
                <div className="workflow-step-marker" aria-hidden="true">
                  {index + 1}
                </div>
                <div className="workflow-step-card">
                  <div className="workflow-step-heading">
                    <div>
                      <span>{ownerLabel(item.owner)}</span>
                      <strong>{item.title}</strong>
                    </div>
                    <em>
                      {formatWorkflowStatus(item.status)}
                      {typeof item.durationMs === "number" ? ` · ${item.durationMs}ms` : ""}
                    </em>
                  </div>
                  <p>{item.summary}</p>
                  {item.chips.length > 0 && (
                    <div className="workflow-chip-row">
                      {item.chips.map((chip) => (
                        <span key={`${item.id}-${chip.label}-${chip.value}`}>
                          <b>{chip.label}</b>
                          {chip.value}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.detail && <small>{item.detail}</small>}
                </div>
              </article>
            ))}
          </div>
          {operation?.error && <p className="ask-trace-error">{operation.error}</p>}
        </>
      ) : (
        <div className="search-workflow-compact" aria-label="Collapsed workflow summary">
          {summaryChips.map((chip) => (
            <span key={`${chip.label}-${chip.value}`}>
              <b>{chip.label}</b>
              {chip.value}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function SearchConversation({
  turns,
  trustFilters,
  getMomentHref,
  activeMoment,
  onOpenMoment
}: {
  turns: SearchConversationTurn[];
  trustFilters: SearchTrustFilters;
  getMomentHref: (assetId: string, segmentId?: string | null, at?: number | null) => string;
  activeMoment?: { assetId: string; segmentId: string | null } | null;
  onOpenMoment?: (asset: AssetRecord, segment: AssetRecord["timeline"][number], options?: MomentOpenOptions) => void;
}) {
  const [expandedResultTurns, setExpandedResultTurns] = useState<Record<string, boolean>>({});
  if (turns.length === 0) return null;
  const latestResultTurnId = [...turns].reverse().find((turn) => turn.results.length > 0 && !isSearchTurnRunning(turn))?.id ?? null;
  return (
    <section className="assistant-thread" aria-label="Search conversation">
      {turns.map((turn) => {
        const running = isSearchTurnRunning(turn);
        const visibleResults = filterSearchResultsByTrust(turn.results, trustFilters);
        const resultSectionExpanded = expandedResultTurns[turn.id] ?? turn.id === latestResultTurnId;
        return (
          <article key={turn.id} className="assistant-turn">
            <div className="user-bubble">
              <span>You</span>
              <p>{turn.query}</p>
            </div>
            <div className={`assistant-bubble ${turn.route} ${turn.results.length > 0 ? "has-results" : ""}`}>
              <span>{turn.route === "structured_answer" ? "Knowledge answer" : turn.route === "error" ? "Error" : "Video answer"}</span>
              {turn.answer && !running && <p>{turn.answer}</p>}
              {running && (
                <div className="assistant-search-status" aria-live="polite">
                  <div>
                    <strong>Searching indexed moments</strong>
                    <span>Planning query filters, matching vectors, and ranking evidence.</span>
                  </div>
                  <span className="search-loading-bar" />
                </div>
              )}
              {turn.plan && (
                <em>
                  {turn.plan.rewrittenQuery} · confidence {Math.round(turn.plan.confidence * 100)}%
                </em>
              )}
              {turn.knowledgeAnswer?.fallback && <em>{turn.knowledgeAnswer.fallback}</em>}
              {turn.knowledgeAnswer && <KnowledgeAnswerCard answer={turn.knowledgeAnswer} />}
              <SearchWorkflowTrace
                operation={turn.operation}
                queryPlan={turn.plan}
                orchestrationPlan={turn.orchestrationPlan}
                totalResults={turn.results.length}
                visibleResults={visibleResults.length}
              />
              {turn.results.length > 0 && (
                <AssistantResultDisclosure
                  turn={turn}
                  results={visibleResults}
                  totalResults={turn.results.length}
                  trustFilters={trustFilters}
                  expanded={resultSectionExpanded}
                  onToggle={() => setExpandedResultTurns((current) => ({ ...current, [turn.id]: !resultSectionExpanded }))}
                  getMomentHref={getMomentHref}
                  activeMoment={activeMoment}
                  onOpenMoment={onOpenMoment}
                />
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function isSearchTurnRunning(turn: SearchConversationTurn) {
  return turn.operation?.status === "queued" || turn.operation?.status === "running" || (!turn.operation && turn.answer === "Searching indexed moments.");
}

function AssistantResultDisclosure({
  turn,
  results,
  totalResults,
  trustFilters,
  expanded,
  onToggle,
  getMomentHref,
  activeMoment,
  onOpenMoment
}: {
  turn: SearchConversationTurn;
  results: SearchResult[];
  totalResults: number;
  trustFilters: SearchTrustFilters;
  expanded: boolean;
  onToggle: () => void;
  getMomentHref: (assetId: string, segmentId?: string | null, at?: number | null) => string;
  activeMoment?: { assetId: string; segmentId: string | null } | null;
  onOpenMoment?: (asset: AssetRecord, segment: AssetRecord["timeline"][number], options?: MomentOpenOptions) => void;
}) {
  const visibleMomentCount = results.reduce((sum, result) => sum + Math.min(result.segments.length, 3), 0);
  const totalMomentCount = turn.results.reduce((sum, result) => sum + Math.min(result.segments.length, 3), 0);
  const summary = `${results.length}/${totalResults} assets · ${visibleMomentCount}/${totalMomentCount} key moments`;
  return (
    <section className={`assistant-results ${expanded ? "expanded" : "collapsed"}`} aria-label="Search result evidence">
      <div className="assistant-results-header">
        <div>
          <span>Visual search results</span>
          <strong>{summary}</strong>
        </div>
        <button type="button" className="assistant-results-toggle" aria-expanded={expanded} onClick={onToggle}>
          <ChevronDown size={14} aria-hidden="true" />
          {expanded ? "Hide" : "Show"}
        </button>
      </div>
      {expanded && (
        <>
          <ResultTrustSummary total={totalResults} visible={results.length} trustFilters={trustFilters} />
          {results.length > 0 ? (
            <div className="assistant-result-list">
              {results.map((result) => (
                <AssistantResultCard
                  key={result.asset.id}
                  result={result}
                  query={turn.plan?.semanticQuery ?? turn.query}
                  getMomentHref={getMomentHref}
                  activeMoment={activeMoment}
                  onOpenMoment={onOpenMoment}
                />
              ))}
            </div>
          ) : (
            <p className="assistant-results-empty">No results passed the evidence threshold. Try a more specific query.</p>
          )}
        </>
      )}
    </section>
  );
}

function AssistantResultCard({
  result,
  query,
  getMomentHref,
  activeMoment,
  onOpenMoment
}: {
  result: SearchResult;
  query: string;
  getMomentHref: (assetId: string, segmentId?: string | null, at?: number | null) => string;
  activeMoment?: { assetId: string; segmentId: string | null } | null;
  onOpenMoment?: (asset: AssetRecord, segment: AssetRecord["timeline"][number], options?: MomentOpenOptions) => void;
}) {
  const ledger = buildEvidenceLedger(result.verification, result.matchReasons, result.segments);
  return (
    <article className="result-card assistant-result-card">
      <div className="result-card-header">
        <div>
          <strong>{result.asset.title}</strong>
          <span>
            Relevance {Math.round(result.score)} · {Math.min(result.segments.length, 3)} key moments · {result.index?.name ?? "Unknown index"}
          </span>
        </div>
        <TrustBadge ledger={ledger} />
      </div>
      {result.explain.some((item) => item.includes("mentioned players:")) && (
        <span className="result-summary-row">
          {result.explain
            .filter((item) => item.includes("mentioned players:"))
            .map((item) => (
              <em key={item}>{item}</em>
            ))}
        </span>
      )}
      {result.knowledgeEvidence.length > 0 && <KnowledgeEvidenceRow evidence={result.knowledgeEvidence} />}
      {result.segments.slice(0, 3).map((segment) => (
        <SearchResultSegment
          key={segment.id}
          result={result}
          segment={segment}
          query={query}
          getMomentHref={getMomentHref}
          active={activeMoment?.assetId === result.asset.id && activeMoment.segmentId === segment.id}
          onOpenMoment={onOpenMoment}
        />
      ))}
      {result.clips.length > 0 && (
        <ClipStrip
          clips={result.clips}
          onOpen={
            onOpenMoment
              ? async (clip) => {
                  const segment = result.asset.timeline.find((item) => item.id === clip.segmentId) ?? result.segments.find((item) => item.id === clip.segmentId);
                  if (segment) onOpenMoment(result.asset, segment, { start: clip.start, end: clip.end, label: clip.title });
                }
              : undefined
          }
          getHref={onOpenMoment ? undefined : (clip) => getMomentHref(clip.assetId, clip.segmentId, clip.start)}
        />
      )}
    </article>
  );
}

function SearchResultSegment({
  result,
  segment,
  query,
  getMomentHref,
  active,
  onOpenMoment
}: {
  result: SearchResult;
  segment: AssetRecord["timeline"][number];
  query: string;
  getMomentHref: (assetId: string, segmentId?: string | null, at?: number | null) => string;
  active: boolean;
  onOpenMoment?: (asset: AssetRecord, segment: AssetRecord["timeline"][number], options?: MomentOpenOptions) => void;
}) {
  const content = (
    <SearchSceneEvidence
      segment={segment}
      query={query}
      reasons={result.matchReasons.filter((reason) => reason.segmentId === segment.id)}
      verification={result.verification.filter((check) => check.segmentId === segment.id)}
    />
  );
  const className = `result-segment ${active ? "active" : ""}`;
  if (onOpenMoment) {
    return (
      <button type="button" className={className} onClick={() => onOpenMoment(result.asset, segment)}>
        {content}
      </button>
    );
  }
  return (
    <a className={className} href={getMomentHref(result.asset.id, segment.id, segment.start)} target="_blank" rel="noreferrer">
      {content}
    </a>
  );
}

function buildWorkflowSummaryChips(
  operation: AskOperation | null,
  queryPlan: DomainQueryPlan | null,
  orchestrationPlan: OrchestrationPlan | null,
  totalResults: number,
  visibleResults: number,
  itemCount: number
) {
  return [
    { label: "steps", value: String(itemCount) },
    operation ? { label: "status", value: formatWorkflowStatus(operation.status) } : null,
    queryPlan ? { label: "route", value: queryPlan.route.replace(/_/g, " ") } : null,
    queryPlan ? { label: "answer", value: queryPlan.responseMode.replace(/_/g, " ") } : null,
    queryPlan ? { label: "knowledge", value: queryPlan.knowledgeMode.replace(/_/g, " ") } : null,
    queryPlan ? { label: "plan", value: `${Math.round(queryPlan.confidence * 100)}%` } : null,
    orchestrationPlan ? { label: "engine", value: orchestrationPlan.retrieval.engine.replace(/_/g, " ") } : null,
    totalResults > 0 ? { label: "results", value: `${visibleResults}/${totalResults}` } : null
  ].filter(Boolean) as Array<{ label: string; value: string }>;
}

function buildWorkflowItems(
  operation: AskOperation | null,
  queryPlan: DomainQueryPlan | null,
  orchestrationPlan: OrchestrationPlan | null,
  totalResults: number,
  visibleResults: number
): WorkflowItem[] {
  const operationSteps = operation?.steps ?? [];
  const stepById = new Map(operationSteps.map((step) => [step.id, step]));
  const items: WorkflowItem[] = [];
  const planStep = stepById.get("plan");

  if (queryPlan || planStep) {
    items.push(buildQueryPlanWorkflowItem(queryPlan, planStep));
  }

  const orderedStepIds = ["scope", "knowledge_answer", "orchestrate", "ground", "embed_query", "vector_search", "knowledge_vector_search", "rank", "retrieve", "analysis"];
  for (const stepId of orderedStepIds) {
    const step = stepById.get(stepId);
    if (!step && stepId !== "orchestrate") continue;
    if (stepId === "orchestrate") {
      if (step || orchestrationPlan) items.push(buildOrchestrationWorkflowItem(orchestrationPlan, step));
      continue;
    }
    if (!step) continue;
    items.push(buildOperationWorkflowItem(step, stepId === "rank" ? resultChips(totalResults, visibleResults) : []));
  }

  const knownIds = new Set(["plan", ...orderedStepIds]);
  for (const step of operationSteps) {
    if (!knownIds.has(step.id)) items.push(buildOperationWorkflowItem(step));
  }

  if (items.length === 0) {
    items.push({
      id: "queued",
      owner: "platform",
      title: "Queued",
      summary: "Waiting for the server to start the search workflow.",
      status: "queued",
      chips: []
    });
  }

  return items;
}

function buildQueryPlanWorkflowItem(queryPlan: DomainQueryPlan | null, step: AskOperation["steps"][number] | undefined): WorkflowItem {
  const filterEntries = Object.entries(queryPlan?.domainFilters ?? {}).filter(([, value]) => Boolean(value));
  const intentChips = [
    queryPlan?.route ? { label: "route", value: queryPlan.route.replace(/_/g, " ") } : null,
    queryPlan?.responseMode ? { label: "answer", value: queryPlan.responseMode.replace(/_/g, " ") } : null,
    queryPlan?.knowledgeMode ? { label: "knowledge", value: queryPlan.knowledgeMode.replace(/_/g, " ") } : null,
    queryPlan?.intent.eventType ? { label: "event", value: queryPlan.intent.eventType } : null,
    queryPlan?.intent.passType ? { label: "pass", value: queryPlan.intent.passType } : null,
    queryPlan?.intent.fieldZone ? { label: "zone", value: queryPlan.intent.fieldZone } : null
  ].filter(Boolean) as Array<{ label: string; value: string }>;
  const chips = [
    ...filterEntries.map(([key, value]) => ({ label: key, value: String(value) })),
    ...intentChips,
    queryPlan ? { label: "confidence", value: `${Math.round(queryPlan.confidence * 100)}%` } : null,
    queryPlan?.planner ? { label: "planner", value: `${queryPlan.planner.source}${queryPlan.planner.model ? ` · ${queryPlan.planner.model}` : ""}` } : null
  ].filter(Boolean) as Array<{ label: string; value: string }>;
  const semanticDetail = queryPlan?.semanticQuery && queryPlan.semanticQuery !== queryPlan.rewrittenQuery ? `Semantic query: ${queryPlan.semanticQuery}.` : "";
  const warnings = queryPlan?.warnings.length ? queryPlan.warnings.slice(0, 2).join(" ") : "";
  return {
    id: "query-plan",
    owner: step?.owner ?? "router",
    title: "Query plan",
    summary: queryPlan?.rewrittenQuery ?? step?.output ?? step?.input ?? "Preparing a structured search plan.",
    detail: [semanticDetail, warnings || step?.input].filter(Boolean).join(" "),
    status: step?.status ?? (queryPlan ? "succeeded" : "queued"),
    durationMs: step?.durationMs,
    chips
  };
}

function buildOrchestrationWorkflowItem(orchestrationPlan: OrchestrationPlan | null, step: AskOperation["steps"][number] | undefined): WorkflowItem {
  const decisionChips = orchestrationPlan?.decisions.slice(0, 4).map((decision) => ({
    label: decision.label,
    value: `${decision.value} · ${Math.round(decision.confidence * 100)}%`
  })) ?? [];
  const chips = [
    orchestrationPlan ? { label: "mode", value: orchestrationPlan.mode.replace(/_/g, " ") } : null,
    orchestrationPlan ? { label: "engine", value: orchestrationPlan.retrieval.engine.replace(/_/g, " ") } : null,
    orchestrationPlan ? { label: "confidence", value: `${Math.round(orchestrationPlan.confidence * 100)}%` } : null,
    ...decisionChips
  ].filter(Boolean) as Array<{ label: string; value: string }>;
  const detail = orchestrationPlan?.steps
    .slice(0, 4)
    .map((planStep) => `${ownerLabel(planStep.owner)}: ${planStep.action} -> ${planStep.output}`)
    .join(" · ");
  return {
    id: "orchestrate",
    owner: step?.owner ?? "router",
    title: "Query orchestration",
    summary: orchestrationPlan
      ? `${orchestrationPlan.mode.replace(/_/g, " ")} workflow using ${orchestrationPlan.retrieval.engine.replace(/_/g, " ")}`
      : step?.output ?? "Choosing the search and analysis path.",
    detail: detail || step?.input,
    status: step?.status ?? (orchestrationPlan ? "succeeded" : "queued"),
    durationMs: step?.durationMs,
    chips
  };
}

function buildOperationWorkflowItem(step: AskOperation["steps"][number], chips: Array<{ label: string; value: string }> = []): WorkflowItem {
  return {
    id: step.id,
    owner: step.owner,
    title: step.label,
    summary: step.output || step.input || "Waiting for this workflow step.",
    detail: step.output && step.input && step.output !== step.input ? `Input: ${step.input}` : undefined,
    status: step.status,
    durationMs: step.durationMs,
    chips
  };
}

function resultChips(totalResults: number, visibleResults: number) {
  return totalResults > 0
    ? [
        {
          label: "visible",
          value: `${visibleResults}/${totalResults}`
        }
      ]
    : [];
}

function ownerLabel(owner: AskOperation["steps"][number]["owner"]) {
  const labels: Record<AskOperation["steps"][number]["owner"], string> = {
    router: "Router",
    knowledge: "Knowledge",
    retrieval: "Retrieval",
    analysis: "Analysis",
    platform: "Platform"
  };
  return labels[owner];
}

function formatWorkflowStatus(status: WorkflowItemStatus) {
  return status.replace(/_/g, " ");
}
