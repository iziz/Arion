import type { DomainQueryPlan, StructuredKnowledgeAnswer, KnowledgeSnapshot } from "../../../../shared/types";
import { getKnowledgePlayer, getKnowledgeSnapshot, playerTeamForSeason } from "./store";

type MatchActivity = NonNullable<KnowledgeSnapshot["matchActivities"]>[number];
type Metric = NonNullable<StructuredKnowledgeAnswer["subject"]["metric"]>;
type MetricRow = {
  activity: MatchActivity;
  value: number;
  providerRank: number;
};

export function answerSportsKnowledgeQuestion(queryPlan: DomainQueryPlan): StructuredKnowledgeAnswer {
  const metric = queryPlan.intent.metric ?? null;
  const requestedPlayer = queryPlan.intent.player ?? queryPlan.domainFilters.player ?? null;
  const playerMatch = requestedPlayer ? getKnowledgePlayer(requestedPlayer) : null;
  const competition = queryPlan.domainFilters.competition ?? playerMatch?.league ?? null;
  const season = queryPlan.domainFilters.season ?? null;
  const statMode = queryPlan.intent.statMode ?? (playerMatch ? "player_total" : null);

  if (queryPlan.route !== "knowledge_evidence" || queryPlan.responseMode !== "structured_answer" || queryPlan.relatedKnowledgeMode !== "direct_answer" || !metric) {
    return emptyAnswer("unsupported", "This query is not a supported sports statistics question.", { player: playerMatch?.canonical ?? null, competition, season, metric });
  }
  if (statMode === "leaderboard") {
    const leader = resolveLeaderboardSubject(queryPlan, metric, competition, season);
    if (leader) {
      return {
        applicable: true,
        route: "stat_qa",
        answer: `${leader.player} leads ${formatScope(leader.competition, leader.season)} with ${leader.value} ${metric} according to imported related knowledge.`,
        confidence: leader.rows.length > 0 ? 0.82 : 0.68,
        subject: { player: leader.player, competition: leader.competition, season: leader.season, metric },
        value: leader.value,
        status: "answered",
        evidence: leader.rows.map(evidenceFromActivity).slice(0, 6),
        fallback: null,
        warnings: [
          "Resolved the ranking subject from imported related knowledge.",
          competition ? "" : "Competition was not explicit; the leader was selected from available imported related knowledge.",
          season ? "" : "Season was not explicit; the answer may be broad."
        ].filter(Boolean)
      };
    }
    return {
      applicable: true,
      route: "stat_qa",
      answer: `I do not have imported ${metric} leaderboard data for ${formatScope(competition, season)}.`,
      confidence: 0.34,
      subject: { player: null, competition, season, metric },
      value: null,
      status: "missing_stat",
      evidence: [],
      fallback: null,
      warnings: [
        "No imported leaderboard rows matched this scoped statistics question.",
        "Video retrieval may still use indexed asset metadata as a scoped fallback."
      ]
    };
  }
  if (!playerMatch) {
    return {
      applicable: true,
      route: "stat_qa",
      answer: "I could not identify the player for this statistics question. Try a full player name from the knowledge base or indexed metadata.",
      confidence: 0.22,
      subject: { player: null, competition, season, metric },
      value: null,
      status: "needs_clarification",
      evidence: [],
      fallback: null,
      warnings: ["Stats questions need a grounded player identity before answering."]
    };
  }

  const snapshot = getKnowledgeSnapshot();
  const activities = (snapshot.matchActivities ?? []).filter((activity) => matchesPlayer(activity.player, playerMatch.canonical, playerMatch.aliases));
  const scoped = activities.filter((activity) => matchesScope(activity, competition, season));
  const rows = preferRosterTeam(scoped, playerMatch.canonical, season ?? undefined);
  const exact = aggregateMetric(rows, metric);

  if (exact.value !== null) {
    return {
      applicable: true,
      route: "stat_qa",
      answer: `${playerMatch.canonical} has ${exact.value} ${metric} in ${formatScope(competition, season)} according to imported related knowledge.`,
      confidence: exact.aggregateRows.length > 0 ? 0.88 : 0.74,
      subject: { player: playerMatch.canonical, competition, season, metric },
      value: exact.value,
      status: "answered",
      evidence: exact.aggregateRows.map(evidenceFromActivity).slice(0, 6),
      fallback: null,
      warnings: buildWarnings(rows, competition, season)
    };
  }

  const fallbackRows = preferRosterTeam(
    activities.filter((activity) => matchesScope(activity, competition, null)),
    playerMatch.canonical,
    undefined
  );
  const latest = latestMetric(fallbackRows, metric);
  const fallback = latest
    ? `Latest imported ${metric} record: ${latest.value} in ${latest.season}${latest.team ? ` for ${latest.team}` : ""}.`
    : null;
  return {
    applicable: true,
    route: "stat_qa",
    answer: `I do not have an imported ${metric} total for ${playerMatch.canonical} in ${formatScope(competition, season)}.`,
    confidence: fallback ? 0.46 : 0.28,
    subject: { player: playerMatch.canonical, competition, season, metric },
    value: null,
    status: "missing_stat",
    evidence: latest ? [evidenceFromActivity(latest.activity)] : [],
    fallback,
    warnings: [
      "The direct answer uses imported related knowledge, not video moment retrieval.",
      season ? `No matching imported aggregate was found for season ${season}.` : "No season was resolved for this stats question.",
      fallback ? "A latest available imported record is shown as fallback evidence." : "Import a current stats source to answer this question."
    ]
  };
}

