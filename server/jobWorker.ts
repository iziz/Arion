import "./env";
import { hostname } from "node:os";
import { closePostgresStore } from "./postgresStore";
import { logJson } from "./observability";
import { getJob } from "./store";
import { runAssetJob } from "./services/assetJobRunner";
import { recoverDurableWorkerJobs } from "./services/durableJobRecovery";
import { updateJob } from "./services/jobState";
import { waitForRedisReady } from "./services/redisHealth";
import {
  assetJobQueueName,
  closeAssetJobQueue,
  createAssetJobWorker,
  enqueueQueuedAssetJobs,
  jobWorkerConcurrency,
  redisUrl
} from "./services/redisJobQueue";
import { publishQueueOutbox, startQueueOutboxPublisher } from "./services/queueOutboxPublisher";

const workerId = process.env.JOB_WORKER_ID ?? `${hostname()}-${process.pid}`;
const reconcileIntervalMs = parsePositiveInteger(process.env.JOB_QUEUE_RECONCILE_MS, 15000);

await waitForRedisReady({
  component: "asset job worker",
  event: "jobs.worker.redis_wait",
  redisUrl,
  workerId
});
await recoverDurableWorkerJobs();
await publishQueueOutbox("asset-job");

const worker = createAssetJobWorker(async (redisJob) => {
  const jobId = redisJob.data.jobId || redisJob.id;
  if (!jobId) {
    logJson("error", "jobs.worker.missing_job_id", "Redis job is missing JobRecord id", { redisJobId: redisJob.id });
    return;
  }

  const job = await claimQueuedJob(jobId);
  if (!job) return;

  try {
    const result = await runAssetJob(job);
    if (!result.ran) {
      await failJob(job.id, result.reason);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker job failed";
    await failJob(job.id, message);
    throw error;
  }
});

worker.on("completed", (job) => {
  logJson("info", "jobs.worker.completed", "Redis worker completed asset job", { redisJobId: job.id, workerId });
});

worker.on("failed", (job, error) => {
  logJson("error", "jobs.worker.failed", error.message, { redisJobId: job?.id, workerId });
});

worker.on("error", (error) => {
  logJson("error", "jobs.worker.error", error.message, { workerId });
});

const reconcileTimer = setInterval(() => {
  void enqueueQueuedAssetJobs().catch((error) => {
    logJson("error", "jobs.worker.reconcile_failed", error instanceof Error ? error.message : "Failed to reconcile queued jobs", { workerId });
  });
}, reconcileIntervalMs);
const outboxPublisherStop = startQueueOutboxPublisher("asset-job", reconcileIntervalMs);

logJson("info", "jobs.worker.started", "Redis asset job worker started", {
  workerId,
  queue: assetJobQueueName,
  redisUrl,
  concurrency: jobWorkerConcurrency,
  reconcileIntervalMs
});

await waitForShutdown();

async function claimQueuedJob(jobId: string) {
  const current = await getJob(jobId);
  if (!current) {
    logJson("warn", "jobs.worker.missing_record", "Redis job skipped because JobRecord was not found", { jobId, workerId });
    return null;
  }
  if (current.status !== "queued") {
    logJson("info", "jobs.worker.skip_claim", "Redis job skipped because JobRecord is not queued", {
      jobId,
      status: current.status,
      workerId
    });
    return null;
  }
  return updateJob(
    current.id,
    {
      status: "running",
      stage: "claimed",
      progress: Math.max(current.progress, 1),
      error: null,
      completedAt: null
    },
    `Job claimed by Redis worker ${workerId}`
  );
}

async function failJob(jobId: string, message: string) {
  await updateJob(
    jobId,
    {
      status: "failed",
      stage: "failed",
      progress: 100,
      error: message,
      completedAt: new Date().toISOString()
    },
    message,
    "error"
  );
}

function waitForShutdown() {
  return new Promise<void>((resolve) => {
    const shutdown = () => {
      clearInterval(reconcileTimer);
      outboxPublisherStop();
      void worker
        .close()
        .then(() => closeAssetJobQueue())
        .then(() => closePostgresStore())
        .then(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
