import "../server/env";
import IORedis from "ioredis";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { closePostgresStore, ensurePostgresStore } from "../server/postgresStore";
import { getPool } from "../server/postgres/connection";

const dataDir = path.resolve(".data");
const dockerAppDataVolume = process.env.DOCKER_APP_DATA_VOLUME || "arion_app-data";
const dockerCopyImage = process.env.DOCKER_COPY_IMAGE || "redis:8-alpine";

await ensurePostgresStore();

const before = await readCounts();
await truncateVideoTables();
await removeHostMediaFiles();
await removeDockerVolumeMediaFiles();
await flushRedisQueues();
const after = await readCounts();

console.log(JSON.stringify({ ok: true, before, after }, null, 2));
await closePostgresStore();

async function readCounts() {
  const result = await getPool().query(`
    select
      (select count(*)::int from app_indexes) as indexes,
      (select count(*)::int from app_assets) as assets,
      (select count(*)::int from app_jobs) as jobs,
      (select count(*)::int from app_vectors) as text_vectors,
      (select count(*)::int from app_visual_vectors) as visual_vectors,
      (select count(*)::int from app_tracking_records) as tracking_records,
      (select count(*)::int from app_ask_operations) as ask_operations,
      (select count(*)::int from app_queue_outbox) as queue_outbox,
      (select count(*)::int from app_events) as events,
      (select count(*)::int from app_billing) as billing,
      (select count(*)::int from app_webhooks) as webhooks,
      (select count(*)::int from app_knowledge_vectors) as knowledge_vectors
  `);
  return result.rows[0];
}

async function truncateVideoTables() {
  await getPool().query(`
    truncate
      app_queue_outbox,
      app_ask_operations,
      app_billing,
      app_events,
      app_webhooks,
      app_jobs,
      app_vectors,
      app_visual_vectors,
      app_tracking_records,
      app_assets,
      app_indexes
  `);
}

async function removeHostMediaFiles() {
  await removeChildren(path.join(dataDir, "object-storage", "generated", "assets"));
  for (const provider of ["local-s3", "local-r2"]) {
    const providerDir = path.join(dataDir, "object-storage", provider);
    for (const bucket of await readDirSafe(providerDir)) {
      if (!bucket.isDirectory()) continue;
      await removeChildren(path.join(providerDir, bucket.name, "assets"));
    }
  }
  await removeChildren(path.join(dataDir, "tmp"));
  await removeChildren(path.join(dataDir, "tmp-uploads"));
  await removeChildren(path.join(dataDir, "tmp-whisperx"));
}

async function removeDockerVolumeMediaFiles() {
  await run("docker", [
    "run",
    "--rm",
    "-v",
    `${dockerAppDataVolume}:/target`,
    dockerCopyImage,
    "sh",
    "-c",
    [
      "rm -rf /target/object-storage/generated/assets/*",
      "rm -rf /target/object-storage/local-s3/*/assets/*",
      "rm -rf /target/object-storage/local-r2/*/assets/*",
      "rm -rf /target/tmp/* /target/tmp-uploads/* /target/tmp-whisperx/*"
    ].join("; ")
  ]);
}

async function flushRedisQueues() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  const redis = new IORedis(redisUrl, {
    connectTimeout: 1000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });
  redis.on("error", () => undefined);
  await redis.connect();
  await redis.flushdb();
  await redis.quit();
}

async function removeChildren(dir: string) {
  for (const entry of await readDirSafe(dir)) {
    await rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function readDirSafe(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}
