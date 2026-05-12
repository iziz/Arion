import assert from "node:assert/strict";
import test from "node:test";
import type { AssetRecord, IndexRecord, KnowledgeSnapshot, TimelineSegment, VisionEvidence } from "../shared/types";
import { resolveTimelineMatchIdentity } from "../server/domainIndex/matchIdentityResolver";

test("match identity resolver keeps separate match contexts and clock mappings inside one edited asset", () => {
  const timeline = [
    segment("seg-spurs", 12, 18, "Son receives the ball for Tottenham against Arsenal in the 72nd minute.", "TOT 1-0 ARS 72'", "track-player-7"),
    segment("seg-liverpool", 42, 48, "Salah breaks forward for Liverpool against Chelsea at 55 minutes.", "LIV 2-1 CHE 55'", "track-player-11")
  ];
  const result = resolveTimelineMatchIdentity(assetRecord(timeline), footballIndex(), timeline, { snapshot: snapshot() });

  assert.equal(result.identity.matchContexts.length, 2);
  assert.equal(result.identity.matchContexts.some((context) => context.homeTeam === "Tottenham Hotspur" && context.awayTeam === "Arsenal"), true);
  assert.equal(result.identity.matchContexts.some((context) => context.homeTeam === "Liverpool" && context.awayTeam === "Chelsea"), true);
  assert.equal(result.timeline[0].identity?.clockMappings[0]?.matchMinuteStart, 72);
  assert.equal(result.timeline[1].identity?.clockMappings[0]?.matchMinuteStart, 55);
  assert.notEqual(result.timeline[0].identity?.matchContextIds[0], result.timeline[1].identity?.matchContextIds[0]);
  assert.equal(result.timeline[0].identity?.trackIdentityAssignments[0]?.trackId, "track-player-7");
  assert.equal(result.timeline[0].identity?.trackIdentityAssignments[0]?.canonicalName, "Son Heung-min");
  assert.equal(result.timeline[0].identity?.trackIdentityAssignments[0]?.status, "confirmed");
  assert.equal(result.timeline[0].identity?.trackIdentityAssignments[0]?.evidence.some((item) => item.source === "reid" && item.value.includes("Kit cluster team-1")), true);
  assert.equal(result.timeline[0].identity?.teamClusterAssignments?.[0]?.cluster, "team-1");
  assert.equal(result.timeline[0].identity?.teamClusterAssignments?.[0]?.team, "Tottenham Hotspur");
  assert.equal(result.identity.teamClusterAssignments?.some((assignment) => assignment.cluster === "team-1" && assignment.team === "Tottenham Hotspur"), true);
  assert.match(result.trace, /^match-identity:sports-identity-resolver-v1:strategies=sports\.football:2:/);
});

test("football identity resolver uses explicit jersey-number OCR with roster and kit-cluster evidence", () => {
  const timeline = [segment("seg-palmer", 54, 60, "Chelsea push against Liverpool at 55 minutes.", "LIV 2-1 CHE No. 20 55'", "track-player-20")];
  const result = resolveTimelineMatchIdentity(assetRecord(timeline), footballIndex(), timeline, { snapshot: snapshot() });
  const assignment = result.timeline[0].identity?.trackIdentityAssignments[0];

  assert.equal(assignment?.canonicalName, "Cole Palmer");
  assert.equal(assignment?.shirtNumber, 20);
  assert.equal(assignment?.evidence.some((item) => item.source === "jersey_ocr" && item.value.includes("20")), true);
  assert.equal(result.timeline[0].identity?.teamClusterAssignments?.[0]?.cluster, "team-1");
  assert.equal(result.timeline[0].identity?.teamClusterAssignments?.[0]?.team, "Chelsea");
});

