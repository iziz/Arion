import assert from "node:assert/strict";
import test from "node:test";
import type { AssetRecord, KnowledgeSnapshot, TimelineSegment } from "../shared/types";
import { applyAmericanFootballActionSpots } from "../server/knowledge/adapters/sports/americanFootball/actionSpotting";
import { buildAmericanFootballActionSpotPredictions } from "../server/knowledge/adapters/sports/americanFootball/actionSpotting/generateActionSpots";

test("american football action spots create detected domain events", () => {
  const timeline = [
    segment("segment-1", 0, 10),
    segment("segment-2", 10, 20)
  ];

  const next = applyAmericanFootballActionSpots(timeline, {
    available: true,
    provider: "american-football-action-spotting",
    model: "test-detector",
    task: "action_spotting",
    spots: [
      {
        label: "QB scramble",
        eventType: "scramble",
        position: 5,
        period: 1,
        confidence: 0.91,
        evidence: ["quarter=1", "down=3"],
        playMetadata: {
          provider: "nflverse",
          gameId: "2025_01_DAL_PHI",
          playId: "1234",
          season: "2025",
          week: 1,
          possessionTeam: "Philadelphia Eagles",
          defensiveTeam: "Dallas Cowboys",
          down: 3,
          distance: 7,
          yardline: "PHI 42",
          yardline100: 42,
          quarter: 1,
          clock: "12:34",
          description: "Jalen Hurts scrambles for 12 yards.",
          sourceText: ["nflverse play metadata"]
        },
        participants: [
          {
            role: "passer",
            playerId: "00-0036389",
            name: "Jalen Hurts",
            team: "Philadelphia Eagles",
            trackId: "track-player-7",
            confidence: 0.88,
            source: "nflverse"
          }
        ],
        tracking: {
          schema: "mot",
          playId: "1234",
          frameIds: ["frame-10"],
          trackIds: ["track-player-7"],
          contactIds: [],
          confidence: 0.72
        }
      }
    ],
    error: null
  });

  assert.equal(next[0].domain?.groups.includes("sports.american_football"), true);
  assert.equal(next[0].domain?.generatedBy, "american-football-action-spotting");
  assert.equal(next[0].domain?.events[0].domain, "sports.american_football");
  assert.equal(next[0].domain?.events[0].eventType, "scramble");
  assert.equal(next[0].domain?.events[0].trust, "detected");
  assert.equal(next[0].domain?.events[0].americanFootball?.playType, "scramble");
  assert.equal(next[0].domain?.events[0].americanFootball?.decision.outcome, "run");
  assert.equal(next[0].domain?.events[0].americanFootball?.playMetadata?.gameId, "2025_01_DAL_PHI");
  assert.equal(next[0].domain?.events[0].americanFootball?.playMetadata?.down, 3);
  assert.equal(next[0].domain?.events[0].americanFootball?.quarterback.trackId, "track-player-7");
  assert.equal(next[0].domain?.events[0].americanFootball?.participants?.[0]?.playerId, "00-0036389");
  assert.equal(next[0].domain?.events[0].americanFootball?.tracking?.trackIds.includes("track-player-7"), true);
  assert.equal(next[0].sources.includes("domain"), true);
  assert.equal(next[1].domain, undefined);
});

test("american football template generator creates spots without pre-existing prediction JSON", () => {
  const testAsset = assetRecord("asset-nfl", "NFL Eagles Not Human Moments 2025", [
    {
      ...segment("segment-1", 10, 16),
      transcript: "Barkley slips two tackles for the Eagles and picks up the first down.",
      sceneData: {
        image: { thumbnailPath: null, framePath: null, labels: ["football", "running back"], dominantColor: "#0a7f4f", brightness: 0.5, motionScore: 0.5, keyframeAt: 13 },
        text: { speech: "Barkley slips two tackles for the Eagles and picks up the first down.", subtitles: [], screenText: [], overlays: [], watermarks: [], comparisons: [] }
      }
    }
  ]);

  const spots = buildAmericanFootballActionSpotPredictions(testAsset, [
    play({
      gameId: "2025_02_NYG_PHI",
      playId: "3129",
      playType: "run",
      description: "Saquon Barkley left tackle for 21 yards.",
      possessionTeam: "Philadelphia Eagles",
      defensiveTeam: "New York Giants",
      rusherPlayerName: "Saquon Barkley",
      rusherPlayerId: "00-0034844"
    })
  ]);

  assert.equal(spots.length, 1);
  assert.equal(spots[0].eventType, "rush");
  assert.equal(spots[0].playMetadata?.gameId, "2025_02_NYG_PHI");
  assert.equal(spots[0].playMetadata?.playId, "3129");
  assert.equal(spots[0].participants?.[0]?.playerId, "00-0034844");
});

