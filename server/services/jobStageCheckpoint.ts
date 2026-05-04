import type { JobRecord, JobStageCheckpoint } from "../../shared/types";
import { getJob } from "../store";
import { updateJob } from "./jobState";

export type JobStageOrder = readonly string[];

export async function startJobStageCheckpoint(jobId: string, stage: string, progress: number, message: string) {
  const job = await getJob(jobId);
  if (!job) return null;
  const now = new Date().toISOString();
  const previous = job.stageCheckpoints?.[stage];
  const checkpoint: JobStageCheckpoint = {
    stage,
    status: "running",
    message,
    progress,
    error: null,
    startedAt: previous?.status === "running" ? previous.startedAt : now,
    updatedAt: now,
    completedAt: null,
    attempts: (previous?.attempts ?? 0) + (previous?.status === "running" ? 0 : 1)
  };
  return updateJob(jobId, { stageCheckpoints: { ...(job.stageCheckpoints ?? {}), [stage]: checkpoint } });
}

export async function completeJobStageCheckpoint(jobId: string, stage: string, progress: number, message: string, status: JobStageCheckpoint["status"] = "succeeded") {
  const job = await getJob(jobId);
  if (!job) return null;
  const now = new Date().toISOString();
  const previous = job.stageCheckpoints?.[stage];
  const checkpoint: JobStageCheckpoint = {
    stage,
    status,
    message,
    progress,
    error: null,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    completedAt: now,
    attempts: Math.max(previous?.attempts ?? 1, 1)
  };
  return updateJob(jobId, { stageCheckpoints: { ...(job.stageCheckpoints ?? {}), [stage]: checkpoint } });
}

export async function failActiveJobStageCheckpoint(jobId: string, message: string) {
  const job = await getJob(jobId);
  if (!job) return null;
  const stage = findRunningCheckpointStage(job) ?? normalizeCheckpointStage(job.stage);
  if (!stage) return null;
  return failJobStageCheckpoint(jobId, stage, message);
}

export async function failJobStageCheckpoint(jobId: string, stage: string, message: string) {
  const job = await getJob(jobId);
  if (!job) return null;
  const now = new Date().toISOString();
  const previous = job.stageCheckpoints?.[stage];
  const checkpoint: JobStageCheckpoint = {
    stage,
    status: "failed",
    message,
    progress: previous?.progress ?? job.progress,
    error: message,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    completedAt: now,
    attempts: Math.max(previous?.attempts ?? 1, 1)
  };
  return updateJob(jobId, {
    stageCheckpoints: { ...(job.stageCheckpoints ?? {}), [stage]: checkpoint },
    parameters: {
      ...(job.parameters ?? {}),
      resumeFromStage: stage
    }
  });
}

export function shouldRunJobStage(job: JobRecord | null, stage: string, order: JobStageOrder, retryStage?: string | null) {
  if (!job) return true;
  const forcedStage = normalizeCheckpointStage(retryStage ?? job.parameters?.retryStage ?? job.parameters?.resumeFromStage);
  if (forcedStage) return isAtOrAfterStage(stage, forcedStage, order);
  const checkpoint = job.stageCheckpoints?.[stage];
  return checkpoint?.status !== "succeeded" && checkpoint?.status !== "skipped";
}

export function findResumeStage(job: JobRecord, order: JobStageOrder) {
  const explicit = normalizeCheckpointStage(job.parameters?.resumeFromStage);
  if (explicit) return explicit;
  const failed = order.find((stage) => job.stageCheckpoints?.[stage]?.status === "failed");
  if (failed) return failed;
  const running = order.find((stage) => job.stageCheckpoints?.[stage]?.status === "running");
  if (running) return running;
  return normalizeCheckpointStage(job.stage);
}

export function normalizeCheckpointStage(value: unknown) {
  if (typeof value !== "string") return null;
  const stage = value.trim();
  return stage.length > 0 && stage !== "queued" && stage !== "claimed" && stage !== "failed" ? stage : null;
}

function findRunningCheckpointStage(job: JobRecord) {
  const checkpoints = Object.values(job.stageCheckpoints ?? {});
  return checkpoints.find((checkpoint) => checkpoint.status === "running")?.stage ?? null;
}

function isAtOrAfterStage(stage: string, forcedStage: string, order: JobStageOrder) {
  const stageIndex = order.indexOf(stage);
  const forcedIndex = order.indexOf(forcedStage);
  if (stageIndex < 0 || forcedIndex < 0) return stage === forcedStage;
  return stageIndex >= forcedIndex;
}
