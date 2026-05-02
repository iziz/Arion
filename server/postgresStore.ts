import { Pool } from "pg";
import type {
  AssetRecord,
  BillingRecord,
  EventRecord,
  IndexRecord,
  JobRecord,
  MetricsSummary,
  TimelineSegment,
  UserRecord,
  WebhookRecord
} from "../shared/types";
import type { VisualVectorRecord } from "./localVisualEmbeddingRuntime";

type VectorRow = {
  id: string;
  index_id: string;
  asset_id: string;
  segment_id: string;
  start_seconds: number;
  end_seconds: number;
  thumbnail_path: string | null;
  modalities: string[];
  tags: string[];
  text: string;
  embedding_json: number[];
  score?: number;
};

type VisualVectorRow = {
  id: string;
  index_id: string;
  asset_id: string;
  segment_id: string;
  keyframe_id: string;
  keyframe_path: string;
  start_seconds: number;
  end_seconds: number;
  model: string;
  embedding_json: number[];
  score?: number;
};

let pool: Pool | null = null;
let initialized = false;
let vectorExtensionAvailable = false;

export function isPostgresEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export async function ensurePostgresStore() {
  if (!isPostgresEnabled()) return false;
  if (initialized) return true;
  const db = getPool();
  await db.query("create extension if not exists vector").catch(() => undefined);
  const vectorType = await db.query("select to_regtype('vector') as type");
  vectorExtensionAvailable = Boolean(vectorType.rows[0]?.type);

  await db.query(`
    create table if not exists app_indexes (
      id text primary key,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create table if not exists app_assets (
      id text primary key,
      index_id text not null,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create table if not exists app_jobs (
      id text primary key,
      asset_id text,
      index_id text,
      status text not null,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create table if not exists app_webhooks (
      id text primary key,
      active boolean not null,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create table if not exists app_events (
      id text primary key,
      type text not null,
      asset_id text,
      index_id text,
      job_id text,
      data jsonb not null,
      created_at timestamptz not null
    );
    create table if not exists app_users (
      id text primary key,
      api_key text unique not null,
      data jsonb not null,
      created_at timestamptz not null
    );
    create table if not exists app_billing (
      id text primary key,
      user_id text not null,
      asset_id text,
      job_id text,
      units integer not null,
      data jsonb not null,
      created_at timestamptz not null
    );
    create table if not exists app_vectors (
      id text primary key,
      index_id text not null,
      asset_id text not null,
      segment_id text not null,
      start_seconds double precision not null,
      end_seconds double precision not null,
      thumbnail_path text,
      modalities text[] not null default '{}',
      tags text[] not null default '{}',
      text text not null,
      embedding_json jsonb not null
    );
    create table if not exists app_visual_vectors (
      id text primary key,
      index_id text not null,
      asset_id text not null,
      segment_id text not null,
      keyframe_id text not null,
      keyframe_path text not null,
      start_seconds double precision not null,
      end_seconds double precision not null,
      model text not null,
      embedding_json jsonb not null
    );
    create table if not exists app_schema_migrations (
      version text primary key,
      description text not null,
      applied_at timestamptz not null default now()
    );
    create index if not exists app_assets_index_id_idx on app_assets(index_id);
    create index if not exists app_jobs_status_idx on app_jobs(status);
    create index if not exists app_vectors_index_id_idx on app_vectors(index_id);
    create index if not exists app_vectors_asset_id_idx on app_vectors(asset_id);
    create index if not exists app_visual_vectors_index_id_idx on app_visual_vectors(index_id);
    create index if not exists app_visual_vectors_asset_id_idx on app_visual_vectors(asset_id);
  `);

  if (vectorExtensionAvailable) {
    const dimension = getExpectedEmbeddingDimensions();
    const currentVectorType = await getVectorColumnType(db, "app_vectors", "embedding");
    if (currentVectorType && currentVectorType !== `vector(${dimension})`) {
      await db.query("drop index if exists app_vectors_embedding_idx");
      await db.query("alter table app_vectors drop column embedding");
    }
    await db.query(`alter table app_vectors add column if not exists embedding vector(${dimension})`);
    await db.query("create index if not exists app_vectors_embedding_idx on app_vectors using hnsw (embedding vector_cosine_ops)").catch(() => undefined);
    const visualDimension = getExpectedVisualEmbeddingDimensions();
    const currentVisualType = await getVectorColumnType(db, "app_visual_vectors", "embedding");
    if (currentVisualType && currentVisualType !== `vector(${visualDimension})`) {
      await db.query("drop index if exists app_visual_vectors_embedding_idx");
      await db.query("alter table app_visual_vectors drop column embedding");
    }
    await db.query(`alter table app_visual_vectors add column if not exists embedding vector(${visualDimension})`);
    await db
      .query("create index if not exists app_visual_vectors_embedding_idx on app_visual_vectors using hnsw (embedding vector_cosine_ops)")
      .catch(() => undefined);
  }

  await seedDefaults();
  await recordMigration("001_base_tables", "Create local service tables");
  await recordMigration("002_pgvector_embedding", `Configure pgvector embedding column with ${getExpectedEmbeddingDimensions()} dimensions`);
  await recordMigration(
    "003_visual_vectors",
    `Configure OpenCLIP visual embedding table with ${getExpectedVisualEmbeddingDimensions()} dimensions`
  );
  initialized = true;
  return true;
}

