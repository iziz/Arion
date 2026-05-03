import { randomUUID } from "node:crypto";
import type { AskOperation, AskResponse } from "../../../shared/types";
import type { AskOperationEntry, AskRequest } from "./types";

const askOperations = new Map<string, AskOperationEntry>();

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
    response: null
  };
}

export function saveAskOperation(entry: AskOperationEntry) {
  askOperations.set(entry.operation.id, entry);
}

export function getAskOperationEntry(operationId: string) {
  return askOperations.get(operationId) ?? null;
}

export function updateAskOperation(entry: AskOperationEntry, patch: Partial<Pick<AskOperation, "status" | "route" | "error" | "completedAt">>) {
  entry.operation = {
    ...entry.operation,
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

export function completeAskOperation(entry: AskOperationEntry, response: Omit<AskResponse, "operation"> & { operation: AskOperation }) {
  updateAskOperation(entry, {
    status: "succeeded",
    route: response.route,
    completedAt: new Date().toISOString(),
    error: null
  });
  entry.response = {
    ...response,
    operation: entry.operation
  };
}

export function failAskOperation(entry: AskOperationEntry, message: string) {
  updateAskOperation(entry, {
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
    sportsAnswer: null,
    results: [],
    warnings: [message]
  };
}

export function toAskResponse(entry: AskOperationEntry): AskResponse {
  return entry.response ?? {
    operation: entry.operation,
    route: entry.operation.route,
    answer: null,
    queryPlan: null,
    orchestrationPlan: null,
    sportsAnswer: null,
    results: [],
    warnings: []
  };
}

export function pruneAskOperations() {
  const entries = Array.from(askOperations.values());
  if (entries.length < 80) return;
  const removable = entries
    .filter((entry) => entry.operation.status === "succeeded" || entry.operation.status === "failed")
    .sort((a, b) => new Date(a.operation.updatedAt).getTime() - new Date(b.operation.updatedAt).getTime())
    .slice(0, Math.max(0, entries.length - 60));
  for (const entry of removable) askOperations.delete(entry.operation.id);
}
