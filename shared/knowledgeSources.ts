import type { KnowledgeSourceId } from "./types";

export type KnowledgeSourceMetadata = {
  id: KnowledgeSourceId;
  label: string;
  adapter: "sports" | "adult";
  capabilities: {
    knowledgeActionSpotting: boolean;
    domainVlmRefinement: boolean;
    visionTracking: boolean;
  };
};

export const KNOWLEDGE_SOURCES: KnowledgeSourceMetadata[] = [
  {
    id: "sports.football",
    label: "Football",
    adapter: "sports",
    capabilities: {
      knowledgeActionSpotting: true,
      domainVlmRefinement: true,
      visionTracking: true
    }
  },
  {
    id: "sports.american_football",
    label: "American football",
    adapter: "sports",
    capabilities: {
      knowledgeActionSpotting: true,
      domainVlmRefinement: true,
      visionTracking: true
    }
  },
  {
    id: "adult.jp_legal",
    label: "Japan legal adult content",
    adapter: "adult",
    capabilities: {
      knowledgeActionSpotting: false,
      domainVlmRefinement: false,
      visionTracking: false
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

export function sourceSupportsDomainVlmRefinement(sourceId: KnowledgeSourceId | null | undefined) {
  return Boolean(KNOWLEDGE_SOURCES.find((source) => source.id === sourceId)?.capabilities.domainVlmRefinement);
}

export function sourceListSupportsDomainVlmRefinement(sourceIds: readonly KnowledgeSourceId[] | null | undefined) {
  return Boolean(sourceIds?.some(sourceSupportsDomainVlmRefinement));
}

export function sourceSupportsVisionTracking(sourceId: KnowledgeSourceId | null | undefined) {
  return Boolean(KNOWLEDGE_SOURCES.find((source) => source.id === sourceId)?.capabilities.visionTracking);
}

export function sourceListSupportsVisionTracking(sourceIds: readonly KnowledgeSourceId[] | null | undefined) {
  return Boolean(sourceIds?.some(sourceSupportsVisionTracking));
}

export function knowledgeSourceAdapter(sourceId: KnowledgeSourceId | null | undefined) {
  return KNOWLEDGE_SOURCES.find((source) => source.id === sourceId)?.adapter ?? null;
}

export function formatKnowledgeSourceLabel(sourceId: KnowledgeSourceId | null | undefined) {
  if (!sourceId) return "None";
  return KNOWLEDGE_SOURCES.find((source) => source.id === sourceId)?.label ?? sourceId;
}