test("sports identity resolver applies American football strategy with nflverse play metadata", () => {
  const timeline = [
    americanFootballSegment(
      "seg-eagles",
      8,
      14,
      "Jalen Hurts throws complete on 3rd and 8 for the Eagles in Q2 12:34.",
      "PHI 14 NYG 7 Q2 12:34 3rd & 8",
      "track-qb-1"
    )
  ];
  const result = resolveTimelineMatchIdentity(assetRecord(timeline), americanFootballIndex(), timeline, { snapshot: americanFootballSnapshot() });

  assert.equal(result.identity.matchContexts.length, 1);
  assert.equal(result.identity.matchContexts[0].gameId, "2025_02_NYG_PHI");
  assert.equal(result.identity.matchContexts[0].playId, "3129");
  assert.equal(result.timeline[0].identity?.clockMappings[0]?.period, "Q2");
  assert.equal(result.timeline[0].identity?.trackIdentityAssignments[0]?.trackId, "track-qb-1");
  assert.equal(result.timeline[0].identity?.trackIdentityAssignments[0]?.canonicalName, "Jalen Hurts");
  assert.equal(result.timeline[0].identity?.trackIdentityAssignments[0]?.status, "confirmed");
  assert.match(result.trace, /sports\.american_football/);
});

function segment(id: string, start: number, end: number, speech: string, overlay: string, trackId: string): TimelineSegment {
  return {
    id,
    start,
    end,
    label: id,
    transcript: speech,
    sceneData: {
      image: {
        thumbnailPath: null,
        framePath: null,
        labels: ["football", "pitch"],
        dominantColor: "#087a34",
        brightness: 0.55,
        motionScore: 0.5,
        keyframeAt: start + 1
      },
      text: {
        speech,
        subtitles: [],
        screenText: [overlay],
        overlays: [overlay],
        watermarks: [],
        comparisons: []
      },
      vision: vision(trackId)
    },
    tags: [],
    modalities: ["visual", "audio", "transcription"],
    confidence: 0.78,
    embedding: [],
    thumbnailPath: null,
    sources: ["visual", "whisper", "paddleocr"]
  };
}

function americanFootballSegment(id: string, start: number, end: number, speech: string, overlay: string, trackId: string): TimelineSegment {
  return {
    ...segment(id, start, end, speech, overlay, trackId),
    domain: {
      groups: ["sports.american_football"],
      captions: ["Jalen Hurts pass play aligned with nflverse metadata."],
      labels: ["american_football.pass"],
      searchText: `${speech} gameId=2025_02_NYG_PHI playId=3129 down=3 distance=8`,
      confidence: 0.86,
      generatedBy: "american-football-action-spotting",
      events: [
        {
          id: "event-3129",
          domain: "sports.american_football",
          ontologyVersion: "american-football-action-spotting-v1",
          caption: "Jalen Hurts completes a pass on third down.",
          eventType: "pass",
          labels: ["american_football.pass"],
          confidence: 0.9,
          evidence: {
            asr: [speech],
            ocr: [overlay],
            visual: ["nearest player track track-qb-1"],
            metadata: ["nflverse gameId=2025_02_NYG_PHI playId=3129"],
            heuristics: ["test fixture"]
          },
          americanFootball: {
            phase: "dropback",
            playType: "pass",
            playMetadata: {
              provider: "nflverse",
              gameId: "2025_02_NYG_PHI",
              playId: "3129",
              season: "2025",
              week: 2,
              possessionTeam: "PHI",
              defensiveTeam: "NYG",
              down: 3,
              distance: 8,
              yardline: "PHI 42",
              yardline100: 58,
              quarter: 2,
              clock: "12:34",
              description: "Jalen Hurts pass complete short right.",
              sourceText: ["Jalen Hurts pass complete short right on 3rd and 8."]
            },
            quarterback: { present: true, confidence: 0.82, trackId, trackingStatus: "detected" },
            pressure: { present: false, confidence: 0.2, source: "unknown" },
            pocket: { status: "intact", confidence: 0.7 },
            decision: { outcome: "throw", confidence: 0.82 },
            participants: [
              {
                role: "passer",
                playerId: "00-0036389",
                name: "Jalen Hurts",
                team: "PHI",
                trackId,
                confidence: 0.9,
                source: "tracking"
              }
            ],
            tracking: {
              schema: "mot",
              playId: "3129",
              frameIds: ["trackedFrames:12"],
              trackIds: [trackId],
              contactIds: [],
              confidence: 0.82
            },
            limitations: []
          }
        }
      ]
    }
  };
}

