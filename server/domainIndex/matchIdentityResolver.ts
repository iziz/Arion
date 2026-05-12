import type {
  ActiveRosterWindow,
  AssetIdentityIndex,
  AssetRecord,
  DomainEvent,
  IdentityEvidenceItem,
  IndexRecord,
  KnowledgeDomainGroup,
  KnowledgeSnapshot,
  MatchClockMapping,
  MatchContext,
  PlayerIdentityCandidate,
  SegmentIdentityContext,
  TeamClusterAssignment,
  TimelineSegment,
  TrackIdentityAssignment
} from "../../shared/types";
import { getKnowledgeSnapshot, matchKnowledgePlayers } from "../knowledge/registry";
import { extractLightKeywords, normalizeLabel, normalizeText, unique } from "./utils";

const SPORTS_IDENTITY_RESOLVER_ID = "sports-identity-resolver-v1";

type MatchActivity = NonNullable<KnowledgeSnapshot["matchActivities"]>[number];
type AmericanFootballPlay = NonNullable<KnowledgeSnapshot["americanFootballPlays"]>[number];
type KnowledgePlayer = KnowledgeSnapshot["players"][number];
type TeamRecord = KnowledgeSnapshot["teams"][number];
type JerseyNumberCandidate = {
  number: number;
  confidence: number;
  value: string;
  source: "text_ocr" | "crop_ocr";
  trackId?: string | null;
};
type VisionPlayerTrack = NonNullable<NonNullable<NonNullable<NonNullable<TimelineSegment["sceneData"]>["vision"]>["tracking"]>["playerTracks"]>[number];
type VisionTrackMovementSummary = NonNullable<VisionPlayerTrack["movement"]>;
type FootballPositionGroup = "goalkeeper" | "defender" | "midfielder" | "forward" | "wide" | "unknown";
type VisualRosterSignal = {
  score: number;
  faceConfidence: number;
  evidence: IdentityEvidenceItem[];
};

type ResolveOptions = {
  snapshot?: KnowledgeSnapshot;
};

type StrategyResult = {
  timeline: TimelineSegment[];
  identity: AssetIdentityIndex;
  trace: string;
};

type SportsIdentityStrategy = {
  id: KnowledgeDomainGroup;
  label: string;
  supports: (index: IndexRecord) => boolean;
  resolve: (asset: AssetRecord, index: IndexRecord, timeline: TimelineSegment[], snapshot: KnowledgeSnapshot) => StrategyResult;
};

type FootballMatchCandidate = {
  id: string;
  matchId: string;
  provider: MatchContext["provider"];
  competition: string;
  season: string;
  homeTeam: string;
  awayTeam: string;
  activities: MatchActivity[];
  homeTerms: string[];
  awayTerms: string[];
  playerNames: string[];
};

type ScoredFootballMatch = {
  candidate: FootballMatchCandidate;
  score: number;
  confidence: number;
  status: MatchContext["status"];
  evidence: string[];
};

type AmericanFootballGameCandidate = {
  id: string;
  gameId: string;
  provider: "nflverse";
  competition: "NFL";
  season: string;
  week: number | null;
  homeTeam: string;
  awayTeam: string;
  plays: AmericanFootballPlay[];
  homeTerms: string[];
  awayTerms: string[];
  teamTerms: string[];
  playerNames: string[];
};

type ScoredAmericanFootballGame = {
  candidate: AmericanFootballGameCandidate;
  play: AmericanFootballPlay | null;
  score: number;
  confidence: number;
  status: MatchContext["status"];
  evidence: string[];
};

type AmericanFootballLookup = {
  byPlayKey: Map<string, AmericanFootballPlay>;
  byGameId: Map<string, AmericanFootballPlay[]>;
  byTerm: Map<string, AmericanFootballPlay[]>;
};

export function resolveTimelineMatchIdentity(
  asset: AssetRecord,
  index: IndexRecord,
  timeline: TimelineSegment[],
  options: ResolveOptions = {}
): { timeline: TimelineSegment[]; identity: AssetIdentityIndex; trace: string } {
  if (!index.domainIndexing?.enabled) {
    return {
      timeline,
      identity: emptyIdentity("skipped", "Sports identity resolver only runs when domain indexing is enabled."),
      trace: "match-identity:skipped:domain-index-disabled"
    };
  }

  const strategies = SPORTS_IDENTITY_STRATEGIES.filter((strategy) => strategy.supports(index));
  if (strategies.length === 0) {
    return {
      timeline,
      identity: emptyIdentity("skipped", "No sports identity strategy is registered for this asset group domain."),
      trace: "match-identity:skipped:no-sports-strategy"
    };
  }

  const snapshot = options.snapshot ?? getKnowledgeSnapshot();
  let nextTimeline = timeline;
  const identities: AssetIdentityIndex[] = [];
  const traces: string[] = [];
  for (const strategy of strategies) {
    const result = strategy.resolve(asset, index, nextTimeline, snapshot);
    nextTimeline = result.timeline;
    identities.push(result.identity);
    traces.push(result.trace);
  }

  const identity = combineAssetIdentityIndexes(identities);
  return {
    timeline: nextTimeline,
    identity,
    trace: `match-identity:${identity.generatedBy}:strategies=${strategies.map((strategy) => strategy.id).join(",")}:${identity.matchContexts.length}:${identity.trackIdentityAssignments.length}:candidates=${identity.playerIdentityCandidates.length}:${traces.join("|")}`
  };
}

const SPORTS_IDENTITY_STRATEGIES: SportsIdentityStrategy[] = [
  {
    id: "sports.football",
    label: "Football identity strategy",
    supports: (index) => Boolean(index.domainIndexing?.groups.includes("sports.football")),
    resolve: resolveFootballIdentity
  },
  {
    id: "sports.american_football",
    label: "American football identity strategy",
    supports: (index) => Boolean(index.domainIndexing?.groups.includes("sports.american_football")),
    resolve: resolveAmericanFootballIdentity
  }
];

function resolveFootballIdentity(asset: AssetRecord, _index: IndexRecord, timeline: TimelineSegment[], snapshot: KnowledgeSnapshot): StrategyResult {
  const candidates = buildFootballMatchCandidates(snapshot);
  if (candidates.length === 0) {
    return {
      timeline,
      identity: emptyIdentity("skipped", "No football match activities are available for match-context resolution."),
      trace: "sports.football:skipped:no-match-activity"
    };
  }

  const rosterByContext = new Map<string, ActiveRosterWindow[]>();
  const contexts = new Map<string, MatchContext>();
  const playerCandidates: PlayerIdentityCandidate[] = [];
  const assignments: TrackIdentityAssignment[] = [];
  const teamClusterAssignments: TeamClusterAssignment[] = [];
  const nextTimeline = timeline.map((segment) => {
    const scored = scoreFootballMatches(asset, segment, candidates).slice(0, 2);
    const selected = scored.filter((item, index) => item.status !== "unknown" && (index === 0 || item.score >= scored[0].score - 1));
    const clockMappings = extractFootballClockMappings(segment);
    const segmentWindows = selected.flatMap((item) => {
      const context = ensureFootballMatchContext(contexts, item, segment, clockMappings);
      let windows = rosterByContext.get(context.id);
      if (!windows) {
        windows = buildFootballActiveRosterWindows(context.id, item.candidate.activities, snapshot.players);
        rosterByContext.set(context.id, windows);
      }
      return windows.filter((window) => isWindowVisibleForSegment(window, clockMappings[0] ?? null)).slice(0, 40);
    });
    const candidatesForSegment = buildFootballPlayerIdentityCandidates(segment, selected[0] ?? null, clockMappings[0] ?? null, segmentWindows);
    const assignmentsForSegment = candidatesForSegment.filter(isTrackAssignment);
    const teamClusterAssignmentsForSegment = buildTeamClusterAssignments(segment, candidatesForSegment);
    playerCandidates.push(...candidatesForSegment);
    assignments.push(...assignmentsForSegment);
    teamClusterAssignments.push(...teamClusterAssignmentsForSegment);

    const identity: SegmentIdentityContext | undefined =
      selected.length > 0 || clockMappings.length > 0 || candidatesForSegment.length > 0 || teamClusterAssignmentsForSegment.length > 0
        ? {
            matchContextIds: selected.map((item) => footballContextIdForCandidate(item.candidate)),
            clockMappings,
            activeRosterWindows: segmentWindows,
            playerIdentityCandidates: candidatesForSegment,
            trackIdentityAssignments: assignmentsForSegment,
            teamClusterAssignments: teamClusterAssignmentsForSegment
          }
        : undefined;

    return identity ? enrichSegmentWithIdentity(segment, identity, contexts) : segment;
  });

  const identity: AssetIdentityIndex = {
    generatedBy: "sports.football.identity.strategy.v1",
    status: contexts.size > 0 ? "ready" : "partial",
    matchContexts: sortedContexts(contexts),
    activeRosterWindows: Array.from(rosterByContext.values()).flat(),
    playerIdentityCandidates: dedupePlayerCandidates(playerCandidates),
    trackIdentityAssignments: dedupeTrackAssignments(assignments),
    teamClusterAssignments: dedupeTeamClusterAssignments(teamClusterAssignments),
    limitations: [
      "Football match context is inferred from indexed text, OCR, VLM captions, and football registry activity; it is not an official broadcast synchronization feed.",
      "Football player identity remains candidate-level unless match context, clock, roster window, and track evidence all support the assignment.",
      "Kit-color clusters are mapped to teams only when roster-backed player identity evidence connects a track cluster to a known team in the same segment.",
      "Track pitch-zone occupancy is screen-coordinate evidence until homography and team attacking direction are calibrated.",
      "Face identity evidence is accepted only as roster-backed face embedding candidates; generic tracking does not create a stable face identity without a configured player gallery."
    ],
    updatedAt: new Date().toISOString()
  };

  return {
    timeline: nextTimeline,
    identity,
    trace: `sports.football:${identity.matchContexts.length}:${identity.trackIdentityAssignments.length}:candidates=${identity.playerIdentityCandidates.length}`
  };
}

