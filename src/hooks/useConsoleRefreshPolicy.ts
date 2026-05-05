import type { JobRecord } from "../../shared/types";

export const ACTIVE_CONSOLE_REFRESH_INTERVAL_MS = 2000;

type RefreshableJob = Pick<JobRecord, "status">;

export function isRefreshableActiveJob(job: RefreshableJob) {
  return job.status === "running" || job.status === "queued";
}

export function getConsoleRefreshIntervalMs(jobs: RefreshableJob[]) {
  return jobs.some(isRefreshableActiveJob) ? ACTIVE_CONSOLE_REFRESH_INTERVAL_MS : null;
}