export async function listIndexes() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_indexes order by created_at asc");
  return result.rows.map((row) => row.data as IndexRecord);
}

export async function getIndex(id: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_indexes where id = $1", [id]);
  return (result.rows[0]?.data as IndexRecord | undefined) ?? null;
}

export async function saveIndex(index: IndexRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_indexes(id, data, created_at, updated_at)
     values ($1, $2, $3, $4)
     on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at`,
    [index.id, index, index.createdAt, index.updatedAt]
  );
  return index;
}

export async function listAssets(indexId?: string) {
  await ensurePostgresStore();
  const result = indexId
    ? await getPool().query("select data from app_assets where index_id = $1 order by created_at desc", [indexId])
    : await getPool().query("select data from app_assets order by created_at desc");
  return result.rows.map((row) => row.data as AssetRecord);
}

export async function getAsset(id: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_assets where id = $1", [id]);
  return (result.rows[0]?.data as AssetRecord | undefined) ?? null;
}

export async function saveAsset(asset: AssetRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_assets(id, index_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set index_id = excluded.index_id, data = excluded.data, updated_at = excluded.updated_at`,
    [asset.id, asset.indexId, asset, asset.createdAt, asset.updatedAt]
  );
  const index = await getIndex(asset.indexId);
  if (index && !index.assetIds.includes(asset.id)) {
    index.assetIds.push(asset.id);
    index.status = "ready";
    index.updatedAt = new Date().toISOString();
    await saveIndex(index);
  }
  return asset;
}

export async function listJobs() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_jobs order by created_at desc");
  return result.rows.map((row) => row.data as JobRecord);
}

export async function getJob(id: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_jobs where id = $1", [id]);
  return (result.rows[0]?.data as JobRecord | undefined) ?? null;
}

export async function saveJob(job: JobRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_jobs(id, asset_id, index_id, status, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set asset_id = excluded.asset_id, index_id = excluded.index_id, status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
    [job.id, job.assetId, job.indexId, job.status, job, job.createdAt, job.updatedAt]
  );
  return job;
}

export async function listWebhooks() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_webhooks order by created_at desc");
  return result.rows.map((row) => row.data as WebhookRecord);
}

export async function getWebhook(id: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_webhooks where id = $1", [id]);
  return (result.rows[0]?.data as WebhookRecord | undefined) ?? null;
}

export async function saveWebhook(webhook: WebhookRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_webhooks(id, active, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set active = excluded.active, data = excluded.data, updated_at = excluded.updated_at`,
    [webhook.id, webhook.active, webhook, webhook.createdAt, webhook.updatedAt]
  );
  return webhook;
}

export async function listEvents(limit = 80) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_events order by created_at desc limit $1", [limit]);
  return result.rows.map((row) => row.data as EventRecord);
}

export async function saveEvent(event: EventRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_events(id, type, asset_id, index_id, job_id, data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do nothing`,
    [event.id, event.type, event.assetId, event.indexId, event.jobId, event, event.createdAt]
  );
  return event;
}

export async function listUsers() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_users order by created_at asc");
  return result.rows.map((row) => row.data as UserRecord);
}

export async function getUserByApiKey(apiKey: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_users where api_key = $1", [apiKey]);
  return (result.rows[0]?.data as UserRecord | undefined) ?? null;
}

export async function listBilling() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_billing order by created_at desc");
  return result.rows.map((row) => row.data as BillingRecord);
}

