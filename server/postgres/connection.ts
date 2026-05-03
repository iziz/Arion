import { Pool } from "pg";

let pool: Pool | null = null;
let initialized = false;
let vectorExtensionAvailable = false;

export function isPostgresEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
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

export async function closePostgresStore() {
  await pool?.end();
  pool = null;
  initialized = false;
  vectorExtensionAvailable = false;
}
