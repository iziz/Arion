import { BrainCircuit, FileVideo, Search } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { AskOperation, DomainQueryPlan, DomainSearchFilters, IndexRecord, OrchestrationPlan, SearchResult, SportsKnowledgeAnswer } from "../../shared/types";
import { truncateText } from "../displayUtils";
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

export function SearchPresetChips({ onPreset }: { onPreset: (preset: "haaland-through-ball" | "son-goals" | "strict-evidence" | "clear") => void }) {
  return (
    <div className="search-preset-chips" aria-label="Search presets">
      <button type="button" onClick={() => onPreset("haaland-through-ball")}>Haaland through ball</button>
      <button type="button" onClick={() => onPreset("son-goals")}>Son goals</button>
      <button type="button" onClick={() => onPreset("strict-evidence")}>Strict evidence</button>
      <button type="button" onClick={() => onPreset("clear")}>Clear</button>
    </div>
  );
}

export function SearchScopeSummary({
  index,
  tag,
  modality,
  domainFilters,
  trustFilters
}: {
  index: IndexRecord | null;
  tag: string;
  modality: string;
  domainFilters: DomainSearchFilters;
  trustFilters: SearchTrustFilters;
}) {
  const entries = Object.entries(domainFilters).filter(([, value]) => Boolean(value));
  return (
    <div className="search-scope-summary" aria-label="Current search scope">
      <span><b>Scope</b>{index?.name ?? "All asset groups"}</span>
      <span><b>Tag</b>{tag || "Any"}</span>
      <span><b>Modality</b>{modality || "Any"}</span>
      <span><b>Evidence</b>{labelForTrustPreset(trustPresetFor(trustFilters))}</span>
      {entries.slice(0, 4).map(([key, value]) => (
        <span key={key}><b>{key}</b>{String(value)}</span>
      ))}
    </div>
  );
}

export function AdvancedSearchFilters({
  open,
  selectedIndex,
  filterTags,
  searchTag,
  setSearchTag,
  searchModality,
  setSearchModality,
  domainFilters,
  setDomainFilters,
  trustFilters,
  setTrustFilters,
  total,
  visible
}: {
  open: boolean;
  selectedIndex: IndexRecord | null;
  filterTags: string[];
  searchTag: string;
  setSearchTag: Dispatch<SetStateAction<string>>;
  searchModality: string;
  setSearchModality: Dispatch<SetStateAction<string>>;
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
        <span>{selectedIndex?.name ?? "All asset groups"} · showing {visible}/{total} after evidence filters</span>
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
        <label>
          <span>Modality</span>
          <select value={searchModality} onChange={(event) => setSearchModality(event.target.value)}>
            <option value="">Any modality</option>
            <option value="visual">Visual</option>
            <option value="audio">Audio</option>
            <option value="transcription">Transcription</option>
            <option value="metadata">Metadata</option>
          </select>
        </label>
      </div>
      <DomainSearchControls filters={domainFilters} onChange={setDomainFilters} />
      <EvidencePresetControls filters={trustFilters} onChange={setTrustFilters} />
      <details className="advanced-evidence-details">
        <summary>Advanced evidence settings</summary>
        <TrustSearchControls filters={trustFilters} onChange={setTrustFilters} total={total} visible={visible} />
      </details>
    </section>
  );
}

