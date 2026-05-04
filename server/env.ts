import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(".env"), quiet: true, override: true });

if (parseBoolean(process.env.ARION_DOCKER_INFRA)) {
  const redisPort = process.env.REDIS_PORT || "16379";
  const postgresPort = process.env.POSTGRES_PORT || "15432";
  process.env.DATABASE_URL =
    process.env.DOCKER_DATABASE_URL || `postgres://video_intelligence:video_intelligence@127.0.0.1:${postgresPort}/video_intelligence`;
  process.env.REDIS_URL = process.env.DOCKER_REDIS_URL || `redis://127.0.0.1:${redisPort}`;
  process.env.POSTGRES_REQUIRE_PGVECTOR = "true";
}

if (!process.env.ARION_PROCESS_ROLE) {
  process.env.ARION_PROCESS_ROLE = inferProcessRole(process.argv[1] ?? "");
}

function inferProcessRole(entry: string) {
  const normalized = entry.split(path.sep).join("/");
  if (normalized.endsWith("/server/jobWorker.ts") || normalized.endsWith("/server/jobWorker.js")) return "worker";
  if (normalized.endsWith("/server/index.ts") || normalized.endsWith("/server/index.js")) return "api";
  if (normalized.includes("/scripts/") || normalized.startsWith("scripts/")) return "script";
  return "unknown";
}

function parseBoolean(value: string | undefined) {
  return value === "true" || value === "1" || value === "yes";
}
