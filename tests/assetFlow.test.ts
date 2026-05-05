import assert from "node:assert/strict";
import test from "node:test";
import { getAssetFlow } from "../src/assetFlow";
import type { AssetRecord, IndexRecord, JobRecord, LocalIntelligence } from "../shared/types";

test("does not mark stale queued runtime stages as active", () => {
  const speakers = getAssetFlow(baseAsset(), baseIndex(), {
    ...baseJob(),
    status: "queued",
    stage: "local-model-runtime",
    progress: 58,
    runtimeStages: {
      diarization: {
        stage: "diarization",
        status: "running",
        message: "Running WhisperX diarization",
        progress: 0,
        error: null,
        startedAt: "2026-05-04T18:17:31.019Z",
        updatedAt: "2026-05-04T18:30:42.683Z",
        completedAt: null
      }
    }
  }).find((step) => step.id === "speakers");

  assert.equal(speakers?.state, "waiting");
  assert.equal(speakers?.progress, null);
  assert.equal(speakers?.serverProgress, undefined);
});

test("running runtime stages take precedence over stored step outputs", () => {
  const asset = {
    ...baseAsset(),
    intelligence: {
      ...emptyIntelligence(),
      asr: {
        transcript: "stored transcript",
        language: "ko",
        confidence: 0.74,
        segments: [{ start: 0, end: 2, text: "stored transcript", speaker: null }]
      },
      diarization: {
        provider: "whisperx",
        speakers: ["SPEAKER_00"],
        segments: [{ start: 0, end: 2, speaker: "SPEAKER_00", text: "stored transcript" }],
        error: null
      },
      ocr: {
        tokens: ["STORED"],
        confidence: 0.8,
        frames: [{ framePath: "generated/frame.png", at: 1, tokens: ["STORED"], boxes: [], confidence: 0.8 }]
      }
    }
  } satisfies AssetRecord;
  const flow = getAssetFlow(asset, baseIndex(), {
    ...baseJob(),
    status: "running",
    stage: "local-model-runtime",
    progress: 54,
    runtimeStages: {
      asr: runtimeStage("asr", "Running Whisper ASR", 20),
      diarization: runtimeStage("diarization", "Running WhisperX diarization", 5),
      ocr: runtimeStage("ocr", "Running PaddleOCR", 12)
    }
  });

  assert.equal(flow.find((step) => step.id === "asr")?.state, "active");
  assert.equal(flow.find((step) => step.id === "asr")?.detail, "Running transcription");
  assert.equal(flow.find((step) => step.id === "speakers")?.state, "active");
  assert.equal(flow.find((step) => step.id === "speakers")?.detail, "Running speaker diarization");
  assert.equal(flow.find((step) => step.id === "ocr")?.state, "active");
  assert.equal(flow.find((step) => step.id === "ocr")?.detail, "Running PaddleOCR");
});

test("completed diarization output is shown after the runtime stage succeeds", () => {
  const asset = {
    ...baseAsset(),
    intelligence: {
      ...emptyIntelligence(),
      diarization: {
        provider: "whisperx",
        speakers: ["SPEAKER_00", "SPEAKER_01"],
        segments: [{ start: 0, end: 2, speaker: "SPEAKER_00", text: "hello" }],
        error: null
      }
    }
  } satisfies AssetRecord;
  const speakers = getAssetFlow(asset, baseIndex(), {
    ...baseJob(),
    status: "running",
    stage: "local-model-runtime",
    progress: 54,
    runtimeStages: {
      diarization: {
        ...runtimeStage("diarization", "Running WhisperX diarization complete", 100),
        status: "succeeded",
        completedAt: "2026-05-04T18:10:00.000Z"
      }
    }
  }).find((step) => step.id === "speakers");

  assert.equal(speakers?.state, "done");
  assert.equal(speakers?.detail, "2 speakers");
});

test("all workflow nodes expose concise search-focused descriptions", () => {
  const flow = getAssetFlow(baseAsset(), baseIndex(), null);
  const descriptions = new Map(flow.map((step) => [step.id, step.description]));

  for (const step of flow) {
    assert.match(step.description, /\S/, `${step.id} should describe its search contribution`);
    assert.notEqual(step.description, step.detail, `${step.id} should keep status detail separate from node description`);
  }

  assert.match(descriptions.get("asr") ?? "", /timed text segments/);
  assert.match(descriptions.get("ocr") ?? "", /frame text/);
  assert.match(descriptions.get("timeline") ?? "", /indexed moments/);
  assert.match(descriptions.get("vector") ?? "", /vector store/);
});