function emptyAnswer(status: StructuredKnowledgeAnswer["status"], answer: string, subject: StructuredKnowledgeAnswer["subject"]): StructuredKnowledgeAnswer {
  return {
    applicable: false,
    route: "unsupported",
    answer,
    confidence: 0,
    subject,
    value: null,
    status,
    evidence: [],
    fallback: null,
    warnings: []
  };
}

function matchesScope(activity: MatchActivity, competition: string | null, season: string | null) {
  if (competition && normalize(activity.competition) !== normalize(competition)) return false;
  if (season && !seasonMatchesRequest(activity.season, season)) return false;
  return true;
}

function matchesPlayer(value: string, canonical: string, aliases: string[]) {
  const normalized = normalize(value);
  return [canonical, ...aliases].some((alias) => normalize(alias) === normalized);
}

function preferRosterTeam(rows: MatchActivity[], player: string, season: string | undefined) {
  const team = playerTeamForSeason(player, season);
  if (!team) return rows;
  const teamRows = rows.filter((activity) => normalize(activity.team).includes(normalize(team)) || normalize(team).includes(normalize(activity.team)));
  return teamRows.length > 0 ? teamRows : rows;
}

function aggregateMetric(rows: MatchActivity[], metric: Metric) {
  const statRows = rows.filter((activity) => activity.role === "STAT");
  const aggregateRows = selectBestMetricRows(statRows, metric);
  if (aggregateRows.length > 0) {
    return {
      value: aggregateRows.reduce((sum, row) => sum + row.value, 0),
      aggregateRows: aggregateRows.map((row) => row.activity)
    };
  }
  if (metric === "goals") {
    const goalRows = dedupeActivities(rows.filter((activity) => activity.role === "GOAL"));
    if (goalRows.length > 0) return { value: goalRows.length, aggregateRows: goalRows };
  }
  if (metric === "assists") {
    const assistRows = dedupeActivities(rows.filter((activity) => activity.role === "ASSIST"));
    if (assistRows.length > 0) return { value: assistRows.length, aggregateRows: assistRows };
  }
  return { value: null, aggregateRows: [] };
}

function resolveLeaderboardSubject(queryPlan: DomainQueryPlan, metric: Metric, competition: string | null, season: string | null) {
  if (queryPlan.intent.statMode !== "leaderboard") return null;
  const snapshot = getKnowledgeSnapshot();
  const scopedActivities = (snapshot.matchActivities ?? []).filter((activity) => matchesScope(activity, competition, season));
  const metricRows = selectBestMetricRows(scopedActivities.filter((activity) => activity.role === "STAT"), metric);
  const leaders = aggregateMetricRowsByPlayer(metricRows);
  if (leaders.length > 0) return leaders[0];
  if (metric === "goals") {
    const goalRows = dedupeActivities(scopedActivities.filter((activity) => activity.role === "GOAL"));
    const goalLeaders = aggregateActivityCountsByPlayer(goalRows);
    if (goalLeaders.length > 0) return goalLeaders[0];
  }
  if (metric === "assists") {
    const assistRows = dedupeActivities(scopedActivities.filter((activity) => activity.role === "ASSIST"));
    const assistLeaders = aggregateActivityCountsByPlayer(assistRows);
    if (assistLeaders.length > 0) return assistLeaders[0];
  }
  return null;
}

function aggregateMetricRowsByPlayer(rows: MetricRow[]) {
  const grouped = new Map<string, { player: string; value: number; rows: MatchActivity[]; competition: string | null; season: string | null; providerRank: number }>();
  for (const row of rows) {
    const key = normalize(row.activity.player);
    const existing = grouped.get(key);
    if (existing) {
      existing.value += row.value;
      existing.rows.push(row.activity);
      existing.providerRank = Math.max(existing.providerRank, row.providerRank);
      if (!existing.competition || existing.competition === row.activity.competition) existing.competition = row.activity.competition;
      if (!existing.season || existing.season === row.activity.season) existing.season = row.activity.season;
      continue;
    }
    grouped.set(key, {
      player: row.activity.player,
      value: row.value,
      rows: [row.activity],
      competition: row.activity.competition,
      season: row.activity.season,
      providerRank: row.providerRank
    });
  }
  return Array.from(grouped.values()).sort((a, b) => b.value - a.value || b.providerRank - a.providerRank || a.player.localeCompare(b.player));
}

