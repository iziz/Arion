import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VisualVectorRecord } from "./localVisualEmbeddingRuntime";
import * as pgStore from "./postgresStore";

const visualVectorPath = path.resolve(".data", "visual-vector-store.json");
let visualVectors: VisualVectorRecord[] = [];
let loaded = false;
let writeChain = Promise.resolve();

export async function upsertAssetVisualVectors(indexId: string, assetId: string, records: VisualVectorRecord[]) {
  if (pgStore.isPostgresEnabled()) return pgStore.upsertAssetVisualVectors(indexId, assetId, records);
  await ensureVisualVectorStore();
  visualVectors = visualVectors.filter((record) => record.assetId !== assetId);
  visualVectors.push(...records);
  await persist();
}

export async function searchVisualVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  if (pgStore.isPostgresEnabled()) return pgStore.searchVisualVectors(indexId, queryVector, limit);
  await ensureVisualVectorStore();
  return visualVectors
    .filter((record) => !indexId || record.indexId === indexId)
    .map((record) => ({ ...record, score: cosineSimilarity(queryVector, record.vector) }))
    .filter((record) => record.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function rebuildVisualVectorStore(records: VisualVectorRecord[]) {
  if (pgStore.isPostgresEnabled()) return pgStore.rebuildVisualVectorStore(records);
  await ensureVisualVectorStore();
  visualVectors = records;
  await persist();
}

export async function getVisualVectorCount() {
  if (pgStore.isPostgresEnabled()) return pgStore.getVisualVectorCount();
  await ensureVisualVectorStore();
  return visualVectors.length;
}

async function ensureVisualVectorStore() {
  if (loaded) return;
  await mkdir(path.dirname(visualVectorPath), { recursive: true });
  try {
    visualVectors = JSON.parse(await readFile(visualVectorPath, "utf8")) as VisualVectorRecord[];
  } catch {
    visualVectors = [];
  }
  loaded = true;
}

async function persist() {
  const body = JSON.stringify(visualVectors, null, 2);
  writeChain = writeChain.then(() => writeFile(visualVectorPath, body));
  await writeChain;
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return Math.max(0, Number(dot.toFixed(3)));
}
