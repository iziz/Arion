import "./env";
import { hostname } from "node:os";
import { closePostgresStore } from "./postgresStore";
import { logJson } from "./observability";
import { runAskOperationById } from "./workflows/askWorkflow";
import {
  askOperationQueueName,
  askQueueReconcileIntervalMs,
  askWorkerConcurrency,
  closeAskOperationQueue,
  createAskOperationWorker,
  enqueueQueuedAskOperations,
  redisUrl,
  resetRunningAskOperations
} from "./services/askJobQueue";
import { publishQueueOutbox, startQueueOutboxPublisher } from "./services/queueOutboxPublisher";
import { waitForRedisReady } from "./services/redisHealth";

const workerId = process.env.ASK_WORKER_ID ?? `${hostname()}-${process.pid}`;

await waitForRedisReady({
  component: "ask operation worker",
  event: "ask.worker.redis_wait",
  redisUrl,
  workerId
});
const recovered = await recoverAskOperations();
await publishQueueOutbox("ask-operation");

const worker = createAskOperationWorker(async (redisJob) => {
  const operationId = redisJob.data.operationId || redisJob.id;
  if (!operationId) {
    logJson("error", "ask.worker.missing_operation_id", "Redis job is missing AskOperation id", { redisJobId: redisJob.id, workerId });
    return;
  }

  const result = await runAskOperationById(operationId);
  if (!result.ran) {
    logJson("info", "ask.worker.skip_execution", "Ask operation skipped by worker", {
      operationId,
      reason: result.reason,
      workerId
    });
  }
});

worker.on("completed", (job) => {
  logJson("info", "ask.worker.completed", "Redis worker completed ask operation", { redisJobId: job.id, workerId });
});

worker.on("failed", (job, error) => {
  logJson("error", "ask.worker.failed", error.message, { redisJobId: job?.id, workerId });
});

worker.on("error", (error) => {
  logJson("error", "ask.worker.error", error.message, { workerId });
});

const reconcileTimer = setInterval(() => {
  void enqueueQueuedAskOperations().catch((error) => {
    logJson("error", "ask.worker.reconcile_failed", error instanceof Error ? error.message : "Failed to reconcile queued ask operations", { workerId });
  });
}, askQueueReconcileIntervalMs);
const outboxPublisherStop = startQueueOutboxPublisher("ask-operation", askQueueReconcileIntervalMs);

logJson("info", "ask.worker.started", "Redis ask operation worker started", {
  workerId,
  queue: askOperationQueueName,
  concurrency: askWorkerConcurrency,
  reconcileIntervalMs: askQueueReconcileIntervalMs,
  recovered
});

await waitForShutdown();

async function recoverAskOperations() {
  const reset = await resetRunningAskOperations();
  const dispatch = await enqueueQueuedAskOperations();
  if (reset.reset > 0 || dispatch.queued > 0) {
    logJson("warn", "ask.durable.recovered", "Recovered durable ask operations after worker restart", {
      reset: reset.reset,
      redisQueued: dispatch.queued,
      redisEnqueued: dispatch.enqueued,
      redisFailed: dispatch.failed
    });
  }
  return { ...reset, ...dispatch };
}

function waitForShutdown() {
  return new Promise<void>((resolve) => {
    const shutdown = () => {
      clearInterval(reconcileTimer);
      outboxPublisherStop();
      void worker
        .close()
        .then(() => closeAskOperationQueue())
        .then(() => closePostgresStore())
        .then(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