function aggregateActivityCountsByPlayer(rows: MatchActivity[]) {
  const grouped = new Map<string, { player: string; value: number; rows: MatchActivity[]; competition: string | null; season: string | null; providerRank: number }>();
  for (const activity of rows) {
    const key = normalize(activity.player);
    const existing = grouped.get(key);
    if (existing) {
      existing.value += 1;
      existing.rows.push(activity);
      existing.providerRank = Math.max(existing.providerRank, providerRank(activity.provider));
      continue;
    }
    grouped.set(key, {
      player: activity.player,
      value: 1,
      rows: [activity],
      competition: activity.competition,
      season: activity.season,
      providerRank: providerRank(activity.provider)
    });
  }
  return Array.from(grouped.values()).sort((a, b) => b.value - a.value || b.providerRank - a.providerRank || a.player.localeCompare(b.player));
}

function latestMetric(rows: MatchActivity[], metric: Metric) {
  const candidates = selectBestMetricRows(rows, metric).sort((a, b) => seasonRank(b.activity.season) - seasonRank(a.activity.season) || b.providerRank - a.providerRank);
  const latest = candidates[0];
  return latest ? { activity: latest.activity, value: latest.value, season: latest.activity.season, team: latest.activity.team } : null;
}

function selectBestMetricRows(rows: MatchActivity[], metric: Metric): MetricRow[] {
  const byScope = new Map<string, MetricRow>();
  for (const activity of rows) {
    const value = metricValue(activity, metric);
    if (value === null) continue;
    const row: MetricRow = {
      activity,
      value,
      providerRank: providerRank(activity.provider)
    };
    const key = [activity.competition, activity.season, activity.team, activity.player, metric].map(normalize).join(":");
    const existing = byScope.get(key);
    if (!existing || row.providerRank > existing.providerRank || (row.providerRank === existing.providerRank && row.value > existing.value)) {
      byScope.set(key, row);
    }
  }
  return Array.from(byScope.values());
}

function metricValue(activity: MatchActivity, metric: Metric) {
  const text = activity.sourceText.toLowerCase();
  const patterns: Record<typeof metric, RegExp> = {
    goals: /(\d+(?:\.\d+)?)\s+goals?/,
    assists: /(\d+(?:\.\d+)?)\s+assists?/,
    appearances: /(\d+(?:\.\d+)?)\s+appearances?/,
    minutes: /(\d+(?:\.\d+)?)\s+minutes?/,
    cards: /(\d+(?:\.\d+)?)\s+cards?/,
    points: /(\d+(?:\.\d+)?)\s+points?/,
    touchdowns: /(\d+(?:\.\d+)?)\s+(?:touchdowns?|tds?)/,
    passing_yards: /(\d+(?:\.\d+)?)\s+passing\s+yards?/,
    passing_touchdowns: /(\d+(?:\.\d+)?)\s+(?:passing\s+touchdowns?|passing\s+tds?)/,
    rushing_yards: /(\d+(?:\.\d+)?)\s+rushing\s+yards?/,
    receiving_yards: /(\d+(?:\.\d+)?)\s+receiving\s+yards?/,
    sacks: /(\d+(?:\.\d+)?)\s+sacks?/,
    interceptions: /(\d+(?:\.\d+)?)\s+interceptions?/
  };
  const match = text.match(patterns[metric]);
  return match ? Number(match[1]) : null;
}

function dedupeActivities(rows: MatchActivity[]) {
  const byId = new Map<string, MatchActivity>();
  for (const row of rows) byId.set(row.id, row);
  return Array.from(byId.values());
}

function providerRank(provider: MatchActivity["provider"]) {
  if (provider === "nflverse") return 4;
  if (provider === "statsbomb") return 4;
  if (provider === "statbunker") return 3;
  if (provider === "football-data") return 2;
  if (provider === "football-data-uk") return 2;
  if (provider === "fbref") return 2;
  return 1;
}

function evidenceFromActivity(activity: MatchActivity): StructuredKnowledgeAnswer["evidence"][number] {
  return {
    provider: activity.provider,
    season: activity.season,
    competition: activity.competition,
    team: activity.team,
    sourceText: activity.sourceText
  };
}

function buildWarnings(rows: MatchActivity[], competition: string | null, season: string | null) {
  return [
    "The direct answer uses imported related knowledge, not video moment retrieval.",
    rows.some((activity) => activity.provider === "kaggle") ? "Some imported rows may contain provider-specific competition/team normalization noise." : "",
    competition ? "" : "Competition was inferred from the player profile.",
    season ? "" : "Season was not explicit, so the answer may be broad."
  ].filter(Boolean);
}

function formatScope(competition: string | null, season: string | null) {
  return [competition, season].filter(Boolean).join(" ") || "the requested scope";
}

function seasonRank(season: string) {
  const match = season.match(/20\d{2}/);
  return match ? Number(match[0]) : 0;
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

function seasonMatchesRequest(activitySeason: string, requestedSeason: string) {
  const activity = normalize(activitySeason);
  return requestedSeason.split(",").map((item) => normalize(item)).filter(Boolean).some((requested) => {
    if (activity === requested) return true;
    if (/^20\d{2}$/.test(requested) && activity.startsWith(requested)) return true;
    return activity.includes(requested) || requested.includes(activity);
  });
}
