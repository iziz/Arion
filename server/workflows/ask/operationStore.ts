import { randomUUID } from "node:crypto";
import type { AskOperation, AskResponse } from "../../../shared/types";
import { logJson } from "../../observability";
import * as pgStore from "../../postgresStore";
import { createAskOperationOutboxEntry, saveAskOperationWithQueueOutbox } from "../../services/queueOutboxStore";
import { publishRealtimeEvent } from "../../services/realtimeEvents";
import type { AskOperationEntry, AskRequest } from "./types";

const askOperations = new Map<string, AskOperationEntry>();
let loaded = false;
let writeChain = Promise.resolve();

export function createAskOperation(request: AskRequest) {
  const now = new Date().toISOString();
  return {
    operation: {
      id: randomUUID(),
      query: request.query,
      indexId: request.indexId ?? null,
      status: "queued",
      route: "pending",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
      steps: []
    } satisfies AskOperation,
    request,
    response: null
  };
}

export async function saveAskOperation(entry: AskOperationEntry, options: { queueDispatch?: boolean } = {}) {
  askOperations.set(entry.operation.id, entry);
  const snapshot = cloneAskOperationEntry(entry);
  assertPostgresRuntime();
  if (options.queueDispatch) {
    await saveAskOperationWithQueueOutbox(snapshot, createAskOperationOutboxEntry(entry.operation.id));
  } else {
    await persistAskOperation(snapshot);
  }
  publishAskOperation(entry);
}

export async function getAskOperationEntry(operationId: string) {
  await ensureAskOperationStore();
  await refreshAskOperationStore();
  return askOperations.get(operationId) ?? null;
}

export async function listAskOperations() {
  await ensureAskOperationStore();
  await refreshAskOperationStore();
  return Array.from(askOperations.values()).map(cloneAskOperationEntry);
}

export function updateAskOperation(entry: AskOperationEntry, patch: Partial<Pick<AskOperation, "status" | "route" | "error" | "completedAt">>) {
  patchAskOperation(entry, patch);
  void queuePersistAskOperation(entry);
  publishAskOperation(entry);
}

export function completeAskOperation(entry: AskOperationEntry, response: Omit<AskResponse, "operation"> & { operation: AskOperation }) {
  patchAskOperation(entry, {
    status: "succeeded",
    route: response.route,
    completedAt: new Date().toISOString(),
    error: null
  });
  entry.response = {
    ...response,
    operation: entry.operation
  };
  void queuePersistAskOperation(entry);
  publishAskOperation(entry);
}

export function failAskOperation(entry: AskOperationEntry, message: string) {
  patchAskOperation(entry, {
    status: "failed",
    route: "error",
    completedAt: new Date().toISOString(),
    error: message
  });
  entry.response = {
    operation: entry.operation,
    route: "error",
    answer: message,
    queryPlan: null,
    orchestrationPlan: null,
    knowledgeAnswer: null,
    results: [],
    warnings: [message]
  };
  void queuePersistAskOperation(entry);
  publishAskOperation(entry);
}

