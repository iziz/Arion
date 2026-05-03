import type { TimelineSegment } from "../../shared/types";
import type { VisualVectorRecord } from "../localVisualEmbeddingRuntime";
import { getPool, isVectorExtensionAvailable } from "./connection";
import { ensurePostgresStore } from "./schema";
import {
  cosineSimilarity,
  isPgVectorCompatible,
  isVisualPgVectorCompatible,
  vectorLiteral,
  vectorRecordText,
  vectorRowToResult,
  visualVectorRowToResult
} from "./vectorUtils";

export async function upsertAssetVectors(indexId: string, assetId: string, segments: TimelineSegment[]) {
  await ensurePostgresStore();
  const db = getPool();
  await db.query("delete from app_vectors where asset_id = $1", [assetId]);
  for (const segment of segments) {
    const id = `${assetId}:${segment.id}`;
    if (isVectorExtensionAvailable()) {
      const pgVector = isPgVectorCompatible(segment.embedding) ? vectorLiteral(segment.embedding) : null;
      await db.query(
        `insert into app_vectors(id, index_id, asset_id, segment_id, start_seconds, end_seconds, thumbnail_path, modalities, tags, text, embedding_json, embedding)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)`,
        [
          id,
          indexId,
          assetId,
          segment.id,
          segment.start,
          segment.end,
          segment.thumbnailPath,
          segment.modalities,
          segment.tags,
          vectorRecordText(segment),
          JSON.stringify(segment.embedding),
          pgVector
        ]
      );
    } else {
      await db.query(
        `insert into app_vectors(id, index_id, asset_id, segment_id, start_seconds, end_seconds, thumbnail_path, modalities, tags, text, embedding_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          indexId,
          assetId,
          segment.id,
          segment.start,
          segment.end,
          segment.thumbnailPath,
          segment.modalities,
          segment.tags,
          vectorRecordText(segment),
          JSON.stringify(segment.embedding)
        ]
      );
    }
  }
}

export async function rebuildVectorStore(assets: Array<{ indexId: string; id: string; timeline: TimelineSegment[] }>) {
  await ensurePostgresStore();
  await getPool().query("truncate app_vectors");
  for (const asset of assets) {
    await upsertAssetVectors(asset.indexId, asset.id, asset.timeline);
  }
}

export async function upsertAssetVisualVectors(_indexId: string, assetId: string, records: VisualVectorRecord[]) {
  await ensurePostgresStore();
  const db = getPool();
  await db.query("delete from app_visual_vectors where asset_id = $1", [assetId]);
  for (const record of records) {
    const pgVector = isVisualPgVectorCompatible(record.vector) ? vectorLiteral(record.vector) : null;
    await db.query(
      `insert into app_visual_vectors(
        id, index_id, asset_id, segment_id, keyframe_id, keyframe_path, start_seconds, end_seconds, model, embedding_json, embedding
      )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)`,
      [
        record.id,
        record.indexId,
        record.assetId,
        record.segmentId,
        record.keyframeId,
        record.keyframePath,
        record.start,
        record.end,
        record.model,
        JSON.stringify(record.vector),
        pgVector
      ]
    );
  }
}

export async function rebuildVisualVectorStore(records: VisualVectorRecord[]) {
  await ensurePostgresStore();
  await getPool().query("truncate app_visual_vectors");
  const byAsset = new Map<string, VisualVectorRecord[]>();
  for (const record of records) {
    byAsset.set(record.assetId, [...(byAsset.get(record.assetId) ?? []), record]);
  }
  for (const [assetId, assetRecords] of byAsset) {
    await upsertAssetVisualVectors(assetRecords[0].indexId, assetId, assetRecords);
  }
}

export async function searchVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  await ensurePostgresStore();
  if (isVectorExtensionAvailable() && isPgVectorCompatible(queryVector)) {
    const result = await getPool().query(
      `select *, 1 - (embedding <=> $1::vector) as score
       from app_vectors
       where embedding is not null
         and ($2::text is null or index_id = $2)
       order by embedding <=> $1::vector
       limit $3`,
      [vectorLiteral(queryVector), indexId ?? null, limit]
    );
    return result.rows.map(vectorRowToResult);
  }

  const result = await getPool().query("select * from app_vectors where ($1::text is null or index_id = $1)", [indexId ?? null]);
  return result.rows
    .map((row) => ({ ...vectorRowToResult(row), score: cosineSimilarity(queryVector, row.embedding_json ?? []) }))
    .filter((row) => row.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function searchVisualVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  await ensurePostgresStore();
  if (isVectorExtensionAvailable() && isVisualPgVectorCompatible(queryVector)) {
    const result = await getPool().query(
      `select *, 1 - (embedding <=> $1::vector) as score
       from app_visual_vectors
       where embedding is not null
         and ($2::text is null or index_id = $2)
       order by embedding <=> $1::vector
       limit $3`,
      [vectorLiteral(queryVector), indexId ?? null, limit]
    );
    return result.rows.map(visualVectorRowToResult);
  }

  const result = await getPool().query("select * from app_visual_vectors where ($1::text is null or index_id = $1)", [indexId ?? null]);
  return result.rows
    .map((row) => ({ ...visualVectorRowToResult(row), score: cosineSimilarity(queryVector, row.embedding_json ?? []) }))
    .filter((row) => row.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function getVectorCount() {
  await ensurePostgresStore();
  const result = await getPool().query(
    "select ((select count(*)::int from app_vectors) + (select count(*)::int from app_visual_vectors)) as count"
  );
  return result.rows[0].count as number;
}

export async function getVisualVectorCount() {
  await ensurePostgresStore();
  const result = await getPool().query("select count(*)::int as count from app_visual_vectors");
  return result.rows[0].count as number;
}
