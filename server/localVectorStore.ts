import type { TimelineSegment } from "../shared/types";
import * as pgStore from "./postgresStore";

export async function upsertAssetVectors(indexId: string, assetId: string, segments: TimelineSegment[]) {
  assertPostgresRuntime();
  return pgStore.upsertAssetVectors(indexId, assetId, segments);
}

export async function searchVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  assertPostgresRuntime();
  return pgStore.searchVectors(indexId, queryVector, limit);
}

export async function rebuildVectorStore(assets: Array<{ indexId: string; id: string; timeline: TimelineSegment[] }>) {
  assertPostgresRuntime();
  return pgStore.rebuildVectorStore(assets);
}

export async function getVectorCount() {
  assertPostgresRuntime();
  return pgStore.getVectorCount();
}

function assertPostgresRuntime() {
  if (!pgStore.isPostgresEnabled()) {
    throw new Error("PostgreSQL vector persistence is required. Set DATABASE_URL or run through Docker infra.");
  }
}
