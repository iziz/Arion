import { BarChart3, Database, Layers3, Route, X } from "lucide-react";
import { useState } from "react";
import type { KnowledgeSourceId, KnowledgeVectorStoreStatus, KnowledgeSnapshot } from "../../../shared/types";
import { knowledgeTemplateDescriptors, sportsBaseTemplateContract, type KnowledgeTemplateDescriptor } from "../../../shared/knowledgeTemplates";
import { EmptyState } from "../common/ConsolePrimitives";

type KnowledgePanelTab = "overview" | "manifest" | "generator" | "evaluator";

export function KnowledgePanel({
  knowledgeSnapshot,
  selectedDomain,
  knowledgeVectorStore,
  onDelete
}: {
  knowledgeSnapshot: KnowledgeSnapshot | null;
  selectedDomain: KnowledgeSourceId;
  knowledgeVectorStore: KnowledgeVectorStoreStatus | null;
  onDelete: (id: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [provider, setProvider] = useState("all");
  const [activeTab, setActiveTab] = useState<KnowledgePanelTab>("overview");
  const normalizedFilter = filter.trim().toLowerCase();
  const domains = knowledgeSnapshot?.domains ?? defaultDomains();
  const selectedDomainInfo = domains.find((item) => item.id === selectedDomain) ?? domains[0];
  const selectedTemplate = knowledgeTemplateDescriptors[selectedDomain] ?? null;
  const domainSport = selectedDomainInfo?.sport ?? sportForDomain(selectedDomain);
  const domainCompetitions = knowledgeSnapshot?.competitions.filter((competition) => competition.domainGroup === selectedDomain || competition.sport === domainSport) ?? [];
  const domainCompetitionSet = new Set(domainCompetitions.map((competition) => competition.value));
  const domainTeams = knowledgeSnapshot?.teams.filter((team) => team.domainGroup === selectedDomain || (team.league && domainCompetitionSet.has(team.league))) ?? [];
  const domainPlayers = knowledgeSnapshot?.players.filter((player) => player.sport === domainSport || domainCompetitionSet.has(player.league)) ?? [];
  const domainActivities = knowledgeSnapshot?.matchActivities?.filter((activity) => domainCompetitionSet.has(activity.competition)) ?? [];
  const domainFacts = knowledgeSnapshot?.facts?.filter((fact) => domainCompetitionSet.has(fact.competition)) ?? [];
  const domainPlays = selectedDomain === "sports.american_football" ? knowledgeSnapshot?.americanFootballPlays ?? [] : [];
  const domainTotals = {
    competitions: selectedDomainInfo?.competitions.length ?? domainCompetitions.length,
    teams: selectedDomainInfo?.teams ?? domainTeams.length,
    players: selectedDomainInfo?.players ?? domainPlayers.length,
    activities: selectedDomainInfo?.matchActivities ?? domainActivities.length,
    facts: selectedDomainInfo?.facts ?? domainFacts.length,
    plays: selectedDomainInfo?.plays ?? domainPlays.length
  };
  const players = domainPlayers.filter((player) => {
    const providerMatch = provider === "all" || (provider === "local" ? !player.provider || player.provider === "local" : player.provider === provider);
    if (!providerMatch) return false;
    if (!normalizedFilter) return true;
    return [player.canonical, player.league, player.position ?? "", ...player.aliases, ...Object.values(player.teamsBySeason)]
      .join(" ")
      .toLowerCase()
      .includes(normalizedFilter);
  });
  const providerStats = countBy(domainPlayers, (player) => player.provider ?? "local");
  const seasonStats = topEntries([
    ...domainPlayers.flatMap((player) => player.activeSeasons),
    ...domainActivities.map((activity) => activity.season),
    ...domainFacts.map((fact) => fact.season)
  ]);
  const teamStats = topEntries([
    ...domainTeams.map((team) => team.value),
    ...domainPlayers.flatMap((player) => Object.values(player.teamsBySeason)),
    ...domainActivities.map((activity) => activity.team),
    ...domainFacts.map((fact) => fact.team ?? fact.entityName)
  ]);
  const positionStats = topEntries(domainPlayers.map((player) => player.position ?? "unknown"));
  const activityRoleStats = topEntries(domainActivities.map((activity) => activity.role));
  const factKindStats = topEntries(domainFacts.map((fact) => fact.kind));
  const playTypeStats = topEntries(domainPlays.map((play) => play.playType || "unknown"));
  const availableKnowledgeDocuments = domainTotals.competitions + domainTotals.teams + domainTotals.players + domainTotals.activities + domainTotals.facts + domainTotals.plays;
  return (
    <section className="panel knowledge-panel">
      <div className="panel-title">
        <Layers3 size={18} />
        <h2>Related Knowledge</h2>
      </div>
      {knowledgeSnapshot ? (
        <>
          <section className="knowledge-domain-summary" aria-label="Selected related knowledge summary">
            <div>
              <p className="section-label">Related Knowledge</p>
              <h2>{selectedDomainInfo?.label ?? selectedDomain}</h2>
              <p>{selectedDomain} · {domainSport.replace(/_/g, " ")}</p>
            </div>
            <div className="knowledge-domain-metrics">
              <span><b>Players</b>{domainTotals.players}</span>
              <span><b>Teams</b>{domainTotals.teams}</span>
              <span><b>Competitions</b>{domainTotals.competitions}</span>
              <span><b>Activities</b>{domainTotals.activities}</span>
              <span><b>Facts</b>{domainTotals.facts}</span>
              {selectedDomain === "sports.american_football" && <span><b>Plays</b>{domainTotals.plays}</span>}
            </div>
          </section>
          <KnowledgePanelTabs activeTab={activeTab} onChange={setActiveTab} templateAvailable={Boolean(selectedTemplate)} />
          {activeTab === "overview" ? (
            <>
              <KnowledgeRagCard
                status={knowledgeVectorStore}
                selectedDomain={selectedDomain}
                availableKnowledgeDocuments={availableKnowledgeDocuments}
              />
              <div className="knowledge-stat-grid" aria-label="Related knowledge statistics">
                <KnowledgeStatCard title="Providers" items={providerStats} />
                <KnowledgeStatCard title="Seasons" items={seasonStats} />
                <KnowledgeStatCard title="Teams" items={teamStats} />
                <KnowledgeStatCard title="Positions" items={positionStats} />
                <KnowledgeStatCard title="Activity roles" items={activityRoleStats} />
                <KnowledgeStatCard title="Fact kinds" items={factKindStats} />
                {selectedDomain === "sports.american_football" && <KnowledgeStatCard title="Play types" items={playTypeStats} />}
              </div>
              <div className="knowledge-toolbar">
                <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter players, teams, positions" />
                <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                  <option value="all">All sources</option>
                  <option value="football-data">Football-data</option>
                  <option value="football-data-uk">Football-data.co.uk</option>
                  <option value="kaggle">Kaggle</option>
                  <option value="statbunker">StatBunker</option>
                  <option value="statsbomb">StatsBomb</option>
                  <option value="nflverse">nflverse</option>
                  <option value="fbref">FBref</option>
                  <option value="local">Local/manual</option>
                </select>
              </div>
              <div className="knowledge-columns">
                <section className="knowledge-list-block wide">
                  <div className="subsection-heading compact">
                    <p className="section-label">Knowledge Registry</p>
                    <h3>{domainTotals.competitions} competitions · {domainTeams.slice(0, 80).length}/{domainTotals.teams} teams shown</h3>
                  </div>
                  <div className="knowledge-registry-grid">
                    <div className="table-list knowledge-table compact-table">
                      {domainCompetitions.map((competition) => (
                        <article key={competition.value} className="ops-row">
                          <strong>{competition.value}</strong>
                          <span>
                            {competition.sport ?? domainSport} · {(competition.aliases ?? []).slice(0, 4).join(", ") || "No aliases"}
                          </span>
                        </article>
                      ))}
                      {domainCompetitions.length === 0 && <EmptyState text="No competition registry exists for this related knowledge." />}
                    </div>
                    <div className="table-list knowledge-table compact-table">
                      {domainTeams.slice(0, 80).map((team) => (
                        <article key={team.value} className="ops-row">
                          <strong>{team.value}</strong>
                          <span>
                            {team.league ?? "No league"} · {(team.aliases ?? []).slice(0, 4).join(", ") || "No aliases"}
                          </span>
                        </article>
                      ))}
                      {domainTeams.length === 0 && <EmptyState text="No team registry exists for this related knowledge." />}
                    </div>
                  </div>
                </section>
                <section className="knowledge-list-block">
                  <div className="subsection-heading compact">
                    <p className="section-label">Players</p>
                    <h3>{players.slice(0, 60).length}/{domainTotals.players} records shown</h3>
                  </div>
                  <div className="table-list knowledge-table">
                    {players.slice(0, 60).map((player) => {
                      const seasons = player.activeSeasons.slice(-3).join(", ");
                      const currentTeam = player.teamsBySeason[player.activeSeasons[player.activeSeasons.length - 1] ?? ""] ?? Object.values(player.teamsBySeason)[0] ?? "No team";
                      return (
                        <article key={player.id} className="ops-row">
                          <div>
                            <strong>{player.canonical}</strong>
                            <span>
                              {player.league} · {currentTeam} · {seasons || "No season"} · {player.position ?? "position unknown"} · {player.provider ?? "local"}
                            </span>
                          </div>
                          <div className="row-actions">
                            <button type="button" onClick={() => void onDelete(player.id)}>
                              <X size={14} />
                              Delete
                            </button>
                          </div>
                        </article>
                      );
                    })}
                    {players.length === 0 && <EmptyState text="No player record matches the filter." />}
                  </div>
                </section>
                <section className="knowledge-list-block">
                  <div className="subsection-heading compact">
                    <p className="section-label">Match Activity</p>
                    <h3>{domainActivities.slice(0, 40).length}/{domainTotals.activities} records shown</h3>
                  </div>
                  <div className="table-list knowledge-table">
                    {domainActivities.slice(0, 40).map((activity) => (
                      <article key={activity.id} className="ops-row">
                        <strong>{activity.player}</strong>
                        <span>
                          {activity.role} · {activity.minute === null ? "sheet" : `${activity.minute}'`} · {activity.team} · {activity.homeTeam} vs {activity.awayTeam}
                        </span>
                      </article>
                    ))}
                    {domainActivities.length === 0 && <EmptyState text="No match activity has been imported for this related knowledge yet." />}
                  </div>
                </section>
                <section className="knowledge-list-block wide">
                  <div className="subsection-heading compact">
                    <p className="section-label">Facts</p>
                    <h3>{domainFacts.slice(0, 80).length}/{domainTotals.facts} records shown</h3>
                  </div>
                  <div className="table-list knowledge-table">
                    {domainFacts.slice(0, 80).map((fact) => (
                      <article key={fact.id} className="ops-row">
                        <strong>{fact.entityName}</strong>
                        <span>
                          {fact.kind} · {fact.metric}: {String(fact.value)} · {fact.season} · {fact.provider}
                        </span>
                      </article>
                    ))}
                    {domainFacts.length === 0 && <EmptyState text="No team, table, attendance, or nationality facts have been imported for this related knowledge yet." />}
                  </div>
                </section>
              </div>
            </>
          ) : (
            <KnowledgeTemplatePanel template={selectedTemplate} view={activeTab} />
          )}
        </>
      ) : (
        <EmptyState text="Knowledge registry is loading." />
      )}
    </section>
  );
}

function KnowledgePanelTabs({
  activeTab,
  onChange,
  templateAvailable
}: {
  activeTab: KnowledgePanelTab;
  onChange: (tab: KnowledgePanelTab) => void;
  templateAvailable: boolean;
}) {
  const tabs: Array<{ id: KnowledgePanelTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "manifest", label: templateAvailable ? "Manifest" : "Manifest unavailable" },
    { id: "generator", label: "Generator" },
    { id: "evaluator", label: "Evaluator" }
  ];
  return (
    <div className="knowledge-tabs" role="tablist" aria-label="Related knowledge views">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          className={activeTab === tab.id ? "active" : ""}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function KnowledgeTemplatePanel({ template, view }: { template: KnowledgeTemplateDescriptor | null; view: Exclude<KnowledgePanelTab, "overview"> }) {
  if (!template) return <EmptyState text="No domain-specific template is registered for this related knowledge." />;
  const { manifest, generator, evaluator } = template;
  const heroTitle = view === "manifest" ? manifest.label : view === "generator" ? generator.id : "Benchmark coverage";
  const heroLabel = view === "manifest" ? "Domain Manifest" : view === "generator" ? "Template Generator" : "Template Evaluator";
  const heroSummary = view === "manifest" ? manifest.summary : view === "generator" ? generator.timing : `Validation coverage for ${manifest.domain}.`;
  return (
    <section className="knowledge-template-panel" aria-label="Domain-specific knowledge template">
      <div className="knowledge-template-hero">
        <div>
          <p className="section-label">{heroLabel}</p>
          <h3>{heroTitle}</h3>
          <p>{heroSummary}</p>
        </div>
        <span>{view === "manifest" ? manifest.version : generator.adapter}</span>
      </div>
      {view === "manifest" && (
        <div className="knowledge-template-grid">
          <TemplateList title="Sports base rules" items={sportsBaseTemplateContract.sharedRules} wide />
          <TemplateList title="Strategy specialization" items={template.strategy.specializationRules} />
          <TemplateList title="Provider contracts" items={manifest.providerContracts.map((provider) => `${provider.name}: ${provider.role} · ${provider.contract}`)} />
          <TemplateList
            title="Evidence contract"
            items={manifest.requiredEvidence.map((evidence) => `${evidence.required ? "Required" : "Optional"} · ${evidence.name}: ${evidence.role} · ${evidence.contract}`)}
          />
          <TemplateList title="Output schema" items={manifest.outputSchema} />
          <TemplateList title="Runtime gates" items={manifest.runtimeGates} />
          <TemplateList title="Skip conditions" items={manifest.skipConditions} wide />
          <TemplateList title="Limitations" items={manifest.limitations} wide />
        </div>
      )}
      {view === "generator" && (
        <div className="knowledge-template-grid">
          <article className="knowledge-template-card">
            <h4>Generator contract</h4>
            <div className="knowledge-template-metrics">
              <span><b>Kind</b>{generator.kind}</span>
              <span><b>Output</b>{generator.outputVersion}</span>
              <span><b>Strategy</b>{template.strategy.strategyId}</span>
              <span><b>Min confidence</b>{generator.actionSpotting.minCandidateConfidence}</span>
              <span><b>Alignment</b>{generator.actionSpotting.alignment.minScore}/{generator.actionSpotting.alignment.minStrongScore}</span>
            </div>
          </article>
          <TemplateList title="Consumes" items={generator.consumes} />
          <TemplateList title="Pipeline" items={generator.pipeline} ordered wide />
          <TemplateList
            title="Action spotting rules"
            items={[
              `Provider context required: ${generator.actionSpotting.alignment.requireProviderContext ? "yes" : "no"}`,
              `Minimum candidate confidence: ${generator.actionSpotting.minCandidateConfidence}`,
              `Alignment score threshold: ${generator.actionSpotting.alignment.minScore}`,
              `Strong evidence threshold: ${generator.actionSpotting.alignment.minStrongScore}`,
              `Team term strategy: ${generator.actionSpotting.alignment.teamTermStrategy}`
            ]}
          />
          <TemplateList title="Emits" items={generator.emits} />
        </div>
      )}
      {view === "evaluator" && (
        <div className="knowledge-template-grid">
          <article className="knowledge-template-card wide">
            <h4>Benchmark coverage</h4>
            <div className="knowledge-benchmark-list">
              {evaluator.benchmarkCoverage.map((benchmark) => (
                <section key={benchmark.name} className={`knowledge-benchmark-row ${benchmark.status}`}>
                  <div>
                    <strong>{benchmark.name}</strong>
                    <span>{benchmark.source} · {benchmark.role}</span>
                    <p>{benchmark.coverage}</p>
                    <em>{benchmark.notes}</em>
                  </div>
                  <aside>
                    <b>{benchmark.status}</b>
                    {benchmark.metrics.slice(0, 4).map((metric) => <span key={metric}>{metric}</span>)}
                  </aside>
                </section>
              ))}
            </div>
          </article>
          <TemplateList title="Validation gates" items={evaluator.validationGates} />
          <TemplateList title="Fixtures" items={evaluator.fixtures} />
          <TemplateList title="Regression checks" items={evaluator.regressionChecks} wide />
        </div>
      )}
    </section>
  );
}

function TemplateList({ title, items, ordered = false, wide = false }: { title: string; items: string[]; ordered?: boolean; wide?: boolean }) {
  const List = ordered ? "ol" : "ul";
  return (
    <article className={`knowledge-template-card ${wide ? "wide" : ""}`}>
      <h4>{title}</h4>
      <List>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </List>
    </article>
  );
}

function KnowledgeRagCard({
  status,
  selectedDomain,
  availableKnowledgeDocuments
}: {
  status: KnowledgeVectorStoreStatus | null;
  selectedDomain: KnowledgeSourceId;
  availableKnowledgeDocuments: number;
}) {
  const domainStatus = status?.domains.find((domain) => domain.domainGroup === selectedDomain) ?? null;
  const domainVectors = domainStatus?.vectors ?? 0;
  const coverage = availableKnowledgeDocuments > 0 ? Math.min(100, Math.round((domainVectors / availableKnowledgeDocuments) * 100)) : 0;
  const ready = domainVectors > 0;
  const providerItems = (domainStatus?.providers ?? status?.providers ?? []).map((item) => ({ label: sourceLabel(item.provider), count: item.vectors }));
  const kindItems = (domainStatus?.kinds ?? status?.kinds ?? []).map((item) => ({ label: kindLabel(item.kind), count: item.vectors }));

  return (
    <section className={`knowledge-rag-card ${ready ? "ready" : "empty"}`} aria-label="Knowledge RAG status">
      <div className="knowledge-rag-header">
        <div>
          <p className="section-label">Knowledge RAG</p>
          <h3>{ready ? "Vectorized knowledge retrieval" : "Vector store not built"}</h3>
          <p>
            {status?.storage ?? "unknown"} · {domainVectors}/{availableKnowledgeDocuments} selected knowledge documents · {status?.vectors ?? 0} total vectors
          </p>
        </div>
        <span className="rag-status-pill">{ready ? `${coverage}% coverage` : "not ready"}</span>
      </div>
      <div className="knowledge-rag-metrics">
        <span><b>Storage</b>{status?.storage ?? "unknown"}</span>
        <span><b>Knowledge vectors</b>{domainVectors}</span>
        <span><b>Total vectors</b>{status?.vectors ?? 0}</span>
        <span><b>Coverage</b>{ready ? `${coverage}%` : "0%"}</span>
      </div>
      <div className="knowledge-rag-flow" aria-label="Knowledge RAG search flow">
        {["Query plan", "Query embedding", "Knowledge vector search", "Evidence grounding", "Video ranking"].map((step, index, steps) => (
          <span key={step}>
            {index === 0 ? <Route size={14} /> : index === 2 ? <Database size={14} /> : null}
            {step}
            {index < steps.length - 1 && <i aria-hidden="true" />}
          </span>
        ))}
      </div>
      <div className="knowledge-rag-breakdown">
        <KnowledgeStatCard title="RAG sources" items={providerItems} />
        <KnowledgeStatCard title="RAG document types" items={kindItems} />
      </div>
    </section>
  );
}

function KnowledgeStatCard({ title, items }: { title: string; items: Array<{ label: string; count: number }> }) {
  return (
    <article className="knowledge-stat-card">
      <div>
        <BarChart3 size={15} />
        <strong>{title}</strong>
      </div>
      {items.length > 0 ? (
        <ul>
          {items.slice(0, 5).map((item) => (
            <li key={item.label}>
              <span>{item.label}</span>
              <b>{item.count}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p>No data</p>
      )}
    </article>
  );
}

function sourceLabel(source: string) {
  return source === "sports_knowledge" ? "knowledge registry" : source;
}

function kindLabel(kind: string) {
  return kind.replace(/_/g, " ");
}

function defaultDomains(): NonNullable<KnowledgeSnapshot["domains"]> {
  return [
    { id: "sports.football", label: "Football", sport: "football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0, plays: 0 },
    { id: "sports.american_football", label: "American football", sport: "american_football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0, plays: 0 }
  ];
}

function countBy<T>(items: T[], keyFn: (item: T) => string | null | undefined) {
  return topEntries(items.map((item) => keyFn(item) ?? "unknown"));
}

function topEntries(values: string[]) {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const value = raw?.trim() || "unknown";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
}

function sportForDomain(domain: string) {
  return domain === "sports.american_football" ? "american_football" : "football";
}
