import type { KnowledgeEvidence, KnowledgeSourceId, KnowledgeVectorStoreStatus } from "../shared/types";

export type KnowledgeVectorStatusRecord = {
  domainGroup: KnowledgeSourceId;
  provider: KnowledgeEvidence["source"];
  kind: KnowledgeEvidence["kind"];
  vectors?: number;
};

export function buildKnowledgeVectorStatus(
  records: KnowledgeVectorStatusRecord[],
  storage: KnowledgeVectorStoreStatus["storage"]
): KnowledgeVectorStoreStatus {
  const domainCounts = new Map<KnowledgeSourceId, number>();
  const providerCounts = new Map<KnowledgeEvidence["source"], number>();
  const kindCounts = new Map<KnowledgeEvidence["kind"], number>();
  const domainProviderCounts = new Map<KnowledgeSourceId, Map<KnowledgeEvidence["source"], number>>();
  const domainKindCounts = new Map<KnowledgeSourceId, Map<KnowledgeEvidence["kind"], number>>();
  let vectors = 0;

  for (const record of records) {
    const count = Math.max(0, Math.floor(record.vectors ?? 1));
    vectors += count;
    increment(domainCounts, record.domainGroup, count);
    increment(providerCounts, record.provider, count);
    increment(kindCounts, record.kind, count);
    increment(nestedMap(domainProviderCounts, record.domainGroup), record.provider, count);
    increment(nestedMap(domainKindCounts, record.domainGroup), record.kind, count);
  }

  return {
    storage,
    vectors,
    domains: sortedEntries(domainCounts).map(([domainGroup, count]) => ({
      domainGroup,
      vectors: count,
      providers: sortedEntries(domainProviderCounts.get(domainGroup) ?? new Map()).map(([provider, providerCount]) => ({ provider, vectors: providerCount })),
      kinds: sortedEntries(domainKindCounts.get(domainGroup) ?? new Map()).map(([kind, kindCount]) => ({ kind, vectors: kindCount }))
    })),
    providers: sortedEntries(providerCounts).map(([provider, count]) => ({ provider, vectors: count })),
    kinds: sortedEntries(kindCounts).map(([kind, count]) => ({ kind, vectors: count }))
  };
}

function nestedMap<K, V extends string>(map: Map<K, Map<V, number>>, key: K) {
  const current = map.get(key);
  if (current) return current;
  const next = new Map<V, number>();
  map.set(key, next);
  return next;
}

function increment<K>(map: Map<K, number>, key: K, count: number) {
  map.set(key, (map.get(key) ?? 0) + count);
}

function sortedEntries<K extends string>(map: Map<K, number>) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
