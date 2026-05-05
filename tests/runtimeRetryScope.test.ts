import assert from "node:assert/strict";
import test from "node:test";
import { getForcedRuntimeStages } from "../server/workflows/indexingWorkflow";
import type { AssetRecord, JobRecord, LocalIntelligence } from "../shared/types";

test("fresh ASR retry forces ASR and diarization even when previous data exists", () => {
  assert.deepEqual(getForcedRuntimeStages("asr", baseJob(), assetWithRuntimeData()), ["asr", "diarization"]);
});

test("recovered ASR retry does not rerun runtime stages with stored successful data", () => {
  assert.deepEqual(
    getForcedRuntimeStages(
      "asr",
      {
        ...baseJob(),
        parameters: { retryStage: "asr", resumeFromStage: "local-model-runtime" }
      },
      assetWithRuntimeData()
    ),
    []
  );
});

test("runtime stage success records prevent repeated forced retries in the same job", () => {
  assert.deepEqual(
    getForcedRuntimeStages(
      "asr",
      {
        ...baseJob(),
        runtimeStages: {
          asr: runtimeStage("asr", "succeeded"),
          diarization: runtimeStage("diarization", "running")
        }
      },
      baseAsset()
    ),
    ["diarization"]
  );
});

function baseJob(): JobRecord {
  return {
    id: "job-1",
    type: "asset.reindex",
    status: "running",
    stage: "local-model-runtime",
    progress: 58,
    indexId: "index-1",
    assetId: "asset-1",
    runtimeStages: {},
    stageCheckpoints: {},
    logs: [],
    error: null,
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z",
    completedAt: null
  };
}

function runtimeStage(stage: string, status: "running" | "succeeded" | "failed"): NonNullable<JobRecord["runtimeStages"]>[string] {
  return {
    stage,
    status,
    message: `${stage} ${status}`,
    progress: status === "running" ? 5 : 100,
    error: status === "failed" ? `${stage} failed` : null,
    startedAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:01:00.000Z",
    completedAt: status === "running" ? null : "2026-05-05T00:01:00.000Z"
  };
}

function assetWithRuntimeData(): AssetRecord {
  return {
    ...baseAsset(),
    intelligence: {
      ...emptyIntelligence(),
      audio: {
        extractedPath: "generated/assets/asset-1/audio.wav",
        speechSegments: [],
        musicSegments: [],
        hasSpeech: true,
        hasMusic: false
      },
      asr: {
        transcript: "hello",
        language: "en",
        confidence: 0.8,
        segments: [{ start: 0, end: 1, text: "hello", speaker: null }]
      },
      diarization: {
        provider: "whisperx",
        speakers: ["SPEAKER_00"],
        segments: [{ start: 0, end: 1, speaker: "SPEAKER_00", text: "hello" }],
        error: null
      },
      ocr: {
        tokens: ["HELLO"],
        confidence: 0.7,
        frames: []
      },
      visual: {
        available: true,
        labels: ["dim-scene"],
        dominantColor: "#222222",
        brightness: 0.1,
        motionScore: 0.01
      }
    }
  };
}

function baseAsset(): AssetRecord {
  return {
    id: "asset-1",
    indexId: "index-1",
    title: "Sample",
    description: "",
    originalName: "sample.mp4",
    storedName: "local-s3/bucket/assets/sample.mp4",
    mimeType: "video/mp4",
    size: 1024,
    duration: 60,
    width: 1920,
    height: 1080,
    status: "transcribing",
    progress: 58,
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
