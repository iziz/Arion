import { getPool } from "./connection";
import { seedDefaults } from "./defaults";
import { getMetrics } from "./repository";
import { ensurePostgresStore, getVectorColumnType } from "./schema";
import { getExpectedEmbeddingDimensions, getExpectedVisualEmbeddingDimensions } from "./vectorUtils";

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
