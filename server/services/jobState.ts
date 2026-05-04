import { randomUUID } from "node:crypto";
import { getAsset, getJob, listJobs, saveAsset, saveJob } from "../store";
import type { AssetRecord, JobRecord } from "../../shared/types";
import { createAssetJobOutboxEntry, saveJobWithQueueOutbox } from "./queueOutboxStore";

export async function createJob(type: JobRecord["type"], indexId: string | null, assetId: string | null, parameters?: JobRecord["parameters"]) {
  const job = buildJob(type, indexId, assetId, parameters);
  return saveJob(job);
}

export async function createQueuedAssetJob(
  type: JobRecord["type"],
  indexId: string | null,
  assetId: string | null,
  parameters?: JobRecord["parameters"]
) {
  const job = buildJob(type, indexId, assetId, parameters);
  return saveJobWithQueueOutbox(job, createAssetJobOutboxEntry(job.id));
}

export async function getActiveAssetJob(assetId: string) {
  const jobs = await listJobs();
  return jobs.find((job) => job.assetId === assetId && (job.status === "queued" || job.status === "running")) ?? null;
}

export async function updateJob(
  id: string,
  patch: Partial<JobRecord>,
  logMessage?: string,
  level: JobRecord["logs"][number]["level"] = "info"
) {
  const current = await getJob(id);
  if (!current) return null;
  const next: JobRecord = {
    ...current,
    ...patch,
    logs: logMessage ? [...current.logs, { at: new Date().toISOString(), level, message: logMessage }] : current.logs,
    updatedAt: new Date().toISOString()
  };
  return saveJob(next);
}

export async function updateAsset(id: string, patch: Partial<AssetRecord>) {
  const current = await getAsset(id);
  if (!current) return null;
  return saveAsset({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function buildJob(type: JobRecord["type"], indexId: string | null, assetId: string | null, parameters?: JobRecord["parameters"]) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    type,
    status: "queued",
    stage: "queued",
    progress: 0,
    indexId,
    assetId,
    ...(parameters ? { parameters } : {}),
    runtimeStages: {},
    stageCheckpoints: {},
    logs: [{ at: now, level: "info", message: "Job queued" }],
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  } satisfies JobRecord;
}
