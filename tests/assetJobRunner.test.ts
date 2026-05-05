import assert from "node:assert/strict";
import test from "node:test";
import { getRetryStage } from "../server/services/assetJobRunner";
import type { JobRecord } from "../shared/types";

test("consumed retryStage is not restored from legacy retry logs", () => {
  const job = {
    ...baseJob(),
    parameters: { retryStage: null },
    logs: [
      { at: "2026-05-05T02:11:19.136Z", level: "info", message: "Job queued" },
      { at: "2026-05-05T02:11:19.143Z", level: "info", message: "Retry requested from workflow card: asr" }
    ]
  } satisfies JobRecord;

  assert.equal(getRetryStage(job), null);
});

function baseJob(): JobRecord {
  return {
    id: "job-1",
    type: "asset.reindex",
    status: "queued",
    stage: "queued",
    progress: 0,
    indexId: "index-1",
    assetId: "asset-1",
    runtimeStages: {},
    stageCheckpoints: {},
    logs: [],
    error: null,
    createdAt: "2026-05-05T02:11:19.136Z",
    updatedAt: "2026-05-05T02:11:19.136Z",
    completedAt: null
  };
}
