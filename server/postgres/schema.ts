import type { Pool } from "pg";
import { logJson } from "../observability";
import {
  getPool,
  isPgvectorRequired,
  isPostgresEnabled,
  isPostgresInitialized,
  setPostgresInitialized,
  setVectorExtensionAvailable,
  setVectorExtensionInstallError
} from "./connection";
import { seedDefaults } from "./defaults";
import { getExpectedEmbeddingDimensions, getExpectedVisualEmbeddingDimensions } from "./vectorUtils";

export const minimumPgvectorVersion = process.env.POSTGRES_MIN_PGVECTOR_VERSION || "0.8.2";

export async function ensurePostgresStore() {
  if (!isPostgresEnabled()) {
    throw new Error("DATABASE_URL is required. Runtime persistence requires PostgreSQL.");
  }
  if (isPostgresInitialized()) return true;
  const db = getPool();
  setVectorExtensionInstallError(null);
  await db.query("create extension if not exists vector").catch((error) => {
    const message = error instanceof Error ? error.message : "Failed to create pgvector extension";
    setVectorExtensionInstallError(message);
    logJson("warn", "postgres.pgvector.extension_unavailable", message);
  });
  const vectorType = await db.query("select to_regtype('vector') as type");
  const vectorExtensionAvailable = Boolean(vectorType.rows[0]?.type);
  setVectorExtensionAvailable(vectorExtensionAvailable);
  if (!vectorExtensionAvailable) {
    const requirement = isPgvectorRequired() ? "POSTGRES_REQUIRE_PGVECTOR is enabled" : "pgvector is required";
    throw new Error(`${requirement}, but the pgvector extension is not available.`);
  }
  await ensurePgvectorVersion(db);

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
    create table if not exists app_ask_operations (
      id text primary key,
      index_id text,
      status text not null,
      route text not null,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      completed_at timestamptz
    );
    create table if not exists app_queue_outbox (
      id text primary key,
      kind text not null,
      aggregate_id text not null,
      status text not null,
      attempts integer not null,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      next_attempt_at timestamptz,
      published_at timestamptz
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
    create table if not exists app_appearance_vectors (
      id text primary key,
      index_id text not null,
      asset_id text not null,
      segment_id text not null,
      keyframe_id text not null,
      keyframe_path text not null,
      start_seconds double precision not null,
      end_seconds double precision not null,
      cluster_id text not null,
      cluster_size integer not null default 1,
      cluster_rank integer not null default 1,
      subject_label text not null,
      source text not null,
      metadata_tags text[] not null default '{}',
      model text not null,
      embedding_json jsonb not null
    );
    create table if not exists app_knowledge_vectors (
      id text primary key,
      domain_group text not null,
      provider text not null,
      kind text not null,
      entity_type text not null,
      entity_name text not null,
      competition text,
      season text,
      team text,
      match_time text,
      text text not null,
      source_text text not null,
      embedding_json jsonb not null
    );
    create table if not exists app_tracking_records (
      id text primary key,
      index_id text not null,
      asset_id text not null,
      segment_id text not null,
      track_type text not null,
      track_id text not null,
      linked_track_id text,
      start_seconds double precision not null,
      end_seconds double precision not null,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create table if not exists app_schema_migrations (
      version text primary key,
      description text not null,
      applied_at timestamptz not null default now()
    );
    create index if not exists app_assets_index_id_idx on app_assets(index_id);
    create index if not exists app_jobs_status_idx on app_jobs(status);
    create index if not exists app_jobs_status_updated_at_idx on app_jobs(status, updated_at);
    create index if not exists app_jobs_asset_id_status_idx on app_jobs(asset_id, status);
    create index if not exists app_ask_operations_status_idx on app_ask_operations(status);
    create index if not exists app_ask_operations_updated_at_idx on app_ask_operations(updated_at);
    create index if not exists app_queue_outbox_status_next_attempt_idx on app_queue_outbox(status, next_attempt_at);
    create index if not exists app_queue_outbox_kind_status_idx on app_queue_outbox(kind, status);
    create index if not exists app_vectors_index_id_idx on app_vectors(index_id);
    create index if not exists app_vectors_asset_id_idx on app_vectors(asset_id);
    create index if not exists app_visual_vectors_index_id_idx on app_visual_vectors(index_id);
    create index if not exists app_visual_vectors_asset_id_idx on app_visual_vectors(asset_id);
    create index if not exists app_appearance_vectors_index_id_idx on app_appearance_vectors(index_id);
    create index if not exists app_appearance_vectors_asset_id_idx on app_appearance_vectors(asset_id);
    create index if not exists app_knowledge_vectors_domain_group_idx on app_knowledge_vectors(domain_group);
    create index if not exists app_knowledge_vectors_entity_name_idx on app_knowledge_vectors(entity_name);
    create index if not exists app_tracking_records_asset_id_idx on app_tracking_records(asset_id);
    create index if not exists app_tracking_records_segment_id_idx on app_tracking_records(segment_id);
    create index if not exists app_tracking_records_track_id_idx on app_tracking_records(track_id);
  `);
  await ensureLexicalVectorIndexes(db);
  await ensureAppearanceClusterColumns(db);

  if (vectorExtensionAvailable) {
    const dimension = getExpectedEmbeddingDimensions();
    const currentVectorType = await getVectorColumnType(db, "app_vectors", "embedding");
    if (currentVectorType && currentVectorType !== `vector(${dimension})`) {
      await db.query("drop index if exists app_vectors_embedding_idx");
      await db.query("alter table app_vectors drop column embedding");
    }
    await db.query(`alter table app_vectors add column if not exists embedding vector(${dimension})`);
    await createVectorIndex(db, "app_vectors_embedding_idx", "app_vectors");
    const currentKnowledgeVectorType = await getVectorColumnType(db, "app_knowledge_vectors", "embedding");
    if (currentKnowledgeVectorType && currentKnowledgeVectorType !== `vector(${dimension})`) {
      await db.query("drop index if exists app_knowledge_vectors_embedding_idx");
      await db.query("alter table app_knowledge_vectors drop column embedding");
    }
    await db.query(`alter table app_knowledge_vectors add column if not exists embedding vector(${dimension})`);
    await createVectorIndex(db, "app_knowledge_vectors_embedding_idx", "app_knowledge_vectors");
    const visualDimension = getExpectedVisualEmbeddingDimensions();
    const currentVisualType = await getVectorColumnType(db, "app_visual_vectors", "embedding");
    if (currentVisualType && currentVisualType !== `vector(${visualDimension})`) {
      await db.query("drop index if exists app_visual_vectors_embedding_idx");
      await db.query("alter table app_visual_vectors drop column embedding");
    }
    await db.query(`alter table app_visual_vectors add column if not exists embedding vector(${visualDimension})`);
    await createVectorIndex(db, "app_visual_vectors_embedding_idx", "app_visual_vectors");
    const currentAppearanceType = await getVectorColumnType(db, "app_appearance_vectors", "embedding");
    if (currentAppearanceType && currentAppearanceType !== `vector(${visualDimension})`) {
      await db.query("drop index if exists app_appearance_vectors_embedding_idx");
      await db.query("alter table app_appearance_vectors drop column embedding");
    }
    await db.query(`alter table app_appearance_vectors add column if not exists embedding vector(${visualDimension})`);
    await createVectorIndex(db, "app_appearance_vectors_embedding_idx", "app_appearance_vectors");
  }

  await seedDefaults();
  await recordMigration("001_base_tables", "Create local service tables");
  await recordMigration("002_pgvector_embedding", `Configure pgvector embedding column with ${getExpectedEmbeddingDimensions()} dimensions`);
  await recordMigration(
    "003_visual_vectors",
    `Configure OpenCLIP visual embedding table with ${getExpectedVisualEmbeddingDimensions()} dimensions`
  );
  await recordMigration("004_knowledge_vectors", `Configure sports knowledge vector table with ${getExpectedEmbeddingDimensions()} dimensions`);
  await recordMigration("005_tracking_records", "Configure derived tracking records table");
  await recordMigration("006_ask_operations", "Configure persistent ask operation state");
  await recordMigration("007_operational_indexes", "Configure operational indexes for worker and polling queries");
  await recordMigration("008_queue_outbox", "Configure transactional queue outbox for Redis dispatch");
  await recordMigration("009_vector_hybrid_search", "Configure pgvector minimum version and lexical vector-search indexes");
  await recordMigration("010_appearance_vectors", `Configure appearance similarity vector table with ${getExpectedVisualEmbeddingDimensions()} dimensions`);
  await recordMigration("011_appearance_clusters", "Configure candidate appearance cluster metadata");
  setPostgresInitialized(true);
  return true;
}

async function ensureAppearanceClusterColumns(db: Pool) {
  await db.query(`
    alter table app_appearance_vectors add column if not exists cluster_id text;
    alter table app_appearance_vectors add column if not exists cluster_size integer not null default 1;
    alter table app_appearance_vectors add column if not exists cluster_rank integer not null default 1;
    update app_appearance_vectors set cluster_id = id where cluster_id is null or cluster_id = '';
    alter table app_appearance_vectors alter column cluster_id set not null;
    create index if not exists app_appearance_vectors_cluster_id_idx on app_appearance_vectors(cluster_id);
  `);
}

export async function getVectorColumnType(db: Pool, table: string, column: string) {
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

async function recordMigration(version: string, description: string) {
  await getPool().query(
    `insert into app_schema_migrations(version, description, applied_at)
     values ($1, $2, now())
     on conflict (version) do update set description = excluded.description`,
    [version, description]
  );
}

async function createVectorIndex(db: Pool, indexName: string, tableName: string) {
  await db.query(`create index if not exists ${indexName} on ${tableName} using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)`).catch((error) => {
    const message = error instanceof Error ? error.message : `Failed to create ${indexName}`;
    logJson("warn", "postgres.pgvector.index_unavailable", message, { indexName, tableName });
    if (isPgvectorRequired()) throw error;
  });
}

async function ensurePgvectorVersion(db: Pool) {
  const result = await db.query("select extversion from pg_extension where extname = 'vector'");
  const version = result.rows[0]?.extversion as string | undefined;
  if (!version) return;
  if (compareVersion(version, minimumPgvectorVersion) >= 0) return;
  throw new Error(`pgvector ${version} is installed, but Arion requires pgvector ${minimumPgvectorVersion} or newer for the configured vector search profile.`);
}

async function ensureLexicalVectorIndexes(db: Pool) {
  await db.query(`
    alter table app_vectors
      add column if not exists search_tsv tsvector;
    create or replace function app_vectors_search_tsv_update() returns trigger
      language plpgsql
      as $$
      begin
        new.search_tsv := to_tsvector('simple', coalesce(new.text, '') || ' ' || array_to_string(new.tags, ' '));
        return new;
      end
      $$;
    drop trigger if exists app_vectors_search_tsv_update_trigger on app_vectors;
    create trigger app_vectors_search_tsv_update_trigger
      before insert or update of text, tags on app_vectors
      for each row execute function app_vectors_search_tsv_update();
    update app_vectors
      set search_tsv = to_tsvector('simple', coalesce(text, '') || ' ' || array_to_string(tags, ' '))
      where search_tsv is null;
    create index if not exists app_vectors_search_tsv_idx on app_vectors using gin(search_tsv);
    alter table app_knowledge_vectors
      add column if not exists search_tsv tsvector;
    create or replace function app_knowledge_vectors_search_tsv_update() returns trigger
      language plpgsql
      as $$
      begin
        new.search_tsv := to_tsvector(
          'simple',
          coalesce(new.entity_name, '') || ' ' ||
          coalesce(new.competition, '') || ' ' ||
          coalesce(new.season, '') || ' ' ||
          coalesce(new.team, '') || ' ' ||
          coalesce(new.text, '') || ' ' ||
          coalesce(new.source_text, '')
        );
        return new;
      end
      $$;
    drop trigger if exists app_knowledge_vectors_search_tsv_update_trigger on app_knowledge_vectors;
    create trigger app_knowledge_vectors_search_tsv_update_trigger
      before insert or update of entity_name, competition, season, team, text, source_text on app_knowledge_vectors
      for each row execute function app_knowledge_vectors_search_tsv_update();
    update app_knowledge_vectors
      set search_tsv = to_tsvector(
        'simple',
        coalesce(entity_name, '') || ' ' ||
        coalesce(competition, '') || ' ' ||
        coalesce(season, '') || ' ' ||
        coalesce(team, '') || ' ' ||
        coalesce(text, '') || ' ' ||
        coalesce(source_text, '')
      )
      where search_tsv is null;
    create index if not exists app_knowledge_vectors_search_tsv_idx on app_knowledge_vectors using gin(search_tsv);
  `);
}

export function isPgvectorVersionSupported(version: string | null | undefined) {
  return Boolean(version && compareVersion(version, minimumPgvectorVersion) >= 0);
}

function compareVersion(left: string, right: string) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function versionParts(value: string) {
  return value
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}
