import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../jsonFileStore";
import { logJson } from "../observability";
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

const outboxPath = path.resolve(".data", "queue-outbox.json");
let outboxEntries: QueueOutboxEntry[] = [];
let loaded = false;
let writeChain = Promise.resolve();

export function createAssetJobOutboxEntry(jobId: string): QueueOutboxEntry {
  return createQueueOutboxEntry("asset-job", jobId, { jobId });
}

export function createAskOperationOutboxEntry(operationId: string): QueueOutboxEntry {
  return createQueueOutboxEntry("ask-operation", operationId, { operationId });
}

export async function addQueueOutboxEntry(entry: QueueOutboxEntry) {
  if (pgStore.isPostgresEnabled()) return pgStore.saveQueueOutboxEntry(entry);
  await ensureLocalOutbox();
  const existing = outboxEntries.findIndex((item) => item.id === entry.id);
  if (existing >= 0) outboxEntries[existing] = entry;
  else outboxEntries.push(entry);
  await persistLocalOutbox();
  return entry;
}

export async function listPendingQueueOutboxEntries(kind?: QueueOutboxKind, limit = 100) {
  if (pgStore.isPostgresEnabled()) return pgStore.listPendingQueueOutboxEntries(kind, limit);
  await ensureLocalOutbox();
  const now = Date.now();
  return outboxEntries
    .filter((entry) => {
      if (kind && entry.kind !== kind) return false;
      if (entry.status === "published") return false;
      if (!entry.nextAttemptAt) return true;
      return new Date(entry.nextAttemptAt).getTime() <= now;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

export async function markQueueOutboxPublished(id: string) {
  const now = new Date().toISOString();
  if (pgStore.isPostgresEnabled()) return pgStore.updateQueueOutboxEntry(id, { status: "published", lastError: null, nextAttemptAt: null, publishedAt: now });
  await ensureLocalOutbox();
  updateLocalOutboxEntry(id, { status: "published", lastError: null, nextAttemptAt: null, publishedAt: now, updatedAt: now });
  await persistLocalOutbox();
}

export async function markQueueOutboxFailed(id: string, message: string, attempts: number) {
  const now = new Date().toISOString();
  const nextAttemptAt = new Date(Date.now() + retryDelayMs(attempts)).toISOString();
  if (pgStore.isPostgresEnabled()) return pgStore.updateQueueOutboxEntry(id, { status: "failed", lastError: message, nextAttemptAt, publishedAt: null });
  await ensureLocalOutbox();
  updateLocalOutboxEntry(id, { status: "failed", lastError: message, nextAttemptAt, publishedAt: null, attempts, updatedAt: now });
  await persistLocalOutbox();
}

export async function saveJobWithQueueOutbox(job: JobRecord, entry: QueueOutboxEntry) {
  if (pgStore.isPostgresEnabled()) {
    const saved = await pgStore.saveJobWithQueueOutbox(job, entry);
    publishRealtimeEvent("job.updated", { jobId: saved.id, assetId: saved.assetId, job: saved });
    return saved;
  }
  const { saveJob } = await import("../store");
  await saveJob(job);
  await addQueueOutboxEntry(entry);
  return job;
}

export async function saveAskOperationWithQueueOutbox(entry: AskOperationEntry, outboxEntry: QueueOutboxEntry) {
  if (pgStore.isPostgresEnabled()) return pgStore.upsertAskOperationEntryWithQueueOutbox(entry, outboxEntry);
  await addQueueOutboxEntry(outboxEntry);
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

async function ensureLocalOutbox() {
  if (loaded) return;
  outboxEntries = await readJsonFile<QueueOutboxEntry[]>(outboxPath, () => [], "queue-outbox");
  loaded = true;
}

async function persistLocalOutbox() {
  const snapshot = outboxEntries.slice(-1000);
  writeChain = writeChain
    .then(() => writeJsonFile(outboxPath, snapshot))
    .catch((error) => {
      logJson("error", "queue.outbox.persist", error instanceof Error ? error.message : "Failed to persist queue outbox");
    });
  await writeChain;
}

function updateLocalOutboxEntry(id: string, patch: Partial<QueueOutboxEntry>) {
  const index = outboxEntries.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  outboxEntries[index] = { ...outboxEntries[index], ...patch };
}

function retryDelayMs(attempts: number) {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
}
