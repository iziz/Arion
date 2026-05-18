import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import IORedis from "ioredis";
import { logJson, recordLatency } from "../observability";
import { listJobs } from "../store";
import type { JobRecord } from "../../shared/types";
import { isSupportedAssetJob } from "./assetJobRunner";
import { updateJob } from "./jobState";

export type RedisAssetJobData = {
  jobId: string;
};

export const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
export const assetJobQueueName = normalizeBullMqQueueName(process.env.JOB_QUEUE_NAME, "arion-asset-jobs");
export const jobWorkerConcurrency = parsePositiveInteger(process.env.JOB_WORKER_CONCURRENCY, 1);
export const jobWorkerLockDurationMs = parsePositiveInteger(process.env.JOB_WORKER_LOCK_DURATION_MS, 10 * 60 * 1000);
export const jobWorkerStalledIntervalMs = parsePositiveInteger(process.env.JOB_WORKER_STALLED_INTERVAL_MS, 60 * 1000);

const defaultJobOptions: JobsOptions = {
  attempts: 1,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 }
};

let queueConnection: IORedis | null = null;
let queue: Queue<RedisAssetJobData> | null = null;

export async function enqueueJobExecution(job: JobRecord, options: { recordFailure?: boolean } = {}) {
  if (!isSupportedAssetJob(job)) {
    return { enqueued: false, reason: `Unsupported Redis queue job type: ${job.type}` };
  }
  try {
    const queue = getAssetJobQueue();
    const existingJob = await queue.getJob(job.id);
    if (existingJob) {
      const state = await existingJob.getState();
      if (shouldReplaceExistingRedisJob(state)) {
        await existingJob.remove();
        logJson("warn", "jobs.redis.requeue_terminal", "Removed terminal Redis job before requeueing persistent queued job", {
          jobId: job.id,
          redisState: state
        });
      } else {
        return { enqueued: true, reason: `Redis job already exists in ${state} state.` };
      }
    }
    const redisJob = await queue.add("asset-job", { jobId: job.id }, { ...defaultJobOptions, jobId: job.id });
    logJson("info", "jobs.redis.enqueued", "Asset job enqueued in Redis", {
      jobId: job.id,
      redisJobId: redisJob.id,
      queue: assetJobQueueName,
      type: job.type
    });
    return { enqueued: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue Redis job";
    logJson("error", "jobs.redis.enqueue_failed", message, { jobId: job.id, type: job.type });
    if (options.recordFailure) {
      await updateJob(job.id, {}, `Redis dispatch failed; job remains queued for worker reconciliation: ${message}`, "warn");
    }
    return { enqueued: false, reason: message };
  }
}

export function shouldReplaceExistingRedisJob(state: string) {
  return state === "completed" || state === "failed";
}

export async function enqueueQueuedAssetJobs() {
  const jobs = await listJobs();
  const queuedJobs = jobs.filter((job) => job.status === "queued" && isSupportedAssetJob(job));
  let enqueued = 0;
  let failed = 0;
  for (const job of queuedJobs) {
    const result = await enqueueJobExecution(job);
    if (result.enqueued) enqueued += 1;
    else failed += 1;
  }
  return { queued: queuedJobs.length, enqueued, failed };
}

export function createAssetJobWorker(processor: Processor<RedisAssetJobData, void, string>) {
  const worker = new Worker<RedisAssetJobData, void, string>(assetJobQueueName, processor, {
    connection: createRedisConnection("worker"),
    concurrency: jobWorkerConcurrency,
    lockDuration: jobWorkerLockDurationMs,
    stalledInterval: jobWorkerStalledIntervalMs,
    maxStalledCount: 3
  });
  worker.on("active", (job) => {
    const waitMs = Math.max(0, Date.now() - job.timestamp);
    recordLatency("jobs.redis.wait", waitMs, "ok");
    logJson("info", "jobs.redis.active", "Asset job started from Redis queue", {
      jobId: job.data.jobId,
      redisJobId: job.id,
      queue: assetJobQueueName,
      waitMs
    });
  });
  worker.on("completed", (job) => {
    const durationMs = Math.max(0, Date.now() - (job.processedOn ?? Date.now()));
    recordLatency("jobs.redis.process", durationMs, "ok");
    logJson("info", "jobs.redis.completed", "Asset job completed from Redis queue", {
      jobId: job.data.jobId,
      redisJobId: job.id,
      queue: assetJobQueueName,
      durationMs
    });
  });
  worker.on("failed", (job, error) => {
    const durationMs = job?.processedOn ? Math.max(0, Date.now() - job.processedOn) : 0;
    recordLatency("jobs.redis.process", durationMs, "error", error.message);
    logJson("error", "jobs.redis.failed", error.message, {
      jobId: job?.data.jobId,
      redisJobId: job?.id,
      queue: assetJobQueueName,
      durationMs
    });
  });
  worker.on("stalled", (jobId) => {
    logJson("warn", "jobs.redis.stalled", "Asset job stalled in Redis queue", {
      redisJobId: jobId,
      queue: assetJobQueueName
    });
  });
  return worker;
}

export async function closeAssetJobQueue() {
  await queue?.close();
  queue = null;
  await queueConnection?.quit();
  queueConnection = null;
}

function getAssetJobQueue() {
  if (!queue) {
    queueConnection = createRedisConnection("producer");
    queue = new Queue<RedisAssetJobData>(assetJobQueueName, { connection: queueConnection });
  }
  return queue;
}

function createRedisConnection(role: "producer" | "worker") {
  return new IORedis(redisUrl, {
    connectTimeout: 3000,
    enableOfflineQueue: role === "worker",
    maxRetriesPerRequest: role === "worker" ? null : 1
  });
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeBullMqQueueName(value: string | undefined, fallback: string) {
  const raw = (value || fallback).trim() || fallback;
  const normalized = raw.replace(/:/g, "-");
  if (normalized !== raw) {
    logJson("warn", "jobs.redis.queue_name_normalized", "BullMQ queue names cannot contain ':'; using a normalized asset job queue name.", {
      configured: raw,
      normalized
    });
  }
  return normalized;
}