function resolveAmericanFootballIdentity(asset: AssetRecord, _index: IndexRecord, timeline: TimelineSegment[], snapshot: KnowledgeSnapshot): StrategyResult {
  const plays = snapshot.americanFootballPlays ?? [];
  if (plays.length === 0) {
    return {
      timeline,
      identity: emptyIdentity("skipped", "No nflverse play metadata is available for American-football game context resolution.", "sports.american_football.identity.strategy.v1"),
      trace: "sports.american_football:skipped:no-nflverse-plays"
    };
  }

  const games = buildAmericanFootballGameCandidates(snapshot, plays);
  const lookup = buildAmericanFootballLookup(plays);
  const rosterByContext = new Map<string, ActiveRosterWindow[]>();
  const contexts = new Map<string, MatchContext>();
  const playerCandidates: PlayerIdentityCandidate[] = [];
  const assignments: TrackIdentityAssignment[] = [];
  const teamClusterAssignments: TeamClusterAssignment[] = [];
  const nextTimeline = timeline.map((segment) => {
    const scored = scoreAmericanFootballGames(asset, segment, games, lookup).slice(0, 2);
    const selected = scored.filter((item, index) => item.status !== "unknown" && (index === 0 || item.score >= scored[0].score - 1.5));
    const selectedPlay = selected[0]?.play ?? null;
    const clockMappings = dedupeClockMappings([...clockMappingsForAmericanFootballPlay(segment, selectedPlay), ...extractAmericanFootballClockMappings(segment)]).slice(0, 4);
    const segmentWindows = selected.flatMap((item) => {
      const context = ensureAmericanFootballGameContext(contexts, item, segment, clockMappings);
      const windows = buildAmericanFootballParticipantWindows(context.id, item.play ? [item.play] : item.candidate.plays.slice(0, 4), snapshot.players);
      const existing = rosterByContext.get(context.id) ?? [];
      rosterByContext.set(context.id, dedupeRosterWindows([...existing, ...windows]));
      return windows.slice(0, 40);
    });
    const candidatesForSegment = buildAmericanFootballPlayerIdentityCandidates(segment, selected[0] ?? null, clockMappings[0] ?? null, segmentWindows, snapshot.players);
    const assignmentsForSegment = candidatesForSegment.filter(isTrackAssignment);
    const teamClusterAssignmentsForSegment = buildTeamClusterAssignments(segment, candidatesForSegment);
    playerCandidates.push(...candidatesForSegment);
    assignments.push(...assignmentsForSegment);
    teamClusterAssignments.push(...teamClusterAssignmentsForSegment);

    const identity: SegmentIdentityContext | undefined =
      selected.length > 0 || clockMappings.length > 0 || candidatesForSegment.length > 0 || teamClusterAssignmentsForSegment.length > 0
        ? {
            matchContextIds: selected.map((item) => americanFootballContextIdForCandidate(item.candidate)),
            clockMappings,
            activeRosterWindows: segmentWindows,
            playerIdentityCandidates: candidatesForSegment,
            trackIdentityAssignments: assignmentsForSegment,
            teamClusterAssignments: teamClusterAssignmentsForSegment
          }
        : undefined;

    return identity ? enrichSegmentWithIdentity(segment, identity, contexts) : segment;
  });

  const identity: AssetIdentityIndex = {
    generatedBy: "sports.american_football.identity.strategy.v1",
    status: contexts.size > 0 ? "ready" : "partial",
    matchContexts: sortedContexts(contexts),
    activeRosterWindows: Array.from(rosterByContext.values()).flat(),
    playerIdentityCandidates: dedupePlayerCandidates(playerCandidates),
    trackIdentityAssignments: dedupeTrackAssignments(assignments),
    teamClusterAssignments: dedupeTeamClusterAssignments(teamClusterAssignments),
    limitations: [
      "American-football game context uses nflverse play metadata and domain event evidence when available.",
      "A game context can contain many play-level clock mappings because edited videos can splice plays from different games or quarters.",
      "Helmet assignment, contact detection, and stronger ReID outputs can be added as evidence sources without changing the sports base schema."
    ],
    updatedAt: new Date().toISOString()
  };

  return {
    timeline: nextTimeline,
    identity,
    trace: `sports.american_football:${identity.matchContexts.length}:${identity.trackIdentityAssignments.length}:candidates=${identity.playerIdentityCandidates.length}`
  };
}

function emptyIdentity(status: AssetIdentityIndex["status"], reason: string, generatedBy = SPORTS_IDENTITY_RESOLVER_ID): AssetIdentityIndex {
  return {
    generatedBy,
    status,
    matchContexts: [],
    activeRosterWindows: [],
    playerIdentityCandidates: [],
    trackIdentityAssignments: [],
    teamClusterAssignments: [],
    limitations: [reason],
    updatedAt: new Date().toISOString()
  };
}

function combineAssetIdentityIndexes(identities: AssetIdentityIndex[]): AssetIdentityIndex {
  const readyCount = identities.filter((identity) => identity.status === "ready").length;
  const partialCount = identities.filter((identity) => identity.status === "partial").length;
  const matchContexts = dedupeMatchContexts(identities.flatMap((identity) => identity.matchContexts));
  const activeRosterWindows = dedupeRosterWindows(identities.flatMap((identity) => identity.activeRosterWindows));
  const playerIdentityCandidates = dedupePlayerCandidates(identities.flatMap((identity) => identity.playerIdentityCandidates));
  const trackIdentityAssignments = dedupeTrackAssignments(identities.flatMap((identity) => identity.trackIdentityAssignments));
  const teamClusterAssignments = dedupeTeamClusterAssignments(identities.flatMap((identity) => identity.teamClusterAssignments ?? []));
  return {
    generatedBy: SPORTS_IDENTITY_RESOLVER_ID,
    status: readyCount > 0 ? "ready" : partialCount > 0 || matchContexts.length > 0 ? "partial" : "skipped",
    matchContexts,
    activeRosterWindows,
    playerIdentityCandidates,
    trackIdentityAssignments,
    teamClusterAssignments,
    limitations: unique([
      "Sports base resolver orchestrates context, clock, roster, and track identity contracts; sport-specific strategies own event semantics.",
      ...identities.flatMap((identity) => identity.limitations)
    ]),
    updatedAt: new Date().toISOString()
  };
}

