import "../server/env";
import { closePostgresStore, ensurePostgresStore, getMetrics, isPostgresEnabled } from "../server/postgresStore";

if (!isPostgresEnabled()) {
  throw new Error("DATABASE_URL is not set.");
}

await ensurePostgresStore();
console.log(JSON.stringify({ ok: true, metrics: await getMetrics() }, null, 2));
await closePostgresStore();
