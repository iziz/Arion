import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TimelineSegment } from "../shared/types";
import * as pgStore from "./postgresStore";

type VectorRecord = {
  id: string;
  indexId: string;
  assetId: string;
  segmentId: string;
  start: number;
  end: number;
  thumbnailPath: string | null;
  modalities: string[];
  vector: number[];
  text: string;
  tags: string[];
};

const vectorPath = path.resolve(".data", "vector-store.json");
let vectors: VectorRecord[] = [];
let loaded = false;
let writeChain = Promise.resolve();

export async function upsertAssetVectors(indexId: string, assetId: string, segments: TimelineSegment[]) {
  if (pgStore.isPostgresEnabled()) return pgStore.upsertAssetVectors(indexId, assetId, segments);
  await ensureVectorStore();
  vectors = vectors.filter((record) => record.assetId !== assetId);
  vectors.push(
    ...segments.map((segment) => ({
      id: `${assetId}:${segment.id}`,
      indexId,
      assetId,
      segmentId: segment.id,
      start: segment.start,
      end: segment.end,
      thumbnailPath: segment.thumbnailPath,
      modalities: segment.modalities,
      vector: segment.embedding,
      text: `${segment.label} ${segment.transcript}`,
      tags: segment.tags
    }))
  );
  await persist();
}

export async function searchVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  if (pgStore.isPostgresEnabled()) return pgStore.searchVectors(indexId, queryVector, limit);
  await ensureVectorStore();
  return vectors
    .filter((record) => !indexId || record.indexId === indexId)
    .map((record) => ({ ...record, score: cosineSimilarity(queryVector, record.vector) }))
    .filter((record) => record.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function rebuildVectorStore(assets: Array<{ indexId: string; id: string; timeline: TimelineSegment[] }>) {
  if (pgStore.isPostgresEnabled()) return pgStore.rebuildVectorStore(assets);
  await ensureVectorStore();
  vectors = [];
  for (const asset of assets) {
    vectors.push(
      ...asset.timeline.map((segment) => ({
        id: `${asset.id}:${segment.id}`,
        indexId: asset.indexId,
        assetId: asset.id,
        segmentId: segment.id,
        start: segment.start,
        end: segment.end,
        thumbnailPath: segment.thumbnailPath,
        modalities: segment.modalities,
        vector: normalizeVector(segment.embedding),
        text: `${segment.label} ${segment.transcript}`,
        tags: segment.tags
      }))
    );
  }
  await persist();
}

export async function getVectorCount() {
  if (pgStore.isPostgresEnabled()) return pgStore.getVectorCount();
  await ensureVectorStore();
  return vectors.length;
}

async function ensureVectorStore() {
  if (loaded) return;
  await mkdir(path.dirname(vectorPath), { recursive: true });
  try {
    vectors = JSON.parse(await readFile(vectorPath, "utf8")) as VectorRecord[];
  } catch {
    vectors = [];
  }
  loaded = true;
}

async function persist() {
  const body = JSON.stringify(vectors, null, 2);
  writeChain = writeChain.then(() => writeFile(vectorPath, body));
  await writeChain;
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  const length = a.length;
  let dot = 0;
  for (let index = 0; index < length; index += 1) dot += a[index] * b[index];
  return Math.max(0, Number(dot.toFixed(3)));
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(4)));
}
