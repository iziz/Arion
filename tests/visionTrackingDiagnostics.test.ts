import assert from "node:assert/strict";
import test from "node:test";
import { applyVisionTracks } from "../server/vision/applyTracking";
import type { TimelineSegment } from "../shared/types";
import type { TrackerResult } from "../server/vision/types";

test("tracker diagnostics are preserved on segment vision evidence", () => {
  const [segment] = applyVisionTracks([baseSegment()], {
    available: true,
    provider: "ultralytics-track",
    model: "yolo11n.pt",
    tracker: "bytetrack.yaml",
    diagnostics: {
      schema: "tracking_diagnostics_v1",
      runtime: { processedFrameCount: 9, emittedSegmentCount: 1 },
      jerseyOcr: { candidateCount: 2 }
    },
    segments: [
      {
        segmentId: "seg-1",
        frameCount: 12,
        trackedFrameCount: 6,
        trackCoverage: 0.5,
        ballTrackId: "sports_ball-1",
        nearestPlayerTrackId: "person-1",
        ballMovement: { fromPrevious: 0.04, speedPerSecond: 0.6, direction: "right" },
        proximity: { ballNearPlayer: true, confidence: 0.72, normalizedDistance: 0.1 },
        playerTracks: [
          {
            id: "person-1",
            label: "person",
            frames: 6,
            confidence: 0.81,
            firstSeen: 0,
            lastSeen: 1.5
          }
        ],
        ballTracks: [
          {
            id: "sports_ball-1",
            label: "sports_ball",
            frames: 4,
            confidence: 0.74,
            firstSeen: 0.3,
            lastSeen: 1.5
          }
        ],
        idSwitches: 0,
        boxes: [
          { label: "person", trackId: "person-1", confidence: 0.81, x: 0.4, y: 0.2, width: 0.12, height: 0.3, source: "ultralytics-track" },
          { label: "sports_ball", trackId: "sports_ball-1", confidence: 0.74, x: 0.51, y: 0.42, width: 0.03, height: 0.03, source: "ultralytics-track" }
        ],
        provider: "ultralytics-track",
        model: "yolo11n.pt",
        tracker: "bytetrack.yaml",
        diagnostics: {
          schema: "tracking_segment_diagnostics_v1",
          boxCount: 2,
          candidateEvidence: { jerseyCandidateCount: 1 }
        }
      }
    ],
    error: null
  } satisfies TrackerResult);

  const diagnostics = segment?.sceneData?.vision?.tracking?.diagnostics as {
    run?: { schema?: string; runtime?: { processedFrameCount?: number }; jerseyOcr?: { candidateCount?: number } };
    segment?: { schema?: string; boxCount?: number; candidateEvidence?: { jerseyCandidateCount?: number } };
  };

  assert.equal(diagnostics.run?.schema, "tracking_diagnostics_v1");
  assert.equal(diagnostics.run?.runtime?.processedFrameCount, 9);
  assert.equal(diagnostics.run?.jerseyOcr?.candidateCount, 2);
  assert.equal(diagnostics.segment?.schema, "tracking_segment_diagnostics_v1");
  assert.equal(diagnostics.segment?.boxCount, 2);
  assert.equal(diagnostics.segment?.candidateEvidence?.jerseyCandidateCount, 1);
});

function baseSegment(): TimelineSegment {
  return {
    id: "seg-1",
    start: 0,
    end: 2,
    label: "Football segment",
    transcript: "",
    sceneData: {
      image: {
        thumbnailPath: null,
        framePath: null,
        labels: [],
        dominantColor: "#000000",
        brightness: 0.5,
        motionScore: 0.2,
        keyframeAt: 1
      },
      text: {
        speech: "",
        subtitles: [],
        screenText: [],
        overlays: [],
        watermarks: [],
        comparisons: []
      },
      vision: {
        generatedBy: "test",
        trust: "detected",
        frameAt: 1,
        pitch: { present: true, greenDominance: 0.7, confidence: 0.8 },
        objects: {
          players: { countEstimate: 1, confidence: 0.7, status: "detected", boxes: [] },
          ball: { present: true, confidence: 0.6, status: "detected", boxes: [] }
        },
        proximity: { ballNearPlayer: false, confidence: 0.1, normalizedDistance: null },
        tracking: {
          status: "estimated",
          ballTrackId: null,
          nearestPlayerTrackId: null,
          continuity: 0,
          version: "tracking_v0",
          ballMovement: { fromPrevious: null, speedPerSecond: null, direction: "unknown" }
        },
        fieldZone: { zone: "middle_third", confidence: 0.4, method: "detector" },
        eventCandidates: [],
        limitations: ["Tracking v0 links boxes by nearest centers only; player identity and team-kit clustering are not stable IDs."]
      }
    },
    tags: [],
    modalities: ["visual"],
    confidence: 0.5,
    embedding: [],
    thumbnailPath: null,
    sources: ["visual"]
  };
}
