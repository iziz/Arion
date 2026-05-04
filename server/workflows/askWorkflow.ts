import { ensureAskOperationStore, getAskOperationEntry, createAskOperation, pruneAskOperations, saveAskOperation, toAskResponse } from "./ask/operationStore";
import { publishQueueOutbox } from "../services/queueOutboxPublisher";
import { runAskOperation } from "./ask/runOperation";
import type { AskRequest } from "./ask/types";

export { parseAskRequest } from "./ask/request";
export { executeSearchPipeline, scopeAssetsForQuery } from "./ask/searchPipeline";
export type { AskRequest, SearchPipelineRequest } from "./ask/types";

export async function startAskOperation(request: AskRequest) {
  await ensureAskOperationStore();
  const entry = createAskOperation(request);
  await pruneAskOperations();
  await saveAskOperation(entry, { queueDispatch: true });
  const dispatch = await publishQueueOutbox("ask-operation", 10);
  const response = toAskResponse(entry);
  if (dispatch.failed > 0) {
    return {
      ...response,
      warnings: [
        ...response.warnings,
        "Ask operation persisted to the queue outbox, but immediate Redis dispatch failed; the worker outbox publisher will retry."
      ]
    };
  }
  return response;
}

export async function getAskOperationResponse(operationId: string) {
  const entry = await getAskOperationEntry(operationId);
  return entry ? toAskResponse(entry) : null;
}

export async function runAskOperationById(operationId: string) {
  const entry = await getAskOperationEntry(operationId);
  if (!entry) {
    throw new Error(`Ask operation not found: ${operationId}`);
  }
  if (entry.operation.status !== "queued") {
    return { ran: false, reason: `Ask operation is ${entry.operation.status}` };
  }
  await runAskOperation(entry, entry.request);
  return { ran: true };
}
