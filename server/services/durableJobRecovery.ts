import { logJson } from "../observability";
import { listJobs } from "../store";
import type { JobRecord } from "../../shared/types";
import { updateJob } from "./jobState";
import { enqueueQueuedAssetJobs } from "./redisJobQueue";
import { cleanupStaleRuntimeProcesses } from "./runtimeProcessCleanup";
import { findResumeStage } from "./jobStageCheckpoint";

const indexingCheckpointOrder = [
  "probe",
  "local-model-runtime",
  "timeline",
  "video-vlm",
  "vision-detection",
  "vision-tracking",
  "domain-index",
  "embed",
  "vector-upsert-text",
  "visual-embedding",
  "vector-upsert-visual",
  "finalize"
] as const;

export async function recoverDurableWorkerJobs() {
  const jobs = await listJobs();
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const cleaned = await cleanupStaleRuntimeProcesses(jobs, {
    staleAssetIds: activeJobs.flatMap((job) => (job.assetId ? [job.assetId] : []))
  });
  if (cleaned.terminated > 0) {
    logJson("warn", "jobs.durable.runtime_cleanup", "Cleaned stale runtime processes before durable job recovery", cleaned);
  }

  let reset = 0;
  for (const job of activeJobs.filter((item) => item.status === "running")) {
    await resetRunningJob(job);
    reset += 1;
  }

  const dispatch = await enqueueQueuedAssetJobs();
  if (activeJobs.length > 0) {
    logJson("warn", "jobs.durable.recovered", "Recovered durable worker jobs after worker restart", {
      active: activeJobs.length,
      reset,
      redisQueued: dispatch.queued,
      redisEnqueued: dispatch.enqueued,
      redisFailed: dispatch.failed
    });
  }
}

async function resetRunningJob(job: JobRecord) {
  const resumeFromStage = findResumeStage(job, indexingCheckpointOrder) ?? job.stage;
  await updateJob(
    job.id,
    {
      status: "queued",
      stage: resumeFromStage,
      progress: job.progress,
      parameters: {
        ...(job.parameters ?? {}),
        resumeFromStage
      },
      error: null,
      completedAt: null
    },
    `Durable worker recovered running job after worker restart; Redis execution will resume from checkpoint stage: ${resumeFromStage}.`,
    "warn"
  );
}
