import type { Pool } from "pg";
import { getPool, isPostgresEnabled, isPostgresInitialized, setPostgresInitialized, setVectorExtensionAvailable } from "./connection";
import { seedDefaults } from "./defaults";
import { getExpectedEmbeddingDimensions, getExpectedVisualEmbeddingDimensions } from "./vectorUtils";

export async function ensurePostgresStore() {
  if (!isPostgresEnabled()) return false;
  if (isPostgresInitialized()) return true;
  const db = getPool();
  await db.query("create extension if not exists vector").catch(() => undefined);
  const vectorType = await db.query("select to_regtype('vector') as type");
  const vectorExtensionAvailable = Boolean(vectorType.rows[0]?.type);
  setVectorExtensionAvailable(vectorExtensionAvailable);

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
    create index if not exists app_knowledge_vectors_domain_group_idx on app_knowledge_vectors(domain_group);
    create index if not exists app_knowledge_vectors_entity_name_idx on app_knowledge_vectors(entity_name);
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
    const currentKnowledgeVectorType = await getVectorColumnType(db, "app_knowledge_vectors", "embedding");
    if (currentKnowledgeVectorType && currentKnowledgeVectorType !== `vector(${dimension})`) {
      await db.query("drop index if exists app_knowledge_vectors_embedding_idx");
      await db.query("alter table app_knowledge_vectors drop column embedding");
    }
    await db.query(`alter table app_knowledge_vectors add column if not exists embedding vector(${dimension})`);
    await db.query("create index if not exists app_knowledge_vectors_embedding_idx on app_knowledge_vectors using hnsw (embedding vector_cosine_ops)").catch(() => undefined);
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
  await recordMigration("004_knowledge_vectors", `Configure sports knowledge vector table with ${getExpectedEmbeddingDimensions()} dimensions`);
  setPostgresInitialized(true);
  return true;
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
