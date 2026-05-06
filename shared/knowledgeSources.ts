import type { KnowledgeSourceId } from "./types";

export type KnowledgeSourceMetadata = {
  id: KnowledgeSourceId;
  label: string;
  adapter: "sports";
  capabilities: {
    knowledgeActionSpotting: boolean;
  };
};

export const KNOWLEDGE_SOURCES: KnowledgeSourceMetadata[] = [
  {
    id: "sports.football",
    label: "Football",
    adapter: "sports",
    capabilities: {
      knowledgeActionSpotting: true
    }
  },
  {
    id: "sports.american_football",
    label: "American football",
    adapter: "sports",
    capabilities: {
      knowledgeActionSpotting: true
    }
  }
];

const knowledgeSourceIds = new Set(KNOWLEDGE_SOURCES.map((source) => source.id));

export function isKnownKnowledgeSourceId(value: unknown): value is KnowledgeSourceId {
  return typeof value === "string" && knowledgeSourceIds.has(value);
}

export function sourceSupportsKnowledgeActionSpotting(sourceId: KnowledgeSourceId | null | undefined) {
  return Boolean(KNOWLEDGE_SOURCES.find((source) => source.id === sourceId)?.capabilities.knowledgeActionSpotting);
}

export function sourceListSupportsKnowledgeActionSpotting(sourceIds: readonly KnowledgeSourceId[] | null | undefined) {
  return Boolean(sourceIds?.some(sourceSupportsKnowledgeActionSpotting));
}

export function formatKnowledgeSourceLabel(sourceId: KnowledgeSourceId | null | undefined) {
  if (!sourceId) return "None";
  return KNOWLEDGE_SOURCES.find((source) => source.id === sourceId)?.label ?? sourceId;
}
