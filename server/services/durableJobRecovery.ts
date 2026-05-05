import { logJson } from "../observability";
import { listJobs } from "../store";
import type { JobRecord, JobStageCheckpoint, RuntimeStageRecord } from "../../shared/types";
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
  let normalized = 0;
  for (const job of activeJobs) {
    if (job.status === "running") {
      await resetInterruptedJob(job);
      reset += 1;
      continue;
    }
    if (hasInterruptedRuntimeState(job)) {
      await normalizeQueuedInterruptedJob(job);
      normalized += 1;
    }
  }

  const dispatch = await enqueueQueuedAssetJobs();
  if (activeJobs.length > 0) {
    logJson("warn", "jobs.durable.recovered", "Recovered durable worker jobs after worker restart", {
      active: activeJobs.length,
      reset,
      normalized,
      redisQueued: dispatch.queued,
      redisEnqueued: dispatch.enqueued,
      redisFailed: dispatch.failed
    });
  }
}

async function resetInterruptedJob(job: JobRecord) {
  const resumeFromStage = findResumeStage(job, indexingCheckpointOrder) ?? job.stage;
  const now = new Date().toISOString();
  const message = `Interrupted by durable worker recovery; stage will rerun from checkpoint: ${resumeFromStage}.`;
  await updateJob(
    job.id,
    {
      status: "queued",
      stage: resumeFromStage,
      progress: job.progress,
      runtimeStages: closeRunningRuntimeStages(job.runtimeStages, now, message),
      stageCheckpoints: closeRunningStageCheckpoints(job.stageCheckpoints, now, message),
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

async function normalizeQueuedInterruptedJob(job: JobRecord) {
  const resumeFromStage = findResumeStage(job, indexingCheckpointOrder) ?? job.stage;
  const now = new Date().toISOString();
  const message = `Stale queued job had interrupted runtime state; stage will rerun from checkpoint: ${resumeFromStage}.`;
  await updateJob(
    job.id,
    {
      stage: resumeFromStage,
      progress: job.progress,
      runtimeStages: closeRunningRuntimeStages(job.runtimeStages, now, message),
      stageCheckpoints: closeRunningStageCheckpoints(job.stageCheckpoints, now, message),
      parameters: {
        ...(job.parameters ?? {}),
        resumeFromStage
      },
      error: null,
      completedAt: null
    },
    `Durable worker normalized stale queued job after worker restart; Redis execution will resume from checkpoint stage: ${resumeFromStage}.`,
    "warn"
  );
}

export function hasInterruptedRuntimeState(job: JobRecord) {
  return (
    Object.values(job.runtimeStages ?? {}).some((stage) => stage.status === "running") ||
    Object.values(job.stageCheckpoints ?? {}).some((checkpoint) => checkpoint.status === "running")
  );
}

export function closeRunningRuntimeStages(runtimeStages: JobRecord["runtimeStages"], now: string, message: string) {
  return mapRecord(runtimeStages, (stage): RuntimeStageRecord =>
    stage.status === "running"
      ? {
          ...stage,
          status: "failed",
          message,
          error: message,
          updatedAt: now,
          completedAt: now
        }
      : stage
  );
}

export function closeRunningStageCheckpoints(stageCheckpoints: JobRecord["stageCheckpoints"], now: string, message: string) {
  return mapRecord(stageCheckpoints, (checkpoint): JobStageCheckpoint =>
    checkpoint.status === "running"
      ? {
          ...checkpoint,
          status: "failed",
          message,
          error: message,
          updatedAt: now,
          completedAt: now
        }
      : checkpoint
  );
}

function mapRecord<T>(record: Record<string, T> | undefined, mapValue: (value: T) => T) {
  return Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, mapValue(value)]));
}