test("active indexing stage invalidates only dependency-linked stored outputs", () => {
  const asset = {
    ...baseAsset(),
    status: "embedding",
    progress: 86,
    timeline: [embeddedTimelineSegment()],
    intelligence: {
      ...emptyIntelligence(),
      modelTrace: ["embedding:local-test-model", "visual-embedding:clip-test-model"]
    }
  } satisfies AssetRecord;
  const flow = getAssetFlow(asset, baseIndex(), {
    ...baseJob(),
    status: "queued",
    stage: "video-vlm",
    progress: 76.12,
    logs: [
      {
        at: "2026-05-05T02:16:39.000Z",
        level: "info",
        message: "[video-vlm:analyzing] Video VLM analyzing segment 17/259"
      }
    ]
  });

  assert.equal(flow.find((step) => step.id === "videoVlm")?.state, "active");
  assert.equal(flow.find((step) => step.id === "videoVlm")?.detail, "Analyzing timeline keyframes 17/259");
  assert.equal(flow.find((step) => step.id === "textEmbedding")?.state, "waiting");
  assert.equal(flow.find((step) => step.id === "textEmbedding")?.detail, "Waiting for Video VLM analysis to finish");
  assert.equal(flow.find((step) => step.id === "textEmbedding")?.progress, null);
  assert.equal(flow.find((step) => step.id === "visualEmbedding")?.state, "done");
  assert.equal(flow.find((step) => step.id === "visualEmbedding")?.progress, 100);
  assert.equal(flow.find((step) => step.id === "ready")?.state, "waiting");
  assert.equal(flow.find((step) => step.id === "ready")?.progress, null);
});

test("current indexing stage is active even when stale output trace exists", () => {
  const asset = {
    ...baseAsset(),
    status: "embedding",
    progress: 86,
    timeline: [embeddedTimelineSegment()],
    intelligence: {
      ...emptyIntelligence(),
      modelTrace: ["video-vlm:qwen:259/259:invalid=0:failed=0", "embedding:local-test-model"]
    }
  } satisfies AssetRecord;
  const flow = getAssetFlow(asset, baseIndex(), {
    ...baseJob(),
    status: "running",
    stage: "video-vlm",
    progress: 76.12,
    logs: [
      {
        at: "2026-05-05T02:16:39.000Z",
        level: "info",
        message: "[video-vlm:analyzing] Video VLM analyzing segment 17/259"
      }
    ]
  });

  assert.equal(flow.find((step) => step.id === "videoVlm")?.state, "active");
  assert.equal(flow.find((step) => step.id === "videoVlm")?.detail, "Analyzing timeline keyframes 17/259");
  assert.equal(flow.find((step) => step.id === "textEmbedding")?.state, "waiting");
});

test("unrelated completed text embedding remains done while visual embedding runs", () => {
  const asset = {
    ...baseAsset(),
    status: "embedding",
    progress: 92,
    timeline: [embeddedTimelineSegment()],
    intelligence: {
      ...emptyIntelligence(),
      modelTrace: ["embedding:local-test-model"]
    }
  } satisfies AssetRecord;
  const flow = getAssetFlow(asset, baseIndex(), {
    ...baseJob(),
    status: "running",
    stage: "visual-embedding",
    progress: 92
  });

  assert.equal(flow.find((step) => step.id === "textEmbedding")?.state, "done");
  assert.equal(flow.find((step) => step.id === "visualEmbedding")?.state, "active");
  assert.equal(flow.find((step) => step.id === "vector")?.state, "waiting");
  assert.equal(flow.find((step) => step.id === "ready")?.state, "waiting");
});

function baseAsset(): AssetRecord {
  return {
    id: "asset-1",
    indexId: "index-1",
    title: "Sample asset",
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
    createdAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:00:00.000Z"
  };
}

function embeddedTimelineSegment(): AssetRecord["timeline"][number] {
  return {
    id: "segment-1",
    start: 0,
    end: 10,
    label: "Moment 1",
    transcript: "stored transcript",
    tags: [],
    modalities: ["visual", "audio", "transcription"],
    confidence: 0.9,
    embedding: [0.1, 0.2, 0.3],
    thumbnailPath: "generated/keyframe.jpg",
    sources: ["whisper", "visual"],
    scene: {
      shotIndex: 0,
      boundaryScore: 0.8,
      boundarySource: "ffmpeg",
      boundaryDetector: "test"
    }
  };
}

function baseIndex(): IndexRecord {
  return {
    id: "index-1",
    name: "Sample index",
    description: "",
    models: {
      search: "local",
      analysis: "local",
      embedding: "local"
    },
    modalities: ["visual", "audio", "transcription", "metadata"],
    capabilityPolicy: {
      whisperXDiarization: "optional",
      videoVlmAnalysis: "optional",
      visionDetector: "optional",
      visionTracker: "optional",
      knowledgeActionSpotting: "optional",
      domainVlmRefinement: "optional"
    },
    assetIds: ["asset-1"],
    status: "ready",
    createdAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:00:00.000Z"
  };
}

function baseJob(): JobRecord {
  return {
    id: "job-1",
    type: "asset.index",
    status: "queued",
    stage: "local-model-runtime",
    progress: 58,
    indexId: "index-1",
    assetId: "asset-1",
    runtimeStages: {},
    stageCheckpoints: {},
    logs: [],
    error: null,
    createdAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:00:00.000Z",
    completedAt: null
  };
}

function runtimeStage(stage: string, message: string, progress: number): NonNullable<JobRecord["runtimeStages"]>[string] {
  return {
    stage,
    status: "running",
    message,
    progress,
    error: null,
    startedAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:01:00.000Z",
    completedAt: null
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