export function DomainSearchControls({
  filters,
  onChange
}: {
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
        <input value={filters.competition ?? ""} onChange={(event) => updateFilter("competition", event.target.value)} placeholder="Competition e.g. Premier League" />
        <input value={filters.season ?? ""} onChange={(event) => updateFilter("season", event.target.value)} placeholder="Season e.g. 2023-24" />
        <input value={filters.player ?? ""} onChange={(event) => updateFilter("player", event.target.value)} placeholder="Player e.g. Erling Haaland" />
        <select value={filters.eventType ?? ""} onChange={(event) => updateFilter("eventType", event.target.value)}>
          <option value="">Any event</option>
          <option value="pass_receive">Receive</option>
          <option value="shot">Shot</option>
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
      </div>
      <div className="domain-filter-actions">
        <button type="button" className="small-button" onClick={clearFilters}>Clear filters</button>
      </div>
    </section>
  );
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

export function QueryPlanCard({ plan }: { plan: DomainQueryPlan }) {
  const filterEntries = Object.entries(plan.domainFilters).filter(([, value]) => Boolean(value));
  return (
    <section className="query-plan-card" aria-label="Structured query plan">
      <div>
        <strong>Query Plan</strong>
        <span>{plan.rewrittenQuery}</span>
      </div>
      <div className="query-plan-grid">
        {filterEntries.length > 0 ? (
          filterEntries.map(([key, value]) => (
            <span key={key}>
              <b>{key}</b>
              {String(value)}
            </span>
          ))
        ) : (
          <span>
            <b>mode</b>
            semantic only
          </span>
        )}
        <span>
          <b>confidence</b>
          {Math.round(plan.confidence * 100)}%
        </span>
        {plan.planner && (
          <span>
            <b>planner</b>
            {plan.planner.source}{plan.planner.model ? ` · ${plan.planner.model}` : ""}
          </span>
        )}
      </div>
      {plan.warnings.length > 0 && (
        <p>{plan.warnings.slice(0, 2).join(" ")}</p>
      )}
    </section>
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

export function AskOperationTrace({ operation }: { operation: AskOperation }) {
  return (
    <section className={`ask-trace ${operation.status}`} aria-label="Ask execution trace">
      <div className="ask-trace-header">
        <div>
          <span>Execution trace</span>
          <strong>{operation.route === "pending" ? "Running server workflow" : operation.route.replace(/_/g, " ")}</strong>
        </div>
        <em>{operation.id.slice(0, 8)} · {operation.status}</em>
      </div>
      <div className="ask-trace-steps">
        {operation.steps.map((step) => (
          <article key={step.id} className={step.status}>
            <span>{step.owner}</span>
            <strong>{step.label}</strong>
            <p>{step.output || step.input}</p>
            <em>
              {step.status}
              {typeof step.durationMs === "number" ? ` · ${step.durationMs}ms` : ""}
            </em>
          </article>
        ))}
        {operation.steps.length === 0 && (
          <article className="queued">
            <span>platform</span>
            <strong>Queued</strong>
            <p>Waiting for the server to start the ask operation.</p>
            <em>queued</em>
          </article>
        )}
      </div>
      {operation.error && <p className="ask-trace-error">{operation.error}</p>}
    </section>
  );
}

export function SearchConversation({
  turns,
  getMomentHref
}: {
  turns: SearchConversationTurn[];
  getMomentHref: (assetId: string, segmentId?: string | null, at?: number | null) => string;
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
                  return (
                    <a key={result.asset.id} href={href} target="_blank" rel="noreferrer">
                      <b>{result.asset.title}</b>
                      <span>
                        {result.segments.length} moments · trust {buildEvidenceLedger(result.verification, result.matchReasons, result.segments).score}%
                      </span>
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

export function OrchestrationPlanCard({ plan }: { plan: OrchestrationPlan }) {
  const ownerLabel: Record<OrchestrationPlan["steps"][number]["owner"], string> = {
    router: "Router",
    knowledge: "Knowledge",
    retrieval: "Retrieval",
    analysis: "Analysis",
    platform: "Platform"
  };
  return (
    <section className="orchestration-card" aria-label="Model orchestration plan">
      <div className="orchestration-heading">
        <div>
          <strong>Orchestration</strong>
          <span>{plan.mode.replace(/_/g, " ")} · confidence {Math.round(plan.confidence * 100)}%</span>
        </div>
        <em>{plan.retrieval.engine.replace(/_/g, " ")}</em>
      </div>
      <div className="decision-row">
        {plan.decisions.map((decision) => (
          <span key={decision.id} className={decision.status}>
            <b>{decision.label}</b>
            {decision.value}
            <em>{Math.round(decision.confidence * 100)}%</em>
          </span>
        ))}
      </div>
      <div className="orchestration-steps">
        {plan.steps.map((step) => (
          <article key={step.id} className={step.status}>
            <span>{ownerLabel[step.owner]}</span>
            <strong>{step.label}</strong>
            <p>{step.action}</p>
            <em>{step.output}</em>
          </article>
        ))}
      </div>
      {(plan.retrieval.fallback.length > 0 || plan.warnings.length > 0) && (
        <p className="orchestration-warning">{[...plan.retrieval.fallback, ...plan.warnings].slice(0, 3).join(" ")}</p>
      )}
      {plan.analysis.required && (
        <p className="orchestration-analysis">Analysis prompt: {truncateText(plan.analysis.prompt, 180)}</p>
      )}
    </section>
  );
}
