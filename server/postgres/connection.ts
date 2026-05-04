import { Pool } from "pg";

let pool: Pool | null = null;
let initialized = false;
let vectorExtensionAvailable = false;
let vectorExtensionInstallError: string | null = null;

export function isPostgresEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: process.env.POSTGRES_APPLICATION_NAME ?? "arion",
      max: parsePositiveInteger(process.env.POSTGRES_POOL_MAX, 10),
      connectionTimeoutMillis: parsePositiveInteger(process.env.POSTGRES_CONNECTION_TIMEOUT_MS, 5000),
      idleTimeoutMillis: parsePositiveInteger(process.env.POSTGRES_IDLE_TIMEOUT_MS, 30000),
      ssl: getPostgresSslConfig()
    });
  }
  return pool;
}

export function isPostgresInitialized() {
  return initialized;
}

export function setPostgresInitialized(value: boolean) {
  initialized = value;
}

export function isVectorExtensionAvailable() {
  return vectorExtensionAvailable;
}

export function setVectorExtensionAvailable(value: boolean) {
  vectorExtensionAvailable = value;
}

export function getVectorExtensionInstallError() {
  return vectorExtensionInstallError;
}

export function setVectorExtensionInstallError(value: string | null) {
  vectorExtensionInstallError = value;
}

export function isPgvectorRequired() {
  return parseBoolean(process.env.POSTGRES_REQUIRE_PGVECTOR);
}

export async function closePostgresStore() {
  await pool?.end();
  pool = null;
  initialized = false;
  vectorExtensionAvailable = false;
  vectorExtensionInstallError = null;
}

function getPostgresSslConfig() {
  const sslMode = process.env.PGSSLMODE ?? process.env.POSTGRES_SSLMODE;
  if (!sslMode || sslMode === "disable") return undefined;
  if (sslMode === "require") return { rejectUnauthorized: false };
  return undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseBoolean(value: string | undefined) {
  return value === "true" || value === "1" || value === "yes";
}
