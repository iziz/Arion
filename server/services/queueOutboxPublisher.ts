import { getJob } from "../store";
import { getAskOperationEntry } from "../workflows/ask/operationStore";
import { enqueueAskOperationExecution } from "./askJobQueue";
import { enqueueJobExecution } from "./redisJobQueue";
import {
  listPendingQueueOutboxEntries,
  markQueueOutboxFailed,
  markQueueOutboxPublished,
  type QueueOutboxKind
} from "./queueOutboxStore";
import { logJson } from "../observability";
import { publishRealtimeEvent } from "./realtimeEvents";

export async function publishQueueOutbox(kind?: QueueOutboxKind, limit = 100) {
  const entries = await listPendingQueueOutboxEntries(kind, limit);
  let published = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      const result = entry.kind === "asset-job" ? await publishAssetJob(entry.aggregateId) : await publishAskOperation(entry.aggregateId);
      if (!result.enqueued) throw new Error(result.reason ?? "Queue dispatch was not enqueued");
      await markQueueOutboxPublished(entry.id);
      published += 1;
      publishRealtimeEvent("outbox.updated", { outboxId: entry.id, kind: entry.kind, aggregateId: entry.aggregateId, status: "published" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Queue outbox publish failed";
      await markQueueOutboxFailed(entry.id, message, entry.attempts + 1);
      failed += 1;
      logJson("warn", "queue.outbox.publish_failed", message, {
        outboxId: entry.id,
        kind: entry.kind,
        aggregateId: entry.aggregateId,
        attempts: entry.attempts + 1
      });
      publishRealtimeEvent("outbox.updated", { outboxId: entry.id, kind: entry.kind, aggregateId: entry.aggregateId, status: "failed", error: message });
    }
  }
  return { pending: entries.length, published, failed };
}

export function startQueueOutboxPublisher(kind: QueueOutboxKind, intervalMs: number) {
  const timer = setInterval(() => {
    void publishQueueOutbox(kind).catch((error) => {
      logJson("error", "queue.outbox.publisher_failed", error instanceof Error ? error.message : "Queue outbox publisher failed", { kind });
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

async function publishAssetJob(jobId: string) {
  const job = await getJob(jobId);
  if (!job) return { enqueued: false, reason: `JobRecord not found: ${jobId}` };
  if (job.status !== "queued") return { enqueued: true, reason: `JobRecord is ${job.status}; dispatch is no longer required.` };
  return enqueueJobExecution(job, { recordFailure: true });
}

async function publishAskOperation(operationId: string) {
  const entry = await getAskOperationEntry(operationId);
  if (!entry) return { enqueued: false, reason: `AskOperation not found: ${operationId}` };
  if (entry.operation.status !== "queued") return { enqueued: true, reason: `AskOperation is ${entry.operation.status}; dispatch is no longer required.` };
  return enqueueAskOperationExecution(operationId, { recordFailure: true });
}
