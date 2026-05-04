import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import IORedis from "ioredis";
import { logJson } from "../observability";
import { listJobs } from "../store";
import type { JobRecord } from "../../shared/types";
import { isSupportedAssetJob } from "./assetJobRunner";
import { updateJob } from "./jobState";

export type RedisAssetJobData = {
  jobId: string;
};

export const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
export const assetJobQueueName = process.env.JOB_QUEUE_NAME ?? "arion:asset-jobs";
export const jobWorkerConcurrency = parsePositiveInteger(process.env.JOB_WORKER_CONCURRENCY, 1);

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
    await getAssetJobQueue().add("asset-job", { jobId: job.id }, { ...defaultJobOptions, jobId: job.id });
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
  return new Worker<RedisAssetJobData, void, string>(assetJobQueueName, processor, {
    connection: createRedisConnection("worker"),
    concurrency: jobWorkerConcurrency
  });
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
