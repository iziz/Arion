import "../server/env";
import { closePostgresStore, ensurePostgresStore, getPostgresStatus, isPostgresEnabled } from "../server/postgresStore";

if (!isPostgresEnabled()) {
  throw new Error("DATABASE_URL is not set.");
}

await ensurePostgresStore();
const status = await getPostgresStatus();
console.log(JSON.stringify({ ok: status.operationalState === "ready", ...status }, null, 2));
await closePostgresStore();
