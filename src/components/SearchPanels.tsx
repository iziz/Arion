import { useEffect, useState } from "react";
import type { AskOperation, AssetRecord, DomainQueryPlan, OrchestrationPlan, SearchResult, SportsKnowledgeAnswer } from "../../shared/types";
import type { SearchScopeMode } from "../consoleTypes";
import {
  buildEvidenceLedger,
  labelForTrustPreset,
  trustPresetFor,
  type SearchTrustFilters
} from "../searchTrust";

export type SearchConversationTurn = {
  id: string;
  query: string;
  answer: string;
  route: "stat_qa" | "moment_retrieval" | "empty" | "error";
  sportsAnswer: SportsKnowledgeAnswer | null;
  results: SearchResult[];
  plan: DomainQueryPlan | null;
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
  indexes: Array<{ id: string; name: string }>;
  assets: AssetRecord[];
  indexId: string;
  onIndexChange: (indexId: string) => void;
  assetId: string;
  onAssetChange: (assetId: string) => void;
}) {
  const selectedIndex = indexes.find((index) => index.id === indexId) ?? null;
  const selectedAsset = assets.find((asset) => asset.id === assetId) ?? null;
  const groupAssetCount = selectedIndex ? assets.filter((asset) => asset.indexId === selectedIndex.id).length : 0;
  const assetGroups = indexes
    .map((index) => ({ index, assets: assets.filter((asset) => asset.indexId === index.id) }))
    .filter((group) => group.assets.length > 0);
  const ungroupedAssets = assets.filter((asset) => !indexes.some((index) => index.id === asset.indexId));
  const options: Array<{ mode: SearchScopeMode; label: string; detail: string; disabled?: boolean }> = [
    { mode: "all", label: "All videos", detail: `${assets.length} videos` },
    { mode: "group", label: "Asset group", detail: selectedIndex ? `${selectedIndex.name} · ${groupAssetCount} videos` : "Select asset group", disabled: indexes.length === 0 },
    { mode: "asset", label: "Video", detail: selectedAsset ? selectedAsset.title : "Select video", disabled: assets.length === 0 }
  ];
  return (
    <div className="search-scope-control" aria-label="Search scope">
      <div className="search-scope-selector">
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={mode === option.mode ? "active" : ""}
            disabled={option.disabled}
            onClick={() => onModeChange(option.mode)}
          >
            <strong>{option.label}</strong>
            <span>{option.detail}</span>
          </button>
        ))}
      </div>
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
    </div>
  );
}

export function SearchScopeSummary({
  scopeLabel,
  trustFilters,
  useKnowledgeLayer
}: {
  scopeLabel: string;
  trustFilters: SearchTrustFilters;
  useKnowledgeLayer: boolean;
}) {
  return (
    <div className="search-scope-summary" aria-label="Current search scope">
      <span><b>Scope</b>{compactLabel(scopeLabel)}</span>
      <span><b>Evidence</b>{labelForTrustPreset(trustPresetFor(trustFilters))}</span>
      <span><b>Knowledge</b>{useKnowledgeLayer ? "On" : "Off"}</span>
    </div>
  );
}

function compactLabel(value: string) {
  return value.length > 56 ? `${value.slice(0, 53)}...` : value;
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

export function SportsAnswerCard({ answer }: { answer: SportsKnowledgeAnswer }) {
  return (
    <section className={`sports-answer-card ${answer.status}`}>
      <div>
        <span>Knowledge answer</span>
        <strong>{answer.answer}</strong>
        {answer.fallback && <p>{answer.fallback}</p>}
      </div>
      <div className="sports-answer-meta">
        {answer.subject.player && <span>Player {answer.subject.player}</span>}
        {answer.subject.competition && <span>Competition {answer.subject.competition}</span>}
        {answer.subject.season && <span>Season {answer.subject.season}</span>}
        {answer.subject.metric && <span>Metric {answer.subject.metric}</span>}
        <span>Confidence {Math.round(answer.confidence * 100)}%</span>
      </div>
      {answer.evidence.length > 0 && (
        <div className="sports-answer-evidence">
          {answer.evidence.slice(0, 3).map((item) => (
            <span key={`${item.provider}-${item.season}-${item.team}-${item.sourceText}`}>
              <b>{item.provider}</b>
              {item.sourceText}
            </span>
          ))}
        </div>
      )}
      {answer.warnings.length > 0 && <p className="sports-answer-warning">{answer.warnings.slice(0, 3).join(" ")}</p>}
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
  const route = operation?.route === "pending" ? "running" : queryPlan?.route.replace(/_/g, " ") ?? operation?.route.replace(/_/g, " ") ?? "search";
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
  getMomentHref,
  onOpenMoment
}: {
  turns: SearchConversationTurn[];
  getMomentHref: (assetId: string, segmentId?: string | null, at?: number | null) => string;
  onOpenMoment?: (asset: AssetRecord, segment: AssetRecord["timeline"][number], options?: MomentOpenOptions) => void;
}) {
  if (turns.length === 0) return null;
  return (
    <section className="assistant-thread" aria-label="Search conversation">
      {turns.map((turn) => (
        <article key={turn.id} className="assistant-turn">
          <div className="user-bubble">
            <span>You</span>
            <p>{turn.query}</p>
          </div>
          <div className={`assistant-bubble ${turn.route}`}>
            <span>{turn.route === "stat_qa" ? "Knowledge answer" : turn.route === "error" ? "Error" : "Video answer"}</span>
            <p>{turn.answer}</p>
            {turn.plan && (
              <em>
                {turn.plan.rewrittenQuery} · confidence {Math.round(turn.plan.confidence * 100)}%
              </em>
            )}
            {turn.sportsAnswer?.fallback && <em>{turn.sportsAnswer.fallback}</em>}
            {turn.results.length > 0 && (
              <div className="assistant-result-strip">
                {turn.results.slice(0, 3).map((result) => {
                  const clip = result.clips[0];
                  const segment = clip
                    ? result.asset.timeline.find((item) => item.id === clip.segmentId) ?? result.segments.find((item) => item.id === clip.segmentId) ?? result.segments[0]
                    : result.segments[0];
                  const href = clip
                    ? getMomentHref(clip.assetId, clip.segmentId, clip.start)
                    : getMomentHref(result.asset.id, segment?.id ?? null, segment?.start ?? null);
                  const content = (
                    <>
                      <b>{result.asset.title}</b>
                      <span>
                        {result.segments.length} moments · trust {buildEvidenceLedger(result.verification, result.matchReasons, result.segments).score}%
                      </span>
                    </>
                  );
                  return onOpenMoment && segment ? (
                    <button
                      key={result.asset.id}
                      type="button"
                      onClick={() =>
                        onOpenMoment(
                          result.asset,
                          segment,
                          clip ? { start: clip.start, end: clip.end, label: clip.title } : undefined
                        )
                      }
                    >
                      {content}
                    </button>
                  ) : (
                    <a key={result.asset.id} href={href} target="_blank" rel="noreferrer">
                      {content}
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        </article>
      ))}
    </section>
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
