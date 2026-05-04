import type { VisualVectorRecord } from "./localVisualEmbeddingRuntime";
import * as pgStore from "./postgresStore";

export async function upsertAssetVisualVectors(indexId: string, assetId: string, records: VisualVectorRecord[]) {
  assertPostgresRuntime();
  return pgStore.upsertAssetVisualVectors(indexId, assetId, records);
}

export async function searchVisualVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  assertPostgresRuntime();
  return pgStore.searchVisualVectors(indexId, queryVector, limit);
}

export async function rebuildVisualVectorStore(records: VisualVectorRecord[]) {
  assertPostgresRuntime();
  return pgStore.rebuildVisualVectorStore(records);
}

export async function getVisualVectorCount() {
  assertPostgresRuntime();
  return pgStore.getVisualVectorCount();
}

function assertPostgresRuntime() {
  if (!pgStore.isPostgresEnabled()) {
    throw new Error("PostgreSQL visual vector persistence is required. Set DATABASE_URL or run through Docker infra.");
  }
}
