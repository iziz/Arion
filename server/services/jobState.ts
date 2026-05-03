import { randomUUID } from "node:crypto";
import { getAsset, getJob, listJobs, saveAsset, saveJob } from "../store";
import { logJson } from "../observability";
import type { AssetRecord, JobRecord } from "../../shared/types";
import { cleanupStaleRuntimeProcesses } from "./runtimeProcessCleanup";

export async function createJob(type: JobRecord["type"], indexId: string | null, assetId: string | null) {
  const now = new Date().toISOString();
  const job: JobRecord = {
    id: randomUUID(),
    type,
    status: "queued",
    stage: "queued",
    progress: 0,
    indexId,
    assetId,
    runtimeStages: {},
    logs: [{ at: now, level: "info", message: "Job queued" }],
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };
  return saveJob(job);
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

export async function recoverDetachedLocalJobs() {
  const jobs = await listJobs();
  const detachedJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  for (const job of detachedJobs) {
    const asset = job.assetId ? await getAsset(job.assetId) : null;
    const hasPreviousIndex = Boolean(asset?.timeline.length);
    const message = hasPreviousIndex
      ? "Detached local job recovered after server restart; previous indexed data was preserved."
      : "Detached local job recovered after server restart; retry is required.";
    await updateJob(
      job.id,
      {
        status: "failed",
        stage: "stale",
        error: message,
        completedAt: new Date().toISOString()
      },
      message,
      "warn"
    );
    if (asset) {
      await updateAsset(asset.id, {
        status: hasPreviousIndex ? "indexed" : "failed",
        progress: hasPreviousIndex ? 100 : asset.progress,
        error: hasPreviousIndex ? null : message
      });
    }
  }
  if (detachedJobs.length > 0) {
    logJson("warn", "jobs.detached.recovered", "Recovered detached local jobs after server restart", { count: detachedJobs.length });
  }
  const cleaned = await cleanupStaleRuntimeProcesses(await listJobs());
  if (cleaned.terminated > 0) {
    logJson("warn", "jobs.detached.runtime_cleanup", "Cleaned stale runtime processes after job recovery", cleaned);
  }
}
