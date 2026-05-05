import assert from "node:assert/strict";
import test from "node:test";
import { createShotWindows, type SceneBoundary } from "../server/sceneDetection";
import { fuseTimelineBasis } from "../server/intelligenceCore/sceneTimeline/timelineBasis";
import type { AssetRecord, LocalIntelligence } from "../shared/types";

test("shot windows are not truncated by a fixed scene-count cap", () => {
  const boundaries: SceneBoundary[] = Array.from({ length: 119 }, (_item, index) => ({
    at: index + 1,
    score: null,
    source: "pyscenedetect",
    detector: "adaptive"
  }));

  const windows = createShotWindows(boundaries, 120);

  assert.equal(windows.length, 120);
});

test("timeline moments are produced from time windows instead of a fixed count", () => {
  const duration = 80;
  const asset = baseAsset(duration);
  const shotWindows = Array.from({ length: 80 }, (_item, index) => ({
    start: index,
    end: index + 1,
    boundaryScore: null,
    boundarySource: "pyscenedetect" as const,
    boundaryDetector: "adaptive"
  }));

  const timeline = fuseTimelineBasis(asset, [], shotWindows, duration);

  assert.equal(timeline.length, 40);
  assert.equal(timeline[0]?.start, 0);
  assert.equal(timeline.at(-1)?.end, duration);
});

function baseAsset(duration: number): AssetRecord {
  return {
    id: "asset-1",
    indexId: "index-1",
    title: "Sample asset",
    description: "",
    originalName: "sample.mp4",
    storedName: "local-s3/bucket/assets/sample.mp4",
    mimeType: "video/mp4",
    size: 1024,
    duration,
    width: 1920,
    height: 1080,
    status: "indexed",
    progress: 100,
    tags: [],
    summary: "",
    timeline: [],
    keyframes: [],
    technicalMetadata: {
      storageProvider: "local-s3",
      bucket: "bucket",
      objectKey: "assets/sample.mp4",
      checksum: null,
      frameRate: 30,
      audioCodec: "aac",
      videoCodec: "h264"
    },
    intelligence: emptyIntelligence(),
    error: null,
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z"
  };
}

function emptyIntelligence(): LocalIntelligence {
  return {
    audio: {
      extractedPath: null,
      speechSegments: [],
      musicSegments: [],
      hasSpeech: false,
      hasMusic: false
    },
    asr: {
      transcript: "",
      language: "unknown",
      confidence: 0,
      segments: []
    },
    diarization: {
      provider: "none",
      speakers: [],
      segments: [],
      error: null
    },
    ocr: {
      tokens: [],
      confidence: 0,
      frames: []
    },
    visual: {
      labels: [],
      dominantColor: "#000000",
      brightness: 0,
      motionScore: 0
    },
    modelTrace: []
  };
}