function patchAskOperation(entry: AskOperationEntry, patch: Partial<Pick<AskOperation, "status" | "route" | "error" | "completedAt">>) {
  entry.operation = {
    ...entry.operation,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  askOperations.set(entry.operation.id, entry);
}

export function toAskResponse(entry: AskOperationEntry): AskResponse {
  return entry.response ?? {
    operation: entry.operation,
    route: entry.operation.route,
    answer: null,
    queryPlan: null,
    orchestrationPlan: null,
    knowledgeAnswer: null,
    results: [],
    warnings: []
  };
}

export async function pruneAskOperations() {
  await ensureAskOperationStore();
  const entries = Array.from(askOperations.values());
  if (entries.length < 80) return;
  const removable = entries
    .filter((entry) => entry.operation.status === "succeeded" || entry.operation.status === "failed")
    .sort((a, b) => new Date(a.operation.updatedAt).getTime() - new Date(b.operation.updatedAt).getTime())
    .slice(0, Math.max(0, entries.length - 60));
  const ids = removable.map((entry) => entry.operation.id);
  for (const id of ids) askOperations.delete(id);
  await deletePersistedAskOperations(ids);
}

export async function ensureAskOperationStore() {
  if (loaded) return;
  askOperations.clear();
  await mergePersistedAskOperationEntries();
  loaded = true;
}

async function refreshAskOperationStore() {
  await mergePersistedAskOperationEntries();
}

async function persistAskOperation(entry: AskOperationEntry) {
  assertPostgresRuntime();
  await pgStore.upsertAskOperationEntry(entry);
}

async function queuePersistAskOperation(entry: AskOperationEntry) {
  const snapshot = cloneAskOperationEntry(entry);
  writeChain = writeChain
    .then(() => persistAskOperation(snapshot))
    .catch((error) => {
      logAskOperationPersistenceError(snapshot.operation.id, error);
    });
  await writeChain;
}

async function deletePersistedAskOperations(ids: string[]) {
  if (ids.length === 0) return;
  const deleteTask = writeChain.then(async () => {
    assertPostgresRuntime();
    await pgStore.deleteAskOperationEntries(ids);
  });
  writeChain = deleteTask.catch((error) => {
    logJson("error", "ask.operation.prune", "Failed to prune persisted ask operations", {
      operationIds: ids,
      error: error instanceof Error ? error.message : "Unknown persistence error"
    });
  });
  await deleteTask;
}

function cloneAskOperationEntry(entry: AskOperationEntry): AskOperationEntry {
  return JSON.parse(JSON.stringify(entry)) as AskOperationEntry;
}

async function mergePersistedAskOperationEntries() {
  assertPostgresRuntime();
  const entries = await pgStore.listAskOperationEntries();
  for (const entry of entries) {
    const normalized = normalizeAskOperationEntry(entry);
    if (!normalized) continue;
    const current = askOperations.get(normalized.operation.id);
    if (!current || new Date(normalized.operation.updatedAt).getTime() >= new Date(current.operation.updatedAt).getTime()) {
      askOperations.set(normalized.operation.id, normalized);
    }
  }
}

function assertPostgresRuntime() {
  if (!pgStore.isPostgresEnabled()) {
    throw new Error("PostgreSQL ask operation persistence is required. Set DATABASE_URL or run through Docker infra.");
  }
}

function logAskOperationPersistenceError(operationId: string, error: unknown) {
  logJson("error", "ask.operation.persist", "Failed to persist ask operation", {
    operationId,
    error: error instanceof Error ? error.message : "Unknown persistence error"
  });
}

function publishAskOperation(entry: AskOperationEntry) {
  publishRealtimeEvent("ask.operation.updated", {
    operationId: entry.operation.id,
    operation: entry.operation,
    response: toAskResponse(entry)
  });
}

function normalizeAskOperationEntry(value: unknown): AskOperationEntry | null {
  if (!isAskOperationEntryLike(value)) return null;
  const operation = value.operation;
  return {
    operation,
    request: isAskRequest(value.request) ? value.request : requestFromOperation(operation),
    response: isAskResponse(value.response) ? value.response : null
  };
}

function isAskOperationEntryLike(value: unknown): value is Partial<AskOperationEntry> & { operation: AskOperation } {
  return (
    typeof value === "object" &&
    value !== null &&
    "operation" in value &&
    typeof (value as { operation?: { id?: unknown } }).operation?.id === "string"
  );
}

function isAskRequest(value: unknown): value is AskRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { query?: unknown }).query === "string" &&
    typeof (value as { explicitFilters?: unknown }).explicitFilters === "object" &&
    (value as { explicitFilters?: unknown }).explicitFilters !== null &&
    typeof (value as { useKnowledgeLayer?: unknown }).useKnowledgeLayer === "boolean"
  );
}

function isAskResponse(value: unknown): value is AskOperationEntry["response"] {
  return value === null || (typeof value === "object" && value !== null && "operation" in value);
}

function requestFromOperation(operation: AskOperation): AskRequest {
  return {
    query: operation.query,
    explicitFilters: {},
    indexId: operation.indexId ?? undefined,
    useKnowledgeLayer: true
  };
}
