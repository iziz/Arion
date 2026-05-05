import assert from "node:assert/strict";
import test from "node:test";
import { getForcedRuntimeStages, invalidateAssetForRetryStage, mapRetryStageToCheckpoint, normalizeWorkflowStage } from "../server/workflows/indexingWorkflow";
import type { AssetRecord, JobRecord, LocalIntelligence } from "../shared/types";

test("fresh ASR retry forces ASR and diarization even when previous data exists", () => {
  assert.deepEqual(getForcedRuntimeStages("asr", baseJob(), assetWithRuntimeData()), ["asr", "diarization"]);
});

test("recovered ASR retry still forces requested stages when previous asset data exists", () => {
  assert.deepEqual(
    getForcedRuntimeStages(
      "asr",
      {
        ...baseJob(),
        parameters: { retryStage: "asr", resumeFromStage: "local-model-runtime" }
      },
      assetWithRuntimeData()
    ),
    ["asr", "diarization"]
  );
});

test("recovered OCR retry still forces OCR when previous OCR data exists", () => {
  assert.deepEqual(
    getForcedRuntimeStages(
      "ocr",
      {
        ...baseJob(),
        parameters: { retryStage: "ocr", resumeFromStage: "local-model-runtime" },
        runtimeStages: {
          ocr: runtimeStage("ocr", "failed")
        }
      },
      assetWithRuntimeData()
    ),
    ["ocr"]
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

test("workflow node retry stages map to the precise rebuild checkpoint", () => {
  assert.equal(normalizeWorkflowStage("detector"), "detector");
  assert.equal(normalizeWorkflowStage("vision-detection"), "detector");
  assert.equal(normalizeWorkflowStage("textEmbedding"), "textEmbedding");
  assert.equal(mapRetryStageToCheckpoint("detector"), "vision-detection");
  assert.equal(mapRetryStageToCheckpoint("tracker"), "vision-tracking");
  assert.equal(mapRetryStageToCheckpoint("textEmbedding"), "embed");
  assert.equal(mapRetryStageToCheckpoint("visualEmbedding"), "visual-embedding");
  assert.equal(mapRetryStageToCheckpoint("vector"), "vector-upsert-text");
});

test("OCR retry invalidates stale OCR and downstream search artifacts only", () => {
  const asset = indexedAssetWithDerivedData();
  const next = invalidateAssetForRetryStage(asset, "ocr");

  assert.equal(next.intelligence.asr.transcript, "hello");
  assert.deepEqual(next.intelligence.ocr.tokens, []);
  assert.deepEqual(next.timeline, []);
  assert.deepEqual(next.keyframes, []);
  assert.deepEqual(next.tags, []);
  assert.equal(next.summary, "");
  assert.ok(next.intelligence.modelTrace.includes("faster-whisper:large-v3"));
  assert.ok(!next.intelligence.modelTrace.some((trace) => trace.startsWith("paddleocr") || trace.startsWith("ocr-")));
  assert.ok(!next.intelligence.modelTrace.some((trace) => trace.startsWith("embedding:") || trace.startsWith("visual-embedding")));
});

test("detector retry invalidates detector descendants without dropping timeline or VLM evidence", () => {
  const asset = indexedAssetWithDerivedData();
  const next = invalidateAssetForRetryStage(asset, "detector");
  const segment = next.timeline[0];

  assert.equal(next.timeline.length, 1);
  assert.equal(next.keyframes.length, 1);
  assert.equal(segment?.sceneData?.vlm?.status, "described");
  assert.equal(segment?.sceneData?.vision, undefined);
  assert.equal(segment?.domain, undefined);
  assert.deepEqual(segment?.embedding, []);
  assert.ok(next.intelligence.modelTrace.includes("video-vlm:qwen:1/1:invalid=0:failed=0"));
  assert.ok(next.intelligence.modelTrace.includes("visual-embedding:clip-test-model"));
  assert.ok(!next.intelligence.modelTrace.some((trace) => trace.startsWith("vision-detector") || trace.startsWith("vision-tracker") || trace.startsWith("domain-vlm") || trace.startsWith("embedding:")));
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

function indexedAssetWithDerivedData(): AssetRecord {
  return {
    ...assetWithRuntimeData(),
    status: "indexed",
    progress: 100,
    tags: ["stored"],
    summary: "Stored summary",
    timeline: [derivedTimelineSegment()],
    keyframes: [{ id: "keyframe-1", segmentId: "segment-1", at: 0, path: "generated/keyframe.jpg", width: 320, height: 180 }],
    intelligence: {
      ...assetWithRuntimeData().intelligence,
      modelTrace: [
        "faster-whisper:large-v3",
        "asr-language:en",
        "paddleocr:en",
        "ocr-language:en",
        "ocr-source:paddleocr",
        "video-vlm:qwen:1/1:invalid=0:failed=0",
        "vision-detector:yolo:test:1",
        "vision-tracker:bytetrack:test:1",
        "domain-vlm:qwen:1/1:invalid=0:failed=0",
        "embedding:local-test-model",
        "visual-embedding:clip-test-model"
      ]
    }
  };
}

function derivedTimelineSegment(): AssetRecord["timeline"][number] {
  return {
    id: "segment-1",
    start: 0,
    end: 10,
    label: "Moment 1",
    transcript: "hello",
    tags: ["stored"],
    modalities: ["visual", "audio", "transcription"],
    confidence: 0.9,
    embedding: [0.1, 0.2, 0.3],
    thumbnailPath: "generated/keyframe.jpg",
    sources: ["whisper", "paddleocr", "visual", "domain"],
    sceneData: {
      image: {
        thumbnailPath: "generated/keyframe.jpg",
        framePath: "generated/frame.jpg",
        labels: ["player"],
        dominantColor: "#111111",
        brightness: 0.4,
        motionScore: 0.2,
        keyframeAt: 0
      },
      text: {
        speech: "hello",
        subtitles: ["hello"],
        screenText: ["score"],
        overlays: [],
        watermarks: [],
        comparisons: []
      },
      vlm: {
        provider: "local",
        model: "qwen",
        status: "described",
        attemptedAt: "2026-05-05T00:00:00.000Z",
        confidence: 0.8,
        caption: "Player runs",
        description: "A player runs.",
        sceneType: "sports",
        labels: ["player"],
        objects: ["player"],
        actions: ["run"],
        visibleText: [],
        evidence: [],
        rawResponse: null,
        error: null
      },
      vision: {
        generatedBy: "detector",
        frameAt: 0,
        pitch: { present: true, greenDominance: 0.7, confidence: 0.8 },
        objects: {
          players: { countEstimate: 2, confidence: 0.8, status: "detected", boxes: [] },
          ball: { present: true, confidence: 0.6, status: "detected", boxes: [] }
        },
        fieldZone: { zone: "middle_third", confidence: 0.5, method: "detector_x_position" },
        eventCandidates: [],
        limitations: []
      }
    },
    domain: {
      groups: ["sports.football"],
      captions: ["Stored event"],
      labels: ["pass"],
      events: [],
      searchText: "stored event",
      confidence: 0.7,
      generatedBy: "domain-index"
    }
  } as AssetRecord["timeline"][number];
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
