import "../server/env";
import { closePostgresStore, isPostgresEnabled, resetPostgresStore } from "../server/postgresStore";

if (!isPostgresEnabled()) {
  throw new Error("DATABASE_URL is not set.");
}

const metrics = await resetPostgresStore();
console.log(JSON.stringify({ ok: true, metrics }, null, 2));
await closePostgresStore();
