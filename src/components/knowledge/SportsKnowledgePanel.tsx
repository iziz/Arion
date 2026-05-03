import { BarChart3, Layers3, X } from "lucide-react";
import { useState } from "react";
import type { SportsDomainGroup, SportsKnowledgeSnapshot } from "../../../shared/types";
import { EmptyState } from "../common/ConsolePrimitives";

export function SportsKnowledgePanel({
  sportsKnowledge,
  selectedDomain,
  onDelete
}: {
  sportsKnowledge: SportsKnowledgeSnapshot | null;
  selectedDomain: SportsDomainGroup;
  onDelete: (id: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [provider, setProvider] = useState("all");
  const normalizedFilter = filter.trim().toLowerCase();
  const domains = sportsKnowledge?.domains ?? defaultDomains();
  const selectedDomainInfo = domains.find((item) => item.id === selectedDomain) ?? domains[0];
  const domainSport = selectedDomainInfo?.sport ?? sportForDomain(selectedDomain);
  const domainCompetitions = sportsKnowledge?.competitions.filter((competition) => competition.domainGroup === selectedDomain || competition.sport === domainSport) ?? [];
  const domainCompetitionSet = new Set(domainCompetitions.map((competition) => competition.value));
  const domainTeams = sportsKnowledge?.teams.filter((team) => team.domainGroup === selectedDomain || (team.league && domainCompetitionSet.has(team.league))) ?? [];
  const domainPlayers = sportsKnowledge?.players.filter((player) => player.sport === domainSport || domainCompetitionSet.has(player.league)) ?? [];
  const domainActivities = sportsKnowledge?.matchActivities?.filter((activity) => domainCompetitionSet.has(activity.competition)) ?? [];
  const domainFacts = sportsKnowledge?.facts?.filter((fact) => domainCompetitionSet.has(fact.competition)) ?? [];
  const players = domainPlayers.filter((player) => {
    const providerMatch = provider === "all" || (provider === "local" ? !player.provider || player.provider === "local" : player.provider === provider);
    if (!providerMatch) return false;
    if (!normalizedFilter) return true;
    return [player.canonical, player.league, player.position ?? "", ...player.aliases, ...Object.values(player.teamsBySeason)]
      .join(" ")
      .toLowerCase()
      .includes(normalizedFilter);
  });
  const footballDataCount = domainPlayers.filter((player) => player.provider === "football-data").length;
  const footballDataUkCount = domainPlayers.filter((player) => player.provider === "football-data-uk").length;
  const kaggleCount = domainPlayers.filter((player) => player.provider === "kaggle").length;
  const statbunkerCount = domainPlayers.filter((player) => player.provider === "statbunker").length;
  const statsbombCount = domainPlayers.filter((player) => player.provider === "statsbomb").length;
  const nflverseCount = domainPlayers.filter((player) => player.provider === "nflverse").length;
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
  return (
    <section className="panel knowledge-panel">
      <div className="panel-title">
        <Layers3 size={18} />
        <h2>Sports Knowledge</h2>
      </div>
      {sportsKnowledge ? (
        <>
          <section className="knowledge-domain-summary" aria-label="Selected knowledge domain summary">
            <div>
              <p className="section-label">Knowledge Domain</p>
              <h2>{selectedDomainInfo?.label ?? selectedDomain}</h2>
              <p>{selectedDomain} · {domainSport.replace(/_/g, " ")}</p>
            </div>
            <div className="knowledge-domain-metrics">
              <span><b>Players</b>{domainPlayers.length}</span>
              <span><b>Teams</b>{domainTeams.length}</span>
              <span><b>Competitions</b>{domainCompetitions.length}</span>
              <span><b>Activities</b>{domainActivities.length}</span>
              <span><b>Facts</b>{domainFacts.length}</span>
            </div>
          </section>
          <div className="obs-summary">
            <span>{domainPlayers.length} players</span>
            <span>{footballDataCount} football-data</span>
            <span>{footballDataUkCount} football-data-uk</span>
            <span>{kaggleCount} kaggle</span>
            <span>{statbunkerCount} statbunker</span>
            <span>{statsbombCount} statsbomb</span>
            <span>{nflverseCount} nflverse</span>
            <span>{domainTeams.length} teams</span>
            <span>{domainCompetitions.length} competitions</span>
            <span>{domainActivities.length} activities</span>
            <span>{domainFacts.length} facts</span>
          </div>
          <div className="knowledge-stat-grid" aria-label="Domain knowledge statistics">
            <KnowledgeStatCard title="Providers" items={providerStats} />
            <KnowledgeStatCard title="Seasons" items={seasonStats} />
            <KnowledgeStatCard title="Teams" items={teamStats} />
            <KnowledgeStatCard title="Positions" items={positionStats} />
            <KnowledgeStatCard title="Activity roles" items={activityRoleStats} />
            <KnowledgeStatCard title="Fact kinds" items={factKindStats} />
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
                <p className="section-label">Domain Registry</p>
                <h3>{domainCompetitions.length} competitions · {domainTeams.length} teams</h3>
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
                  {domainCompetitions.length === 0 && <EmptyState text="No competition registry exists for this domain." />}
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
                  {domainTeams.length === 0 && <EmptyState text="No team registry exists for this domain." />}
                </div>
              </div>
            </section>
            <section className="knowledge-list-block">
              <div className="subsection-heading compact">
                <p className="section-label">Players</p>
                <h3>{players.length} records</h3>
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
                <h3>{domainActivities.length} records</h3>
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
                {domainActivities.length === 0 && <EmptyState text="No match activity has been imported for this domain yet." />}
              </div>
            </section>
            <section className="knowledge-list-block wide">
              <div className="subsection-heading compact">
                <p className="section-label">Facts</p>
                <h3>{domainFacts.length} records</h3>
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
                {domainFacts.length === 0 && <EmptyState text="No team, table, attendance, or nationality facts have been imported for this domain yet." />}
              </div>
            </section>
          </div>
        </>
      ) : (
        <EmptyState text="Sports knowledge registry is loading." />
      )}
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

function defaultDomains(): NonNullable<SportsKnowledgeSnapshot["domains"]> {
  return [
    { id: "sports.football", label: "Football", sport: "football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0 },
    { id: "sports.american_football", label: "American football", sport: "american_football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0 }
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
