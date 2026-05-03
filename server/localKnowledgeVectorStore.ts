import path from "node:path";
import type { SportsDomainGroup } from "../shared/types";
import { cosineSimilarity } from "./intelligenceCore/textUtils";
import { readJsonFile, writeJsonFile } from "./jsonFileStore";
import { embedPassageTexts } from "./localEmbeddingRuntime";
import * as pgStore from "./postgresStore";
import type { SportsKnowledgeDocument, SportsKnowledgeVectorHit, SportsKnowledgeVectorRecord } from "./sportsKnowledgeDocuments";

const knowledgeVectorPath = path.resolve(".data", "knowledge-vector-store.json");
let records: SportsKnowledgeVectorRecord[] = [];
let loaded = false;
let writeChain = Promise.resolve();

export type RebuildKnowledgeVectorOptions = {
  batchSize?: number;
  onProgress?: (progress: { embedded: number; total: number }) => void;
};

export async function rebuildKnowledgeVectorStore(documents: SportsKnowledgeDocument[], options: RebuildKnowledgeVectorOptions = {}) {
  const batchSize = Math.max(1, Math.min(512, options.batchSize ?? 128));
  const next: SportsKnowledgeVectorRecord[] = [];
  for (let index = 0; index < documents.length; index += batchSize) {
    const batch = documents.slice(index, index + batchSize);
    const vectors = await embedPassageTexts(batch.map((document) => document.text));
    for (let offset = 0; offset < batch.length; offset += 1) {
      next.push({ ...batch[offset], vector: vectors[offset] ?? [] });
    }
    options.onProgress?.({ embedded: Math.min(index + batch.length, documents.length), total: documents.length });
  }
  if (pgStore.isPostgresEnabled()) {
    await pgStore.rebuildKnowledgeVectorStore(next);
    records = next;
    loaded = true;
    return { count: next.length, storage: "postgres" as const };
  }
  records = next;
  loaded = true;
  await persist();
  return { count: records.length, storage: "local" as const };
}

export async function searchKnowledgeVectors(domainGroup: SportsDomainGroup | undefined, queryVector: number[], limit = 24): Promise<SportsKnowledgeVectorHit[]> {
  if (pgStore.isPostgresEnabled()) return pgStore.searchKnowledgeVectors(domainGroup, queryVector, limit);
  await ensureKnowledgeVectorStore();
  return records
    .filter((record) => !domainGroup || record.domainGroup === domainGroup)
    .map((record) => ({ ...record, score: cosineSimilarity(queryVector, record.vector) }))
    .filter((record) => record.score > 0.12)
    .sort((a, b) => b.score - a.score || a.entityName.localeCompare(b.entityName))
    .slice(0, limit);
}

export async function getKnowledgeVectorCount() {
  if (pgStore.isPostgresEnabled()) return pgStore.getKnowledgeVectorCount();
  await ensureKnowledgeVectorStore();
  return records.length;
}

export async function ensureKnowledgeVectorStore() {
  if (loaded) return;
  records = await readJsonFile<SportsKnowledgeVectorRecord[]>(knowledgeVectorPath, () => [], "knowledge-vector-store");
  loaded = true;
}

async function persist() {
  writeChain = writeChain.then(() => writeJsonFile(knowledgeVectorPath, records));
  await writeChain;
}
