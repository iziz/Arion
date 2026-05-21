import type { AppearanceVectorRecord } from "./appearanceSimilarity";
import * as pgStore from "./postgresStore";

export async function upsertAssetAppearanceVectors(indexId: string, assetId: string, records: AppearanceVectorRecord[]) {
  assertPostgresRuntime();
  return pgStore.upsertAssetAppearanceVectors(indexId, assetId, records);
}

export async function searchAppearanceVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  assertPostgresRuntime();
  return pgStore.searchAppearanceVectors(indexId, queryVector, limit);
}

export async function rebuildAppearanceVectorStore(records: AppearanceVectorRecord[]) {
  assertPostgresRuntime();
  return pgStore.rebuildAppearanceVectorStore(records);
}

export async function getAppearanceVectorCount() {
  assertPostgresRuntime();
  return pgStore.getAppearanceVectorCount();
}

function assertPostgresRuntime() {
  if (!pgStore.isPostgresEnabled()) {
    throw new Error("PostgreSQL appearance vector persistence is required. Set DATABASE_URL or run through Docker infra.");
  }
}
