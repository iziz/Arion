import { Database, Edit3, Layers3, Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { SportsKnowledgeSnapshot } from "../../../shared/types";
import { EmptyState } from "../common/ConsolePrimitives";

export function SportsKnowledgePanel({
  sportsKnowledge,
  onSubmit,
  onDelete,
  onImport,
  onStatbunkerImport,
  importing
}: {
  sportsKnowledge: SportsKnowledgeSnapshot | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onImport: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onStatbunkerImport: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  importing: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [provider, setProvider] = useState("all");
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const normalizedFilter = filter.trim().toLowerCase();
  const players = sportsKnowledge?.players.filter((player) => {
    const providerMatch = provider === "all" || (provider === "local" ? !player.provider || player.provider === "local" : player.provider === provider);
    if (!providerMatch) return false;
    if (!normalizedFilter) return true;
    return [player.canonical, player.league, player.position ?? "", ...player.aliases, ...Object.values(player.teamsBySeason)]
      .join(" ")
      .toLowerCase()
      .includes(normalizedFilter);
  }) ?? [];
  const activities = sportsKnowledge?.matchActivities ?? [];
  const facts = sportsKnowledge?.facts ?? [];
  const footballDataCount = sportsKnowledge?.players.filter((player) => player.provider === "football-data").length ?? 0;
  const kaggleCount = sportsKnowledge?.players.filter((player) => player.provider === "kaggle").length ?? 0;
  const statbunkerCount = sportsKnowledge?.players.filter((player) => player.provider === "statbunker").length ?? 0;
  const editingPlayer = sportsKnowledge?.players.find((player) => player.id === editingPlayerId) ?? null;
  return (
    <section className="panel knowledge-panel">
      <div className="panel-title">
        <Layers3 size={18} />
        <h2>Sports Knowledge</h2>
      </div>
      {sportsKnowledge ? (
        <>
          <div className="obs-summary">
            <span>{sportsKnowledge.players.length} players</span>
            <span>{footballDataCount} football-data</span>
            <span>{kaggleCount} kaggle</span>
            <span>{statbunkerCount} statbunker</span>
            <span>{sportsKnowledge.teams.length} teams</span>
            <span>{sportsKnowledge.competitions.length} competitions</span>
            <span>{activities.length} activities</span>
            <span>{facts.length} facts</span>
          </div>
          <div className="knowledge-grid">
            <form className="knowledge-import-card" onSubmit={(event) => void onImport(event)}>
              <div>
                <strong>Football-data import</strong>
                <span>Prefetch roster and optional match activity into local knowledge.</span>
              </div>
              <input name="competitionCode" defaultValue="PL" placeholder="Competition code e.g. PL" />
              <input name="season" defaultValue={defaultFootballSeason()} placeholder="Season start year e.g. 2025" inputMode="numeric" />
              <input name="matchLimit" defaultValue="10" placeholder="Match limit for activity import" inputMode="numeric" />
              <label className="inline-toggle">
                <input name="includeMatches" type="checkbox" />
                <span>Import match activity</span>
              </label>
              <button type="submit" disabled={importing}>
                <Database size={16} />
                {importing ? "Importing" : "Import"}
              </button>
            </form>
            <form className="knowledge-import-card" onSubmit={(event) => void onStatbunkerImport(event)}>
              <div>
                <strong>Kaggle / StatBunker import</strong>
                <span>Import CC0 Kaggle dumps or approved StatBunker CSV/JSON exports.</span>
              </div>
              <select name="source" defaultValue="kaggle">
                <option value="kaggle">Kaggle dataset</option>
                <option value="statbunker">StatBunker export</option>
              </select>
              <input name="dataset" defaultValue="cclayford/statbunker-football-stats" placeholder="Kaggle dataset ref" />
              <input name="localPath" placeholder="Local CSV/JSON directory path" />
              <input name="competition" defaultValue="Premier League" placeholder="Competition" />
              <input name="season" placeholder="Season e.g. 2017-18" />
              <label className="inline-toggle">
                <input name="download" type="checkbox" />
                <span>Download with Kaggle CLI</span>
              </label>
              <button type="submit" disabled={importing}>
                <Database size={16} />
                {importing ? "Importing" : "Import dataset"}
              </button>
            </form>
            <form
              key={editingPlayer?.id ?? "new-player"}
              className="knowledge-form"
              onSubmit={(event) => {
                void onSubmit(event).then(() => setEditingPlayerId(null));
              }}
            >
              <div>
                <strong>{editingPlayer ? "Edit player" : "Manual player"}</strong>
                <span>{editingPlayer ? "Override a player record in local knowledge." : "Add or override a known player record."}</span>
              </div>
              <input name="id" type="hidden" defaultValue={editingPlayer?.id ?? ""} />
              <input name="canonical" placeholder="Player canonical name" defaultValue={editingPlayer?.canonical ?? ""} required />
              <input name="aliases" placeholder="Aliases, comma separated" defaultValue={editingPlayer?.aliases.join(", ") ?? ""} />
              <select name="sport" defaultValue={editingPlayer?.sport ?? "football"}>
                <option value="football">football</option>
                <option value="american_football">american football</option>
              </select>
              <select name="league" defaultValue={editingPlayer?.league ?? "Premier League"}>
                {sportsKnowledge.competitions.map((competition) => (
                  <option key={competition.value} value={competition.value}>{competition.value}</option>
                ))}
              </select>
              <input name="activeSeasons" placeholder="Seasons, comma separated" defaultValue={editingPlayer?.activeSeasons.join(", ") ?? ""} />
              <input name="team" placeholder="Team for listed seasons" defaultValue={editingPlayer ? Object.values(editingPlayer.teamsBySeason)[0] ?? "" : ""} />
              <input name="position" placeholder="Position" defaultValue={editingPlayer?.position ?? ""} />
              <input name="shirtNumber" placeholder="Shirt number" defaultValue={editingPlayer?.shirtNumber ?? ""} inputMode="numeric" />
              <button type="submit">
                {editingPlayer ? <Edit3 size={16} /> : <Plus size={16} />}
                {editingPlayer ? "Save player" : "Add player"}
              </button>
              {editingPlayer && (
                <button type="button" className="secondary-button" onClick={() => setEditingPlayerId(null)}>
                  <X size={16} />
                  Cancel edit
                </button>
              )}
            </form>
          </div>
          <div className="knowledge-toolbar">
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter players, teams, positions" />
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="all">All sources</option>
              <option value="football-data">Football-data</option>
              <option value="kaggle">Kaggle</option>
              <option value="statbunker">StatBunker</option>
              <option value="local">Local/manual</option>
            </select>
          </div>
          <div className="knowledge-columns">
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
                        <button type="button" onClick={() => setEditingPlayerId(player.id)}>
                          <Edit3 size={14} />
                          Edit
                        </button>
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
                <h3>{activities.length} records</h3>
              </div>
              <div className="table-list knowledge-table">
                {activities.slice(0, 40).map((activity) => (
                  <article key={activity.id} className="ops-row">
                    <strong>{activity.player}</strong>
                    <span>
                      {activity.role} · {activity.minute === null ? "sheet" : `${activity.minute}'`} · {activity.team} · {activity.homeTeam} vs {activity.awayTeam}
                    </span>
                  </article>
                ))}
                {activities.length === 0 && <EmptyState text="No match activity has been imported yet." />}
              </div>
            </section>
            <section className="knowledge-list-block wide">
              <div className="subsection-heading compact">
                <p className="section-label">Facts</p>
                <h3>{facts.length} records</h3>
              </div>
              <div className="table-list knowledge-table">
                {facts.slice(0, 80).map((fact) => (
                  <article key={fact.id} className="ops-row">
                    <strong>{fact.entityName}</strong>
                    <span>
                      {fact.kind} · {fact.metric}: {String(fact.value)} · {fact.season} · {fact.provider}
                    </span>
                  </article>
                ))}
                {facts.length === 0 && <EmptyState text="No team, table, attendance, or nationality facts have been imported yet." />}
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

function defaultFootballSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  return String(now.getUTCMonth() >= 6 ? year : year - 1);
}
