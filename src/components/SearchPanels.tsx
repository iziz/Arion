import type { Dispatch, SetStateAction } from "react";
import type { AskOperation, AssetRecord, DomainQueryPlan, DomainSearchFilters, OrchestrationPlan, SearchResult, SportsDomainGroup, SportsKnowledgeAnswer } from "../../shared/types";
import {
  buildEvidenceLedger,
  labelForTrustPreset,
  trustPresetFor,
  TRUST_PRESETS,
  type SearchTrustFilters,
  type TrustPreset
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

export function SearchDomainSelector({
  value,
  onChange
}: {
  value: SportsDomainGroup | "";
  onChange: (domainGroup: SportsDomainGroup | "") => void;
}) {
  const options: Array<{ value: SportsDomainGroup | ""; label: string; detail: string }> = [
    { value: "", label: "All", detail: "all indexed domains" },
    { value: "sports.football", label: "Football", detail: "goals, passes, zones" },
    { value: "sports.american_football", label: "American football", detail: "QB, pressure, pocket" }
  ];
  return (
    <div className="search-domain-selector" aria-label="Search domain">
      {options.map((option) => (
        <button
          key={option.value || "all"}
          type="button"
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          <strong>{option.label}</strong>
          <span>{option.detail}</span>
        </button>
      ))}
    </div>
  );
}

export function SearchScopeSummary({
  domainGroup,
  tag,
  domainFilters,
  trustFilters,
  useKnowledgeLayer
}: {
  domainGroup: SportsDomainGroup | "";
  tag: string;
  domainFilters: DomainSearchFilters;
  trustFilters: SearchTrustFilters;
  useKnowledgeLayer: boolean;
}) {
  const entries = Object.entries(domainFilters).filter(([, value]) => Boolean(value));
  return (
    <div className="search-scope-summary" aria-label="Current search scope">
      <span><b>Domain</b>{domainLabel(domainGroup)}</span>
      <span><b>Tag</b>{tag || "Any"}</span>
      <span><b>Evidence</b>{labelForTrustPreset(trustPresetFor(trustFilters))}</span>
      <span><b>Knowledge</b>{useKnowledgeLayer ? "On" : "Off"}</span>
      {entries.slice(0, 4).map(([key, value]) => (
        <span key={key}><b>{key}</b>{String(value)}</span>
      ))}
    </div>
  );
}

export function AdvancedSearchFilters({
  open,
  searchDomainGroup,
  filterTags,
  searchTag,
  setSearchTag,
  domainFilters,
  setDomainFilters,
  trustFilters,
  setTrustFilters,
  total,
  visible
}: {
  open: boolean;
  searchDomainGroup: SportsDomainGroup | "";
  filterTags: string[];
  searchTag: string;
  setSearchTag: Dispatch<SetStateAction<string>>;
  domainFilters: DomainSearchFilters;
  setDomainFilters: Dispatch<SetStateAction<DomainSearchFilters>>;
  trustFilters: SearchTrustFilters;
  setTrustFilters: Dispatch<SetStateAction<SearchTrustFilters>>;
  total: number;
  visible: number;
}) {
  if (!open) return null;
  return (
    <section className="advanced-search-panel" aria-label="Advanced search filters">
      <div className="advanced-search-header">
        <strong>Advanced filters</strong>
        <span>{domainLabel(searchDomainGroup)} · showing {visible}/{total} after evidence filters</span>
      </div>
      <div className="scope-filter-grid">
        <label>
          <span>Tag</span>
          <select value={searchTag} onChange={(event) => setSearchTag(event.target.value)}>
            <option value="">Any tag</option>
            {filterTags.map((tag) => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </select>
        </label>
      </div>
      <DomainSearchControls domainGroup={searchDomainGroup} filters={domainFilters} onChange={setDomainFilters} />
      <EvidencePresetControls filters={trustFilters} onChange={setTrustFilters} />
      <details className="advanced-evidence-details">
        <summary>Advanced evidence settings</summary>
        <TrustSearchControls filters={trustFilters} onChange={setTrustFilters} total={total} visible={visible} />
      </details>
    </section>
  );
}

export function DomainSearchControls({
  domainGroup,
  filters,
  onChange
}: {
  domainGroup: SportsDomainGroup | "";
  filters: DomainSearchFilters;
  onChange: Dispatch<SetStateAction<DomainSearchFilters>>;
}) {
  const updateFilter = (key: keyof DomainSearchFilters, value: string) => {
    onChange((current) => ({ ...current, [key]: value || undefined }));
  };
  const clearFilters = () => onChange({});
  return (
    <section className="domain-search-controls" aria-label="Domain event search filters">
      <div className="domain-search-header">
        <strong>Domain filters</strong>
      </div>
      <div className="domain-filter-grid">
        <input value={filters.competition ?? ""} onChange={(event) => updateFilter("competition", event.target.value)} placeholder={domainGroup === "sports.american_football" ? "Competition e.g. NFL" : "Competition e.g. Premier League"} />
        <input value={filters.season ?? ""} onChange={(event) => updateFilter("season", event.target.value)} placeholder="Season e.g. 2023-24" />
        <input value={filters.player ?? ""} onChange={(event) => updateFilter("player", event.target.value)} placeholder={domainGroup === "sports.american_football" ? "Player or QB" : "Player"} />
        {domainGroup === "sports.american_football" && (
          <select value={filters.eventType ?? ""} onChange={(event) => updateFilter("eventType", event.target.value)}>
            <option value="">Any play</option>
            <option value="scramble">Scramble</option>
            <option value="pressure">Pressure</option>
            <option value="pocket_escape">Pocket escape</option>
            <option value="throw_on_run">Throw on run</option>
          </select>
        )}
        {domainGroup === "sports.football" && (
          <>
            <select value={filters.eventType ?? ""} onChange={(event) => updateFilter("eventType", event.target.value)}>
              <option value="">Any event</option>
              <option value="pass_receive">Receive</option>
              <option value="shot">Shot</option>
              <option value="dribble">Dribble</option>
            </select>
            <select value={filters.passType ?? ""} onChange={(event) => updateFilter("passType", event.target.value)}>
              <option value="">Any pass</option>
              <option value="through_ball">Through ball</option>
              <option value="cross">Cross</option>
              <option value="cutback">Cutback</option>
              <option value="long_ball">Long ball</option>
              <option value="short_pass">Short pass</option>
            </select>
            <select value={filters.fieldZone ?? ""} onChange={(event) => updateFilter("fieldZone", event.target.value)}>
              <option value="">Any zone</option>
              <option value="final_third">Final third</option>
              <option value="penalty_area">Penalty area</option>
              <option value="middle_third">Middle third</option>
              <option value="defensive_third">Defensive third</option>
            </select>
            <select value={filters.role ?? ""} onChange={(event) => updateFilter("role", event.target.value)}>
              <option value="">Any role</option>
              <option value="receiver">Receiver</option>
              <option value="passer">Passer</option>
              <option value="shooter">Shooter</option>
            </select>
          </>
        )}
      </div>
      <div className="domain-filter-actions">
        <button type="button" className="small-button" onClick={clearFilters}>Clear filters</button>
      </div>
    </section>
  );
}

function domainLabel(domainGroup: SportsDomainGroup | "") {
  if (domainGroup === "sports.football") return "Football";
  if (domainGroup === "sports.american_football") return "American football";
  return "All domains";
}

export function EvidencePresetControls({
  filters,
  onChange
}: {
  filters: SearchTrustFilters;
  onChange: Dispatch<SetStateAction<SearchTrustFilters>>;
}) {
  const selected = trustPresetFor(filters);
  return (
    <section className="evidence-preset-controls" aria-label="Evidence quality preset">
      <div className="domain-search-header">
        <strong>Evidence mode</strong>
      </div>
      <div className="evidence-mode-control">
        {(["broad", "balanced", "strict"] as TrustPreset[]).map((preset) => (
          <button
            key={preset}
            type="button"
            className={selected === preset ? "active" : ""}
            onClick={() => onChange(TRUST_PRESETS[preset])}
          >
            {labelForTrustPreset(preset)}
          </button>
        ))}
      </div>
    </section>
  );
}

export function TrustSearchControls({
  filters,
  onChange,
  total,
  visible
}: {
  filters: SearchTrustFilters;
  onChange: Dispatch<SetStateAction<SearchTrustFilters>>;
  total: number;
  visible: number;
}) {
  const update = <Key extends keyof SearchTrustFilters>(key: Key, value: SearchTrustFilters[Key]) => {
    onChange((current) => ({ ...current, [key]: value }));
  };
  const reset = () =>
    onChange(TRUST_PRESETS.balanced);
  return (
    <section className="trust-search-controls" aria-label="Trust filters">
      <div className="domain-search-header">
        <strong>Trust filters</strong>
        <span>
          Showing {visible}/{total} results after evidence quality filters.
        </span>
      </div>
      <div className="trust-filter-grid">
        <label className="inline-toggle">
          <input type="checkbox" checked={filters.verifiedOnly} onChange={(event) => update("verifiedOnly", event.target.checked)} />
          <span>Verified only</span>
        </label>
        <label className="inline-toggle">
          <input type="checkbox" checked={filters.includeSoft} onChange={(event) => update("includeSoft", event.target.checked)} />
          <span>Include soft matches</span>
        </label>
        <label className="inline-toggle">
          <input type="checkbox" checked={filters.hideFailed} onChange={(event) => update("hideFailed", event.target.checked)} />
          <span>Hide failed evidence</span>
        </label>
        <label className="inline-toggle">
          <input type="checkbox" checked={filters.requireHardPlayer} onChange={(event) => update("requireHardPlayer", event.target.checked)} />
          <span>Hard player evidence</span>
        </label>
        <label className="inline-toggle">
          <input type="checkbox" checked={filters.requireHardFieldZone} onChange={(event) => update("requireHardFieldZone", event.target.checked)} />
          <span>Hard field zone</span>
        </label>
        <label className="trust-score-filter">
          <span>Minimum trust</span>
          <input type="range" min="0" max="100" step="5" value={filters.minScore} onChange={(event) => update("minScore", Number(event.target.value))} />
          <b>{filters.minScore}%</b>
        </label>
      </div>
      <div className="domain-filter-actions">
        <button type="button" className="small-button" onClick={() => update("minScore", 70)}>High trust preset</button>
        <button type="button" className="small-button" onClick={reset}>Reset trust filters</button>
      </div>
    </section>
  );
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
  if (!operation && !queryPlan && !orchestrationPlan) return null;
  const items = buildWorkflowItems(operation, queryPlan, orchestrationPlan, totalResults, visibleResults);
  const route = operation?.route === "pending" ? "running" : operation?.route.replace(/_/g, " ") ?? queryPlan?.intent.questionType?.replace(/_/g, " ") ?? "search";
  return (
    <section className={`search-workflow ${operation?.status ?? "succeeded"}`} aria-label="Search workflow">
      <div className="search-workflow-header">
        <div>
          <span>Search workflow</span>
          <strong>{route}</strong>
          <p>{queryPlan?.rewrittenQuery ?? operation?.query ?? orchestrationPlan?.query}</p>
        </div>
        {operation && <em>{operation.id.slice(0, 8)} · {operation.status}</em>}
      </div>
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
  onOpenMoment?: (asset: AssetRecord, segment: AssetRecord["timeline"][number]) => void;
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
                  const segment = result.segments[0];
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
                    <button key={result.asset.id} type="button" onClick={() => onOpenMoment(result.asset, segment)}>
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
    queryPlan?.intent.questionType ? { label: "intent", value: queryPlan.intent.questionType.replace(/_/g, " ") } : null,
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
