import { getPool, getVectorExtensionInstallError, isVectorExtensionAvailable } from "./connection";
import { seedDefaults } from "./defaults";
import { getMetrics } from "./repository";
import { ensurePostgresStore, getVectorColumnType, isPgvectorVersionSupported, minimumPgvectorVersion } from "./schema";
import { getExpectedEmbeddingDimensions, getExpectedVisualEmbeddingDimensions } from "./vectorUtils";

export async function resetPostgresStore() {
  await ensurePostgresStore();
  await getPool().query(`
    truncate
      app_vectors,
      app_visual_vectors,
      app_appearance_vectors,
      app_tracking_records,
      app_ask_operations,
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
  const [version, extension, migrations, metrics, vectorTables] = await Promise.all([
    db.query("select version() as version"),
    db.query("select extversion from pg_extension where extname = 'vector'"),
    db.query("select version, description, applied_at from app_schema_migrations order by applied_at asc"),
    getMetrics(),
    getVectorTableStatuses()
  ]);
  const issues = getOperationalIssues(vectorTables);
  const pgvector = (extension.rows[0]?.extversion as string | undefined) ?? null;
  if (!isPgvectorVersionSupported(pgvector)) {
    issues.unshift(`pgvector ${pgvector ?? "missing"} is below the required ${minimumPgvectorVersion}.`);
  }
  return {
    enabled: true,
    ready: issues.length === 0,
    operationalState: issues.length === 0 ? "ready" : "degraded",
    postgres: version.rows[0]?.version as string,
    pgvector,
    minimumPgvectorVersion,
    pgvectorRequired: true,
    pgvectorInstallError: getVectorExtensionInstallError(),
    vectorSearchMode: "pgvector",
    embeddingColumn: vectorTables.find((table) => table.table === "app_vectors")?.columnType ?? null,
    expectedEmbeddingDimensions: getExpectedEmbeddingDimensions(),
    visualEmbeddingColumn: vectorTables.find((table) => table.table === "app_visual_vectors")?.columnType ?? null,
    expectedVisualEmbeddingDimensions: getExpectedVisualEmbeddingDimensions(),
    vectorTables,
    issues,
    migrations: migrations.rows,
    metrics
  };
}

async function getVectorTableStatuses() {
  const expectedText = `vector(${getExpectedEmbeddingDimensions()})`;
  const expectedVisual = `vector(${getExpectedVisualEmbeddingDimensions()})`;
  return Promise.all([
    getVectorTableStatus("app_vectors", expectedText, "app_vectors_embedding_idx", "app_vectors_search_tsv_idx"),
    getVectorTableStatus("app_knowledge_vectors", expectedText, "app_knowledge_vectors_embedding_idx", "app_knowledge_vectors_search_tsv_idx"),
    getVectorTableStatus("app_visual_vectors", expectedVisual, "app_visual_vectors_embedding_idx"),
    getVectorTableStatus("app_appearance_vectors", expectedVisual, "app_appearance_vectors_embedding_idx")
  ]);
}

async function getVectorTableStatus(table: string, expectedColumnType: string, indexName: string, lexicalIndexName?: string) {
  const db = getPool();
  const [columnType, hnswIndex, lexicalIndex, counts] = await Promise.all([
    getVectorColumnType(db, table, "embedding"),
    hasIndex(indexName),
    lexicalIndexName ? hasIndex(lexicalIndexName) : Promise.resolve(null),
    getVectorCounts(table)
  ]);
  const tableIssues: string[] = [];
  if (isVectorExtensionAvailable()) {
    if (columnType !== expectedColumnType) tableIssues.push(`${table}.embedding is ${columnType ?? "missing"}, expected ${expectedColumnType}.`);
    if (!hnswIndex) tableIssues.push(`${indexName} is missing; pgvector search works but may scan more rows.`);
    if (lexicalIndexName && !lexicalIndex) tableIssues.push(`${lexicalIndexName} is missing; hybrid lexical search works but may scan more rows.`);
    if (counts.jsonRows > 0 && counts.pgvectorRows === 0) tableIssues.push(`${table} has JSON embeddings but no populated pgvector rows; rebuild vectors for indexed search.`);
  }
  return {
    table,
    column: "embedding",
    columnType,
    expectedColumnType,
    hnswIndex,
    lexicalIndex,
    totalRows: counts.totalRows,
    jsonRows: counts.jsonRows,
    pgvectorRows: counts.pgvectorRows,
    searchMode: "pgvector",
    ready: tableIssues.length === 0,
    issues: tableIssues
  };
}

async function hasIndex(indexName: string) {
  const result = await getPool().query("select to_regclass($1) is not null as present", [indexName]);
  return Boolean(result.rows[0]?.present);
}

async function getVectorCounts(table: string) {
  const columnType = await getVectorColumnType(getPool(), table, "embedding");
  const embeddingCount = columnType
    ? ", count(embedding)::int as pgvector_rows"
    : ", 0::int as pgvector_rows";
  const result = await getPool().query(`
    select
      count(*)::int as total_rows,
      count(*) filter (
        where jsonb_typeof(embedding_json) = 'array'
          and jsonb_array_length(embedding_json) > 0
      )::int as json_rows
      ${embeddingCount}
    from ${table}
  `);
  const row = result.rows[0];
  return {
    totalRows: Number(row.total_rows),
    jsonRows: Number(row.json_rows),
    pgvectorRows: Number(row.pgvector_rows)
  };
}

function getOperationalIssues(vectorTables: Awaited<ReturnType<typeof getVectorTableStatuses>>) {
  return vectorTables.flatMap((table) => table.issues);
}