function buildFootballMatchCandidates(snapshot: KnowledgeSnapshot): FootballMatchCandidate[] {
  const footballCompetitions = new Set(
    snapshot.competitions.filter((competition) => competition.domainGroup === "sports.football" || competition.sport === "football").map((competition) => competition.value)
  );
  const footballActivities = (snapshot.matchActivities ?? []).filter((activity) => footballCompetitions.has(activity.competition));
  const teamsByName = new Map(snapshot.teams.map((team) => [normalizeText(team.value), team]));
  const grouped = new Map<string, MatchActivity[]>();
  for (const activity of footballActivities) {
    const key = `${activity.provider}:${activity.competition}:${activity.season}:${activity.matchId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), activity]);
  }
  return Array.from(grouped.entries()).map(([id, activities]) => {
    const first = activities[0];
    return {
      id,
      matchId: String(first.matchId),
      provider: first.provider,
      competition: first.competition,
      season: first.season,
      homeTeam: first.homeTeam,
      awayTeam: first.awayTeam,
      activities,
      homeTerms: teamTerms(first.homeTeam, teamsByName),
      awayTerms: teamTerms(first.awayTeam, teamsByName),
      playerNames: unique(activities.map((activity) => activity.player).filter(Boolean))
    };
  });
}

function teamTerms(team: string, teamsByName: Map<string, TeamRecord>) {
  const record = teamsByName.get(normalizeText(team));
  return unique([team, ...(record?.aliases ?? []), ...extractLightKeywords(team)].filter(Boolean));
}

function scoreFootballMatches(asset: AssetRecord, segment: TimelineSegment, candidates: FootballMatchCandidate[]): ScoredFootballMatch[] {
  const text = segmentEvidenceText(segment);
  const normalized = normalizeText(text);
  const weakText = normalizeText(assetMetadataText(asset));
  const clockMappings = extractFootballClockMappings(segment);
  return candidates
    .map((candidate) => scoreFootballMatch(candidate, normalized, weakText, clockMappings))
    .filter((item) => item.score >= 2.5)
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
}

function scoreFootballMatch(candidate: FootballMatchCandidate, normalized: string, weakText: string, clockMappings: MatchClockMapping[]): ScoredFootballMatch {
  let score = 0;
  const evidence: string[] = [];
  const homeStrong = includesAny(normalized, candidate.homeTerms);
  const awayStrong = includesAny(normalized, candidate.awayTerms);
  const homeWeak = !homeStrong && includesAny(weakText, candidate.homeTerms);
  const awayWeak = !awayStrong && includesAny(weakText, candidate.awayTerms);
  if (homeStrong) {
    score += 2.3;
    evidence.push(`Segment text matched home team ${candidate.homeTeam}.`);
  } else if (homeWeak) {
    score += 0.7;
    evidence.push(`Asset metadata matched home team ${candidate.homeTeam}.`);
  }
  if (awayStrong) {
    score += 2.3;
    evidence.push(`Segment text matched away team ${candidate.awayTeam}.`);
  } else if (awayWeak) {
    score += 0.7;
    evidence.push(`Asset metadata matched away team ${candidate.awayTeam}.`);
  }
  if (homeStrong && awayStrong) score += 1.2;

  const matchedPlayers = candidate.playerNames.filter((player) => normalizeText(player).length > 2 && normalized.includes(normalizeText(player))).slice(0, 4);
  if (matchedPlayers.length > 0) {
    score += Math.min(3.2, matchedPlayers.length * 1.2);
    evidence.push(`Segment text matched match player(s): ${matchedPlayers.join(", ")}.`);
  }
  if (normalized.includes(normalizeText(candidate.competition))) {
    score += 0.6;
    evidence.push(`Segment text matched competition ${candidate.competition}.`);
  }
  if (normalized.includes(normalizeText(candidate.season))) {
    score += 0.4;
    evidence.push(`Segment text matched season ${candidate.season}.`);
  }
  if (clockMappings.length > 0) {
    score += 0.5;
    evidence.push(`Clock evidence found: ${clockMappings.map((item) => item.clockText).filter(Boolean).join(", ")}.`);
  }

  const confidence = Number(Math.min(0.96, score / 8).toFixed(2));
  const status: MatchContext["status"] = score >= 6 ? "confirmed" : score >= 3.2 ? "candidate" : "unknown";
  return { candidate, score, confidence, status, evidence };
}

function ensureFootballMatchContext(contexts: Map<string, MatchContext>, scored: ScoredFootballMatch, segment: TimelineSegment, clockMappings: MatchClockMapping[]) {
  const id = footballContextIdForCandidate(scored.candidate);
  const videoRange = {
    start: segment.start,
    end: segment.end,
    confidence: scored.confidence,
    evidence: scored.evidence.slice(0, 4)
  };
  const existing = contexts.get(id);
  if (existing) {
    existing.confidence = Number(Math.max(existing.confidence, scored.confidence).toFixed(2));
    existing.status = existing.status === "confirmed" || scored.status === "confirmed" ? "confirmed" : scored.status;
    existing.evidence = unique([...existing.evidence, ...scored.evidence]).slice(0, 12);
    existing.videoRanges.push(videoRange);
    existing.clockMappings.push(...clockMappings);
    return existing;
  }
  const context: MatchContext = {
    id,
    domainGroup: "sports.football",
    matchId: scored.candidate.matchId,
    provider: scored.candidate.provider,
    competition: scored.candidate.competition,
    season: scored.candidate.season,
    homeTeam: scored.candidate.homeTeam,
    awayTeam: scored.candidate.awayTeam,
    confidence: scored.confidence,
    status: scored.status,
    evidence: scored.evidence.slice(0, 12),
    videoRanges: [videoRange],
    clockMappings: [...clockMappings]
  };
  contexts.set(id, context);
  return context;
}

function buildFootballActiveRosterWindows(matchContextId: string, activities: MatchActivity[], players: KnowledgePlayer[]): ActiveRosterWindow[] {
  const playerByName = new Map(players.filter((player) => player.sport === "football").map((player) => [normalizeText(player.canonical), player]));
  const windows = new Map<string, ActiveRosterWindow>();
  for (const activity of activities) {
    const key = `${normalizeText(activity.team)}:${normalizeText(activity.player)}`;
    const known = playerByName.get(normalizeText(activity.player)) ?? null;
    const current =
      windows.get(key) ??
      ({
        matchContextId,
        playerId: activity.playerId === null ? known?.id ?? null : String(activity.playerId),
        canonicalName: known?.canonical ?? activity.player,
        team: activity.team || null,
        position: known?.position ?? null,
        shirtNumber: known?.shirtNumber ?? null,
        startMinute: null,
        endMinute: null,
        reason: "unknown",
        evidence: []
      } satisfies ActiveRosterWindow);

    if (activity.role === "STARTING") {
      current.startMinute = 0;
      current.reason = "starter";
      current.evidence.push(`${activity.player} listed as starter for ${activity.team}.`);
    } else if (activity.role === "SUB_IN") {
      current.startMinute = activity.minute ?? current.startMinute;
      current.reason = "sub_in";
      current.evidence.push(`${activity.player} substituted in${activity.minute === null ? "" : ` at ${activity.minute}'`}.`);
    } else if (activity.role === "SUB_OUT") {
      current.endMinute = activity.minute ?? current.endMinute;
      if (current.reason === "unknown") current.reason = "sub_out";
      current.evidence.push(`${activity.player} substituted out${activity.minute === null ? "" : ` at ${activity.minute}'`}.`);
    } else if (activity.role === "CARD" && /red/i.test(activity.event)) {
      current.endMinute = activity.minute ?? current.endMinute;
      current.reason = "red_card";
      current.evidence.push(`${activity.player} red card${activity.minute === null ? "" : ` at ${activity.minute}'`}.`);
    } else if (activity.role === "GOAL" || activity.role === "ASSIST" || activity.role === "STAT") {
      if (current.reason === "unknown") current.reason = "event_mentioned";
      current.evidence.push(activity.sourceText);
    }
    windows.set(key, current);
  }
  return dedupeRosterWindows(Array.from(windows.values()));
}

function isWindowVisibleForSegment(window: ActiveRosterWindow, clock: MatchClockMapping | null) {
  const minute = clock?.matchMinuteStart;
  if (minute === null || minute === undefined) return true;
  const start = window.startMinute ?? 0;
  const end = window.endMinute ?? 130;
  return minute >= start && minute <= end;
}

function buildFootballPlayerIdentityCandidates(
  segment: TimelineSegment,
  match: ScoredFootballMatch | null,
  clock: MatchClockMapping | null,
  windows: ActiveRosterWindow[]
): PlayerIdentityCandidate[] {
  if (!match) return [];
  const sources = segmentTextSources(segment);
  const trackId = nearestTrackId(segment);
  const candidates: PlayerIdentityCandidate[] = [];
  for (const source of sources) {
    for (const matched of matchKnowledgePlayers(source.text)) {
      if (matched.value.sport !== "football") continue;
      const window = windows.find((item) => normalizeText(item.canonicalName) === normalizeText(matched.value.canonical));
      if (!window && windows.length > 0) continue;
      const evidence: IdentityEvidenceItem[] = [
        { source: source.source, value: matched.evidence[0] ?? matched.value.canonical, confidence: Math.max(source.confidence, matched.confidence) },
        ...(window ? [{ source: "lineup" as const, value: `${window.canonicalName} active roster window`, confidence: 0.72 }] : []),
        ...(trackId ? [{ source: "mot" as const, value: `Nearest player track ${trackId}`, confidence: segment.sceneData?.vision?.tracking?.continuity ?? 0.5 }, ...visualTrackEvidence(segment, trackId)] : [])
      ];
      candidates.push({
        trackId,
        playerId: window?.playerId ?? matched.value.id,
        canonicalName: matched.value.canonical,
        team: window?.team ?? null,
        shirtNumber: window?.shirtNumber ?? matched.value.shirtNumber ?? null,
        matchContextId: footballContextIdForCandidate(match.candidate),
        videoRange: { start: segment.start, end: segment.end },
        matchClock: clock,
        confidence: footballCandidateConfidence(match, source, Boolean(window), Boolean(trackId), clock),
        status: footballCandidateStatus(match, source, Boolean(window), Boolean(trackId), clock),
        evidence
      });
    }
  }

  for (const jersey of extractJerseyNumberCandidates(segment)) {
    const matchedWindows = windows.filter((window) => window.shirtNumber === jersey.number);
    const jerseyTrackId = jersey.trackId ?? trackId;
    for (const window of matchedWindows) {
      const evidence: IdentityEvidenceItem[] = [
        { source: "jersey_ocr", value: jersey.value, confidence: jersey.confidence },
        { source: "lineup", value: `${window.canonicalName} active roster window`, confidence: 0.72 },
        ...(jerseyTrackId
          ? [
              { source: "mot" as const, value: `Player track ${jerseyTrackId}`, confidence: segment.sceneData?.vision?.tracking?.continuity ?? 0.5 },
              ...visualTrackEvidence(segment, jerseyTrackId)
            ]
          : [])
      ];
      candidates.push({
        trackId: jerseyTrackId,
        playerId: window.playerId,
        canonicalName: window.canonicalName,
        team: window.team,
        shirtNumber: window.shirtNumber,
        matchContextId: footballContextIdForCandidate(match.candidate),
        videoRange: { start: segment.start, end: segment.end },
        matchClock: clock,
        confidence: Number(Math.min(0.92, match.confidence + 0.18 + (jerseyTrackId ? 0.08 : 0) + (jersey.source === "crop_ocr" ? 0.03 : 0)).toFixed(2)),
        status: "candidate",
        evidence
      });
    }
  }

  candidates.push(...buildFootballVisualRosterIdentityCandidates(segment, match, clock, windows));

  return dedupePlayerCandidates(candidates).slice(0, 8);
}

function buildFootballVisualRosterIdentityCandidates(
  segment: TimelineSegment,
  match: ScoredFootballMatch,
  clock: MatchClockMapping | null,
  windows: ActiveRosterWindow[]
): PlayerIdentityCandidate[] {
  const tracks = segment.sceneData?.vision?.tracking?.playerTracks ?? [];
  if (tracks.length === 0 || windows.length === 0) return [];
  const matchContextId = footballContextIdForCandidate(match.candidate);
  const candidates: PlayerIdentityCandidate[] = [];

  for (const track of tracks.slice(0, 10)) {
    const scored = windows
      .map((window) => ({ window, signal: visualRosterSignals(segment, track, window) }))
      .filter(({ signal }) => signal.score >= 0.14 || signal.faceConfidence >= 0.62)
      .sort((a, b) => b.signal.score - a.signal.score || b.signal.faceConfidence - a.signal.faceConfidence)
      .slice(0, 3);

    for (const { window, signal } of scored) {
      const evidence: IdentityEvidenceItem[] = [
        { source: "lineup", value: `${window.canonicalName} active roster candidate${window.position ? ` (${window.position})` : ""}`, confidence: 0.58 },
        { source: "mot", value: `Player track ${track.id}`, confidence: segment.sceneData?.vision?.tracking?.continuity ?? 0.48 },
        ...visualTrackEvidence(segment, track.id),
        ...signal.evidence
      ];
      const faceBoost = signal.faceConfidence >= 0.62 ? signal.faceConfidence * 0.18 : 0;
      const confidence = Number(Math.min(0.91, match.confidence + 0.1 + Math.min(0.18, signal.score) + faceBoost + (clock ? 0.04 : 0)).toFixed(2));
      candidates.push({
        trackId: track.id,
        playerId: window.playerId,
        canonicalName: window.canonicalName,
        team: window.team,
        shirtNumber: window.shirtNumber,
        matchContextId,
        videoRange: { start: segment.start, end: segment.end },
        matchClock: clock,
        confidence,
        status: signal.faceConfidence >= 0.88 && match.status === "confirmed" && clock ? "confirmed" : "candidate",
        evidence
      });
    }
  }

  return candidates;
}

function visualRosterSignals(_segment: TimelineSegment, track: VisionPlayerTrack, window: ActiveRosterWindow): VisualRosterSignal {
  const movementSignal = movementPositionSignal(track, window);
  const faceSignal = faceRosterSignal(track, window);
  return {
    score: Number(Math.min(0.42, movementSignal.score + faceSignal.score).toFixed(3)),
    faceConfidence: faceSignal.faceConfidence,
    evidence: dedupeEvidenceItems([...movementSignal.evidence, ...faceSignal.evidence]).slice(0, 6)
  };
}

function movementPositionSignal(track: VisionPlayerTrack, window: ActiveRosterWindow): VisualRosterSignal {
  const movement = track.movement;
  const group = footballPositionGroup(window.position);
  if (!movement || movement.samples < 2 || group === "unknown") return { score: 0, faceConfidence: 0, evidence: [] };

  const zone = movement.fieldZoneHint;
  const lane = movement.widthLaneHint;
  const zoneShare = zone === "unknown" ? 0 : Math.max(movement.fieldZoneConfidence ?? 0, fieldZoneShare(movement, zone));
  const laneShare = lane === "unknown" ? 0 : Math.max(movement.widthLaneConfidence ?? 0, laneOccupancyShare(movement, lane));
  const speed = movement.speedPerSecond ?? 0;
  const displacement = movement.displacement ?? 0;
  let score = 0;
  const reasons: string[] = [];

  if (group === "goalkeeper") {
    if ((zone === "defensive_third" || zone === "final_third") && zoneShare >= 0.45 && speed <= 0.06 && displacement <= 0.12) {
      score += 0.14;
      reasons.push(`low-movement outer-third occupancy for ${window.position}`);
    }
  } else if (group === "defender") {
    if (zone === "defensive_third") {
      score += 0.12;
      reasons.push(`defensive-third occupancy for ${window.position}`);
    } else if (zone === "middle_third") {
      score += 0.07;
      reasons.push(`middle-third support occupancy for ${window.position}`);
    }
    if (speed <= 0.08) score += 0.02;
  } else if (group === "midfielder") {
    if (zone === "middle_third") {
      score += 0.12;
      reasons.push(`middle-third occupancy for ${window.position}`);
    }
    if (lane === "central" && laneShare >= 0.45) score += 0.03;
  } else if (group === "forward") {
    if (zone === "final_third") {
      score += 0.12;
      reasons.push(`final-third occupancy for ${window.position}`);
    } else if (zone === "middle_third") {
      score += 0.06;
      reasons.push(`middle-to-advanced occupancy for ${window.position}`);
    }
  } else if (group === "wide") {
    if (lane === "far_side" || lane === "near_side") {
      score += 0.11;
      reasons.push(`wide-lane occupancy for ${window.position}`);
    }
    if (zone === "middle_third" || zone === "final_third") score += 0.04;
  }

  if (score <= 0) return { score: 0, faceConfidence: 0, evidence: [] };
  if (zoneShare >= 0.55) score += 0.03;
  const confidence = Math.max(0.4, Math.min(0.62, 0.38 + score + Math.min(0.08, zoneShare * 0.08)));
  const evidence: IdentityEvidenceItem[] = [
    {
      source: "position",
      value: `${window.canonicalName} roster position ${window.position} matched ${reasons.join(", ")}.`,
      confidence: Number(confidence.toFixed(2))
    },
    {
      source: "movement",
      value: `${movementEvidenceLabel(track.id, movement)} ${movement.coordinateMode === "pitch_homography" ? "Pitch homography coordinates are available." : "Screen coordinates are uncalibrated for attacking direction."}`,
      confidence: Number(Math.max(0.36, Math.min(0.58, (zoneShare + laneShare) / 2)).toFixed(2))
    }
  ];
  return { score: Number(Math.min(0.22, score).toFixed(3)), faceConfidence: 0, evidence };
}

function faceRosterSignal(track: VisionPlayerTrack, window: ActiveRosterWindow): VisualRosterSignal {
  const candidates = (track.faceIdentityCandidates ?? [])
    .filter((candidate) => faceCandidateMatchesWindow(candidate, window))
    .sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  if (!best) return { score: 0, faceConfidence: 0, evidence: [] };
  const faceConfidence = Math.max(0, Math.min(0.98, best.confidence));
  const evidence: IdentityEvidenceItem[] = [
    {
      source: "face",
      value: `Roster-backed face embedding candidate matched ${window.canonicalName}${best.frameAt === null ? "" : ` at ${best.frameAt}s`}${best.evidence ? `: ${best.evidence}` : ""}.`,
      confidence: Number(faceConfidence.toFixed(2))
    }
  ];
  return {
    score: faceConfidence >= 0.62 ? Number(Math.min(0.24, faceConfidence * 0.24).toFixed(3)) : 0,
    faceConfidence: Number(faceConfidence.toFixed(3)),
    evidence
  };
}

function faceCandidateMatchesWindow(candidate: NonNullable<VisionPlayerTrack["faceIdentityCandidates"]>[number], window: ActiveRosterWindow) {
  if (candidate.playerId && window.playerId && candidate.playerId === window.playerId) return true;
  if (!candidate.canonicalName) return false;
  return normalizeText(candidate.canonicalName) === normalizeText(window.canonicalName);
}

function footballPositionGroup(position: string | null | undefined): FootballPositionGroup {
  if (!position) return "unknown";
  const normalized = normalizeText(position);
  if (/\b(gk|goalkeeper|keeper)\b/.test(normalized)) return "goalkeeper";
  if (/\b(lw|rw|lm|rm|wb|lwb|rwb|wing|winger|wide|fullback|full back)\b/.test(normalized)) return "wide";
  if (/\b(cb|lb|rb|df|def|defender|centre back|center back|back)\b/.test(normalized)) return "defender";
  if (/\b(dm|cm|am|mf|mid|midfielder)\b/.test(normalized)) return "midfielder";
  if (/\b(fw|st|cf|forward|striker|attacker)\b/.test(normalized)) return "forward";
  return "unknown";
}

function fieldZoneShare(movement: VisionTrackMovementSummary, zone: VisionTrackMovementSummary["fieldZoneHint"]) {
  if (zone === "unknown") return 0;
  return movement.zoneOccupancy.find((item) => item.zone === zone)?.share ?? 0;
}

function laneOccupancyShare(movement: VisionTrackMovementSummary, lane: VisionTrackMovementSummary["widthLaneHint"]) {
  if (lane === "unknown") return 0;
  return movement.laneOccupancy.find((item) => item.lane === lane)?.share ?? 0;
}

function movementEvidenceLabel(trackId: string, movement: VisionTrackMovementSummary) {
  const zoneShare = movement.fieldZoneHint === "unknown" ? 0 : fieldZoneShare(movement, movement.fieldZoneHint);
  const laneShare = movement.widthLaneHint === "unknown" ? 0 : laneOccupancyShare(movement, movement.widthLaneHint);
  return `Track ${trackId} occupied ${movement.fieldZoneHint} ${formatPercent(zoneShare || movement.fieldZoneConfidence)} and ${movement.widthLaneHint} lane ${formatPercent(
    laneShare || movement.widthLaneConfidence
  )}.`;
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function buildTeamClusterAssignments(segment: TimelineSegment, candidates: PlayerIdentityCandidate[]): TeamClusterAssignment[] {
  const tracks = new Map((segment.sceneData?.vision?.tracking?.playerTracks ?? []).map((track) => [track.id, track]));
  const byKey = new Map<string, TeamClusterAssignment>();

  for (const candidate of candidates) {
    if (!candidate.trackId || !candidate.team || candidate.status === "rejected" || candidate.status === "unknown") continue;
    const track = tracks.get(candidate.trackId);
    if (!track?.teamCluster || track.teamCluster === "unknown") continue;

    const teamConfidence = track.teamConfidence ?? 0.42;
    const confidence = Number(Math.min(0.88, candidate.confidence * 0.66 + teamConfidence * 0.34).toFixed(2));
    const key = `${candidate.matchContextId ?? "unknown"}:${track.teamCluster}:${candidate.team}:${candidate.videoRange.start}:${candidate.videoRange.end}`;
    const evidence: IdentityEvidenceItem[] = [
      ...visualTrackEvidence(segment, candidate.trackId),
      {
        source: "knowledge",
        value: `${candidate.canonicalName ?? candidate.playerId ?? "Unknown player"} roster-backed team ${candidate.team}`,
        confidence: Math.min(0.82, candidate.confidence)
      }
    ];
    const existing = byKey.get(key);
    if (!existing || confidence > existing.confidence) {
      byKey.set(key, {
        cluster: track.teamCluster,
        team: candidate.team,
        matchContextId: candidate.matchContextId,
        videoRange: candidate.videoRange,
        confidence,
        status: candidate.status === "confirmed" && confidence >= 0.72 ? "confirmed" : "candidate",
        evidence
      });
    } else {
      existing.evidence = dedupeEvidenceItems([...existing.evidence, ...evidence]).slice(0, 8);
    }
  }

  const distinctTeamsByCluster = new Map<string, Set<string>>();
  for (const assignment of byKey.values()) {
    const key = `${assignment.matchContextId ?? "unknown"}:${assignment.cluster}:${assignment.videoRange.start}:${assignment.videoRange.end}`;
    distinctTeamsByCluster.set(key, new Set([...(distinctTeamsByCluster.get(key) ?? []), assignment.team ?? "unknown"]));
  }

  return Array.from(byKey.values())
    .map((assignment) => {
      const ambiguityKey = `${assignment.matchContextId ?? "unknown"}:${assignment.cluster}:${assignment.videoRange.start}:${assignment.videoRange.end}`;
      const ambiguous = (distinctTeamsByCluster.get(ambiguityKey)?.size ?? 0) > 1;
      if (!ambiguous) return assignment;
      return {
        ...assignment,
        confidence: Number(Math.max(0.2, assignment.confidence * 0.72).toFixed(2)),
        status: "candidate" as const,
        evidence: dedupeEvidenceItems([
          ...assignment.evidence,
          {
            source: "knowledge",
            value: `Cluster ${assignment.cluster} has competing team candidates in this segment.`,
            confidence: 0.42
          }
        ]).slice(0, 8)
      };
    })
    .sort((a, b) => b.confidence - a.confidence || a.cluster.localeCompare(b.cluster) || (a.team ?? "").localeCompare(b.team ?? ""));
}

function footballCandidateConfidence(match: ScoredFootballMatch, source: { source: IdentityEvidenceItem["source"]; confidence: number }, hasWindow: boolean, hasTrack: boolean, clock: MatchClockMapping | null) {
  let confidence = 0.3 + match.confidence * 0.22 + source.confidence * 0.22;
  if (hasWindow) confidence += 0.12;
  if (hasTrack) confidence += 0.08;
  if (clock?.matchMinuteStart !== null && clock?.matchMinuteStart !== undefined) confidence += 0.08;
  if (source.source === "ocr" || source.source === "asr") confidence += 0.05;
  if (source.source === "title" || source.source === "metadata") confidence -= 0.12;
  return Number(Math.max(0, Math.min(0.93, confidence)).toFixed(2));
}

function footballCandidateStatus(
  match: ScoredFootballMatch,
  source: { source: IdentityEvidenceItem["source"] },
  hasWindow: boolean,
  hasTrack: boolean,
  clock: MatchClockMapping | null
): PlayerIdentityCandidate["status"] {
  const strongText = source.source === "asr" || source.source === "ocr" || source.source === "vlm";
  if (match.status === "confirmed" && strongText && hasWindow && hasTrack && clock) return "confirmed";
  if (match.status !== "unknown" && (strongText || hasWindow)) return "candidate";
  return "unknown";
}

function buildAmericanFootballGameCandidates(snapshot: KnowledgeSnapshot, plays: AmericanFootballPlay[]): AmericanFootballGameCandidate[] {
  const teamsByName = new Map(snapshot.teams.map((team) => [normalizeText(team.value), team]));
  const grouped = new Map<string, AmericanFootballPlay[]>();
  for (const play of plays) {
    grouped.set(play.gameId, [...(grouped.get(play.gameId) ?? []), play]);
  }
  return Array.from(grouped.values()).map((gamePlays) => {
    const first = gamePlays[0];
    const homeTerms = teamTerms(first.homeTeam, teamsByName);
    const awayTerms = teamTerms(first.awayTeam, teamsByName);
    const playTeamTerms = unique(gamePlays.flatMap((play) => [play.possessionTeam, play.defensiveTeam, play.homeTeam, play.awayTeam].flatMap((team) => footballTeamTerms(team))).filter(Boolean));
    return {
      id: `nflverse:${first.season}:${first.gameId}`,
      gameId: first.gameId,
      provider: "nflverse",
      competition: "NFL",
      season: first.season,
      week: first.week,
      homeTeam: first.homeTeam,
      awayTeam: first.awayTeam,
      plays: gamePlays,
      homeTerms,
      awayTerms,
      teamTerms: unique([...homeTerms, ...awayTerms, ...playTeamTerms]),
      playerNames: unique(gamePlays.flatMap((play) => [play.passerPlayerName, play.rusherPlayerName, play.receiverPlayerName]).filter((name): name is string => Boolean(name)))
    };
  });
}

function buildAmericanFootballLookup(plays: AmericanFootballPlay[]): AmericanFootballLookup {
  const lookup: AmericanFootballLookup = {
    byPlayKey: new Map(),
    byGameId: new Map(),
    byTerm: new Map()
  };
  for (const play of plays) {
    lookup.byPlayKey.set(americanFootballPlayKey(play.gameId, play.playId), play);
    lookup.byGameId.set(play.gameId, [...(lookup.byGameId.get(play.gameId) ?? []), play]);
    const terms = unique([
      play.season,
      play.gameId,
      play.playId,
      play.playType,
      play.down === null || play.distance === null ? "" : `${play.down} and ${play.distance}`,
      play.yardline ?? "",
      ...footballTeamTerms(play.homeTeam),
      ...footballTeamTerms(play.awayTeam),
      ...footballTeamTerms(play.possessionTeam),
      ...footballTeamTerms(play.defensiveTeam),
      ...playerNameTerms(play.passerPlayerName),
      ...playerNameTerms(play.rusherPlayerName),
      ...playerNameTerms(play.receiverPlayerName),
      ...textTerms(play.description).filter((term) => term.length >= 5).slice(0, 18)
    ]);
    for (const term of terms) addToMap(lookup.byTerm, normalizeText(term), play);
  }
  return lookup;
}

function scoreAmericanFootballGames(asset: AssetRecord, segment: TimelineSegment, games: AmericanFootballGameCandidate[], lookup: AmericanFootballLookup): ScoredAmericanFootballGame[] {
  const text = [assetMetadataText(asset), segmentEvidenceText(segment)].join(" ");
  const normalized = normalizeText(text);
  const domainMetadata = americanFootballPlayMetadataFromSegment(segment);
  const candidatePlays = candidateAmericanFootballPlays(segment, normalized, domainMetadata, lookup);
  const gameIds = new Set(candidatePlays.map((play) => play.gameId));
  for (const metadata of domainMetadata) {
    if (metadata.gameId) gameIds.add(metadata.gameId);
  }
  const candidateGames = games.filter((game) => gameIds.has(game.gameId) || game.teamTerms.some((term) => normalized.includes(normalizeText(term)))).slice(0, 200);
  return candidateGames
    .map((candidate) => scoreAmericanFootballGame(candidate, normalized, domainMetadata, candidatePlays))
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score || a.candidate.gameId.localeCompare(b.candidate.gameId));
}

function candidateAmericanFootballPlays(
  segment: TimelineSegment,
  normalized: string,
  domainMetadata: Array<NonNullable<NonNullable<DomainEvent["americanFootball"]>["playMetadata"]>>,
  lookup: AmericanFootballLookup
) {
  const plays = new Map<string, AmericanFootballPlay>();
  for (const metadata of domainMetadata) {
    if (metadata.gameId && metadata.playId) {
      const play = lookup.byPlayKey.get(americanFootballPlayKey(metadata.gameId, metadata.playId));
      if (play) plays.set(americanFootballPlayKey(play.gameId, play.playId), play);
    } else if (metadata.gameId) {
      for (const play of lookup.byGameId.get(metadata.gameId) ?? []) plays.set(americanFootballPlayKey(play.gameId, play.playId), play);
    }
  }
  for (const term of textTerms(normalized).slice(0, 80)) {
    for (const play of lookup.byTerm.get(term) ?? []) {
      plays.set(americanFootballPlayKey(play.gameId, play.playId), play);
      if (plays.size > 1500) break;
    }
    if (plays.size > 1500) break;
  }
  const eventPlayIds = new Set(
    (segment.domain?.events ?? [])
      .map((event) => event.americanFootball?.tracking?.playId ?? event.americanFootball?.playMetadata?.playId ?? null)
      .filter((value): value is string => Boolean(value))
  );
  for (const play of lookup.byPlayKey.values()) {
    if (eventPlayIds.has(play.playId)) plays.set(americanFootballPlayKey(play.gameId, play.playId), play);
  }
  return Array.from(plays.values());
}

function scoreAmericanFootballGame(
  candidate: AmericanFootballGameCandidate,
  normalized: string,
  domainMetadata: Array<NonNullable<NonNullable<DomainEvent["americanFootball"]>["playMetadata"]>>,
  candidatePlays: AmericanFootballPlay[]
): ScoredAmericanFootballGame {
  let score = 0;
  const evidence: string[] = [];
  const metadataMatch = domainMetadata.find((metadata) => metadata.gameId === candidate.gameId);
  if (metadataMatch) {
    score += metadataMatch.playId ? 7 : 5;
    evidence.push(`Domain event play metadata matched gameId=${candidate.gameId}${metadataMatch.playId ? ` playId=${metadataMatch.playId}` : ""}.`);
  }
  if (includesAny(normalized, candidate.homeTerms)) {
    score += 1.3;
    evidence.push(`Segment text matched home team ${candidate.homeTeam}.`);
  }
  if (includesAny(normalized, candidate.awayTerms)) {
    score += 1.3;
    evidence.push(`Segment text matched away team ${candidate.awayTeam}.`);
  }
  const matchedPlayers = candidate.playerNames.filter((player) => playerNameScore(normalized, player) > 0).slice(0, 4);
  if (matchedPlayers.length > 0) {
    score += Math.min(4.5, matchedPlayers.length * 1.5);
    evidence.push(`Segment text matched NFL player(s): ${matchedPlayers.join(", ")}.`);
  }
  const downDistance = parseAmericanFootballDownDistance(normalized);
  if (downDistance && candidate.plays.some((play) => play.down === downDistance.down && play.distance === downDistance.distance)) {
    score += 2.2;
    evidence.push(`Down-distance matched ${downDistance.down} and ${downDistance.distance}.`);
  }
  const clock = parseAmericanFootballClock(normalized)[0] ?? null;
  if (clock && candidate.plays.some((play) => play.quarter === clock.quarter)) {
    score += 0.8;
    evidence.push(`Quarter clock evidence found: Q${clock.quarter} ${clock.clock}.`);
  }
  const candidatePlay = selectAmericanFootballPlay(candidate, normalized, domainMetadata, candidatePlays, downDistance, clock);
  if (candidatePlay) {
    score += candidatePlay.scoreBonus;
    evidence.push(...candidatePlay.evidence);
  }
  const confidence = Number(Math.min(0.96, score / 10).toFixed(2));
  const status: MatchContext["status"] = score >= 7 ? "confirmed" : score >= 4 ? "candidate" : "unknown";
  return { candidate, play: candidatePlay?.play ?? null, score, confidence, status, evidence: unique(evidence).slice(0, 12) };
}

function selectAmericanFootballPlay(
  candidate: AmericanFootballGameCandidate,
  normalized: string,
  domainMetadata: Array<NonNullable<NonNullable<DomainEvent["americanFootball"]>["playMetadata"]>>,
  candidatePlays: AmericanFootballPlay[],
  downDistance: { down: number; distance: number } | null,
  clock: { quarter: number; clock: string } | null
) {
  let best: { play: AmericanFootballPlay; score: number; scoreBonus: number; evidence: string[] } | null = null;
  const gamePlays = candidatePlays.filter((play) => play.gameId === candidate.gameId);
  const plays = gamePlays.length > 0 ? gamePlays : candidate.plays.slice(0, 120);
  for (const play of plays) {
    let score = 0;
    const evidence: string[] = [];
    const metadata = domainMetadata.find((item) => item.gameId === play.gameId && item.playId === play.playId);
    if (metadata) {
      score += 8;
      evidence.push(`Exact play metadata matched playId=${play.playId}.`);
    }
    for (const name of [play.passerPlayerName, play.rusherPlayerName, play.receiverPlayerName]) {
      const nameScore = playerNameScore(normalized, name);
      if (nameScore > 0) {
        score += nameScore;
        evidence.push(`Player mention matched ${name}.`);
      }
    }
    if (downDistance && play.down === downDistance.down && play.distance === downDistance.distance) {
      score += 3;
      evidence.push(`Play down-distance matched ${downDistance.down} and ${downDistance.distance}.`);
    }
    if (clock && play.quarter === clock.quarter && (!play.clock || play.clock === clock.clock)) {
      score += play.clock === clock.clock ? 3 : 1;
      evidence.push(`Play clock matched Q${clock.quarter}${play.clock ? ` ${play.clock}` : ""}.`);
    }
    const overlap = termOverlap(textTerms(normalized), textTerms(play.description));
    if (overlap > 0) score += Math.min(2.5, overlap * 0.25);
    if (!best || score > best.score) best = { play, score, scoreBonus: Math.min(3, score * 0.25), evidence };
  }
  return best && best.score >= 3 ? best : null;
}

function ensureAmericanFootballGameContext(contexts: Map<string, MatchContext>, scored: ScoredAmericanFootballGame, segment: TimelineSegment, clockMappings: MatchClockMapping[]) {
  const id = americanFootballContextIdForCandidate(scored.candidate);
  const play = scored.play;
  const videoRange = {
    start: segment.start,
    end: segment.end,
    confidence: scored.confidence,
    evidence: scored.evidence.slice(0, 4)
  };
  const existing = contexts.get(id);
  if (existing) {
    existing.confidence = Number(Math.max(existing.confidence, scored.confidence).toFixed(2));
    existing.status = existing.status === "confirmed" || scored.status === "confirmed" ? "confirmed" : scored.status;
    existing.evidence = unique([...existing.evidence, ...scored.evidence]).slice(0, 12);
    existing.videoRanges.push(videoRange);
    existing.clockMappings.push(...clockMappings);
    if (!existing.playId && play?.playId) existing.playId = play.playId;
    return existing;
  }
  const context: MatchContext = {
    id,
    domainGroup: "sports.american_football",
    matchId: scored.candidate.gameId,
    gameId: scored.candidate.gameId,
    playId: play?.playId ?? null,
    provider: "nflverse",
    competition: "NFL",
    season: scored.candidate.season,
    week: scored.candidate.week,
    homeTeam: scored.candidate.homeTeam,
    awayTeam: scored.candidate.awayTeam,
    down: play?.down ?? null,
    distance: play?.distance ?? null,
    yardline: play?.yardline ?? null,
    yardline100: play?.yardline100 ?? null,
    confidence: scored.confidence,
    status: scored.status,
    evidence: scored.evidence.slice(0, 12),
    videoRanges: [videoRange],
    clockMappings: [...clockMappings]
  };
  contexts.set(id, context);
  return context;
}

function buildAmericanFootballParticipantWindows(matchContextId: string, plays: AmericanFootballPlay[], players: KnowledgePlayer[]): ActiveRosterWindow[] {
  const playerById = new Map(players.filter((player) => player.sport === "american_football").map((player) => [player.id, player]));
  const playerByName = new Map(players.filter((player) => player.sport === "american_football").map((player) => [normalizeText(player.canonical), player]));
  const windows: ActiveRosterWindow[] = [];
  for (const play of plays) {
    for (const participant of americanFootballPlayParticipants(play)) {
      const known = (participant.playerId ? playerById.get(participant.playerId) : null) ?? (participant.name ? playerByName.get(normalizeText(participant.name)) : null) ?? null;
      windows.push({
        matchContextId,
        playerId: participant.playerId ?? known?.id ?? null,
        canonicalName: known?.canonical ?? participant.name ?? "Unknown player",
        team: participant.team,
        position: known?.position ?? null,
        shirtNumber: known?.shirtNumber ?? null,
        startMinute: play.quarter && play.clock ? elapsedGameMinute(play.quarter, play.clock) : null,
        endMinute: play.quarter && play.clock ? elapsedGameMinute(play.quarter, play.clock) : null,
        reason: "play_participant",
        evidence: [`${participant.role} in nflverse gameId=${play.gameId} playId=${play.playId}.`]
      });
    }
  }
  return dedupeRosterWindows(windows);
}

function buildAmericanFootballPlayerIdentityCandidates(
  segment: TimelineSegment,
  scored: ScoredAmericanFootballGame | null,
  clock: MatchClockMapping | null,
  windows: ActiveRosterWindow[],
  players: KnowledgePlayer[]
): PlayerIdentityCandidate[] {
  if (!scored) return [];
  const play = scored.play;
  const contextId = americanFootballContextIdForCandidate(scored.candidate);
  const eventParticipants = americanFootballEventParticipants(segment);
  const participants = eventParticipants.length > 0 ? eventParticipants : play ? americanFootballPlayParticipants(play) : [];
  const playersById = new Map(players.filter((player) => player.sport === "american_football").map((player) => [player.id, player]));
  const playersByName = new Map(players.filter((player) => player.sport === "american_football").map((player) => [normalizeText(player.canonical), player]));
  const trackId = nearestTrackId(segment);
  const quarterbackTrackId = segment.domain?.events.find((event) => event.americanFootball?.quarterback.trackId)?.americanFootball?.quarterback.trackId ?? null;
  const sources = segmentTextSources(segment);
  const text = normalizeText(sources.map((source) => source.text).join(" "));
  const candidates: PlayerIdentityCandidate[] = [];

  for (const participant of participants) {
    const known = (participant.playerId ? playersById.get(participant.playerId) : null) ?? (participant.name ? playersByName.get(normalizeText(participant.name)) : null) ?? null;
    const window = windows.find((item) => item.playerId === participant.playerId || (participant.name && normalizeText(item.canonicalName) === normalizeText(participant.name)));
    const participantTrack = participant.trackId ?? (participant.role === "passer" || participant.role === "quarterback" ? quarterbackTrackId ?? trackId : null);
    const name = known?.canonical ?? participant.name ?? window?.canonicalName ?? null;
    const evidence: IdentityEvidenceItem[] = [
      { source: participant.source === "helmet_assignment" ? "helmet_assignment" : participant.source === "tracking" ? "mot" : "play_metadata", value: `${participant.role} ${name ?? participant.playerId ?? "unknown"}`, confidence: participant.confidence },
      ...(window ? [{ source: "play_metadata" as const, value: `${window.canonicalName} play participant window`, confidence: 0.76 }] : []),
      ...(participantTrack ? [{ source: "mot" as const, value: `Track ${participantTrack}`, confidence: segment.sceneData?.vision?.tracking?.continuity ?? 0.55 }, ...visualTrackEvidence(segment, participantTrack)] : [])
    ];
    const strongText = Boolean(name && playerNameScore(text, name) > 0);
    candidates.push({
      trackId: participantTrack,
      playerId: participant.playerId ?? known?.id ?? window?.playerId ?? null,
      canonicalName: name,
      team: participant.team ?? window?.team ?? null,
      shirtNumber: known?.shirtNumber ?? window?.shirtNumber ?? null,
      matchContextId: contextId,
      videoRange: { start: segment.start, end: segment.end },
      matchClock: clock,
      confidence: americanFootballCandidateConfidence(scored, Boolean(participantTrack), Boolean(window), strongText),
      status: americanFootballCandidateStatus(scored, Boolean(participantTrack), Boolean(window), strongText, participant.source),
      evidence
    });
  }

  for (const source of sources) {
    for (const matched of matchKnowledgePlayers(source.text)) {
      if (matched.value.sport !== "american_football") continue;
      const window = windows.find((item) => normalizeText(item.canonicalName) === normalizeText(matched.value.canonical));
      if (!window && windows.length > 0) continue;
      candidates.push({
        trackId,
        playerId: window?.playerId ?? matched.value.id,
        canonicalName: matched.value.canonical,
        team: window?.team ?? null,
        shirtNumber: window?.shirtNumber ?? matched.value.shirtNumber ?? null,
        matchContextId: contextId,
        videoRange: { start: segment.start, end: segment.end },
        matchClock: clock,
        confidence: Number(Math.min(0.88, scored.confidence + source.confidence * 0.15 + (window ? 0.08 : 0) + (trackId ? 0.04 : 0)).toFixed(2)),
        status: scored.status === "confirmed" && window && trackId ? "candidate" : "candidate",
        evidence: [
          { source: source.source, value: matched.evidence[0] ?? matched.value.canonical, confidence: Math.max(source.confidence, matched.confidence) },
          ...(window ? [{ source: "play_metadata" as const, value: `${window.canonicalName} play participant window`, confidence: 0.76 }] : []),
          ...(trackId ? [{ source: "mot" as const, value: `Nearest player track ${trackId}`, confidence: segment.sceneData?.vision?.tracking?.continuity ?? 0.5 }, ...visualTrackEvidence(segment, trackId)] : [])
        ]
      });
    }
  }

  return dedupePlayerCandidates(candidates).slice(0, 10);
}

function americanFootballCandidateConfidence(scored: ScoredAmericanFootballGame, hasTrack: boolean, hasWindow: boolean, strongText: boolean) {
  let confidence = 0.34 + scored.confidence * 0.32;
  if (scored.play) confidence += 0.12;
  if (hasWindow) confidence += 0.08;
  if (hasTrack) confidence += 0.08;
  if (strongText) confidence += 0.08;
  return Number(Math.max(0, Math.min(0.94, confidence)).toFixed(2));
}

function americanFootballCandidateStatus(
  scored: ScoredAmericanFootballGame,
  hasTrack: boolean,
  hasWindow: boolean,
  strongText: boolean,
  source: string
): PlayerIdentityCandidate["status"] {
  const detectorBacked = source === "helmet_assignment" || source === "tracking" || source === "mot";
  if (scored.status === "confirmed" && scored.play && hasTrack && hasWindow && (strongText || detectorBacked)) return "confirmed";
  if (scored.status !== "unknown" && (scored.play || hasWindow || strongText)) return "candidate";
  return "unknown";
}

function americanFootballPlayMetadataFromSegment(segment: TimelineSegment): Array<NonNullable<NonNullable<DomainEvent["americanFootball"]>["playMetadata"]>> {
  return (segment.domain?.events ?? []).map((event) => event.americanFootball?.playMetadata).filter((metadata): metadata is NonNullable<NonNullable<DomainEvent["americanFootball"]>["playMetadata"]> => Boolean(metadata));
}

function americanFootballEventParticipants(segment: TimelineSegment): Array<{
  role: "quarterback" | "rusher" | "receiver" | "passer" | "tackler" | "contact" | "unknown";
  playerId: string | null;
  name: string | null;
  team: string | null;
  trackId: string | null;
  confidence: number;
  source: "play_metadata" | "helmet_assignment" | "tracking" | "asr" | "ocr" | "vlm" | "unknown";
}> {
  const participants = (segment.domain?.events ?? []).flatMap((event) => event.americanFootball?.participants ?? []);
  return participants.map((participant) => ({
    role: participant.role,
    playerId: participant.playerId,
    name: participant.name,
    team: participant.team,
    trackId: participant.trackId,
    confidence: participant.confidence,
    source: participant.source === "nflverse" ? "play_metadata" : participant.source
  }));
}

function americanFootballPlayParticipants(play: AmericanFootballPlay): Array<{
  role: "passer" | "rusher" | "receiver";
  playerId: string | null;
  name: string | null;
  team: string | null;
  trackId: string | null;
  confidence: number;
  source: "play_metadata";
}> {
  return [
    { role: "passer", playerId: play.passerPlayerId, name: play.passerPlayerName, team: play.possessionTeam, trackId: null, confidence: 0.78, source: "play_metadata" },
    { role: "rusher", playerId: play.rusherPlayerId, name: play.rusherPlayerName, team: play.possessionTeam, trackId: null, confidence: 0.76, source: "play_metadata" },
    { role: "receiver", playerId: play.receiverPlayerId, name: play.receiverPlayerName, team: play.possessionTeam, trackId: null, confidence: 0.76, source: "play_metadata" }
  ].filter((participant) => Boolean(participant.playerId || participant.name)) as Array<{
    role: "passer" | "rusher" | "receiver";
    playerId: string | null;
    name: string | null;
    team: string | null;
    trackId: string | null;
    confidence: number;
    source: "play_metadata";
  }>;
}

function clockMappingsForAmericanFootballPlay(segment: TimelineSegment, play: AmericanFootballPlay | null): MatchClockMapping[] {
  if (!play?.quarter || !play.clock) return [];
  const elapsed = elapsedGameMinute(play.quarter, play.clock);
  return [
    {
      videoStart: segment.start,
      videoEnd: segment.end,
      period: quarterPeriod(play.quarter),
      matchMinuteStart: elapsed,
      matchMinuteEnd: elapsed === null ? null : Number(Math.min(75, elapsed + Math.max(0, segment.end - segment.start) / 60).toFixed(2)),
      clockText: `Q${play.quarter} ${play.clock}`,
      source: "play_metadata",
      confidence: 0.86,
      evidence: [`nflverse game clock: Q${play.quarter} ${play.clock}`]
    }
  ];
}

function extractAmericanFootballClockMappings(segment: TimelineSegment): MatchClockMapping[] {
  const mappings: MatchClockMapping[] = [];
  for (const source of segmentTextSources(segment)) {
    if (source.source !== "ocr" && source.source !== "asr" && source.source !== "vlm" && source.source !== "event_metadata") continue;
    for (const clock of parseAmericanFootballClock(source.text)) {
      const elapsed = elapsedGameMinute(clock.quarter, clock.clock);
      mappings.push({
        videoStart: segment.start,
        videoEnd: segment.end,
        period: quarterPeriod(clock.quarter),
        matchMinuteStart: elapsed,
        matchMinuteEnd: elapsed === null ? null : Number(Math.min(75, elapsed + Math.max(0, segment.end - segment.start) / 60).toFixed(2)),
        clockText: `Q${clock.quarter} ${clock.clock}`,
        source: source.source,
        confidence: source.source === "ocr" ? 0.72 : source.source === "asr" ? 0.62 : 0.58,
        evidence: [`${source.source.toUpperCase()} football clock cue: Q${clock.quarter} ${clock.clock}`]
      });
    }
  }
  return dedupeClockMappings(mappings);
}

function parseAmericanFootballClock(text: string) {
  const values: Array<{ quarter: number; clock: string }> = [];
  const normalized = text.replace(/[’′]/g, "'").replace(/\s+/g, " ");
  for (const match of normalized.matchAll(/\bQ\s*([1-4])\s*[-:]?\s*([0-9]{1,2}:[0-5]\d)\b/gi)) {
    values.push({ quarter: Number(match[1]), clock: normalizeGameClock(match[2]) });
  }
  for (const match of normalized.matchAll(/\b([1-4])(?:st|nd|rd|th)\s+quarter\b.{0,24}?\b([0-9]{1,2}:[0-5]\d)\b/gi)) {
    values.push({ quarter: Number(match[1]), clock: normalizeGameClock(match[2]) });
  }
  for (const match of normalized.matchAll(/\bquarter\s+([1-4])\b.{0,24}?\b([0-9]{1,2}:[0-5]\d)\b/gi)) {
    values.push({ quarter: Number(match[1]), clock: normalizeGameClock(match[2]) });
  }
  return uniqueBy(values.filter((item) => item.quarter >= 1 && item.quarter <= 4), (item) => `${item.quarter}:${item.clock}`);
}

function parseAmericanFootballDownDistance(text: string) {
  const match = text.match(/\b([1-4])(?:st|nd|rd|th)?\s*(?:and|&)\s*(\d{1,2})\b/);
  if (!match) return null;
  return { down: Number(match[1]), distance: Number(match[2]) };
}

function extractFootballClockMappings(segment: TimelineSegment): MatchClockMapping[] {
  const mappings: MatchClockMapping[] = [];
  for (const source of segmentTextSources(segment)) {
    if (source.source !== "ocr" && source.source !== "asr" && source.source !== "vlm") continue;
    for (const clock of parseFootballClockTexts(source.text)) {
      mappings.push({
        videoStart: segment.start,
        videoEnd: segment.end,
        period: footballPeriodForMinute(clock.minute),
        matchMinuteStart: clock.minute,
        matchMinuteEnd: Number(Math.min(130, clock.minute + Math.max(0, segment.end - segment.start) / 60).toFixed(2)),
        clockText: clock.text,
        source: source.source,
        confidence: source.source === "ocr" ? 0.72 : source.source === "asr" ? 0.62 : 0.58,
        evidence: [`${source.source.toUpperCase()} clock cue: ${clock.text}`]
      });
    }
  }
  return dedupeClockMappings(mappings).slice(0, 4);
}

function parseFootballClockTexts(text: string) {
  const values: Array<{ minute: number; text: string }> = [];
  const normalized = text.replace(/[’′]/g, "'");
  for (const match of normalized.matchAll(/\b(45|90|105|120)\s*\+\s*(\d{1,2})\b/g)) {
    const minute = Number(match[1]) + Number(match[2]);
    values.push({ minute, text: match[0] });
  }
  for (const match of normalized.matchAll(/\b([1-9]\d?|1[01]\d|120)\s*(?:'|min(?:ute)?s?|분)\b/gi)) {
    values.push({ minute: Number(match[1]), text: match[0] });
  }
  for (const match of normalized.matchAll(/\b([1-9]\d?|1[01]\d|120)(?:st|nd|rd|th)\s+minute\b/gi)) {
    values.push({ minute: Number(match[1]), text: match[0] });
  }
  for (const match of normalized.matchAll(/\b([0-9]{1,2}):([0-5]\d)\b/g)) {
    const minute = Number(match[1]);
    if (minute <= 59) values.push({ minute, text: match[0] });
  }
  return values.filter((item) => item.minute >= 0 && item.minute <= 130);
}

function footballPeriodForMinute(minute: number): MatchClockMapping["period"] {
  if (minute <= 45) return "1H";
  if (minute <= 90) return "2H";
  if (minute <= 105) return "ET1";
  if (minute <= 120) return "ET2";
  return "unknown";
}

function quarterPeriod(quarter: number): MatchClockMapping["period"] {
  if (quarter === 1) return "Q1";
  if (quarter === 2) return "Q2";
  if (quarter === 3) return "Q3";
  if (quarter === 4) return "Q4";
  return "OT";
}

function elapsedGameMinute(quarter: number, clock: string | null) {
  if (!clock) return null;
  const [minute, second] = clock.split(":").map(Number);
  if (!Number.isFinite(minute) || !Number.isFinite(second)) return null;
  return Number(((quarter - 1) * 15 + Math.max(0, 15 - minute - second / 60)).toFixed(2));
}

function normalizeGameClock(clock: string) {
  const [minute, second] = clock.split(":");
  return `${Number(minute)}:${second.padStart(2, "0")}`;
}

function enrichSegmentWithIdentity(segment: TimelineSegment, identity: SegmentIdentityContext, contexts: Map<string, MatchContext>): TimelineSegment {
  const merged = mergeSegmentIdentity(segment.identity, identity);
  const contextText = identity.matchContextIds
    .map((id) => contexts.get(id))
    .filter((context): context is MatchContext => Boolean(context))
    .map((context) =>
      [
        `Match context: ${context.homeTeam} vs ${context.awayTeam}`,
        context.competition,
        context.season,
        context.status,
        context.gameId ? `gameId ${context.gameId}` : "",
        context.playId ? `playId ${context.playId}` : "",
        context.down ? `down ${context.down}` : "",
        context.distance ? `distance ${context.distance}` : "",
        context.yardline ? `yardline ${context.yardline}` : ""
      ]
        .filter(Boolean)
        .join(" ")
    )
    .join(" ");
  const clockText = identity.clockMappings.map((clock) => `Match clock: ${clock.period} ${clock.clockText ?? `${clock.matchMinuteStart}'`}.`).join(" ");
  const candidateText = identity.playerIdentityCandidates
    .map((candidate) => `Player identity ${candidate.status}: ${candidate.canonicalName ?? "unknown"}${candidate.trackId ? ` track ${candidate.trackId}` : ""}.`)
    .join(" ");
  const clusterText = (identity.teamClusterAssignments ?? [])
    .map((assignment) => `Team cluster ${assignment.status}: ${assignment.cluster} -> ${assignment.team ?? "unknown"}.`)
    .join(" ");
  const searchText = [segment.domain?.searchText, contextText, clockText, candidateText, clusterText].filter(Boolean).join(" ");
  const tags = extractLightKeywords([contextText, clockText, candidateText, clusterText].join(" ")).slice(0, 16);
  return {
    ...segment,
    identity: merged,
    domain: segment.domain ? { ...segment.domain, searchText } : segment.domain,
    tags: unique([
      ...segment.tags,
      ...tags,
      ...identity.playerIdentityCandidates.flatMap((candidate) => (candidate.canonicalName ? [`player.${normalizeLabel(candidate.canonicalName)}`] : [])),
      ...(identity.teamClusterAssignments ?? []).flatMap((assignment) => (assignment.team ? [`team.${normalizeLabel(assignment.team)}`, `kit.${assignment.cluster}`] : []))
    ]).slice(0, 48)
  };
}

function mergeSegmentIdentity(existing: SegmentIdentityContext | undefined, next: SegmentIdentityContext): SegmentIdentityContext {
  if (!existing) return next;
  return {
    matchContextIds: unique([...existing.matchContextIds, ...next.matchContextIds]),
    clockMappings: dedupeClockMappings([...existing.clockMappings, ...next.clockMappings]),
    activeRosterWindows: dedupeRosterWindows([...existing.activeRosterWindows, ...next.activeRosterWindows]),
    playerIdentityCandidates: dedupePlayerCandidates([...existing.playerIdentityCandidates, ...next.playerIdentityCandidates]),
    trackIdentityAssignments: dedupeTrackAssignments([...existing.trackIdentityAssignments, ...next.trackIdentityAssignments]),
    teamClusterAssignments: dedupeTeamClusterAssignments([...(existing.teamClusterAssignments ?? []), ...(next.teamClusterAssignments ?? [])])
  };
}

function segmentEvidenceText(segment: TimelineSegment) {
  return segmentTextSources(segment)
    .filter((source) => source.source !== "title" && source.source !== "metadata")
    .map((source) => source.text)
    .join(" ");
}

function segmentTextSources(segment: TimelineSegment): Array<{ source: IdentityEvidenceItem["source"]; text: string; confidence: number }> {
  const sceneText = segment.sceneData?.text;
  const vlm = segment.sceneData?.vlm;
  return [
    { source: "asr" as const, text: [segment.transcript, sceneText?.speech].filter(Boolean).join(" "), confidence: 0.74 },
    { source: "ocr" as const, text: [...(sceneText?.subtitles ?? []), ...(sceneText?.screenText ?? []), ...(sceneText?.overlays ?? [])].join(" "), confidence: 0.68 },
    {
      source: "vlm" as const,
      text: [vlm?.caption, vlm?.description, ...(vlm?.visibleText ?? []), ...(vlm?.labels ?? []), ...(vlm?.evidence ?? [])].filter(Boolean).join(" "),
      confidence: 0.62
    },
    { source: "event_metadata" as const, text: [segment.domain?.searchText, ...(segment.domain?.captions ?? []), ...(segment.domain?.labels ?? [])].filter(Boolean).join(" "), confidence: 0.58 }
  ].filter((item) => item.text.trim().length > 0);
}

function extractJerseyNumberCandidates(segment: TimelineSegment): JerseyNumberCandidate[] {
  const candidates: JerseyNumberCandidate[] = [];
  const ocr = segmentTextSources(segment)
    .filter((source) => source.source === "ocr" || source.source === "vlm")
    .map((source) => source.text)
    .join(" ");
  for (const number of [
    ...Array.from(ocr.matchAll(/(?:#|no\.?\s*|number\s+|shirt\s+|jersey\s+|등번호\s*)(\d{1,2})\b/gi)).map((match) => Number(match[1])),
    ...Array.from(ocr.matchAll(/\b(\d{1,2})\s*번(?:\s*선수)?/g)).map((match) => Number(match[1]))
  ]) {
    if (isValidJerseyNumber(number)) {
      candidates.push({
        number,
        source: "text_ocr",
        confidence: 0.64,
        value: `Jersey number ${number}`
      });
    }
  }

  const tracking = segment.sceneData?.vision?.tracking;
  for (const track of tracking?.playerTracks ?? []) {
    for (const candidate of track.jerseyNumberCandidates ?? []) {
      if (!isValidJerseyNumber(candidate.number)) continue;
      candidates.push({
        number: candidate.number,
        source: "crop_ocr",
        trackId: track.id,
        confidence: Math.max(0.45, Math.min(0.82, candidate.confidence)),
        value: `Jersey crop OCR #${candidate.number} on ${track.id}${candidate.text ? ` (${candidate.text})` : ""}`
      });
    }
  }

  const deduped = new Map<string, JerseyNumberCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.number}:${candidate.trackId ?? ""}`;
    const existing = deduped.get(key);
    if (!existing || candidate.confidence > existing.confidence) {
      deduped.set(key, candidate);
    }
  }
  return Array.from(deduped.values()).sort((left, right) => right.confidence - left.confidence).slice(0, 8);
}

function isValidJerseyNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 99;
}

function assetMetadataText(asset: AssetRecord) {
  return [asset.title, asset.originalName, asset.description, asset.tags.join(" ")].filter(Boolean).join(" ");
}

function nearestTrackId(segment: TimelineSegment) {
  return segment.sceneData?.vision?.tracking?.nearestPlayerTrackId ?? null;
}

function visualTrackEvidence(segment: TimelineSegment, trackId: string): IdentityEvidenceItem[] {
  const track = segment.sceneData?.vision?.tracking?.playerTracks?.find((item) => item.id === trackId);
  if (!track) return [];
  const evidence: IdentityEvidenceItem[] = [];
  if (track.teamCluster && track.teamCluster !== "unknown") {
    evidence.push({
      source: "reid",
      value: `Kit cluster ${track.teamCluster}${track.appearance?.dominantHex ? ` (${track.appearance.dominantHex})` : ""}`,
      confidence: Math.max(0.34, Math.min(0.72, track.teamConfidence ?? 0.42))
    });
  }
  if (track.appearance?.dominantHex) {
    evidence.push({
      source: "reid",
      value: `Upper-body kit color ${track.appearance.dominantHex}`,
      confidence: Math.max(0.28, Math.min(0.58, (track.teamConfidence ?? 0.4) - 0.08))
    });
  }
  return evidence;
}

function footballTeamTerms(team: string | null) {
  if (!team) return [];
  const normalized = normalizeText(team);
  const parts = normalized.split(/\s+/).filter((part) => part.length > 1);
  const mascot = parts.at(-1);
  return unique([team, normalized, mascot ?? "", ...parts, ...extractLightKeywords(team)]).filter((term) => term.length > 1);
}

function playerNameTerms(name: string | null) {
  if (!name) return [];
  const normalized = normalizeText(name);
  const parts = normalized.split(/\s+/).filter((part) => part.length > 1);
  const last = parts.at(-1);
  return unique([name, normalized, last ?? "", ...parts]).filter((term) => term.length > 1);
}

function textTerms(text: string) {
  return unique(
    normalizeText(text)
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 1)
  );
}

function playerNameScore(text: string, name: string | null) {
  if (!name) return 0;
  const normalized = normalizeText(name);
  if (normalized.length > 2 && text.includes(normalized)) return 5;
  const parts = normalized.split(/\s+/).filter((part) => part.length > 2);
  const last = parts.at(-1);
  if (last && text.includes(last)) return 2.5;
  return 0;
}

function termOverlap(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.reduce((sum, term) => sum + (rightSet.has(term) ? 1 : 0), 0);
}

function includesAny(normalized: string, terms: string[]) {
  return terms.some((term) => {
    const value = normalizeText(term);
    return value.length > 1 && normalized.includes(value);
  });
}

function footballContextIdForCandidate(candidate: FootballMatchCandidate) {
  return `matchctx:sports_football:${normalizeLabel(candidate.provider)}:${normalizeLabel(candidate.competition)}:${normalizeLabel(candidate.season)}:${candidate.matchId}`;
}

function americanFootballContextIdForCandidate(candidate: AmericanFootballGameCandidate) {
  return `matchctx:sports_american_football:nflverse:${normalizeLabel(candidate.season)}:${normalizeLabel(candidate.gameId)}`;
}

function americanFootballPlayKey(gameId: string, playId: string) {
  return `${gameId}:${playId}`;
}

function isTrackAssignment(candidate: PlayerIdentityCandidate): candidate is TrackIdentityAssignment {
  return Boolean(candidate.trackId);
}

function sortedContexts(contexts: Map<string, MatchContext>) {
  return dedupeMatchContexts(
    Array.from(contexts.values()).map((context) => ({
      ...context,
      videoRanges: context.videoRanges.sort((a, b) => a.start - b.start),
      clockMappings: dedupeClockMappings(context.clockMappings).sort((a, b) => a.videoStart - b.videoStart)
    }))
  );
}

function dedupeMatchContexts(contexts: MatchContext[]) {
  const byKey = new Map<string, MatchContext>();
  for (const context of contexts) {
    const existing = byKey.get(context.id);
    if (!existing) {
      byKey.set(context.id, { ...context, videoRanges: [...context.videoRanges], clockMappings: [...context.clockMappings] });
      continue;
    }
    byKey.set(context.id, {
      ...existing,
      confidence: Number(Math.max(existing.confidence, context.confidence).toFixed(2)),
      status: existing.status === "confirmed" || context.status === "confirmed" ? "confirmed" : existing.status === "candidate" || context.status === "candidate" ? "candidate" : "unknown",
      evidence: unique([...existing.evidence, ...context.evidence]).slice(0, 12),
      videoRanges: [...existing.videoRanges, ...context.videoRanges].sort((a, b) => a.start - b.start),
      clockMappings: dedupeClockMappings([...existing.clockMappings, ...context.clockMappings]).sort((a, b) => a.videoStart - b.videoStart)
    });
  }
  return Array.from(byKey.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function dedupeClockMappings(mappings: MatchClockMapping[]) {
  const byKey = new Map<string, MatchClockMapping>();
  for (const mapping of mappings) {
    const key = `${mapping.videoStart}:${mapping.videoEnd}:${mapping.period}:${mapping.clockText}:${mapping.source}`;
    const existing = byKey.get(key);
    if (!existing || mapping.confidence > existing.confidence) byKey.set(key, mapping);
  }
  return Array.from(byKey.values());
}

function dedupeRosterWindows(windows: ActiveRosterWindow[]) {
  const byKey = new Map<string, ActiveRosterWindow>();
  for (const window of windows) {
    const key = `${window.matchContextId}:${window.playerId ?? window.canonicalName}:${window.team ?? "unknown"}:${window.startMinute ?? "any"}:${window.endMinute ?? "any"}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...window, evidence: unique(window.evidence).slice(0, 6) });
      continue;
    }
    byKey.set(key, {
      ...existing,
      startMinute: existing.startMinute ?? window.startMinute,
      endMinute: existing.endMinute ?? window.endMinute,
      evidence: unique([...existing.evidence, ...window.evidence]).slice(0, 6)
    });
  }
  return Array.from(byKey.values()).sort((a, b) => (a.team ?? "").localeCompare(b.team ?? "") || a.canonicalName.localeCompare(b.canonicalName));
}

