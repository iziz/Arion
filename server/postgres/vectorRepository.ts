import type { PoolClient } from "pg";
import type { TimelineSegment } from "../../shared/types";
import type { VisualVectorRecord } from "../localVisualEmbeddingRuntime";
import { getPool } from "./connection";
import { ensurePostgresStore } from "./schema";
import {
  isPgVectorCompatible,
  isVisualPgVectorCompatible,
  type VectorRow,
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

export async function searchVectors(indexId: string | undefined, queryVector: number[], limit = 25, queryText = "") {
  await ensurePostgresStore();
  if (!isPgVectorCompatible(queryVector)) {
    throw new Error(`Query embedding is incompatible with configured pgvector dimensions: ${queryVector.length}.`);
  }
  const boundedLimit = positiveLimit(limit);
  const lexicalQuery = prepareLexicalQuery(queryText);
  const candidateLimit = lexicalQuery ? Math.max(boundedLimit * 6, 80) : boundedLimit;
  const pgvectorRows = await searchVectorRows(indexId, queryVector, candidateLimit);
  if (!lexicalQuery) return pgvectorRows.map(vectorRowToResult).slice(0, boundedLimit);
  const lexicalRows = await searchLexicalVectorRows(indexId, lexicalQuery, candidateLimit);
  return mergeHybridVectorHits(pgvectorRows, lexicalRows, boundedLimit);
}

async function searchVectorRows(indexId: string | undefined, queryVector: number[], limit: number) {
  const result = await getPool().query<VectorRow>(
    `select v.*, 1 - (v.embedding <=> $1::vector) as score
     from app_vectors v
     join app_assets a on a.id = v.asset_id
     where v.embedding is not null
       and ($2::text is null or v.index_id = $2)
       and ${assetComplianceSearchableSql}
     order by v.embedding <=> $1::vector
     limit $3`,
    [vectorLiteral(queryVector), indexId ?? null, limit]
  );
  return result.rows;
}

async function searchLexicalVectorRows(indexId: string | undefined, queryText: string, limit: number) {
  const result = await getPool().query<VectorRow>(
    `select v.*, ts_rank_cd(v.search_tsv, websearch_to_tsquery('simple', $1)) as lexical_score
     from app_vectors v
     join app_assets a on a.id = v.asset_id
     where v.embedding is not null
       and ($2::text is null or v.index_id = $2)
       and ${assetComplianceSearchableSql}
       and v.search_tsv @@ websearch_to_tsquery('simple', $1)
     order by lexical_score desc
     limit $3`,
    [queryText, indexId ?? null, limit]
  );
  return result.rows;
}

function mergeHybridVectorHits(vectorRows: VectorRow[], lexicalRows: VectorRow[], limit: number) {
  const byId = new Map<string, {
    hit: ReturnType<typeof vectorRowToResult>;
    vectorRank: number | null;
    lexicalRank: number | null;
    lexicalScore: number;
  }>();

  vectorRows.forEach((row, index) => {
    const hit = vectorRowToResult(row);
    byId.set(hit.id, {
      hit,
      vectorRank: index + 1,
      lexicalRank: null,
      lexicalScore: 0
    });
  });
  lexicalRows.forEach((row, index) => {
    const hit = byId.get(row.id)?.hit ?? vectorRowToResult({ ...row, score: 0 });
    const entry = byId.get(row.id) ?? {
      hit,
      vectorRank: null,
      lexicalRank: null,
      lexicalScore: 0
    };
    entry.lexicalRank = index + 1;
    entry.lexicalScore = Math.max(entry.lexicalScore, Number(row.lexical_score ?? 0));
    byId.set(row.id, entry);
  });

  return Array.from(byId.values())
    .map(({ hit, vectorRank, lexicalRank, lexicalScore }) => {
      const vectorScore = Number(hit.score ?? 0);
      const lexicalBoost = Math.min(1, Math.max(0, lexicalScore));
      const reciprocalRank =
        (vectorRank ? 1 / (60 + vectorRank) : 0) +
        (lexicalRank ? 1 / (60 + lexicalRank) : 0);
      return {
        ...hit,
        score: Number((vectorScore * 0.86 + lexicalBoost * 0.14 + reciprocalRank).toFixed(6))
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function searchVisualVectors(indexId: string | undefined, queryVector: number[], limit = 25) {
  await ensurePostgresStore();
  if (!isVisualPgVectorCompatible(queryVector)) {
    throw new Error(`Visual query embedding is incompatible with configured pgvector dimensions: ${queryVector.length}.`);
  }
  const pgvectorRows = await getPool().query(
    `select v.*, 1 - (v.embedding <=> $1::vector) as score
     from app_visual_vectors v
     join app_assets a on a.id = v.asset_id
     where v.embedding is not null
       and ($2::text is null or v.index_id = $2)
       and ${assetComplianceSearchableSql}
     order by v.embedding <=> $1::vector
     limit $3`,
    [vectorLiteral(queryVector), indexId ?? null, limit]
  );
  return pgvectorRows.rows.map(visualVectorRowToResult);
}

const assetComplianceSearchableSql = "((a.data #>> '{compliance,status}') is null or (a.data #>> '{compliance,status}') in ('not_applicable', 'metadata_complete'))";

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

function positiveLimit(value: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 25;
  return Math.min(200, Math.floor(parsed));
}

function prepareLexicalQuery(value: string) {
  const text = value.replace(/\s+/g, " ").trim().slice(0, 400);
  return /[A-Za-z0-9가-힣\u3040-\u30ff\u3400-\u9fff]/.test(text) ? text : "";
}
