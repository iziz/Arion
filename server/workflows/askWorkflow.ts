import { getAskOperationEntry, createAskOperation, pruneAskOperations, saveAskOperation, toAskResponse } from "./ask/operationStore";
import { runAskOperation } from "./ask/runOperation";
import type { AskRequest } from "./ask/types";

export { parseAskRequest } from "./ask/request";
export { executeSearchPipeline, scopeAssetsForQuery } from "./ask/searchPipeline";
export type { AskRequest, SearchPipelineRequest } from "./ask/types";

export function startAskOperation(request: AskRequest) {
  const entry = createAskOperation(request);
  pruneAskOperations();
  saveAskOperation(entry);
  void runAskOperation(entry, request);
  return toAskResponse(entry);
}

export function getAskOperationResponse(operationId: string) {
  const entry = getAskOperationEntry(operationId);
  return entry ? toAskResponse(entry) : null;
}
