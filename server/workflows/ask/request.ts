import { parseDomainFilters } from "../../queryPlanner";
import type { AskRequest } from "./types";

export function parseAskRequest(body: unknown): AskRequest {
  const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const filtersValue = typeof value.domainFilters === "object" && value.domainFilters !== null ? value.domainFilters as Record<string, unknown> : value;
  const limit = typeof value.limit === "number" && Number.isFinite(value.limit) ? value.limit : undefined;
  return {
    query: typeof value.q === "string" ? value.q.trim() : typeof value.query === "string" ? value.query.trim() : "",
    explicitFilters: parseDomainFilters(filtersValue),
    indexId: typeof value.indexId === "string" && value.indexId.trim() ? value.indexId.trim() : undefined,
    domainGroup: domainGroupValue(value.domainGroup),
    tag: typeof value.tag === "string" && value.tag.trim() ? value.tag.trim() : undefined,
    modality: typeof value.modality === "string" && value.modality.trim() ? value.modality.trim() : undefined,
    limit,
    useKnowledgeLayer: value.useKnowledgeLayer !== false
  };
}

function domainGroupValue(value: unknown) {
  return value === "sports.football" || value === "sports.american_football" ? value : undefined;
}
