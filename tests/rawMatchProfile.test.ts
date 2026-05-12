import assert from "node:assert/strict";
import test from "node:test";
import { buildRawMatchVideoProfile } from "../server/rawMatchProfile";
import type { AssetRecord, TimelineSegment } from "../shared/types";

test("raw match profile keeps unknown source context candidate-first", () => {
  const asset = assetRecord([segmentWithFootballVision()]);

  const profile = buildRawMatchVideoProfile(asset);

  assert.equal(profile.status, "partial");
  assert.equal(profile.sourceContext.status, "unknown");
  assert.equal(profile.identityReadiness.rosterRequired, true);
  assert.equal(profile.identityReadiness.jerseyOcrUsable, true);
  assert.equal(profile.identityReadiness.faceUsable, false);
  assert.equal(profile.trackingReadiness.usableForEvents, true);
  assert.equal(profile.observed.teamKitClusters[0]?.cluster, "team-1");
  assert.ok(profile.limitations.some((item) => item.includes("Raw match video mode")));
});

test("raw match profile promotes confirmed source context from reviewed identity", () => {
  const asset = {
    ...assetRecord([segmentWithFootballVision()]),
    identity: {
      generatedBy: "test",
      status: "ready" as const,
      matchContexts: [
        {
          id: "ctx-1",
          matchId: "match-1",
          provider: "manual" as const,
          competition: "Premier League",
          season: "2025/26",
          homeTeam: "Home FC",
          awayTeam: "Away FC",
          confidence: 0.95,
          status: "confirmed" as const,
          evidence: ["Manual review confirmed match context."],
          videoRanges: [],
          clockMappings: []
        }
      ],
      activeRosterWindows: [],
      playerIdentityCandidates: [],
      trackIdentityAssignments: [],
      limitations: [],
      updatedAt: "2026-05-13T00:00:00.000Z"
    }
  };

  const profile = buildRawMatchVideoProfile(asset);

  assert.equal(profile.sourceContext.status, "confirmed");
  assert.deepEqual(profile.sourceContext.teams, ["Home FC", "Away FC"]);
  assert.equal(profile.identityReadiness.rosterRequired, false);
});

function segmentWithFootballVision(): TimelineSegment {
  return {
    id: "seg-1",
    start: 0,
    end: 2,
    label: "Unknown football clip",
    transcript: "",
    sceneData: {
      image: {
        thumbnailPath: null,
        framePath: null,
        labels: ["football pitch"],
        dominantColor: "#1a7f38",
        brightness: 0.52,
        motionScore: 0.3,
        keyframeAt: 1
      },
      text: {
        speech: "",
        subtitles: [],
        screenText: ["12:34 HOME 1-0 AWAY"],
        overlays: [],
        watermarks: [],
        comparisons: []
      },
      vision: {
        generatedBy: "test",
        trust: "detected",
        frameAt: 1,
        pitch: { present: true, greenDominance: 0.74, confidence: 0.88 },
        objects: {
          players: { countEstimate: 14, confidence: 0.82, status: "detected", boxes: [] },
          ball: { present: true, confidence: 0.72, status: "detected", boxes: [] }
        },
        proximity: { ballNearPlayer: true, confidence: 0.7, normalizedDistance: 0.12 },
        tracking: {
          status: "tracked",
          ballTrackId: "sports_ball-1",
          nearestPlayerTrackId: "person-10",
          continuity: 0.46,
          version: "tracking_v2",
          frameCount: 20,
          trackedFrameCount: 10,
          trackCoverage: 0.5,
          idSwitches: 1,
          playerTracks: [
            {
              id: "person-10",
              label: "person",
              frames: 10,
              confidence: 0.82,
              firstSeen: 0,
              lastSeen: 2,
              appearance: { dominantHex: "#d91e2b", hue: 0.98, saturation: 0.78, brightness: 0.85, samplePixels: 800, region: "upper_body" },
              teamCluster: "team-1",
              teamConfidence: 0.76,
              teamEvidence: ["upper-body kit color #d91e2b"],
              jerseyNumberCandidates: [{ number: 10, confidence: 0.81, text: "10", source: "crop_ocr", frameAt: 1, samples: 2 }]
            }
          ],
          ballTracks: [{ id: "sports_ball-1", label: "sports_ball", frames: 8, confidence: 0.74, firstSeen: 0, lastSeen: 2 }],
          ballMovement: { fromPrevious: 0.12, speedPerSecond: 0.8, direction: "right" }
        },
        eventClassification: {
          label: "pass_receive",
          confidence: 0.66,
          rules: ["test"],
          features: {
            textCue: false,
            receiverCue: true,
            ballTracked: true,
            playerNearBall: true,
            fieldZone: "middle_third",
            ballDirection: "right"
          }
        },
        fieldZone: { zone: "middle_third", confidence: 0.64, method: "detector" },
        eventCandidates: [{ type: "pass_receive", confidence: 0.62, reason: "test" }],
        limitations: []
      }
    },
    domain: {
      groups: ["sports.football"],
      captions: [],
      labels: [],
      events: [
        {
          id: "event-1",
          domain: "sports.football",
          ontologyVersion: "test",
          caption: "Pass receive candidate",
          eventType: "pass_receive",
          labels: ["event.pass_receive"],
          confidence: 0.66,
          trust: "candidate",
          evidence: { asr: [], ocr: [], visual: ["ball track sports_ball-1"], metadata: [], heuristics: ["classifier candidate"] }
        }
      ],
      searchText: "",
      confidence: 0.66,
      generatedBy: "test"
    },
    tags: [],
    modalities: ["visual"],
    confidence: 0.7,
    embedding: [],
    thumbnailPath: null,
    sources: ["visual"]
  };
}

function assetRecord(timeline: TimelineSegment[]): AssetRecord {
  return {
    id: "asset-raw",
    indexId: "index-1",
    title: "Unknown football recording",
    description: "",
    originalName: "unknown-football.mp4",
    storedName: "local/test",
    mimeType: "video/mp4",
    size: 1024,
    duration: 120,
    width: 1920,
    height: 1080,
    status: "indexed",
    progress: 100,
    tags: [],
    summary: "",
    timeline,
    keyframes: [],
    technicalMetadata: {
      storageProvider: "local-s3",
      bucket: "bucket",
      objectKey: "assets/unknown-football.mp4",
      checksum: "sha256-test",
      frameRate: 30,
      audioCodec: "aac",
      videoCodec: "h264"
    },
    intelligence: {
      audio: { extractedPath: null, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
      asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
      diarization: { provider: "none", speakers: [], segments: [], error: null },
      ocr: { tokens: ["12:34", "HOME", "1-0", "AWAY"], confidence: 0.7, frames: [] },
      visual: { labels: ["football pitch"], dominantColor: "#1a7f38", brightness: 0.52, motionScore: 0.3 },
      modelTrace: []
    },
    error: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z"
  };
}