export async function saveBilling(record: BillingRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_billing(id, user_id, asset_id, job_id, units, data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do nothing`,
    [record.id, record.userId, record.assetId, record.jobId, record.units, record, record.createdAt]
  );
  return record;
}

export async function getMetrics(): Promise<MetricsSummary> {
  await ensurePostgresStore();
  const result = await getPool().query(`
    select
      (select count(*)::int from app_indexes) as indexes,
      (select count(*)::int from app_assets) as assets,
      (select count(*)::int from app_assets where data->>'status' = 'indexed') as indexed_assets,
      (select count(*)::int from app_jobs where status in ('queued', 'running')) as running_jobs,
      (select count(*)::int from app_jobs where status = 'failed') as failed_jobs,
      coalesce((select sum((data->>'duration')::double precision) from app_assets where data->>'duration' is not null), 0) as total_duration,
      coalesce((select sum(jsonb_array_length(coalesce(data->'timeline', '[]'::jsonb))) from app_assets), 0)::int as segments,
      ((select count(*)::int from app_vectors) + (select count(*)::int from app_visual_vectors)) as vectors,
      (select count(*)::int from app_webhooks where active = true) as webhooks,
      coalesce((select sum(units) from app_billing), 0)::int as billing_units
  `);
  const row = result.rows[0];
  return {
    indexes: row.indexes,
    assets: row.assets,
    indexedAssets: row.indexed_assets,
    runningJobs: row.running_jobs,
    failedJobs: row.failed_jobs,
    totalDuration: Number(row.total_duration),
    segments: row.segments,
    vectors: row.vectors,
    webhooks: row.webhooks,
    billingUnits: row.billing_units
  };
}

export async function upsertAssetVectors(indexId: string, assetId: string, segments: TimelineSegment[]) {
  await ensurePostgresStore();
  const db = getPool();
  await db.query("delete from app_vectors where asset_id = $1", [assetId]);
  for (const segment of segments) {
    const id = `${assetId}:${segment.id}`;
    if (vectorExtensionAvailable) {
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
  if (vectorExtensionAvailable && isPgVectorCompatible(queryVector)) {
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
  if (vectorExtensionAvailable && isVisualPgVectorCompatible(queryVector)) {
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

export async function closePostgresStore() {
  await pool?.end();
  pool = null;
  initialized = false;
}

export async function resetPostgresStore() {
  await ensurePostgresStore();
  await getPool().query(`
    truncate
      app_vectors,
      app_visual_vectors,
      app_billing,
      app_events,
      app_webhooks,
      app_jobs,
      app_assets,
      app_indexes,
      app_users
    restart identity cascade
  `);
  await seedDefaults();
  return getMetrics();
}

export async function getPostgresStatus() {
  await ensurePostgresStore();
  const db = getPool();
  const [version, extension, embeddingType, migrations, metrics] = await Promise.all([
    db.query("select version() as version"),
    db.query("select extversion from pg_extension where extname = 'vector'"),
    getVectorColumnType(db, "app_vectors", "embedding"),
    db.query("select version, description, applied_at from app_schema_migrations order by applied_at asc"),
    getMetrics()
  ]);
  return {
    enabled: true,
    postgres: version.rows[0]?.version as string,
    pgvector: (extension.rows[0]?.extversion as string | undefined) ?? null,
    embeddingColumn: embeddingType,
    expectedEmbeddingDimensions: getExpectedEmbeddingDimensions(),
    visualEmbeddingColumn: await getVectorColumnType(db, "app_visual_vectors", "embedding"),
    expectedVisualEmbeddingDimensions: getExpectedVisualEmbeddingDimensions(),
    migrations: migrations.rows,
    metrics
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

async function getVectorColumnType(db: Pool, table: string, column: string) {
  const result = await db.query(
    `select format_type(a.atttypid, a.atttypmod) as type
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = $1
       and a.attname = $2
       and not a.attisdropped`,
    [table, column]
  );
  return (result.rows[0]?.type as string | undefined) ?? null;
}

async function seedDefaults() {
  const now = new Date().toISOString();
  const defaultIndex = createDefaultIndex(now);
  await getPool().query(
    `insert into app_indexes(id, data, created_at, updated_at)
     values ($1, $2, $3, $4)
     on conflict (id) do nothing`,
    [defaultIndex.id, defaultIndex, defaultIndex.createdAt, defaultIndex.updatedAt]
  );
  const user: UserRecord = {
    id: "local-user",
    name: "Local Developer",
    apiKey: "local-dev-key",
    plan: "local-dev",
    createdAt: now
  };
  await getPool().query(
    `insert into app_users(id, api_key, data, created_at)
     values ($1, $2, $3, $4)
     on conflict (id) do nothing`,
    [user.id, user.apiKey, user, user.createdAt]
  );
}

async function recordMigration(version: string, description: string) {
  await getPool().query(
    `insert into app_schema_migrations(version, description, applied_at)
     values ($1, $2, now())
     on conflict (version) do update set description = excluded.description`,
    [version, description]
  );
}

function createDefaultIndex(now = new Date().toISOString()): IndexRecord {
  return {
    id: "default-index",
    name: "Default video intelligence index",
    description: "Local index for uploaded assets, timeline metadata, search, and analysis.",
    models: {
      search: "local-semantic-retrieval",
      analysis: "local-pattern-analysis",
      embedding: process.env.EMBEDDING_MODEL || "intfloat/multilingual-e5-small"
    },
    modalities: ["visual", "audio", "transcription", "metadata"],
    domainIndexing: {
      enabled: false,
      groups: [],
      stages: []
    },
    assetIds: [],
    status: "empty",
    createdAt: now,
    updatedAt: now
  };
}

function vectorRowToResult(row: VectorRow) {
  return {
    id: row.id,
    indexId: row.index_id,
    assetId: row.asset_id,
    segmentId: row.segment_id,
    start: Number(row.start_seconds),
    end: Number(row.end_seconds),
    thumbnailPath: row.thumbnail_path,
    modalities: row.modalities ?? [],
    vector: row.embedding_json ?? [],
    text: row.text,
    tags: row.tags ?? [],
    score: Number(row.score ?? 0)
  };
}

function visualVectorRowToResult(row: VisualVectorRow) {
  return {
    id: row.id,
    indexId: row.index_id,
    assetId: row.asset_id,
    segmentId: row.segment_id,
    keyframeId: row.keyframe_id,
    keyframePath: row.keyframe_path,
    start: Number(row.start_seconds),
    end: Number(row.end_seconds),
    model: row.model,
    vector: row.embedding_json ?? [],
    score: Number(row.score ?? 0)
  };
}

function vectorLiteral(vector: number[]) {
  return `[${vector.map((value) => Number(value || 0)).join(",")}]`;
}

function vectorRecordText(segment: TimelineSegment) {
  const vision = segment.sceneData?.vision;
  return [
    segment.label,
    segment.transcript,
    segment.domain?.searchText,
    ...(segment.domain?.captions ?? []),
    ...(segment.domain?.labels ?? []),
    vision?.pitch.present ? `pitch ${Math.round(vision.pitch.confidence * 100)}%` : "",
    vision?.objects.players.status === "estimated" || vision?.objects.players.status === "detected" ? `players ${vision.objects.players.status} ${vision.objects.players.countEstimate}` : "",
    vision?.objects.ball.status === "estimated" || vision?.objects.ball.status === "detected" ? `ball ${vision.objects.ball.status}` : "",
    vision?.fieldZone.zone !== "unknown" ? `zone ${vision?.fieldZone.zone}` : "",
    vision?.fieldCalibration ? `field calibration ${vision.fieldCalibration.status} ${vision.fieldCalibration.method}` : "",
    vision?.fieldCalibration && vision.fieldCalibration.attackingDirection !== "unknown" ? `attacking direction ${vision.fieldCalibration.attackingDirection}` : "",
    vision?.tracking?.ballTrackId ? `ball track ${vision.tracking.ballTrackId}` : "",
    vision?.tracking?.nearestPlayerTrackId ? `nearest player ${vision.tracking.nearestPlayerTrackId}` : "",
    vision?.eventClassification && vision.eventClassification.label !== "unknown" ? `event classifier ${vision.eventClassification.label}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function isPgVectorCompatible(vector: number[]) {
  return vector.length === getExpectedEmbeddingDimensions() && vector.some((value) => Number.isFinite(value) && value !== 0);
}

function isVisualPgVectorCompatible(vector: number[]) {
  return vector.length === getExpectedVisualEmbeddingDimensions() && vector.some((value) => Number.isFinite(value) && value !== 0);
}

function getExpectedEmbeddingDimensions() {
  return Number(process.env.EMBEDDING_DIMENSIONS || 384);
}

function getExpectedVisualEmbeddingDimensions() {
  return Number(process.env.VISUAL_EMBEDDING_DIMENSIONS || 512);
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  const length = a.length;
  let dot = 0;
  for (let index = 0; index < length; index += 1) dot += a[index] * b[index];
  return Math.max(0, Number(dot.toFixed(3)));
}