function vision(trackId: string): VisionEvidence {
  return {
    generatedBy: "test",
    frameAt: 1,
    pitch: { present: true, greenDominance: 0.7, confidence: 0.82 },
    objects: {
      players: { countEstimate: 12, confidence: 0.8, status: "detected" },
      ball: { present: true, confidence: 0.7, status: "detected" }
    },
    proximity: { ballNearPlayer: true, confidence: 0.7, normalizedDistance: 0.12 },
    tracking: {
      status: "tracked",
      ballTrackId: "track-ball-1",
      nearestPlayerTrackId: trackId,
      continuity: 0.76,
      version: "tracking_v2",
      playerTracks: [
        {
          id: trackId,
          label: "person",
          frames: 12,
          confidence: 0.82,
          firstSeen: 1,
          lastSeen: 4,
          appearance: { dominantHex: "#ffffff", hue: 0, saturation: 0.12, brightness: 0.98, samplePixels: 240, region: "upper_body" },
          teamCluster: "team-1",
          teamConfidence: 0.71,
          teamEvidence: ["upper-body kit color #ffffff", "hue distance gap 0.180"]
        }
      ],
      ballMovement: { fromPrevious: 0.1, speedPerSecond: 1.2, direction: "right" }
    },
    eventClassification: {
      label: "pass_receive",
      confidence: 0.7,
      rules: ["test"],
      features: {
        textCue: true,
        receiverCue: true,
        ballTracked: true,
        playerNearBall: true,
        fieldZone: "final_third",
        ballDirection: "right"
      }
    },
    fieldZone: { zone: "final_third", confidence: 0.6, method: "detector" },
    eventCandidates: [{ type: "pass_receive", confidence: 0.7, reason: "test" }],
    limitations: []
  };
}

function assetRecord(timeline: TimelineSegment[]): AssetRecord {
  return {
    id: "asset-edited-highlights",
    indexId: "idx-football",
    title: "Edited football highlights",
    description: "",
    originalName: "edited-football-highlights.mp4",
    storedName: "local/test",
    mimeType: "video/mp4",
    size: 1,
    duration: 120,
    width: 1920,
    height: 1080,
    status: "embedding",
    progress: 83,
    tags: [],
    summary: "",
    timeline,
    keyframes: [],
    technicalMetadata: {
      storageProvider: "local-s3",
      bucket: "test",
      objectKey: "test/video.mp4",
      checksum: null,
      frameRate: 25,
      audioCodec: "aac",
      videoCodec: "h264"
    },
    intelligence: {
      audio: { extractedPath: null, speechSegments: [], musicSegments: [], hasSpeech: true, hasMusic: false },
      asr: { transcript: timeline.map((item) => item.transcript).join(" "), language: "en", confidence: 0.8, segments: [] },
      diarization: { provider: "none", speakers: [], segments: [], error: null },
      ocr: { tokens: [], confidence: 0.8, frames: [] },
      visual: { labels: ["football"], dominantColor: "#087a34", brightness: 0.55, motionScore: 0.5 },
      modelTrace: []
    },
    error: null,
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z"
  };
}

function footballIndex(): IndexRecord {
  return {
    id: "idx-football",
    name: "Football",
    description: "",
    models: { search: "test", analysis: "test", embedding: "test" },
    modalities: ["visual", "audio", "transcription"],
    domainIndexing: { enabled: true, groups: ["sports.football"], stages: ["domain_caption", "event_label", "structured_event"] },
    assetIds: [],
    status: "ready",
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z"
  };
}

function americanFootballIndex(): IndexRecord {
  return {
    id: "idx-american-football",
    name: "American football",
    description: "",
    models: { search: "test", analysis: "test", embedding: "test" },
    modalities: ["visual", "audio", "transcription"],
    domainIndexing: { enabled: true, groups: ["sports.american_football"], stages: ["domain_caption", "event_label", "structured_event"] },
    assetIds: [],
    status: "ready",
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z"
  };
}

