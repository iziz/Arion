import type { KnowledgeSourceId } from "../shared/types";
import { embedPassageTexts } from "./localEmbeddingRuntime";
import * as pgStore from "./postgresStore";
import type { KnowledgeDocument, KnowledgeVectorHit, KnowledgeVectorRecord } from "./knowledge/documents";

export type RebuildKnowledgeVectorOptions = {
  batchSize?: number;
  onProgress?: (progress: { embedded: number; total: number }) => void;
};

export async function rebuildKnowledgeVectorStore(documents: KnowledgeDocument[], options: RebuildKnowledgeVectorOptions = {}) {
  assertPostgresRuntime();
  const batchSize = Math.max(1, Math.min(512, options.batchSize ?? 128));
  const next: KnowledgeVectorRecord[] = [];
  for (let index = 0; index < documents.length; index += batchSize) {
    const batch = documents.slice(index, index + batchSize);
    const vectors = await embedPassageTexts(batch.map((document) => document.text));
    for (let offset = 0; offset < batch.length; offset += 1) {
      next.push({ ...batch[offset], vector: vectors[offset] ?? [] });
    }
    options.onProgress?.({ embedded: Math.min(index + batch.length, documents.length), total: documents.length });
  }
  await pgStore.rebuildKnowledgeVectorStore(next);
  return { count: next.length, storage: "postgres" as const };
}

export async function searchKnowledgeVectors(domainGroup: KnowledgeSourceId | undefined, queryVector: number[], limit = 24, queryText = ""): Promise<KnowledgeVectorHit[]> {
  assertPostgresRuntime();
  return pgStore.searchKnowledgeVectors(domainGroup, queryVector, limit, queryText);
}

export async function getKnowledgeVectorCount() {
  assertPostgresRuntime();
  return pgStore.getKnowledgeVectorCount();
}

export async function getKnowledgeVectorStatus() {
  assertPostgresRuntime();
  return pgStore.getKnowledgeVectorStatus();
}

export async function ensureKnowledgeVectorStore() {
  assertPostgresRuntime();
  await pgStore.ensurePostgresStore();
}

function assertPostgresRuntime() {
  if (!pgStore.isPostgresEnabled()) {
    throw new Error("PostgreSQL knowledge vector persistence is required. Set DATABASE_URL or run through Docker infra.");
  }
}