test("american football template generator does not align nflverse plays without NFL context", () => {
  const testAsset = assetRecord("asset-college", "THERE IS A FOX ON THE FIELD", [
    {
      ...segment("segment-1", 5, 10),
      transcript: "Slovis was hit again incomplete.",
      sceneData: {
        image: { thumbnailPath: null, framePath: null, labels: ["football", "Arizona"], dominantColor: "#0a7f4f", brightness: 0.5, motionScore: 0.5, keyframeAt: 7 },
        text: { speech: "Slovis was hit again incomplete.", subtitles: ["Arizona State"], screenText: [], overlays: [], watermarks: [], comparisons: [] }
      }
    }
  ]);

  const spots = buildAmericanFootballActionSpotPredictions(testAsset, [
    play({
      gameId: "2025_01_ARI_GB",
      playId: "99",
      playType: "pass",
      description: "Arizona pass incomplete.",
      possessionTeam: "Arizona Cardinals",
      defensiveTeam: "Green Bay Packers"
    })
  ]);

  assert.equal(spots.length, 1);
  assert.equal(spots[0].eventType, "pressure");
  assert.equal(spots[0].playMetadata, undefined);
});

function segment(id: string, start: number, end: number): TimelineSegment {
  return {
    id,
    start,
    end,
    label: id,
    transcript: "",
    tags: [],
    modalities: ["visual"],
    confidence: 0.5,
    embedding: [],
    thumbnailPath: null,
    sources: ["visual"]
  };
}

function assetRecord(id: string, title: string, timeline: TimelineSegment[]): Pick<AssetRecord, "id" | "title" | "description" | "originalName" | "timeline"> {
  return {
    id,
    title,
    description: "",
    originalName: `${title}.mkv`,
    timeline
  };
}

function play(input: Partial<NonNullable<KnowledgeSnapshot["americanFootballPlays"]>[number]> & { gameId: string; playId: string; playType: string; description: string }): NonNullable<KnowledgeSnapshot["americanFootballPlays"]>[number] {
  return {
    id: `nflverse:play:2025:${input.gameId}:${input.playId}`,
    provider: "nflverse",
    competition: "NFL",
    season: "2025",
    week: 1,
    gameId: input.gameId,
    playId: input.playId,
    gameDate: "2025-09-01",
    homeTeam: input.homeTeam ?? "Philadelphia Eagles",
    awayTeam: input.awayTeam ?? "New York Giants",
    possessionTeam: input.possessionTeam ?? null,
    defensiveTeam: input.defensiveTeam ?? null,
    quarter: input.quarter ?? 1,
    clock: input.clock ?? "12:34",
    down: input.down ?? 1,
    distance: input.distance ?? 10,
    yardline: input.yardline ?? "PHI 24",
    yardline100: input.yardline100 ?? 76,
    playType: input.playType,
    description: input.description,
    yardsGained: input.yardsGained ?? 0,
    touchdown: input.touchdown ?? false,
    turnover: input.turnover ?? false,
    passerPlayerId: input.passerPlayerId ?? null,
    passerPlayerName: input.passerPlayerName ?? null,
    rusherPlayerId: input.rusherPlayerId ?? null,
    rusherPlayerName: input.rusherPlayerName ?? null,
    receiverPlayerId: input.receiverPlayerId ?? null,
    receiverPlayerName: input.receiverPlayerName ?? null,
    sourceText: input.sourceText ?? input.description
  };
}