function snapshot(): KnowledgeSnapshot {
  return {
    domains: [
      {
        id: "sports.football",
        label: "Football",
        sport: "football",
        competitions: ["Premier League"],
        teams: 4,
        players: 4,
        matchActivities: 4,
        facts: 0
      }
    ],
    competitions: [{ value: "Premier League", aliases: ["Premier League", "EPL"], domainGroup: "sports.football", sport: "football" }],
    teams: [
      { value: "Tottenham Hotspur", aliases: ["Tottenham", "Spurs", "TOT"], domainGroup: "sports.football", league: "Premier League" },
      { value: "Arsenal", aliases: ["Arsenal", "ARS"], domainGroup: "sports.football", league: "Premier League" },
      { value: "Liverpool", aliases: ["Liverpool", "LIV"], domainGroup: "sports.football", league: "Premier League" },
      { value: "Chelsea", aliases: ["Chelsea", "CHE"], domainGroup: "sports.football", league: "Premier League" }
    ],
    players: [
      player("son-heung-min", "Son Heung-min", "Tottenham Hotspur", 7),
      player("bukayo-saka", "Bukayo Saka", "Arsenal", 7),
      player("mohamed-salah", "Mohamed Salah", "Liverpool", 11),
      player("cole-palmer", "Cole Palmer", "Chelsea", 20)
    ],
    matchActivities: [
      activity(1001, "Tottenham Hotspur", "Arsenal", "Tottenham Hotspur", "Son Heung-min", 7),
      activity(1001, "Tottenham Hotspur", "Arsenal", "Arsenal", "Bukayo Saka", 7),
      activity(1002, "Liverpool", "Chelsea", "Liverpool", "Mohamed Salah", 11),
      activity(1002, "Liverpool", "Chelsea", "Chelsea", "Cole Palmer", 20)
    ],
    facts: [],
    americanFootballPlays: []
  };
}

function americanFootballSnapshot(): KnowledgeSnapshot {
  return {
    domains: [
      {
        id: "sports.american_football",
        label: "American football",
        sport: "american_football",
        competitions: ["NFL"],
        teams: 2,
        players: 1,
        matchActivities: 0,
        facts: 0,
        plays: 1
      }
    ],
    competitions: [{ value: "NFL", aliases: ["NFL", "National Football League"], domainGroup: "sports.american_football", sport: "american_football" }],
    teams: [
      { value: "Philadelphia Eagles", aliases: ["Eagles", "PHI"], domainGroup: "sports.american_football", league: "NFL" },
      { value: "New York Giants", aliases: ["Giants", "NYG"], domainGroup: "sports.american_football", league: "NFL" }
    ],
    players: [
      {
        id: "00-0036389",
        canonical: "Jalen Hurts",
        aliases: ["Jalen Hurts", "Hurts"],
        sport: "american_football",
        league: "NFL",
        activeSeasons: ["2025"],
        teamsBySeason: { "2025": "PHI" },
        provider: "nflverse",
        externalIds: { gsis_id: "00-0036389" },
        position: "QB",
        shirtNumber: 1
      }
    ],
    matchActivities: [],
    facts: [],
    americanFootballPlays: [
      {
        id: "nflverse:2025_02_NYG_PHI:3129",
        provider: "nflverse",
        competition: "NFL",
        season: "2025",
        week: 2,
        gameId: "2025_02_NYG_PHI",
        playId: "3129",
        gameDate: "2025-09-14",
        homeTeam: "PHI",
        awayTeam: "NYG",
        possessionTeam: "PHI",
        defensiveTeam: "NYG",
        quarter: 2,
        clock: "12:34",
        down: 3,
        distance: 8,
        yardline: "PHI 42",
        yardline100: 58,
        playType: "pass",
        description: "Jalen Hurts pass complete short right on 3rd and 8.",
        yardsGained: 12,
        touchdown: false,
        turnover: false,
        passerPlayerId: "00-0036389",
        passerPlayerName: "Jalen Hurts",
        rusherPlayerId: null,
        rusherPlayerName: null,
        receiverPlayerId: null,
        receiverPlayerName: null,
        sourceText: "Jalen Hurts pass complete short right on 3rd and 8."
      }
    ]
  };
}

function player(id: string, canonical: string, team: string, shirtNumber: number): KnowledgeSnapshot["players"][number] {
  return {
    id,
    canonical,
    aliases: [canonical],
    sport: "football",
    league: "Premier League",
    activeSeasons: ["2025-26"],
    teamsBySeason: { "2025-26": team },
    provider: "local",
    shirtNumber
  };
}

function activity(matchId: number, homeTeam: string, awayTeam: string, team: string, player: string, playerId: number): NonNullable<KnowledgeSnapshot["matchActivities"]>[number] {
  return {
    id: `activity:${matchId}:${player}`,
    provider: "football-data",
    competition: "Premier League",
    season: "2025-26",
    matchId,
    utcDate: null,
    matchday: null,
    homeTeam,
    awayTeam,
    team,
    player,
    playerId,
    role: "STARTING",
    minute: null,
    event: "starting lineup",
    sourceText: `${player} started for ${team}.`
  };
}
