import assert from "node:assert/strict";
import test from "node:test";
import {
  closeRunningRuntimeStages,
  closeRunningStageCheckpoints,
  hasInterruptedRuntimeState
} from "../server/services/durableJobRecovery";
import { findResumeStage, shouldRunJobStage } from "../server/services/jobStageCheckpoint";
import type { JobRecord } from "../shared/types";

const checkpointOrder = ["probe", "local-model-runtime", "timeline", "video-vlm", "vision-detection"] as const;

test("detects queued jobs with interrupted runtime state", () => {
  assert.equal(
    hasInterruptedRuntimeState({
      ...baseJob(),
      status: "queued",
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
    }),
    true
  );
});

test("closes running runtime stages during durable recovery", () => {
  const closed = closeRunningRuntimeStages(
    {
      asr: {
        stage: "asr",
        status: "succeeded",
        message: "Running Whisper ASR complete",
        progress: 100,
        error: null,
        startedAt: "2026-05-04T18:16:43.923Z",
        updatedAt: "2026-05-04T18:17:31.008Z",
        completedAt: "2026-05-04T18:17:31.008Z"
      },
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
    },
    "2026-05-04T19:00:37.133Z",
    "Interrupted by durable worker recovery."
  );

  assert.equal(closed.diarization.status, "failed");
  assert.equal(closed.diarization.error, "Interrupted by durable worker recovery.");
  assert.equal(closed.diarization.completedAt, "2026-05-04T19:00:37.133Z");
  assert.equal(closed.asr.status, "succeeded");
});

test("closes running stage checkpoints during durable recovery", () => {
  const closed = closeRunningStageCheckpoints(
    {
      "local-model-runtime": {
        stage: "local-model-runtime",
        status: "running",
        message: "Local ASR, OCR, and visual runtime complete",
        progress: 60,
        error: null,
        startedAt: "2026-05-04T18:16:42.387Z",
        updatedAt: "2026-05-04T18:22:41.400Z",
        completedAt: null,
        attempts: 1
      }
    },
    "2026-05-04T19:00:37.133Z",
    "Interrupted by durable worker recovery."
  );

  assert.equal(closed["local-model-runtime"].status, "failed");
  assert.equal(closed["local-model-runtime"].error, "Interrupted by durable worker recovery.");
  assert.equal(closed["local-model-runtime"].completedAt, "2026-05-04T19:00:37.133Z");
});

test("durable recovery resumes the interrupted checkpoint instead of stale retry stage", () => {
  const job = {
    ...baseJob(),
    parameters: {
      retryStage: "asr",
      resumeFromStage: "local-model-runtime"
    },
    stageCheckpoints: {
      "local-model-runtime": checkpoint("local-model-runtime", "succeeded"),
      timeline: checkpoint("timeline", "succeeded"),
      "video-vlm": checkpoint("video-vlm", "running")
    }
  } satisfies JobRecord;

  assert.equal(findResumeStage(job, checkpointOrder), "video-vlm");
});

test("resume stage takes precedence over retry stage when deciding rerun scope", () => {
  const job = {
    ...baseJob(),
    parameters: {
      retryStage: "asr",
      resumeFromStage: "video-vlm"
    },
    stageCheckpoints: {
      "local-model-runtime": checkpoint("local-model-runtime", "succeeded"),
      timeline: checkpoint("timeline", "succeeded"),
      "video-vlm": checkpoint("video-vlm", "failed")
    }
  } satisfies JobRecord;

  assert.equal(shouldRunJobStage(job, "local-model-runtime", checkpointOrder, "local-model-runtime"), false);
  assert.equal(shouldRunJobStage(job, "timeline", checkpointOrder, "local-model-runtime"), false);
  assert.equal(shouldRunJobStage(job, "video-vlm", checkpointOrder, "local-model-runtime"), true);
});

test("rebuild scope reruns downstream checkpoints without using stale retry stage", () => {
  const job = {
    ...baseJob(),
    parameters: {
      retryStage: null,
      resumeFromStage: null,
      rebuildFromStage: "timeline"
    },
    stageCheckpoints: {
      "local-model-runtime": checkpoint("local-model-runtime", "succeeded"),
      timeline: checkpoint("timeline", "succeeded"),
      "video-vlm": checkpoint("video-vlm", "succeeded")
    }
  } satisfies JobRecord;

  assert.equal(shouldRunJobStage(job, "local-model-runtime", checkpointOrder, null), false);
  assert.equal(shouldRunJobStage(job, "timeline", checkpointOrder, null), true);
  assert.equal(shouldRunJobStage(job, "video-vlm", checkpointOrder, null), true);
});

test("resume scope takes precedence over rebuild scope after worker recovery", () => {
  const job = {
    ...baseJob(),
    parameters: {
      retryStage: null,
      resumeFromStage: "video-vlm",
      rebuildFromStage: "local-model-runtime"
    },
    stageCheckpoints: {
      "local-model-runtime": checkpoint("local-model-runtime", "succeeded"),
      timeline: checkpoint("timeline", "succeeded"),
      "video-vlm": checkpoint("video-vlm", "failed")
    }
  } satisfies JobRecord;

  assert.equal(shouldRunJobStage(job, "local-model-runtime", checkpointOrder, null), false);
  assert.equal(shouldRunJobStage(job, "timeline", checkpointOrder, null), false);
  assert.equal(shouldRunJobStage(job, "video-vlm", checkpointOrder, null), true);
});

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

function checkpoint(stage: string, status: "succeeded" | "running" | "failed") {
  return {
    stage,
    status,
    message: `${stage} ${status}`,
    progress: 60,
    error: status === "failed" ? `${stage} failed` : null,
    startedAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:01:00.000Z",
    completedAt: status === "running" ? null : "2026-05-04T18:01:00.000Z",
    attempts: 1
  };
}
