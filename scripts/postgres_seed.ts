import "../server/env";
import { closePostgresStore, ensurePostgresStore, getPostgresStatus, isPostgresEnabled } from "../server/postgresStore";

if (!isPostgresEnabled()) {
  throw new Error("DATABASE_URL is not set.");
}

await ensurePostgresStore();
console.log(JSON.stringify({ ok: true, status: await getPostgresStatus() }, null, 2));
await closePostgresStore();
