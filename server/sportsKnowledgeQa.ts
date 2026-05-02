import type { DomainQueryPlan, SportsKnowledgeAnswer, SportsKnowledgeSnapshot } from "../shared/types";
import { getKnowledgePlayer, getSportsKnowledgeSnapshot, matchCompetition, matchKnowledgePlayer, playerTeamForSeason } from "./sportsKnowledge";

type MatchActivity = NonNullable<SportsKnowledgeSnapshot["matchActivities"]>[number];
type Metric = NonNullable<SportsKnowledgeAnswer["subject"]["metric"]>;
type MetricRow = {
  activity: MatchActivity;
  value: number;
  providerRank: number;
};

export function answerSportsKnowledgeQuestion(queryPlan: DomainQueryPlan): SportsKnowledgeAnswer {
  const metric = queryPlan.intent.metric ?? null;
  const playerMatch = queryPlan.intent.player ? getKnowledgePlayer(queryPlan.intent.player) : matchKnowledgePlayer(queryPlan.originalQuery)?.value ?? null;
  const competition = queryPlan.domainFilters.competition ?? matchCompetition(queryPlan.originalQuery)?.value ?? playerMatch?.league ?? null;
  const season = queryPlan.domainFilters.season ?? null;

  if (queryPlan.intent.questionType !== "stat_qa" || !metric) {
    return emptyAnswer("unsupported", "This query is not a supported sports statistics question.", { player: playerMatch?.canonical ?? null, competition, season, metric });
  }
  if (!playerMatch) {
    return {
      applicable: true,
      route: "stat_qa",
      answer: "I could not identify the player for this statistics question. Try a full player name such as Son Heung-min or Erling Haaland.",
      confidence: 0.22,
      subject: { player: null, competition, season, metric },
      value: null,
      status: "needs_clarification",
      evidence: [],
      fallback: null,
      warnings: ["Stats questions need a grounded player identity before answering."]
    };
  }

  const snapshot = getSportsKnowledgeSnapshot();
  const activities = (snapshot.matchActivities ?? []).filter((activity) => matchesPlayer(activity.player, playerMatch.canonical, playerMatch.aliases));
  const scoped = activities.filter((activity) => matchesScope(activity, competition, season));
  const rows = preferRosterTeam(scoped, playerMatch.canonical, season ?? undefined);
  const exact = aggregateMetric(rows, metric);

  if (exact.value !== null) {
    return {
      applicable: true,
      route: "stat_qa",
      answer: `${playerMatch.canonical} has ${exact.value} ${metric} in ${formatScope(competition, season)} according to imported sports knowledge.`,
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
      "The direct answer uses imported sports knowledge, not video moment retrieval.",
      season ? `No matching imported aggregate was found for season ${season}.` : "No season was resolved for this stats question.",
      fallback ? "A latest available imported record is shown as fallback evidence." : "Import a current stats source to answer this question."
    ]
  };
}

function emptyAnswer(status: SportsKnowledgeAnswer["status"], answer: string, subject: SportsKnowledgeAnswer["subject"]): SportsKnowledgeAnswer {
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
  if (season && normalize(activity.season) !== normalize(season)) return false;
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
    cards: /(\d+(?:\.\d+)?)\s+cards?/
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
  if (provider === "statbunker") return 3;
  if (provider === "football-data") return 2;
  return 1;
}

function evidenceFromActivity(activity: MatchActivity): SportsKnowledgeAnswer["evidence"][number] {
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
    "The direct answer uses imported sports knowledge, not video moment retrieval.",
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
