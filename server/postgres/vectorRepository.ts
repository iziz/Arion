import type { PoolClient } from "pg";
import type { TimelineSegment } from "../../shared/types";
import type { VisualVectorRecord } from "../localVisualEmbeddingRuntime";
import { getPool } from "./connection";
import { ensurePostgresStore } from "./schema";
import {
  isPgVectorCompatible,
  isVisualPgVectorCompatible,
  vectorLiteral,
  vectorRecordText,
  vectorRowToResult,
  visualVectorRowToResult
} from "./vectorUtils";

export async function upsertAssetVectors(indexId: string, assetId: string, segments: TimelineSegment[]) {
  await ensurePostgresStore();
  validateTextSegments(assetId, segments);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("delete from app_vectors where asset_id = $1", [assetId]);
    for (const segment of segments) {
      await insertTextVector(client, indexId, assetId, segment);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function rebuildVectorStore(assets: Array<{ indexId: string; id: string; timeline: TimelineSegment[] }>) {
  await ensurePostgresStore();
  for (const asset of assets) validateTextSegments(asset.id, asset.timeline);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("truncate app_vectors");
    for (const asset of assets) {
      for (const segment of asset.timeline) {
        await insertTextVector(client, asset.indexId, asset.id, segment);
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertAssetVisualVectors(_indexId: string, assetId: string, records: VisualVectorRecord[]) {
  await ensurePostgresStore();
  validateVisualRecords(records);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("delete from app_visual_vectors where asset_id = $1", [assetId]);
    for (const record of records) {
      await insertVisualVector(client, record);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function rebuildVisualVectorStore(records: VisualVectorRecord[]) {
  await ensurePostgresStore();
  validateVisualRecords(records);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("truncate app_visual_vectors");
    for (const record of records) {
      await insertVisualVector(client, record);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function searchVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  await ensurePostgresStore();
  if (!isPgVectorCompatible(queryVector)) {
    throw new Error(`Query embedding is incompatible with configured pgvector dimensions: ${queryVector.length}.`);
  }
  const pgvectorRows = await getPool().query(
    `select *, 1 - (embedding <=> $1::vector) as score
     from app_vectors
     where embedding is not null
       and ($2::text is null or index_id = $2)
     order by embedding <=> $1::vector
     limit $3`,
    [vectorLiteral(queryVector), indexId ?? null, limit]
  );
  return pgvectorRows.rows.map(vectorRowToResult);
}

export async function searchVisualVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  await ensurePostgresStore();
  if (!isVisualPgVectorCompatible(queryVector)) {
    throw new Error(`Visual query embedding is incompatible with configured pgvector dimensions: ${queryVector.length}.`);
  }
  const pgvectorRows = await getPool().query(
    `select *, 1 - (embedding <=> $1::vector) as score
     from app_visual_vectors
     where embedding is not null
       and ($2::text is null or index_id = $2)
     order by embedding <=> $1::vector
     limit $3`,
    [vectorLiteral(queryVector), indexId ?? null, limit]
  );
  return pgvectorRows.rows.map(visualVectorRowToResult);
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

function validateTextSegments(assetId: string, segments: TimelineSegment[]) {
  for (const segment of segments) {
    if (!isPgVectorCompatible(segment.embedding)) {
      const id = `${assetId}:${segment.id}`;
      throw new Error(`Text embedding for ${id} is incompatible with pgvector dimension ${segment.embedding.length}. Rebuild embeddings with the configured model.`);
    }
  }
}

async function insertTextVector(
  client: PoolClient,
  indexId: string,
  assetId: string,
  segment: TimelineSegment
) {
  await client.query(
    `insert into app_vectors(id, index_id, asset_id, segment_id, start_seconds, end_seconds, thumbnail_path, modalities, tags, text, embedding_json, embedding)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)`,
    [
      `${assetId}:${segment.id}`,
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
      vectorLiteral(segment.embedding)
    ]
  );
}

function validateVisualRecords(records: VisualVectorRecord[]) {
  for (const record of records) {
    if (!isVisualPgVectorCompatible(record.vector)) {
      throw new Error(`Visual embedding for ${record.id} is incompatible with pgvector dimension ${record.vector.length}. Rebuild visual embeddings with the configured model.`);
    }
  }
}

async function insertVisualVector(client: PoolClient, record: VisualVectorRecord) {
  await client.query(
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
      vectorLiteral(record.vector)
    ]
  );
}