function dedupePlayerCandidates(candidates: PlayerIdentityCandidate[]) {
  const byKey = new Map<string, PlayerIdentityCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.matchContextId}:${candidate.trackId ?? "no-track"}:${candidate.playerId ?? candidate.canonicalName}:${candidate.videoRange.start}:${candidate.videoRange.end}`;
    const existing = byKey.get(key);
    if (!existing || candidate.confidence > existing.confidence) byKey.set(key, candidate);
  }
  return Array.from(byKey.values()).sort((a, b) => b.confidence - a.confidence);
}

function dedupeTrackAssignments(assignments: TrackIdentityAssignment[]) {
  return dedupePlayerCandidates(assignments).filter(isTrackAssignment);
}

function dedupeTeamClusterAssignments(assignments: TeamClusterAssignment[]) {
  const byKey = new Map<string, TeamClusterAssignment>();
  for (const assignment of assignments) {
    const key = `${assignment.matchContextId ?? "unknown"}:${assignment.cluster}:${assignment.team ?? "unknown"}:${assignment.videoRange.start}:${assignment.videoRange.end}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...assignment, evidence: dedupeEvidenceItems(assignment.evidence).slice(0, 8) });
      continue;
    }
    byKey.set(key, {
      ...existing,
      confidence: Number(Math.max(existing.confidence, assignment.confidence).toFixed(2)),
      status: existing.status === "confirmed" || assignment.status === "confirmed" ? "confirmed" : existing.status === "candidate" || assignment.status === "candidate" ? "candidate" : "unknown",
      evidence: dedupeEvidenceItems([...existing.evidence, ...assignment.evidence]).slice(0, 8)
    });
  }
  return Array.from(byKey.values()).sort((a, b) => b.confidence - a.confidence || a.cluster.localeCompare(b.cluster) || (a.team ?? "").localeCompare(b.team ?? ""));
}

function dedupeEvidenceItems(items: IdentityEvidenceItem[]) {
  const byKey = new Map<string, IdentityEvidenceItem>();
  for (const item of items) {
    const key = `${item.source}:${item.value}`;
    const existing = byKey.get(key);
    if (!existing || item.confidence > existing.confidence) byKey.set(key, item);
  }
  return Array.from(byKey.values()).sort((a, b) => b.confidence - a.confidence || a.source.localeCompare(b.source) || a.value.localeCompare(b.value));
}

function addToMap<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function uniqueBy<T>(items: T[], keyForItem: (item: T) => string) {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const key = keyForItem(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return Array.from(byKey.values());
}
