import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeStageJobUpdate } from "../server/workflows/runtimeStageState";
import type { JobRecord } from "../shared/types";

test("starts a fresh runtime attempt after a terminal stage", () => {
  const { patch, logMessage, level } = buildRuntimeStageJobUpdate(
    {
      ...baseJob(),
      progress: 40,
      runtimeStages: {
        asr: {
          stage: "asr",
          status: "failed",
          message: "Running Whisper ASR failed: fetch failed",
          progress: 100,
          error: "fetch failed",
          startedAt: "2026-05-04T18:16:43.923Z",
          updatedAt: "2026-05-04T18:27:42.675Z",
          completedAt: "2026-05-04T18:27:42.675Z"
        }
      }
    },
    {
      stage: "asr",
      status: "running",
      message: "Running Whisper ASR",
      progress: 0
    },
    "2026-05-04T19:04:12.832Z",
    { keepJobStage: true }
  );

  const asr = patch.runtimeStages?.asr;
  assert.equal(asr?.status, "running");
  assert.equal(asr?.message, "Running Whisper ASR");
  assert.equal(asr?.progress, 0);
  assert.equal(asr?.error, null);
  assert.equal(asr?.startedAt, "2026-05-04T19:04:12.832Z");
  assert.equal(asr?.completedAt, null);
  assert.equal(patch.stage, "local-model-runtime");
  assert.equal(patch.progress, 48);
  assert.equal(logMessage, "[runtime:asr:running] Running Whisper ASR");
  assert.equal(level, "info");
});

test("preserves running stage progress on heartbeat regression", () => {
  const { patch, logMessage } = buildRuntimeStageJobUpdate(
    {
      ...baseJob(),
      runtimeStages: {
        ocr: {
          stage: "ocr",
          status: "running",
          message: "Prepared 2643 OCR snapshots for korean, en",
          progress: 12,
          error: null,
          startedAt: "2026-05-04T19:04:12.829Z",
          updatedAt: "2026-05-04T19:05:12.836Z",
          completedAt: null
        }
      }
    },
    {
      stage: "ocr",
      status: "running",
      message: "Running PaddleOCR",
      progress: 3,
      heartbeat: true
    },
    "2026-05-04T19:05:42.836Z",
    { keepJobStage: true }
  );

  const ocr = patch.runtimeStages?.ocr;
  assert.equal(ocr?.message, "Prepared 2643 OCR snapshots for korean, en");
  assert.equal(ocr?.progress, 12);
  assert.equal(ocr?.startedAt, "2026-05-04T19:04:12.829Z");
  assert.equal(ocr?.completedAt, null);
  assert.equal(logMessage, undefined);
});

function baseJob(): JobRecord {
  return {
    id: "job-1",
    type: "asset.index",
    status: "running",
    stage: "local-model-runtime",
    progress: 40,
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
