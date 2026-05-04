import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import IORedis from "ioredis";
import { logJson } from "../observability";
import { getAskOperationEntry, listAskOperations, updateAskOperation } from "../workflows/ask/operationStore";

export type RedisAskOperationData = {
  operationId: string;
};

export const askOperationQueueName = normalizeBullMqQueueName(process.env.ASK_QUEUE_NAME, "arion-ask-operations");
export const askWorkerConcurrency = parsePositiveInteger(process.env.ASK_WORKER_CONCURRENCY, 2);
export const askQueueReconcileIntervalMs = parsePositiveInteger(process.env.ASK_QUEUE_RECONCILE_MS, 15000);
export const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const defaultJobOptions: JobsOptions = {
  attempts: 1,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 }
};

let queueConnection: IORedis | null = null;
let queue: Queue<RedisAskOperationData> | null = null;

export async function enqueueAskOperationExecution(operationId: string, options: { recordFailure?: boolean } = {}) {
  try {
    await getAskOperationQueue().add("ask-operation", { operationId }, { ...defaultJobOptions, jobId: operationId });
    return { enqueued: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue ask operation";
    logJson("error", "ask.redis.enqueue_failed", message, { operationId });
    if (options.recordFailure) {
      const entry = await getAskOperationEntry(operationId);
      if (entry) {
        const now = new Date().toISOString();
        entry.operation.steps = [
          ...entry.operation.steps.filter((step) => step.id !== "dispatch"),
          {
            id: "dispatch",
            label: "Ask queue dispatch",
            owner: "platform",
            input: `queue=${askOperationQueueName}`,
            output: `Redis dispatch failed; operation remains queued for worker reconciliation: ${message}`,
            status: "fallback",
            startedAt: now,
            completedAt: now,
            durationMs: 0,
            error: message
          }
        ];
        updateAskOperation(entry, {});
      }
    }
    return { enqueued: false, reason: message };
  }
}

export async function enqueueQueuedAskOperations() {
  const operations = await listAskOperations();
  const queued = operations.filter((entry) => entry.operation.status === "queued");
  let enqueued = 0;
  let failed = 0;
  for (const entry of queued) {
    const result = await enqueueAskOperationExecution(entry.operation.id);
    if (result.enqueued) enqueued += 1;
    else failed += 1;
  }
  return { queued: queued.length, enqueued, failed };
}

export async function resetRunningAskOperations() {
  const operations = await listAskOperations();
  const running = operations.filter((entry) => entry.operation.status === "running");
  for (const entry of running) {
    updateAskOperation(entry, {
      status: "queued",
      route: "pending",
      error: null,
      completedAt: null
    });
  }
  return { reset: running.length };
}

export function createAskOperationWorker(processor: Processor<RedisAskOperationData, void, string>) {
  return new Worker<RedisAskOperationData, void, string>(askOperationQueueName, processor, {
    connection: createRedisConnection("worker"),
    concurrency: askWorkerConcurrency
  });
}

export async function closeAskOperationQueue() {
  await queue?.close();
  queue = null;
  await queueConnection?.quit();
  queueConnection = null;
}

function getAskOperationQueue() {
  if (!queue) {
    queueConnection = createRedisConnection("producer");
    queue = new Queue<RedisAskOperationData>(askOperationQueueName, { connection: queueConnection });
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
    logJson("warn", "ask.redis.queue_name_normalized", "BullMQ queue names cannot contain ':'; using a normalized ask operation queue name.", {
      configured: raw,
      normalized
    });
  }
  return normalized;
}
