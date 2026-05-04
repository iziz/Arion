import { randomUUID } from "node:crypto";
import * as pgStore from "../postgresStore";
import type { AskOperationEntry } from "../workflows/ask/types";
import type { JobRecord } from "../../shared/types";
import { publishRealtimeEvent } from "./realtimeEvents";

export type QueueOutboxKind = "asset-job" | "ask-operation";

export type QueueOutboxEntry = {
  id: string;
  kind: QueueOutboxKind;
  aggregateId: string;
  payload: Record<string, string>;
  status: "pending" | "published" | "failed";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export function createAssetJobOutboxEntry(jobId: string): QueueOutboxEntry {
  return createQueueOutboxEntry("asset-job", jobId, { jobId });
}

export function createAskOperationOutboxEntry(operationId: string): QueueOutboxEntry {
  return createQueueOutboxEntry("ask-operation", operationId, { operationId });
}

export async function addQueueOutboxEntry(entry: QueueOutboxEntry) {
  assertPostgresRuntime();
  return pgStore.saveQueueOutboxEntry(entry);
}

export async function listPendingQueueOutboxEntries(kind?: QueueOutboxKind, limit = 100) {
  assertPostgresRuntime();
  return pgStore.listPendingQueueOutboxEntries(kind, limit);
}

export async function markQueueOutboxPublished(id: string) {
  assertPostgresRuntime();
  const now = new Date().toISOString();
  return pgStore.updateQueueOutboxEntry(id, { status: "published", lastError: null, nextAttemptAt: null, publishedAt: now });
}

export async function markQueueOutboxFailed(id: string, message: string, attempts: number) {
  assertPostgresRuntime();
  const nextAttemptAt = new Date(Date.now() + retryDelayMs(attempts)).toISOString();
  return pgStore.updateQueueOutboxEntry(id, { status: "failed", lastError: message, nextAttemptAt, publishedAt: null });
}

export async function saveJobWithQueueOutbox(job: JobRecord, entry: QueueOutboxEntry) {
  assertPostgresRuntime();
  const saved = await pgStore.saveJobWithQueueOutbox(job, entry);
  publishRealtimeEvent("job.updated", { jobId: saved.id, assetId: saved.assetId, job: saved });
  return saved;
}

export async function saveAskOperationWithQueueOutbox(entry: AskOperationEntry, outboxEntry: QueueOutboxEntry) {
  assertPostgresRuntime();
  return pgStore.upsertAskOperationEntryWithQueueOutbox(entry, outboxEntry);
}

function createQueueOutboxEntry(kind: QueueOutboxKind, aggregateId: string, payload: Record<string, string>): QueueOutboxEntry {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind,
    aggregateId,
    payload,
    status: "pending",
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    publishedAt: null
  };
}

function retryDelayMs(attempts: number) {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
}

function assertPostgresRuntime() {
  if (!pgStore.isPostgresEnabled()) {
    throw new Error("PostgreSQL queue outbox persistence is required. Set DATABASE_URL or run through Docker infra.");
  }
}
